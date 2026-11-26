"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createGrokDesktopLauncher } = require("../lib/grok-desktop-launcher");

const app = "/Applications/Grok.app";
const root = "/users/Fixture User/.kobashi/grok-desktop";
const agentHome = root + "/agent-home";
const asn = "ASN:0x0-0x22222:";

function fixture(options = {}) {
  const calls = [];
  const state = { active: options.active || "", pid: "123", log: options.log, session: "account-revision-1", prepared: 0 };
  let clock = 0;
  const launcher = createGrokDesktopLauncher({
    platform: options.platform || "darwin", profileRoot: root, appPaths: [app],
    exists: name => !options.missing && [app + "/Contents/Info.plist", app + "/Contents/MacOS/grok-app", root + "/logs"].includes(name),
    ready: () => state.session, realpath: options.realpath, now: () => clock, startupTimeoutMs: 400,
    wait: async ms => { clock += ms; await options.wait?.(state); },
    prepareProfile: async () => {
      state.prepared++;
      await options.prepare?.(state);
      return options.profile || { root, agentHome };
    },
    execute: async (command, args) => {
      calls.push([command, ...args]);
      if (command === "/usr/bin/plutil") return JSON.stringify({
        CFBundleIdentifier: options.identifier || "com.grokapp.desktop", CFBundleExecutable: options.executable || "grok-app",
      });
      if (command === "/usr/bin/lsappinfo") {
        if (args.includes("find")) return state.active;
        if (args[0] === "info") return '"pid"=' + state.pid + '\n"LSBundlePath"=' + JSON.stringify(options.runningApp || app);
      }
      if (command === "/usr/bin/osascript") return options.activation || "activated\n";
      if (command === "/usr/sbin/lsof") {
        const record = state.log ?? ("p" + state.pid + "\nf3\naw\nn" + root + "/logs/app.log.2026-11-26\n");
        if (options.lsofStatus) throw Object.assign(new Error("fixture diagnostics"), { code: options.lsofStatus, stdout: record });
        return record;
      }
      if (command === "/usr/bin/open") {
        if (options.openFails) throw new Error("private OS error");
        if (!options.delayed) state.active = asn;
        return "";
      }
      throw Error("Unexpected command " + command);
    },
  });
  return { launcher, state, calls, opens: () => calls.filter(([cmd]) => cmd === "/usr/bin/open"),
    focus: () => calls.filter(([cmd]) => cmd === "/usr/bin/osascript") };
}

test("launch scopes both Grok homes to the installed app and focuses only the log-verified instance", async () => {
  const f = fixture({ lsofStatus: 1 });
  assert.deepEqual(await f.launcher.open(), { state: "opened" });
  assert.deepEqual(f.opens(), [["/usr/bin/open", "-g", "--env", "GROK_APP_HOME=" + root, "--env", "GROK_HOME=" + agentHome, app]]);
  assert.equal(f.focus().length, 1);
  assert.deepEqual(f.focus()[0].slice(-2), ["123", "com.grokapp.desktop"]);
  assert.match(f.focus()[0][4], /NSRunningApplication\.runningApplicationWithProcessIdentifier/);
  assert.ok(f.calls.some(([cmd, ...args]) => cmd === "/usr/sbin/lsof" && args.includes("123") && args.includes(root + "/logs")));
  assert.deepEqual(await f.launcher.open(), { state: "already_running" });
  assert.equal(f.state.prepared, 1);
  assert.equal(f.opens().length, 1);
  assert.equal(f.focus().length, 2);
  f.state.pid = "2408";
  await assert.rejects(f.launcher.open(), { code: "grok_other_profile_running" });
  assert.equal(f.focus().length, 2);
});

test("an already-running ordinary, unknown or older private profile is left alone", async () => {
  for (const opts of [{ active: asn }, { active: asn, runningApp: "/Volumes/Grok/Grok.app" },
    { active: asn + "\nASN:0x0-0x33333:" }]) {
    const f = fixture(opts);
    await assert.rejects(f.launcher.open(), { code: "grok_other_profile_running" });
    assert.equal(f.state.prepared, 0);
    assert.equal(f.opens().length + f.focus().length, 0);
  }
  const race = fixture({ prepare: state => { state.active = asn; } });
  await assert.rejects(race.launcher.open(), { code: "grok_other_profile_running" });
  assert.equal(race.opens().length + race.focus().length, 0);
});

test("LaunchServices and lsof path aliases resolve to the verified bundle and log directory", async () => {
  const f = fixture({
    runningApp: "/mirror" + app,
    log: "p123\nf3\naw\nn/mirror" + root + "/logs/app.log.2026-11-26",
    realpath: filename => filename.replace(/^\/mirror/, ""),
  });
  assert.deepEqual(await f.launcher.open(), { state: "opened" });
  assert.equal(f.focus().length, 1);
});

test("missing or unrelated read-only log records cannot validate a private launch", async () => {
  for (const log of ["", "p321\nf3\naw\nn" + root + "/logs/app.log.2026-11-26",
    "p123\nf3\nar\nn" + root + "/logs/app.log.2026-11-26",
    "p123\nf3\naw\nn/regular/logs/app.log.2026-11-26",
    "p123\nf3\naw\nn" + root + "/logs/unrelated.txt"]) {
    const f = fixture({ log });
    await assert.rejects(f.launcher.open(), { code: "grok_other_profile_running" });
    assert.equal(f.focus().length, 0);
  }
  const delayed = fixture({ delayed: true });
  await assert.rejects(delayed.launcher.open(), { code: "launch_pending" });
});

test("pending duplicate clicks share the launch, and account or switch changes revoke pending work", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ delayed: true, wait: async state => { await gate; state.active = asn; } });
  const one = f.launcher.open();
  assert.equal(one, f.launcher.open());
  await new Promise(setImmediate);
  assert.equal(f.opens().length, 1);
  release();
  assert.deepEqual(await one, { state: "opened" });
  const changed = fixture({ prepare: state => { state.session = "new-revision"; } });
  await assert.rejects(changed.launcher.open(), { code: "bridge_not_ready" });
  assert.equal(changed.opens().length + changed.focus().length, 0);
  const afterOpen = fixture({ delayed: true, wait: state => { state.session = null; state.active = asn; } });
  await assert.rejects(afterOpen.launcher.open(), { code: "bridge_not_ready" });
  assert.equal(afterOpen.focus().length, 0);
});

test("invalid packages, platform and preparation errors never spawn Grok", async () => {
  for (const [opts, code] of [
    [{ platform: "win32" }, "unsupported_platform"], [{ missing: true }, "desktop_not_found"],
    [{ identifier: "com.other.grok" }, "desktop_not_found"], [{ executable: "../other" }, "desktop_not_found"],
    [{ profile: { root, agentHome: "/users/test/.grok" } }, "profile_conflict"],
    [{ prepare: () => { throw Object.assign(new Error("private cause"), { code: "catalog_unavailable" }); } }, "catalog_unavailable"],
    [{ prepare: () => { throw new Error("private cause"); } }, "launch_failed"],
  ]) {
    const f = fixture(opts);
    await assert.rejects(f.launcher.open(), { code, message: code });
    assert.equal(f.opens().length + f.focus().length, 0);
  }
  const failed = fixture({ openFails: true });
  await assert.rejects(failed.launcher.open(), { code: "launch_failed", message: "launch_failed" });
  const unfocused = fixture({ activation: "refused" });
  await assert.rejects(unfocused.launcher.open(), { code: "launch_failed" });
  await assert.rejects(unfocused.launcher.open(), { code: "launch_failed" });
  assert.equal(unfocused.opens().length, 1);
});
