"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { createCodexDesktopLauncher } = require("../lib/codex-desktop-launcher");
const { WINDOWS_DISCOVERY, WINDOWS_PROCESSES, WINDOWS_ACTIVATE } = require("../lib/codex-windows-launcher");

const store = { executable: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.11_x64__publisher\\app\\ChatGPT.exe",
  appId: "OpenAI.Codex_publisher!App" };
const installed = "C:\\Users\\测试 user\\AppData\\Local\\Programs\\OpenAI\\Codex\\Codex.exe";
function fixture(options = {}) {
  const calls = [];
  const env = { LOCALAPPDATA: "C:\\Users\\测试 user\\AppData\\Local", OPENAI_API_KEY: "test-placeholder",
    CODEX_CLI_PATH: "old-cli", CODEX_APP_SERVER_WS_URL: "old-server" };
  const files = new Set(options.files || [store.executable]);
  let rows = options.before || [], clock = 0;
  const launcher = createCodexDesktopLauncher({ platform: "win32", userHome: "C:\\Users\\测试 user",
    codexHome: "C:\\Users\\测试 user\\custom codex", env, nativeAccount: () => options.native === true,
    exists: file => files.has(file), now: () => clock, startupTimeoutMs: 400,
    wait: async ms => { clock += ms; },
    execute: async (command, args, execOptions) => {
      assert.equal(command, "powershell.exe");
      assert.deepEqual(args.slice(0, -1), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
      assert.equal(execOptions.windowsHide, true);
      assert.ok(execOptions.timeout <= 10000);
      const script = args.at(-1);
      calls.push({ script, options: execOptions });
      if (script === WINDOWS_DISCOVERY) return { stdout: '\uFEFF' + JSON.stringify(options.store ?? [store]) };
      if (script === WINDOWS_PROCESSES) return { stdout: JSON.stringify(rows) };
      assert.equal(script, WINDOWS_ACTIVATE);
      await options.gate;
      if (options.launchError) throw new Error("private launch details");
      const target = JSON.parse(execOptions.env.KOBASHI_CODEX_LAUNCH_TARGET);
      rows = options.after ?? [{ pid: 200, executable: target.executable }];
      return { stdout: "" };
    },
  });
  return { launcher, calls, env, activation: () => calls.find(call => call.script === WINDOWS_ACTIVATE) };
}

test("Windows icon support launches the registered Store desktop, never the PATH CLI", async () => {
  const f = fixture();
  assert.equal(f.launcher.supported, true);
  assert.deepEqual(await f.launcher.open(), { state: "opened" });
  assert.deepEqual(JSON.parse(f.activation().options.env.KOBASHI_CODEX_LAUNCH_TARGET), { ...store, pid: null });
  assert.equal(f.env.KOBASHI_CODEX_LAUNCH_TARGET, undefined);
});

test("Windows activates the existing desktop and coalesces duplicate clicks", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const rows = [{ pid: 42, executable: store.executable.toLowerCase() }];
  const f = fixture({ before: rows, after: rows, gate });
  const first = f.launcher.open(), second = f.launcher.open();
  assert.equal(first, second);
  await new Promise(setImmediate);
  assert.equal(f.calls.filter(call => call.script === WINDOWS_ACTIVATE).length, 1);
  release();
  assert.deepEqual(await first, { state: "already_running" });
  assert.equal(JSON.parse(f.activation().options.env.KOBASHI_CODEX_LAUNCH_TARGET).pid, 42);
});

test("standalone Windows installs receive scoped configuration and native auth opt-in", async () => {
  const f = fixture({ store: [], files: [installed], native: true });
  assert.deepEqual(await f.launcher.open(), { state: "opened" });
  const env = f.activation().options.env;
  assert.equal(JSON.parse(env.KOBASHI_CODEX_LAUNCH_TARGET).executable, installed);
  assert.equal(env.CODEX_HOME, "C:\\Users\\测试 user\\custom codex");
  assert.equal(env.OPENAI_API_KEY, "");
  assert.equal(env.OPENAI_BASE_URL, "");
  assert.equal(env.CODEX_CLI_PATH, "");
  assert.equal(env.CODEX_APP_SERVER_WS_URL, "");
  assert.equal(env.NO_PROXY, "127.0.0.1,localhost");
  assert.equal(f.env.OPENAI_API_KEY, "test-placeholder");
});

test("an already-running standalone desktop is preferred to another installed Store copy", async () => {
  const rows = [{ pid: 84, executable: installed }];
  const f = fixture({ files: [store.executable, installed], before: rows, after: rows });
  assert.deepEqual(await f.launcher.open(), { state: "already_running" });
  const env = f.activation().options.env;
  assert.equal(env.OPENAI_API_KEY, "test-placeholder");
  assert.deepEqual(JSON.parse(env.KOBASHI_CODEX_LAUNCH_TARGET), { executable: installed, pid: 84 });
});

test("consumer ChatGPT, runtime packages and a CLI-only install do not qualify as the desktop", async () => {
  const f = fixture({ files: [store.executable, installed.replace(/Codex.exe$/, "bin\\codex.exe")], store: [
    { ...store, appId: "OpenAI.ChatGPT_publisher!App" },
    { ...store, appId: "OpenAI.CodexPrimaryRuntime_publisher!App" },
    { ...store, executable: store.executable.replace("ChatGPT.exe", "codex-command-runner.exe") },
  ] });
  await assert.rejects(f.launcher.open(), { code: "desktop_not_found" });
  assert.equal(f.activation(), undefined);
});

test("launch failures are recoverable and a CLI process cannot falsely confirm success", async () => {
  const failed = fixture({ launchError: true });
  await assert.rejects(failed.launcher.open(), { code: "launch_failed" });
  await assert.rejects(failed.launcher.open(), { code: "launch_failed" });
  assert.equal(failed.calls.filter(call => call.script === WINDOWS_ACTIVATE).length, 2);
  const pending = fixture({ after: [{ pid: 300, executable: store.executable.replace("ChatGPT.exe", "resources\\codex.exe") }] });
  await assert.rejects(pending.launcher.open(), { code: "launch_pending" });
  assert.equal(pending.calls.filter(call => call.script === WINDOWS_ACTIVATE).length, 1);
});
