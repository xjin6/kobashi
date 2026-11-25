"use strict";

function authObject(source) {
  try {
    const value = JSON.parse(String(source));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

// Only this exact one-field file was written by the legacy bridge. A file
// containing tokens, another key, or even extra metadata belongs to its owner.
function isLegacyProxyAuth(source) {
  const value = authObject(source);
  return !!value && Object.keys(value).length === 1 && value.OPENAI_API_KEY === "PROXY_MANAGED";
}

function isNativeAccountAuth(source) {
  const value = authObject(source);
  if (!value || value.auth_mode !== undefined && value.auth_mode !== "chatgpt" ||
      value.OPENAI_API_KEY !== undefined && value.OPENAI_API_KEY !== null && value.OPENAI_API_KEY !== "") return false;
  const tokens = value.tokens;
  // Validate the persisted native shape, never print credentials or infer that
  // locally present tokens are still valid. The official app handles refresh.
  return !!tokens && typeof tokens === "object" && !Array.isArray(tokens) &&
    ["access_token", "id_token", "refresh_token"].every(key =>
      typeof tokens[key] === "string" && tokens[key].trim().length > 0);
}

function planNativeAuthMigration(liveSource, backupSource) {
  if (!isLegacyProxyAuth(liveSource)) return { action: "none" };
  if (isNativeAccountAuth(backupSource)) return { action: "restore", contents: String(backupSource) };
  return { action: "remove" };
}

function migrateNativeAuth({ authPath, fs = require("node:fs"), writeTextAtomic }) {
  function read(file) {
    try { return fs.readFileSync(file, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
  }
  const liveSource = read(authPath);
  if (!isLegacyProxyAuth(liveSource)) return "none";
  const plan = planNativeAuthMigration(liveSource, read(authPath + ".bak"));
  // A new login or logout wins over our earlier snapshot. Everything below is
  // synchronous, and the backup is kept for recovery in both migration paths.
  if (read(authPath) !== liveSource) return "none";
  if (plan.action === "restore") writeTextAtomic(authPath, plan.contents, 0o600);
  else if (plan.action === "remove") fs.unlinkSync(authPath);
  return plan.action;
}

module.exports = { isLegacyProxyAuth, isNativeAccountAuth, planNativeAuthMigration, migrateNativeAuth };
