"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createClaudeDesktopLauncher } = require("../lib/claude-desktop-launcher");

const bundle = "com.anthropic.claudefordesktop";
const asn = "ASN:0x0-0x1234:";
function mac(options = {}) {
  const calls = [];
  let running = options.running || "", clock = 0;
  const launcher = createClaudeDesktopLauncher({
    platform: "darwin", now: () => clock, startupTimeoutMs: 400,
    wait: async ms => { clock += ms; if (options.delayed) running = asn; },
    execute: async (file, args, opts) => {
      calls.push([file, args]);
      assert.equal(opts.env, undefined);
      if (file === "/usr/bin/lsappinfo") {
        assert.deepEqual(args, ["-nonames", "find", "-bundleid", bundle]);
        return { stdout: running };
      }
      assert.equal(file, "/usr/bin/open");
      assert.deepEqual(args, ["-b", bundle]);
      if (options.error) throw options.error;
      if (options.gate) await options.gate;
      if (!options.delayed && !options.neverAppears) running = running || asn;
      return { stdout: "" };
    },
  });
  return { launcher, opens: () => calls.filter(([file]) => file === "/usr/bin/open") };
}

test("macOS opens or raises only the registered Claude Desktop bundle with its normal settings", async () => {
  for (const [options, state] of [[{}, "opened"], [{ delayed: true }, "opened"], [{ running: asn }, "already_running"]]) {
    const f = mac(options);
    assert.equal(f.launcher.supported, true);
    assert.deepEqual(await f.launcher.open(), { state });
    assert.equal(f.opens().length, 1);
  }
});

test("overlapping clicks coalesce; a later click can reopen the desktop", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = mac({ gate });
  const first = f.launcher.open();
  assert.equal(first, f.launcher.open());
  await new Promise(setImmediate);
  assert.equal(f.opens().length, 1);
  release();
  assert.deepEqual(await first, { state: "opened" });
  assert.deepEqual(await f.launcher.open(), { state: "already_running" });
  assert.equal(f.opens().length, 2);
});

test("missing, failed, or unconfirmed macOS opens return safe and retryable errors", async () => {
  const missing = Object.assign(new Error("sensitive failure detail"), { stderr: "Unable to find application with bundle identifier " + bundle });
  for (const [options, code] of [[{ error: missing }, "desktop_not_found"], [{ error: new Error("diagnostic") }, "launch_failed"],
    [{ neverAppears: true }, "launch_pending"]]) {
    const f = mac(options);
    await assert.rejects(f.launcher.open(), { code, message: code });
    await assert.rejects(f.launcher.open(), { code, message: code });
    assert.equal(f.opens().length, 2);
  }
});

test("Windows opens the registered Anthropic desktop or its fixed Squirrel location, never the PATH CLI", async () => {
  for (const state of ["opened", "already_running", "desktop_not_found", "launch_pending", "private error details"]) {
    const launcher = createClaudeDesktopLauncher({
      platform: "win32", windowsRoot: "D:\\Windows",
      execute: async (file, args, options) => {
        assert.equal(file, "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
        assert.deepEqual(args.slice(0, -1), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
        assert.equal(options.windowsHide, true);
        assert.equal(options.env, undefined);
        const script = args.at(-1);
        assert.ok(script.includes("PackageFamilyName -eq 'Claude_pzs8sxrjxfjjc'"));
        assert.ok(script.includes("Get-AppxPackageManifest"));
        assert.ok(script.includes("GetFolderPath('LocalApplicationData')) 'AnthropicClaude'"));
        assert.ok(script.includes("GetFileName([string]$app.Executable) -ne 'Claude.exe'"));
        assert.ok(script.includes("Start-Process -FilePath $exe"));
        assert.doesNotMatch(script, /Get-Command|claude:\/\/|Set-ItemProperty|taskkill|Stop-Process/i);
        return { stdout: state + "\r\n" };
      },
    });
    assert.equal(launcher.supported, true);
    if (state === "opened" || state === "already_running") assert.deepEqual(await launcher.open(), { state });
    else await assert.rejects(launcher.open(), { code: state === "private error details" ? "launch_failed" : state });
  }
});

test("unsupported platforms never execute a launch command", async () => {
  const launcher = createClaudeDesktopLauncher({ platform: "linux", execute: () => assert.fail("unexpected command") });
  assert.equal(launcher.supported, false);
  await assert.rejects(launcher.open(), { code: "unsupported_platform" });
});
