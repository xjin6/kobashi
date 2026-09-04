const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const {
  KOBASHI_OPENAI_MODEL_SLUGS,
  buildKobashiModelCatalog,
  createKobashiModelCatalog,
  ensureKobashiModelCatalog,
  loadBundledCodexModelCatalog,
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

test("catalog is an exact OpenAI allowlist and preserves bundled metadata", () => {
  const expectedModels = [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.3-codex",
    "gpt-5-mini",
  ];
  const sourceModels = KOBASHI_OPENAI_MODEL_SLUGS.map(slug => modelRecord(slug));
  sourceModels.push(
    modelRecord("gpt-5.2"),
    modelRecord("gpt-5.6-sol-fast"),
    modelRecord("grok-4.6"),
    modelRecord("mai-code-1.1-flash"),
    modelRecord("gpt-daybreak-blue-latest"),
  );
  const source = { models: sourceModels };

  const result = buildKobashiModelCatalog(source);
  assert.deepEqual(KOBASHI_OPENAI_MODEL_SLUGS, expectedModels);
  assert.deepEqual(result.models.map(model => model.slug), expectedModels);
  assert.deepEqual(result.models.map(model => model.priority), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(result.models.every(model => model.visibility === "list"));
  assert.equal(result.models[4].base_instructions, "Bundled instructions for gpt-5.4");
  assert.equal(result.models[4].truncation_policy.limit, 12345);
  assert.deepEqual(
    result.models[0].supported_reasoning_levels.map(level => level.effort),
    ["low", "medium", "high", "xhigh", "max", "ultra"],
  );
  assert.deepEqual(
    result.models[4].supported_reasoning_levels.map(level => level.effort),
    ["low", "medium", "high", "xhigh"],
  );
  for (const model of result.models.slice(0, 5)) {
    assert.equal(model.context_window, 1000000);
    assert.equal(model.max_context_window, 1000000);
    assert.equal(model.auto_compact_token_limit, 900000);
  }
  for (const model of result.models.slice(5, 7)) {
    assert.equal(model.context_window, 272000);
    assert.equal(model.max_context_window, 272000);
    assert.equal("auto_compact_token_limit" in model, false);
  }
  assert.equal(result.models[7].context_window, 128000);
  assert.equal(result.models[7].max_context_window, 128000);
  assert.equal("auto_compact_token_limit" in result.models[7], false);

  // Building a catalog must not mutate the installed catalog supplied by Codex.
  assert.equal(source.models.find(model => model.slug === "gpt-5.4").visibility, "hide");
  assert.equal(source.models.find(model => model.slug === "gpt-5.4").priority, 99);
});

test("missing models clone the nearest bundled family metadata", () => {
  const fullMetadata = { family: "full", nested: { value: 1 } };
  const miniMetadata = { family: "mini", nested: { value: 2 } };
  const source = {
    models: [
      modelRecord("gpt-5.4", { kobashi_test_metadata: fullMetadata }),
      modelRecord("gpt-5.4-mini", { kobashi_test_metadata: miniMetadata }),
    ],
  };

  const result = buildKobashiModelCatalog(source);
  const codex53 = result.models.find(model => model.slug === "gpt-5.3-codex");
  const mini5 = result.models.find(model => model.slug === "gpt-5-mini");

  assert.equal(codex53.kobashi_test_metadata.family, "full");
  assert.equal(mini5.kobashi_test_metadata.family, "mini");
  assert.notEqual(codex53.kobashi_test_metadata, fullMetadata);
  assert.notEqual(mini5.kobashi_test_metadata.nested, miniMetadata.nested);
  assert.deepEqual(
    codex53.supported_reasoning_levels.map(level => level.effort),
    ["low", "medium", "high", "xhigh"],
  );
  assert.deepEqual(
    mini5.supported_reasoning_levels.map(level => level.effort),
    ["minimal", "low", "medium", "high"],
  );
});

test("invalid or unavailable bundled data produces a valid small fallback", () => {
  for (const input of [undefined, null, {}, { models: "invalid" }]) {
    const result = buildKobashiModelCatalog(input);
    assert.deepEqual(result.models.map(model => model.slug), KOBASHI_OPENAI_MODEL_SLUGS);
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
        return JSON.stringify({ models: [modelRecord("gpt-5.4")] });
      },
    });

    assert.equal(result.models[0].slug, "gpt-5.4");
    assert.equal(fs.existsSync(scratchDir), false);
  });
});

test("catalog creation falls back safely when Codex cannot be queried", () => {
  let warning;
  const result = createKobashiModelCatalog({
    execFileSyncImpl() { throw new Error("Codex unavailable"); },
    onWarning(error) { warning = error; },
  });

  assert.match(warning.message, /Codex unavailable/);
  assert.deepEqual(result.models.map(model => model.slug), KOBASHI_OPENAI_MODEL_SLUGS);
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

test("ensure helper writes only beneath an explicitly supplied home directory", () => {
  withTempDir(homeDir => {
    const result = ensureKobashiModelCatalog({
      homeDir,
      bundledCatalog: { models: [modelRecord("gpt-5.4")] },
    });

    assert.equal(result.catalogPath, path.join(homeDir, ".kobashi", "codex-model-catalog.json"));
    assert.deepEqual(JSON.parse(fs.readFileSync(result.catalogPath, "utf8")), result.catalog);
  });
});
