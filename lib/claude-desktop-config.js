const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");

// Use our own profile ID. A user's existing gateway (including CC Switch) can
// stay registered with all its settings and credentials in its original file.
const PROFILE_ID = "8f96d38e-d52e-4dd8-b154-a063b0d18923";
const PROFILE_KEYS = [
  "inferenceGatewayBaseUrl", "inferenceGatewayAuthScheme", "inferenceGatewayApiKey",
  "inferenceProvider", "modelDiscoveryEnabled", "inferenceModels",
];

function windowsDataDir(base, name) {
  const exact = path.join(base, name);
  if (fs.existsSync(exact) || !fs.existsSync(base)) return exact;
  const names = fs.readdirSync(base, { withFileTypes: true })
    .filter(dir => dir.isDirectory() && dir.name.startsWith("Claude") &&
      dir.name.includes("-3p") === name.includes("-3p"))
    .map(dir => dir.name).sort();
  return names.map(dir => path.join(base, dir))
    .find(dir => fs.existsSync(path.join(dir, "claude_desktop_config.json"))) || exact;
}

function desktopDirs(home, platform, env) {
  if (platform === "win32") {
    const base = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return ["Claude", "Claude-3p"].map(name => windowsDataDir(base, name));
  }
  if (platform !== "darwin" && platform !== "linux") return null;
  const base = platform === "darwin" ? path.join(home, "Library", "Application Support") :
    (path.isAbsolute(env.XDG_CONFIG_HOME || "") ? env.XDG_CONFIG_HOME : path.join(home, ".config"));
  return ["Claude", "Claude-3p"].map(name => path.join(base, name));
}

function readObject(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  let object;
  try { object = JSON.parse(text.replace(/^\uFEFF/, "")); }
  catch { throw new Error(`Invalid JSON in ${file}`); }
  if (!object || typeof object !== "object" || Array.isArray(object)) {
    throw new Error(`Expected a JSON object in ${file}`);
  }
  return object;
}

function writeObject(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600;
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function writeChange(file, before, after, removeIfEmpty = false) {
  if (removeIfEmpty && !Object.keys(after).length) {
    if (before !== null) fs.unlinkSync(file);
  } else if (!isDeepStrictEqual(before, after)) writeObject(file, after);
}

function pick(object, keys) {
  return Object.fromEntries(keys.filter(key => object && Object.hasOwn(object, key)).map(key => [key, object[key]]));
}

function restoreKeys(object, keys, saved) {
  const result = { ...object };
  for (const key of keys) delete result[key];
  return Object.assign(result, saved);
}

function desktopModels(models) {
  const seen = new Set();
  const entries = [];
  for (const { id, name, supports1m, behavesAs, maxEffort } of models) {
    // Desktop rejects the entire list if even one ID is outside its role
    // families. The gateway resolves these same IDs to the Copilot catalog.
    if (!/^(?:anthropic\/)?claude-(sonnet|opus|haiku|fable)-[^\s[\]]+$/i.test(id)) {
      throw new Error(`Invalid Claude Desktop route ID: ${id}`);
    }
    if (seen.has(id)) continue;
    seen.add(id);
    const entry = { name: id };
    if (name) entry.labelOverride = name;
    if (behavesAs && maxEffort) Object.assign(entry, { behavesAs, maxEffort });
    if (supports1m === true) Object.assign(entry, { supports1m: true, prefer1m: true });
    entries.push(entry);
    if (entries.length === 200) break;
  }
  return entries;
}

function createClaudeDesktopConfig({ home = os.homedir(), platform = process.platform, env = process.env } = {}) {
  const journal = path.join(home, ".kobashi", "claude-desktop-state.json");

  function files(dirs) {
    const library = path.join(dirs[1], "configLibrary");
    return {
      configs: dirs.map(dir => path.join(dir, "claude_desktop_config.json")),
      profile: path.join(library, PROFILE_ID + ".json"), meta: path.join(library, "_meta.json"),
    };
  }

  function readMeta(file) {
    const meta = readObject(file);
    if (meta && Object.hasOwn(meta, "entries") && !Array.isArray(meta.entries)) {
      throw new Error(`Expected an entries array in ${file}`);
    }
    return meta;
  }

  function restore() {
    const state = readObject(journal);
    if (!state) return false;
    const target = files(state.dirs);
    const configs = target.configs.map(readObject);
    const meta = readMeta(target.meta);
    const profile = readObject(target.profile);
    if (state.phase !== "restoring") writeObject(journal, { ...state, phase: "restoring" });

    // If another profile was selected while Kobashi ran, leave Desktop in its
    // new mode. Restore the deployment keys before deselecting our profile so
    // cleanup can be retried at any point after an interrupted write.
    if (meta?.appliedId === PROFILE_ID) {
      configs.forEach((config, i) => {
        if (config?.deploymentMode === "3p") {
          const before = state.configs[i];
          writeChange(target.configs[i], config, restoreKeys(config, ["deploymentMode"], before.fields), !before.existed);
        }
      });
    }
    if (meta) {
      let next = { ...meta };
      if (next.appliedId === PROFILE_ID) {
        next = restoreKeys(next, ["appliedId"], state.meta.fields);
        // The user may have deleted their previous profile during this session.
        if (state.meta.priorIdRegistered && !meta.entries?.some(entry => entry?.id === next.appliedId)) {
          const remaining = meta.entries?.find(entry => entry?.id && entry.id !== PROFILE_ID);
          if (remaining) next.appliedId = remaining.id;
          else delete next.appliedId;
        }
      }
      if (next.entries) {
        next.entries = next.entries.flatMap(entry => {
          if (entry?.id !== PROFILE_ID) return [entry];
          if (!state.meta.entry) return [];
          return [entry.name === "Kobashi" ? restoreKeys(entry, ["name"], state.meta.entry) : entry];
        });
        if (!next.entries.length && !state.meta.hadEntries) delete next.entries;
      }
      writeChange(target.meta, meta, next, !state.meta.existed);
    }
    if (profile) {
      writeChange(target.profile, profile, restoreKeys(profile, PROFILE_KEYS, state.profile.fields), !state.profile.existed);
    }
    fs.unlinkSync(journal);
    return true;
  }

  function apply({ baseUrl, token, models, refreshOnly = false }) {
    let state = readObject(journal);
    if (refreshOnly && state?.phase !== "active") return false;
    if (state?.phase === "restoring") { restore(); state = null; }
    const dirs = state?.dirs || desktopDirs(home, platform, env);
    if (!dirs) return false;
    const hasApp = platform === "darwin" && ["/Applications/Claude.app", path.join(home, "Applications", "Claude.app")]
      .some(bundle => fs.existsSync(bundle));
    if (!state && !hasApp && !dirs.some(dir => fs.existsSync(dir))) return false;

    const target = files(dirs);
    const configs = target.configs.map(readObject);
    const meta = readMeta(target.meta);
    const selected = meta?.appliedId === PROFILE_ID && configs.every(config => config?.deploymentMode === "3p");
    if (refreshOnly && !selected) return false;
    if (!refreshOnly && state?.phase === "active" && !selected) {
      // A deliberate activation after an external switch must restore the
      // newly selected profile next time the bridge is turned off.
      restore();
      return apply({ baseUrl, token, models });
    }
    const profile = readObject(target.profile);
    const nextProfile = { ...profile };
    // Desktop can omit default connection settings when saving a profile.
    // Refreshing the model list only needs to update inferenceModels.
    if (!refreshOnly || !profile) Object.assign(nextProfile, {
      inferenceProvider: "gateway", inferenceGatewayAuthScheme: "bearer",
      inferenceGatewayBaseUrl: baseUrl, inferenceGatewayApiKey: token, modelDiscoveryEnabled: true,
    });
    if (models !== undefined) {
      const list = desktopModels(models);
      if (list.length) nextProfile.inferenceModels = list;
      else delete nextProfile.inferenceModels;
    } else if (!state) delete nextProfile.inferenceModels;

    if (refreshOnly) {
      writeChange(target.profile, profile, nextProfile);
      return true;
    }
    const entries = meta?.entries || [];
    const own = entries.find(entry => entry?.id === PROFILE_ID);
    const updatedEntries = own ? entries.map(entry => entry === own ? { ...entry, name: "Kobashi" } : entry)
      : [...entries, { id: PROFILE_ID, name: "Kobashi" }];
    if (!state) {
      state = {
        phase: "applying", dirs,
        configs: configs.map(config => ({ existed: !!config, fields: pick(config, ["deploymentMode"]) })),
        profile: { existed: !!profile, fields: pick(profile, PROFILE_KEYS) },
        meta: { existed: !!meta, hadEntries: !!meta?.entries, fields: pick(meta, ["appliedId"]),
          priorIdRegistered: entries.some(entry => entry?.id && entry.id === meta?.appliedId),
          entry: own ? pick(own, ["name"]) : null },
      };
      // Persist only the fields we own before changing any of Desktop's files.
      writeObject(journal, state);
    }
    try {
      writeChange(target.profile, profile, nextProfile);
      writeChange(target.meta, meta, { ...meta, entries: updatedEntries, appliedId: PROFILE_ID });
      // Switch the normal app last, when the target profile is ready to use.
      for (const i of [1, 0]) {
        writeChange(target.configs[i], configs[i], { ...configs[i], deploymentMode: "3p" });
      }
      if (state.phase !== "active") writeObject(journal, { ...state, phase: "active" });
    } catch (error) {
      if (state.phase === "applying") restore();
      throw error;
    }
    return true;
  }

  return { apply, restore };
}

module.exports = { createClaudeDesktopConfig };
