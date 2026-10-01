const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { EMPTY_CATALOG_MODEL_ID, buildKobashiModelCatalog, writeModelCatalogAtomic } = require("../lib/codex-model-catalog");
const { CodexModelCapabilities } = require("../lib/codex-model-capabilities");

// Exercise the actual refresh path without starting the app, binding its ports,
// loading credentials, or touching the user's Codex configuration.
const source = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");
const refreshSource = source.slice(
  source.indexOf("function readCodexModelCatalog()"),
  source.indexOf("function stopCodexClientWatch()"),
);

function fixture(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kobashi-refresh-test-"));
  const catalogPath = path.join(dir, "catalog.json");
  const configPath = path.join(dir, "config.toml");
  fs.writeFileSync(configPath, "model_provider = \"kobashi\"\n");
  let efforts = ["low", "medium", "high", "xhigh", "max"];
  let live = [{
    id: "gpt-6.1-sol", vendor: "OpenAI", model_picker_enabled: true,
    supported_endpoints: ["/responses"],
    capabilities: { type: "chat", supports: {
      streaming: true, tool_calls: true,
      reasoning_effort: ["low", "medium", "high", "xhigh", "max"],
    } },
  }];
  let fetchError = null;
  const nudges = [];
  let discoveries = 0, probes = 0;
  let context;
  const codexCapabilities = new CodexModelCapabilities({
    probe: async () => { probes++; return { state: "verified", constraints: {} }; },
    onChange: () => { if (context) context.publishCodexModelCatalog(); },
  });
  context = vm.createContext({
    githubToken: "test-account", codexEnabled: true, codexCapabilities,
    codexModelSessionStarted: false, codexModelSessionAwaitingClient: false,
    codexModelSessionRequest: null, codexModelSessionGeneration: 0,
    codexBundledCatalog: { models: [] }, buildKobashiModelCatalog, writeModelCatalogAtomic,
    fs, EMPTY_CATALOG_MODEL_ID, CODEX_MODEL_CATALOG: catalogPath, CODEX_CONFIG: configPath,
    log() {}, dbg() {},
    getCopilotModelsRaw: async () => {
      discoveries++;
      if (fetchError) throw fetchError;
      return live;
    },
    isKobashiManagedConfig: () => true,
    writeTextAtomic: (file, text) => { nudges.push(text); fs.writeFileSync(file, text); },
    loadBundledCodexModelCatalog: () => ({ models: [{
        slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol",
        supported_reasoning_levels: efforts.map(effort => ({ effort, description: effort })),
        default_reasoning_level: "low", multi_agent_reasoning_effort: "xhigh",
        shell_type: "unified_exec", visibility: "list", supported_in_api: true,
        priority: 1, support_verbosity: true, truncation_policy: { mode: "tokens", limit: 10000 },
        experimental_supported_tools: [], base_instructions: "test instructions",
      }] }),
  });
  vm.runInContext(refreshSource, context);
  return Promise.resolve().then(() => run({
    refresh: async () => {
      const before = context.readCodexModelCatalog();
      await context.refreshCodexModelCatalog();
      await codexCapabilities.idle();
      const result = context.publishCodexModelCatalog();
      return { ...result, changed: JSON.stringify(before) !== JSON.stringify(result.catalog) };
    },
    read: () => JSON.parse(JSON.stringify(context.readCodexModelCatalog())),
    ensureSession: () => context.ensureCodexModelSession(),
    restartSession: () => context.beginCodexModelSession(),
    finish: () => codexCapabilities.idle(),
    counts: () => ({ discoveries, probes }),
    context,
    setEfforts: value => { efforts = value; },
    setLive: value => { live = value; },
    failFetch: () => { fetchError = new Error("offline"); },
    nudges,
  })).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

test("Codex updates refresh Ultra even when Copilot capabilities have not changed", async () => {
  await fixture(async ({ refresh, read, setEfforts, nudges }) => {
    assert.equal((await refresh()).changed, true);
    assert.ok(!read().models[0].supported_reasoning_levels.some(level => level.effort === "ultra"));
    setEfforts(["low", "medium", "high", "xhigh", "max", "ultra"]);
    assert.equal((await refresh()).changed, true);
    assert.ok(read().models[0].supported_reasoning_levels.some(level => level.effort === "ultra"));
    const afterUpgrade = nudges.length;
    assert.equal(afterUpgrade, 0, "native model/list does not reload on config rewrites");
    assert.equal((await refresh()).changed, false);
    assert.equal(nudges.length, afterUpgrade, "unchanged metadata should not nudge Codex again");
  });
});

test("a successful empty account catalog clears previously offered models", async () => {
  await fixture(async ({ refresh, read, setLive }) => {
    await refresh();
    setLive([]);
    assert.equal((await refresh()).changed, true);
    assert.deepEqual(read().models, []);
  });
});

test("a transient fetch error preserves the last known catalog", async () => {
  await fixture(async ({ refresh, read, failFetch }) => {
    await refresh();
    const before = read();
    failFetch();
    assert.equal((await refresh()).changed, false);
    assert.deepEqual(read(), before);
  });
});

test("offline first launch does not invent available models", async () => {
  await fixture(async ({ refresh, read, failFetch }) => {
    failFetch();
    await refresh();
    assert.deepEqual(read().models, []);
  });
});

test("repeated list reads and turns share a startup check; restart explicitly bypasses verification cache", async () => {
  await fixture(async ({ ensureSession, restartSession, finish, counts }) => {
    await Promise.all([ensureSession(), ensureSession(), ensureSession()]);
    await finish();
    assert.deepEqual(counts(), { discoveries: 1, probes: 1 });
    await ensureSession(); await finish();
    assert.deepEqual(counts(), { discoveries: 1, probes: 1 });
    await restartSession(); await finish();
    assert.deepEqual(counts(), { discoveries: 2, probes: 2 });
  });
});

test("the first-request fallback and the initial process snapshot are one refresh", async () => {
  const { CodexClientLifecycle } = require("../lib/codex-client-lifecycle");
  await fixture(async ({ context, ensureSession, finish, counts }) => {
    context.CodexClientLifecycle = class extends CodexClientLifecycle {
      constructor(options) { super({ ...options, readClients: async () => [{ key: "10:start" }] }); }
    };
    vm.runInContext(source.slice(source.indexOf("const codexClientWatcher ="), source.indexOf("function writeTextAtomic(")), context);
    const watcher = vm.runInContext("codexClientWatcher", context);
    await ensureSession(); await finish();
    await watcher.poll(); await ensureSession(); await finish();
    assert.deepEqual(counts(), { discoveries: 1, probes: 1 });
    watcher.readClients = async () => [{ key: "11:restart" }];
    await watcher.poll(); await ensureSession(); await finish();
    assert.deepEqual(counts(), { discoveries: 2, probes: 2 });
  });
});

test("a closed client cannot publish a late discovery result", async () => {
  await fixture(async ({ context, ensureSession, finish, counts }) => {
    let respond;
    context.getCopilotModelsRaw = () => new Promise(resolve => { respond = resolve; });
    const pending = ensureSession();
    context.codexModelSessionGeneration++;
    context.codexCapabilities.pause();
    respond([{ id: "should-not-be-used" }]);
    await pending; await finish();
    assert.equal(counts().probes, 0);
    assert.equal(context.codexCapabilities.models().length, 0);
  });
});

test("a first request racing the watcher after an idle snapshot starts only one validation round", async () => {
  const { CodexClientLifecycle } = require("../lib/codex-client-lifecycle");
  await fixture(async ({ context, ensureSession, finish, counts }) => {
    let clients = [];
    context.CodexClientLifecycle = class extends CodexClientLifecycle {
      constructor(options) { super({ ...options, readClients: async () => clients }); }
    };
    vm.runInContext(source.slice(source.indexOf("const codexClientWatcher ="), source.indexOf("function writeTextAtomic(")), context);
    const watcher = vm.runInContext("codexClientWatcher", context);
    await watcher.poll();
    assert.deepEqual(counts(), { discoveries: 0, probes: 0 });
    await ensureSession(); await finish();
    clients = [{ key: "10:start" }];
    await watcher.poll(); await ensureSession(); await finish();
    assert.deepEqual(counts(), { discoveries: 1, probes: 1 });
    clients = [{ key: "11:restart" }];
    await watcher.poll(); await ensureSession(); await finish();
    assert.deepEqual(counts(), { discoveries: 2, probes: 2 });
  });
});


test("publishing on bridge initialization preserves only this account's legacy verified entries", async () => {
  await fixture(async ({ refresh, read, context }) => {
    await refresh();
    const registry = context.codexCapabilities;
    // Simulate v2.1.5's verdict-only disk cache, before network discovery.
    registry.latest.clear(); registry.hasSnapshot = false;
    context.publishCodexModelCatalog();
    assert.equal(read().models.length, 1);
    registry.setAccount("different-account");
    context.publishCodexModelCatalog();
    assert.deepEqual(read().models, []);
  });
});

test("a Codex restart never publishes an empty intermediate directory", async () => {
  await fixture(async ({ ensureSession, restartSession, finish, read, context }) => {
    await ensureSession(); await finish();
    const published = [];
    const write = context.writeModelCatalogAtomic;
    context.writeModelCatalogAtomic = (file, catalog) => { published.push(catalog.models.length); write(file, catalog); };
    await restartSession(); await finish();
    assert.equal(read().models.length, 1);
    assert.ok(published.length > 0);
    assert.ok(published.every(count => count === 1));
  });
});
