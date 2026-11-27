const { imageEndpointForPath, resolveCodexImageRequest } = require("./codex-image-generation");

const DEFAULT_REQUEST_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_RESPONSE_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function sendJson(res, status, error, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  const bytes = Buffer.from(JSON.stringify({ error }));
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": bytes.length,
    ...headers,
  });
  res.end(bytes);
}

function publicError(code, message, param = null) {
  return { type: "invalid_request_error", code, param, message };
}

function collectRequest(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const cleanup = () => {
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      req.removeListener("aborted", onAborted);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      error ? reject(error) : resolve(value);
    };
    const onData = chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        const error = new Error("Image request exceeds limit");
        error.code = "request_too_large";
        // Drain any remaining client bytes without retaining them so a local
        // oversized request cannot keep growing bridge memory.
        req.resume();
        finish(error);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish(null, Buffer.concat(chunks));
    const onError = error => finish(error);
    const onAborted = () => finish(new Error("Image request interrupted"));
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAborted);
  });
}

function responseHeaders(headers, length) {
  const source = headers || {};
  return {
    "Content-Type": source["content-type"] || "application/json",
    "Content-Length": length,
    ...(source["retry-after"] && { "Retry-After": source["retry-after"] }),
    ...(source["x-codex-imagegen-request-id"] && {
      "X-Codex-Imagegen-Request-Id": source["x-codex-imagegen-request-id"],
    }),
  };
}

function createCodexImageGateway({ active, models, request, token, invalidateToken,
  isAuthFailure, hostname, requestMaxBytes = DEFAULT_REQUEST_MAX_BYTES,
  responseMaxBytes = DEFAULT_RESPONSE_MAX_BYTES, timeoutMs = DEFAULT_TIMEOUT_MS,
  onRoute = () => {} }) {
  return async function codexImageGateway(req, res) {
    const endpoint = imageEndpointForPath(req.url);
    if (!endpoint) {
      sendJson(res, 404, publicError("not_found", "Image endpoint not found."));
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, publicError("method_not_allowed", "Image endpoints require POST."),
        { Allow: "POST" });
      return;
    }
    const contentType = String(req.headers["content-type"] || "").toLowerCase();
    if (!contentType.startsWith("application/json")) {
      sendJson(res, 415, publicError("unsupported_media_type",
        "Codex image requests must use application/json."));
      return;
    }

    const session = active();
    if (!session) {
      sendJson(res, 401, publicError("image_gateway_inactive", "Codex image generation is not active."));
      return;
    }
    const sessionCurrent = () => active() === session;
    let outgoing = null;
    let incoming = null;
    let clientClosed = false;
    const cancel = () => {
      clientClosed = true;
      try { outgoing?.destroy(); } catch {}
      try { incoming?.destroy(); } catch {}
    };
    res.on("close", () => {
      if (!res.writableEnded) cancel();
    });

    let clientBytes;
    try {
      clientBytes = await collectRequest(req, requestMaxBytes);
    } catch (error) {
      if (error.code === "request_too_large") {
        sendJson(res, 413, publicError("request_too_large", "Image request exceeds the local size limit."));
      } else if (!clientClosed) {
        sendJson(res, 400, publicError("invalid_request_body", "Unable to read the image request."));
      }
      return;
    }
    if (clientClosed) return;
    if (!sessionCurrent()) {
      sendJson(res, 409, publicError("image_session_changed",
        "The connected account or image bridge changed during the request."));
      return;
    }

    let body;
    try {
      body = JSON.parse(clientBytes.toString("utf8"));
    } catch {
      sendJson(res, 400, publicError("invalid_request_body", "Image request body must be valid JSON."));
      return;
    }

    let catalog;
    try {
      catalog = await models();
    } catch {
      sendJson(res, 503, publicError("image_catalog_unavailable",
        "Unable to read image availability for the current Copilot account."));
      return;
    }
    if (!sessionCurrent()) {
      sendJson(res, 409, publicError("image_session_changed",
        "The connected account or image bridge changed during the request."));
      return;
    }

    const resolved = resolveCodexImageRequest(endpoint, body, catalog);
    if (resolved.error) {
      sendJson(res, 400, resolved.error);
      return;
    }
    const upstreamBytes = Buffer.from(JSON.stringify(resolved.body));
    for (const change of resolved.changes) {
      try { onRoute(change); } catch {}
    }

    const once = async attempt => {
      const bearer = await token();
      if (clientClosed) return null;
      if (!sessionCurrent()) {
        const error = new Error("Image session changed");
        error.code = "image_session_changed";
        throw error;
      }

      return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => finish(Object.assign(new Error("Image request timed out"), {
          code: "image_request_timeout",
        })), timeoutMs);
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) {
            try { outgoing?.destroy(); } catch {}
            try { incoming?.destroy(); } catch {}
            reject(error);
          } else resolve(value);
        };
        Promise.resolve().then(async () => {
          const turnId = req.headers["x-codex-image-turn-id"];
          outgoing = await request({
            hostname,
            path: endpoint,
            method: "POST",
            headers: {
              Authorization: `Bearer ${bearer}`,
              "Content-Type": "application/json",
              "Content-Length": upstreamBytes.length,
              Accept: "application/json",
              "Editor-Version": "vscode/1.110.1",
              "Editor-Plugin-Version": "copilot-chat/0.38.2",
              "User-Agent": "GitHubCopilotChat/0.38.2",
              "Copilot-Integration-Id": "vscode-chat",
              "X-GitHub-Api-Version": "2025-10-01",
              ...(typeof turnId === "string" && turnId ? { "X-Codex-Image-Turn-Id": turnId } : {}),
            },
          }, response => {
            incoming = response;
            if (clientClosed || !sessionCurrent()) {
              finish(Object.assign(new Error("Image session changed"), {
                code: clientClosed ? "client_closed" : "image_session_changed",
              }));
              return;
            }
            const chunks = [];
            let size = 0;
            response.on("data", chunk => {
              if (!sessionCurrent()) {
                finish(Object.assign(new Error("Image session changed"), { code: "image_session_changed" }));
                return;
              }
              size += chunk.length;
              if (size > responseMaxBytes) {
                finish(Object.assign(new Error("Image response exceeds limit"), {
                  code: "image_response_too_large",
                }));
                return;
              }
              chunks.push(chunk);
            });
            response.on("end", () => finish(null, {
              status: response.statusCode,
              headers: response.headers,
              body: Buffer.concat(chunks),
              bearer,
              attempt,
            }));
            response.on("error", finish);
            response.on("aborted", () => finish(new Error("Image response interrupted")));
          });
          if (clientClosed || !sessionCurrent()) {
            finish(Object.assign(new Error("Image session changed"), {
              code: clientClosed ? "client_closed" : "image_session_changed",
            }));
            return;
          }
          outgoing.on("error", finish);
          outgoing.end(upstreamBytes);
        }).catch(finish);
      });
    };

    let result;
    try {
      result = await once(0);
      if (!result || clientClosed) return;
      const authRejected = result.status === 401 ||
        (result.status === 400 && isAuthFailure(result.body.toString("utf8")));
      if (authRejected) {
        invalidateToken(result.bearer);
        result = await once(1);
      }
    } catch (error) {
      if (clientClosed || error.code === "client_closed") return;
      if (error.code === "image_session_changed") {
        sendJson(res, 409, publicError("image_session_changed",
          "The connected account or image bridge changed during the request."));
      } else if (error.code === "image_response_too_large") {
        sendJson(res, 502, publicError("image_response_too_large",
          "The image response exceeded the local size limit."));
      } else if (error.code === "image_request_timeout") {
        sendJson(res, 504, publicError("image_request_timeout", "Image generation timed out."));
      } else {
        sendJson(res, 502, publicError("image_gateway_error", "Unable to complete image generation."));
      }
      return;
    }

    if (!result || clientClosed) return;
    if (!sessionCurrent()) {
      sendJson(res, 409, publicError("image_session_changed",
        "The connected account or image bridge changed during the request."));
      return;
    }
    if (result.status === 401 ||
        (result.status === 400 && isAuthFailure(result.body.toString("utf8")))) {
      // The one replay is the hard bound. Leave a second rejected token
      // invalidated so the next independent request mints a fresh credential.
      invalidateToken(result.bearer);
    }
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(result.status || 502, responseHeaders(result.headers, result.body.length));
    res.end(result.body);
  };
}

module.exports = {
  DEFAULT_REQUEST_MAX_BYTES,
  DEFAULT_RESPONSE_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  createCodexImageGateway,
};
