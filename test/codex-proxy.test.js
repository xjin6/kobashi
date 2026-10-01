const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { Readable, Writable } = require("node:stream");
const vm = require("node:vm");
const test = require("node:test");
const { selectCopilotOpenAIModels } = require("../lib/codex-model-catalog");
const { normalizeCodexRequest, retryCodexRequest } = require("../lib/codex-request-compat");
const { createResponsesSseNormalizer } = require("../lib/responses-sse-normalizer");

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
    createResponsesSseNormalizer,
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
          const upstream = Readable.from([Buffer.from(JSON.stringify(response.body))]);
          upstream.statusCode = response.status;
          upstream.headers = { "content-type": "application/json" };
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
    post: body => fetch(`${base}/v1/responses`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }),
  };
}

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
