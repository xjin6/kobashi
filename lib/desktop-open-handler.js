"use strict";

function failure(code) { return Object.assign(new Error(code), { code }); }

function isLocalDesktopRequest(req, port) {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket?.remoteAddress) &&
    hosts.includes(req.headers.host) &&
    (!req.headers.origin || hosts.some(host => req.headers.origin === "http://" + host)) &&
    req.headers["sec-fetch-site"] !== "cross-site";
}

function readEmptyJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [], done = false;
    const finish = error => {
      if (done) return;
      done = true;
      req.removeListener("data", data);
      req.removeListener("end", end);
      req.removeListener("error", failed);
      req.removeListener("aborted", failed);
      if (error) { chunks = []; req.resume(); reject(error); } else resolve();
    };
    const data = chunk => {
      size += chunk.length;
      if (size > 1024) finish(failure("invalid_request")); else chunks.push(chunk);
    };
    const failed = () => finish(failure("invalid_request"));
    const end = () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!value || Array.isArray(value) || typeof value !== "object" || Object.keys(value).length) throw Error();
        finish();
      } catch { finish(failure("invalid_request")); }
    };
    req.on("data", data); req.once("end", end); req.once("error", failed); req.once("aborted", failed);
  });
}

function createDesktopOpenHandler({ route, launcher, port, ready = () => true, safeErrors, localRequest = isLocalDesktopRequest }) {
  return async function handle(req, res) {
    if (req.url !== route) return false;
    const reply = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff" });
      res.end(JSON.stringify(value));
    };
    if (!localRequest(req, port)) {
      reply(403, { ok: false, error: "invalid_origin" }); return true;
    }
    if (req.method !== "POST") { reply(405, { ok: false, error: "invalid_request" }); return true; }
    try {
      if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")) throw failure("invalid_request");
      await readEmptyJson(req);
      if (!ready()) throw failure("bridge_not_ready");
      const result = await launcher.open();
      reply(200, { ok: true, ...result });
    } catch (error) {
      const code = error.code === "invalid_request" || error.code === "bridge_not_ready" ||
        safeErrors.has(error.code) ? error.code : "launch_failed";
      reply(code === "invalid_request" ? 400 : 503, { ok: false, error: code });
    }
    return true;
  };
}

module.exports = { createDesktopOpenHandler };
