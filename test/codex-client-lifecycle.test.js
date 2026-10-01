const assert = require("node:assert/strict");
const test = require("node:test");
const { readCodexClients, selectCodexClients, CodexClientLifecycle } = require("../lib/codex-client-lifecycle");

function process(pid, executable, args = "", ppid = 1, startedAt = "start-1") {
  return { pid, ppid, startedAt, executable, commandLine: `"${executable}" ${args}`.trim() };
}
const macApp = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
const macCli = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
const winApp = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0\\app\\Codex.exe";
const winCli = "C:\\Users\\Test\\AppData\\Local\\OpenAI\\Codex\\bin\\1.0\\codex.exe";

test("macOS desktop plus its helpers and app-server count as one client", () => {
  const clients = selectCodexClients([
    process(10, macApp), { pid: 11, ppid: 10 },
    process(12, macCli, "-c features.code_mode_host=true app-server --listen stdio://", 11),
    process(13, macCli, "debug models --bundled"),
    process(14, macCli, 'exec "do work"'),
  ]);
  assert.deepEqual(clients.map(client => client.pid), [10]);
});

test("Windows GUI, renderer and extracted native server count as one client", () => {
  const clients = selectCodexClients([
    process(20, winApp), process(21, winApp, "--type=renderer", 20),
    process(22, winCli, 'app-server --listen stdio://', 21),
    process(23, winCli, "debug models --bundled"),
    process(24, winApp, "--type gpu-process", 20),
  ]);
  assert.deepEqual(clients.map(client => client.pid), [20]);
});

test("independent interactive CLI and editor servers are detected, diagnostic jobs are ignored", () => {
  const clients = selectCodexClients([
    process(1, macCli, "-c model=app-server debug models --bundled", 0),
    process(2, macCli, "app-server generate-json-schema", 0),
    process(3, macCli, "--version", 0),
    process(4, macCli, "--model example", 0),
    process(5, macCli, "app-server --listen stdio://", 0),
    process(6, macCli, 'resume "saved-chat"', 0),
    process(7, "C:\\apps\\kobashi.exe", "", 0),
  ]);
  assert.deepEqual(clients.map(client => client.pid), [4, 5, 6]);
});

test("Windows reader uses hidden read-only PowerShell and handles Unicode paths", async () => {
  const calls = [];
  const clients = await readCodexClients({ platform: "win32", execFileImpl: async (...args) => {
    calls.push(args);
    return { stdout: '\uFEFF' + JSON.stringify([process(30, winApp.replace("Program Files", "应用 程序"))]) };
  } });
  assert.deepEqual(clients.map(client => client.pid), [30]);
  assert.equal(calls[0][0], "powershell.exe");
  assert.ok(calls[0][1].includes("-NoProfile"));
  assert.ok(calls[0][1].includes("-NonInteractive"));
  assert.match(calls[0][1].at(-1), /Get-CimInstance Win32_Process/);
  assert.equal(calls[0][2].windowsHide, true);
  assert.equal(calls[0][2].timeout, 8000);
});

test("macOS reader combines stable start times with command lines, without spawning Codex", async () => {
  const commands = [];
  const clients = await readCodexClients({ platform: "darwin", execFileImpl: async (command, args) => {
    commands.push([command, args]);
    return { stdout: args[0] === "-axo"
      ? ` 40 1 Thu Oct  1 03:38:22 2026 ${macApp}\n 41 40 Thu Oct  1 03:38:23 2026 ${macCli}\n 42 1 Thu Oct  1 03:38:24 2026 ${macCli}\n`
      : `41 ${macCli} app-server\n42 ${macCli} debug models --bundled\n` };
  } });
  assert.deepEqual(clients.map(client => client.pid), [40]);
  assert.equal(clients[0].key, "40:Thu Oct  1 03:38:22 2026");
  assert.ok(commands.every(([name]) => name === "ps"));
});

test("stable process, child launches and window reopening do not repeat startup refresh", async () => {
  let clients = [{ key: "100:start-1", pid: 100 }];
  const starts = [];
  const watcher = new CodexClientLifecycle({ readClients: async () => clients, onStart: event => starts.push(event) });
  await watcher.poll(); await watcher.poll(); await watcher.poll();
  assert.equal(starts.length, 1);
  assert.equal(starts[0].initial, true);
  // A replacement is detected even when quit/relaunch happens between polls.
  clients = [{ key: "101:start-2", pid: 101 }];
  await watcher.poll();
  assert.equal(starts.length, 2);
  assert.equal(starts[1].initial, false);
  // PID recycling must not hide a genuine restart.
  clients = [{ key: "101:start-3", pid: 101 }]; await watcher.poll();
  assert.equal(starts.length, 3);
});

test("startup from idle and complete exit are detected without timed inference", async () => {
  let clients = [], starts = 0, stops = 0;
  const watcher = new CodexClientLifecycle({ readClients: async () => clients,
    onStart: () => starts++, onStop: () => stops++ });
  await watcher.poll(); await watcher.poll(); assert.equal(starts, 0);
  clients = [{ key: "1:start" }]; await watcher.poll(); assert.equal(starts, 1);
  clients = []; await watcher.poll(); await watcher.poll(); assert.equal(stops, 1);
});

test("failed process inspection is not a simulated restart", async () => {
  let fail = false, starts = 0;
  const watcher = new CodexClientLifecycle({ readClients: async () => {
    if (fail) throw new Error("permission denied"); return [{ key: "1:start" }];
  }, onStart: () => starts++ });
  await watcher.poll(); fail = true; await watcher.poll(); fail = false; await watcher.poll();
  assert.equal(starts, 1);
});

test("long refreshes do not block detecting another restart and stopped watchers ignore late snapshots", async () => {
  let clients = [{ key: "1:start" }], starts = 0, release;
  const watcher = new CodexClientLifecycle({ readClients: async () => clients,
    onStart: () => { starts++; return new Promise(resolve => { release = resolve; }); } });
  await watcher.poll(); const firstRelease = release;
  clients = [{ key: "2:start" }]; await watcher.poll();
  assert.equal(starts, 2); firstRelease(); release();
  let finish;
  watcher.readClients = () => new Promise(resolve => { finish = resolve; });
  const pending = watcher.poll(); watcher.stop(); finish([{ key: "3:start" }]); await pending;
  assert.equal(starts, 2);
});

test("a server briefly outliving its desktop parent does not trigger a refresh during quit", async () => {
  let processes = [process(10, macApp), process(11, macCli, "app-server", 10)];
  let starts = 0;
  const watcher = new CodexClientLifecycle({ readClients: async () => selectCodexClients(processes), onStart: () => starts++ });
  await watcher.poll();
  processes = [process(11, macCli, "app-server", 1)]; await watcher.poll();
  assert.equal(starts, 1);
  processes = [process(12, macApp, "", 1, "new-start")]; await watcher.poll();
  assert.equal(starts, 2);
});
