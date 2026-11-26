const { timingSafeEqual } = require("node:crypto");
const { once } = require("node:events");
const { advertisedEfforts } = require("./claude-effort");

const CHAT = "/v1/chat/completions";
const RESPONSES = "/v1/responses";
const ENDPOINTS = new Set([CHAT, "/chat/completions", RESPONSES, "/responses"]);

function endpoints(model) {
  // Older Copilot chat records predate endpoint negotiation. They use Chat
  // Completions. An explicit list (including an empty one) is authoritative.
  if (model.supported_endpoints == null) return ["/chat/completions"];
  return Array.isArray(model.supported_endpoints)
    ? [...new Set(model.supported_endpoints.filter(path => ENDPOINTS.has(path)))] : [];
}

function selectGrokModels(catalog) {
  const models = Array.isArray(catalog) ? catalog : catalog?.data;
  if (!Array.isArray(models)) throw new Error("Invalid Copilot model directory");
  const seen = new Set();
  return models.filter(model => {
    if (!model || typeof model.id !== "string" || seen.has(model.id)) return false;
    if (!/^(?:x[.-]?ai\/)?grok(?:[-.][a-z0-9][a-z0-9._-]*)?$/i.test(model.id)) return false;
    // An unqualified ID can be submitted only when Copilot identifies its
    // vendor. A qualified ID also identifies its owner in older directory rows.
    const owner = model.vendor || model.id.split("/")[0];
    if (typeof owner !== "string" || !/^x[ .-]?ai$/i.test(owner.trim())) return false;
    const { type, supports } = model.capabilities || {};
    if (type !== "chat" || supports?.streaming === false || supports?.tool_calls === false || !endpoints(model).length) return false;
    if ("model_picker_enabled" in model && model.model_picker_enabled !== true) return false;
    if (model.policy?.state && model.policy.state !== "enabled") return false;
    if (/\binternal\b/i.test([model.id, model.name, model.description].join(" "))) return false;
    seen.add(model.id);
    return true;
  });
}

function listGrokModels(catalog) {
  return { object: "list", data: selectGrokModels(catalog).map(model => {
    const limits = model.capabilities.limits;
    const context = limits?.max_context_window_tokens ?? limits?.max_prompt_tokens;
    const vision = model.capabilities.supports?.vision;
    const efforts = advertisedEfforts(model);
    return { id: model.id, object: "model", created: Number(model.created) || 0, owned_by: "xai",
      display_name: model.name || model.id, supported_endpoints: endpoints(model),
      ...(typeof vision === "boolean" && { supports_vision: vision }),
      ...(Array.isArray(efforts) && { reasoning_efforts: [...new Set(efforts.filter(e => typeof e === "string" && e.length))] }),
      ...(Number.isSafeInteger(context) && context > 0 && { context_window: context }) };
  }) };
}

function error(status, message) {
  return Object.assign(new Error(message), { status });
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function validBearer(header, token) {
  const bearer = /^Bearer ([^\s]+)$/i.exec(header || "")?.[1];
  if (!bearer || typeof token !== "string" || !token) return false;
  const supplied = Buffer.from(bearer), expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readBody(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function upstreamHeaders(bearer, body, path, length) {
  const turns = path === CHAT ? body.messages : body.input;
  const last = Array.isArray(turns) && turns.at(-1);
  const continuation = last?.role === "tool" || last?.role === "assistant" || last?.type === "function_call_output";
  const vision = Array.isArray(turns) && turns.some(turn => Array.isArray(turn?.content) &&
    turn.content.some(part => part?.type === "image_url" || part?.type === "input_image"));
  return {
    Authorization: "Bearer " + bearer, "Content-Type": "application/json", "Content-Length": length,
    "Editor-Version": "vscode/1.110.1", "Editor-Plugin-Version": "copilot-chat/0.38.2",
    "User-Agent": "GitHubCopilotChat/0.38.2", "Copilot-Integration-Id": "vscode-chat",
    "X-GitHub-Api-Version": "2025-10-01", "X-Initiator": continuation ? "agent" : "user",
    Accept: body.stream === true ? "text/event-stream" : "application/json",
    ...(vision && { "Copilot-Vision-Request": "true" }),
  };
}

function createGrokGateway({ active, gatewayToken, models, request, token, invalidateToken, isAuthFailure, hostname }) {
  return async (req, res) => {
    const session = active();
    const abort = new AbortController();
    let outgoing, incoming;
    res.once("close", () => {
      if (res.writableEnded) return;
      abort.abort();
      outgoing?.destroy(new Error("Grok client disconnected"));
      incoming?.destroy();
    });
    function checkSession() {
      if (abort.signal.aborted || session !== active()) throw error(401, "Grok bridge session changed");
    }
    function send(options, bytes) {
      return new Promise((resolve, reject) => {
        request(options, resolve).then(client => {
          outgoing = client;
          client.once("error", reject);
          try {
            // The network transport may have awaited a tunnel before returning
            // the writable request. Recheck the session before sending any bytes.
            checkSession();
            client.end(bytes);
          } catch (err) { client.destroy(); reject(err); }
        }, reject);
      });
    }

    try {
      if (!session) throw error(401, "Grok bridge not active");
      if (!validBearer(req.headers.authorization, await gatewayToken())) throw error(401, "Invalid Grok gateway token");
      checkSession();
      const path = req.url.split("?")[0];
      if (req.method === "GET" && path === "/v1/models") {
        const catalog = listGrokModels(await models());
        checkSession();
        json(res, 200, catalog);
        return;
      }
      if (req.method !== "POST" || (path !== CHAT && path !== RESPONSES)) throw error(404, "Unknown Grok gateway endpoint");
      let body;
      try { body = JSON.parse((await readBody(req)).toString("utf8")); }
      catch { throw error(400, "Invalid request JSON"); }
      if (typeof body?.model !== "string" || !body.model.trim()) throw error(400, "A model ID is required");
      checkSession();
      const model = selectGrokModels(await models()).find(candidate => candidate.id === body.model);
      checkSession();
      if (!model) throw error(404, "This Grok model is unavailable on the connected Copilot account");
      const upstreamPath = endpoints(model).find(advertised => advertised === path || "/v1" + advertised === path);
      if (!upstreamPath) throw error(400, "This Copilot model does not support " + path);

      // Re-serialize the checked object so duplicate JSON keys cannot select
      // different model IDs in our parser and the upstream parser.
      const bytes = Buffer.from(JSON.stringify(body));
      for (let attempt = 0; attempt < 2; attempt++) {
        const bearer = await token();
        checkSession();
        incoming = await send({ hostname, path: upstreamPath, method: "POST",
          headers: upstreamHeaders(bearer, body, path, bytes.length) }, bytes);
        checkSession();
        const status = incoming.statusCode || 502;
        const headers = incoming.headers || {};
        const stream = status === 200 && (headers["content-type"] || (body.stream ? "text/event-stream" : "")).includes("text/event-stream");
        const responseHeaders = {
          "Content-Type": headers["content-type"] || (stream ? "text/event-stream" : "application/json"),
          "Cache-Control": "no-store",
          ...(headers["retry-after"] && { "Retry-After": headers["retry-after"] }),
        };
        if (stream) {
          res.writeHead(status, responseHeaders);
          res.flushHeaders();
          for await (const chunk of incoming) {
            checkSession();
            if (!res.write(chunk)) await once(res, "drain", { signal: abort.signal });
          }
          checkSession();
          res.end();
          return;
        }
        const raw = await readBody(incoming);
        checkSession();
        if (status === 401 || (status === 400 && isAuthFailure(raw.toString("utf8")))) {
          invalidateToken(bearer);
          if (attempt === 0) continue;
        }
        res.writeHead(status, responseHeaders);
        res.end(raw);
        return;
      }
    } catch (err) {
      incoming?.destroy();
      if (res.destroyed || res.writableEnded) return;
      // A dropped stream must not appear to the caller as a successful turn.
      if (res.headersSent) { res.destroy(); return; }
      const status = err.status || 502;
      const type = { 400: "invalid_request_error", 401: "authentication_error", 404: "not_found_error" }[status] || "api_error";
      json(res, status, { error: { type, message: err.message } });
    }
  };
}

module.exports = { selectGrokModels, listGrokModels, createGrokGateway };
