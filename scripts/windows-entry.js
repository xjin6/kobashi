"use strict";

// Diagnostic entry points never load index.js, bind bridge ports, or read a
// real account. The build selects this entry only in its disposable source copy.
if (process.argv.includes("--version")) {
  console.log(require("../package.json").version);
} else if (process.argv.includes("--self-test")) {
  const assert = require("node:assert/strict");
  const fs = require("node:fs");
  const path = require("node:path");
  const crypto = require("node:crypto");
  const { injectCodexConfig } = require("../lib/codex-config");
  const { migrateNativeAuth } = require("../lib/codex-native-auth");
  const { createCodexDesktopLauncher } = require("../lib/codex-desktop-launcher");
  const manifest = require("../package.json");
  const assetHashes = {};
  for (const name of ["ui.html", "kobashi.svg", "kobashi-icon.ico", "codex.png"]) {
    const data = fs.readFileSync(path.join(__dirname, "..", "assets", name));
    assetHashes[name] = crypto.createHash("sha256").update(data).digest("hex");
  }
  const html = fs.readFileSync(path.join(__dirname, "..", "assets", "ui.html"), "utf8");
  assert.ok(html.includes('id="codex-launch"') && html.includes("openCodexDesktop()"));
  const native = injectCodexConfig('cli_auth_credentials_store = "keyring"\n', 18921, { chatgptAuth: true });
  assert.ok(native.includes('model_provider = "kobashi"') && native.includes("requires_openai_auth = true"));
  assert.ok(!/env_key|experimental_bearer_token/.test(native));
  assert.ok(native.includes('cli_auth_credentials_store = "keyring"'));
  const authPath = "fixture-auth.json";
  const account = JSON.stringify({ tokens: { access_token: "fixture-access", id_token: "fixture-id", refresh_token: "fixture-refresh" } });
  const files = new Map([[authPath, JSON.stringify({ OPENAI_API_KEY: "PROXY_MANAGED" })], [authPath + ".bak", account]]);
  assert.equal(migrateNativeAuth({ authPath, fs: { readFileSync: file => files.get(file) },
    writeTextAtomic: (file, value, mode) => { assert.equal(mode, 0o600); files.set(file, value); } }), "restore");
  assert.equal(files.get(authPath), account);
  assert.equal(files.get(authPath + ".bak"), account);
  assert.equal(createCodexDesktopLauncher().supported, true);
  console.log(JSON.stringify({ ok: true, version: manifest.version, platform: process.platform,
    architecture: process.arch, windowsNativeAccountAuth: true, legacyAuthMigration: true,
    desktopLaunchSupported: true, assetHashes }));
} else {
  require("../index.js");
}
