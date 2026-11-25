const assert = require("node:assert/strict");
const http = require("node:http");
const { Readable, Writable } = require("node:stream");
const test = require("node:test");
const { createClaudeGateway } = require("../lib/claude-gateway");
const { buildClaudeRoutes } = require("../lib/claude-routes");

const DESKTOP = "/claude-desktop/v1";
const KEY = "fixture-local-gateway";
const auth = { authorization: "Bearer " + KEY };
const tool = { name: "Read", input_schema: { type: "object", properties: { path: { type: "string" } } } };
const prompt = model => ({ model, messages: [{ role: "user", content: "Inspect README" }], max_tokens: 500 });
function model(id, name, vendor, endpoints) {
  return { id, name, vendor, supported_endpoints: endpoints, model_picker_enabled: true, policy: { state: "enabled" },
    capabilities: { type: "chat", supports: { streaming: true, tool_calls: true, reasoning_effort: ["low", "high"] } } };
}
const gpt = model("gpt-5-probe", "OpenAI fixture", "OpenAI", ["/chat/completions", "/responses"]);
const gemini = model("gemini-probe", "Gemini fixture", "Google", ["/chat/completions", "/responses"]);
const claude = model("claude-sonnet-4.6", "Claude fixture", "Anthropic", ["/chat/completions", "/v1/messages"]);
const chatReply = { id: "chat-1", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }] };
const responsesReply = { id: "resp-1", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] };

// Use the actual HTTP handler on an ephemeral loopback port. Only the upstream
// transport is mocked. No session, profile, CLI process, or Copilot account is loaded.
async function fixture(t, options = {}) {
  const state = { account: "first", models: [gpt, gemini, claude], calls: [], invalidated: [], issued: 0, discoveries: 0 };
  const handler = createClaudeGateway({
    hostname: "copilot.invalid", active: () => state.account, gatewayToken: () => KEY,
    routes: async () => { state.discoveries++; return buildClaudeRoutes(state.models); },
    token: async () => {
      state.issued++;
      options.beforeToken?.(state);
      return "copilot-" + state.issued;
    },
    invalidateToken: token => state.invalidated.push(token),
    isAuthFailure: text => /not a valid API key/i.test(text),
    request: async (request, receive) => {
      const chunks = [];
      return new Writable({
        write(bytes, _, done) { chunks.push(bytes); done(); },
        final(done) {
          const call = { ...request, body: JSON.parse(Buffer.concat(chunks)) };
          state.calls.push(call);
          const reply = options.respond?.(call, state) || {
            body: call.path === "/responses" ? responsesReply : chatReply,
          };
          const upstream = reply.stream || Readable.from([Buffer.from(JSON.stringify(reply.body))]);
          upstream.statusCode = reply.status || 200;
          receive(upstream);
          done();
        },
      });
    },
  });
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  function post(body, url = DESKTOP + "/messages", headers = auth) {
    return fetch(base + url, { method: "POST", headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body) });
  }
  return { state, post, get: (url = DESKTOP + "/models", headers = auth) => fetch(base + url, { headers }) };
}

test("the Desktop prefix authenticates before discovery, including the token counter", async t => {
  const { state, get, post } = await fixture(t);
  for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: KEY }]) {
    const response = await get(DESKTOP + "/models?beta=true", headers);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.type, "authentication_error");
  }
  assert.equal((await post(prompt(gpt.id), DESKTOP + "/messages/count_tokens", {})).status, 401);
  assert.equal(state.discoveries, 0);
  assert.equal(state.issued, 0);
  assert.equal((await get(DESKTOP + "/models?beta=true", { "x-api-key": KEY })).status, 200);
  assert.equal((await get("/v1/models", {})).status, 200);
});

test("Desktop publishes distinct stable IDs, real labels and only tool-capable, enabled models", async t => {
  const { state, get, post } = await fixture(t);
  state.models = [gpt, gemini, claude,
    { ...gpt, id: "gpt-disabled", policy: { state: "disabled" } },
    { ...gpt, id: "no-tools", capabilities: { type: "chat", supports: { streaming: true, tool_calls: false } } },
    { ...gpt, id: "no-transport", supported_endpoints: ["/embeddings"] }];
  const first = await (await get()).json();
  assert.equal(first.has_more, false);
  assert.equal(first.first_id, first.data[0].id);
  assert.equal(first.last_id, first.data.at(-1).id);
  assert.deepEqual(new Set(first.data.map(x => x.display_name)), new Set([gpt.name, gemini.name, claude.name]));
  assert.equal(new Set(first.data.map(x => x.id)).size, 3);
  assert.ok(first.data.every(m => /^claude-(sonnet|haiku|opus|fable)-/.test(m.id)));
  state.models.reverse();
  assert.deepEqual((await (await get()).json()).data, first.data);
  for (const [wanted, endpoint] of [[gpt, "/responses"], [gemini, "/chat/completions"]]) {
    const alias = first.data.find(m => m.display_name === wanted.name).id;
    const response = await post(prompt(alias));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).content[0].text, "ok");
    const call = state.calls.at(-1);
    assert.equal(call.body.model, wanted.id);
    assert.equal(call.path, endpoint);
    assert.equal(call.hostname, "copilot.invalid");
    assert.doesNotMatch(JSON.stringify(call.headers), new RegExp(KEY));
  }
  const removed = first.data.find(m => m.display_name === gpt.name).id;
  state.models = [gemini];
  for (const id of [removed, gpt.id, "unrecognized-model"]) {
    const response = await post(prompt(id));
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.type, "not_found_error");
  }
  assert.equal(state.calls.length, 2);
  const internal = await post(prompt("claude-haiku-4-5-20251001"));
  assert.equal(internal.status, 200);
  assert.equal(state.calls.at(-1).body.model, gemini.id);
  state.models = [];
  assert.equal((await post(prompt("claude-sonnet-4-6"))).status, 404);
  assert.equal(state.calls.length, 3);
});

test("native Messages preserves signed history, client tools, betas, and streamed event bytes", async t => {
  const opaque = "fixture-native-signature";
  const events = 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"native"}}\n\n';
  const { state, post } = await fixture(t, { respond: () => ({ stream: Readable.from([Buffer.from(events)]) }) });
  const body = { model: "claude-sonnet-4-6", stream: true, max_tokens: 256,
    system: [{ type: "text", text: "System", cache_control: { type: "ephemeral" } }],
    tools: [tool], tool_choice: { type: "auto" }, thinking: { type: "adaptive" },
    messages: [{ role: "user", content: "Read" }, { role: "assistant", content: [
      { type: "thinking", thinking: "summary", signature: opaque }, { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "README" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "result" }] }] };
  const headers = { ...auth, "anthropic-beta": "context-management-test,effort-test", "anthropic-version": "2023-06-01",
    "x-api-key": "unused-fixture-credential" };
  const response = await post(body, DESKTOP + "/messages?beta=true", headers);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), events);
  const [call] = state.calls;
  assert.equal(call.path, "/v1/messages");
  assert.deepEqual(call.body, { ...body, model: claude.id });
  assert.equal(call.headers["anthropic-version"], headers["anthropic-version"]);
  assert.equal(call.headers["anthropic-beta"], headers["anthropic-beta"]);
  assert.equal(call.headers["X-Initiator"], "agent");
  assert.equal(call.headers.Authorization, "Bearer copilot-1");
  assert.equal(call.headers["x-api-key"], undefined);
});

test("Responses tool loop replays reasoning, the original call ID and text next to the result", async t => {
  const reason = { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Inspect the file." }], encrypted_content: "opaque-input" };
  const call = { type: "function_call", id: "fc_item", call_id: "call_exec", name: "Read", arguments: '{"path":"README"}' };
  const { state, get, post } = await fixture(t, { respond: (_, state) => state.calls.length === 1 ?
    { body: { id: "resp-tools", status: "completed", output: [reason, call] } } : undefined });
  const alias = (await (await get()).json()).data.find(x => x.display_name === gpt.name).id;
  const body = { ...prompt(alias), tools: [tool], output_config: { effort: "high" } };
  const first = await (await post(body)).json();
  assert.equal(first.model, alias);
  assert.equal(first.stop_reason, "tool_use");
  assert.equal(first.content[0].type, "thinking");
  assert.deepEqual(first.content[1], { type: "tool_use", id: call.call_id, name: tool.name, input: { path: "README" } });
  const follow = { ...body, messages: [...body.messages, { role: "assistant", content: first.content }, { role: "user", content: [
    { type: "tool_result", tool_use_id: call.call_id, content: "README content" }, { type: "text", text: "Summarize." }] }] };
  const next = await post(follow);
  assert.equal(next.status, 200);
  assert.equal((await next.json()).content[0].text, "ok");
  const request = state.calls[1].body;
  assert.equal(request.model, gpt.id);
  assert.equal(request.store, false);
  assert.deepEqual(request.input[1], reason);
  assert.equal(request.input[2].call_id, call.call_id);
  assert.deepEqual(request.input[3], { type: "function_call_output", call_id: call.call_id, output: "README content" });
  assert.deepEqual(request.input[4], { role: "user", content: [{ type: "input_text", text: "Summarize." }] });
  assert.equal(request.reasoning.effort, "high");
});

test("only token rejection gets one replay and it uses a newly issued upstream token", async t => {
  let mode = "auth";
  const { state, post } = await fixture(t, { respond: (_, state) => {
    if (mode === "auth" && state.calls.length === 1) return { status: 400, body: { error: { message: "Not a valid API key" } } };
    if (mode === "always") return { status: 401, body: { error: { message: "Expired token" } } };
    if (mode === "bad") return { status: 400, body: { error: { message: "Invalid input" } } };
  } });
  const first = await post(prompt(gpt.id));
  assert.equal(first.status, 200);
  assert.equal(state.calls.length, 2);
  assert.deepEqual(state.calls[0].body, state.calls[1].body);
  assert.deepEqual(state.calls.map(c => c.headers.Authorization), ["Bearer copilot-1", "Bearer copilot-2"]);
  assert.deepEqual(state.invalidated, ["copilot-1"]);
  mode = "always";
  const second = await post(prompt(gpt.id));
  assert.equal(second.status, 401);
  assert.equal((await second.json()).error.type, "authentication_error");
  assert.equal(state.calls.length, 4);
  mode = "bad";
  assert.equal((await post(prompt(gpt.id))).status, 400);
  assert.equal(state.calls.length, 5);
});

test("disabled bridge and account change during token acquisition cannot issue an upstream request", async t => {
  const { state, get, post } = await fixture(t, { beforeToken: state => { state.account = "new-account"; } });
  assert.equal((await post(prompt(gpt.id))).status, 401);
  assert.equal(state.calls.length, 0);
  state.account = null;
  assert.equal((await get()).status, 401);
  assert.equal((await post(prompt(gemini.id))).status, 401);
  assert.equal(state.calls.length, 0);
});

test("switching accounts during a nonstreaming response drops the obsolete response", async t => {
  const { state, post } = await fixture(t, { respond: (_, state) => ({
    stream: Readable.from((async function* () {
      await new Promise(resolve => setImmediate(resolve));
      state.account = "new-account";
      yield Buffer.from(JSON.stringify(responsesReply));
    })()),
  }) });
  const response = await post(prompt(gpt.id));
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.type, "authentication_error");
  assert.equal(state.calls.length, 1);
  assert.deepEqual(state.invalidated, []);
});

test("count_tokens accounts for context, tool schemas, and results without a Copilot call", async t => {
  const { state, post } = await fixture(t);
  const count = async body => {
    const response = await post(body, DESKTOP + "/messages/count_tokens?beta=true");
    assert.equal(response.status, 200);
    return (await response.json()).input_tokens;
  };
  const short = await count(prompt(gpt.id));
  const expanded = await count({ ...prompt(gpt.id), system: "system context", tools: [tool], messages: [
    ...prompt(gpt.id).messages,
    { role: "assistant", content: [{ type: "tool_use", id: "call", name: "Read", input: { path: "README" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: "data".repeat(200) }] },
  ] });
  assert.ok(Number.isInteger(short) && short > 0);
  assert.ok(expanded > short);
  assert.equal(state.issued, 0);
  assert.equal(state.discoveries, 0);
  assert.equal(state.calls.length, 0);
});
