const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { CodexModelCapabilities } = require("../lib/codex-model-capabilities");
const { buildKobashiModelCatalog, writeModelCatalogAtomic } = require("../lib/codex-model-catalog");

// Opt-in native integration: no real account, inference, or live client config.
// KOBASHI_TEST_CODEX must point to the installed native CLI being checked.
const executable = process.env.KOBASHI_TEST_CODEX;
async function startNativePicker(dir, children) {
  const child = spawn(executable, ["app-server", "--stdio"], {
    cwd: dir, env: { ...process.env, CODEX_HOME: dir }, stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  children.push(child);
  child.stderr.resume();
  let buffer = "", id = 0;
  const requests = new Map();
  child.stdout.on("data", chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      const pending = requests.get(message.id);
      if (pending) { requests.delete(message.id); message.error ? pending.reject(new Error(JSON.stringify(message.error))) : pending.resolve(message.result); }
    }
  });
  child.on("error", error => { for (const pending of requests.values()) pending.reject(error); });
  child.on("exit", () => { for (const pending of requests.values()) pending.reject(new Error("diagnostic server exited")); });
  const call = (method, params) => new Promise((resolve, reject) => {
    requests.set(++id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  await call("initialize", { clientInfo: { name: "kobashi-picker-test", version: "1" }, capabilities: {} });
  child.stdin.write('{"method":"initialized"}\n');
  return async () => (await call("model/list", {})).data;
}

function temporaryPicker(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kobashi-native-picker-"));
  const children = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exit = new Promise(resolve => child.once("exit", resolve));
        child.kill(); await exit;
      }
    }
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("kobashi-native-picker-"));
    // Windows may retain native file handles briefly after process exit.
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const catalogPath = path.join(dir, "catalog.json");
  const configPath = path.join(dir, "config.toml");
  fs.writeFileSync(configPath, `model_provider = "test"\nmodel_catalog_json = ${JSON.stringify(catalogPath)}\n[model_providers.test]\nname = "test"\nbase_url = "http://127.0.0.1:1/v1"\nwire_api = "responses"\n`);
  return { dir, children, catalogPath, configPath };
}

test("native picker starts populated and reads newly verified models on its next launch", {
  skip: !executable, timeout: 20000,
}, async t => {
  const { dir, children, catalogPath, configPath } = temporaryPicker(t);
  const model = id => ({ id, vendor: "OpenAI", supported_endpoints: ["/responses"],
    capabilities: { type: "chat", supports: { streaming: true, tool_calls: true, reasoning_effort: ["low"] } } });
  const options = { cachePath: path.join(dir, "capabilities.json"),
    probe: async () => ({ state: "verified", constraints: {} }) };
  const first = new CodexModelCapabilities(options);
  first.setAccount("test-only"); first.update([model("gpt-picker-a")], {}); await first.idle();
  // A brand-new bridge instance must publish from cache before any requests.
  const restored = new CodexModelCapabilities(options);
  restored.setAccount("test-only");
  const publish = () => writeModelCatalogAtomic(catalogPath, buildKobashiModelCatalog({}, restored.models()));
  publish();
  const modelIds = async list => (await list()).map(model => model.id).sort();
  const firstList = await startNativePicker(dir, children);
  const list = () => modelIds(firstList);
  assert.deepEqual(await list(), ["gpt-picker-a"]);
  restored.update([model("gpt-picker-a"), model("gpt-picker-b")], {}, { revalidate: true });
  publish();
  assert.equal(JSON.parse(fs.readFileSync(catalogPath)).models.length, 1, "never publish a temporary empty directory");
  await restored.idle(); publish();
  fs.writeFileSync(configPath, fs.readFileSync(configPath, "utf8") + "\n# changed\n");
  assert.deepEqual(await list(), ["gpt-picker-a"], "running native picker retains its startup snapshot");
  const nextList = await startNativePicker(dir, children);
  assert.deepEqual(await modelIds(nextList), ["gpt-picker-a", "gpt-picker-b"]);
});

test("native Fast controls follow verified model availability across families and disappear after removal", {
  skip: !executable, timeout: 20000,
}, async t => {
  const { dir, children, catalogPath } = temporaryPicker(t);
  const ids = ["gpt-6.2-astra", "gpt-6.2-sol", "gpt-6.1-terra", "gpt-6-luna", "gpt-5.6-sol"];
  const bases = ids.map(id => ({ id, vendor: "OpenAI", supported_endpoints: ["/responses"],
    capabilities: { type: "chat", supports: { streaming: true, tool_calls: true, reasoning_effort: ["low"] } } }));
  const variants = bases.slice(0, 3).map(base => ({ ...base, id: `${base.id}-fast`,
    vendor: "Experimental", name: `${base.id} Fast (Internal only)` }));
  const registry = new CodexModelCapabilities({ probe: async model => ({
    state: model.id === variants[2].id ? "unavailable" : "verified", constraints: {},
  }) });
  registry.setAccount("test-only");
  registry.update([...variants, ...bases].reverse(), {}); await registry.idle();
  const publish = () => writeModelCatalogAtomic(catalogPath, buildKobashiModelCatalog({}, registry.models()));
  publish();
  const list = await startNativePicker(dir, children);
  for (const model of await list()) {
    const fast = ids.slice(0, 2).includes(model.id);
    assert.deepEqual(model.additionalSpeedTiers, fast ? ["fast"] : [], model.id);
    assert.deepEqual(model.serviceTiers.map(tier => tier.id), fast ? ["priority"] : [], model.id);
    assert.equal(model.defaultServiceTier, null);
  }
  registry.update(bases, {}); await registry.idle(); publish();
  const next = await startNativePicker(dir, children);
  const updated = await next();
  assert.equal(updated.length, bases.length);
  assert.ok(updated.every(model => !model.additionalSpeedTiers.length && !model.serviceTiers.length));
});
