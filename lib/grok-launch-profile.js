const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { scanToml, assignmentStringValue } = require("./codex-config");
const { desktopProviders, prepareDesktopProfile, profileConfig } = require("./grok-desktop");
const { GROK_BASE_URL } = require("./grok-local");

const PARENT_ID = /^kobashi-(?:responses|chat)(?:-fixed)?$/;
const GROK_ID = /^(?:x[.-]?ai\/)?grok(?:[-.][a-z0-9][a-z0-9._-]*)?$/i;
const OPTIONAL_FIELDS = ["context_window", "app_supports_vision", "app_efforts"];
const SLOTS = ["default", "image_description", "web_search", "session_summary", "prompt_suggestion"];

function conflict() {
  return Object.assign(new Error("The existing Grok profile has an unrecognized configuration."), { code: "profile_conflict" });
}

// Index only real TOML tables and assignments. Text inside e.g. multiline
// prompts, nested MCP tables, and comments stays byte-for-byte in place.
function profileTables(source) {
  const { tables, assignments } = scanToml(source);
  const sections = new Map();
  for (const table of tables) {
    if (table.arrayTable) continue;
    const name = table.path.trim();
    const match = /^(?:model|"model"|'model')\s*\.\s*(?:([\w-]+)|"([\w.-]+)"|'([\w.-]+)')$/.exec(name);
    let id = null;
    if (match) id = match[1] || match[2] || match[3];
    else if (/^(?:models|"models"|'models')$/.test(name)) id = "";
    // Native Grok accepts quoted IDs with punctuation and even nested-looking
    // names. Retain these as foreign sections for its custom-provider check.
    else if (/^(?:model|"model"|'model')\s*\./.test(name)) id = name;
    if (id === null) continue;
    if (sections.has(id)) throw conflict();
    const fields = new Map();
    for (const field of assignments.filter(row => row.table === table)) {
      if (fields.has(field.key)) throw conflict();
      fields.set(field.key, field);
    }
    sections.set(id, { table, fields, string(key) {
      const field = fields.get(key);
      return field && assignmentStringValue(source, field);
    } });
  }
  return sections;
}

// allowed_models is the only user-editable array touched by reconciliation.
// Accept TOML string arrays, including multiline/trailing comma/comments.
function allowedModels(raw) {
  const tokens = /\s+|#[^\r\n]*|"(?:\\.|[^"\\])*"|'[^'\r\n]*'|[[\],]/gy;
  const values = [];
  let state = "open", cursor = 0;
  while (cursor < raw.length) {
    const match = tokens.exec(raw);
    if (!match) throw conflict();
    const token = match[0];
    cursor = tokens.lastIndex;
    if (/^\s|^#/.test(token)) continue;
    if (state === "open" && token === "[") state = "value";
    else if ((state === "value" || state === "comma") && token === "]") state = "end";
    else if (state === "comma" && token === ",") state = "value";
    else if (state === "value" && /^["']/.test(token)) {
      try { values.push(token[0] === "'" ? token.slice(1, -1) : JSON.parse(token)); }
      catch { throw conflict(); }
      state = "comma";
    } else throw conflict();
  }
  if (state !== "end") throw conflict();
  return values;
}

function mergeModelRow(row, saved) {
  if (!saved) return row;
  // Retain custom labels, display settings and a previously chosen default
  // effort when that option still exists in the live Copilot directory.
  const { contextWindow, supportsVision, efforts, ...rest } = saved;
  const next = { ...rest, ...row, name: saved.name || row.name };
  if (row.efforts && Array.isArray(efforts)) {
    next.efforts = row.efforts.map(item => ({ ...item, ...efforts.find(e => e?.id === item.id) }));
  }
  return next;
}

function refreshConfig(source, settings, providers, baseUrl, key) {
  const existing = profileTables(source);
  const owned = new Set(), children = new Map();
  const ownedBase = section => [GROK_BASE_URL, baseUrl].includes(section.string("base_url"));
  for (const [id, row] of existing) {
    if (PARENT_ID.test(id) && ownedBase(row) && row.string("app_provider_mode") === "generic" &&
        row.string("api_backend") === (id.startsWith("kobashi-responses") ? "responses" : "chat_completions") &&
        GROK_ID.test(row.string("model") || "") && row.string("app_models")) {
      owned.add(id);
    }
  }
  const routes = existing.get("");
  if (!owned.size || !routes) throw conflict();
  for (const [id, row] of existing) {
    const parentId = row.string("app_parent_provider");
    if (!PARENT_ID.test(parentId || "") || !owned.has(parentId)) continue;
    const model = row.string("model");
    if (!ownedBase(row) || row.string("app_provider_mode") !== "generic" || !GROK_ID.test(model || "") || children.has(model)) throw conflict();
    children.set(model, id);
    owned.add(id);
  }
  // Grok App can automatically union every custom section with a base_url
  // into allowed_models when it synchronizes its generic children. A foreign
  // relay can become selectable even when the current allowlist excludes it.
  for (const [id, section] of existing) {
    if (id && !owned.has(id) && section.fields.has("base_url") && section.string("base_url") !== "") throw conflict();
  }
  const oldDefault = routes.string("default");
  if (!owned.has(oldDefault)) throw conflict();
  const oldDefaultModel = existing.get(oldDefault).string("model");
  // The native default for an omitted officialAuxInject is true.
  if (settings.sessionDataMode !== "independent" || settings.officialAuxInject !== false) throw conflict();
  const currentIds = new Set(providers.flatMap(p => p.models.map(m => m.id)));
  if (settings.modelId && !currentIds.has(settings.modelId) && !owned.has(settings.modelId) &&
      !GROK_ID.test(settings.modelId)) throw conflict();

  for (const provider of providers) {
    const parent = existing.get(provider.id);
    if (parent && !owned.has(provider.id)) throw conflict();
    let previousRows = [];
    if (parent) {
      try { previousRows = JSON.parse(parent.string("app_models")); } catch { throw conflict(); }
      if (!Array.isArray(previousRows)) throw conflict();
      const previousModel = parent.string("model");
      if (provider.models.some(row => row.id === previousModel)) provider.activeModel = previousModel;
    }
    for (const row of provider.models) {
      if (children.has(row.id)) continue;
      // A removed child's old numeric slot must never be reassigned to another
      // model when its owner reopens an old chat. New children get stable IDs.
      const suffix = createHash("sha256").update(row.id).digest("hex").slice(0, 20);
      const id = provider.id + "__kb-" + suffix;
      if (existing.has(id)) throw conflict();
      children.set(row.id, id);
    }
    const previousOrder = new Map(previousRows.map((m, i) => [m?.id, i]));
    provider.models = provider.models.map(row => mergeModelRow(row, previousRows.find(m => m?.id === row.id)))
      .sort((a, b) => (previousOrder.get(a.id) ?? Infinity) - (previousOrder.get(b.id) ?? Infinity));
    if (PARENT_ID.test(oldDefault) && provider.models.some(row => row.id === oldDefaultModel)) provider.activeModel = oldDefaultModel;
  }
  const generated = profileConfig(providers, baseUrl, key, children);
  const desired = profileTables(generated);
  const defaultId = desired.get(oldDefault)?.string("model") === oldDefaultModel ? oldDefault :
    providers.find(p => p.activeModel === oldDefaultModel)?.id || providers[0].id;
  const edits = [];
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const adds = [];
  function setField(section, key, value) {
    const field = section.fields.get(key);
    if (!field) {
      if (value !== undefined) edits.push({ start: section.table.bodyStart, end: section.table.bodyStart,
        text: key + " = " + value + newline });
      return;
    }
    const original = source.slice(field.start, field.end);
    const afterEquals = original.slice(original.indexOf("=") + 1).trim();
    if (value === afterEquals || (value?.startsWith('"') && JSON.stringify(section.string(key)) === value)) return;
    const text = value === undefined ? "" : key + " = " + value + newline;
    edits.push({ start: field.start, end: field.end, text });
  }
  for (const id of owned) {
    if (desired.has(id)) continue;
    const section = existing.get(id);
    const start = section.table.start, end = Math.max(section.table.bodyStart, ...[...section.fields.values()].map(f => f.end));
    edits.push({ start, end, text: "" });
  }
  for (const [id, row] of desired) {
    if (!id) continue;
    const old = existing.get(id);
    if (!old) { adds.push(generated.slice(row.table.start, row.table.end).trimEnd()); continue; }
    if (!owned.has(id)) throw conflict();
    for (const [key, field] of row.fields) {
      if (key === "name" && old.string(key)) continue;
      const line = generated.slice(field.start, field.end);
      setField(old, key, line.slice(line.indexOf("=") + 1).trim());
    }
    for (const key of OPTIONAL_FIELDS) if (!row.fields.has(key)) setField(old, key, undefined);
  }
  const allowed = routes.fields.get("allowed_models");
  if (!allowed) throw conflict();
  const oldList = source.slice(allowed.start, allowed.end);
  const list = allowedModels(oldList.slice(oldList.indexOf("=") + 1));
  if (list.some(id => !owned.has(id))) throw conflict();
  const nextList = [...new Set([...list.filter(id => desired.has(id)), ...[...desired.keys()].filter(Boolean)])];
  if (JSON.stringify(list) !== JSON.stringify(nextList)) setField(routes, "allowed_models", JSON.stringify(nextList));
  for (const slot of SLOTS) {
    const previous = routes.string(slot);
    // Explicit foreign aux routing is a user preference. Opening it as a
    // Copilot-only profile would start side jobs on the wrong service.
    if (previous && !owned.has(previous)) throw conflict();
    if (!previous || !desired.has(previous) || previous === oldDefault && previous !== defaultId) {
      setField(routes, slot, JSON.stringify(defaultId));
    }
  }
  let config = source;
  for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end)) {
    config = config.slice(0, edit.start) + edit.text + config.slice(edit.end);
  }
  if (adds.length) config += (config.endsWith(newline) ? newline : newline + newline) +
    adds.join("\n\n").replace(/\n/g, newline) + newline;
  const fallback = desired.get(defaultId).string("model");
  const chosen = settings.modelId;
  const modelId = currentIds.has(chosen) || (chosen && desired.has(chosen)) ? chosen : fallback;
  return { config, modelId };
}

function checkType(file, directory = false) {
  const stat = fs.lstatSync(file);
  if (!(directory ? stat.isDirectory() : stat.isFile())) throw conflict();
}

function replaceAtomic(file, before, after) {
  if (before === after) return;
  const temp = path.join(path.dirname(file), "." + randomUUID() + ".tmp");
  try {
    fs.writeFileSync(temp, after, { flag: "wx", mode: 0o600 });
    checkType(file);
    if (fs.readFileSync(file, "utf8") !== before) throw conflict();
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
}

function ensureGrokLaunchProfile(directory, catalog, baseUrl, key) {
  const providers = desktopProviders(catalog);
  const root = path.resolve(directory);
  const parent = path.dirname(root);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  try { checkType(root, true); }
  catch (err) {
    if (err.code !== "ENOENT") throw err;
    const stage = fs.mkdtempSync(path.join(parent, ".grok-profile-"));
    try {
      const profile = prepareDesktopProfile(path.join(stage, "profile"), providers, baseUrl, key);
      try {
        fs.renameSync(profile.root, root);
        return { root, agentHome: path.join(root, "agent-home") };
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code) || !fs.existsSync(root)) throw error;
      }
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  }
  const agentHome = path.join(root, "agent-home");
  const configFile = path.join(agentHome, "config.toml"), settingsFile = path.join(root, "settings.json");
  try {
    checkType(root, true); checkType(agentHome, true); checkType(configFile); checkType(settingsFile);
  } catch (e) { if (e.code === "ENOENT" || e.code === "ENOTDIR") throw conflict(); throw e; }
  const oldConfig = fs.readFileSync(configFile, "utf8"), oldSettings = fs.readFileSync(settingsFile, "utf8");
  let settings;
  try { settings = JSON.parse(oldSettings); } catch { throw conflict(); }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw conflict();
  const { config, modelId } = refreshConfig(oldConfig, settings, providers, baseUrl, key);
  replaceAtomic(configFile, oldConfig, config);
  if (modelId !== settings.modelId) {
    try { replaceAtomic(settingsFile, oldSettings, JSON.stringify({ ...settings, modelId }, null, 2) + "\n"); }
    catch (err) { replaceAtomic(configFile, config, oldConfig); throw err; }
  }
  return { root, agentHome };
}

module.exports = { ensureGrokLaunchProfile };
