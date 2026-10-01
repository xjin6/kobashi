const assert = require("node:assert/strict");
const { Writable, Readable } = require("node:stream");
const test = require("node:test");
const { createCodexProbeTransport } = require("../lib/codex-probe-transport");

function harness(options = {}) {
  const calls = []; let generation = 0;
  const transport = createCodexProbeTransport({
    hostname: "mock.invalid", timeoutMs: 1000,
    token: async () => `token-${generation}`, invalidateToken: () => generation++,
    isAuthFailure: body => body.includes("expired token"),
    request: async (request, receive) => {
      const chunks = [];
      const outgoing = new Writable({
        write(chunk, encoding, done) { chunks.push(chunk); done(); },
        final(done) {
          calls.push({ ...request, body: Buffer.concat(chunks) });
          const reply = options.reply?.(calls.length) || { status: 200, body: "data: [DONE]\n\n" };
          const response = Readable.from([Buffer.from(reply.body)]);
          response.statusCode = reply.status; response.headers = { "content-type": "text/event-stream" };
          receive(response); done();
        },
      });
      return outgoing;
    },
    ...options,
  });
  return { calls, transport };
}

test("capability checks use the shared route and retry authentication at most once", async () => {
  const { transport, calls } = harness({ reply: n => ({ status: n === 1 ? 401 : 200, body: "ok" }) });
  assert.equal((await transport({ model: "future", input: "你好" })).status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers.Authorization, "Bearer token-0");
  assert.equal(calls[1].headers.Authorization, "Bearer token-1");
  assert.equal(calls[1].headers["Content-Length"], calls[1].body.length);
});

test("oversized probe responses fail rather than using unbounded memory", async () => {
  const { transport } = harness({ maxBytes: 2 });
  await assert.rejects(transport({}), /exceeds limit/);
});

test("timeout covers route establishment and destroys a late request", async () => {
  let outgoing;
  const { transport } = harness({ timeoutMs: 10, request: () => new Promise(resolve => {
    setTimeout(() => { outgoing = new Writable({ write(chunk, encoding, done) { done(); } }); resolve(outgoing); }, 30);
  }) });
  await assert.rejects(transport({}), /timed out/);
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(outgoing.destroyed, true);
});
