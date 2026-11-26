#!/usr/bin/env node
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { parseArgs } = require("node:util");
const { GROK_BASE_URL, grokGatewayKeyPath } = require("../lib/grok-local");
const { desktopProviders, prepareDesktopProfile } = require("../lib/grok-desktop");

const usage = [
  "node scripts/grok-desktop.js [--copy-key] [--prepare <new-directory>]",
  "  Show native Grok App provider settings from the connected Copilot account.",
  "  --copy-key   Copy Kobashi's local gateway key to the macOS clipboard.",
  "  --prepare    Create a new, private Grok App profile and Grok Build config.",
].join("\n");

function shellQuote(text) {
  return "'" + text.replaceAll("'", "'\\''") + "'";
}

async function main() {
  const { values } = parseArgs({ options: {
    help: { type: "boolean", short: "h" }, "copy-key": { type: "boolean" }, prepare: { type: "string" },
  } });
  if (values.help) return console.log(usage);
  if (values["copy-key"] && process.platform !== "darwin") throw new Error("--copy-key requires macOS.");
  if (values.prepare !== undefined && !values.prepare.trim()) throw new Error("--prepare needs a new directory name.");
  const keyPath = grokGatewayKeyPath();
  let key;
  try { key = fs.readFileSync(keyPath, "utf8").trim(); } catch (err) {
    if (err.code !== "ENOENT") throw err;
    throw new Error("Start the Grok gateway with a connected Copilot account first. Missing key at " + keyPath);
  }
  if (!key) throw new Error("Empty Grok gateway key at " + keyPath);
  let result;
  try {
    result = await fetch(GROK_BASE_URL + "/models", {
      headers: { Authorization: "Bearer " + key }, redirect: "error", signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new Error("Cannot reach the local Grok gateway at " + GROK_BASE_URL + ". Start Kobashi's Grok gateway first.");
  }
  if (!result.ok) throw new Error("Grok gateway model discovery returned HTTP " + result.status + ". Check Kobashi's Copilot connection.");
  const providers = desktopProviders(await result.json());
  if (values.prepare) {
    const profile = prepareDesktopProfile(values.prepare, providers, GROK_BASE_URL, key);
    console.log("Prepared private Grok App profile at " + profile.root);
    if (process.platform === "darwin") {
      console.log("After quitting Grok App, launch this profile with");
      // The App sets GROK_HOME for ACP chat, while its background title CLI
      // inherits the parent environment. Both must point into this profile.
      console.log("  GROK_APP_HOME=" + shellQuote(profile.root) + " GROK_HOME=" + shellQuote(profile.agentHome) +
        " /Applications/Grok.app/Contents/MacOS/grok-app");
    }
    console.log("Grok Build CLI on macOS or Linux");
    console.log('  GROK_HOME=' + shellQuote(profile.agentHome) + ' "$HOME/.grok/bin/grok" -m ' + providers[0].id);
    console.log();
  }
  if (!values.prepare) {
    console.log("Grok App → Settings → Account → Custom providers → Add provider → Custom");
    console.log("Base URL  " + GROK_BASE_URL);
    console.log("API key   Local gateway key at " + keyPath);
    console.log("Mode      Generic OpenAI-compatible relay");
  }
  for (const provider of providers) {
    console.log("\n" + provider.name);
    console.log("  Provider ID   " + provider.id);
    console.log("  API backend   " + provider.backend);
    console.log("  Active model  " + provider.models[0].id);
    for (const model of provider.models) {
      const details = [model.id];
      if (model.contextWindow) details.push(model.contextWindow + " context tokens");
      if (typeof model.supportsVision === "boolean") details.push(model.supportsVision ? "vision" : "text only");
      if (model.efforts) details.push("efforts " + model.efforts.map(level => level.id).join(", "));
      console.log("  Model         " + details.join(" · "));
    }
  }
  if (!values.prepare) {
    console.log("\nSave and choose Use. In Account → Extras, turn off Inject official tools.");
    console.log("To route background chat titles and auxiliary tasks through Kobashi too, use --prepare and its launch command.");
  }
  console.log("To update an existing provider's catalog, use Fetch models in its Grok App settings and save the current IDs.");
  if (values["copy-key"]) {
    execFileSync("/usr/bin/pbcopy", { input: key, stdio: ["pipe", "ignore", "ignore"] });
    console.log("Copied the local gateway key to the clipboard.");
  }
}

main().catch(err => {
  console.error(err.message);
  process.exitCode = 1;
});
