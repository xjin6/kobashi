const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createClaudeDesktopConfig } = require("../lib/claude-desktop-config");

const gateway = { baseUrl: "http://127.0.0.1:18923/claude-desktop", token: "local-test-token" };
const sonnet = { id: "claude-sonnet-5", name: "Copilot First" };
const opus = { id: "claude-opus-5", name: "Copilot Second", supports1m: true };
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
function write(file, json) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(json));
}
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kobashi-ccd-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const base = path.join(home, "Library", "Application Support");
  const normal = path.join(base, "Claude", "claude_desktop_config.json");
  const threep = path.join(base, "Claude-3p", "claude_desktop_config.json");
  const library = path.join(base, "Claude-3p", "configLibrary");
  const meta = path.join(library, "_meta.json");
  const config = () => createClaudeDesktopConfig({ home, platform: "darwin", env: {} });
  const active = () => path.join(library, read(meta).appliedId + ".json");
  return { home, normal, threep, library, meta, config, active };
}

test("install, refresh and restore a Desktop gateway while preserving other profiles and edits", t => {
  const f = fixture(t);
  write(f.normal, { deploymentMode: "1p", preferences: { theme: "light" } });
  write(f.threep, { preferences: { tools: true } });
  write(f.meta, { appliedId: "other", entries: [{ id: "other", name: "Work" }], extra: true });
  const other = path.join(f.library, "other.json");
  const previous = { inferenceGatewayBaseUrl: "https://example.invalid", inferenceGatewayApiKey: "unrelated" };
  write(other, previous);
  assert.equal(f.config().apply({ ...gateway, models: [sonnet, opus] }), true);
  const managed = f.active();
  const profile = read(managed);
  assert.deepEqual(profile, { inferenceGatewayBaseUrl: gateway.baseUrl, inferenceGatewayApiKey: gateway.token,
    inferenceGatewayAuthScheme: "bearer", inferenceProvider: "gateway", modelDiscoveryEnabled: true,
    inferenceModels: [{ name: sonnet.id, labelOverride: sonnet.name },
      { name: opus.id, labelOverride: opus.name, supports1m: true, prefer1m: true }] });
  assert.deepEqual(read(other), previous);
  assert.equal(read(f.normal).deploymentMode, "3p");
  assert.equal(read(f.threep).deploymentMode, "3p");
  assert.deepEqual(read(f.meta).entries[0], { id: "other", name: "Work" });

  write(f.normal, { ...read(f.normal), preferences: { theme: "dark" } });
  write(managed, { ...profile, userSetting: true });
  assert.equal(f.config().apply({ ...gateway, refreshOnly: true }), true);
  assert.deepEqual(read(managed).inferenceModels, profile.inferenceModels);
  assert.equal(f.config().apply({ ...gateway, refreshOnly: true, models: [opus] }), true);
  assert.deepEqual(read(managed).inferenceModels, [profile.inferenceModels[1]]);
  assert.equal(f.config().restore(), true);
  assert.deepEqual(read(managed), { userSetting: true });
  assert.deepEqual(read(f.normal), { deploymentMode: "1p", preferences: { theme: "dark" } });
  assert.deepEqual(read(f.threep), { preferences: { tools: true } });
  assert.deepEqual(read(f.meta), { appliedId: "other", entries: [{ id: "other", name: "Work" }], extra: true });
  assert.deepEqual(read(other), previous);
  assert.equal(f.config().restore(), false);
});

test("catalog refresh and cleanup respect a profile selected while Kobashi ran", t => {
  const f = fixture(t);
  write(f.normal, { deploymentMode: "1p" });
  const config = f.config();
  config.apply({ ...gateway, models: [sonnet] });
  const managed = f.active();
  const next = { appliedId: "work", entries: [...read(f.meta).entries, { id: "work", name: "Work" }] };
  write(f.meta, next);
  assert.equal(config.apply({ ...gateway, models: [opus], refreshOnly: true }), false);
  assert.equal(read(managed).inferenceModels[0].name, sonnet.id);
  config.restore();
  assert.equal(read(f.normal).deploymentMode, "3p");
  assert.equal(read(f.threep).deploymentMode, "3p");
  assert.deepEqual(read(f.meta), { appliedId: "work", entries: [{ id: "work", name: "Work" }] });
  assert.equal(fs.existsSync(managed), false);
  assert.equal(config.apply({ ...gateway, models: [opus], refreshOnly: true }), false);

  config.apply(gateway);
  const meta = read(f.meta);
  write(f.meta, { ...meta, appliedId: "new", entries: [...meta.entries, { id: "new", name: "New" }] });
  config.apply({ ...gateway, models: [opus] });
  config.restore();
  assert.equal(read(f.meta).appliedId, "new");
});

test("discovery-only startup, invalid catalogs, and empty-account refresh", t => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.normal), { recursive: true });
  assert.throws(() => f.config().apply({ ...gateway, models: [{ id: "gpt-5.4", name: "GPT" }] }), /route ID/);
  assert.equal(fs.existsSync(f.meta), false);
  const config = f.config();
  config.apply(gateway);
  const managed = f.active();
  assert.equal("inferenceModels" in read(managed), false);
  config.apply({ ...gateway, models: [sonnet], refreshOnly: true });
  config.apply({ ...gateway, models: [], refreshOnly: true });
  assert.equal("inferenceModels" in read(managed), false);
  config.restore();
  for (const file of [f.normal, f.threep, f.meta, managed]) assert.equal(fs.existsSync(file), false, file);
});

test("preflights malformed Desktop files and skips CLI-only machines", t => {
  const f = fixture(t);
  const cli = createClaudeDesktopConfig({ home: f.home, platform: "linux", env: {} });
  assert.equal(cli.apply({ ...gateway, models: [sonnet] }), false);
  write(f.normal, { deploymentMode: "1p" });
  write(f.meta, { entries: {} });
  assert.throws(() => f.config().apply(gateway), /entries array/);
  assert.deepEqual(read(f.normal), { deploymentMode: "1p" });
  assert.equal(fs.existsSync(f.threep), false);
  assert.equal(f.config().restore(), false);
});

test("existing preferences in the Kobashi profile and its library entry survive reactivation", t => {
  const f = fixture(t);
  write(f.normal, { deploymentMode: "1p" });
  const config = f.config();
  config.apply(gateway);
  const managed = f.active(), id = read(f.meta).appliedId;
  config.restore();
  const oldProfile = { inferenceModels: ["claude-haiku-4-5"], oldSetting: true };
  const entry = { id, name: "Custom name", icon: "user" };
  write(managed, oldProfile);
  write(f.meta, { entries: [entry] });
  config.apply({ ...gateway, models: [sonnet] });
  config.restore();
  assert.deepEqual(read(f.meta), { entries: [entry] });
  assert.deepEqual(read(managed), oldProfile);
});

test("failed activation rolls the other Desktop files back and can be retried", t => {
  const f = fixture(t);
  const original = { deploymentMode: "1p", preferences: { theme: "light" } };
  write(f.normal, original);
  const rename = fs.renameSync;
  const mock = t.mock.method(fs, "renameSync", (source, destination) => {
    if (destination === f.normal) throw new Error("Desktop file locked");
    return rename(source, destination);
  });
  const config = f.config();
  assert.throws(() => config.apply({ ...gateway, models: [sonnet] }), /file locked/);
  assert.deepEqual(read(f.normal), original);
  assert.equal(fs.existsSync(f.threep), false);
  assert.equal(fs.existsSync(f.meta), false);
  assert.equal(config.restore(), false);
  mock.mock.restore();
  assert.equal(config.apply({ ...gateway, models: [opus] }), true);
  assert.equal(read(f.active()).inferenceModels[0].name, opus.id);
  config.restore();
  assert.deepEqual(read(f.normal), original);
});

test("finds Windows desktop data folders used by alternate release channels", t => {
  const f = fixture(t);
  const localData = path.join(f.home, "AppData", "Local");
  const normal = path.join(localData, "ClaudeBeta", "claude_desktop_config.json");
  const threep = path.join(localData, "ClaudeBeta-3p", "claude_desktop_config.json");
  write(normal, { deploymentMode: "1p" });
  write(threep, {});
  const config = createClaudeDesktopConfig({ home: f.home, platform: "win32", env: { LOCALAPPDATA: localData } });
  assert.equal(config.apply({ ...gateway, models: [sonnet] }), true);
  assert.equal(read(normal).deploymentMode, "3p");
  assert.equal(read(threep).deploymentMode, "3p");
  assert.equal(fs.existsSync(path.join(localData, "Claude")), false);
  config.restore();
  assert.deepEqual(read(normal), { deploymentMode: "1p" });
  assert.deepEqual(read(threep), {});
});
