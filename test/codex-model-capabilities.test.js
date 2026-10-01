const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { CodexModelCapabilities } = require("../lib/codex-model-capabilities");
const { buildKobashiModelCatalog } = require("../lib/codex-model-catalog");

function model(id = "gpt-unreleased") {
  return { id, vendor: "OpenAI", model_picker_enabled: true, policy: { state: "enabled" },
    supported_endpoints: ["/responses"], capabilities: { type: "chat", supports: {
      streaming: true, tool_calls: true, reasoning_effort: ["low", "high", "xhigh", "max"],
    } } };
}
function registry(options = {}) {
  const registry = new CodexModelCapabilities({ probe: async () => ({ state: "verified", constraints: {} }), ...options });
  registry.setAccount("test-account");
  return registry;
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test("new models are hidden until verified and concurrent refreshes share the same probe", async () => {
  let finish, calls = 0;
  const r = registry({ probe: async () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  r.update([model()], { models: [] });
  r.update([model()], { models: [] });
  assert.deepEqual(r.models(), []);
  await tick();
  assert.equal(calls, 1);
  finish({ state: "verified", constraints: { "reasoning.context": ["auto", "current_turn"] } });
  await r.idle();
  assert.equal(r.models()[0].id, "gpt-unreleased");
  assert.deepEqual(r.constraints("gpt-unreleased"), { "reasoning.context": ["auto", "current_turn"] });
  r.update([model()], { models: [] });
  await r.idle();
  assert.equal(calls, 1);
});

test("model rollout and native Ultra rollout independently invalidate validation", async () => {
  let calls = 0;
  const r = registry({ probe: async () => { calls++; return { state: "verified", constraints: {} }; } });
  const m = model();
  r.update([m], { models: [] }); await r.idle();
  const native = { slug: m.id, display_name: m.id, supported_reasoning_levels: [{ effort: "max" }, { effort: "ultra" }],
    multi_agent_reasoning_effort: "xhigh", default_reasoning_level: "low", shell_type: "unified_exec",
    visibility: "list", supported_in_api: true, priority: 1, support_verbosity: true,
    truncation_policy: { mode: "tokens", limit: 10000 }, experimental_supported_tools: [], base_instructions: "Test" };
  const bundled = { models: [native] };
  r.update([m], bundled);
  assert.equal(r.models().length, 1, "keep the earlier verified model during a capability rollout");
  assert.ok(!buildKobashiModelCatalog(bundled, r.models()).models[0].supported_reasoning_levels.some(level => level.effort === "ultra"),
    "new Ultra metadata must wait for the new probe");
  await r.idle();
  assert.ok(buildKobashiModelCatalog(bundled, r.models()).models[0].supported_reasoning_levels.some(level => level.effort === "ultra"));
  m.version = "new-upstream-version";
  r.update([m], bundled); await r.idle();
  assert.equal(calls, 3);
});

test("learned effort restrictions update both picker efforts and Ultra eligibility", async () => {
  const r = registry();
  r.update([model()], { models: [] }); await r.idle();
  r.learn("gpt-unreleased", r.token("gpt-unreleased"), { "reasoning.effort": ["low", "high"] });
  assert.deepEqual(r.models()[0].capabilities.supports.reasoning_effort, ["low", "high"]);
  assert.deepEqual(buildKobashiModelCatalog({}, r.models()).models[0].supported_reasoning_levels.map(x => x.effort), ["low", "high"]);
});

test("restart revalidation removes old learned limitations even when metadata is unchanged", async () => {
  let now = 10_000, calls = 0;
  const r = registry({ now: () => now, probe: async () => ({ state: "verified",
    constraints: calls++ ? {} : { "reasoning.context": ["current_turn"] } }) });
  r.update([model()], {}); await r.idle();
  assert.ok(r.constraints("gpt-unreleased")["reasoning.context"]);
  now += 1000 * 60 * 60 * 24 * 365;
  r.update([model()], {}); r.pump(); await r.idle();
  assert.equal(calls, 1, "time alone must not trigger another paid probe");
  assert.equal(r.models().length, 1, "a running session must not lose its picker due to a timer");
  r.update([model()], {}, { revalidate: true }); await r.idle();
  assert.equal(calls, 2);
  assert.deepEqual(r.constraints("gpt-unreleased"), {});
});

test("a failed startup check never creates a background retry loop", async () => {
  let now = 1000, state = "transient", calls = 0;
  const r = registry({ now: () => now, probe: async () => { calls++; return { state, constraints: {} }; } });
  r.update([model()], {}); await r.idle();
  assert.equal(r.models().length, 0);
  now += 1_000_000;
  r.update([model()], {}); r.pump(); await r.idle();
  assert.equal(calls, 1);
  state = "verified";
  r.update([model()], {}, { revalidate: true }); await r.idle();
  assert.equal(calls, 2);
  assert.equal(r.models().length, 1);
});

test("model removal and access failures update the picker; restart explicitly checks recovery", async () => {
  let now = 1000, calls = 0;
  const r = registry({ now: () => now, probe: async () => { calls++; return { state: "verified", constraints: {} }; } });
  r.update([model()], {}); await r.idle();
  r.observeFailure("gpt-unreleased", r.token("gpt-unreleased"), 404, { error: { code: "model_not_found" } });
  assert.equal(r.models().length, 0);
  now += 1_000_000; r.update([model()], {}); await r.idle();
  assert.equal(calls, 1);
  assert.equal(r.models().length, 0);
  r.update([model()], {}, { revalidate: true }); await r.idle();
  assert.equal(r.models().length, 1);
  r.update([], {});
  assert.equal(r.models().length, 0);
});

test("cache is durable, account-scoped, and invalidated when model metadata changes", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kobashi-capabilities-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cachePath = path.join(dir, "cache.json");
  let calls = 0;
  const options = { cachePath, probe: async () => { calls++; return { state: "verified", constraints: {} }; } };
  const first = registry(options); first.update([model()], {}); await first.idle();
  const second = registry(options);
  assert.equal(second.models().length, 1, "hydrate the picker before any network call or discovery");
  assert.equal(calls, 1);
  second.update([model()], {}); await second.idle();
  assert.equal(calls, 1);
  assert.equal(second.models().length, 1);
  second.setAccount("another-account"); second.update([model()], {});
  assert.equal(second.models().length, 0); await second.idle();
  assert.equal(calls, 2);
  assert.ok(!fs.readFileSync(cachePath, "utf8").includes("another-account"));
  if (process.platform !== "win32") assert.equal(fs.statSync(cachePath).mode & 0o777, 0o600);
});

test("late probes and responses from an old account cannot validate or mutate the new account", async () => {
  const resolvers = [];
  const r = registry({ probe: () => new Promise(resolve => resolvers.push(resolve)), concurrency: 2 });
  r.update([model()], {}); await tick();
  const oldToken = r.token("gpt-unreleased");
  r.setAccount("new-account"); r.update([model()], {}); await tick();
  resolvers[0]({ state: "verified", constraints: { "reasoning.context": ["current_turn"] } });
  await tick();
  assert.equal(r.models().length, 0);
  r.learn("gpt-unreleased", oldToken, { "reasoning.effort": ["low"] });
  assert.deepEqual(r.constraints("gpt-unreleased"), {});
  resolvers[1]({ state: "verified", constraints: {} }); await r.idle();
  assert.equal(r.models().length, 1);
});

test("in-flight probes cannot overwrite newer real-request failures or constraints", async () => {
  let finish;
  const r = registry({ probe: () => new Promise(resolve => { finish = resolve; }) });
  r.update([model()], {}); await tick();
  r.observeFailure("gpt-unreleased", r.token("gpt-unreleased"), 403, { error: { code: "model_access_denied" } });
  finish({ state: "verified", constraints: {} }); await r.idle();
  assert.equal(r.models().length, 0);
});

test("probe concurrency is bounded and disabling bridge prevents queued checks", async () => {
  let finishes = [];
  const r = registry({ probe: () => new Promise(resolve => finishes.push(resolve)), concurrency: 2 });
  r.update([model("gpt-a"), model("gpt-b"), model("gpt-c")], {}); await tick();
  assert.equal(finishes.length, 2);
  r.pause(); finishes.forEach(resolve => resolve({ state: "verified", constraints: {} })); await r.idle();
  assert.equal(finishes.length, 2);
  assert.equal(r.models().length, 0);
});

test("restarting invalidates old probes and performs exactly one new round", async () => {
  const finish = [];
  const r = registry({ probe: () => new Promise(resolve => finish.push(resolve)), concurrency: 2 });
  r.update([model()], {}, { revalidate: true }); await tick();
  r.update([model()], {}, { revalidate: true }); await tick();
  assert.equal(finish.length, 2);
  finish[0]({ state: "verified", constraints: { "reasoning.context": ["current_turn"] } }); await tick();
  assert.equal(r.models().length, 0);
  finish[1]({ state: "verified", constraints: {} }); await r.idle();
  assert.equal(r.models().length, 1);
  assert.deepEqual(r.constraints("gpt-unreleased"), {});
  r.pump(); await r.idle();
  assert.equal(finish.length, 2);
});

test("real-request compatibility learned during a probe is retained without another paid probe", async () => {
  let finish, calls = 0;
  const r = registry({ probe: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  r.update([model()], {}); await tick();
  r.learn("gpt-unreleased", r.token("gpt-unreleased"), { "reasoning.context": ["current_turn"] });
  finish({ state: "verified", constraints: {} }); await r.idle();
  assert.equal(r.models().length, 1);
  assert.deepEqual(r.constraints("gpt-unreleased"), { "reasoning.context": ["current_turn"] });
  assert.equal(calls, 1);
});


test("restart and transient failures preserve prior success, but explicit rejection removes it", async () => {
  let state = "verified", calls = 0;
  const r = registry({ probe: async () => { calls++; return { state, reason: "network_or_timeout", constraints: {} }; } });
  r.update([model()], {}); await r.idle();
  state = "transient";
  r.update([model()], {}, { revalidate: true });
  assert.equal(r.models().length, 1, "no empty startup window");
  await r.idle();
  assert.equal(r.models().length, 1, "a timeout cannot revoke a successful check");
  r.pump(); await r.idle(); assert.equal(calls, 2, "no timed retry");
  state = "unavailable";
  r.update([model()], {}, { revalidate: true }); await r.idle();
  assert.equal(r.models().length, 0);
});

test("cached native effort snapshot survives bridge restart without native discovery", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kobashi-picker-cache-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { cachePath: path.join(dir, "cache.json") };
  const first = registry(options);
  const native = { slug: "gpt-unreleased", supported_reasoning_levels: [{ effort: "ultra" }],
    multi_agent_reasoning_effort: "xhigh" };
  first.update([model()], { models: [native] }); await first.idle();
  const before = first.models();
  const second = registry(options);
  assert.deepEqual(second.models(), before);
  second.setAccount("another-account");
  assert.deepEqual(second.models(), []);
});
