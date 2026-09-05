const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const {
  buildKobashiModelCatalog,
  createKobashiModelCatalog,
  ensureKobashiModelCatalog,
  getCopilotReasoningEfforts,
  loadBundledCodexModelCatalog,
  selectCopilotOpenAIModels,
  writeModelCatalogAtomic,
} = require("../lib/codex-model-catalog");

function modelRecord(slug, overrides = {}) {
  return {
    slug,
    display_name: slug,
    description: `${slug} bundled description`,
    default_reasoning_level: "medium",
    supported_reasoning_levels: [
      { effort: "low", description: "Bundled low" },
      { effort: "medium", description: "Bundled medium" },
    ],
    shell_type: "unified_exec",
    visibility: "hide",
    supported_in_api: true,
    priority: 99,
    support_verbosity: true,
    truncation_policy: { mode: "tokens", limit: 12345 },
    experimental_supported_tools: [],
    base_instructions: `Bundled instructions for ${slug}`,
    ...overrides,
  };
}

function copilotModel(id, overrides = {}) {
  const base = {
    id,
    name: id,
    vendor: "OpenAI",
    version: id,
    model_picker_enabled: true,
    policy: { state: "enabled" },
    capabilities: {
      type: "chat",
      limits: {
        max_context_window_tokens: 400000,
        max_prompt_tokens: 272000,
      },
      supports: {
        streaming: true,
        tool_calls: true,
        reasoning_effort: ["low", "medium", "high"],
      },
    },
  };
  return {
    ...base,
    ...overrides,
    capabilities: {
      ...base.capabilities,
      ...(overrides.capabilities || {}),
      limits: {
        ...base.capabilities.limits,
        ...(overrides.capabilities?.limits || {}),
      },
      supports: {
        ...base.capabilities.supports,
        ...(overrides.capabilities?.supports || {}),
      },
    },
  };
}

function assertCodexMinimumRecord(record) {
  assert.equal(typeof record.slug, "string");
  assert.equal(typeof record.display_name, "string");
  assert.ok(Array.isArray(record.supported_reasoning_levels));
  assert.equal(typeof record.shell_type, "string");
  assert.equal(record.visibility, "list");
  assert.equal(record.supported_in_api, true);
  assert.equal(typeof record.priority, "number");
  assert.equal(typeof record.support_verbosity, "boolean");
  assert.equal(typeof record.truncation_policy, "object");
  assert.ok(Array.isArray(record.experimental_supported_tools));
  assert.ok(
    typeof record.base_instructions === "string" ||
    typeof record.model_messages?.instructions_template === "string",
  );
}

function withTempDir(run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kobashi-model-catalog-test-"));
  try {
    return run(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("selects the live account-enabled OpenAI chat models without a fixed allowlist", () => {
  const selected = selectCopilotOpenAIModels({
    data: [
      copilotModel("gpt-5-mini", { vendor: "Azure OpenAI" }),
      copilotModel("gpt-6-astra", { name: "GPT-6 Astra" }),
      copilotModel("gpt-5.6-sol"),
      copilotModel("gpt-5.6-sol-fast", { name: "GPT-5.6 Sol Fast (Internal only)" }),
      copilotModel("gpt-7-disabled", { policy: { state: "disabled" } }),
      copilotModel("gpt-7-hidden", { model_picker_enabled: false }),
      copilotModel("gpt-7-embedding", { capabilities: { type: "embeddings" } }),
      copilotModel("gemini-4-pro", { vendor: "Google" }),
      copilotModel("gpt-6-astra"),
    ],
  });

  assert.deepEqual(selected.map(model => model.id), [
    "gpt-6-astra",
    "gpt-5.6-sol",
    "gpt-5-mini",
  ]);
});

test("normalizes live reasoning efforts to values Codex understands", () => {
  const model = copilotModel("gpt-7", {
    capabilities: {
      supports: {
        reasoning_effort: ["HIGH", "low", "future", "max", "low", "none"],
      },
    },
  });
  assert.deepEqual(getCopilotReasoningEfforts(model), ["none", "low", "high", "max"]);
});

test("live models drive the catalog and exact bundled metadata is preserved", () => {
  const astraMetadata = { family: "astra", nested: { value: 1 } };
  const bundled = {
    models: [
      modelRecord("gpt-6-astra", {
        display_name: "GPT-6-Astra",
        description: "Bundled Astra description",
        default_reasoning_level: "low",
        supported_reasoning_levels: [
          { effort: "low", description: "Bundled low" },
          { effort: "medium", description: "Bundled medium" },
          { effort: "high", description: "Bundled high" },
          { effort: "xhigh", description: "Bundled xhigh" },
          { effort: "max", description: "Bundled max" },
          { effort: "ultra", description: "Bundled ultra" },
        ],
        kobashi_test_metadata: astraMetadata,
      }),
      modelRecord("gpt-5.6-sol"),
    ],
  };
  const live = {
    data: [
      copilotModel("gpt-5.6-sol"),
      copilotModel("gpt-6-astra", {
        name: "GPT-6 Astra",
        capabilities: {
          limits: {
            max_context_window_tokens: 1000000,
            max_prompt_tokens: 872000,
          },
          supports: {
            reasoning_effort: ["low", "medium", "high", "xhigh", "max"],
          },
        },
      }),
    ],
  };

  const result = buildKobashiModelCatalog(bundled, live);
  assert.deepEqual(result.models.map(model => model.slug), ["gpt-6-astra", "gpt-5.6-sol"]);
  assert.deepEqual(result.models.map(model => model.priority), [1, 2]);

  const astra = result.models[0];
  assert.equal(astra.display_name, "GPT-6-Astra");
  assert.equal(astra.description, "Bundled Astra description");
  assert.equal(astra.context_window, 1000000);
  assert.equal(astra.max_context_window, 1000000);
  assert.equal(astra.auto_compact_token_limit, 872000);
  assert.deepEqual(
    astra.supported_reasoning_levels.map(level => level.effort),
    ["low", "medium", "high", "xhigh", "max", "ultra"],
  );
  assert.equal(astra.kobashi_test_metadata.family, "astra");
  assert.notEqual(astra.kobashi_test_metadata, astraMetadata);
  result.models.forEach(assertCodexMinimumRecord);
});

test("a future live model is synthesized from the nearest bundle metadata", () => {
  const fullMetadata = { family: "full", nested: { value: 1 } };
  const bundled = {
    models: [
      modelRecord("gpt-5.6-sol", { kobashi_test_metadata: fullMetadata }),
      modelRecord("gpt-5.6-luna", { kobashi_test_metadata: { family: "small" } }),
    ],
  };
  const live = {
    data: [
      copilotModel("gpt-7-orbit", {
        name: "GPT-7 Orbit",
        capabilities: {
          limits: {
            max_context_window_tokens: 1200000,
            max_prompt_tokens: 950000,
          },
          supports: {
            reasoning_effort: ["low", "medium", "high", "xhigh", "max"],
          },
        },
      }),
    ],
  };

  const result = buildKobashiModelCatalog(bundled, live);
  const orbit = result.models[0];
  assert.equal(orbit.slug, "gpt-7-orbit");
  assert.equal(orbit.display_name, "GPT-7 Orbit");
  assert.match(orbit.description, /GitHub Copilot/);
  assert.equal(orbit.kobashi_test_metadata.family, "full");
  assert.notEqual(orbit.kobashi_test_metadata, fullMetadata);
  assert.equal(orbit.context_window, 1000000);
  assert.equal(orbit.auto_compact_token_limit, 900000);
  assert.deepEqual(
    orbit.supported_reasoning_levels.map(level => level.effort),
    ["low", "medium", "high", "xhigh", "max"],
  );
  assertCodexMinimumRecord(orbit);
});

test("missing live data falls back to visible bundled OpenAI models", () => {
  const result = buildKobashiModelCatalog({
    models: [
      modelRecord("gpt-5.6-sol", { visibility: "list", priority: 2 }),
      modelRecord("gpt-6-astra", { visibility: "list", priority: 1 }),
      modelRecord("gpt-5.4", { visibility: "hide" }),
      modelRecord("gpt-internal-preview", {
        display_name: "GPT Internal Only",
        visibility: "list",
      }),
      modelRecord("codex-auto-review", { visibility: "list" }),
    ],
  });

  assert.deepEqual(result.models.map(model => model.slug), ["gpt-6-astra", "gpt-5.6-sol"]);
  result.models.forEach(assertCodexMinimumRecord);
});

test("invalid or unavailable inputs produce a valid emergency fallback", () => {
  for (const input of [undefined, null, {}, { models: "invalid" }]) {
    const result = buildKobashiModelCatalog(input);
    assert.deepEqual(result.models.map(model => model.slug), ["gpt-5"]);
    result.models.forEach(assertCodexMinimumRecord);
  }
});

test("bundled catalog loader isolates Codex from the user's real config", () => {
  withTempDir(tempRoot => {
    let scratchDir;
    const result = loadBundledCodexModelCatalog({
      tempRoot,
      env: { CODEX_HOME: "must-not-be-used" },
      execFileSyncImpl(command, args, options) {
        assert.equal(command, "codex");
        assert.deepEqual(args, ["debug", "models", "--bundled"]);
        assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
        scratchDir = options.env.CODEX_HOME;
        assert.notEqual(scratchDir, "must-not-be-used");
        assert.equal(path.dirname(scratchDir), tempRoot);
        assert.ok(fs.existsSync(scratchDir));
        return JSON.stringify({ models: [modelRecord("gpt-6-astra")] });
      },
    });

    assert.equal(result.models[0].slug, "gpt-6-astra");
    assert.equal(fs.existsSync(scratchDir), false);
  });
});

test("bundled catalog loader discovers the ChatGPT app Codex binary", () => {
  withTempDir(tempRoot => {
    const commands = [];
    const appCommand = "/Applications/ChatGPT.app/Contents/Resources/codex";
    const fsImpl = {
      ...fs,
      existsSync(value) {
        return value === appCommand || fs.existsSync(value);
      },
    };
    const result = loadBundledCodexModelCatalog({
      tempRoot,
      fsImpl,
      execFileSyncImpl(command) {
        commands.push(command);
        if (command === "codex") throw Object.assign(new Error("not found"), { code: "ENOENT" });
        return JSON.stringify({ models: [modelRecord("gpt-6-astra")] });
      },
    });

    assert.deepEqual(commands, ["codex", appCommand]);
    assert.equal(result.models[0].slug, "gpt-6-astra");
  });
});

test("catalog creation falls back safely when Codex cannot be queried", () => {
  let warning;
  const result = createKobashiModelCatalog({
    codexCommand: "missing-codex",
    execFileSyncImpl() { throw new Error("Codex unavailable"); },
    onWarning(error) { warning = error; },
  });

  assert.match(warning.message, /Codex unavailable/);
  assert.deepEqual(result.models.map(model => model.slug), ["gpt-5"]);
  result.models.forEach(assertCodexMinimumRecord);
});

test("atomic writer replaces the target and leaves no sibling temporary file", () => {
  withTempDir(tempRoot => {
    const target = path.join(tempRoot, "nested", "models.json");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "old contents", "utf8");
    const catalog = buildKobashiModelCatalog({ models: [] });

    assert.equal(writeModelCatalogAtomic(target, catalog), path.resolve(target));
    assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), catalog);
    assert.deepEqual(fs.readdirSync(path.dirname(target)), ["models.json"]);
  });
});

test("atomic writer preserves the previous catalog when rename fails", () => {
  withTempDir(tempRoot => {
    const target = path.join(tempRoot, "models.json");
    fs.writeFileSync(target, "previous catalog", "utf8");
    const fsImpl = {
      mkdirSync: fs.mkdirSync,
      writeFileSync: fs.writeFileSync,
      unlinkSync: fs.unlinkSync,
      renameSync() { throw new Error("simulated rename failure"); },
    };

    assert.throws(
      () => writeModelCatalogAtomic(
        target,
        buildKobashiModelCatalog({ models: [] }),
        { fsImpl, tempSuffix: "failure-probe" },
      ),
      /simulated rename failure/,
    );
    assert.equal(fs.readFileSync(target, "utf8"), "previous catalog");
    assert.equal(fs.existsSync(path.join(tempRoot, ".models.json.failure-probe.tmp")), false);
  });
});

test("ensure helper writes a live catalog only beneath the supplied home", () => {
  withTempDir(homeDir => {
    const result = ensureKobashiModelCatalog({
      homeDir,
      bundledCatalog: { models: [modelRecord("gpt-6-astra")] },
      copilotCatalog: { data: [copilotModel("gpt-6-astra")] },
    });

    assert.equal(result.catalogPath, path.join(homeDir, ".kobashi", "codex-model-catalog.json"));
    assert.deepEqual(JSON.parse(fs.readFileSync(result.catalogPath, "utf8")), result.catalog);
    assert.deepEqual(result.catalog.models.map(model => model.slug), ["gpt-6-astra"]);
  });
});
