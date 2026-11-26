const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { ensureGrokLaunchProfile } = require("../lib/grok-launch-profile");
const { prepareDesktopProfile, desktopProviders } = require("../lib/grok-desktop");
const { scanToml, assignmentStringValue } = require("../lib/codex-config");

const oldUrl = "http://127.0.0.1:18924/v1", url = "http://127.0.0.1:18922/grok/v1";
const row = id => ({ id, display_name: id.toUpperCase(), owned_by: "xai", context_window: 500000,
  supported_endpoints: ["/responses"], reasoning_efforts: ["low", "high"], supports_vision: true });
const old = { data: [row("grok-4.6"), row("grok-4.7")] };

function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "kobashi-profile-test-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const directory = path.join(parent, "grok-desktop");
  const config = path.join(directory, "agent-home", "config.toml");
  return { parent, directory, config, settings: path.join(directory, "settings.json") };
}

function sectionValue(config, table, field) {
  const assignment = scanToml(config).assignments.find(a => a.table?.path === table && a.key === field);
  return assignment && assignmentStringValue(config, assignment);
}

test("opens the prior unmarked Grok trial with its selected model, private notes and unrelated native settings intact", t => {
  const f = fixture(t);
  prepareDesktopProfile(f.directory, desktopProviders(old), oldUrl, "previous-key");
  const memo = path.join(f.directory, "journal.txt");
  fs.writeFileSync(memo, "existing chat journal\n");
  const settings = JSON.parse(fs.readFileSync(f.settings));
  settings.theme = "dark"; settings.modelId = "grok-4.6"; settings.userOptions = { zoom: 1.25 };
  fs.writeFileSync(f.settings, JSON.stringify(settings));
  const savedSettings = fs.readFileSync(f.settings, "utf8");
  const foreign = '\n[plugins.personal]\nmodel = "my-model"\nbase_url = "http://localhost:9"\n' +
    'prompt = """\n[model.kobashi-responses]\napi_key = "literal inside prompt"\n"""\n';
  const keep = '# handwritten capability override\naudio = "custom"\n';
  let before = fs.readFileSync(f.config, "utf8").replace('[model.kobashi-responses]\n', '[model.kobashi-responses]\n' + keep);
  before = before.replace(/^allowed_models = (.+)$/m, (_, v) =>
    'allowed_models = [\n# managed IDs only\n' + JSON.parse(v).map(id => "'" + id + "',").join("\n") + '\n]');
  fs.writeFileSync(f.config, before + foreign);
  const fresh = { data: [row("grok-new"), row("grok-4.7"), { ...row("grok-4.6"),
    context_window: 600000, supports_vision: false, reasoning_efforts: ["low", "medium", "high"] }] };
  const profile = ensureGrokLaunchProfile(f.directory, fresh, url, "new-key");
  assert.equal(profile.agentHome, path.dirname(f.config));
  const after = fs.readFileSync(f.config, "utf8");
  assert.ok(after.includes(foreign));
  assert.ok(after.includes(keep));
  assert.doesNotMatch(after, /previous-key|18924/);
  for (const [section, model] of [["kobashi-responses", "grok-4.6"], ["kobashi-responses__1", "grok-4.6"],
    ["kobashi-responses__2", "grok-4.7"]]) {
    assert.equal(sectionValue(after, "model." + section, "model"), model);
    assert.equal(sectionValue(after, "model." + section, "api_key"), "new-key");
    assert.equal(sectionValue(after, "model." + section, "base_url"), url);
  }
  const rows = JSON.parse(sectionValue(after, "model.kobashi-responses", "app_models"));
  assert.deepEqual(rows.map(m => m.id), ["grok-4.6", "grok-4.7", "grok-new"]);
  assert.deepEqual(rows[0].efforts.map(e => e.id), ["low", "medium", "high"]);
  assert.equal(rows[0].contextWindow, 600000);
  assert.equal(rows[0].supportsVision, false);
  assert.equal(fs.readFileSync(memo, "utf8"), "existing chat journal\n");
  assert.equal(fs.readFileSync(f.settings, "utf8"), savedSettings);
  const inode = fs.statSync(f.config).ino;
  ensureGrokLaunchProfile(f.directory, fresh, url, "new-key");
  assert.equal(fs.readFileSync(f.config, "utf8"), after);
  assert.equal(fs.statSync(f.config).ino, inode, "an unchanged second launch need not write the file");
});

test("retiring a model drops its menu entry without reassigning its old child ID, and repairs a stale selection", t => {
  const f = fixture(t);
  ensureGrokLaunchProfile(f.directory, old, url, "key");
  const settings = JSON.parse(fs.readFileSync(f.settings));
  settings.extra = "retain";
  fs.writeFileSync(f.settings, JSON.stringify(settings));
  ensureGrokLaunchProfile(f.directory, { data: [row("grok-next"), row("grok-4.7")] }, url, "key");
  const config = fs.readFileSync(f.config, "utf8");
  assert.doesNotMatch(config, /grok-4\.6|kobashi-responses__1(?=["\]])/);
  assert.equal(sectionValue(config, "model.kobashi-responses__2", "model"), "grok-4.7");
  assert.deepEqual(JSON.parse(fs.readFileSync(f.settings)), { ...settings, modelId: "grok-4.7" });
});

test("moving a selected model into a different native provider group preserves the saved chat and side-task targets", t => {
  const f = fixture(t);
  ensureGrokLaunchProfile(f.directory, old, url, "key");
  ensureGrokLaunchProfile(f.directory, { data: [row("grok-4.7"), { ...row("grok-4.6"), reasoning_efforts: [] }] }, url, "key");
  const config = fs.readFileSync(f.config, "utf8");
  assert.equal(sectionValue(config, "model.kobashi-responses__1", "model"), "grok-4.6");
  assert.equal(sectionValue(config, "model.kobashi-responses__1", "app_parent_provider"), "kobashi-responses-fixed");
  for (const slot of ["default", "session_summary", "web_search", "image_description", "prompt_suggestion"]) {
    const section = sectionValue(config, "models", slot);
    assert.equal(section, "kobashi-responses-fixed");
    assert.equal(sectionValue(config, "model." + section, "model"), "grok-4.6");
  }
});

test("an unrelated existing directory, a foreign active provider, symlinked files and an empty catalog never get overwritten", t => {
  const f = fixture(t);
  assert.throws(() => ensureGrokLaunchProfile(f.directory, { data: [] }, url, "key"), { code: "no_grok_models" });
  assert.equal(fs.existsSync(f.directory), false);
  fs.mkdirSync(f.directory);
  assert.throws(() => ensureGrokLaunchProfile(f.directory, old, url, "key"), { code: "profile_conflict" });
  assert.deepEqual(fs.readdirSync(f.directory), []);
  fs.rmdirSync(f.directory);
  prepareDesktopProfile(f.directory, desktopProviders(old), oldUrl, "old");
  const foreign = fs.readFileSync(f.config, "utf8").replace('default = "kobashi-responses"', 'default = "external"');
  fs.writeFileSync(f.config, foreign);
  assert.throws(() => ensureGrokLaunchProfile(f.directory, old, url, "new"), { code: "profile_conflict" });
  assert.equal(fs.readFileSync(f.config, "utf8"), foreign);
  if (process.platform !== "win32") {
    const target = path.join(f.parent, "user-config");
    fs.renameSync(f.config, target); fs.symlinkSync(target, f.config);
    assert.throws(() => ensureGrokLaunchProfile(f.directory, old, url, "key"), { code: "profile_conflict" });
    assert.equal(fs.readFileSync(target, "utf8"), foreign);
  }
});

test("an external menu choice, auto-added relay, or native official-tool fallback preserves the profile and prevents launching it", t => {
  const f = fixture(t);
  prepareDesktopProfile(f.directory, desktopProviders(old), oldUrl, "old-key");
  const original = fs.readFileSync(f.config, "utf8");
  for (const value of ["*", "gpt-*", "personal", "grok-4.7"]) {
    const changed = original.replace('allowed_models = [', 'allowed_models = [' + JSON.stringify(value) + ',');
    fs.writeFileSync(f.config, changed);
    assert.throws(() => ensureGrokLaunchProfile(f.directory, old, url, "new"), { code: "profile_conflict" });
    assert.equal(fs.readFileSync(f.config, "utf8"), changed);
  }
  const unselected = original + '\n[model."my other relay"]\nbase_url = "http://localhost:9"\n';
  fs.writeFileSync(f.config, unselected);
  assert.throws(() => ensureGrokLaunchProfile(f.directory, old, url, "new"), { code: "profile_conflict" });
  assert.equal(fs.readFileSync(f.config, "utf8"), unselected);
  fs.writeFileSync(f.config, original);
  const settings = JSON.parse(fs.readFileSync(f.settings));
  for (const flag of [true, undefined]) {
    const text = JSON.stringify({ ...settings, officialAuxInject: flag });
    fs.writeFileSync(f.settings, text);
    assert.throws(() => ensureGrokLaunchProfile(f.directory, old, url, "new"), { code: "profile_conflict" });
    assert.equal(fs.readFileSync(f.settings, "utf8"), text);
    assert.equal(fs.readFileSync(f.config, "utf8"), original);
  }
});

test("concurrent first launches publish only a complete private Grok profile", async t => {
  const f = fixture(t);
  const script = 'require(process.argv[1]).ensureGrokLaunchProfile(process.argv[2],JSON.parse(process.argv[3]),process.argv[4],"key")';
  const args = ["-e", script, require.resolve("../lib/grok-launch-profile"), f.directory, JSON.stringify(old), url];
  const runs = Array.from({ length: 4 }, () => once(spawn(process.execPath, args, { stdio: "inherit" }), "exit"));
  for (const [code] of await Promise.all(runs)) assert.equal(code, 0);
  assert.deepEqual(fs.readdirSync(f.parent), ["grok-desktop"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.settings)).modelId, "grok-4.6");
  const config = fs.readFileSync(f.config, "utf8");
  assert.equal(sectionValue(config, "model.kobashi-responses__2", "model"), "grok-4.7");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(f.config).mode & 0o777, 0o600);
    assert.equal(fs.statSync(f.directory).mode & 0o777, 0o700);
  }
});
