const http = require("http");
const https = require("https");
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
    try { const r = execSync(`where ${cmd}`, { stdio: "pipe" }).toString().trim().split("\n")[0]; if (r) return r.trim(); } catch {}
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
      execSync(`start "" "${BROWSER_PATH}" --app=${url} --window-size=420,560`, { stdio: "ignore", shell: true });
    } else {
      execSync(`start "" "${url}"`, { stdio: "ignore", shell: true });
    }
  }
}

const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const COPILOT_API = "api.githubcopilot.com";
const PROXY_PORT = 18921;
const UI_PORT = 18922;

// ─── Assets ────────────────────────────────────────────────────────────────
const ASSETS = path.join(__dirname, "assets");
const HTML = fs.readFileSync(path.join(ASSETS, "ui.html"), "utf-8")
  .replace("{{PROXY_PORT}}", PROXY_PORT);

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
    try { execSync("setx OPENAI_API_KEY PROXY_MANAGED", { stdio: "ignore" }); } catch {}
    try { execSync(`setx OPENAI_BASE_URL http://127.0.0.1:${PROXY_PORT}/v1`, { stdio: "ignore" }); } catch {}
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
    try { execSync('REG DELETE "HKCU\\Environment" /v OPENAI_API_KEY /f', { stdio: "ignore" }); } catch {}
    try { execSync('REG DELETE "HKCU\\Environment" /v OPENAI_BASE_URL /f', { stdio: "ignore" }); } catch {}
  } else if (process.platform === "darwin") {
    try { execSync("launchctl unsetenv OPENAI_API_KEY", { stdio: "ignore" }); } catch {}
    try { execSync("launchctl unsetenv OPENAI_BASE_URL", { stdio: "ignore" }); } catch {}
  }
  log("[Bridge] Codex config restored");
}

// ─── Session persistence ────────────────────────────────────────────────────
const SESSION_FILE = path.join(process.env.HOME || process.env.USERPROFILE, ".codex", "ccb-session.json");

function saveSession() {
  try {
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ github_token: githubToken, username, bridgeEnabled }, null, 2));
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
    bridgeEnabled = data.bridgeEnabled !== false;
    await ensureCopilotToken();
    if (bridgeEnabled) writeCodexConfig();
    log("[Bridge] Session restored for", username);
    return true;
  } catch (e) {
    dbg("[Session] restore failed:", e.message);
    githubToken = null; username = null; bridgeEnabled = false;
    deleteSession();
    return false;
  }
}

// ─── State ─────────────────────────────────────────────────────────────────
let githubToken = null, copilotToken = null, copilotTokenExpiry = 0;
let username = null, bridgeEnabled = false;

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
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
  });
}

async function ensureCopilotToken() {
  if (copilotToken && Date.now() / 1000 < copilotTokenExpiry - 60) return copilotToken;
  const res = await httpsRequest({
    hostname: "api.github.com", path: "/copilot_internal/v2/token", method: "GET",
    headers: { Authorization: `token ${githubToken}`, "User-Agent": "GitHubCopilotChat/0.38.2", "Editor-Version": "vscode/1.110.1", "Editor-Plugin-Version": "copilot-chat/0.38.2" },
  });
  if (res.status === 401 || res.status === 403) {
    githubToken = null; copilotToken = null; username = null; bridgeEnabled = false;
    deleteSession(); restoreCodexConfig();
    throw new Error(`GitHub token revoked (${res.status})`);
  }
  if (res.status !== 200) throw new Error(`Copilot token error: ${res.status}`);
  copilotToken = res.body.token;
  copilotTokenExpiry = res.body.expires_at;
  return copilotToken;
}

// ─── Proxy server ──────────────────────────────────────────────────────────
const proxy = http.createServer(async (req, res) => {
  if (!githubToken || !bridgeEnabled) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Bridge not active" }));
    return;
  }
  const bodyChunks = [];
  for await (const chunk of req) bodyChunks.push(chunk);
  const bodyBuf = Buffer.concat(bodyChunks);
  try {
    const token = await ensureCopilotToken();
    const p = req.url.startsWith("/v1") ? req.url : `/v1${req.url}`;
    const upstream = https.request({
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
    upstream.on("error", e => { res.writeHead(502); res.end(JSON.stringify({ error: e.message })); });
    if (bodyBuf.length) upstream.write(bodyBuf);
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
      bridgeEnabled = true;
      writeCodexConfig();
      saveSession();
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ access_token: githubToken, username }));
    } else {
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ pending: true, error: r.body.error }));
    }
    return;
  }
  if (req.url === "/api/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ connected: !!githubToken, username, bridgeEnabled, proxyPort: PROXY_PORT })); return;
  }
  if (req.method === "POST" && req.url === "/api/toggle") {
    if (!githubToken) { res.writeHead(400); res.end(JSON.stringify({ error: "Not connected" })); return; }
    bridgeEnabled = !bridgeEnabled;
    if (bridgeEnabled) writeCodexConfig(); else restoreCodexConfig();
    saveSession();
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ bridgeEnabled })); return;
  }
  if (req.method === "POST" && req.url === "/api/disconnect") {
    githubToken = null; copilotToken = null; username = null; bridgeEnabled = false;
    deleteSession(); restoreCodexConfig();
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true })); return;
  }
  if (req.method === "POST" && req.url === "/api/open-url") {
    const chunks = []; for await (const c of req) chunks.push(c);
    const { url } = JSON.parse(Buffer.concat(chunks).toString());
    if (url && url.startsWith("https://")) {
      if (process.platform === "darwin") spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
      else execSync(`start "" "${url}"`, { stdio: "ignore", shell: true });
    }
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true })); return;
  }
  if (req.url === "/favicon.png" || req.url === "/icon-192.png" || req.url === "/icon-512.png") {
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end(fs.readFileSync(path.join(ASSETS, "codex-color.png"))); return;
  }
  if (req.url === "/favicon.ico") {
    if (process.platform === "win32") {
      res.writeHead(200, { "Content-Type": "image/x-icon" });
      res.end(fs.readFileSync(path.join(ASSETS, "bridge-icon.ico"))); return;
    }
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end(fs.readFileSync(path.join(ASSETS, "codex-color.png"))); return;
  }
  if (req.url === "/manifest.json") {
    res.writeHead(200, { "Content-Type": "application/manifest+json" });
    res.end(JSON.stringify({ name: "Codex Copilot Bridge", short_name: "Codex Bridge", start_url: "/", display: "standalone", background_color: "#0a0c10", theme_color: "#7c6cf0", icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }, { src: "/icon-512.png", sizes: "512x512", type: "image/png" }] }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" }); res.end(HTML);
});

process.on("SIGINT", () => { if (bridgeEnabled) restoreCodexConfig(); process.exit(); });
process.on("SIGTERM", () => { if (bridgeEnabled) restoreCodexConfig(); process.exit(); });

function openBrowser() {
  if (!process.argv.includes("--no-open")) openAppWindow(`http://127.0.0.1:${UI_PORT}`);
}

const testReq = http.get(`http://127.0.0.1:${UI_PORT}/api/status`, () => {
  log("[Bridge] Already running, opening browser");
  openBrowser(); process.exit(0);
});
testReq.on("error", () => {
  proxy.listen(PROXY_PORT, () => log(`[Bridge] Proxy on http://127.0.0.1:${PROXY_PORT}`));
  ui.listen(UI_PORT, async () => {
    log(`[Bridge] UI on http://127.0.0.1:${UI_PORT}`);
    await loadSession();
    openBrowser();
    // Idle timeout only in standalone mode (not managed by .app Swift wrapper)
    if (!process.argv.includes("--no-open")) {
      let lastSeen = Date.now();
      const handler = ui.listeners("request")[0];
      ui.removeAllListeners("request");
      ui.on("request", (req, res) => { lastSeen = Date.now(); handler(req, res); });
      setInterval(() => {
        if (Date.now() - lastSeen > 30000) {
          log("[Bridge] No activity, shutting down");
          if (bridgeEnabled) restoreCodexConfig();
          process.exit(0);
        }
      }, 10000);
    }
  });
});
testReq.end();
