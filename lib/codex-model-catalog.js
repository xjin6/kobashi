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
const EMPTY_CATALOG_MODEL_ID = "kobashi-no-available-models";

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
 * Return only account-enabled OpenAI models compatible with Codex's transport.
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
      // A model can appear in Copilot's chat picker without accepting Responses.
      // WebSocket-only support is insufficient: Kobashi forwards HTTP requests.
      if (!Array.isArray(model.supported_endpoints) ||
          !model.supported_endpoints.includes("/responses")) return false;
      if (capabilities.type !== "chat" ||
          capabilities.supports?.streaming !== true ||
          capabilities.supports?.tool_calls !== true) return false;

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
  return null;
}

function liveModelSpec(model, template, exact) {
  const apiEfforts = getCopilotReasoningEfforts(model);
  const templateEfforts = (template?.supported_reasoning_levels || [])
    .map(level => level?.effort)
    .filter(effort => CODEX_REASONING_EFFORT_SET.has(effort));

  // The account's API capabilities determine actual wire-level efforts. A
  // bundled catalog may lag behind a rollout, so it must not hide new efforts.
  const efforts = [...apiEfforts];
  // Ultra is Codex's automatic delegation mode, not an API reasoning effort.
  // The native client maps it to this per-model effort (max by default). Only
  // exact native metadata establishes that a model supports the client mode.
  const ultraEffort = template?.multi_agent_reasoning_effort || "max";
  if (exact && templateEfforts.includes("ultra") && apiEfforts.includes(ultraEffort)) {
    efforts.push("ultra");
  }

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

// Codex requires at least one serialized record, even when no models are
// available. Keep this storage-only sentinel out of the picker and the API;
// callers continue to work with the logical empty catalog.
function catalogForStorage(catalog) {
  if (catalog.models.length) return catalog;
  return { ...catalog, models: [{
    ...fallbackRecord({
      slug: EMPTY_CATALOG_MODEL_ID,
      displayName: "No models available through GitHub Copilot",
      description: "No compatible models are currently available for this account.",
      efforts: [],
      defaultEffort: null,
    }, 1),
    visibility: "hide",
    supported_in_api: false,
  }] };
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
  // Native availability says nothing about Copilot account access. An empty or
  // unavailable account catalog must never create an unverified picker list.
  if (!liveModels.length) return { models: [] };

  const models = liveModels.map((model, index) => {
    const priority = index + 1;
    // During revalidation use the native capability snapshot paired with the
    // successful probe, so a newly declared Ultra mode is not offered early.
    const hasVerifiedNative = Object.hasOwn(model.kobashi_verified || {}, "native");
    const template = hasVerifiedNative
      ? model.kobashi_verified.native
        ? { record: model.kobashi_verified.native, exact: true }
        : findTemplate(model.id, new Map(), sourceModels.filter(record => record?.slug !== model.id))
      : findTemplate(model.id, bySlug, sourceModels);
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
    const constraints = model.kobashi_verified?.constraints || {};
    if (constraints["text.verbosity"] === null) record.support_verbosity = false;
    const summaries = constraints["reasoning.summary"];
    if (summaries === null) record.default_reasoning_summary = "none";
    else if (Array.isArray(summaries) && !summaries.includes(record.default_reasoning_summary)) {
      record.default_reasoning_summary = summaries.includes("auto") ? "auto" : summaries[0];
    }

    if (!template.exact) {
      record.display_name = spec.displayName;
      record.description = spec.description;
    }
    return record;
  });

  return { models };
}

// The desktop app extracts its Windows CLI into a versioned per-user directory.
// Its agent shells add that directory to PATH, but Explorer-launched Kobashi
// does not inherit it. Probe only this known install root, newest binary first.
function windowsCodexCommands(fsImpl, env) {
  const localAppData = env.LOCALAPPDATA ||
    (env.USERPROFILE && path.join(env.USERPROFILE, "AppData", "Local"));
  if (!localAppData) return [];
  const binRoot = path.join(localAppData, "OpenAI", "Codex", "bin");
  const candidates = [path.join(binRoot, "codex.exe")];
  try {
    for (const entry of fsImpl.readdirSync(binRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(path.join(binRoot, entry.name, "codex.exe"));
    }
  } catch {
    // Codex may not be installed, or its files may not be accessible yet.
  }
  return candidates.flatMap(command => {
    try {
      const stat = fsImpl.statSync(command);
      return stat.isFile() ? [{ command, mtime: stat.mtimeMs }] : [];
    } catch {
      return [];
    }
  }).sort((left, right) => right.mtime - left.mtime)
    .map(candidate => candidate.command);
}

function macCodexCommands(env) {
  const roots = [
    "/Applications/ChatGPT.app",
    "/Applications/Codex.app",
    ...(env.HOME ? [
      path.posix.join(env.HOME, "Applications/ChatGPT.app"),
      path.posix.join(env.HOME, "Applications/Codex.app"),
    ] : []),
  ];
  return roots.flatMap(root => [
    path.posix.join(root, "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"),
    path.posix.join(root, "Contents/Resources/codex"),
  ]);
}

/** Read the installed Codex binary's catalog without loading the user's config. */
function loadBundledCodexModelCatalog(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const env = { ...process.env, ...options.env };
  const platform = options.platform || process.platform;
  const tempRoot = path.resolve(options.tempRoot || os.tmpdir());
  const scratchPrefix = path.join(tempRoot, "kobashi-codex-catalog-");
  const scratchDir = fsImpl.mkdtempSync(scratchPrefix);

  try {
    const explicitCommand = !!options.codexCommand;
    const commands = explicitCommand
      ? [options.codexCommand]
      : [
          // Prefer the desktop app's current native metadata to a separately
          // installed CLI on PATH, which can lag behind desktop model rollouts.
          ...(platform === "darwin" ? macCodexCommands(env) : []),
          ...(platform === "win32" ? windowsCodexCommands(fsImpl, env) : []),
          "codex",
          "/opt/homebrew/bin/codex",
          "/usr/local/bin/codex",
          path.join(env.HOME || "", ".local/bin/codex"),
          path.join(env.HOME || "", ".npm-global/bin/codex"),
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
            env: { ...env, CODEX_HOME: scratchDir },
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

/** Query Codex for metadata, synthesizing records only for verified live models. */
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
  const storageCatalog = catalogForStorage(parseCatalog(catalog));
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
  const contents = `${JSON.stringify(storageCatalog, null, 2)}\n`;

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
  EMPTY_CATALOG_MODEL_ID,
  buildKobashiModelCatalog,
  createKobashiModelCatalog,
  ensureKobashiModelCatalog,
  getCopilotReasoningEfforts,
  getKobashiModelCatalogPath,
  loadBundledCodexModelCatalog,
  selectCopilotOpenAIModels,
  writeModelCatalogAtomic,
};
