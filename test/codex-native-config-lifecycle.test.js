const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const config = require("../lib/codex-config");
const { migrateNativeAuth } = require("../lib/codex-native-auth");

const source = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");
const lifecycleSource = source.slice(source.indexOf("async function writeCodexConfig()"),
  source.indexOf("// ─── Claude config"));
const preferenceSource = source.slice(source.indexOf("function readCodexNativeAuthPreference()"),
  source.indexOf("// Legacy location: kobashi's own state"));
const openHandlerSource = source.slice(source.indexOf("const codexOpenHandler ="),
  source.indexOf("const ui = http.createServer"));

function fixture(preference, platform = "darwin") {
  const home = "/fixture/codex";
  const preferencePath = "/fixture/kobashi/codex-native-auth.json";
  const authPath = home + "/auth.json";
  const configPath = home + "/config.toml";
  const originalAuth = JSON.stringify({ tokens: { access_token: "FAKE-ACCOUNT-TOKEN" } });
  const files = new Map([
    [authPath, originalAuth],
    [authPath + ".bak", "FAKE-OLD-AUTH-BACKUP"],
    [configPath, 'cli_auth_credentials_store = "keyring"\nmodel_provider = "openai"\n'],
  ]);
  if (preference !== undefined) files.set(preferencePath, preference);
  const touches = [];
  const commands = [];
  const context = vm.createContext({
    ...config, migrateNativeAuth, CODEX_DIR: home, CODEX_AUTH: authPath, CODEX_CONFIG: configPath,
    CODEX_MODEL_CATALOG: "/fixture/catalog.json", CODEX_NATIVE_AUTH_PREFERENCE: preferencePath,
    PROXY_PORT: 18921, githubToken: "FAKE-GITHUB-TOKEN", codexEnabled: true,
    codexConfigured: false, codexConfigGeneration: 0,
    codexDesktopLauncher: {}, UI_PORT: 18922,
    createCodexOpenHandler: options => options,
    process: { platform },
    fs: {
      mkdirSync(p) { touches.push(["mkdir", p]); },
      existsSync(p) { touches.push(["exists", p]); return files.has(p); },
      readFileSync(p) {
        touches.push(["read", p]);
        if (!files.has(p)) throw Object.assign(new Error("missing fixture file"), { code: "ENOENT" });
        return files.get(p);
      },
      unlinkSync(p) { touches.push(["unlink", p]); files.delete(p); },
    },
    writeTextAtomic(p, text) { touches.push(["write", p]); files.set(p, text); },
    execSync(command) { commands.push(command); },
    codexCapabilities: { setAccount() {}, async idle() {} },
    publishCodexModelCatalog: () => ({ catalogPath: "/fixture/catalog.json", catalog: { models: [{}] } }),
    async ensureCodexModelSession() {}, startCodexClientWatch() {}, stopCodexClientWatch() {},
    log() {}, dbg() {},
  });
  vm.runInContext(`${preferenceSource}\n${lifecycleSource}`, context);
  vm.runInContext(openHandlerSource, context);
  return { context, files, touches, commands, configPath, authPath, originalAuth, preferencePath,
    launchReady: () => vm.runInContext("codexOpenHandler.ready()", context) };
}

test("native exit restores the previous provider and re-enable preserves the login mode", async () => {
  const f = fixture('{"enabled":true}');
  const originalConfig = f.files.get(f.configPath);
  await f.context.writeCodexConfig();
  assert.match(f.files.get(f.configPath), /^requires_openai_auth = true$/m);
  assert.equal(f.files.get(f.configPath + ".bak"), originalConfig);
  // A normal process restart/reinjection must not replace the true baseline.
  await f.context.writeCodexConfig();
  assert.equal(f.files.get(f.configPath + ".bak"), originalConfig);
  assert.deepEqual(f.commands.filter(command => /OPENAI_(API_KEY|BASE_URL)/.test(command)), []);
  f.commands.length = 0;
  f.context.restoreCodexConfig();
  assert.match(f.files.get(f.configPath), /^model_provider = "openai"$/m);
  assert.match(f.files.get(f.configPath), /^cli_auth_credentials_store = "keyring"$/m);
  assert.doesNotMatch(f.files.get(f.configPath), /model_providers\.kobashi|requires_openai_auth|model_catalog_json/);
  assert.equal(f.files.has(f.configPath + ".bak"), false);
  assert.deepEqual(f.commands, []);
  await f.context.writeCodexConfig();
  assert.match(f.files.get(f.configPath), /^model_provider = "kobashi"$/m);
  assert.match(f.files.get(f.configPath), /^requires_openai_auth = true$/m);
  assert.doesNotMatch(f.files.get(f.configPath), /^env_key\s*=/m);
  assert.equal(f.files.get(f.authPath), f.originalAuth);
  assert.equal(f.files.get(f.authPath + ".bak"), "FAKE-OLD-AUTH-BACKUP");
  assert.equal(f.files.get(f.preferencePath), '{"enabled":true}');
  assert.deepEqual(f.touches.filter(([op, p]) => ["write", "unlink"].includes(op) && p.startsWith(f.authPath)), []);
  assert.deepEqual(f.commands.filter(command => /OPENAI_(API_KEY|BASE_URL)/.test(command)), []);
});

test("native exit restores a custom provider while preserving later user settings", async () => {
  const f = fixture('{"enabled":true}');
  f.files.set(f.configPath, `# User baseline
model_provider = "organization"
model_catalog_json = "/fixture/user-catalog.json"
cli_auth_credentials_store = "keyring"

[model_providers.organization]
name = "User gateway"
base_url = "https://gateway.example.invalid/v1"

[desktop]
show-context-window-usage = false
`);
  await f.context.writeCodexConfig();
  f.files.set(f.configPath, f.files.get(f.configPath)
    .replace("show-context-window-usage = false", "show-context-window-usage = true")
    + '\n[custom_user_section]\nkeep = "later edit"\n');
  f.context.restoreCodexConfig();
  const restored = f.files.get(f.configPath);
  assert.match(restored, /^model_provider = "organization"$/m);
  assert.match(restored, /^model_catalog_json = "\/fixture\/user-catalog.json"$/m);
  assert.match(restored, /^base_url = "https:\/\/gateway.example.invalid\/v1"$/m);
  assert.match(restored, /^show-context-window-usage = true$/m);
  assert.match(restored, /^keep = "later edit"$/m);
  assert.doesNotMatch(restored, /model_providers\.kobashi|requires_openai_auth/);
  assert.deepEqual(f.touches.filter(([op, p]) => ["write", "unlink"].includes(op) && p.startsWith(f.authPath)), []);
});

test("native exit preserves a provider selected by the user while Kobashi was running", async () => {
  const f = fixture('{"enabled":true}');
  await f.context.writeCodexConfig();
  f.files.set(f.configPath, f.files.get(f.configPath)
    .replace('model_provider = "kobashi"', 'model_provider = "later-choice"'));
  f.context.restoreCodexConfig();
  assert.match(f.files.get(f.configPath), /^model_provider = "later-choice"$/m);
  assert.doesNotMatch(f.files.get(f.configPath), /model_providers\.kobashi/);
  assert.deepEqual(f.touches.filter(([op, p]) => ["write", "unlink"].includes(op) && p.startsWith(f.authPath)), []);
});

test("native exit without an original config removes injected settings and preserves login", async () => {
  const f = fixture('{"enabled":true}');
  f.files.delete(f.configPath);
  await f.context.writeCodexConfig();
  f.context.restoreCodexConfig();
  assert.equal((f.files.get(f.configPath) || "").trim(), "");
  assert.equal(f.files.get(f.authPath), f.originalAuth);
  assert.deepEqual(f.touches.filter(([op, p]) => ["write", "unlink"].includes(op) && p.startsWith(f.authPath)), []);
});

test("explicit opt-out keeps existing placeholder behavior and auth restoration", async () => {
  const f = fixture('{"enabled":false}');
  await f.context.writeCodexConfig();
  assert.match(f.files.get(f.configPath), /^env_key = "OPENAI_API_KEY"$/m);
  assert.equal(JSON.parse(f.files.get(f.authPath)).OPENAI_API_KEY, "PROXY_MANAGED");
  assert.ok(f.commands.some(command => command === "launchctl setenv OPENAI_API_KEY PROXY_MANAGED"));
  f.context.restoreCodexConfig();
  assert.equal(f.files.get(f.authPath), f.originalAuth);
});

test("invalid native auth preference aborts before changing configuration or credentials", async () => {
  const f = fixture('{"enabled":"true"}');
  const before = new Map(f.files);
  await assert.rejects(f.context.writeCodexConfig());
  assert.deepEqual(f.files, before);
  assert.deepEqual(f.touches, [["read", f.preferencePath]]);
  assert.deepEqual(f.commands, []);
});

const legacyAuth = '{"OPENAI_API_KEY":"PROXY_MANAGED"}';
const nativeBackup = JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: {
  access_token: "FAKE-ACCESS", id_token: "FAKE-ID", refresh_token: "FAKE-REFRESH", account_id: "FAKE-ACCOUNT",
} });

for (const platform of ["darwin", "win32"]) {
  test(`fresh ${platform} install defaults to native account without a preference file`, async () => {
    const f = fixture(undefined, platform);
    await f.context.writeCodexConfig();
    assert.equal(f.context.readCodexNativeAuthPreference(), true);
    assert.equal(f.files.has(f.preferencePath), false);
    assert.match(f.files.get(f.configPath), /^requires_openai_auth = true$/m);
    assert.doesNotMatch(f.files.get(f.configPath), /env_key|experimental_bearer_token/);
    assert.equal(f.files.get(f.authPath), f.originalAuth);
    assert.equal(f.files.get(f.authPath + ".bak"), "FAKE-OLD-AUTH-BACKUP");
    assert.deepEqual(f.commands.filter(command => /OPENAI_(API_KEY|BASE_URL)/.test(command)), []);
    f.context.restoreCodexConfig();
    assert.match(f.files.get(f.configPath), /^model_provider = "openai"$/m);
    assert.equal(f.files.get(f.authPath), f.originalAuth);
  });

  test(`legacy ${platform} upgrade restores native backup and keeps it across restart and exit`, async () => {
    const f = fixture(undefined, platform);
    const baseline = f.files.get(f.configPath);
    f.files.set(f.configPath + ".bak", baseline);
    f.files.set(f.configPath, config.injectCodexConfig(baseline, 18921, { platform, chatgptAuth: false }));
    f.files.set(f.authPath, legacyAuth);
    f.files.set(f.authPath + ".bak", nativeBackup);
    await f.context.writeCodexConfig();
    assert.match(f.files.get(f.configPath), /^requires_openai_auth = true$/m);
    assert.doesNotMatch(f.files.get(f.configPath), /env_key|experimental_bearer_token/);
    assert.equal(f.files.get(f.authPath), nativeBackup);
    assert.equal(f.files.get(f.authPath + ".bak"), nativeBackup);
    await f.context.writeCodexConfig();
    assert.equal(f.touches.filter(([op, p]) => op === "write" && p === f.authPath).length, 1);
    f.context.restoreCodexConfig();
    assert.match(f.files.get(f.configPath), /^model_provider = "openai"$/m);
    assert.equal(f.files.get(f.authPath), nativeBackup);
    assert.equal(f.files.get(f.authPath + ".bak"), nativeBackup);
    assert.deepEqual(f.commands.filter(command => /OPENAI_(API_KEY|BASE_URL)/.test(command)), []);
  });
}

test("default upgrade without a native backup removes the placeholder for official sign-in", async () => {
  const f = fixture();
  f.files.set(f.authPath, legacyAuth);
  await f.context.writeCodexConfig();
  assert.equal(f.files.has(f.authPath), false);
  assert.equal(f.files.get(f.authPath + ".bak"), "FAKE-OLD-AUTH-BACKUP");
  assert.match(f.files.get(f.configPath), /^requires_openai_auth = true$/m);
  f.files.set(f.authPath, nativeBackup); // User signs in through the official app.
  f.context.restoreCodexConfig();
  assert.equal(f.files.get(f.authPath), nativeBackup);
});

test("default startup leaves a missing login missing even when an older backup exists", async () => {
  const f = fixture();
  f.files.delete(f.authPath);
  f.files.set(f.authPath + ".bak", nativeBackup);
  await f.context.writeCodexConfig();
  f.context.restoreCodexConfig();
  assert.equal(f.files.has(f.authPath), false);
  assert.equal(f.files.get(f.authPath + ".bak"), nativeBackup);
});

test("account changes during preparation cannot migrate legacy authentication", async () => {
  const f = fixture();
  f.files.set(f.authPath, legacyAuth);
  f.files.set(f.authPath + ".bak", nativeBackup);
  let finish;
  f.context.publishCodexModelCatalog = () => ({ catalogPath: "/fixture/catalog.json", catalog: { models: [] } });
  f.context.ensureCodexModelSession = () => new Promise(resolve => { finish = resolve; });
  const pending = f.context.writeCodexConfig();
  await new Promise(setImmediate);
  f.context.githubToken = "ANOTHER-FAKE-ACCOUNT";
  finish(); await pending;
  assert.equal(f.files.get(f.authPath), legacyAuth);
  assert.equal(f.files.get(f.authPath + ".bak"), nativeBackup);
});

test("icon waits for native setup; disabling during discovery cannot re-enable launch or migrate auth", async () => {
  const f = fixture();
  f.files.set(f.authPath, legacyAuth);
  f.files.set(f.authPath + ".bak", nativeBackup);
  assert.equal(f.launchReady(), false);
  let finish;
  f.context.publishCodexModelCatalog = () => ({ catalogPath: "/fixture/catalog.json", catalog: { models: [] } });
  f.context.ensureCodexModelSession = () => new Promise(resolve => { finish = resolve; });
  const pending = f.context.writeCodexConfig();
  await new Promise(setImmediate);
  assert.equal(f.launchReady(), false);
  f.context.restoreCodexConfig();
  finish(); await pending;
  assert.equal(f.launchReady(), false);
  assert.equal(f.files.get(f.authPath), legacyAuth);
  f.context.publishCodexModelCatalog = () => ({ catalogPath: "/fixture/catalog.json", catalog: { models: [{}] } });
  await f.context.writeCodexConfig();
  assert.equal(f.launchReady(), true);
  assert.equal(f.files.get(f.authPath), nativeBackup);
  f.context.restoreCodexConfig();
  assert.equal(f.launchReady(), false);
});

test("failed configuration cannot launch a desktop using a stale readiness flag", async () => {
  const f = fixture();
  await f.context.writeCodexConfig();
  assert.equal(f.launchReady(), true);
  f.context.writeTextAtomic = () => { throw Object.assign(Error("fixture write denied"), { code: "EACCES" }); };
  await assert.rejects(f.context.writeCodexConfig(), { code: "EACCES" });
  assert.equal(f.launchReady(), false);
});
