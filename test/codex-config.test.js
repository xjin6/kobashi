const assert = require("assert/strict");
const test = require("node:test");
const {
  injectCodexConfig,
  restoreCodexConfigContents,
  isKobashiManagedConfig,
  isKobashiManagedAuth,
} = require("../lib/codex-config");

test("injects the Kobashi catalog without unsafe global context overrides", () => {
  const result = injectCodexConfig("[desktop]\nshow-context-window-usage = true\n", 18921, {
    modelCatalogPath: "C:\\Users\\me\\.kobashi\\codex-models.json",
  });

  assert.match(result, /^model_provider = "kobashi"$/m);
  assert.match(result, /^model_catalog_json = "C:\\\\Users\\\\me\\\\\.kobashi\\\\codex-models\.json" # Kobashi default$/m);
  assert.doesNotMatch(result, /^model_context_window\s*=/m);
  assert.doesNotMatch(result, /^model_auto_compact_token_limit\s*=/m);
});

test("1M defaults never replace user-supplied context settings", () => {
  const source = `model_context_window = 320000
model_auto_compact_token_limit = 280000
`;
  const result = injectCodexConfig(source, 18921, { modelCatalogPath: "/tmp/kobashi-models.json" });

  assert.match(result, /^model_context_window = 320000$/m);
  assert.match(result, /^model_auto_compact_token_limit = 280000$/m);
  assert.doesNotMatch(result, /1000000 # Kobashi default/);
  assert.doesNotMatch(result, /900000 # Kobashi default/);
});

test("an existing user catalog is preserved through inject and restore", () => {
  const backup = `model_catalog_json = "D:\\\\mine.json"

[desktop]
show-context-window-usage = true
`;
  const options = {
    modelCatalogPath: "C:\\Users\\me\\.kobashi\\codex-models.json",
  };
  const live = injectCodexConfig(backup, 18921, options);
  const result = restoreCodexConfigContents(live, backup, options);

  assert.match(result, /^model_catalog_json = "D:\\\\mine\.json"$/m);
  assert.doesNotMatch(result, /model_context_window/);
  assert.doesNotMatch(result, /model_auto_compact_token_limit/);
  assert.doesNotMatch(result, /model_providers\.kobashi/);
});

test("restore removes a Kobashi catalog default when the user had none", () => {
  const options = { modelCatalogPath: "C:\\Users\\me\\.kobashi\\codex-models.json" };
  const live = injectCodexConfig("", 18921, options);
  const result = restoreCodexConfigContents(live, "", options);

  assert.doesNotMatch(result, /model_catalog_json/);
});

test("restore preserves a context setting the user added while Kobashi was running", () => {
  const live = `model_context_window = 600000 # user changed this\n${injectCodexConfig("", 18921)}`;
  const result = restoreCodexConfigContents(live);

  assert.match(result, /^model_context_window = 600000 # user changed this$/m);
  assert.doesNotMatch(result, /model_auto_compact_token_limit/);
});

test("reinjection migrates only exact legacy Kobashi 1M defaults", () => {
  const source = `model_provider = "kobashi"
model_context_window = 1000000 # Kobashi default
model_auto_compact_token_limit = 900000 # Kobashi default

[model_providers.kobashi]
name = "Kobashi"
base_url = "http://127.0.0.1:18921/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
`;
  const result = injectCodexConfig(source, 18921, { modelCatalogPath: "/tmp/models.json" });

  assert.doesNotMatch(result, /^model_context_window\s*=/m);
  assert.doesNotMatch(result, /^model_auto_compact_token_limit\s*=/m);
  assert.match(result, /^model_catalog_json = "\/tmp\/models\.json" # Kobashi default$/m);
});

test("an unmarked global context override is always preserved", () => {
  const source = `model_provider = "kobashi"
model_catalog_json = "/tmp/models.json" # Kobashi default
model_context_window = 1000000

[model_providers.kobashi]
name = "Kobashi"
base_url = "http://127.0.0.1:18921/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
`;
  const result = injectCodexConfig(source, 18921, { modelCatalogPath: "/tmp/models.json" });

  assert.match(result, /^model_context_window = 1000000$/m);
});

test("recognizes only a complete Kobashi-managed provider config", () => {
  const managed = injectCodexConfig("", 18921);
  assert.equal(isKobashiManagedConfig(managed, 18921), true);
  assert.equal(isKobashiManagedConfig(managed), true);
  assert.equal(isKobashiManagedConfig('model_provider = "kobashi"\n', 18921), false);
  assert.equal(isKobashiManagedConfig(managed, 4141), false);

  const legacy = `model_provider = "copilot-bridge"

[model_providers.copilot-bridge]
base_url = "http://127.0.0.1:4141/v1"
`;
  assert.equal(isKobashiManagedConfig(legacy), true);
  assert.equal(isKobashiManagedConfig(legacy, 18921), false);
});

test("recognizes only Kobashi-managed Codex auth contents", () => {
  assert.equal(isKobashiManagedAuth('{"OPENAI_API_KEY":"PROXY_MANAGED"}'), true);
  assert.equal(isKobashiManagedAuth({ OPENAI_API_KEY: "PROXY_MANAGED" }), true);
  assert.equal(isKobashiManagedAuth('{"OPENAI_API_KEY":"real-user-value"}'), false);
  assert.equal(isKobashiManagedAuth("not json"), false);
});

test("restore ignores a stale backup that already contains Kobashi", () => {
  const staleBackup = injectCodexConfig("", 18921);
  const live = `${staleBackup}\n[desktop]\nshow-context-window-usage = true\n`;
  const result = restoreCodexConfigContents(live, staleBackup);

  assert.doesNotMatch(result, /model_provider/);
  assert.doesNotMatch(result, /model_providers\.kobashi/);
  assert.match(result, /show-context-window-usage = true/);
});

test("reinjection preserves settings added after the backup was created", () => {
  const live = `model_provider = "kobashi"
model = "gpt-5.6-sol"
model_context_window = 1050000
model_auto_compact_token_limit = 900000
model_reasoning_effort = "ultra"

[model_providers.kobashi]
name = "Kobashi"
base_url = "http://127.0.0.1:18921/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"

[desktop]
show-context-window-usage = true
`;

  const result = injectCodexConfig(live, 18921);
  assert.match(result, /^model_provider = "kobashi"/);
  assert.match(result, /^model_context_window = 1050000$/m);
  assert.match(result, /^model_reasoning_effort = "ultra"$/m);
  assert.equal((result.match(/\[model_providers\.kobashi\]/g) || []).length, 1);
});

test("restore merges the old provider with live user settings", () => {
  const backup = `model_provider = "openai"

[desktop]
show-context-window-usage = false
`;
  const live = `model_provider = "kobashi"
model_context_window = 1000000

[model_providers.kobashi]
name = "Kobashi"
base_url = "http://127.0.0.1:18921/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"

[desktop]
show-context-window-usage = true
`;

  const result = restoreCodexConfigContents(live, backup);
  assert.match(result, /^model_provider = "openai"$/m);
  assert.match(result, /^model_context_window = 1000000$/m);
  assert.match(result, /^show-context-window-usage = true$/m);
  assert.doesNotMatch(result, /model_providers\.kobashi/);
});

test("restore ignores a stale legacy Kobashi provider backup", () => {
  const backup = `model_provider = "copilot-bridge"

[model_providers.copilot-bridge]
name = "Old bridge"
base_url = "http://127.0.0.1:4141/v1"
`;
  const live = `${injectCodexConfig("model_context_window = 1000000\n", 18921)}
[plugins.example]
enabled = true
`;

  const result = restoreCodexConfigContents(live, backup);
  assert.doesNotMatch(result, /^model_provider\s*=/m);
  assert.doesNotMatch(result, /\[model_providers\.copilot-bridge\]/);
  assert.match(result, /^model_context_window = 1000000$/m);
  assert.match(result, /\[plugins\.example\]/);
});

test("multiline strings, arrays, and blank lines survive inject and restore byte-for-byte", () => {
  const source = `developer_instructions = """
Keep these bytes:

[model_providers.kobashi]
model_provider = "kobashi"

"""
literal_instructions = '''
[model_providers.copilot-bridge]
'''
allowed = [
  "alpha",
  "[model_providers.kobashi]",
]



[desktop]
show-context-window-usage = true
`;
  const options = { modelCatalogPath: "/tmp/models.json" };

  const live = injectCodexConfig(source, 18921, options);
  assert.match(live, /Keep these bytes:\n\n\[model_providers\.kobashi\]\nmodel_provider = "kobashi"\n\n"""/);
  assert.match(live, /literal_instructions = '''\n\[model_providers\.copilot-bridge\]\n'''/);
  assert.match(live, /\]\n\n\n\n\[model_providers\.kobashi\]/);

  const restored = restoreCodexConfigContents(live, source, options);
  assert.equal(restored, source);
});

test("CRLF and UTF-8 BOM are retained without introducing lone LF characters", () => {
  const source = "\uFEFFmodel_context_window = 1000000\r\n\r\n\r\n" +
    "[desktop]\r\nshow-context-window-usage = true\r\n";
  const options = { modelCatalogPath: "C:\\Users\\me\\models.json" };

  const live = injectCodexConfig(source, 18921, options);
  assert.equal(live.startsWith("\uFEFF"), true);
  assert.equal(/(^|[^\r])\n/.test(live), false);

  const restored = restoreCodexConfigContents(live, source, options);
  assert.equal(restored, source);
});

test("restore is idempotent and retains a non-Kobashi model provider", () => {
  const backup = `model_provider = "openai"

[model_providers.custom]
name = "Custom"
base_url = "https://example.test/v1"

[desktop]
show-context-window-usage = true
`;
  const live = injectCodexConfig(backup, 18921);

  const restoredOnce = restoreCodexConfigContents(live, backup);
  const restoredTwice = restoreCodexConfigContents(restoredOnce, backup);

  assert.equal(restoredTwice, restoredOnce);
  assert.equal((restoredTwice.match(/^model_provider = "openai"$/gm) || []).length, 1);
  assert.match(restoredTwice, /\[model_providers\.custom\]/);
  assert.doesNotMatch(restoredTwice, /\[model_providers\.kobashi\]/);
});

test("restore does not claim a same-named provider that is not the local Kobashi bridge", () => {
  const userConfig = `model_provider = "kobashi"

[model_providers.kobashi]
name = "User provider"
base_url = "https://example.test/v1"
`;

  assert.equal(restoreCodexConfigContents(userConfig), userConfig);
});
