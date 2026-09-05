const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const FALLBACK_BASE_INSTRUCTIONS =
  "You are Codex, an agentic coding assistant. Follow developer and user instructions, " +
  "use the available tools when helpful, and work carefully in the user's workspace.";

const DEFAULT_REASONING_DESCRIPTIONS = Object.freeze({
  none: "No reasoning",
  minimal: "Fastest responses with minimal reasoning",
  low: "Fast responses with lighter reasoning",
  medium: "Balances speed and reasoning depth for everyday tasks",
  high: "Greater reasoning depth for complex problems",
  xhigh: "Extra high reasoning depth for complex problems",
  max: "Maximum reasoning depth for the hardest problems",
  ultra: "Maximum reasoning with automatic task delegation",
});

const CODEX_REASONING_EFFORTS = Object.freeze([
  "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
]);
const CODEX_REASONING_EFFORT_SET = new Set(CODEX_REASONING_EFFORTS);
const LONG_CONTEXT_THRESHOLD = 1_000_000;
const LONG_CONTEXT_WINDOW = 1_000_000;
const LONG_CONTEXT_AUTO_COMPACT = 900_000;
const EMERGENCY_MODEL_ID = "gpt-5";

function parseCatalog(value) {
  let catalog = value;
  if (Buffer.isBuffer(catalog)) catalog = catalog.toString("utf8");
  if (typeof catalog === "string") catalog = JSON.parse(catalog);
  if (!catalog || typeof catalog !== "object" || !Array.isArray(catalog.models)) {
    throw new TypeError("Codex model catalog must be an object with a models array");
  }
  return catalog;
}

function hasInstructions(record) {
  return typeof record.base_instructions === "string" ||
    typeof record.model_messages?.instructions_template === "string";
}

// These are the fields Codex 0.153.0 requires when parsing a custom catalog.
// Optional metadata is preserved by cloning the bundled record when possible.
function isUsableRecord(record) {
  return !!record && typeof record === "object" &&
    typeof record.slug === "string" &&
    typeof record.display_name === "string" &&
    Array.isArray(record.supported_reasoning_levels) &&
    typeof record.shell_type === "string" &&
    typeof record.visibility === "string" &&
    typeof record.supported_in_api === "boolean" &&
    Number.isFinite(record.priority) &&
    typeof record.support_verbosity === "boolean" &&
    !!record.truncation_policy && typeof record.truncation_policy === "object" &&
    Array.isArray(record.experimental_supported_tools) &&
    hasInstructions(record);
}

function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function reasoningLevels(efforts, template = []) {
  const descriptions = new Map(
    template
      .filter(level => level && typeof level.effort === "string")
      .map(level => [level.effort, level.description]),
  );
  return efforts.map(effort => ({
    effort,
    description: descriptions.get(effort) || DEFAULT_REASONING_DESCRIPTIONS[effort],
  }));
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

function looksLikeOpenAIModelId(id) {
  return /^(?:gpt(?:-|$)|o\d+(?:-|$))/i.test(String(id || ""));
}

function isInternalModel(model) {
  return /\binternal(?:\s+only)?\b/i.test(
    [model?.id, model?.name, model?.description].filter(Boolean).join(" "),
  );
}

function parseCopilotModels(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray(value.data)) return value.data;
  return [];
}

/**
 * Return only account-enabled OpenAI chat models advertised by GitHub Copilot.
 * The endpoint is account- and policy-aware; a name-based fixed allowlist would
 * immediately go stale whenever Copilot rolls out a new model.
 */
function selectCopilotOpenAIModels(copilotCatalog) {
  const seen = new Set();
  return parseCopilotModels(copilotCatalog)
    .filter(model => {
      if (!model || typeof model !== "object") return false;
      const id = typeof model.id === "string" ? model.id.trim() : "";
      if (!id || seen.has(id) || isInternalModel(model)) return false;

      const vendor = String(model.vendor || "");
      if (!/\bopenai\b/i.test(vendor) && !(vendor === "" && looksLikeOpenAIModelId(id))) {
        return false;
      }
      if ("model_picker_enabled" in model && model.model_picker_enabled !== true) return false;

      const policyState = model.policy && typeof model.policy === "object"
        ? String(model.policy.state || "").toLowerCase()
        : "";
      if (policyState && policyState !== "enabled") return false;

      const capabilities = model.capabilities || {};
      if (capabilities.type && capabilities.type !== "chat") return false;
      if (capabilities.supports?.streaming === false ||
          capabilities.supports?.tool_calls === false) return false;

      seen.add(id);
      return true;
    })
    .sort(compareLiveModels);
}

function modelVersion(id) {
  const value = String(id || "");
  const gpt = value.match(/^gpt-(\d+)(?:[.-](\d+))?(?:[.-](\d+))?/i);
  if (gpt) return [3, Number(gpt[1]), Number(gpt[2] || 0), Number(gpt[3] || 0)];
  const o = value.match(/^o(\d+)(?:[.-](\d+))?/i);
  if (o) return [2, Number(o[1]), Number(o[2] || 0), 0];
  const numbers = (value.match(/\d+/g) || []).slice(0, 3).map(Number);
  return [1, ...(numbers.concat([0, 0, 0]).slice(0, 3))];
}

function variantPriority(id) {
  const value = String(id || "").toLowerCase();
  if (value.includes("astra")) return 80;
  if (value.includes("sol")) return 70;
  if (value.includes("terra")) return 60;
  if (value.includes("luna")) return 50;
  if (value.includes("codex")) return 40;
  if (value.includes("mini")) return 10;
  return 30;
}

function compareLiveModels(left, right) {
  const a = modelVersion(left?.id);
  const b = modelVersion(right?.id);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (b[index] || 0) - (a[index] || 0);
  }
  const variantDifference = variantPriority(right?.id) - variantPriority(left?.id);
  if (variantDifference) return variantDifference;
  return String(left?.id || "").localeCompare(String(right?.id || ""));
}

function getCopilotReasoningEfforts(model) {
  const efforts = model?.capabilities?.supports?.reasoning_effort;
  if (!Array.isArray(efforts)) return [];
  const seen = new Set();
  return efforts
    .map(effort => String(effort || "").toLowerCase())
    .filter(effort => CODEX_REASONING_EFFORT_SET.has(effort) && effort !== "ultra")
    .filter(effort => {
      if (seen.has(effort)) return false;
      seen.add(effort);
      return true;
    })
    .sort((left, right) =>
      CODEX_REASONING_EFFORTS.indexOf(left) - CODEX_REASONING_EFFORTS.indexOf(right));
}

function chooseDefaultEffort(efforts, preferred) {
  if (efforts.includes(preferred)) return preferred;
  for (const effort of ["medium", "low", "high", "minimal", "none", "xhigh", "max", "ultra"]) {
    if (efforts.includes(effort)) return effort;
  }
  return "medium";
}

function liveModelSpec(model, template, exact) {
  const apiEfforts = getCopilotReasoningEfforts(model);
  const templateEfforts = (template?.supported_reasoning_levels || [])
    .map(level => level?.effort)
    .filter(effort => CODEX_REASONING_EFFORT_SET.has(effort));

  let efforts;
  if (exact && templateEfforts.length) {
    const apiSet = new Set(apiEfforts);
    efforts = templateEfforts.filter(effort => effort === "ultra" || apiSet.has(effort));
  } else {
    efforts = apiEfforts;
  }
  if (!efforts.length) efforts = templateEfforts.filter(effort => effort !== "ultra");
  if (!efforts.length) efforts = ["low", "medium", "high"];

  const limits = model?.capabilities?.limits || {};
  const maxContext = positiveInteger(limits.max_context_window_tokens);
  const maxPrompt = positiveInteger(limits.max_prompt_tokens);
  let contextWindow = positiveInteger(template?.context_window) || 272_000;
  let autoCompactTokenLimit = positiveInteger(template?.auto_compact_token_limit);

  // Copilot reports both the total window and its maximum prompt. Preserve
  // Kobashi's safe 1M cap for million-token models, and compact before the
  // account-specific prompt ceiling. Smaller models use their prompt ceiling.
  if (maxContext && maxContext >= LONG_CONTEXT_THRESHOLD) {
    contextWindow = LONG_CONTEXT_WINDOW;
    autoCompactTokenLimit = Math.min(
      maxPrompt || LONG_CONTEXT_AUTO_COMPACT,
      LONG_CONTEXT_AUTO_COMPACT,
    );
  } else if (maxPrompt || maxContext) {
    contextWindow = maxPrompt || maxContext;
    autoCompactTokenLimit = null;
  }

  const displayName = exact && template?.display_name
    ? template.display_name
    : String(model.name || model.id);
  const description = exact && template?.description
    ? template.description
    : `${displayName} (available through GitHub Copilot).`;

  return {
    slug: model.id,
    displayName,
    description,
    efforts,
    defaultEffort: chooseDefaultEffort(efforts, template?.default_reasoning_level),
    contextWindow,
    autoCompactTokenLimit,
  };
}

function fallbackRecord(spec, priority) {
  return {
    slug: spec.slug,
    display_name: spec.displayName,
    description: spec.description,
    default_reasoning_level: spec.defaultEffort,
    supported_reasoning_levels: reasoningLevels(spec.efforts),
    shell_type: "unified_exec",
    visibility: "list",
    supported_in_api: true,
    priority,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    include_skills_usage_instructions: true,
    include_plugin_usage_instructions: true,
    include_apps_usage_instructions: true,
    default_reasoning_summary: "auto",
    support_verbosity: true,
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text_and_image",
    truncation_policy: { mode: "tokens", limit: 10000 },
    supports_image_detail_original: true,
    context_window: 272000,
    max_context_window: 272000,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ["text", "image"],
    supports_search_tool: true,
    use_responses_lite: true,
    base_instructions: FALLBACK_BASE_INSTRUCTIONS,
  };
}

function templateKind(slug) {
  const value = String(slug || "").toLowerCase();
  if (value.includes("mini") || value.includes("luna")) return "small";
  return "full";
}

function findTemplate(slug, bySlug, sourceModels) {
  const exact = bySlug.get(slug);
  if (isUsableRecord(exact)) return { record: exact, exact: true };

  const targetVersion = modelVersion(slug);
  const targetKind = templateKind(slug);
  const candidates = sourceModels.filter(isUsableRecord);
  candidates.sort((left, right) => {
    const leftKind = templateKind(left.slug) === targetKind ? 1 : 0;
    const rightKind = templateKind(right.slug) === targetKind ? 1 : 0;
    if (leftKind !== rightKind) return rightKind - leftKind;

    const leftVersion = modelVersion(left.slug);
    const rightVersion = modelVersion(right.slug);
    const distance = version =>
      Math.abs((version[1] || 0) - (targetVersion[1] || 0)) * 1000 +
      Math.abs((version[2] || 0) - (targetVersion[2] || 0)) * 10 +
      Math.abs((version[3] || 0) - (targetVersion[3] || 0));
    const distanceDifference = distance(leftVersion) - distance(rightVersion);
    if (distanceDifference) return distanceDifference;
    return compareLiveModels({ id: left.slug }, { id: right.slug });
  });
  return { record: candidates[0] || null, exact: false };
}

function buildBundledFallback(sourceModels) {
  const models = sourceModels
    .filter(isUsableRecord)
    .filter(record =>
      record.visibility === "list" &&
      record.supported_in_api === true &&
      looksLikeOpenAIModelId(record.slug) &&
      !isInternalModel({ id: record.slug, name: record.display_name, description: record.description }))
    .sort((left, right) =>
      compareLiveModels({ id: left.slug }, { id: right.slug }))
    .map((source, index) => {
      const record = cloneJson(source);
      record.visibility = "list";
      record.supported_in_api = true;
      record.priority = index + 1;
      record.availability_nux = null;
      record.upgrade = null;
      return record;
    });

  if (models.length) return { models };
  const spec = {
    slug: EMERGENCY_MODEL_ID,
    displayName: "GPT-5",
    description: "OpenAI model (offline fallback; refreshes from GitHub Copilot when connected).",
    efforts: ["low", "medium", "high"],
    defaultEffort: "medium",
    contextWindow: 272_000,
    autoCompactTokenLimit: null,
  };
  return { models: [fallbackRecord(spec, 1)] };
}

/**
 * Build Codex's custom catalog from the live, account-scoped Copilot catalog.
 * The installed Codex bundle supplies rich UI/instruction metadata only; it is
 * never used as a fixed allowlist when live data is available.
 */
function buildKobashiModelCatalog(bundledCatalog, copilotCatalog) {
  let sourceModels = [];
  try {
    sourceModels = parseCatalog(bundledCatalog).models;
  } catch {
    // Synthesised records below keep the catalog valid without Codex installed.
  }

  const bySlug = new Map(
    sourceModels
      .filter(record => record && typeof record.slug === "string")
      .map(record => [record.slug, record]),
  );

  const liveModels = selectCopilotOpenAIModels(copilotCatalog);
  if (!liveModels.length) return buildBundledFallback(sourceModels);

  const models = liveModels.map((model, index) => {
    const priority = index + 1;
    const template = findTemplate(model.id, bySlug, sourceModels);
    const spec = liveModelSpec(model, template.record, template.exact);
    let record = template.record && cloneJson(template.record);
    if (!record) record = fallbackRecord(spec, priority);

    record.slug = spec.slug;
    record.display_name = spec.displayName;
    record.visibility = "list";
    record.supported_in_api = true;
    record.priority = priority;
    record.availability_nux = null;
    record.upgrade = null;
    record.context_window = spec.contextWindow;
    record.max_context_window = spec.contextWindow;
    if (Number.isFinite(spec.autoCompactTokenLimit)) {
      record.auto_compact_token_limit = spec.autoCompactTokenLimit;
    } else {
      delete record.auto_compact_token_limit;
    }

    record.default_reasoning_level = spec.defaultEffort;
    record.supported_reasoning_levels = reasoningLevels(
      spec.efforts,
      record.supported_reasoning_levels,
    );

    if (!template.exact) {
      record.display_name = spec.displayName;
      record.description = spec.description;
    }
    return record;
  });

  return { models };
}

/** Read the installed Codex binary's catalog without loading the user's config. */
function loadBundledCodexModelCatalog(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const tempRoot = path.resolve(options.tempRoot || os.tmpdir());
  const scratchPrefix = path.join(tempRoot, "kobashi-codex-catalog-");
  const scratchDir = fsImpl.mkdtempSync(scratchPrefix);

  try {
    const explicitCommand = !!options.codexCommand;
    const commands = explicitCommand
      ? [options.codexCommand]
      : [
          "codex",
          "/Applications/ChatGPT.app/Contents/Resources/codex",
          "/Applications/Codex.app/Contents/Resources/codex",
          path.join(process.env.HOME || "", "Applications/ChatGPT.app/Contents/Resources/codex"),
          path.join(process.env.HOME || "", "Applications/Codex.app/Contents/Resources/codex"),
          "/opt/homebrew/bin/codex",
          "/usr/local/bin/codex",
          path.join(process.env.HOME || "", ".local/bin/codex"),
          path.join(process.env.HOME || "", ".npm-global/bin/codex"),
        ];
    let lastError = null;
    for (const command of [...new Set(commands.filter(Boolean))]) {
      if (!explicitCommand &&
          command !== "codex" &&
          typeof fsImpl.existsSync === "function" &&
          !fsImpl.existsSync(command)) continue;
      try {
        const output = (options.execFileSyncImpl || execFileSync)(
          command,
          ["debug", "models", "--bundled"],
          {
            encoding: "utf8",
            env: { ...process.env, ...options.env, CODEX_HOME: scratchDir },
            maxBuffer: options.maxBuffer || 16 * 1024 * 1024,
            stdio: ["ignore", "pipe", "pipe"],
            timeout: options.timeout || 30000,
            windowsHide: true,
          },
        );
        return parseCatalog(output);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("Codex executable not found");
  } finally {
    // Delete only the exact directory mkdtempSync just created under tempRoot.
    const resolvedScratch = path.resolve(scratchDir);
    const ownedPrefix = `${tempRoot}${path.sep}`;
    if (resolvedScratch.startsWith(ownedPrefix) &&
        path.basename(resolvedScratch).startsWith("kobashi-codex-catalog-")) {
      try { fsImpl.rmSync(resolvedScratch, { recursive: true, force: true }); } catch {}
    }
  }
}

/** Query Codex when available and fall back to a self-contained valid catalog. */
function createKobashiModelCatalog(options = {}) {
  let bundledCatalog = options.bundledCatalog;
  if (bundledCatalog === undefined) {
    try {
      bundledCatalog = loadBundledCodexModelCatalog(options);
    } catch (error) {
      if (typeof options.onWarning === "function") {
        try { options.onWarning(error); } catch {}
      }
      bundledCatalog = { models: [] };
    }
  }
  return buildKobashiModelCatalog(bundledCatalog, options.copilotCatalog);
}

function getKobashiModelCatalogPath(homeDir = process.env.HOME || process.env.USERPROFILE) {
  if (!homeDir) throw new Error("Cannot locate the user's home directory");
  return path.resolve(homeDir, ".kobashi", "codex-model-catalog.json");
}

/** Write via a sibling temporary file, preserving the old file on any failure. */
function writeModelCatalogAtomic(filePath, catalog, options = {}) {
  parseCatalog(catalog);
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new TypeError("Model catalog path must be a non-empty string");
  }

  const fsImpl = options.fsImpl || fs;
  const targetPath = path.resolve(filePath);
  const targetDir = path.dirname(targetPath);
  fsImpl.mkdirSync(targetDir, { recursive: true });

  const suffix = options.tempSuffix ||
    `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tempPath = path.join(targetDir, `.${path.basename(targetPath)}.${suffix}.tmp`);
  const contents = `${JSON.stringify(catalog, null, 2)}\n`;

  if (options.skipUnchanged !== false &&
      typeof fsImpl.existsSync === "function" &&
      typeof fsImpl.readFileSync === "function" &&
      fsImpl.existsSync(targetPath)) {
    try {
      if (fsImpl.readFileSync(targetPath, "utf8") === contents) return targetPath;
    } catch {}
  }

  try {
    fsImpl.writeFileSync(tempPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    fsImpl.renameSync(tempPath, targetPath);
  } catch (error) {
    try { fsImpl.unlinkSync(tempPath); } catch {}
    throw error;
  }
  return targetPath;
}

function ensureKobashiModelCatalog(options = {}) {
  const catalog = createKobashiModelCatalog(options);
  const catalogPath = options.catalogPath || getKobashiModelCatalogPath(options.homeDir);
  writeModelCatalogAtomic(catalogPath, catalog, options);
  return { catalogPath: path.resolve(catalogPath), catalog };
}

module.exports = {
  buildKobashiModelCatalog,
  createKobashiModelCatalog,
  ensureKobashiModelCatalog,
  getCopilotReasoningEfforts,
  getKobashiModelCatalogPath,
  loadBundledCodexModelCatalog,
  selectCopilotOpenAIModels,
  writeModelCatalogAtomic,
};
