const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const FALLBACK_BASE_INSTRUCTIONS =
  "You are Codex, an agentic coding assistant. Follow developer and user instructions, " +
  "use the available tools when helpful, and work carefully in the user's workspace.";

const DEFAULT_REASONING_DESCRIPTIONS = Object.freeze({
  minimal: "Fastest responses with minimal reasoning",
  low: "Fast responses with lighter reasoning",
  medium: "Balances speed and reasoning depth for everyday tasks",
  high: "Greater reasoning depth for complex problems",
  xhigh: "Extra high reasoning depth for complex problems",
  max: "Maximum reasoning depth for the hardest problems",
  ultra: "Maximum reasoning with automatic task delegation",
});

const MODEL_SPECS = Object.freeze([
  {
    slug: "gpt-5.6-sol",
    displayName: "GPT-5.6-Sol",
    description: "Latest frontier agentic coding model.",
    cloneFrom: ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"],
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultEffort: "low",
    contextWindow: 1000000,
    autoCompactTokenLimit: 900000,
  },
  {
    slug: "gpt-5.6-terra",
    displayName: "GPT-5.6-Terra",
    description: "Balanced agentic coding model for everyday work.",
    cloneFrom: ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.5"],
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultEffort: "medium",
    contextWindow: 1000000,
    autoCompactTokenLimit: 900000,
  },
  {
    slug: "gpt-5.6-luna",
    displayName: "GPT-5.6-Luna",
    description: "Fast and affordable agentic coding model.",
    cloneFrom: ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.5"],
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
    contextWindow: 1000000,
    autoCompactTokenLimit: 900000,
  },
  {
    slug: "gpt-5.5",
    displayName: "GPT-5.5",
    description: "Frontier model for complex coding, research, and real-world work.",
    cloneFrom: ["gpt-5.4", "gpt-5.6-terra"],
    efforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "medium",
    contextWindow: 1000000,
    autoCompactTokenLimit: 900000,
  },
  {
    slug: "gpt-5.4",
    displayName: "GPT-5.4",
    description: "OpenAI GPT-5.4 model.",
    cloneFrom: ["gpt-5.5", "gpt-5.3-codex"],
    efforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "medium",
    contextWindow: 1000000,
    autoCompactTokenLimit: 900000,
  },
  {
    slug: "gpt-5.4-mini",
    displayName: "GPT-5.4-Mini",
    description: "Fast, efficient GPT-5.4 model.",
    cloneFrom: ["gpt-5-mini", "gpt-5.4", "gpt-5.5"],
    efforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "medium",
    contextWindow: 272000,
  },
  {
    slug: "gpt-5.3-codex",
    displayName: "GPT-5.3-Codex",
    description: "Codex-tuned GPT-5.3 model.",
    cloneFrom: ["gpt-5.4", "gpt-5.5"],
    efforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "medium",
    contextWindow: 272000,
  },
  {
    slug: "gpt-5-mini",
    displayName: "GPT-5-Mini",
    description: "Fast, efficient OpenAI model.",
    cloneFrom: ["gpt-5.4-mini", "gpt-5.4", "gpt-5.5"],
    efforts: ["minimal", "low", "medium", "high"],
    defaultEffort: "medium",
    contextWindow: 128000,
  },
]);

const KOBASHI_OPENAI_MODEL_SLUGS = Object.freeze(MODEL_SPECS.map(spec => spec.slug));

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

function findTemplate(spec, bySlug) {
  const exact = bySlug.get(spec.slug);
  if (isUsableRecord(exact)) return { record: exact, exact: true };

  for (const slug of spec.cloneFrom) {
    const candidate = bySlug.get(slug);
    if (isUsableRecord(candidate)) return { record: candidate, exact: false };
  }
  return { record: null, exact: false };
}

/**
 * Build the replacement Codex catalog. Only the explicit allowlist can reach
 * the output, so retired, internal-only, and non-OpenAI records stay excluded.
 */
function buildKobashiModelCatalog(bundledCatalog) {
  let sourceModels = [];
  try {
    sourceModels = parseCatalog(bundledCatalog).models;
  } catch {
    // A small valid catalog is safer than leaving a stale or partially written
    // catalog active when the installed Codex binary cannot be queried.
  }

  const bySlug = new Map(
    sourceModels
      .filter(record => record && typeof record.slug === "string")
      .map(record => [record.slug, record]),
  );

  const models = MODEL_SPECS.map((spec, index) => {
    const priority = index + 1;
    const template = findTemplate(spec, bySlug);
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

    // The bundled catalog describes models known to the installed Codex build,
    // not necessarily every effort exposed by the current Copilot endpoint.
    // Keep the picker deterministic even when an older bundle only lists a
    // subset. `ultra` is a Codex UI mode; the proxy safely maps it to the API's
    // highest supported effort before forwarding the request.
    record.default_reasoning_level = spec.defaultEffort;
    record.supported_reasoning_levels = reasoningLevels(
      spec.efforts,
      record.supported_reasoning_levels,
    );

    if (!template.exact) {
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
    const output = (options.execFileSyncImpl || execFileSync)(
      options.codexCommand || "codex",
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
  return buildKobashiModelCatalog(bundledCatalog);
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
  KOBASHI_OPENAI_MODEL_SLUGS,
  buildKobashiModelCatalog,
  createKobashiModelCatalog,
  ensureKobashiModelCatalog,
  getKobashiModelCatalogPath,
  loadBundledCodexModelCatalog,
  writeModelCatalogAtomic,
};
