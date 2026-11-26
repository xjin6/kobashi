const assert = require("node:assert/strict");
const http = require("node:http");
const { Readable, Writable } = require("node:stream");
const test = require("node:test");
const { createClaudeGateway } = require("../lib/claude-gateway");
const { buildClaudeRoutes } = require("../lib/claude-routes");

const query = "GitHub Copilot usage documentation";
const url = "https://docs.github.com/en/copilot";
const title = "GitHub Copilot documentation";
const hosted = { name: "web_search", type: "web_search_20250305", max_uses: 1 };
const clientTool = { name: "WebSearch", description: "Search the web", input_schema: {
  type: "object", properties: { query: { type: "string" } }, required: ["query"],
} };
const main = "gpt-6.2-sol", fallback = "gpt-5.6-sol", chat = "gemini-fixture";

function record(id, platform, path) {
  return { id, name: id, vendor: platform, supported_endpoints: [path], policy: { state: "enabled" },
    capabilities: { type: "chat", supports: { tool_calls: true, streaming: true } }, model_picker_enabled: true };
}
const catalog = [record(main, "OpenAI", "/responses"), record(fallback, "OpenAI", "/responses"),
  record(chat, "Google", "/chat/completions")];

function searchOutput() {
  return { id: "resp_search", status: "completed", output: [
    { type: "web_search_call", id: "ws_1", status: "completed",
      action: { type: "search", query, sources: [{ type: "url", url, title }] } },
    { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [
      { type: "output_text", text: title, annotations: [{ type: "url_citation", title, url, start_index: 0, end_index: title.length }] },
    ] },
  ], usage: { input_tokens: 8, output_tokens: 7 } };
}

function hostedRequest(model, stream = false) {
  return { model, max_tokens: 1500, stream, tools: [hosted],
    messages: [{ role: "user", content: [{ type: "text", text: "Perform a web search for the query: " + query }] }] };
}

// A real loopback Claude HTTP listener. The Copilot transport can emit a
// Responses event stream or JSON according to the actual upstream request.
async function start(t, respond, models = catalog) {
  const routes = buildClaudeRoutes(models);
  const calls = [], invalidated = [];
  let tokens = 0;
  const handler = createClaudeGateway({
    active: () => "fixture-account", gatewayToken: () => "local-fixture-key", routes: async () => routes,
    hostname: "copilot.invalid", token: async () => "upstream-" + ++tokens,
    invalidateToken: bearer => invalidated.push(bearer), isAuthFailure: () => false,
    request: async (options, receive) => {
      const bytes = [];
      return new Writable({
        write(chunk, _, done) { bytes.push(chunk); done(); },
        final(done) {
          const call = { ...options, body: JSON.parse(Buffer.concat(bytes)) };
          calls.push(call);
          const reply = respond?.(call, calls.length) || { body: searchOutput() };
          const status = reply.status || 200;
          let payload = JSON.stringify(reply.body);
          const sse = !reply.stream && status === 200 && call.body.stream && call.path === "/responses";
          if (sse) {
            const events = [{ type: "response.created", response: { id: reply.body.id, status: "in_progress" } }];
            for (const [output_index, item] of reply.body.output.entries()) {
              events.push({ type: "response.output_item.done", output_index, item });
            }
            events.push({ type: "response.completed", response: reply.body });
            payload = events.map(event => "data: " + JSON.stringify(event) + "\n\n").join("") + "data: [DONE]\n\n";
          }
          const upstream = reply.stream || Readable.from([Buffer.from(payload)]);
          upstream.statusCode = status;
          upstream.headers = { "content-type": sse ? "text/event-stream" : "application/json" };
          receive(upstream);
          done();
        },
      });
    },
  });
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const endpoint = `http://127.0.0.1:${server.address().port}/claude-desktop/v1/messages?beta=true`;
  return {
    calls, invalidated,
    id: raw => routes.find(r => r.model.id === raw).id,
    post: (body, headers = {}) => fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json",
      Authorization: "Bearer local-fixture-key", ...headers }, body: JSON.stringify(body) }),
  };
}

function verifyBlocks(blocks) {
  const call = blocks.find(b => b.type === "server_tool_use");
  assert.ok(call?.id);
  assert.equal(call.name, "web_search");
  const result = blocks.find(b => b.type === "web_search_tool_result");
  assert.equal(result?.tool_use_id, call.id);
  assert.deepEqual(result.content.map(({ type, url, title }) => ({ type, url, title })),
    [{ type: "web_search_result", url, title }]);
}

test("native Messages executes its own search and uses a helper only on explicit rejection", async t => {
  const native = "claude-sonnet-4.6";
  const nativeAnswer = { type: "message", id: "msg_native", content: [
    { type: "text", text: "Native search result", citations: [{ type: "web_search_result_location", url, title }] },
  ] };
  const bridge = await start(t, (_, index) => {
    if (index === 1) return { body: nativeAnswer };
    if (index === 2) return { status: 400, body: { error: { message: "web_search is not supported on this model" } } };
  }, [record(native, "Anthropic", "/v1/messages"), record(fallback, "OpenAI", "/responses")]);
  const input = hostedRequest(bridge.id(native));
  assert.deepEqual(await (await bridge.post(input)).json(), nativeAnswer);
  verifyBlocks((await (await bridge.post(input)).json()).content);
  assert.deepEqual(bridge.calls.map(c => [c.path, c.body.model]), [
    ["/v1/messages", native], ["/v1/messages", native], ["/responses", fallback],
  ]);
  assert.deepEqual(bridge.calls[0].body, { ...input, model: native });
});

test("the native fast search profile requests a low search context and keeps completed hits on output exhaustion", async t => {
  const partial = searchOutput();
  partial.status = "incomplete";
  partial.incomplete_details = { reason: "max_output_tokens" };
  const bridge = await start(t, () => ({ body: partial }));
  const input = { ...hostedRequest(bridge.id(main)), tools: [{ ...hosted, search_profile: "fast" }] };
  const answer = await (await bridge.post(input)).json();
  verifyBlocks(answer.content);
  assert.equal(answer.stop_reason, "max_tokens");
  assert.equal(answer.content.some(b => b.type === "text"), false);
  assert.equal(bridge.calls[0].body.tools[0].search_context_size, "low");
});

test("selected Responses model performs actual hosted search and returns linked Anthropic result blocks", async t => {
  const bridge = await start(t);
  const alias = bridge.id(main);
  const res = await bridge.post(hostedRequest(alias));
  assert.equal(res.status, 200);
  const answer = await res.json();
  assert.equal(answer.model, alias);
  verifyBlocks(answer.content);
  assert.equal(bridge.calls.length, 1);
  const [call] = bridge.calls;
  assert.equal(call.path, "/responses");
  assert.equal(call.body.model, main);
  assert.ok(call.body.tools.some(t => t.type === "web_search"));
  assert.ok(call.body.include.includes("web_search_call.action.sources"));
  assert.deepEqual(call.body.input, [{ role: "user", content: query }]);
});

test("streaming search delivers native result events and finishes once", async t => {
  const bridge = await start(t);
  const res = await bridge.post(hostedRequest(bridge.id(main), true), { "anthropic-beta": "web-search-results-only-2026-02-09" });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  const events = (await res.text()).split(/\r?\n/).filter(line => line.startsWith("data: "))
    .map(line => JSON.parse(line.slice(6)));
  assert.equal(events[0].type, "message_start");
  const blocks = events.filter(e => e.type === "content_block_start").map(e => e.content_block);
  verifyBlocks(blocks);
  assert.equal(blocks.at(-1).type, "web_search_tool_result");
  assert.deepEqual(JSON.parse(events.find(e => e.delta?.type === "input_json_delta").delta.partial_json), { query });
  assert.equal(events.at(-1).type, "message_stop");
  assert.equal(events.filter(e => e.type === "message_stop").length, 1);
  assert.equal(bridge.calls.length, 1);
  assert.equal(bridge.calls[0].headers.Accept, "application/json");
  assert.equal(bridge.calls[0].body.stream, false);
  assert.equal(bridge.calls[0].headers["anthropic-beta"], undefined);
});

test("Chat runs its client WebSearch, scopes the helper model to the search subrequest and resumes the original model", async t => {
  const bridge = await start(t, call => {
    if (call.path === "/responses") return;
    const first = call.body.messages.length === 1;
    const message = first ? { role: "assistant", content: null, tool_calls: [
      { id: "call_native", type: "function", function: { name: clientTool.name, arguments: JSON.stringify({ query }) } },
    ] } : { role: "assistant", content: "done" };
    return { body: { id: "chat_1", choices: [{ finish_reason: first ? "tool_calls" : "stop", message }] } };
  });
  const alias = bridge.id(chat);
  const outer = { ...hostedRequest(alias), tools: [clientTool] };
  const first = await (await bridge.post(outer)).json();
  assert.equal(first.stop_reason, "tool_use");
  assert.deepEqual(first.content[0], { type: "tool_use", id: "call_native", name: clientTool.name, input: { query } });
  const found = await (await bridge.post(hostedRequest(alias))).json();
  verifyBlocks(found.content);
  const last = await bridge.post({ ...outer, messages: [...outer.messages, { role: "assistant", content: first.content },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_native", content: url }] }] });
  assert.equal((await last.json()).content[0].text, "done");
  assert.deepEqual(bridge.calls.map(c => [c.path, c.body.model]),
    [["/chat/completions", chat], ["/responses", fallback], ["/chat/completions", chat]]);
});

test("mixed client tools stay on their normal route and a Chat-only account cannot fabricate a search", async t => {
  const bridge = await start(t, () => ({ body: { choices: [{ finish_reason: "stop", message: { content: "normal" } }] } }),
    [record(chat, "Google", "/chat/completions"), { ...record(fallback, "OpenAI", "/responses"), policy: { state: "disabled" } }]);
  const alias = bridge.id(chat);
  const mixed = await bridge.post({ ...hostedRequest(alias), tools: [hosted, clientTool] });
  assert.equal(mixed.status, 200);
  assert.equal((await mixed.json()).content[0].text, "normal");
  assert.deepEqual(bridge.calls[0].body.tools.map(tool => tool.function.name), ["WebSearch"]);
  const missing = await bridge.post(hostedRequest(alias));
  assert.ok(missing.status >= 400);
  assert.equal((await missing.json()).type, "error");
  assert.equal(bridge.calls.length, 1);
});

test("one 401 refresh retries the same search, permission failures preserve the provider's error", async t => {
  const bridge = await start(t, (_, index) => {
    if (index === 1) return { status: 401, body: { error: { message: "Stale session" } } };
    if (index === 3) return { status: 403, body: { error: { message: "Search disabled by organization" } } };
  });
  const req = hostedRequest(bridge.id(main));
  const success = await bridge.post(req);
  assert.equal(success.status, 200);
  verifyBlocks((await success.json()).content);
  assert.deepEqual(bridge.calls.slice(0, 2).map(c => c.body.model), [main, main]);
  assert.deepEqual(bridge.calls.slice(0, 2).map(c => c.headers.Authorization), ["Bearer upstream-1", "Bearer upstream-2"]);
  assert.deepEqual(bridge.invalidated, ["upstream-1"]);
  const denied = await bridge.post(req);
  assert.equal(denied.status, 403);
  assert.match((await denied.json()).error.message, /disabled by organization/);
  assert.equal(bridge.calls.length, 3);
});

test("only explicit unsupported hosted-tool errors permit a different Responses model", async t => {
  const bridge = await start(t, (_, index) => {
    if (index === 1) return { status: 400, body: { error: { code: "unsupported_value", param: "tools[0].type",
      message: "This model does not support the web_search tool." } } };
    if (index === 3) return { status: 400, body: { error: { message: "Invalid input syntax" } } };
  });
  const req = hostedRequest(bridge.id(main));
  const search = await bridge.post(req);
  assert.equal(search.status, 200);
  verifyBlocks((await search.json()).content);
  assert.deepEqual(bridge.calls.map(c => c.body.model), [main, fallback]);
  const invalid = await bridge.post(req);
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error.message, /Invalid input syntax/);
  assert.equal(bridge.calls.length, 3);
});

test("an invalid tool type can use the helper while an unsupported search filter cannot", async t => {
  const bridge = await start(t, (_, index) => {
    if (index === 1) return { status: 400, body: { error: { code: "invalid_value", param: "tools[0].type",
      message: "Invalid value: 'web_search'. Supported values are: 'function' and 'custom'." } } };
    if (index === 3) return { status: 400, body: { error: { code: "unsupported_value", param: "tools[0].filters.blocked_domains",
      message: "web_search does not support blocked_domains." } } };
  });
  const request = hostedRequest(bridge.id(main));
  const recovered = await bridge.post(request);
  assert.equal(recovered.status, 200);
  verifyBlocks((await recovered.json()).content);
  const invalid = await bridge.post({ ...request, tools: [{ ...hosted, blocked_domains: ["example.com"] }] });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error.message, /does not support blocked_domains/);
  assert.deepEqual(bridge.calls.map(c => c.body.model), [main, fallback, main]);
});

test("one logical CCD search can refresh credentials only once across primary and helper attempts", async t => {
  const bridge = await start(t, (_, index) => {
    if (index === 1 || index === 3) return { status: 401, body: { error: { message: "Token rejected" } } };
    if (index === 2) return { status: 400, body: { error: { code: "unsupported_value", param: "tools[0].type",
      message: "This model does not support the web_search tool." } } };
  });
  const rejected = await bridge.post(hostedRequest(bridge.id(main)));
  assert.equal(rejected.status, 401);
  assert.equal((await rejected.json()).error.type, "authentication_error");
  assert.deepEqual(bridge.calls.map(c => c.body.model), [main, main, fallback]);
});

test("a prose-only response permits one helper retry and never passes as a completed search", async t => {
  const ungrounded = { id: "without_search", status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: "Try " + url, annotations: [] }] }] };
  const bridge = await start(t, (call, index) => ({ body: index === 2 && call.body.model === fallback ? searchOutput() : ungrounded }));
  const req = hostedRequest(bridge.id(main));
  const recovered = await bridge.post(req);
  assert.equal(recovered.status, 200);
  verifyBlocks((await recovered.json()).content);
  assert.deepEqual(bridge.calls.map(call => call.body.model), [main, fallback]);

  const response = await bridge.post(req);
  assert.equal(response.status, 502);
  const failure = await response.json();
  assert.equal(failure.type, "error");
  assert.equal(failure.content, undefined);
  assert.deepEqual(bridge.calls.map(call => call.body.model), [main, fallback, main, fallback]);
});

test("a real search returning zero sources cannot promote an uncited URL from answer text", async t => {
  const output = searchOutput();
  output.output[0].action.sources = [];
  output.output[1].content = [{ type: "output_text", text: "Try visiting " + url, annotations: [] }];
  const bridge = await start(t, () => ({ body: output }));
  const response = await bridge.post(hostedRequest(bridge.id(main)));
  assert.equal(response.status, 200);
  const blocks = (await response.json()).content;
  const call = blocks.find(block => block.type === "server_tool_use");
  const result = blocks.find(block => block.type === "web_search_tool_result");
  assert.equal(result.tool_use_id, call.id);
  assert.deepEqual(result.content, []);
  assert.equal(bridge.calls.length, 1);
});

test("host filters are sent to Copilot and the final CCD result enforces path restrictions", async t => {
  const reply = searchOutput();
  const excluded = "https://docs.github.com/en/actions";
  reply.output[0].action.sources.push({ type: "url", url: excluded, title: "Outside the requested path" });
  reply.output[1].content[0].text += " " + excluded;
  const bridge = await start(t, () => ({ body: reply }));
  const request = hostedRequest(bridge.id(chat));
  request.tools = [{ ...hosted, allowed_domains: ["docs.github.com/en/copilot"] }];
  const response = await bridge.post(request);
  assert.equal(response.status, 200);
  const answer = await response.json();
  verifyBlocks(answer.content);
  assert.ok(!JSON.stringify(answer.content).includes(excluded));
  assert.deepEqual(bridge.calls[0].body.tools[0].filters, { allowed_domains: ["docs.github.com"] });
  const rejected = await bridge.post({ ...request, tools: [{ ...request.tools[0], blocked_domains: ["example.org"] }] });
  assert.equal(rejected.status, 400);
  assert.equal(bridge.calls.length, 1);
});

test("rate limiting and an interrupted Copilot search both stop without another model or token retry", async t => {
  const bridge = await start(t, (_, index) => {
    if (index === 1) return { status: 429, body: { error: { message: "Copilot search rate limit reached" } } };
    return { stream: Readable.from((async function* () {
      yield Buffer.from('{"id":"partial"');
      throw new Error("Copilot search connection interrupted");
    })()) };
  });
  const req = hostedRequest(bridge.id(main));
  const limited = await bridge.post(req);
  assert.equal(limited.status, 429);
  assert.match((await limited.json()).error.message, /rate limit/);
  const interrupted = await bridge.post(req);
  assert.equal(interrupted.status, 502);
  assert.match((await interrupted.json()).error.message, /interrupted/);
  assert.deepEqual(bridge.calls.map(call => call.body.model), [main, main]);
  assert.deepEqual(bridge.invalidated, []);
});
