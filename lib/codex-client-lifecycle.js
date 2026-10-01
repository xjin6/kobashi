const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

// Read-only process metadata. The lightweight local watcher never calls an LLM.
// Keep parents for ancestry, but include command lines only for Codex clients.
const WINDOWS_PROCESS_QUERY = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$rows = @(Get-CimInstance Win32_Process | ForEach-Object {
  if ($_.Name -match '^(Codex|ChatGPT)(\\.exe)?$') {
    [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId;
      startedAt = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' });
      executable = $_.ExecutablePath; name = $_.Name; commandLine = $_.CommandLine }
  } else { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId } }
})
ConvertTo-Json -InputObject $rows -Depth 3 -Compress
`;

function basename(value) { return String(value || "").split(/[\\/]/).at(-1).toLowerCase(); }
function isMacDesktop(executable) {
  return /\/(?:ChatGPT|Codex)\.app\/Contents\/MacOS\/[^/]+$/i.test(executable || "");
}
function isCodexExecutable(process) {
  return ["codex", "codex.exe", "chatgpt", "chatgpt.exe"].includes(basename(process.executable || process.name));
}

function commandArguments(process) {
  const line = String(process.commandLine || "").trim();
  let rest;
  if (line.startsWith('"')) rest = line.slice(line.indexOf('"', 1) + 1);
  else if (process.executable && line.startsWith(process.executable)) rest = line.slice(process.executable.length);
  else rest = line.replace(/^\S+/, "");
  return (rest.match(/"[^"]*"|'[^']*'|\S+/g) || []).map(arg => arg.replace(/^['"]|['"]$/g, ""));
}

function isClient(process) {
  if (!process.startedAt || !isCodexExecutable(process)) return false;
  if (!process.commandLine) return isMacDesktop(process.executable);
  const args = commandArguments(process);
  if (args.some(arg => /^--type(?:=|$)/.test(arg)) || args.some(arg => ["--version", "--help", "-V", "-h"].includes(arg))) return false;
  if (isMacDesktop(process.executable)) return true;
  const valueOptions = new Set(["-c", "--config", "-m", "--model", "-p", "--profile", "-s", "--sandbox",
    "-a", "--ask-for-approval", "-C", "--cd", "--add-dir", "-i", "--image", "--enable", "--disable"]);
  let command = null;
  for (let index = 0; index < args.length; index++) {
    if (valueOptions.has(args[index])) { index++; continue; }
    if (args[index].startsWith("-")) continue;
    command = args[index]; break;
  }
  if (command === "app-server") return !args.some(arg => ["generate-ts", "generate-json-schema"].includes(arg));
  // Never mistake our own bundled-catalog query, automation jobs, or Codex's
  // subprocess tools for a fresh interactive client. That would loop probes.
  return !["debug", "exec", "e", "review", "login", "logout", "mcp", "mcp-server", "features",
    "completion", "completions", "apply", "cloud", "responses-api-proxy"].includes(command);
}

function selectCodexClients(processes) {
  const byPid = new Map(processes.map(process => [Number(process.pid), process]));
  const candidates = new Map(processes.filter(isClient).map(process => [Number(process.pid), process]));
  const groups = new Map();
  for (const process of candidates.values()) {
    let parent = Number(process.ppid), rootPid = Number(process.pid);
    const seen = new Set([rootPid]);
    while (parent && !seen.has(parent)) {
      if (candidates.has(parent)) rootPid = parent;
      seen.add(parent); parent = Number(byPid.get(parent)?.ppid);
    }
    if (!groups.has(rootPid)) groups.set(rootPid, []);
    groups.get(rootPid).push(`${process.pid}:${process.startedAt}`);
  }
  return [...groups].map(([pid, processKeys]) => {
    const process = candidates.get(pid);
    return { pid, startedAt: process.startedAt, key: `${pid}:${process.startedAt}`, processKeys };
  }).sort((a, b) => a.pid - b.pid);
}

async function readCodexClients({ platform = process.platform, execFileImpl = execFileAsync, env = process.env } = {}) {
  const options = { encoding: "utf8", windowsHide: true, timeout: 4000, maxBuffer: 4 * 1024 * 1024 };
  if (platform === "win32") {
    const { stdout } = await execFileImpl("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESS_QUERY], { ...options, timeout: 8000 });
    const rows = JSON.parse(String(stdout).replace(/^\uFEFF/, ""));
    if (!Array.isArray(rows)) throw new Error("Invalid Windows process snapshot");
    return selectCodexClients(rows);
  }
  if (platform !== "darwin" && platform !== "linux") return [];
  const { stdout } = await execFileImpl("ps", ["-axo", "pid=,ppid=,lstart=,comm="], { ...options, env: { ...env, LC_ALL: "C" } });
  const rows = String(stdout).split(/\r?\n/).flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.+)$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), startedAt: match[3], executable: match[4] }] : [];
  });
  const ids = rows.filter(row => isCodexExecutable(row) && !isMacDesktop(row.executable)).map(row => row.pid);
  if (ids.length) {
    let commands = "";
    try {
      commands = (await execFileImpl("ps", ["-p", ids.join(","), "-o", "pid=,args="], options)).stdout;
    } catch (error) {
      // A short-lived debug query can disappear between snapshots. ps may still
      // return other rows with exit 1; real command failures remain errors.
      if (error.code !== 1) throw error;
      commands = error.stdout || "";
    }
    const byPid = new Map(rows.map(row => [row.pid, row]));
    for (const line of String(commands).split(/\r?\n/)) {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (match && byPid.has(Number(match[1]))) byPid.get(Number(match[1])).commandLine = match[2];
    }
  }
  return selectCodexClients(rows);
}

class CodexClientLifecycle {
  constructor({ readClients = readCodexClients, onStart = () => {}, onStop = () => {},
    onError = () => {}, intervalMs = 5000 } = {}) {
    Object.assign(this, { readClients, onStart, onStop, onError, intervalMs });
    this.previous = null;
    this.timer = null;
    this.pending = null;
    this.generation = 0;
  }
  start() {
    if (this.timer) return this.pending || Promise.resolve();
    this.timer = setInterval(() => { this.poll(); }, this.intervalMs);
    this.timer.unref?.();
    return this.poll();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null; this.previous = null; this.generation++;
  }
  poll() {
    if (this.pending) return this.pending;
    const generation = this.generation;
    const pending = (async () => {
      try {
        const clients = await this.readClients();
        if (generation !== this.generation) return;
        const keys = new Set(clients.map(client => client.key));
        const initial = this.previous === null;
        const started = clients.filter(client => !this.previous?.has(client.key));
        const stopped = this.previous?.size > 0 && keys.size === 0;
        // Remember descendants too: a server briefly outliving its GUI parent
        // during shutdown is not a newly launched client.
        this.previous = new Set(clients.flatMap(client => client.processKeys || [client.key]));
        if (started.length) Promise.resolve(this.onStart({ initial, clients: started })).catch(error => this.onError(error));
        else if (stopped) Promise.resolve(this.onStop()).catch(error => this.onError(error));
      } catch (error) {
        // Failed inspection is not evidence that Codex quit and restarted.
        try { this.onError(error); } catch {}
      }
    })().finally(() => { if (this.pending === pending) this.pending = null; });
    this.pending = pending;
    return pending;
  }
}

module.exports = { CodexClientLifecycle, readCodexClients, selectCodexClients };
