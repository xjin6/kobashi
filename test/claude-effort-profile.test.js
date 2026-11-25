const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { createClaudeDesktopConfig } = require("../lib/claude-desktop-config");
const { buildClaudeRoutes, listClaudeModels, resolveClaudeRoute } = require("../lib/claude-routes");
const { translateRequest } = require("../lib/claude-input");

const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function record(id, vendor, endpoint, efforts) {
  return {
    id, name: id, vendor, model_picker_enabled: true, supported_endpoints: [endpoint],
    capabilities: { type: "chat", supports: { tool_calls: true, streaming: true, reasoning_effort: efforts } },
  };
}

test("published IDs avoid embedded CLI version detection and old chats still resolve the exact model", () => {
  const rawId = "gpt-6.2-astra";
  const oldId = "claude-sonnet-4-6-kb-936210-173228";
  const newId = "claude-sonnet-kb-936210-173228";
  const source = record(rawId, "OpenAI", "/responses", ["low", "medium", "high", "xhigh", "max"]);
  source.capabilities.limits = { max_context_window_tokens: 1_000_000 };
  const other = record("other", "Other", "/chat/completions", []);
  const routes = buildClaudeRoutes([other, source]);
  const current = routes.find(r => r.model.id === rawId);
  assert.equal(current.id, newId);
  assert.equal(listClaudeModels([current], true).first_id, newId);
  assert.equal(listClaudeModels([current], false).first_id, oldId);
  for (const id of [oldId, oldId + "[1m]", newId, newId + "[1m]", rawId]) {
    assert.equal(resolveClaudeRoute(routes, id), current);
    assert.equal(resolveClaudeRoute(buildClaudeRoutes([other]), id), null);
  }
});

test("Copilot effort capability changes refresh the existing CCD picker row through the production publisher", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kobashi-effort-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const normal = path.join(home, ".config", "Claude", "claude_desktop_config.json");
  const threep = path.join(home, ".config", "Claude-3p", "claude_desktop_config.json");
  const library = path.join(path.dirname(threep), "configLibrary");
  const meta = path.join(library, "_meta.json");
  const priorProfile = path.join(library, "work.json");
  const cli = path.join(home, ".claude", "settings.json");
  const original = { deploymentMode: "1p", preferences: { theme: "dark" } };
  const previousLibrary = { appliedId: "work", entries: [{ id: "work", name: "Work" }] };
  write(normal, original);
  write(threep, { preferences: { theme: "system" } });
  write(meta, previousLibrary);
  write(priorProfile, { inferenceModels: [{ name: "claude-sonnet-5", maxEffort: "medium" }] });
  write(cli, { effortLevel: "low" });
  const savedProfile = fs.readFileSync(priorProfile, "utf8");
  const savedCli = fs.readFileSync(cli, "utf8");
  const config = createClaudeDesktopConfig({ home, platform: "linux", env: {} });

  // Exercise index.js's real projection and snapshot comparison. Loading the
  // whole executable would start listeners and use the currently signed-in account.
  const source = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");
  const publish = vm.runInNewContext(source.slice(source.indexOf("function publishClaudeDesktop("),
    source.indexOf("const CLAUDE_DIR =")) + "\npublishClaudeDesktop", {
    claudeDesktop: config, claudeGatewayKey: "fixture", CLAUDE_PORT: 18923,
    claudeDesktopPublished: false, claudeDesktopCatalog: null,
    log(...message) { assert.fail(message.join(" ")); },
  });

  const rawId = "test-copilot-chat";
  const catalog = efforts => buildClaudeRoutes([
    record(rawId, "Example", "/responses", efforts),
    record("future-chat", "Example", "/chat/completions", ["capability-new-to-kobashi"]),
    record("claude-sonnet-4.6", "Anthropic", "/v1/messages", ["low", "medium", "high"]),
  ]);
  const first = catalog(["low", "medium", "high"]);
  publish(first);
  const managed = path.join(library, read(meta).appliedId + ".json");
  const entry = label => read(managed).inferenceModels.find(item => item.labelOverride === label);
  const pickerId = entry(rawId).name;
  assert.deepEqual(entry(rawId), { name: pickerId, labelOverride: rawId, behavesAs: "claude-sonnet-5", maxEffort: "high" });
  for (const label of ["future-chat", "claude-sonnet-4.6"]) {
    assert.equal(Object.hasOwn(entry(label), "behavesAs"), false);
    assert.equal(Object.hasOwn(entry(label), "maxEffort"), false);
  }

  const savedByDesktop = read(managed);
  delete savedByDesktop.inferenceGatewayAuthScheme;
  write(managed, savedByDesktop);
  const upgraded = catalog(["low", "medium", "high", "xhigh", "max"]);
  publish(upgraded);
  assert.deepEqual(entry(rawId), { name: pickerId, labelOverride: rawId, behavesAs: "claude-sonnet-5", maxEffort: "max" });
  assert.equal(Object.hasOwn(read(managed), "inferenceGatewayAuthScheme"), false);
  const route = resolveClaudeRoute(upgraded, pickerId);
  const request = translateRequest(route.format, { model: pickerId, messages: [{ role: "user", content: "hi" }],
    thinking: { type: "adaptive" }, output_config: { effort: "max" } }, route.model);
  assert.equal(request.model, rawId);
  assert.equal(request.reasoning.effort, "max");

  publish(catalog([]));
  assert.deepEqual(entry(rawId), { name: pickerId, labelOverride: rawId });
  assert.deepEqual(read(normal), { ...original, deploymentMode: "3p" });
  assert.deepEqual(read(threep), { preferences: { theme: "system" }, deploymentMode: "3p" });
  assert.equal(fs.readFileSync(cli, "utf8"), savedCli);
  assert.equal(fs.readFileSync(priorProfile, "utf8"), savedProfile);
  assert.equal(config.restore(), true);
  assert.deepEqual(read(normal), original);
  assert.deepEqual(read(threep), { preferences: { theme: "system" } });
  assert.deepEqual(read(meta), previousLibrary);
  assert.equal(fs.existsSync(managed), false);
  assert.equal(fs.readFileSync(priorProfile, "utf8"), savedProfile);
  assert.equal(fs.readFileSync(cli, "utf8"), savedCli);
});
