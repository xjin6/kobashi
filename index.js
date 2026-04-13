const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { execSync, spawn } = require("child_process");

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
    return null; // fallback to open(1)
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

// Codex config paths
const CODEX_DIR = path.join(process.env.HOME || process.env.USERPROFILE, ".codex");
const CODEX_AUTH = path.join(CODEX_DIR, "auth.json");
const CODEX_CONFIG = path.join(CODEX_DIR, "config.toml");

function writeCodexConfig() {
  fs.mkdirSync(CODEX_DIR, { recursive: true });
  if (fs.existsSync(CODEX_AUTH) && !fs.existsSync(CODEX_AUTH + ".bak")) {
    fs.copyFileSync(CODEX_AUTH, CODEX_AUTH + ".bak");
  }
  if (fs.existsSync(CODEX_CONFIG) && !fs.existsSync(CODEX_CONFIG + ".bak")) {
    fs.copyFileSync(CODEX_CONFIG, CODEX_CONFIG + ".bak");
  }
  fs.writeFileSync(CODEX_AUTH, JSON.stringify({ OPENAI_API_KEY: "PROXY_MANAGED" }, null, 2));

  // Read user's original config from backup to preserve their settings
  let src = "";
  if (fs.existsSync(CODEX_CONFIG + ".bak")) {
    src = fs.readFileSync(CODEX_CONFIG + ".bak", "utf-8");
  } else if (fs.existsSync(CODEX_CONFIG)) {
    src = fs.readFileSync(CODEX_CONFIG, "utf-8");
  }

  // Parse into top-level keys and sections
  const lines = src.split("\n");
  const topLevel = [];    // lines before any [section]
  const sections = [];    // each section as a string block
  let curSection = null;
  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      if (curSection) sections.push(curSection);
      curSection = line + "\n";
    } else if (curSection) {
      curSection += line + "\n";
    } else {
      topLevel.push(line);
    }
  }
  if (curSection) sections.push(curSection);

  // Filter out bridge-related content from top-level and sections
  const cleanTop = topLevel
    .filter(l => !/^\s*model_provider\s*=/.test(l) && !/^\s*base_url\s*=.*127\.0\.0\.1/.test(l))
    .join("\n").trim();
  const cleanSections = sections
    .filter(s => !/^\s*\[model_providers\.copilot-bridge\]/.test(s))
    .map(s => s.trim()).join("\n\n");

  // Build new config: bridge top-level → user top-level → bridge section → user sections
  const out = [
    `model_provider = "copilot-bridge"`,
    cleanTop,
    "",
    `[model_providers.copilot-bridge]`,
    `name = "Copilot Bridge"`,
    `base_url = "http://127.0.0.1:${PROXY_PORT}/v1"`,
    `env_key = "OPENAI_API_KEY"`,
    `wire_api = "responses"`,
    "",
    cleanSections,
  ].filter(l => l !== undefined).join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";

  fs.writeFileSync(CODEX_CONFIG, out);

  // Set user-level env vars so new terminals / VS Code pick them up
  if (process.platform === "win32") {
    try { execSync('setx OPENAI_API_KEY PROXY_MANAGED', { stdio: "ignore" }); } catch {}
    try { execSync(`setx OPENAI_BASE_URL http://127.0.0.1:${PROXY_PORT}/v1`, { stdio: "ignore" }); } catch {}
  } else if (process.platform === "darwin") {
    try { execSync('launchctl setenv OPENAI_API_KEY PROXY_MANAGED', { stdio: "ignore" }); } catch {}
    try { execSync(`launchctl setenv OPENAI_BASE_URL http://127.0.0.1:${PROXY_PORT}/v1`, { stdio: "ignore" }); } catch {}
  }
  console.log("[Bridge] Codex config injected");
}

function restoreCodexConfig() {
  if (fs.existsSync(CODEX_AUTH + ".bak")) {
    fs.copyFileSync(CODEX_AUTH + ".bak", CODEX_AUTH);
    fs.unlinkSync(CODEX_AUTH + ".bak");
  } else if (fs.existsSync(CODEX_AUTH)) {
    fs.unlinkSync(CODEX_AUTH);
  }
  if (fs.existsSync(CODEX_CONFIG + ".bak")) {
    fs.copyFileSync(CODEX_CONFIG + ".bak", CODEX_CONFIG);
    fs.unlinkSync(CODEX_CONFIG + ".bak");
  } else if (fs.existsSync(CODEX_CONFIG)) {
    fs.unlinkSync(CODEX_CONFIG);
  }
  // Remove the env vars we set
  if (process.platform === "win32") {
    try { execSync('REG DELETE "HKCU\\Environment" /v OPENAI_API_KEY /f', { stdio: "ignore" }); } catch {}
    try { execSync('REG DELETE "HKCU\\Environment" /v OPENAI_BASE_URL /f', { stdio: "ignore" }); } catch {}
  } else if (process.platform === "darwin") {
    try { execSync('launchctl unsetenv OPENAI_API_KEY', { stdio: "ignore" }); } catch {}
    try { execSync('launchctl unsetenv OPENAI_BASE_URL', { stdio: "ignore" }); } catch {}
  }
  console.log("[Bridge] Codex config restored");
}

// State
let githubToken = null;
let copilotToken = null;
let copilotTokenExpiry = 0;
let username = null;
let bridgeEnabled = false;

// HTTPS helper
function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
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
  if (res.status !== 200) throw new Error(`Copilot token error: ${res.status}`);
  copilotToken = res.body.token;
  copilotTokenExpiry = res.body.expires_at;
  return copilotToken;
}

// Proxy server
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
      console.log(`[Proxy] ${req.method} ${p} → ${upstreamRes.statusCode}`);
      if (upstreamRes.statusCode !== 200) {
        const chunks2 = [];
        upstreamRes.on("data", c => chunks2.push(c));
        upstreamRes.on("end", () => console.log(`[Proxy] body: ${Buffer.concat(chunks2).toString().slice(0, 300)}`));
      }
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers); upstreamRes.pipe(res);
    });
    upstream.on("error", (e) => { res.writeHead(502); res.end(JSON.stringify({ error: e.message })); });
    if (bodyBuf.length) upstream.write(bodyBuf);
    upstream.end();
  } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
});

// UI server
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
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ bridgeEnabled })); return;
  }
  if (req.method === "POST" && req.url === "/api/disconnect") {
    githubToken = null; copilotToken = null; username = null; bridgeEnabled = false;
    restoreCodexConfig();
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true })); return;
  }
  if (req.method === "POST" && req.url === "/api/open-url") {
    const chunks = []; for await (const c of req) chunks.push(c);
    const { url } = JSON.parse(Buffer.concat(chunks).toString());
    if (url && url.startsWith("https://")) {
      if (process.platform === "darwin") {
        spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
      } else {
        execSync(`start "" "${url}"`, { stdio: "ignore", shell: true });
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true })); return;
  }
  if (req.url === "/favicon.png" || req.url === "/icon-192.png" || req.url === "/icon-512.png") {
    const icon = fs.readFileSync(path.join(__dirname, "codex-color.png"));
    res.writeHead(200, { "Content-Type": "image/png" }); res.end(icon); return;
  }
  if (req.url === "/favicon.ico") {
    if (process.platform === "win32") {
      const icon = fs.readFileSync(path.join(__dirname, "bridge-icon.ico"));
      res.writeHead(200, { "Content-Type": "image/x-icon" }); res.end(icon); return;
    } else {
      const icon = fs.readFileSync(path.join(__dirname, "codex-color.png"));
      res.writeHead(200, { "Content-Type": "image/png" }); res.end(icon); return;
    }
  }
  if (req.url === "/manifest.json") {
    res.writeHead(200, { "Content-Type": "application/manifest+json" });
    res.end(JSON.stringify({
      name: "Codex Copilot Bridge",
      short_name: "Codex Bridge",
      start_url: "/",
      display: "standalone",
      background_color: "#0a0c10",
      theme_color: "#7c6cf0",
      icons: [
        { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png" }
      ]
    }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" }); res.end(HTML);
});

process.on("SIGINT", () => { if (bridgeEnabled) restoreCodexConfig(); process.exit(); });
process.on("SIGTERM", () => { if (bridgeEnabled) restoreCodexConfig(); process.exit(); });

function openBrowser() {
  if (!process.argv.includes("--no-open")) {
    openAppWindow(`http://127.0.0.1:${UI_PORT}`);
  }
}

// Check if already running; if so, just open browser and exit
const testReq = http.get(`http://127.0.0.1:${UI_PORT}/api/status`, () => {
  console.log("[Bridge] Already running, opening browser");
  openBrowser();
  process.exit(0);
});
testReq.on("error", () => {
  // Not running, start normally
  proxy.listen(PROXY_PORT, () => console.log(`[Bridge] Proxy on http://127.0.0.1:${PROXY_PORT}`));
  ui.listen(UI_PORT, () => {
    console.log(`[Bridge] UI on http://127.0.0.1:${UI_PORT}`);
    openBrowser();
    // Heartbeat: track UI connections, exit when idle too long
    let lastSeen = Date.now();
    const origHandler = ui.listeners("request")[0];
    ui.removeAllListeners("request");
    ui.on("request", (req, res) => { lastSeen = Date.now(); origHandler(req, res); });
    setInterval(() => {
      if (Date.now() - lastSeen > 30000) {
        console.log("[Bridge] No activity, shutting down");
        if (bridgeEnabled) restoreCodexConfig();
        process.exit(0);
      }
    }, 10000);
  });
});
testReq.end();

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<link rel="icon" type="image/png" href="/favicon.png"/>
<link rel="manifest" href="/manifest.json"/>
<title>Codex Copilot Bridge</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  :root{--bg:#0a0c10;--fg:#e6edf3;--muted:#8b949e;--card-bg:rgba(22,27,34,.85);--card-border:rgba(48,54,61,.6);--card-shadow:0 24px 48px rgba(0,0,0,.4),0 0 0 1px rgba(48,54,61,.3);--bg-glow:radial-gradient(ellipse at 20% 50%,rgba(88,166,255,.15),transparent 60%),radial-gradient(ellipse at 80% 20%,rgba(63,185,80,.12),transparent 50%),radial-gradient(ellipse at 50% 80%,rgba(136,103,255,.12),transparent 50%);--accent1:#58a6ff;--accent2:#a371f7;--btn-bg:rgba(33,38,45,.8);--btn-border:rgba(48,54,61,.8);--btn-hover-bg:rgba(48,54,61,.8);--btn-hover-border:rgba(88,166,255,.3);--btn-hover-glow:0 0 20px rgba(88,166,255,.1);--code-bg:rgba(13,17,23,.8);--code-border:rgba(48,54,61,.6);--panel-bg:rgba(13,17,23,.6);--panel-border:rgba(48,54,61,.5);--toggle-bg:#21262d;--toggle-border:#30363d;--badge-bg:rgba(88,166,255,.1);--badge-border:rgba(88,166,255,.2);--badge-color:#58a6ff;--disconnect-color:#f85149;--disconnect-border:rgba(248,81,73,.3);--env-bg:rgba(13,17,23,.8);--env-border:rgba(48,54,61,.4);--env-key:#ff7b72;--env-val:#a5d6ff;--dot-gray:#484f58;--spinner-bg:rgba(48,54,61,.8);--logo-color:#58a6ff}
  [data-theme="light"]{--bg:#f0f4f0;--fg:#1a2e1a;--muted:#5a6e5a;--card-bg:rgba(255,255,255,.9);--card-border:rgba(46,139,87,.15);--card-shadow:0 24px 48px rgba(0,0,0,.08),0 0 0 1px rgba(46,139,87,.1);--bg-glow:radial-gradient(ellipse at 20% 50%,rgba(34,197,94,.1),transparent 60%),radial-gradient(ellipse at 80% 20%,rgba(16,185,129,.08),transparent 50%),radial-gradient(ellipse at 50% 80%,rgba(74,222,128,.06),transparent 50%);--accent1:#15803d;--accent2:#0891b2;--btn-bg:rgba(255,255,255,.9);--btn-border:rgba(46,139,87,.25);--btn-hover-bg:rgba(240,253,244,.9);--btn-hover-border:rgba(34,197,94,.5);--btn-hover-glow:0 0 20px rgba(34,197,94,.1);--code-bg:rgba(240,253,244,.8);--code-border:rgba(46,139,87,.15);--panel-bg:rgba(240,253,244,.6);--panel-border:rgba(46,139,87,.12);--toggle-bg:#d1d5db;--toggle-border:#9ca3af;--badge-bg:rgba(34,197,94,.1);--badge-border:rgba(34,197,94,.25);--badge-color:#16a34a;--disconnect-color:#dc2626;--disconnect-border:rgba(220,38,38,.3);--env-bg:rgba(240,253,244,.8);--env-border:rgba(46,139,87,.12);--env-key:#b91c1c;--env-val:#1e40af;--dot-gray:#9ca3af;--spinner-bg:rgba(46,139,87,.2);--logo-color:#16a34a}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;background:var(--bg);color:var(--fg);min-height:100vh;display:flex;align-items:center;justify-content:center;overflow:hidden;transition:background .3s,color .3s}
  .bg{position:fixed;inset:0;z-index:0;background:var(--bg-glow)}
  .card{position:relative;z-index:1;background:var(--card-bg);backdrop-filter:blur(20px);border:1px solid var(--card-border);border-radius:16px;padding:36px;width:440px;box-shadow:var(--card-shadow);transition:all .3s}
  .logo{display:flex;align-items:center;gap:10px;margin-bottom:6px}
  .logo svg{width:28px;height:28px;color:var(--logo-color)}
  h1{font-size:20px;font-weight:700;background:linear-gradient(135deg,var(--accent1),var(--accent2));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
  .sub{color:var(--muted);font-size:13px;margin-bottom:28px}
  .btn{display:inline-flex;align-items:center;gap:8px;padding:11px 22px;border-radius:10px;border:1px solid var(--btn-border);background:var(--btn-bg);color:var(--fg);font-size:14px;font-weight:600;cursor:pointer;transition:all .2s;backdrop-filter:blur(4px)}
  .btn:hover{background:var(--btn-hover-bg);border-color:var(--btn-hover-border);box-shadow:var(--btn-hover-glow)}
  .btn:active{transform:scale(.97)}
  .code-box{background:var(--code-bg);border:1px solid var(--code-border);border-radius:12px;padding:20px;text-align:center;margin:14px 0;transition:all .3s}
  .user-code{font-family:"SF Mono",Consolas,monospace;font-size:32px;font-weight:800;letter-spacing:.18em;background:linear-gradient(135deg,var(--accent1),var(--accent2));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
  .link{color:var(--accent1);text-decoration:none;font-size:13px;transition:color .2s}
  .link:hover{color:var(--accent2);text-decoration:underline}
  .btn-copy{display:inline-flex;align-items:center;gap:4px;padding:4px 12px;border-radius:6px;border:1px solid var(--code-border);background:var(--btn-bg);color:var(--muted);font-size:11px;cursor:pointer;transition:all .2s;margin-top:10px}
  .btn-copy:hover{background:var(--btn-hover-bg);color:var(--fg);border-color:var(--btn-hover-border)}
  .btn-copy.copied{border-color:#3fb950;color:#3fb950}
  .spinner{width:14px;height:14px;border:2px solid var(--spinner-bg);border-top-color:var(--accent1);border-radius:50%;display:inline-block;animation:spin .7s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
  .status{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted);margin-top:12px}
  .panel{background:var(--panel-bg);border:1px solid var(--panel-border);border-radius:12px;padding:18px;margin-top:16px;transition:all .3s}
  .panel-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
  .panel-row:last-child{margin-bottom:0}
  .panel-label{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
  .panel-value{font-size:13px;color:var(--fg);font-weight:500}
  .dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:4px}
  .dot-green{background:#3fb950;box-shadow:0 0 8px rgba(63,185,80,.4)}
  .dot-gray{background:var(--dot-gray)}
  .dot-pulse{animation:pulse 2s ease-in-out infinite}
  .toggle{position:relative;width:44px;height:24px;border-radius:12px;background:var(--toggle-bg);border:1px solid var(--toggle-border);cursor:pointer;transition:all .3s}
  .toggle.on{background:#238636;border-color:#238636;box-shadow:0 0 12px rgba(35,134,54,.3)}
  .toggle .knob{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;transition:all .3s;box-shadow:0 1px 3px rgba(0,0,0,.3)}
  .toggle.on .knob{left:22px}
  .user-badge{display:inline-flex;align-items:center;gap:6px;padding:4px 12px 4px 4px;background:var(--badge-bg);border:1px solid var(--badge-border);border-radius:20px;font-size:13px;color:var(--badge-color)}
  .user-badge img{width:22px;height:22px;border-radius:50%}
  .btn-disconnect{background:transparent;border:1px solid var(--disconnect-border);color:var(--disconnect-color);font-size:12px;padding:6px 14px;border-radius:8px}
  .btn-disconnect:hover{background:rgba(248,81,73,.1);border-color:var(--disconnect-color)}
  .env-box{background:var(--env-bg);border:1px solid var(--env-border);border-radius:8px;padding:12px 14px;font-family:"SF Mono",Consolas,monospace;font-size:11px;line-height:2;color:var(--muted);margin-top:8px;transition:all .3s}
  .env-box .key{color:var(--env-key)}
  .env-box .val{color:var(--env-val)}
  .section-title{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-top:20px;margin-bottom:8px}
  .fade-in{animation:fadeIn .4s ease}
  @keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
  #view-idle,#view-waiting,#view-connected{display:none}
  .watermark{position:fixed;bottom:8px;right:12px;z-index:0;font-size:10px;color:var(--muted);opacity:.65;text-align:right;line-height:1.6}
  .watermark a{color:inherit;text-decoration:none;cursor:pointer}
  .watermark a:hover{opacity:.8;text-decoration:underline}
  .theme-btn{position:absolute;top:12px;right:12px;width:32px;height:32px;border-radius:8px;border:1px solid var(--card-border);background:var(--btn-bg);color:var(--muted);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .2s;z-index:2}
  .theme-btn:hover{color:var(--fg);border-color:var(--btn-hover-border)}
</style>
</head>
<body>
<div class="bg"></div>
<div class="watermark"><a href="#" onclick="fetch('/api/open-url',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:'https://github.com/xjin6/codex-copilot-bridge'})});return false">xjin6</a> &middot; v1.0.0 &middot; 2026-04-13</div>
<div class="card">
  <button class="theme-btn" id="theme-btn" onclick="toggleTheme()" title="Toggle light/dark mode"><svg id="theme-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"></svg></button>
  <div class="logo">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
    <h1>Codex Copilot Bridge</h1>
  </div>
  <p class="sub">Route OpenAI Codex through your GitHub Copilot subscription</p>

  <div id="view-idle">
    <button class="btn" onclick="startAuth()">
      <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
      Connect with GitHub
    </button>
  </div>

  <div id="view-waiting" class="fade-in">
    <div class="code-box">
      <div style="font-size:12px;color:#8b949e;margin-bottom:10px">Enter this code at GitHub</div>
      <div style="margin-bottom:12px"><a class="link" id="verify-link" href="#" onclick="openLink(event)"></a></div>
      <div class="user-code" id="user-code"></div>
      <button class="btn-copy" id="btn-copy" onclick="copyCode()"><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25z"/></svg> Copy</button>
    </div>
    <div class="status"><span class="spinner"></span> Waiting for authorization...</div>
  </div>

  <div id="view-connected" class="fade-in">
    <div class="panel">
      <div class="panel-row">
        <div>
          <span class="panel-label">Account</span>
          <div style="margin-top:4px"><span class="user-badge"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> <span id="username"></span></span></div>
        </div>
        <button class="btn btn-disconnect" onclick="disconnect()">Disconnect</button>
      </div>
    </div>

    <div class="panel" style="margin-top:12px">
      <div class="panel-row">
        <div>
          <span class="panel-label">Codex Bridge</span>
          <div style="margin-top:4px;display:flex;align-items:center;gap:8px">
            <span class="dot dot-pulse" id="status-dot"></span>
            <span class="panel-value" id="status-text">Active</span>
          </div>
        </div>
        <div class="toggle" id="toggle" onclick="toggleBridge()"><div class="knob"></div></div>
      </div>
    </div>

    <div class="section-title">Codex Configuration</div>
    <div class="env-box">
      <span class="key">OPENAI_BASE_URL</span>=<span class="val">http://127.0.0.1:${PROXY_PORT}/v1</span><br/>
      <span class="key">OPENAI_API_KEY</span>=<span class="val">PROXY_MANAGED</span><br/>
      <span style="color:#484f58">Config auto-injected to ~/.codex/<br/>Restart VS Code to pick up env vars</span>
    </div>
  </div>
</div>

<script>
const sunSVG='<path d="M8 1a.75.75 0 01.75.75v1.5a.75.75 0 01-1.5 0v-1.5A.75.75 0 018 1zm0 10a3 3 0 100-6 3 3 0 000 6zm0-1.5a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm5.657-5.157a.75.75 0 010 1.06l-1.06 1.061a.75.75 0 11-1.061-1.06l1.06-1.061a.75.75 0 011.061 0zM15 8a.75.75 0 01-.75.75h-1.5a.75.75 0 010-1.5h1.5A.75.75 0 0115 8zm-2.343 5.657a.75.75 0 01-1.06 0l-1.061-1.06a.75.75 0 111.06-1.061l1.061 1.06a.75.75 0 010 1.061zM8 15a.75.75 0 01-.75-.75v-1.5a.75.75 0 011.5 0v1.5A.75.75 0 018 15zm-5.657-2.343a.75.75 0 010-1.06l1.06-1.061a.75.75 0 111.061 1.06l-1.06 1.061a.75.75 0 01-1.061 0zM1 8a.75.75 0 01.75-.75h1.5a.75.75 0 010 1.5h-1.5A.75.75 0 011 8zm2.343-5.657a.75.75 0 011.06 0l1.061 1.06a.75.75 0 01-1.06 1.061L3.343 3.403a.75.75 0 010-1.06z"/>';
const moonSVG='<path d="M9.598 1.591a.75.75 0 01.785-.175 7 7 0 11-8.967 8.967.75.75 0 01.961-.96 5.5 5.5 0 007.046-7.046.75.75 0 01.175-.786z"/>';
function applyTheme(t){
  document.documentElement.setAttribute('data-theme',t);
  document.getElementById('theme-icon').innerHTML=t==='light'?sunSVG:moonSVG;
  localStorage.setItem('theme',t);
}
function toggleTheme(){applyTheme(document.documentElement.getAttribute('data-theme')==='light'?'dark':'light')}
(function(){const s=localStorage.getItem('theme')||(window.matchMedia('(prefers-color-scheme:light)').matches?'light':'dark');applyTheme(s)})();
let pollTimer=null,pollInterval=5000;
function show(v){['idle','waiting','connected'].forEach(x=>document.getElementById('view-'+x).style.display='none');document.getElementById('view-'+v).style.display='block'}
function updateToggle(on){
  const t=document.getElementById('toggle'),d=document.getElementById('status-dot'),s=document.getElementById('status-text');
  if(on){t.classList.add('on');d.className='dot dot-green dot-pulse';s.textContent='Active'}
  else{t.classList.remove('on');d.className='dot dot-gray';s.textContent='Paused'}
}
function openLink(e){
  e.preventDefault();
  const url=document.getElementById('verify-link').href;
  fetch('/api/open-url',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})});
}
function copyCode(){
  const code=document.getElementById('user-code').textContent;
  navigator.clipboard.writeText(code).then(()=>{
    const b=document.getElementById('btn-copy');b.classList.add('copied');b.innerHTML='<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg> Copied!';
    setTimeout(()=>{b.classList.remove('copied');b.innerHTML='<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25z"/></svg> Copy'},2000);
  });
}
async function startAuth(){
  const r=await fetch('/api/start',{method:'POST'});const d=await r.json();
  document.getElementById('user-code').textContent=d.user_code;
  const l=document.getElementById('verify-link');l.href=d.verification_uri;l.textContent=d.verification_uri;
  show('waiting');pollInterval=(d.interval||5)*1000;poll(d.device_code);
}
async function poll(dc){
  const r=await fetch('/api/poll',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({device_code:dc})});
  const d=await r.json();
  if(d.access_token){document.getElementById('username').textContent='@'+d.username;updateToggle(true);show('connected');return}
  if(d.error==='slow_down')pollInterval+=5000;
  pollTimer=setTimeout(()=>poll(dc),pollInterval);
}
async function toggleBridge(){
  const r=await fetch('/api/toggle',{method:'POST'});const d=await r.json();updateToggle(d.bridgeEnabled);
}
async function disconnect(){await fetch('/api/disconnect',{method:'POST'});show('idle')}
fetch('/api/status').then(r=>r.json()).then(d=>{
  if(d.connected){document.getElementById('username').textContent='@'+d.username;updateToggle(d.bridgeEnabled);show('connected')}
  else show('idle');
});
setInterval(()=>fetch('/api/status').catch(()=>{}),10000);
</script>
</body>
</html>`;
