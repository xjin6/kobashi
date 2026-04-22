const http = require("http");
const https = require("https");
const net = require("net");
const tls = require("tls");
const fs = require("fs");
const path = require("path");
const { execSync, spawn } = require("child_process");

const DEBUG = process.argv.includes("--debug");
const log = (...a) => console.log(...a);
const dbg = (...a) => { if (DEBUG) console.log(...a); };

// ─── Browser detection ─────────────────────────────────────────────────────
function findBrowser() {
  if (process.platform === "darwin") {
    const home = process.env.HOME || "";
    const candidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Arc.app/Contents/MacOS/Arc",
      path.join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
      path.join(home, "Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }
  // Windows
  const candidates = [
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Microsoft\\Edge\\Application\\msedge.exe"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Microsoft\\Edge\\Application\\msedge.exe"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Google\\Chrome\\Application\\chrome.exe"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Google\\Chrome\\Application\\chrome.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google\\Chrome\\Application\\chrome.exe"),
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  for (const cmd of ["msedge", "chrome"]) {
    try { const r = execSync(`where ${cmd}`, { stdio: "pipe", windowsHide: true }).toString().trim().split("\n")[0]; if (r) return r.trim(); } catch {}
  }
  return null;
}

const BROWSER_PATH = findBrowser();

function openAppWindow(url) {
  if (process.platform === "darwin") {
    if (BROWSER_PATH) {
      spawn(BROWSER_PATH, [`--app=${url}`, "--window-size=420,560", "--no-default-browser-check"], {
        detached: true, stdio: "ignore",
      }).unref();
    } else {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } else {
    if (BROWSER_PATH) {
      execSync(`start "" "${BROWSER_PATH}" --app=${url} --window-size=420,560`, { stdio: "ignore", shell: true, windowsHide: true });
    } else {
      execSync(`start "" "${url}"`, { stdio: "ignore", shell: true, windowsHide: true });
    }
  }
}

const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const COPILOT_API = "api.githubcopilot.com";
const PROXY_PORT = 18921;
const UI_PORT = 18922;
const CLAUDE_PORT = 18923;
const CLAUDE_MODEL = "claude-sonnet-4.6";

// ─── System proxy detection ────────────────────────────────────────────────
// Detect OS-level HTTP proxy. If present, route upstream Copilot requests
// through it so users behind VPNs (Clash/Surge in system-proxy mode) work
// without touching global env vars. Only Bridge's own outbound traffic is
// affected — other apps are untouched.
function detectSystemProxy() {
  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (envProxy) {
    try { return new URL(envProxy); } catch {}
  }
  try {
    if (process.platform === "darwin") {
      const out = execSync("scutil --proxy", { stdio: ["ignore", "pipe", "ignore"] }).toString();
      const enabled = /HTTPSEnable\s*:\s*1/.test(out) || /HTTPEnable\s*:\s*1/.test(out);
      if (!enabled) return null;
      const host = (out.match(/HTTPSProxy\s*:\s*([^\s]+)/) || out.match(/HTTPProxy\s*:\s*([^\s]+)/) || [])[1];
      const port = (out.match(/HTTPSPort\s*:\s*(\d+)/) || out.match(/HTTPPort\s*:\s*(\d+)/) || [])[1];
      if (host && port) return new URL(`http://${host}:${port}`);
    } else if (process.platform === "win32") {
      const out = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /v ProxyServer', { stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).toString();
      if (!/ProxyEnable\s+REG_DWORD\s+0x1/.test(out)) return null;
      const server = (out.match(/ProxyServer\s+REG_SZ\s+(\S+)/) || [])[1];
      if (!server) return null;
      const hp = server.includes("=") ? (server.split(";").find(s => s.startsWith("https=") || s.startsWith("http=")) || "").split("=")[1] : server;
      if (hp) return new URL(`http://${hp}`);
    }
  } catch {}
  return null;
}

// Build a CONNECT tunnel through an HTTP proxy, returning a TLS socket to the origin.
function connectViaProxy(proxyUrl, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(proxyUrl.port) || 80, proxyUrl.hostname, () => {
      const auth = proxyUrl.username ? `Proxy-Authorization: Basic ${Buffer.from(decodeURIComponent(proxyUrl.username) + ":" + decodeURIComponent(proxyUrl.password || "")).toString("base64")}\r\n` : "";
      sock.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${auth}\r\n`);
    });
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString();
      if (buf.includes("\r\n\r\n")) {
        sock.removeListener("data", onData);
        if (!/^HTTP\/1\.[01] 200/i.test(buf)) { sock.destroy(); return reject(new Error(`Proxy CONNECT failed: ${buf.split("\r\n")[0]}`)); }
        const tlsSock = tls.connect({ socket: sock, servername: targetHost });
        tlsSock.on("secureConnect", () => resolve(tlsSock));
        tlsSock.on("error", reject);
      }
    };
    sock.on("data", onData);
    sock.on("error", reject);
  });
}

// Issue an HTTPS request, tunneling through the system proxy if one is set.
// Returns a Promise<ClientRequest> because proxy CONNECT is async.
async function upstreamHttpsRequest(options, onResponse) {
  const proxyUrl = detectSystemProxy();
  if (!proxyUrl) {
    return https.request(options, onResponse);
  }
  dbg(`[Bridge] Routing via system proxy ${proxyUrl.hostname}:${proxyUrl.port}`);
  const socket = await connectViaProxy(proxyUrl, options.hostname, 443);
  return https.request({ ...options, createConnection: () => socket }, onResponse);
}

// ─── Assets ────────────────────────────────────────────────────────────────
let SEA = null;
try { const s = require("node:sea"); if (s.isSea()) SEA = s; } catch {}

function getAsset(name) {
  if (SEA) return Buffer.from(SEA.getAsset(name));
  return fs.readFileSync(path.join(__dirname, "assets", name));
}
function getAssetText(name) {
  if (SEA) return SEA.getAsset(name, "utf-8");
  return fs.readFileSync(path.join(__dirname, "assets", name), "utf-8");
}

const HTML = getAssetText("ui.html")
  .replace("{{PROXY_PORT}}", PROXY_PORT)
  .replace("{{CLAUDE_PORT}}", CLAUDE_PORT);

// ─── Codex config paths ────────────────────────────────────────────────────
const CODEX_DIR = path.join(process.env.HOME || process.env.USERPROFILE, ".codex");
const CODEX_AUTH = path.join(CODEX_DIR, "auth.json");
const CODEX_CONFIG = path.join(CODEX_DIR, "config.toml");

function writeCodexConfig() {
  fs.mkdirSync(CODEX_DIR, { recursive: true });
  if (fs.existsSync(CODEX_AUTH) && !fs.existsSync(CODEX_AUTH + ".bak"))
    fs.copyFileSync(CODEX_AUTH, CODEX_AUTH + ".bak");
  if (fs.existsSync(CODEX_CONFIG) && !fs.existsSync(CODEX_CONFIG + ".bak"))
    fs.copyFileSync(CODEX_CONFIG, CODEX_CONFIG + ".bak");

  fs.writeFileSync(CODEX_AUTH, JSON.stringify({ OPENAI_API_KEY: "PROXY_MANAGED" }, null, 2));

  let src = "";
  if (fs.existsSync(CODEX_CONFIG + ".bak")) src = fs.readFileSync(CODEX_CONFIG + ".bak", "utf-8");
  else if (fs.existsSync(CODEX_CONFIG)) src = fs.readFileSync(CODEX_CONFIG, "utf-8");

  const lines = src.split("\n");
  const topLevel = [], sections = [];
  let cur = null;
  for (const line of lines) {
    if (/^\s*\[/.test(line)) { if (cur) sections.push(cur); cur = line + "\n"; }
    else if (cur) cur += line + "\n";
    else topLevel.push(line);
  }
  if (cur) sections.push(cur);

  const cleanTop = topLevel
    .filter(l => !/^\s*model_provider\s*=/.test(l) && !/^\s*base_url\s*=.*127\.0\.0\.1/.test(l))
    .join("\n").trim();
  const cleanSections = sections
    .filter(s => !/^\s*\[model_providers\.copilot-bridge\]/.test(s))
    .map(s => s.trim()).join("\n\n");

  const out = [
    `model_provider = "copilot-bridge"`, cleanTop, "",
    `[model_providers.copilot-bridge]`,
    `name = "Copilot Bridge"`,
    `base_url = "http://127.0.0.1:${PROXY_PORT}/v1"`,
    `env_key = "OPENAI_API_KEY"`,
    `wire_api = "responses"`, "",
    cleanSections,
  ].join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";

  fs.writeFileSync(CODEX_CONFIG, out);

  if (process.platform === "win32") {
    try { execSync("setx OPENAI_API_KEY PROXY_MANAGED", { stdio: "ignore", windowsHide: true }); } catch {}
    try { execSync(`setx OPENAI_BASE_URL http://127.0.0.1:${PROXY_PORT}/v1`, { stdio: "ignore", windowsHide: true }); } catch {}
  } else if (process.platform === "darwin") {
    try { execSync("launchctl setenv OPENAI_API_KEY PROXY_MANAGED", { stdio: "ignore" }); } catch {}
    try { execSync(`launchctl setenv OPENAI_BASE_URL http://127.0.0.1:${PROXY_PORT}/v1`, { stdio: "ignore" }); } catch {}
  }
  log("[Bridge] Codex config injected");
}

function restoreCodexConfig() {
  if (fs.existsSync(CODEX_AUTH + ".bak")) { fs.copyFileSync(CODEX_AUTH + ".bak", CODEX_AUTH); fs.unlinkSync(CODEX_AUTH + ".bak"); }
  else if (fs.existsSync(CODEX_AUTH)) fs.unlinkSync(CODEX_AUTH);
  if (fs.existsSync(CODEX_CONFIG + ".bak")) { fs.copyFileSync(CODEX_CONFIG + ".bak", CODEX_CONFIG); fs.unlinkSync(CODEX_CONFIG + ".bak"); }
  else if (fs.existsSync(CODEX_CONFIG)) fs.unlinkSync(CODEX_CONFIG);

  if (process.platform === "win32") {
    try { execSync('REG DELETE "HKCU\\Environment" /v OPENAI_API_KEY /f', { stdio: "ignore", windowsHide: true }); } catch {}
    try { execSync('REG DELETE "HKCU\\Environment" /v OPENAI_BASE_URL /f', { stdio: "ignore", windowsHide: true }); } catch {}
  } else if (process.platform === "darwin") {
    try { execSync("launchctl unsetenv OPENAI_API_KEY", { stdio: "ignore" }); } catch {}
    try { execSync("launchctl unsetenv OPENAI_BASE_URL", { stdio: "ignore" }); } catch {}
  }
  log("[Bridge] Codex config restored");
}

// ─── Claude config (~/.claude/settings.json) ───────────────────────────────
const CLAUDE_DIR = path.join(process.env.HOME || process.env.USERPROFILE, ".claude");
const CLAUDE_SETTINGS = path.join(CLAUDE_DIR, "settings.json");

function writeClaudeConfig() {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  if (fs.existsSync(CLAUDE_SETTINGS) && !fs.existsSync(CLAUDE_SETTINGS + ".bak"))
    fs.copyFileSync(CLAUDE_SETTINGS, CLAUDE_SETTINGS + ".bak");

  let settings = {};
  try {
    if (fs.existsSync(CLAUDE_SETTINGS + ".bak"))
      settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS + ".bak", "utf-8"));
    else if (fs.existsSync(CLAUDE_SETTINGS))
      settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, "utf-8"));
  } catch {}

  settings.env = settings.env || {};
  settings.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${CLAUDE_PORT}`;
  settings.env.ANTHROPIC_AUTH_TOKEN = "PROXY_MANAGED";
  // Do NOT force ANTHROPIC_MODEL — let Claude Code pick its own model via /v1/models,
  // and the bridge will remap it to whatever Copilot actually supports.
  if (settings.env.ANTHROPIC_MODEL) delete settings.env.ANTHROPIC_MODEL;

  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2));
  log("[Bridge] Claude config injected");
}

function restoreClaudeConfig() {
  if (fs.existsSync(CLAUDE_SETTINGS + ".bak")) {
    fs.copyFileSync(CLAUDE_SETTINGS + ".bak", CLAUDE_SETTINGS);
    fs.unlinkSync(CLAUDE_SETTINGS + ".bak");
  } else if (fs.existsSync(CLAUDE_SETTINGS)) {
    // Remove only the keys we added
    try {
      const s = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, "utf-8"));
      if (s.env) {
        delete s.env.ANTHROPIC_BASE_URL;
        delete s.env.ANTHROPIC_AUTH_TOKEN;
        delete s.env.ANTHROPIC_MODEL;
        if (Object.keys(s.env).length === 0) delete s.env;
      }
      fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(s, null, 2));
    } catch {}
  }
  log("[Bridge] Claude config restored");
}

// ─── Session persistence ────────────────────────────────────────────────────
const SESSION_FILE = path.join(process.env.HOME || process.env.USERPROFILE, ".codex", "ccb-session.json");

function saveSession() {
  try {
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ github_token: githubToken, username, codexEnabled, claudeEnabled }, null, 2));
    try { fs.chmodSync(SESSION_FILE, 0o600); } catch {}
  } catch (e) { dbg("[Session] save failed:", e.message); }
}

function deleteSession() {
  try { if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE); } catch {}
}

async function loadSession() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return false;
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
    if (!data.github_token) return false;
    githubToken = data.github_token;
    username = data.username || "";
    // Backward compat: old sessions used single bridgeEnabled flag (Codex only)
    codexEnabled = data.codexEnabled !== undefined ? data.codexEnabled : (data.bridgeEnabled !== false);
    claudeEnabled = !!data.claudeEnabled;
    await ensureCopilotToken();
    if (codexEnabled) writeCodexConfig();
    if (claudeEnabled) writeClaudeConfig();
    log("[Bridge] Session restored for", username);
    return true;
  } catch (e) {
    dbg("[Session] restore failed:", e.message);
    githubToken = null; username = null; codexEnabled = false; claudeEnabled = false;
    deleteSession();
    return false;
  }
}

// ─── State ─────────────────────────────────────────────────────────────────
let githubToken = null, copilotToken = null, copilotTokenExpiry = 0;
let username = null, codexEnabled = false, claudeEnabled = false;

function httpsRequest(options, body) {
  return new Promise(async (resolve, reject) => {
    try {
      const req = await upstreamHttpsRequest(options, (res) => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode, body: raw }); }
        });
      });
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    } catch (e) { reject(e); }
  });
}

async function ensureCopilotToken() {
  if (copilotToken && Date.now() / 1000 < copilotTokenExpiry - 60) return copilotToken;
  const res = await httpsRequest({
    hostname: "api.github.com", path: "/copilot_internal/v2/token", method: "GET",
    headers: { Authorization: `token ${githubToken}`, "User-Agent": "GitHubCopilotChat/0.38.2", "Editor-Version": "vscode/1.110.1", "Editor-Plugin-Version": "copilot-chat/0.38.2" },
  });
  if (res.status === 401 || res.status === 403) {
    if (codexEnabled) restoreCodexConfig();
    if (claudeEnabled) restoreClaudeConfig();
    githubToken = null; copilotToken = null; username = null; codexEnabled = false; claudeEnabled = false;
    deleteSession();
    throw new Error(`GitHub token revoked (${res.status})`);
  }
  if (res.status !== 200) throw new Error(`Copilot token error: ${res.status}`);
  copilotToken = res.body.token;
  copilotTokenExpiry = res.body.expires_at;
  return copilotToken;
}

// ─── Copilot model list (cached) + Claude model mapping ───────────────────
let copilotModelsCache = null;
let copilotModelsCacheAt = 0;

async function getCopilotClaudeModelsRaw() {
  const now = Date.now();
  if (copilotModelsCache && now - copilotModelsCacheAt < 300000) return copilotModelsCache;
  const token = await ensureCopilotToken();
  const data = await new Promise((resolve, reject) => {
    const r = https.request({
      hostname: COPILOT_API, path: "/models", method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Editor-Version": "vscode/1.110.1", "Editor-Plugin-Version": "copilot-chat/0.38.2",
        "User-Agent": "GitHubCopilotChat/0.38.2", "Copilot-Integration-Id": "vscode-chat",
        "X-GitHub-Api-Version": "2025-10-01",
      },
    }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(e); }
      });
    });
    r.on("error", reject);
    r.end();
  });
  const list = (data.data || []).filter(m => /claude/i.test(m.id || ""));
  copilotModelsCache = list;
  copilotModelsCacheAt = now;
  return list;
}

// Convert a Copilot model id (e.g. "claude-sonnet-4.6", "claude-opus-4.6-1m") to
// the id format Claude Code extension uses (dashes, "[1m]" suffix).
//   claude-sonnet-4.6       → claude-sonnet-4-6
//   claude-opus-4.6-1m      → claude-opus-4-6[1m]
//   claude-sonnet-4         → claude-sonnet-4
function copilotIdToClaudeCodeId(id) {
  let m = id;
  const oneM = /-1m$/i.test(m);
  if (oneM) m = m.replace(/-1m$/i, "");
  m = m.replace(/(\d+)\.(\d+)/, "$1-$2");
  return oneM ? `${m}[1m]` : m;
}

// Build the list of Claude-Code-facing models from Copilot's raw list.
// For each Copilot model that doesn't already have a 1m sibling, also synthesise
// a "[1m]" variant so Claude Code's picker sees it (Copilot routes them to the
// 200k version — we still forward; worst case the caller's big context is truncated).
async function getClaudeCodeFacingModels() {
  const raw = await getCopilotClaudeModelsRaw();
  const byCopilotId = new Map(raw.map(m => [m.id, m]));
  const out = [];
  const seen = new Set();
  for (const m of raw) {
    const cc = copilotIdToClaudeCodeId(m.id);
    if (seen.has(cc)) continue;
    seen.add(cc);
    out.push({ id: cc, name: m.name || m.id, _copilot: m.id });
  }
  // Synthesize [1m] variant for each base that lacks one
  for (const m of raw) {
    if (/-1m$/i.test(m.id)) continue;
    const base = copilotIdToClaudeCodeId(m.id);
    const variant = `${base}[1m]`;
    if (seen.has(variant)) continue;
    // If there is a native -1m Copilot twin, skip (already covered above)
    if (byCopilotId.has(`${m.id}-1m`)) continue;
    seen.add(variant);
    out.push({
      id: variant,
      name: `${m.name || m.id} (1M context)`,
      _copilot: m.id,
    });
  }
  return out;
}

// Maps a Claude Code–style model id to the Copilot id to send upstream.
async function mapClaudeModel(requested) {
  if (!requested) return CLAUDE_MODEL;
  const list = await getClaudeCodeFacingModels();
  const hit = list.find(m => m.id === requested);
  if (hit) return hit._copilot;
  // Fallback: normalise dash→dot and retry directly against Copilot ids
  const raw = await getCopilotClaudeModelsRaw();
  const copilotIds = raw.map(m => m.id);
  if (copilotIds.includes(requested)) return requested;
  const stripped = requested.replace(/\[1m\]$/i, "");
  const dotted = stripped.replace(/^(claude-[a-z]+-\d+)-(\d+)(.*)$/, "$1.$2$3");
  if (copilotIds.includes(`${dotted}-1m`) && /\[1m\]$/i.test(requested)) return `${dotted}-1m`;
  if (copilotIds.includes(dotted)) return dotted;
  // Family best-match
  const fam = (requested.match(/claude-(sonnet|opus|haiku)/) || [])[1];
  if (fam) {
    const family = copilotIds.filter(id => id.includes(fam));
    if (family.length) {
      family.sort((a, b) => {
        const na = (a.match(/(\d+(?:\.\d+)?)/g) || []).map(Number);
        const nb = (b.match(/(\d+(?:\.\d+)?)/g) || []).map(Number);
        for (let i = 0; i < Math.max(na.length, nb.length); i++) {
          const x = na[i] || 0, y = nb[i] || 0;
          if (x !== y) return y - x;
        }
        return 0;
      });
      return family[0];
    }
  }
  return CLAUDE_MODEL;
}

// ─── Codex proxy server (OpenAI passthrough) ──────────────────────────────
const proxy = http.createServer(async (req, res) => {
  if (!githubToken || !codexEnabled) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Codex bridge not active" }));
    return;
  }
  const bodyChunks = [];
  for await (const chunk of req) bodyChunks.push(chunk);
  const bodyBuf = Buffer.concat(bodyChunks);
  try {
    const token = await ensureCopilotToken();
    const p = req.url.startsWith("/v1") ? req.url : `/v1${req.url}`;
    const upstream = await upstreamHttpsRequest({
      hostname: COPILOT_API, path: p, method: req.method,
      headers: {
        "Content-Type": "application/json", Authorization: `Bearer ${token}`,
        "Editor-Version": "vscode/1.110.1", "Editor-Plugin-Version": "copilot-chat/0.38.2",
        "User-Agent": "GitHubCopilotChat/0.38.2", "Copilot-Integration-Id": "vscode-chat",
        "X-GitHub-Api-Version": "2025-10-01",
      },
    }, (upstreamRes) => {
      dbg(`[Proxy] ${req.method} ${p} → ${upstreamRes.statusCode}`);
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    upstream.on("error", e => { try { res.writeHead(502); res.end(JSON.stringify({ error: e.message })); } catch {} });
    if (bodyBuf.length) upstream.write(bodyBuf);
    upstream.end();
  } catch (e) { try { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); } catch {} }
});

// ─── Anthropic ↔ OpenAI translation ────────────────────────────────────────
function anthropicToOpenAI(req) {
  const messages = [];
  if (req.system) {
    const sysText = typeof req.system === "string"
      ? req.system
      : req.system.map(b => b.text || "").join("\n");
    messages.push({ role: "system", content: sysText });
  }
  for (const m of req.messages || []) {
    if (typeof m.content === "string") {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    // Content blocks: text, tool_use, tool_result, image
    const textParts = [];
    const toolCalls = [];
    const toolResults = [];
    for (const b of m.content || []) {
      if (b.type === "text") textParts.push(b.text);
      else if (b.type === "tool_use") {
        toolCalls.push({
          id: b.id, type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input || {}) }
        });
      } else if (b.type === "tool_result") {
        const rc = typeof b.content === "string"
          ? b.content
          : (b.content || []).map(x => x.text || "").join("\n");
        toolResults.push({ role: "tool", tool_call_id: b.tool_use_id, content: rc });
      }
    }
    if (toolResults.length) { for (const tr of toolResults) messages.push(tr); continue; }
    const msg = { role: m.role };
    if (textParts.length) msg.content = textParts.join("\n");
    if (toolCalls.length) { msg.tool_calls = toolCalls; if (!msg.content) msg.content = null; }
    messages.push(msg);
  }

  const out = {
    model: req.model || CLAUDE_MODEL,
    messages,
    stream: !!req.stream,
  };
  if (req.max_tokens) out.max_tokens = req.max_tokens;
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.stop_sequences) out.stop = req.stop_sequences;
  if (req.tools) {
    out.tools = req.tools.map(t => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema }
    }));
  }
  return out;
}

function openAIToAnthropicResponse(oai, model) {
  const choice = (oai.choices || [{}])[0];
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: "text", text: msg.content });
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc.function.arguments || "{}"); } catch {}
      content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
    }
  }
  const stopReasonMap = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use" };
  return {
    id: oai.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReasonMap[choice.finish_reason] || "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: (oai.usage && oai.usage.prompt_tokens) || 0,
      output_tokens: (oai.usage && oai.usage.completion_tokens) || 0,
    },
  };
}

// SSE translator: parses OpenAI delta stream and emits Anthropic events
function makeStreamTranslator(model, write) {
  const msgId = `msg_${Date.now()}`;
  let started = false;
  let textBlockOpen = false;
  let toolBlocks = {}; // index -> { id, name, jsonBuf }
  let inputTokens = 0, outputTokens = 0;
  let stopReason = "end_turn";
  let buffer = "";

  function send(event, data) {
    write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function ensureStart() {
    if (started) return;
    started = true;
    send("message_start", {
      type: "message_start",
      message: {
        id: msgId, type: "message", role: "assistant", model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  function closeOpenBlocks() {
    if (textBlockOpen) {
      send("content_block_stop", { type: "content_block_stop", index: 0 });
      textBlockOpen = false;
    }
    for (const idx of Object.keys(toolBlocks)) {
      send("content_block_stop", { type: "content_block_stop", index: parseInt(idx) });
    }
    toolBlocks = {};
  }

  return {
    feed(chunk) {
      buffer += chunk.toString("utf-8");
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let evt;
        try { evt = JSON.parse(data); } catch { continue; }
        ensureStart();
        const delta = (evt.choices && evt.choices[0] && evt.choices[0].delta) || {};
        const finish = evt.choices && evt.choices[0] && evt.choices[0].finish_reason;
        if (evt.usage) {
          inputTokens = evt.usage.prompt_tokens || inputTokens;
          outputTokens = evt.usage.completion_tokens || outputTokens;
        }

        if (delta.content) {
          if (!textBlockOpen) {
            send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
            textBlockOpen = true;
          }
          send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta.content } });
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = (tc.index !== undefined ? tc.index : 0) + (textBlockOpen ? 1 : 0);
            if (!toolBlocks[idx]) {
              toolBlocks[idx] = { id: tc.id || `tool_${idx}`, name: (tc.function && tc.function.name) || "", jsonBuf: "" };
              send("content_block_start", {
                type: "content_block_start", index: idx,
                content_block: { type: "tool_use", id: toolBlocks[idx].id, name: toolBlocks[idx].name, input: {} },
              });
            }
            const block = toolBlocks[idx];
            if (tc.id) block.id = tc.id;
            if (tc.function && tc.function.name) block.name = tc.function.name;
            if (tc.function && tc.function.arguments) {
              block.jsonBuf += tc.function.arguments;
              send("content_block_delta", {
                type: "content_block_delta", index: idx,
                delta: { type: "input_json_delta", partial_json: tc.function.arguments },
              });
            }
          }
        }
        if (finish) {
          const map = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use" };
          stopReason = map[finish] || "end_turn";
        }
      }
    },
    end() {
      ensureStart();
      closeOpenBlocks();
      send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens },
      });
      send("message_stop", { type: "message_stop" });
    },
  };
}

// ─── Claude proxy server (Anthropic → OpenAI translation) ─────────────────
const claudeProxy = http.createServer(async (req, res) => {
  dbg(`[Claude] ← ${req.method} ${req.url}`);
  if (!githubToken || !claudeEnabled) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "Claude bridge not active" } }));
    return;
  }
  // POST /v1/messages/count_tokens — best-effort token count (rough estimate)
  if (req.method === "POST" && req.url.replace(/\?.*$/, "").endsWith("/v1/messages/count_tokens")) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
    let chars = 0;
    if (typeof body.system === "string") chars += body.system.length;
    else if (Array.isArray(body.system)) chars += body.system.reduce((n, b) => n + (b.text || "").length, 0);
    for (const m of body.messages || []) {
      if (typeof m.content === "string") chars += m.content.length;
      else for (const b of m.content || []) {
        if (b.type === "text") chars += (b.text || "").length;
        else if (b.type === "tool_use") chars += JSON.stringify(b.input || {}).length + (b.name || "").length;
        else if (b.type === "tool_result") chars += (typeof b.content === "string" ? b.content : JSON.stringify(b.content || "")).length;
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ input_tokens: Math.max(1, Math.ceil(chars / 4)) }));
    return;
  }
  // GET /v1/models — list available Claude models in Claude-Code-compatible ids
  if (req.method === "GET" && (req.url === "/v1/models" || req.url.startsWith("/v1/models?"))) {
    try {
      const models = await getClaudeCodeFacingModels();
      const now = new Date().toISOString();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        data: models.map(m => ({
          type: "model",
          id: m.id,
          display_name: m.name,
          created_at: now,
        })),
        has_more: false,
        first_id: models[0]?.id || null,
        last_id: models[models.length - 1]?.id || null,
      }));
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: e.message } }));
    }
    return;
  }

  if (!req.url.endsWith("/v1/messages") && req.url !== "/v1/messages" && !req.url.startsWith("/v1/messages?")) {
    dbg(`[Claude] 404 ${req.method} ${req.url}`);
    res.writeHead(404); res.end(JSON.stringify({ error: "Not found", path: req.url })); return;
  }

  const bodyChunks = [];
  for await (const chunk of req) bodyChunks.push(chunk);
  const rawBody = Buffer.concat(bodyChunks).toString();
  dbg(`[Claude] /v1/messages body head: ${rawBody.slice(0, 300)}`);
  let anthropicReq;
  try { anthropicReq = JSON.parse(rawBody); }
  catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: "Invalid JSON" })); return; }

  const isStream = !!anthropicReq.stream;
  const oaiReq = anthropicToOpenAI(anthropicReq);
  // Remap the requested model to one Copilot actually exposes
  try {
    const mapped = await mapClaudeModel(oaiReq.model);
    if (mapped !== oaiReq.model) dbg(`[Claude] model ${oaiReq.model} → ${mapped}`);
    oaiReq.model = mapped;
  } catch (e) {
    dbg("[Claude] model list fetch failed, using default:", e.message);
    oaiReq.model = CLAUDE_MODEL;
  }
  const model = oaiReq.model;

  try {
    const token = await ensureCopilotToken();
    const upstream = await upstreamHttpsRequest({
      hostname: COPILOT_API, path: "/chat/completions", method: "POST",
      headers: {
        "Content-Type": "application/json", Authorization: `Bearer ${token}`,
        "Editor-Version": "vscode/1.110.1", "Editor-Plugin-Version": "copilot-chat/0.38.2",
        "User-Agent": "GitHubCopilotChat/0.38.2", "Copilot-Integration-Id": "vscode-chat",
        "X-GitHub-Api-Version": "2025-10-01",
        "Accept": isStream ? "text/event-stream" : "application/json",
      },
    }, (upstreamRes) => {
      dbg(`[Claude] upstream model=${model} status=${upstreamRes.statusCode} stream=${isStream}`);
      if (upstreamRes.statusCode !== 200) {
        const errChunks = [];
        upstreamRes.on("data", d => errChunks.push(d));
        upstreamRes.on("end", () => {
          const raw = Buffer.concat(errChunks).toString();
          dbg(`[Claude] upstream error body: ${raw.slice(0, 500)}`);
          // Translate Copilot/OpenAI error shape → Anthropic error shape so Claude
          // Code surfaces the real upstream message instead of a generic "model may
          // not exist" string.
          let anthErr;
          try {
            const j = JSON.parse(raw);
            const msg = (j.error && (j.error.message || j.message)) || j.message || raw;
            const typeMap = { 400: "invalid_request_error", 401: "authentication_error", 403: "permission_error", 404: "not_found_error", 429: "rate_limit_error" };
            anthErr = { type: "error", error: { type: typeMap[upstreamRes.statusCode] || "api_error", message: msg } };
          } catch {
            anthErr = { type: "error", error: { type: "api_error", message: raw || `upstream ${upstreamRes.statusCode}` } };
          }
          res.writeHead(upstreamRes.statusCode, { "Content-Type": "application/json" });
          res.end(JSON.stringify(anthErr));
        });
        return;
      }
      if (isStream) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
        const trans = makeStreamTranslator(model, c => res.write(c));
        upstreamRes.on("data", d => trans.feed(d));
        upstreamRes.on("end", () => { trans.end(); res.end(); });
      } else {
        const chunks = [];
        upstreamRes.on("data", d => chunks.push(d));
        upstreamRes.on("end", () => {
          let oaiResp;
          try { oaiResp = JSON.parse(Buffer.concat(chunks).toString()); }
          catch { res.writeHead(502); res.end(JSON.stringify({ error: "Bad upstream JSON" })); return; }
          const anthResp = openAIToAnthropicResponse(oaiResp, model);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(anthResp));
        });
      }
    });
    upstream.on("error", e => { res.writeHead(502); res.end(JSON.stringify({ error: e.message })); });
    upstream.write(JSON.stringify(oaiReq));
    upstream.end();
  } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
});

// ─── UI server ─────────────────────────────────────────────────────────────
const ui = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/api/start") {
    const r = await httpsRequest(
      { hostname: "github.com", path: "/login/device/code", method: "POST", headers: { Accept: "application/json", "User-Agent": "GitHubCopilotChat/0.38.2", "Content-Type": "application/x-www-form-urlencoded" } },
      `client_id=${GITHUB_CLIENT_ID}&scope=read:user`
    );
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(r.body)); return;
  }
  if (req.method === "POST" && req.url === "/api/poll") {
    const chunks = []; for await (const c of req) chunks.push(c);
    const { device_code } = JSON.parse(Buffer.concat(chunks).toString());
    const r = await httpsRequest(
      { hostname: "github.com", path: "/login/oauth/access_token", method: "POST", headers: { Accept: "application/json", "User-Agent": "GitHubCopilotChat/0.38.2", "Content-Type": "application/x-www-form-urlencoded" } },
      `client_id=${GITHUB_CLIENT_ID}&device_code=${device_code}&grant_type=urn:ietf:params:oauth:grant-type:device_code`
    );
    if (r.body.access_token) {
      githubToken = r.body.access_token;
      const u = await httpsRequest({ hostname: "api.github.com", path: "/user", method: "GET", headers: { Authorization: `token ${githubToken}`, "User-Agent": "GitHubCopilotChat/0.38.2" } });
      username = u.body.login || "";
      codexEnabled = true;
      claudeEnabled = true;
      writeCodexConfig();
      writeClaudeConfig();
      saveSession();
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ access_token: githubToken, username }));
    } else {
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ pending: true, error: r.body.error }));
    }
    return;
  }
  if (req.method === "POST" && req.url === "/api/heartbeat") {
    lastHeartbeat = Date.now();
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true })); return;
  }
  if (req.method === "POST" && req.url === "/api/focus") {
    focusAppWindow();
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true })); return;
  }
  if (req.url === "/api/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ connected: !!githubToken, username, codexEnabled, claudeEnabled, proxyPort: PROXY_PORT, claudePort: CLAUDE_PORT })); return;
  }
  if (req.method === "POST" && req.url === "/api/toggle-codex") {
    if (!githubToken) { res.writeHead(400); res.end(JSON.stringify({ error: "Not connected" })); return; }
    codexEnabled = !codexEnabled;
    if (codexEnabled) writeCodexConfig(); else restoreCodexConfig();
    saveSession();
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ codexEnabled })); return;
  }
  if (req.method === "POST" && req.url === "/api/toggle-claude") {
    if (!githubToken) { res.writeHead(400); res.end(JSON.stringify({ error: "Not connected" })); return; }
    claudeEnabled = !claudeEnabled;
    if (claudeEnabled) writeClaudeConfig(); else restoreClaudeConfig();
    saveSession();
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ claudeEnabled })); return;
  }
  if (req.method === "POST" && req.url === "/api/disconnect") {
    if (codexEnabled) restoreCodexConfig();
    if (claudeEnabled) restoreClaudeConfig();
    githubToken = null; copilotToken = null; username = null; codexEnabled = false; claudeEnabled = false;
    deleteSession();
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true })); return;
  }
  if (req.method === "POST" && req.url === "/api/open-url") {
    const chunks = []; for await (const c of req) chunks.push(c);
    const { url } = JSON.parse(Buffer.concat(chunks).toString());
    if (url && url.startsWith("https://")) {
      if (process.platform === "darwin") spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
      else execSync(`start "" "${url}"`, { stdio: "ignore", shell: true, windowsHide: true });
    }
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true })); return;
  }
  if (req.url === "/kobashi.svg" || req.url.startsWith("/kobashi.svg?") || req.url === "/favicon.svg" || req.url.startsWith("/favicon.svg?")) {
    res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store, max-age=0" });
    res.end(getAssetText("kobashi.svg")); return;
  }
  if (req.url === "/codex-logo.png") {
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end(getAsset("codex.png")); return;
  }
  if (req.url === "/favicon.ico") {
    if (process.platform === "win32") {
      res.writeHead(200, { "Content-Type": "image/x-icon" });
      res.end(getAsset("kobashi-icon.ico")); return;
    }
    res.writeHead(200, { "Content-Type": "image/svg+xml" });
    res.end(getAssetText("kobashi.svg")); return;
  }
  if (req.url === "/manifest.json") {
    res.writeHead(200, { "Content-Type": "application/manifest+json" });
    res.end(JSON.stringify({ name: "Kobashi", short_name: "Kobashi", start_url: "/", display: "standalone", background_color: "#0a0c10", theme_color: "#7c6cf0", icons: [{ src: "/kobashi.svg", sizes: "any", type: "image/svg+xml" }] }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" }); res.end(HTML);
});

function cleanupOnExit() {
  if (codexEnabled) restoreCodexConfig();
  if (claudeEnabled) restoreClaudeConfig();
}
process.on("SIGINT", () => { cleanupOnExit(); process.exit(); });
process.on("SIGTERM", () => { cleanupOnExit(); process.exit(); });

let lastHeartbeat = 0;

function focusAppWindow() {
  if (process.platform === "win32") {
    const ps = `
      Add-Type @"
      using System; using System.Runtime.InteropServices;
      public class W { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int n); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }
"@
      Get-Process msedge,chrome,brave -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowTitle -like '*Kobashi*' } |
        ForEach-Object { [W]::ShowWindow($_.MainWindowHandle,9); [W]::SetForegroundWindow($_.MainWindowHandle) }
    `;
    try { execSync(`powershell -WindowStyle Hidden -Command "${ps.replace(/\n\s*/g, ' ')}"`, { stdio: "ignore", windowsHide: true }); } catch {}
  }
}

function openBrowser() {
  if (!process.argv.includes("--no-open")) openAppWindow(`http://127.0.0.1:${UI_PORT}`);
}

const testReq = http.get(`http://127.0.0.1:${UI_PORT}/api/status`, () => {
  // Already running — ask the server to focus its window
  const focusReq = http.request({ hostname: "127.0.0.1", port: UI_PORT, path: "/api/focus", method: "POST" }, () => process.exit(0));
  focusReq.on("error", () => process.exit(0));
  focusReq.end();
});
testReq.on("error", () => {
  proxy.listen(PROXY_PORT, () => log(`[Bridge] Codex proxy on http://127.0.0.1:${PROXY_PORT}`));
  claudeProxy.listen(CLAUDE_PORT, () => log(`[Bridge] Claude proxy on http://127.0.0.1:${CLAUDE_PORT}`));
  ui.listen(UI_PORT, async () => {
    log(`[Bridge] UI on http://127.0.0.1:${UI_PORT}`);
    await loadSession();
    openBrowser();
    // Heartbeat-based shutdown: exit when browser window is closed
    if (!process.argv.includes("--no-open")) {
      // Give window 10s to load before we start watching heartbeat
      setTimeout(() => { lastHeartbeat = Date.now(); }, 10000);
      setInterval(() => {
        if (lastHeartbeat > 0 && Date.now() - lastHeartbeat > 5000) {
          log("[Bridge] Window closed, shutting down");
          cleanupOnExit();
          process.exit(0);
        }
      }, 1000);
    }
  });
});
testReq.end();
