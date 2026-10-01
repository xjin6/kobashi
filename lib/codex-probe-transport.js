// Bounded transport for background synthetic capability checks. Use the same
// auth and network route as real traffic, without touching the live HTTP server.
function createCodexProbeTransport({ request, token, invalidateToken, isAuthFailure,
  hostname, timeoutMs = 45_000, maxBytes = 512 * 1024 }) {
  function once(body) {
    return new Promise((resolve, reject) => {
      let settled = false, outgoing, incoming;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          outgoing?.destroy(); incoming?.destroy(); reject(error);
        } else resolve(result);
      };
      const timer = setTimeout(() => finish(new Error("Capability probe timed out")), timeoutMs);
      (async () => {
        const bearer = await token();
        if (settled) return;
        const bytes = Buffer.from(JSON.stringify(body));
        outgoing = await request({ hostname, path: "/v1/responses", method: "POST",
          headers: {
            Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", "Content-Length": bytes.length,
            "Editor-Version": "vscode/1.110.1", "Editor-Plugin-Version": "copilot-chat/0.38.2",
            "User-Agent": "GitHubCopilotChat/0.38.2", "Copilot-Integration-Id": "vscode-chat",
            "X-GitHub-Api-Version": "2025-10-01", Accept: "text/event-stream",
          },
        }, response => {
          incoming = response;
          if (settled) { response.destroy(); return; }
          const chunks = [];
          let size = 0;
          response.on("data", chunk => {
            size += chunk.length;
            if (size > maxBytes) { finish(new Error("Capability response exceeds limit")); return; }
            chunks.push(chunk);
          });
          response.on("end", () => finish(null, { status: response.statusCode,
            headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
          response.on("error", error => finish(error));
          response.on("aborted", () => finish(new Error("Capability response interrupted")));
        });
        outgoing.on("error", error => finish(error));
        if (settled) { outgoing.destroy(); return; }
        outgoing.end(bytes);
      })().catch(error => finish(error));
    });
  }
  return async body => {
    let response = await once(body);
    if (response.status === 401 || (response.status === 400 && isAuthFailure(response.body))) {
      invalidateToken();
      response = await once(body);
    }
    return response;
  };
}

module.exports = { createCodexProbeTransport };
