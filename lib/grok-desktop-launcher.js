"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const executeFile = promisify(execFile);
const BUNDLE_ID = "com.grokapp.desktop";
const LSAPPINFO = "/usr/bin/lsappinfo";
// NSRunningApplication activates an existing PID without launching a new
// instance or sending Apple events to another application.
const ACTIVATE = `ObjC.import("AppKit");
function run(args) {
  const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(args[0]));
  if (ObjC.unwrap(app.bundleIdentifier) !== args[1] || app.terminated) return "missing";
  return app.activateWithOptions(3) ? "activated" : "refused";
}`;
const GROK_LAUNCH_ERRORS = new Set([
  "unsupported_platform", "desktop_not_found", "grok_other_profile_running", "launch_pending", "launch_failed",
  "bridge_not_ready", "no_grok_models", "profile_conflict", "profile_unavailable", "catalog_unavailable",
]);
function failure(code) { return Object.assign(new Error(code), { code }); }

function createGrokDesktopLauncher({
  platform = process.platform, profileRoot = path.join(os.homedir(), ".kobashi", "grok-desktop"),
  appPaths = ["/Applications/Grok.app", path.join(os.homedir(), "Applications", "Grok.app")],
  prepareProfile, ready = () => true, exists = fs.existsSync, realpath = fs.realpathSync, execute = executeFile,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, startupTimeoutMs = 8000,
} = {}) {
  let pending = null;
  let confirmedInstance = null;
  function samePath(actual, expected) {
    if (!actual) return false;
    if (actual === expected) return true;
    // LaunchServices and lsof may report different aliases of the same path
    // (for example /tmp and /private/tmp).
    try { return realpath(actual) === realpath(expected); } catch { return false; }
  }
  async function run(command, args) {
    const result = await execute(command, args, { encoding: "utf8", timeout: 3500, maxBuffer: 128 * 1024 });
    return typeof result === "string" ? result : result.stdout || "";
  }
  async function findApp() {
    for (const app of appPaths) {
      const plist = path.join(app, "Contents", "Info.plist");
      if (!exists(plist) || !exists(path.join(app, "Contents", "MacOS", "grok-app"))) continue;
      try {
        const info = JSON.parse(await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist]));
        if (info.CFBundleIdentifier === BUNDLE_ID && info.CFBundleExecutable === "grok-app") return app;
      } catch { /* Try the user's Applications directory as well. */ }
    }
    throw failure("desktop_not_found");
  }
  async function currentInstance(app) {
    // An ASN identifies a specific LaunchServices registration even if a PID
    // is later reused. This lookup also finds copies launched from another path.
    const asn = (await run(LSAPPINFO, ["-nonames", "find", "-bundleid", BUNDLE_ID])).trim();
    if (!asn) return null;
    if (!/^ASN:0x[\da-f]+-0x[\da-f]+:$/i.test(asn)) throw failure("grok_other_profile_running");
    const info = await run(LSAPPINFO, ["info", "-only", "pid", "-only", "bundlepath", asn]);
    const pid = /^"pid"=(\d+)$/m.exec(info)?.[1];
    const reportedPath = /^"LSBundlePath"=(.*)$/m.exec(info)?.[1];
    let bundlePath;
    try { bundlePath = JSON.parse(reportedPath); } catch { /* incomplete registration */ }
    if (!pid || typeof bundlePath !== "string" || !samePath(bundlePath, app)) {
      throw failure("grok_other_profile_running");
    }
    return { asn, pid };
  }
  async function ownsProfileLog(instance) {
    const logs = path.join(profileRoot, "logs");
    if (!exists(logs)) return false;
    let output;
    try {
      output = await run("/usr/sbin/lsof", ["-nP", "-a", "-p", instance.pid, "-F", "pfan", "+d", logs]);
    } catch (error) {
      // macOS lsof may return 1 for other non-open files in +d even when it
      // emitted a valid matching file. Never inspect log contents or process env.
      if (error.code !== 1 || !error.stdout) return false;
      output = String(error.stdout);
    }
    let matchingPid = false, writable = false;
    for (const field of output.split(/\r?\n/)) {
      if (field.startsWith("p")) matchingPid = field === "p" + instance.pid;
      else if (field.startsWith("f")) writable = false;
      else if (field.startsWith("a")) writable = field === "aw" || field === "au";
      else if (matchingPid && writable && field.startsWith("n")) {
        const name = field.slice(1);
        if (/^app\.log\.\d{4}-\d{2}-\d{2}$/.test(path.basename(name)) && samePath(path.dirname(name), logs)) return true;
      }
    }
    return false;
  }
  async function launch() {
    if (platform !== "darwin") throw failure("unsupported_platform");
    const session = ready();
    function checkReady() {
      if (!session || ready() !== session) throw failure("bridge_not_ready");
    }
    checkReady();
    const app = await findApp();
    async function focus(instance, state) {
      checkReady();
      // lsappinfo setfront can exit 0 with "ERROR #-54 permErr" while leaving
      // another app in front. AppKit returns an explicit activation result.
      const result = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", ACTIVATE, instance.pid, BUNDLE_ID]);
      if (result.trim() !== "activated") throw failure("launch_failed");
      checkReady();
      return { state };
    }
    async function focusKnown(instance) {
      if (confirmedInstance?.asn !== instance.asn || confirmedInstance.pid !== instance.pid || !await ownsProfileLog(instance)) {
        throw failure("grok_other_profile_running");
      }
      return focus(instance, "already_running");
    }
    const before = await currentInstance(app);
    if (before) return focusKnown(before);
    confirmedInstance = null;
    checkReady();
    const profile = await prepareProfile();
    if (profile?.root !== profileRoot || profile.agentHome !== path.join(profileRoot, "agent-home")) {
      throw failure("profile_conflict");
    }
    checkReady();
    if (await currentInstance(app)) throw failure("grok_other_profile_running");
    checkReady();
    // Ask for a background launch first; focus only after the App's own rolling
    // logger proves the new instance opened this private profile.
    await run("/usr/bin/open", ["-g", "--env", "GROK_APP_HOME=" + profile.root,
      "--env", "GROK_HOME=" + profile.agentHome, app]);
    const deadline = now() + startupTimeoutMs;
    let instance;
    do {
      checkReady();
      instance = await currentInstance(app);
      if (instance && await ownsProfileLog(instance)) {
        checkReady();
        confirmedInstance = instance;
        return focus(instance, "opened");
      }
      if (now() >= deadline) break;
      await wait(200);
    } while (true);
    throw failure(instance ? "grok_other_profile_running" : "launch_pending");
  }
  return {
    supported: platform === "darwin",
    open() {
      if (!pending) {
        pending = launch().catch(error => {
          throw failure(GROK_LAUNCH_ERRORS.has(error.code) ? error.code : "launch_failed");
        }).finally(() => { pending = null; });
      }
      return pending;
    },
  };
}

module.exports = { createGrokDesktopLauncher, GROK_LAUNCH_ERRORS };
