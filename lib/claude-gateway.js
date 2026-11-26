const { timingSafeEqual } = require("node:crypto");
const { resolveClaudeRoute, listClaudeModels } = require("./claude-routes");
const { translateRequest } = require("./claude-input");
const { translateResponse, createStreamTranslator } = require("./claude-output");
const { planWebSearch, runWebSearch, webSearchEvents, modelLacksSearch } = require("./claude-web-search");

function estimateInputTokens(body) {
  let chars = 0;
  if (typeof body.system === "string") chars += body.system.length;
  else if (Array.isArray(body.system)) chars += body.system.reduce((n, b) => n + (b.text || "").length, 0);
  if (Array.isArray(body.tools)) {
    for (const t of body.tools) {
      chars += (t.name || "").length + (t.description || "").length;
      if (t.input_schema) chars += JSON.stringify(t.input_schema).length;
    }
  }
  for (const m of body.messages || []) {
    if (typeof m.content === "string") chars += m.content.length;
    else for (const b of m.content || []) {
      if (b.type === "text") chars += (b.text || "").length;
      else if (b.type === "image") chars += 4000;
      else if (b.type === "tool_use") chars += JSON.stringify(b.input || {}).length + (b.name || "").length;
      else if (b.type === "tool_result") chars += (typeof b.content === "string" ? b.content : JSON.stringify(b.content || "")).length;
    }
  }
  return Math.max(1, Math.ceil(chars / 2.5));
}

function statusError(status, message) {
  return Object.assign(new Error(message), { status });
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function errorBody(status, message) {
  const types = { 400: "invalid_request_error", 401: "authentication_error", 403: "permission_error",
    404: "not_found_error", 413: "request_too_large", 429: "rate_limit_error", 529: "overloaded_error" };
  return { type: "error", error: { type: types[status] || "api_error", message } };
}

function validToken(headers, token) {
  const provided = /^Bearer ([^\s]+)$/i.exec(headers.authorization || "")?.[1] || headers["x-api-key"];
  if (!token || typeof provided !== "string") return false;
  const key = Buffer.from(token);
  const other = Buffer.from(provided);
  return key.length === other.length && timingSafeEqual(key, other);
}

async function readBody(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function requestHeaders(bearer, route, body, clientHeaders, stream) {
  const last = body.messages.at(-1);
  const continuation = last?.role === "assistant" || (Array.isArray(last?.content) &&
    last.content.length > 0 && last.content.every(part => part.type === "tool_result"));
  const headers = {
    "Content-Type": "application/json", Authorization: "Bearer " + bearer,
    "Editor-Version": "vscode/1.110.1", "Editor-Plugin-Version": "copilot-chat/0.38.2",
    "User-Agent": "GitHubCopilotChat/0.38.2", "Copilot-Integration-Id": "vscode-chat",
    "X-GitHub-Api-Version": "2025-10-01", "X-Initiator": continuation ? "agent" : "user",
    Accept: stream ? "text/event-stream" : "application/json",
  };
  if (body.messages.some(m => Array.isArray(m.content) && m.content.some(b => b.type === "image" ||
    (b.type === "tool_result" && Array.isArray(b.content) && b.content.some(p => p.type === "image"))))) {
    headers["Copilot-Vision-Request"] = "true";
  }
  if (route.format === "messages") {
    headers["anthropic-version"] = clientHeaders["anthropic-version"] || "2023-06-01";
    if (clientHeaders["anthropic-beta"]) headers["anthropic-beta"] = clientHeaders["anthropic-beta"];
  }
  return headers;
}

function openRequest(request, options, bytes, signal) {
  return new Promise((resolve, reject) => {
    request(options, resolve).then(outgoing => {
      const cancel = () => outgoing.destroy(new Error("Claude client disconnected"));
      outgoing.on("error", reject);
      outgoing.once("close", () => signal.removeEventListener("abort", cancel));
      if (signal.aborted) { cancel(); return; }
      signal.addEventListener("abort", cancel, { once: true });
      outgoing.end(bytes);
    }, reject);
  });
}

function waitForDrain(res) {
  if (!res.writableNeedDrain || res.destroyed) return;
  return new Promise(resolve => {
    const finish = () => { res.off("close", finish); res.off("drain", finish); resolve(); };
    res.once("drain", finish);
    res.once("close", finish);
  });
}

function createClaudeGateway({ active, gatewayToken, routes, request, token, invalidateToken, isAuthFailure,
  hostname, onRequest = () => {} }) {
  return async (req, res) => {
    const session = active();
    const abort = new AbortController();
    let incoming, translator;
    res.once("close", () => {
      if (res.writableEnded) return;
      abort.abort();
      incoming?.destroy();
    });
    const checkSession = () => {
      if (abort.signal.aborted || active() !== session) throw statusError(401, "Claude bridge session changed");
    };
    try {
      if (!session) throw statusError(401, "Claude bridge not active");
      let path = req.url.split("?")[0];
      const desktop = path.startsWith("/claude-desktop/");
      if (desktop) {
        if (!validToken(req.headers, gatewayToken())) throw statusError(401, "Invalid Claude Desktop gateway token");
        path = path.slice("/claude-desktop".length);
      }
      if (req.method === "GET" && path === "/v1/models") {
        const catalog = await routes();
        checkSession();
        json(res, 200, listClaudeModels(desktop ? catalog.slice(0, 200) : catalog, desktop));
        return;
      }
      if (req.method !== "POST" || !["/v1/messages", "/v1/messages/count_tokens"].includes(path)) {
        throw statusError(404, "Unknown Claude gateway endpoint");
      }
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { throw statusError(400, "Invalid Messages JSON"); }
      checkSession();
      if (!Array.isArray(body?.messages)) throw statusError(400, "Expected a Messages request with a messages array");
      if (path.endsWith("/count_tokens")) {
        json(res, 200, { input_tokens: estimateInputTokens(body) });
        return;
      }
      if (typeof body.model !== "string" || !body.model.trim()) throw statusError(400, "Missing model");
      const catalog = await routes();
      checkSession();
      const route = resolveClaudeRoute(catalog, body.model);
      if (!route) throw statusError(404, catalog.length ? "Copilot model route is unavailable: " + body.model
        : "This Copilot account has no enabled chat model with streaming and tool calls");
      let refreshedToken = false;
      async function forward(target, payload) {
        onRequest(body, target, payload);
        const bytes = Buffer.from(JSON.stringify(payload));
        for (;;) {
          const bearer = await token();
          checkSession();
          const headers = requestHeaders(bearer, target, body, req.headers, payload.stream);
          incoming = await openRequest(request, { hostname, path: target.path, method: "POST", headers }, bytes, abort.signal);
          checkSession();
          if (incoming.statusCode === 200) return;
          const status = incoming.statusCode || 502;
          const raw = await readBody(incoming);
          checkSession();
          if (status === 401 || (status === 400 && isAuthFailure(raw))) {
            invalidateToken(bearer);
            if (!refreshedToken) {
              refreshedToken = true;
              continue;
            }
          }
          let detail, parameter;
          try {
            const parsed = JSON.parse(raw);
            detail = parsed.error?.message || parsed.message;
            parameter = parsed.error?.param;
          } catch {}
          throw Object.assign(statusError(status, detail || raw || "Copilot returned HTTP " + status), { upstreamParameter: parameter });
        }
      }
      async function readReply() {
        const raw = await readBody(incoming);
        checkSession();
        return JSON.parse(raw);
      }
      let plan, payload;
      try {
        if (route.format !== "messages") plan = planWebSearch(body, route, catalog, req.headers);
        if (!plan) payload = translateRequest(route.format, body, route.model);
      } catch (error) { throw statusError(400, error.message); }
      if (!plan) {
        try { await forward(route, payload); }
        catch (error) {
          // Preserve native Anthropic events and signatures when Copilot can
          // run the tool directly. An explicit pre-response tool rejection is
          // the only native failure on which we try one Responses alternative.
          if (route.format !== "messages" || !modelLacksSearch(error)) throw error;
          try { plan = planWebSearch(body, route, catalog, req.headers); }
          catch { throw error; }
          if (!plan) throw error;
          plan.routes = plan.routes.slice(0, 1);
        }
      }
      if (plan) {
        const answer = await runWebSearch(plan, body, async (target, searchPayload) => {
          await forward(target, searchPayload);
          return readReply();
        });
        checkSession();
        if (body.stream) {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
          res.end(webSearchEvents(answer));
        } else json(res, 200, answer);
        return;
      }
      if (!body.stream) {
        const upstream = await readReply();
        json(res, 200, route.format === "messages" ? upstream : translateResponse(route.format, upstream, body.model, route.model.id));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      if (route.format !== "messages") {
        translator = createStreamTranslator(route.format, body.model, chunk => res.write(chunk), estimateInputTokens(body), route.model.id);
      }
      for await (const chunk of incoming) {
        if (res.destroyed) return;
        checkSession();
        if (translator) translator.feed(chunk);
        else res.write(chunk);
        if (res.writableNeedDrain) await waitForDrain(res);
      }
      checkSession();
      translator?.end();
      res.end();
    } catch (error) {
      incoming?.destroy();
      if (res.destroyed || res.writableEnded) return;
      const status = error.status || 502;
      if (!res.headersSent) json(res, status, errorBody(status, error.message));
      else {
        if (translator) translator.fail(error);
        else res.write("event: error\ndata: " + JSON.stringify(errorBody(status, error.message)) + "\n\n");
        res.end();
      }
    }
  };
}

module.exports = { createClaudeGateway };
