const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const configHelpers = require("../lib/codex-config");
const source = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");
const writeSource = source.slice(source.indexOf("async function writeCodexConfig()"),
  source.indexOf("// Remove only what writeCodexConfig() injected"));
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, cached = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kobashi-config-startup-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "config.toml");
  fs.writeFileSync(file, 'model = "gpt-user-choice"\n');
  let finish, checks = 0, watches = 0;
  const pending = new Promise(resolve => { finish = () => { cached = true; resolve(); }; });
  const context = vm.createContext({
    ...configHelpers, fs, path, githubToken: "test", codexEnabled: true,
    CODEX_DIR: dir, CODEX_AUTH: path.join(dir, "auth.json"), CODEX_CONFIG: file,
    CODEX_MODEL_CATALOG: path.join(dir, "catalog.json"), PROXY_PORT: 18921,
    process: { platform: "test" }, dbg() {}, log() {},
    writeTextAtomic: (file, text) => fs.writeFileSync(file, text),
    codexCapabilities: { setAccount() {}, idle: () => pending },
    publishCodexModelCatalog: () => ({ catalogPath: path.join(dir, "catalog.json"),
      catalog: { models: cached ? [{ slug: "gpt-verified" }] : [] } }),
    ensureCodexModelSession: async () => { checks++; },
    startCodexClientWatch: () => { watches++; },
  });
  vm.runInContext(writeSource, context);
  return { context, file, finish, read: () => fs.readFileSync(file, "utf8"),
    counts: () => ({ checks, watches }) };
}

test("first setup waits for a verified directory and retains edits made during preparation", async t => {
  const f = fixture(t);
  const writing = f.context.writeCodexConfig(); await tick();
  assert.ok(!f.read().includes("model_catalog_json"));
  fs.appendFileSync(f.file, 'notify = ["user-command"]\n');
  f.finish(); await writing;
  assert.ok(f.read().includes("model_catalog_json"));
  assert.ok(f.read().includes('notify = ["user-command"]'));
  assert.deepEqual(f.counts(), { checks: 1, watches: 1 });
});

test("verified startup cache is injected immediately without an extra inference round", async t => {
  const f = fixture(t, true);
  await f.context.writeCodexConfig();
  assert.ok(f.read().includes("model_catalog_json"));
  assert.deepEqual(f.counts(), { checks: 0, watches: 1 });
});

test("account changes during first preparation cannot inject stale configuration", async t => {
  const f = fixture(t);
  const before = f.read();
  const writing = f.context.writeCodexConfig(); await tick();
  f.context.githubToken = "different-account";
  f.finish(); await writing;
  assert.equal(f.read(), before);
  assert.equal(f.counts().watches, 0);
});
