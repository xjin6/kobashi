const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { desktopProviders, prepareDesktopProfile } = require("../lib/grok-desktop");

const catalog = { data: [
  { id: "grok-4.7", display_name: "Grok 4.7", owned_by: "xai", supported_endpoints: ["/responses"],
    context_window: 500000, reasoning_efforts: ["low", "medium", "high", "xhigh"], supports_vision: true },
  { id: "grok-4.6", display_name: "Grok 4.6", owned_by: "xai", supported_endpoints: ["/v1/responses"],
    reasoning_efforts: ["low", "high"], supports_vision: false },
  { id: "grok-code", owned_by: "xai", supported_endpoints: ["/v1/chat/completions"] },
] };

test("Grok App providers use only models and protocols available on the gateway", () => {
  const groups = desktopProviders({ data: [
    ...catalog.data, catalog.data[1],
    { id: "gpt-5", owned_by: "openai", supported_endpoints: ["/responses"] },
    { id: "grok-image", owned_by: "xai", supported_endpoints: ["/images/generations"] },
  ] });
  assert.deepEqual(groups.map(p => [p.backend, p.models.map(row => row.id)]), [
    ["responses", ["grok-4.7", "grok-4.6"]], ["chat_completions", ["grok-code"]],
  ]);
  assert.equal(groups[0].models[0].contextWindow, 500000);
  assert.throws(() => desktopProviders({ data: [] }), /no supported Grok models/);
  assert.throws(() => desktopProviders({}), /Invalid model list/);
  const mixed = desktopProviders({ data: [
    { ...catalog.data[0], id: "grok-fixed", reasoning_efforts: [] }, ...catalog.data,
  ] });
  assert.equal(mixed[0].id, "kobashi-responses-fixed");
  assert.equal(mixed[1].id, "kobashi-responses");
});

test("isolated Grok App profile selects the generic provider and binds picker choices to exact wire model ids", t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "kobashi-grok-profile-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const directory = path.join(scratch, "grok app");
  const providers = desktopProviders(catalog);
  const url = "http://127.0.0.1:18924/v1";
  const profile = prepareDesktopProfile(directory, providers, url, "fixture-only-key");
  const configPath = path.join(profile.agentHome, "config.toml");
  const config = fs.readFileSync(configPath, "utf8");
  const tables = new Map();
  let table;
  for (const line of config.split("\n").filter(Boolean)) {
    if (line.startsWith("[")) {
      table = {};
      assert.ok(!tables.has(line));
      tables.set(line, table);
    } else {
      const eq = line.indexOf(" = ");
      table[line.slice(0, eq)] = JSON.parse(line.slice(eq + 3));
    }
  }
  const routes = tables.get("[models]");
  assert.equal(routes.default, "kobashi-responses");
  for (const slot of ["image_description", "web_search", "session_summary", "prompt_suggestion"]) {
    assert.equal(routes[slot], routes.default);
  }
  for (const id of routes.allowed_models) {
    const fields = tables.get("[model." + id + "]");
    assert.equal(fields.base_url, url);
    assert.equal(fields.api_key, "fixture-only-key");
    assert.equal(fields.app_provider_mode, "generic");
    assert.equal(fields.api_backend, fields.model === "grok-code" ? "chat_completions" : "responses");
  }
  const parent = tables.get("[model.kobashi-responses]");
  assert.deepEqual(JSON.parse(parent.app_models), providers[0].models);
  assert.equal(parent.context_window, 500000);
  assert.equal(parent.supports_reasoning_effort, true);
  assert.deepEqual(JSON.parse(parent.app_efforts).map(level => level.id), ["low", "medium", "high", "xhigh"]);
  const appModels = JSON.parse(parent.app_models);
  assert.deepEqual(appModels[1].efforts.map(level => level.id), ["low", "high"]);
  assert.equal(appModels[0].supportsVision, true);
  assert.equal(appModels[1].supportsVision, false);
  assert.equal(parent.app_supports_vision, "true");
  const alternate = tables.get("[model.kobashi-responses__2]");
  assert.equal(alternate.model, "grok-4.6");
  assert.equal(alternate.app_parent_provider, "kobashi-responses");
  assert.equal(alternate.supports_reasoning_effort, true);
  assert.equal(tables.get("[model.kobashi-chat]").supports_reasoning_effort, false);
  const settings = JSON.parse(fs.readFileSync(path.join(directory, "settings.json"), "utf8"));
  assert.equal(settings.modelId, "grok-4.7");
  assert.equal(settings.officialAuxInject, false);
  assert.equal(settings.sessionDataMode, "independent");
  assert.equal(settings.permissionPolicy, "ask");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(directory).mode & 0o077, 0);
    assert.equal(fs.statSync(configPath).mode & 0o077, 0);
  }
  assert.throws(() => prepareDesktopProfile(directory, providers, url, "other-key"), { code: "EEXIST" });
  assert.equal(fs.readFileSync(configPath, "utf8"), config);
});
