const assert = require("node:assert/strict");
const http = require("node:http");
const { Readable, Writable } = require("node:stream");
const test = require("node:test");
const { createGrokGateway, listGrokModels } = require("../lib/grok-gateway");

const localKey = "grok-local-fixture";
const chatPath = "/v1/chat/completions";
const responsePath = "/v1/responses";
function model(id, supported_endpoints, overrides = {}) {
  return { id, name: id, vendor: "xAI", capabilities: { type: "chat" }, supported_endpoints, ...overrides };
}
const chatModel = model("grok-code-fast-1", ["/v1/chat/completions"]);
const responseModel = model("grok-4.7", ["/responses"], { name: "Grok 4.7",
  capabilities: { type: "chat", supports: { vision: true, reasoning_effort: ["low", null, "high", "low"] },
    limits: { max_context_window_tokens: 500000, max_prompt_tokens: 100000 } } });
const wrongVendor = model("grok-lookalike", ["/responses"], { vendor: "Other" });

async function fixture(t, { respond, afterCatalog, beforeToken, beforeSend } = {}) {
  const state = { session: 1, catalog: [chatModel, responseModel, wrongVendor], discoveries: 0, tokens: 0,
    rejected: [], calls: [] };
  const handler = createGrokGateway({
    active: () => state.session, gatewayToken: () => localKey,
    models: async () => { state.discoveries++; afterCatalog?.(state); return state.catalog; },
    hostname: "api.copilot.test",
    token: async () => { beforeToken?.(state); return "copilot-" + ++state.tokens; },
    invalidateToken: bearer => state.rejected.push(bearer),
    isAuthFailure: body => /invalid api key/i.test(body),
    request: async (options, receive) => {
      beforeSend?.(state);
      const chunks = [];
      return new Writable({
        write(chunk, _, done) { chunks.push(chunk); done(); },
        final(done) {
          const raw = Buffer.concat(chunks).toString("utf8");
          const call = { ...options, raw, body: JSON.parse(raw) };
          state.calls.push(call);
          const result = respond?.(call, state) || {};
          const incoming = result.stream || Readable.from([Buffer.from(JSON.stringify(result.body ?? { ok: true }))]);
          incoming.statusCode = result.status ?? 200;
          incoming.headers = result.headers || {};
          receive(incoming);
          done();
        },
      });
    },
  });
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = "http://127.0.0.1:" + server.address().port;
  const bearer = { authorization: "Bearer " + localKey };
  return { state, get: (path = "/v1/models", headers = bearer) => fetch(base + path, { headers }),
    post: (path, body, headers = bearer) => fetch(base + path, {
      method: "POST", headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }) };
}

test("discovery includes only enabled Grok chat IDs with a supported HTTP endpoint", () => {
  const legacy = model("xai/grok-legacy", undefined, { vendor: undefined });
  const selectable = [responseModel, chatModel, legacy];
  const other = [wrongVendor, null, responseModel, model("gpt-mimic", ["/responses"]),
    model("grok-unknown", ["/responses"], { vendor: undefined }),
    model("grok-malformed-vendor", ["/responses"], { vendor: ["xAI"] }),
    model("xai/grok-conflict", ["/responses"], { vendor: "Other" }),
    model("grok-hidden", ["/responses"], { model_picker_enabled: false }),
    model("grok-private", ["/responses"], { description: "Internal only" }),
    model("grok-off", ["/responses"], { policy: { state: "disabled" } }),
    model("grok-embed", ["/responses"], { capabilities: { type: "embedding" } }),
    model("grok-no-stream", ["/responses"], { capabilities: { type: "chat", supports: { streaming: false } } }),
    model("grok-no-tools", ["/responses"], { capabilities: { type: "chat", supports: { tool_calls: false } } }),
    model("grok-ws", ["/responses/websocket"]), model("grok-empty", []), model("grok-malformed", "/responses")];
  const list = listGrokModels({ data: [...selectable, ...other] });
  assert.equal(list.object, "list");
  assert.deepEqual(list.data.map(x => x.id), selectable.map(x => x.id));
  assert.deepEqual(list.data[0], { id: "grok-4.7", object: "model", display_name: "Grok 4.7",
    created: 0, owned_by: "xai", supported_endpoints: ["/responses"], context_window: 500000, supports_vision: true,
    reasoning_efforts: ["low", "high"] });
  assert.deepEqual(list.data[2].supported_endpoints, ["/chat/completions"]);
  assert.deepEqual(listGrokModels([]).data, []);
});

test("local bearer, exact model IDs and allowed endpoint are enforced before inference", async t => {
  const { state, get, post } = await fixture(t);
  for (const headers of [{}, { authorization: "Bearer invalid" }, { "x-api-key": localKey }]) {
    assert.equal((await get("/v1/models", headers)).status, 401);
    assert.equal((await post(responsePath, { model: responseModel.id }, headers)).status, 401);
  }
  assert.equal(state.discoveries, 0);
  assert.equal((await get("/v1/files")).status, 404);
  assert.equal((await post("/other/chat/completions", { model: responseModel.id })).status, 404);
  assert.equal((await post(responsePath, "{")).status, 400);
  assert.equal((await post(responsePath, { model: "" })).status, 400);
  assert.equal(state.discoveries, 0);
  assert.deepEqual((await (await get("/v1/models?limit=10")).json()).data.map(x => x.id), [chatModel.id, responseModel.id]);
  for (const id of ["gpt-fixture", wrongVendor.id, "grok-removed", responseModel.id.toUpperCase()]) {
    assert.equal((await post(responsePath, { model: id })).status, 404);
  }
  assert.equal((await post(chatPath, { model: responseModel.id })).status, 400);
  assert.equal((await post(responsePath, { model: chatModel.id })).status, 400);
  state.catalog = [];
  assert.deepEqual((await (await get()).json()).data, []);
  assert.equal((await post(responsePath, { model: responseModel.id })).status, 404);
  assert.equal(state.tokens, 0);
  assert.equal(state.calls.length, 0);
  state.session = null;
  assert.equal((await get()).status, 401);
});

test("Chat and Responses preserve user content, tool calls and exact upstream model without forwarding client credentials", async t => {
  const { state, post } = await fixture(t);
  const content = [{ type: "input_image", image_url: "data:image/png;base64,test" }];
  const body = { model: responseModel.id, input: [{ role: "user", content },
    { type: "function_call_output", call_id: "tool-1", output: "file" }], tools: [{ type: "function", name: "read" }] };
  const headers = { authorization: "Bearer " + localKey, "x-api-key": "xai-fixture", cookie: "private=true",
    "x-initiator": "untrusted" };
  const reply = await post(responsePath + "?client=desktop", body, headers);
  assert.equal(reply.status, 200);
  assert.deepEqual(await reply.json(), { ok: true });
  assert.deepEqual(state.calls[0].body, body);
  assert.equal(state.calls[0].path, "/responses");
  assert.equal(state.calls[0].hostname, "api.copilot.test");
  assert.equal(state.calls[0].headers.Authorization, "Bearer copilot-1");
  assert.equal(state.calls[0].headers["X-Initiator"], "agent");
  assert.equal(state.calls[0].headers["Copilot-Vision-Request"], "true");
  assert.doesNotMatch(JSON.stringify(state.calls[0].headers), /grok-local-fixture|xai-fixture|private=true|untrusted/);
  // Both parsers receive one unambiguous model ID even with a duplicate key.
  const chat = '{"model":"gpt-fixture","model":"grok-code-fast-1","messages":[{"role":"user","content":"hello"}]}';
  assert.equal((await post(chatPath, chat)).status, 200);
  assert.equal(state.calls[1].body.model, chatModel.id);
  assert.equal(state.calls[1].path, "/v1/chat/completions");
  assert.doesNotMatch(state.calls[1].raw, /gpt-fixture/);
  assert.equal(state.calls[1].headers["X-Initiator"], "user");
});

test("SSE delivers the first bytes before completion and preserves subsequent event bytes", { timeout: 5000 }, async t => {
  const first = "event: response.created\ndata: {}\n\n";
  const last = "event: response.completed\ndata: {}\n\n";
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(release);
  const { post } = await fixture(t, { respond: () => ({ headers: { "content-type": "text/event-stream" },
    stream: Readable.from((async function* () { yield Buffer.from(first); await gate; yield Buffer.from(last); })()) }) });
  const response = await post(responsePath, { model: responseModel.id, stream: true });
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const reader = response.body.getReader();
  assert.equal(Buffer.from((await reader.read()).value).toString(), first);
  release();
  assert.equal(Buffer.from((await reader.read()).value).toString(), last);
  assert.equal((await reader.read()).done, true);
});

test("only an auth rejection retries once, using the same route, model, and body", async t => {
  let status = 400, message = "Invalid API key";
  const { state, post } = await fixture(t, { respond: () => ({
    status, body: { error: { message } }, headers: { "retry-after": "30" },
  }) });
  const body = { model: chatModel.id, messages: [{ role: "user", content: "hello" }] };
  const response = await post(chatPath, body);
  assert.equal(response.status, 400);
  assert.deepEqual((await response.json()).error, { message });
  assert.equal(state.calls.length, 2);
  assert.deepEqual(state.calls.map(c => c.headers.Authorization), ["Bearer copilot-1", "Bearer copilot-2"]);
  assert.deepEqual(state.rejected, ["copilot-1", "copilot-2"]);
  assert.deepEqual(state.calls[1].body, body);
  assert.equal(state.calls[1].path, state.calls[0].path);
  message = "invalid option";
  await post(chatPath, body);
  assert.equal(state.calls.length, 3);
  status = 429;
  const limited = await post(chatPath, body);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "30");
  assert.equal(state.calls.length, 4);
});

test("account changes during discovery, token mint, tunnel creation or non-streaming reply cannot leak results", async t => {
  const change = state => { state.session++; };
  const body = { model: responseModel.id, input: "hello" };
  for (const stage of ["afterCatalog", "beforeToken", "beforeSend"]) {
    const { state, post } = await fixture(t, { [stage]: change });
    assert.equal((await post(responsePath, body)).status, 401);
    assert.equal(state.calls.length, 0, stage);
  }
  const { post } = await fixture(t, { respond: (_, state) => ({
    stream: Readable.from((async function* () { state.session++; yield Buffer.from('{"private":true}'); })()),
  }) });
  const response = await post(responsePath, body);
  assert.equal(response.status, 401);
  assert.doesNotMatch(await response.text(), /private/);
});
