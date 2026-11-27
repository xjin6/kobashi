const assert = require("node:assert/strict");
const http = require("node:http");
const { PassThrough, Readable, Writable } = require("node:stream");
const test = require("node:test");
const { createCodexImageGateway } = require("../lib/codex-image-gateway");

function imageModel(id = "gpt-image-2.5-flare") {
  return {
    id,
    vendor: "Experimental",
    model_picker_enabled: false,
    policy: { state: "enabled" },
    supported_endpoints: ["/v1/images/generations", "/v1/images/edits"],
    capabilities: { type: "image", family: id, limits: { max_prompt_tokens: 32000 }, supports: {} },
  };
}

async function harness(t, options = {}) {
  const state = { session: "account-a/1", token: 0, modelReads: 0, invalidations: [] };
  const calls = [];
  const streams = [];
  const request = async (requestOptions, receive) => {
    const chunks = [];
    const outgoing = new Writable({
      write(chunk, encoding, done) { chunks.push(chunk); done(); },
      final(done) {
        const call = { ...requestOptions, body: Buffer.concat(chunks), outgoing };
        calls.push(call);
        const reply = options.reply?.(calls.length, call, state) || {
          status: 200,
          body: Buffer.from('{"data":[{"b64_json":"fixture"}]}'),
          headers: { "content-type": "application/json" },
        };
        if (reply.manual) {
          const incoming = new PassThrough();
          incoming.statusCode = reply.status || 200;
          incoming.headers = reply.headers || { "content-type": "application/json" };
          streams.push(incoming);
          receive(incoming);
          reply.start?.(incoming, state);
        } else {
          const parts = reply.parts || [Buffer.from(reply.body || "")];
          const incoming = Readable.from(parts);
          incoming.statusCode = reply.status;
          incoming.headers = reply.headers || { "content-type": "application/json" };
          streams.push(incoming);
          receive(incoming);
        }
        done();
      },
    });
    return outgoing;
  };
  const gateway = createCodexImageGateway({
    hostname: "mock.invalid",
    active: () => state.session,
    models: async () => {
      state.modelReads++;
      if (options.onModels) return options.onModels(state);
      return options.models || [imageModel()];
    },
    token: async () => {
      if (options.onToken) await options.onToken(state);
      return `token-${state.token}`;
    },
    invalidateToken: rejected => { state.invalidations.push(rejected); state.token++; },
    isAuthFailure: body => /expired token/i.test(body),
    request,
    requestMaxBytes: options.requestMaxBytes,
    responseMaxBytes: options.responseMaxBytes,
    timeoutMs: options.timeoutMs || 1000,
  });
  const server = http.createServer((req, res) => gateway(req, res));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) => fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { base, calls, gateway, post, state, streams };
}

test("routes the native image alias with isolated auth and preserves response bytes and headers", async t => {
  const raw = Buffer.from('{ "data": [ { "b64_json": "opaque" } ], "created": 1 }');
  const h = await harness(t, { reply: () => ({ status: 200, body: raw, headers: {
    "content-type": "application/json; charset=utf-8",
    "retry-after": "7",
    "x-codex-imagegen-request-id": "image-request-fixture",
  } }) });
  const response = await h.post("/v1/images/generations", {
    model: "gpt-image-2", prompt: "fixture", quality: "auto", size: "auto",
    background: "transparent", future: { keep: true },
  }, { authorization: "Bearer native-chatgpt-secret", "x-codex-image-turn-id": "turn-fixture" });
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), raw);
  assert.equal(response.headers.get("retry-after"), "7");
  assert.equal(response.headers.get("x-codex-imagegen-request-id"), "image-request-fixture");
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].path, "/v1/images/generations");
  assert.equal(h.calls[0].headers.Authorization, "Bearer token-0");
  assert.equal(h.calls[0].headers["X-Codex-Image-Turn-Id"], "turn-fixture");
  assert.ok(!JSON.stringify(h.calls[0].headers).includes("native-chatgpt-secret"));
  const sent = JSON.parse(h.calls[0].body);
  assert.deepEqual(sent, {
    model: "gpt-image-2.5-flare", prompt: "fixture", quality: "auto", size: "auto",
    background: "transparent", future: { keep: true },
  });
  assert.equal(h.calls[0].headers["Content-Length"], h.calls[0].body.length);
});

test("preserves Codex JSON edit image references while changing only the model", async t => {
  const h = await harness(t);
  const body = {
    model: "gpt-image-2", prompt: "add a hat", quality: "auto", size: "auto",
    images: [{ image_url: "data:image/png;base64,Zm9v" }, { file_id: "file-image" }],
  };
  assert.equal((await h.post("/images/edits?client=codex", body)).status, 200);
  assert.deepEqual(JSON.parse(h.calls[0].body), { ...body, model: "gpt-image-2.5-flare" });
  assert.equal(h.calls[0].path, "/v1/images/edits");
});

test("bounds request and response memory before forwarding bytes", async t => {
  const requestLimited = await harness(t, { requestMaxBytes: 16 });
  const tooLarge = await requestLimited.post("/v1/images/generations", {
    model: "gpt-image-2", prompt: "x".repeat(64),
  });
  assert.equal(tooLarge.status, 413);
  assert.equal((await tooLarge.json()).error.code, "request_too_large");
  assert.equal(requestLimited.state.modelReads, 0);
  assert.equal(requestLimited.calls.length, 0);

  const responseLimited = await harness(t, { responseMaxBytes: 4,
    reply: () => ({ status: 200, body: "12345" }) });
  const tooLargeResponse = await responseLimited.post("/v1/images/generations",
    { model: "gpt-image-2", prompt: "fixture" });
  assert.equal(tooLargeResponse.status, 502);
  assert.equal((await tooLargeResponse.json()).error.code, "image_response_too_large");
});

test("accepts only JSON POST requests on the dedicated image endpoints", async t => {
  const h = await harness(t);
  const get = await fetch(h.base + "/v1/images/generations");
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
  const text = await fetch(h.base + "/v1/images/generations", {
    method: "POST", headers: { "content-type": "text/plain" }, body: "fixture",
  });
  assert.equal(text.status, 415);
  const malformed = await h.post("/v1/images/generations", "{invalid");
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, "invalid_request_body");
  assert.equal(h.state.modelReads, 0);
  assert.equal(h.calls.length, 0);
});

test("retries only authentication failures once with a newly issued token", async t => {
  for (const first of [
    { status: 401, body: '{"error":"unauthorized"}' },
    { status: 400, body: '{"error":"expired token"}' },
  ]) {
    const h = await harness(t, { reply: attempt => attempt === 1 ? first : {
      status: 200, body: '{"data":[{"b64_json":"ok"}]}',
    } });
    const response = await h.post("/v1/images/generations",
      { model: "gpt-image-2", prompt: "fixture" });
    assert.equal(response.status, 200);
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[0].headers.Authorization, "Bearer token-0");
    assert.equal(h.calls[1].headers.Authorization, "Bearer token-1");
    assert.deepEqual(h.state.invalidations, ["token-0"]);
  }

  const nonAuth = await harness(t, { reply: () => ({
    status: 400, body: '{"error":{"code":"invalid_value"}}',
    headers: { "content-type": "application/json" },
  }) });
  const rejected = await nonAuth.post("/v1/images/generations",
    { model: "gpt-image-2", prompt: "fixture", quality: "invalid" });
  assert.equal(rejected.status, 400);
  assert.equal(nonAuth.calls.length, 1);
  assert.deepEqual(nonAuth.state.invalidations, []);
  assert.deepEqual(await rejected.json(), { error: { code: "invalid_value" } });

  const stillExpired = await harness(t, { reply: () => ({
    status: 400, body: '{"error":"expired token"}',
    headers: { "content-type": "application/json" },
  }) });
  const twiceRejected = await stillExpired.post("/v1/images/generations",
    { model: "gpt-image-2", prompt: "fixture" });
  assert.equal(twiceRejected.status, 400);
  assert.equal(stillExpired.calls.length, 2, "authentication retry remains bounded to one replay");
  assert.deepEqual(stillExpired.state.invalidations, ["token-0", "token-1"],
    "the final rejected credential is not cached for the next request");
});

test("account changes before transport or during the response cannot return old image bytes", async t => {
  const before = await harness(t, { onToken: async state => { state.session = "account-b/2"; } });
  const early = await before.post("/v1/images/generations",
    { model: "gpt-image-2", prompt: "fixture" });
  assert.equal(early.status, 409);
  assert.equal((await early.json()).error.code, "image_session_changed");
  assert.equal(before.calls.length, 0);

  const during = await harness(t, { reply: () => ({
    status: 200, manual: true,
    start(stream, state) {
      stream.write('{"data":[{"b64_json":"old');
      setTimeout(() => {
        state.session = "account-b/2";
        stream.end('-account"}]}');
      }, 5);
    },
  }) });
  const stale = await during.post("/v1/images/generations",
    { model: "gpt-image-2", prompt: "fixture" });
  assert.equal(stale.status, 409);
  const payload = await stale.text();
  assert.match(payload, /image_session_changed/);
  assert.doesNotMatch(payload, /old-account/);
});

test("unknown models and unavailable image capability fail locally without upstream traffic", async t => {
  const h = await harness(t);
  const unknown = await h.post("/v1/images/generations",
    { model: "gpt-image-unavailable", prompt: "fixture" });
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).error.code, "model_not_supported");
  assert.equal(h.calls.length, 0);

  const unavailable = await harness(t, { models: [] });
  const missing = await unavailable.post("/v1/images/generations",
    { model: "gpt-image-2", prompt: "fixture" });
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error.code, "image_generation_unavailable");
  assert.equal(unavailable.calls.length, 0);
});

test("client disconnect destroys an in-flight image response", async t => {
  const h = await harness(t, { reply: () => ({ status: 200, manual: true }) });
  const request = http.request(h.base + "/v1/images/generations", {
    method: "POST", headers: { "content-type": "application/json" },
  });
  request.on("error", () => {});
  request.end(JSON.stringify({ model: "gpt-image-2", prompt: "fixture" }));
  for (let count = 0; count < 50 && !h.streams.length; count++) {
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.equal(h.streams.length, 1);
  request.destroy();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.streams[0].destroyed, true);
});
