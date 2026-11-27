const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { Readable, Writable } = require("node:stream");
const vm = require("node:vm");
const test = require("node:test");
const { selectCopilotOpenAIModels } = require("../lib/codex-model-catalog");
const { normalizeCodexRequest, retryCodexRequest } = require("../lib/codex-request-compat");
const { resolveCodexServiceTier } = require("../lib/codex-service-tier");
const { createResponsesSseNormalizer, normalizeModelAliasHeaders } = require("../lib/responses-sse-normalizer");

const { CodexModelCapabilities } = require("../lib/codex-model-capabilities");

const source = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");
const proxySource = source.slice(source.indexOf("function isAuthFailureBody(body)"),
  source.indexOf("// ─── Anthropic ↔ OpenAI translation"));

function model(id, overrides = {}) {
  return {
    id, vendor: "OpenAI", model_picker_enabled: true,
    supported_endpoints: ["/responses"],
    capabilities: { type: "chat", supports: {
      streaming: true, tool_calls: true, reasoning_effort: ["low", "medium", "high"],
    } },
    ...overrides,
  };
}

async function setup(t, options = {}) {
  const requests = [];
  let tokenRequests = 0;
  let refreshes = 0;
  const models = options.models || [model("gpt-5-mini")];
  const codexCapabilities = new CodexModelCapabilities({ probe: async () => ({ state: "verified", constraints: {} }) });
  codexCapabilities.setAccount("test-account");
  codexCapabilities.update(models, {});
  await codexCapabilities.idle();
  if (options.constraints) codexCapabilities.learn(models[0].id, codexCapabilities.token(models[0].id), options.constraints);
  const context = vm.createContext({
    codexCapabilities, codexBundledCatalog: { models: [] },
    http, Buffer, githubToken: "test-only", codexEnabled: true,
    copilotToken: null, copilotTokenExpiry: 0, COPILOT_API: "mock.invalid",
    log() {}, dbg() {}, normalizeCodexRequest, retryCodexRequest, selectCopilotOpenAIModels,
    createResponsesSseNormalizer, normalizeModelAliasHeaders, resolveCodexServiceTier,
    getCopilotModelsRaw: async () => models,
    ensureCodexModelSession: async () => { refreshes++; },
    readCodexModelCatalog: () => null,
    ensureCopilotToken: async () => { tokenRequests++; return "test-only"; },
    upstreamHttpsRequest: async (request, receive) => {
      const chunks = [];
      return new Writable({
        write(chunk, encoding, done) { chunks.push(chunk); done(); },
        final(done) {
          const bytes = Buffer.concat(chunks);
          requests.push({ ...request, body: JSON.parse(bytes), bytes });
          const response = options.respond?.(requests.at(-1), requests.length) || {
            status: 200, body: { status: "completed", output: [] },
          };
          const upstream = Readable.from([Buffer.from(response.rawBody ?? JSON.stringify(response.body))]);
          upstream.statusCode = response.status;
          upstream.headers = { "content-type": response.contentType || "application/json", ...response.headers };
          receive(upstream);
          done();
        },
      });
    },
  });
  // Run only the real Codex HTTP handler, with a mock upstream and a random
  // loopback port. Never start the app or load its session/config files.
  const server = vm.runInContext(`${proxySource}\nproxy;`, context);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    requests, codexCapabilities,
    counts: () => ({ tokenRequests, refreshes }),
    getModels: () => fetch(`${base}/v1/models`),
    post: (body, headers = {}) => fetch(`${base}/v1/responses`, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
    }),
  };
}

test("native account credentials and identity headers never reach the Copilot upstream", async t => {
  const bridge = await setup(t);
  const response = await bridge.post({ model: "gpt-5-mini", input: "fixture" }, {
    Authorization: "Bearer fixture-native-account", "ChatGPT-Account-Id": "fixture-account",
    "OpenAI-Organization": "fixture-org", "OpenAI-Project": "fixture-project",
  });
  assert.equal(response.status, 200); await response.json();
  assert.equal(bridge.requests.length, 1);
  assert.equal(bridge.requests[0].headers.Authorization, "Bearer test-only");
  const sent = Object.keys(bridge.requests[0].headers).map(key => key.toLowerCase());
  for (const header of ["chatgpt-account-id", "openai-organization", "openai-project"]) assert.equal(sent.includes(header), false);
});

test("proxy applies verified context support and forwards correct bytes without retrying", async t => {
  const bridge = await setup(t, { constraints: { "reasoning.context": ["auto", "current_turn"] } });
  const body = {
    model: "gpt-5-mini", input: [{ role: "user", content: "你好" }],
    reasoning: { effort: "medium", context: "all_turns" }, stream: false,
  };
  const response = await bridge.post(body);
  assert.equal(response.status, 200);
  await response.json();
  assert.equal(bridge.requests.length, 1);
  const sent = bridge.requests[0];
  assert.deepEqual(sent.body, { ...body, reasoning: { effort: "medium", context: "current_turn" } });
  assert.equal(sent.headers["Content-Length"], sent.bytes.length);
  assert.equal(bridge.counts().tokenRequests, 1);
});

test("native Ultra's xhigh request passes through with its delegation instructions", async t => {
  const bridge = await setup(t, { models: [model("gpt-6.1-sol", {
    capabilities: { type: "chat", supports: {
      streaming: true, tool_calls: true, reasoning_effort: ["low", "medium", "high", "xhigh", "max"],
    } },
  })] });
  const body = {
    model: "gpt-6.1-sol", reasoning: { effort: "xhigh", context: "all_turns" },
    input: [{ role: "developer", content: "Proactively delegate work to subagents." }],
  };
  const response = await bridge.post(body);
  await response.json();
  assert.deepEqual(bridge.requests[0].body, body);
});

test("models endpoint excludes chat-only, disabled, and unsupported tool models", async t => {
  const bridge = await setup(t, { models: [
    model("gpt-5-mini"),
    model("gpt-chat-only", { supported_endpoints: ["/chat/completions"] }),
    model("gpt-disabled", { policy: { state: "disabled" } }),
    model("gpt-no-tools", { capabilities: { type: "chat", supports: { streaming: true } } }),
  ] });
  const response = await bridge.getModels();
  assert.deepEqual((await response.json()).data.map(item => item.id), ["gpt-5-mini"]);
  assert.equal(bridge.counts().refreshes, 1);
  assert.equal(bridge.requests.length, 0);
});

test("unrelated parameter errors are passed through once without token refresh", async t => {
  const error = { error: { message: "Unsupported value for another parameter", code: "invalid_request_body" } };
  const bridge = await setup(t, { respond: () => ({ status: 400, body: error }) });
  const response = await bridge.post({ model: "gpt-5-mini", input: "OK" });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), error);
  assert.equal(bridge.requests.length, 1);
  assert.equal(bridge.counts().tokenRequests, 1);
});

const contextError = { error: {
  message: "Unsupported value: 'all_turns' is not supported with the 'gpt-future' model. Supported values are: 'auto' and 'current_turn'.",
  code: "invalid_request_body",
} };

test("a precise upstream context error is repaired once and remembered for subsequent turns", async t => {
  const bridge = await setup(t, {
    models: [model("gpt-future")],
    respond: request => request.body.reasoning.context === "all_turns"
      ? { status: 400, body: contextError } : undefined,
  });
  const body = { model: "gpt-future", input: "OK", reasoning: { effort: "high", context: "all_turns" } };
  const first = await bridge.post(body);
  assert.equal(first.status, 200);
  await first.json();
  assert.equal(bridge.requests.length, 2);
  assert.deepEqual(bridge.requests.map(request => request.body.reasoning.context), ["all_turns", "current_turn"]);
  const second = await bridge.post(body);
  assert.equal(second.status, 200);
  await second.json();
  assert.equal(bridge.requests.length, 3, "known compatibility must avoid another failing attempt");
  assert.equal(bridge.requests[2].body.reasoning.context, "current_turn");
});

test("context and token retries have separate bounds and never loop", async t => {
  const bridge = await setup(t, {
    models: [model("gpt-future")],
    respond: (request, attempt) => attempt === 1
      ? { status: 401, body: { error: "unauthorized" } }
      : { status: 400, body: contextError },
  });
  const response = await bridge.post({
    model: "gpt-future", input: "OK", reasoning: { context: "all_turns" },
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), contextError);
  assert.equal(bridge.requests.length, 3, "one token retry plus one context retry only");
});

test("real model-access rejection removes a model from the models endpoint", async t => {
  const bridge = await setup(t, { respond: () => ({ status: 404, body: { error: { code: "model_not_found", message: "Model removed" } } }) });
  const rejected = await bridge.post({ model: "gpt-5-mini", input: "OK" });
  assert.equal(rejected.status, 404); await rejected.json();
  const listing = await bridge.getModels();
  assert.deepEqual((await listing.json()).data, []);
});

test("runtime effort corrections update the same registry used by the picker", async t => {
  const bridge = await setup(t, { models: [model("gpt-future", { capabilities: { type: "chat", supports: {
    streaming: true, tool_calls: true, reasoning_effort: ["low", "high", "max"],
  } } })], respond: request => request.body.reasoning.effort === "max"
    ? { status: 400, body: { error: { param: "reasoning.effort", message: "Unsupported value: 'max' is not supported with the 'gpt-future' model. Supported values are: 'low' and 'high'." } } }
    : undefined });
  const response = await bridge.post({ model: "gpt-future", input: "OK", reasoning: { effort: "max" } });
  assert.equal(response.status, 200); await response.json();
  assert.deepEqual(bridge.codexCapabilities.models()[0].capabilities.supports.reasoning_effort, ["low", "high"]);
  assert.equal(bridge.requests[1].body.reasoning.effort, "high");
});

test("stream decryption errors teach an agent-message fallback for the next client retry", async t => {
  const failure = { type: "error", code: "invalid_request_body",
    message: "Encrypted function output content could not be decrypted or decoded." };
  const bridge = await setup(t, { respond: request => ({ status: 200, contentType: "text/event-stream",
    rawBody: request.body.input[0].content.some(part => part.type === "encrypted_content")
      ? `data: ${JSON.stringify({ type: "response.failed", response: { status: "failed" } })}\n\ndata: ${JSON.stringify(failure)}\n\n`
      : 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
  }) });
  const body = { model: "gpt-5-mini", stream: true, input: [{ type: "agent_message",
    author: "child", recipient: "parent", content: [{ type: "input_text", text: "Payload:\n" },
      { type: "encrypted_content", encrypted_content: "opaque" }] }] };
  assert.match(await (await bridge.post(body)).text(), /response.failed/);
  assert.match(await (await bridge.post(body)).text(), /response.completed/);
  assert.equal(bridge.requests.length, 2);
  assert.equal(bridge.requests[1].body.input[0].content[0].text, "Payload:\n");
  assert.match(bridge.requests[1].body.input[0].content[1].text, /unavailable/);
  assert.equal(bridge.requests[1].headers["Content-Length"], bridge.requests[1].bytes.length);
  assert.equal(bridge.counts().tokenRequests, 2, "decryption failure must not refresh authentication");
});

function fastModels(id = "gpt-5.6-sol") {
  const base = model(id, { capabilities: { type: "chat", supports: {
    streaming: true, tool_calls: true, reasoning_effort: ["low", "medium", "high", "max"],
  } } });
  return [base, { ...base, id: `${base.id}-fast`, name: `${id} Fast (Internal only)`,
    vendor: "Experimental", policy: { state: "enabled" } }];
}

test("speed routing leaves missing-model validation to the upstream without throwing", async t => {
  const error = { error: { type: "invalid_request_error", param: "model", message: "model is required" } };
  const bridge = await setup(t, { respond: () => ({ status: 400, body: error }) });
  for (const body of [{ input: "OK" }, { input: "OK", service_tier: "default" }]) {
    const response = await bridge.post(body);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), error);
    assert.deepEqual(bridge.requests.at(-1).body, { input: "OK" });
  }
});

test("native Fast routes to the exact verified sibling and preserves Ultra, tools and conversation", async t => {
  const bridge = await setup(t, { models: fastModels() });
  const body = { model: "gpt-5.6-sol", service_tier: "priority", stream: true,
    reasoning: { effort: "max", context: "all_turns" },
    input: [{ role: "developer", content: "Proactively delegate work to subagents." },
      { role: "user", content: "保持原始上下文" }], tools: [{ type: "function", name: "fixture" }],
    max_output_tokens: 1234 };
  for (const tier of ["priority", "fast"]) {
    const response = await bridge.post({ ...body, service_tier: tier });
    assert.equal(response.status, 200); await response.json();
    const sent = bridge.requests.at(-1);
    const expected = { ...body, model: "gpt-5.6-sol-fast" };
    delete expected.service_tier;
    assert.deepEqual(sent.body, expected);
    assert.equal(sent.headers["Content-Length"], sent.bytes.length);
  }
  assert.equal(bridge.requests.length, 2);
  assert.equal(body.service_tier, "priority");
  assert.equal(bridge.codexCapabilities.models().length, 2);
});

test("Fast selects the matching endpoint across OpenAI families without crossing models", async t => {
  const ids = ["gpt-6.2-astra", "gpt-6.2-sol", "gpt-6.1-terra", "gpt-6-luna", "gpt-5.6-sol", "o3"];
  const bridge = await setup(t, { models: ids.flatMap(id => fastModels(id)).reverse() });
  for (const id of ids) {
    const body = { model: id, service_tier: "priority", input: "same conversation", reasoning: { effort: "max" } };
    const response = await bridge.post(body);
    assert.equal(response.status, 200); await response.json();
    assert.deepEqual(bridge.requests.at(-1).body, {
      model: `${id}-fast`, input: body.input, reasoning: body.reasoning,
    });
    const direct = await bridge.post({ ...body, model: `${id}-fast` });
    assert.equal(direct.status, 200); await direct.json();
    assert.equal(bridge.requests.at(-1).body.model, `${id}-fast`);
  }
});

test("Standard omits service_tier without selecting Fast and explicit Fast never gains a second suffix", async t => {
  const bridge = await setup(t, { models: fastModels() });
  for (const selected of ["gpt-5.6-sol", "gpt-5.6-sol-fast"]) {
    for (const service_tier of [undefined, null, "auto", "default"]) {
      const response = await bridge.post({ model: selected, service_tier, input: "OK" });
      assert.equal(response.status, 200); await response.json();
      assert.deepEqual(bridge.requests.at(-1).body, { model: selected, input: "OK" });
    }
  }
  const response = await bridge.post({ model: "gpt-5.6-sol-fast", service_tier: "priority", input: "OK" });
  assert.equal(response.status, 200); await response.json();
  assert.deepEqual(bridge.requests.at(-1).body, { model: "gpt-5.6-sol-fast", input: "OK" });
});

test("unsupported or unavailable speed fails locally without tokens, upstream traffic or silent fallback", async t => {
  const bridge = await setup(t, { models: [...fastModels(), model("gpt-6-astra")] });
  for (const body of [
    { model: "gpt-6-astra", service_tier: "priority" },
    { model: "gpt-5.6-sol", service_tier: "ultrafast" },
    { model: "gpt-5.6-sol", service_tier: "flex" },
    { model: "gpt-5.6-sol", service_tier: {} },
  ]) {
    const response = await bridge.post({ ...body, input: "OK" });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.param, "service_tier");
  }
  bridge.codexCapabilities.setAccount("another-account");
  const response = await bridge.post({ model: "gpt-5.6-sol", service_tier: "priority", input: "OK" });
  assert.equal(response.status, 400); await response.json();
  assert.equal(bridge.requests.length, 0);
  assert.equal(bridge.counts().tokenRequests, 0);
  assert.ok(resolveCodexServiceTier({ model: "gpt-5.6-sol", service_tier: "priority" }, fastModels()).error,
    "raw discovery metadata must never authorize Fast without successful verification");
});

test("Fast validation retries belong to Fast and an access revocation leaves Standard available", async t => {
  let revoke = false;
  const bridge = await setup(t, { models: fastModels(), respond: request => {
    if (request.body.model !== "gpt-5.6-sol-fast") return;
    if (revoke) return { status: 403, body: { error: { code: "model_access_denied", message: "Fast unavailable" } } };
    if (request.body.reasoning?.context === "all_turns") return { status: 400, body: contextError };
  } });
  const body = { model: "gpt-5.6-sol", service_tier: "priority", input: "OK",
    reasoning: { effort: "max", context: "all_turns" } };
  const first = await bridge.post(body);
  assert.equal(first.status, 200); await first.json();
  assert.equal(bridge.requests.length, 2);
  assert.deepEqual(bridge.requests.map(r => r.body.model), ["gpt-5.6-sol-fast", "gpt-5.6-sol-fast"]);
  assert.deepEqual(bridge.codexCapabilities.constraints("gpt-5.6-sol"), {});
  assert.ok(bridge.codexCapabilities.constraints("gpt-5.6-sol-fast")["reasoning.context"]);
  revoke = true;
  const rejected = await bridge.post(body);
  assert.equal(rejected.status, 403); await rejected.json();
  assert.deepEqual(bridge.codexCapabilities.models().map(m => m.id), ["gpt-5.6-sol"]);
  const blocked = await bridge.post(body);
  assert.equal(blocked.status, 400); await blocked.json();
  assert.equal(bridge.requests.length, 3, "revoked Fast must not be retried or replaced with Standard");
  const standard = await bridge.post({ ...body, service_tier: "default" });
  assert.equal(standard.status, 200); await standard.json();
  assert.equal(bridge.requests.at(-1).body.model, "gpt-5.6-sol");
  assert.equal(bridge.requests.at(-1).body.reasoning.context, "all_turns");
});

test("Fast response aliases keep the native selected identity without masking unexpected reroutes", async t => {
  let upstreamModel = "gpt-5.6-sol-fast";
  const bridge = await setup(t, { models: fastModels(), respond: () => ({
    status: 200, contentType: "text/event-stream", headers: { "openai-model": upstreamModel },
    rawBody: `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed",
      model: upstreamModel, headers: { "OpenAI-Model": upstreamModel }, output: [] } })}\n\n`,
  }) });
  for (const [selected, serverModel, expected] of [
    ["gpt-5.6-sol", "gpt-5.6-sol-fast", "gpt-5.6-sol"],
    ["gpt-5.6-sol-fast", "gpt-5.6-sol", "gpt-5.6-sol-fast"],
    ["gpt-5.6-sol", "unexpected-upstream-model", "unexpected-upstream-model"],
  ]) {
    upstreamModel = serverModel;
    const response = await bridge.post({ model: selected, service_tier: "priority", input: "OK", stream: true });
    assert.equal(response.headers.get("openai-model"), expected);
    const event = JSON.parse((await response.text()).slice(6).trim());
    assert.equal(event.response.model, expected);
    assert.equal(event.response.headers["OpenAI-Model"], expected);
  }
});
