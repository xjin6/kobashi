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
// Detect the OS-level proxy and route upstream Copilot requests through it, so
// users behind a VPN/proxy work without touching global env vars. Only the
// Bridge's own outbound traffic is affected — other apps are untouched.
//
// Supports three deployment styles transparently:
//   1. HTTP(S) system proxy   (Clash/Surge/privoxy "system proxy" mode)
//   2. SOCKS5 system proxy    (Shadowsocks, Trojan, Clash SOCKS mode)
//   3. TUN / virtual-NIC mode (Clash TUN, corporate VPN) → no proxy set,
//      traffic is captured at the network layer, so a direct connection works.
//
// Returned URL's protocol ("http:" vs "socks5:") tells the caller which tunnel
// to build. A null return means "connect directly" (covers case 3).
function detectSystemProxy() {
  // Env vars win. ALL_PROXY is the conventional home of a SOCKS proxy; the
  // HTTP(S)_PROXY vars may themselves carry a socks5:// scheme.
  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
    || process.env.ALL_PROXY || process.env.all_proxy;
  if (envProxy) {
    try { return new URL(/:\/\//.test(envProxy) ? envProxy : `http://${envProxy}`); } catch {}
  }
  try {
    if (process.platform === "darwin") {
      const out = execSync("scutil --proxy", { stdio: ["ignore", "pipe", "ignore"] }).toString();
      // Prefer an HTTP(S) proxy when present…
      if (/HTTPSEnable\s*:\s*1/.test(out) || /HTTPEnable\s*:\s*1/.test(out)) {
        const host = (out.match(/HTTPSProxy\s*:\s*([^\s]+)/) || out.match(/HTTPProxy\s*:\s*([^\s]+)/) || [])[1];
        const port = (out.match(/HTTPSPort\s*:\s*(\d+)/) || out.match(/HTTPPort\s*:\s*(\d+)/) || [])[1];
        if (host && port) return new URL(`http://${host}:${port}`);
      }
      // …otherwise fall back to a SOCKS proxy (Shadowsocks/Trojan/Clash-SOCKS).
      if (/SOCKSEnable\s*:\s*1/.test(out)) {
        const host = (out.match(/SOCKSProxy\s*:\s*([^\s]+)/) || [])[1];
        const port = (out.match(/SOCKSPort\s*:\s*(\d+)/) || [])[1];
        if (host && port) return new URL(`socks5://${host}:${port}`);
      }
    } else if (process.platform === "win32") {
      const out = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /v ProxyServer', { stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).toString();
      if (!/ProxyEnable\s+REG_DWORD\s+0x1/.test(out)) return null;
      const server = (out.match(/ProxyServer\s+REG_SZ\s+(\S+)/) || [])[1];
      if (!server) return null;
      if (server.includes("=")) {
        const parts = server.split(";");
        const httpHp = (parts.find(s => s.startsWith("https=") || s.startsWith("http=")) || "").split("=")[1];
        if (httpHp) return new URL(`http://${httpHp}`);
        const socksHp = (parts.find(s => s.startsWith("socks=")) || "").split("=")[1];
        if (socksHp) return new URL(`socks5://${socksHp}`);
      } else {
        return new URL(`http://${server}`);
      }
    }
  } catch {}
  return null;
}

// Build a CONNECT tunnel through an HTTP proxy, returning a TLS socket to the
// origin. Optional timeoutMs bounds the tunnel+TLS handshake (not the later
// stream), so a dead proxy fails fast instead of hanging the request.
function connectViaProxy(proxyUrl, targetHost, targetPort, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer = null, settled = false;
    const sock = net.connect(Number(proxyUrl.port) || 80, proxyUrl.hostname, () => {
      const auth = proxyUrl.username ? `Proxy-Authorization: Basic ${Buffer.from(decodeURIComponent(proxyUrl.username) + ":" + decodeURIComponent(proxyUrl.password || "")).toString("base64")}\r\n` : "";
      sock.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${auth}\r\n`);
    });
    const ok = (v) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); resolve(v); };
    const no = (e) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); try { sock.destroy(); } catch {} reject(e instanceof Error ? e : new Error(String(e))); };
    if (timeoutMs) timer = setTimeout(() => no(new Error("proxy timeout")), timeoutMs);
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString();
      if (buf.includes("\r\n\r\n")) {
        sock.removeListener("data", onData);
        if (!/^HTTP\/1\.[01] 200/i.test(buf)) return no(new Error(`Proxy CONNECT failed: ${buf.split("\r\n")[0]}`));
        const tlsSock = tls.connect({ socket: sock, servername: targetHost });
        tlsSock.on("secureConnect", () => ok(tlsSock));
        tlsSock.on("error", no);
      }
    };
    sock.on("data", onData);
    sock.on("error", no);
  });
}

// Build a tunnel through a SOCKS5 proxy (Shadowsocks / Trojan / Clash-SOCKS),
// returning a TLS socket to the origin. Zero-dependency RFC 1928 client with
// optional username/password (RFC 1929) auth. Sends the destination as a host
// name (ATYP=domain) so DNS is resolved on the proxy side — important when the
// origin is only reachable through the tunnel.
function connectViaSocks5(proxyUrl, targetHost, targetPort, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(proxyUrl.port) || 1080, proxyUrl.hostname);
    let timer = null, settled = false;
    const fail = (e) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); try { sock.destroy(); } catch {} reject(e instanceof Error ? e : new Error(String(e))); };
    const done = (v) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); resolve(v); };
    if (timeoutMs) timer = setTimeout(() => fail(new Error("socks timeout")), timeoutMs);
    sock.on("error", fail);

    const user = proxyUrl.username ? decodeURIComponent(proxyUrl.username) : "";
    const pass = proxyUrl.password ? decodeURIComponent(proxyUrl.password) : "";

    // Read exactly n bytes from the socket, buffering across chunks.
    let buf = Buffer.alloc(0);
    let want = null, cb = null;
    const pump = () => {
      while (want != null && buf.length >= want) {
        const out = buf.subarray(0, want); buf = buf.subarray(want);
        const f = cb; want = null; cb = null; f(out);
      }
    };
    const onData = (d) => { buf = Buffer.concat([buf, d]); pump(); };
    sock.on("data", onData);
    const read = (n, f) => { want = n; cb = f; pump(); };

    // Handshake done: stop intercepting the socket and hand any bytes that
    // arrived after the SOCKS reply back to the stream, so the TLS layer
    // sees a clean, complete byte sequence.
    const handoff = () => {
      sock.removeListener("data", onData);
      if (buf.length) sock.unshift(buf);
      const tlsSock = tls.connect({ socket: sock, servername: targetHost });
      tlsSock.on("secureConnect", () => done(tlsSock));
      tlsSock.on("error", fail);
    };

    sock.on("connect", () => {
      // Greeting: offer "no-auth" (0x00) and, if we have creds, user/pass (0x02).
      const methods = user ? [0x00, 0x02] : [0x00];
      sock.write(Buffer.from([0x05, methods.length, ...methods]));
      read(2, (rep) => {
        if (rep[0] !== 0x05) return fail(new Error("SOCKS5: bad version from proxy"));
        const method = rep[1];
        if (method === 0xff) return fail(new Error("SOCKS5: no acceptable auth method"));
        const sendConnect = () => {
          const host = Buffer.from(targetHost, "utf8");
          const req = Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
            host,
            Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
          ]);
          sock.write(req);
          read(4, (head) => {
            if (head[1] !== 0x00) return fail(new Error(`SOCKS5: connect failed (code ${head[1]})`));
            const atyp = head[3];
            const skip = atyp === 0x01 ? 4 + 2 : atyp === 0x04 ? 16 + 2 : null;
            const finish = handoff;
            if (skip != null) read(skip, finish);
            else read(1, (l) => read(l[0] + 2, finish)); // domain: 1 len byte + name + port
          });
        };
        if (method === 0x02) {
          const u = Buffer.from(user, "utf8"), p = Buffer.from(pass, "utf8");
          sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
          read(2, (a) => { if (a[1] !== 0x00) return fail(new Error("SOCKS5: auth rejected")); sendConnect(); });
        } else {
          sendConnect();
        }
      });
    });
  });
}

// ─── Auto-discovery of local proxies ──────────────────────────────────────
// When the OS advertises no proxy (detectSystemProxy → null) we first try a
// direct connection. That covers TUN-mode VPNs and corporate full-tunnel VPNs.
// But a very common real-world setup is "proxy app is running with a local
// port open, but the user never ticked 'set as system proxy'": Clash/Surge/
// v2rayN/Shadowsocks all do this. The OS shows no proxy, and a direct
// connection to Copilot fails. To make Kobashi zero-config in that case, we
// probe the well-known local proxy ports and reuse whichever can actually
// tunnel a verified TLS session to the Copilot API.
//
// Probing only happens after a direct attempt fails, so TUN / full-tunnel /
// system-proxy users never pay for it. The discovered proxy is cached and
// re-validated lazily; a failure clears the cache so a restarted proxy heals.
const PROBE_HOST = COPILOT_API; // api.githubcopilot.com — the real upstream
const PROBE_TIMEOUT = 1500;
const PROBE_CANDIDATES = [
  // [scheme, port] — ordered by popularity among GUI proxy clients.
  ["http", 7890], ["socks5", 7891],   // Clash / Clash Verge / Mihomo
  ["http", 1087], ["socks5", 1086],   // ShadowsocksX-NG (privoxy + ss-local)
  ["http", 1089], ["socks5", 1080],   // Tanpopo / generic trojan
  ["http", 6152], ["socks5", 6153],   // Surge
  ["http", 8888], ["socks5", 1081],   // Quantumult / misc
  ["http", 10809], ["socks5", 10808], // v2rayN / v2rayU
  ["http", 2080], ["socks5", 2080],   // Nekoray / sing-box default
  ["http", 8889], ["socks5", 7897],   // Clash Verge (newer), misc
];
let discoveredProxy = null;       // URL of a proxy verified to reach Copilot
let discoveredProxyAt = 0;        // timestamp of last successful verification

// Open a verified TLS socket to PROBE_HOST through one candidate. Resolves with
// the live socket on success (so the probe doubles as the real connection when
// we want it), or rejects on any failure within PROBE_TIMEOUT.
function probeCandidate(scheme, port) {
  const url = new URL(`${scheme}://127.0.0.1:${port}`);
  return scheme.startsWith("socks")
    ? connectViaSocks5(url, PROBE_HOST, 443, PROBE_TIMEOUT)
    : connectViaProxy(url, PROBE_HOST, 443, PROBE_TIMEOUT);
}

// Find a local proxy that can reach Copilot. Probes all candidates in parallel
// and returns the URL of the first that completes a verified TLS handshake.
// Returns null if none work (caller then surfaces the original direct error).
async function discoverLocalProxy() {
  // Reuse a recently-verified proxy without re-scanning.
  if (discoveredProxy && Date.now() - discoveredProxyAt < 60000) return discoveredProxy;
  const attempts = PROBE_CANDIDATES.map(([scheme, port]) =>
    probeCandidate(scheme, port).then(
      (sock) => { try { sock.destroy(); } catch {} return new URL(`${scheme}://127.0.0.1:${port}`); },
      () => null,
    ));
  const results = await Promise.all(attempts);
  const hit = results.find(Boolean) || null;
  if (hit) { discoveredProxy = hit; discoveredProxyAt = Date.now(); dbg(`[Bridge] Auto-discovered local proxy ${hit.protocol}//${hit.host}`); }
  return hit;
}

// Open a TLS socket to hostname:443 through whatever route works:
//   1. An OS-advertised proxy (HTTP CONNECT or SOCKS5), if any.
//   2. A direct connection (covers TUN-mode and full-tunnel VPNs).
//   3. An auto-discovered local proxy (covers "proxy running but not set as
//      system proxy"), validated against the Copilot API.
// Returns a connected TLS socket, or null to mean "use a plain direct request".
async function connectUpstream(hostname) {
  const proxyUrl = detectSystemProxy();
  if (proxyUrl) {
    const scheme = (proxyUrl.protocol || "").replace(":", "").toLowerCase();
    dbg(`[Bridge] Routing via ${scheme} proxy ${proxyUrl.hostname}:${proxyUrl.port}`);
    if (scheme.startsWith("socks")) return connectViaSocks5(proxyUrl, hostname, 443, 8000);
    return connectViaProxy(proxyUrl, hostname, 443, 8000);
  }

  // No system proxy. Prefer a previously-discovered local proxy if we have one.
  if (discoveredProxy && Date.now() - discoveredProxyAt < 60000) {
    const scheme = discoveredProxy.protocol.replace(":", "");
    try {
      return scheme.startsWith("socks")
        ? await connectViaSocks5(discoveredProxy, hostname, 443, 8000)
        : await connectViaProxy(discoveredProxy, hostname, 443, 8000);
    } catch { discoveredProxy = null; } // stale → fall through to re-probe
  }

  // Try a direct connection first (TUN / full-tunnel VPN succeed here).
  try {
    const direct = await directTlsConnect(hostname, 2500);
    return direct;
  } catch (e) {
    // Direct failed — maybe a proxy is running but not set as system proxy.
    const found = await discoverLocalProxy();
    if (!found) throw e; // nothing works; surface the original direct error
    const scheme = found.protocol.replace(":", "");
    return scheme.startsWith("socks")
      ? connectViaSocks5(found, hostname, 443, 8000)
      : connectViaProxy(found, hostname, 443, 8000);
  }
}

// Plain direct TLS connection with a bounded handshake timeout.
function directTlsConnect(hostname, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const s = tls.connect({ host: hostname, port: 443, servername: hostname });
    const timer = timeoutMs ? setTimeout(() => { if (!settled) { settled = true; try { s.destroy(); } catch {} reject(new Error("direct timeout")); } }, timeoutMs) : null;
    s.on("secureConnect", () => { if (settled) return; settled = true; if (timer) clearTimeout(timer); resolve(s); });
    s.on("error", (e) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); reject(e); });
  });
}

// Issue an HTTPS request, tunneling through the system proxy if one is set.
// Returns a Promise<ClientRequest> because proxy CONNECT is async.
async function upstreamHttpsRequest(options, onResponse) {
  const socket = await connectUpstream(options.hostname);
  if (!socket) return https.request(options, onResponse);
  // When we supply our own pre-tunneled socket via createConnection, Node no
  // longer infers the port, so it would emit a "Host: <host>:80" header that
  // some origins (e.g. GitHub) reject with 400. Pin port + servername so the
  // generated Host header and SNI are correct.
  return https.request({ port: 443, servername: options.hostname, ...options, createConnection: () => socket }, onResponse);
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
    try { execSync(`setx NO_PROXY "127.0.0.1,localhost"`, { stdio: "ignore", windowsHide: true }); } catch {}
  } else if (process.platform === "darwin") {
    try { execSync("launchctl setenv OPENAI_API_KEY PROXY_MANAGED", { stdio: "ignore" }); } catch {}
    try { execSync(`launchctl setenv OPENAI_BASE_URL http://127.0.0.1:${PROXY_PORT}/v1`, { stdio: "ignore" }); } catch {}
    // CRITICAL: Codex's Rust HTTP client honours system proxy. If user has a system
    // HTTP proxy (Clash etc.) at 127.0.0.1:1089, codex's request to our local 18921
    // would be intercepted by the proxy and silently dropped. Bypass for loopback.
    try { execSync(`launchctl setenv NO_PROXY "127.0.0.1,localhost"`, { stdio: "ignore" }); } catch {}
    try { execSync(`launchctl setenv no_proxy "127.0.0.1,localhost"`, { stdio: "ignore" }); } catch {}
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

// Env vars that other Claude Code config switchers (e.g. cc-switch) may write into
// settings.json and which silently override Claude Code's model picker. Bridge has
// to strip these on inject AND on restore — otherwise Claude Code sends a model
// ID Copilot has never heard of and surfaces "model not supported".
const CLAUDE_MODEL_ENV_KEYS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_CUSTOM_HEADERS",
];

function writeClaudeConfig() {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  // Refresh .bak whenever the live settings.json is NOT a kobashi-managed state
  // (i.e. some other tool — cc-switch, the user, etc. — has written to it since
  // we last touched it). This way, toggling kobashi off correctly restores
  // whatever was there *just before* kobashi took over, not a stale ancient snapshot.
  let live = null;
  try {
    if (fs.existsSync(CLAUDE_SETTINGS))
      live = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, "utf-8"));
  } catch {}
  const liveIsKobashi = live && live.env && live.env.ANTHROPIC_BASE_URL === `http://127.0.0.1:${CLAUDE_PORT}` && live.env.ANTHROPIC_AUTH_TOKEN === "PROXY_MANAGED";
  if (fs.existsSync(CLAUDE_SETTINGS) && !liveIsKobashi) {
    fs.copyFileSync(CLAUDE_SETTINGS, CLAUDE_SETTINGS + ".bak");
  }

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
  // Strip any model-routing env vars that other tools (cc-switch etc.) may have
  // left behind — Claude Code reads several of these and they silently override
  // the model picker into IDs that the Copilot backend doesn't expose.
  for (const k of CLAUDE_MODEL_ENV_KEYS) delete settings.env[k];

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
        for (const k of CLAUDE_MODEL_ENV_KEYS) delete s.env[k];
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
// Most-recent Claude model mapping, surfaced in the UI status bar so the user
// can see what Claude Code asked for vs. what we actually sent to Copilot
// (e.g. opus-4.8[1m] downgraded to opus-4.8 because Copilot has no 1M variant).
let lastModelMap = null; // { requested, sent, downgraded, note, at }
// When set, kobashi ignores whatever Claude Code requests and forces this model.
// null = pass-through (no override).
let claudeModelOverride = null;

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
  const data = await new Promise(async (resolve, reject) => {
    try {
      const r = await upstreamHttpsRequest({
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
    } catch (e) { reject(e); }
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
  // Removed: no longer synthesise fake [1m] variants.
  // Only expose models Copilot actually provides — what you pick is what gets sent.
  // For true 1M context, select a model Copilot natively offers (e.g. claude-opus-4.6-1m).
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
  // GET /v1/models — Codex CLI uses this as a health-check / model picker.
  // Copilot doesn't expose this endpoint, so return a static list of the
  // models Copilot actually supports via the Responses API.
  if (req.method === "GET" && (req.url === "/v1/models" || req.url.startsWith("/v1/models?"))) {
    // Only models Copilot's Responses API actually accepts (probed empirically).
    const models = [
      "gpt-5.2-codex", "gpt-5.3-codex",
      "gpt-5.2", "gpt-5.4", "gpt-5.5",
      "gpt-5.4-mini", "gpt-5-mini",
    ];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: models.map(id => ({ id, object: "model", created: 0, owned_by: "copilot" })),
    }));
    return;
  }
  const bodyChunks = [];
  for await (const chunk of req) bodyChunks.push(chunk);
  let bodyBuf = Buffer.concat(bodyChunks);
  // Map legacy / canonical model ids Codex sends to ones Copilot's Responses API accepts.
  // Codex defaults to "gpt-5-codex" / "gpt-5" which Copilot rejects — translate to a
  // versioned sibling. Body is mutated only when model field is present and recognized.
  if (req.method === "POST" && bodyBuf.length && req.url.includes("/responses")) {
    try {
      const j = JSON.parse(bodyBuf.toString());
      if (j.model) {
        const codexModelMap = {
          "gpt-5": "gpt-5.5",
          "gpt-5-codex": "gpt-5.2-codex",
          "gpt-4.1": "gpt-5.4",     // 4.1 family not in Responses API; use closest 5.x
          "gpt-4o": "gpt-5.4",
          "gpt-4o-mini": "gpt-5.4-mini",
          "o3": "gpt-5.5",
          "o4-mini": "gpt-5.4-mini",
        };
        const original = j.model;
        if (codexModelMap[j.model]) {
          j.model = codexModelMap[j.model];
          bodyBuf = Buffer.from(JSON.stringify(j));
          log(`[Codex] model ${original} → ${j.model}`);
        }
      }
    } catch {}
  }
  try {
    const token = await ensureCopilotToken();
    const p = req.url.startsWith("/v1") ? req.url : `/v1${req.url}`;
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": bodyBuf.length,  // Use the potentially-modified body length
      Authorization: `Bearer ${token}`,
      "Editor-Version": "vscode/1.110.1", "Editor-Plugin-Version": "copilot-chat/0.38.2",
      "User-Agent": "GitHubCopilotChat/0.38.2", "Copilot-Integration-Id": "vscode-chat",
      "X-GitHub-Api-Version": "2025-10-01",
    };
    const upstream = await upstreamHttpsRequest({
      hostname: COPILOT_API, path: p, method: req.method, headers,
    }, (upstreamRes) => {
      dbg(`[Codex] ${req.method} ${p} → ${upstreamRes.statusCode}`);
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
    const contentParts = [];     // multimodal parts (text + image_url) for this message
    const toolCalls = [];
    const toolResults = [];
    const deferredImages = [];    // images pulled out of tool_result, re-attached below

    // Anthropic image block → OpenAI image_url part. Supports base64 and url sources.
    const toImagePart = (src) => {
      if (!src) return null;
      if (src.type === "base64" && src.data)
        return { type: "image_url", image_url: { url: `data:${src.media_type || "image/png"};base64,${src.data}` } };
      if (src.type === "url" && src.url)
        return { type: "image_url", image_url: { url: src.url } };
      return null;
    };

    for (const b of m.content || []) {
      if (b.type === "text") contentParts.push({ type: "text", text: b.text || "" });
      else if (b.type === "image") {
        const p = toImagePart(b.source);
        if (p) contentParts.push(p);
      } else if (b.type === "document") {
        // Anthropic 'document' blocks (e.g. Claude Code reading a PDF). The Copilot
        // chat/completions endpoint REJECTS pdf parts (verified: 400 "Could not
        // process image" / "type has to be image_url or text"), so we can't pass
        // them through. Degrade loudly: surface any caller-provided plaintext, else
        // a clear placeholder, so the turn doesn't 400 and the model knows why.
        const src = b.source || {};
        if (src.type === "text" && src.data) {
          contentParts.push({ type: "text", text: `[document${b.title ? " " + b.title : ""}]\n${src.data}` });
        } else if (src.type === "content" && Array.isArray(src.content)) {
          const t = src.content.filter(x => x.type === "text").map(x => x.text || "").join("\n");
          contentParts.push({ type: "text", text: `[document${b.title ? " " + b.title : ""}]\n${t}` });
        } else {
          contentParts.push({ type: "text", text: `[document${b.title ? " " + b.title : ""} omitted — this backend cannot accept binary PDFs; ask the user to paste the relevant text]` });
        }
      } else if (b.type === "tool_use") {
        toolCalls.push({
          id: b.id, type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input || {}) }
        });
      } else if (b.type === "tool_result") {
        const blocks = typeof b.content === "string"
          ? [{ type: "text", text: b.content }]
          : (b.content || []);
        const textChunks = [];
        for (const x of blocks) {
          if (x.type === "image") {
            const p = toImagePart(x.source);
            if (p) deferredImages.push(p);
          } else {
            textChunks.push(x.text || "");
          }
        }
        let rc = textChunks.join("\n");
        if (!rc && deferredImages.length) rc = "[image returned by tool — see attached image below]";
        // OpenAI tool messages have no is_error flag, so fold Anthropic's error
        // signal into the text — otherwise the model can't tell a tool failed.
        if (b.is_error) rc = `[tool error] ${rc}`;
        toolResults.push({ role: "tool", tool_call_id: b.tool_use_id, content: rc });
      }
    }
    if (toolResults.length) {
      for (const tr of toolResults) messages.push(tr);
      // OpenAI tool-role messages can't carry images, so any image a tool returned
      // (e.g. Read on a screenshot) is re-attached as a follow-up user message —
      // this is what lets vision models actually see tool-produced images.
      if (deferredImages.length) messages.push({ role: "user", content: deferredImages });
      continue;
    }
    const msg = { role: m.role };
    const hasImage = contentParts.some(p => p.type === "image_url");
    if (hasImage) {
      msg.content = contentParts;            // keep multimodal array so the image survives
    } else {
      const text = contentParts.map(p => p.text).join("\n");
      if (text) msg.content = text;
    }
    if (toolCalls.length) { msg.tool_calls = toolCalls; if (!msg.content) msg.content = null; }
    messages.push(msg);
  }

  const out = {
    model: req.model || CLAUDE_MODEL,
    messages,
    stream: !!req.stream,
  };
  // Ask the upstream to include token usage in the streaming response, otherwise
  // streamed turns report input_tokens:0 and Claude Code's context meter is blind.
  if (req.stream) out.stream_options = { include_usage: true };
  if (req.max_tokens) out.max_tokens = req.max_tokens;
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.stop_sequences) out.stop = req.stop_sequences;
  if (req.metadata && req.metadata.user_id) out.user = req.metadata.user_id;
  // Effort slider → reasoning_effort. Claude Code maps its Effort control to
  // thinking.budget_tokens (≈1024 low … up to --max-thinking-tokens, e.g. 31999).
  // Copilot ignores budget_tokens itself, but DOES honor OpenAI reasoning_effort
  // (verified empirically: low avg ~396 vs high ~864 chars of reasoning, fully
  // separated distributions). So we bucket the budget into low/medium/high.
  if (req.thinking && req.thinking.type === "enabled" && typeof req.thinking.budget_tokens === "number") {
    const b = req.thinking.budget_tokens;
    out.reasoning_effort = b <= 4096 ? "low" : b <= 16000 ? "medium" : "high";
  }
  if (req.tools) {
    out.tools = req.tools.map(t => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema }
    }));
  }
  // Anthropic tool_choice → OpenAI tool_choice. Without this, Claude Code's
  // "force this tool" / "must use a tool" semantics were silently lost and the
  // model was free to answer in prose instead of calling the tool it was told to.
  // Verified upstream: Copilot honors "auto" / "required" / "none" / {function}.
  if (req.tool_choice && typeof req.tool_choice === "object") {
    const tc = req.tool_choice;
    if (tc.type === "auto") out.tool_choice = "auto";
    else if (tc.type === "any") out.tool_choice = "required";
    else if (tc.type === "none") out.tool_choice = "none";
    else if (tc.type === "tool" && tc.name)
      out.tool_choice = { type: "function", function: { name: tc.name } };
    if (tc.disable_parallel_tool_use) out.parallel_tool_calls = false;
  }
  return out;
}

function openAIToAnthropicResponse(oai, model) {
  const choice = (oai.choices || [{}])[0];
  const msg = choice.message || {};
  const content = [];
  // Reasoning (Copilot streams/returns the model's chain-of-thought as
  // reasoning_text, with an opaque signature in reasoning_opaque). Emit it as a
  // proper Anthropic thinking block FIRST so it renders as the model's thinking.
  if (msg.reasoning_text) {
    const tb = { type: "thinking", thinking: msg.reasoning_text };
    if (msg.reasoning_opaque) tb.signature = msg.reasoning_opaque;
    content.push(tb);
  }
  if (msg.content) content.push({ type: "text", text: msg.content });
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc.function.arguments || "{}"); } catch {}
      content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
    }
  }
  const stopReasonMap = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use", content_filter: "end_turn" };
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
  // Dynamic block-index allocator. Anthropic requires content blocks to be
  // indexed in the order they are opened. A response may contain a thinking
  // block, then text, then one or more tool_use blocks — so we can no longer
  // hardcode text=0. Whatever opens first gets the next free index.
  let nextIndex = 0;
  let thinkingIndex = -1, thinkingOpen = false, sigSent = false, pendingSig = null;
  let textIndex = -1, textBlockOpen = false;
  let toolBlocks = {}; // openai tool index -> { anthIndex, id, name, jsonBuf }
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

  // Thinking must be fully emitted and closed before any text/tool block opens,
  // because Anthropic blocks can't interleave. When text or a tool arrives we
  // first flush the signature (if upstream gave one) and stop the thinking block.
  function closeThinking() {
    if (!thinkingOpen) return;
    if (pendingSig && !sigSent) {
      send("content_block_delta", { type: "content_block_delta", index: thinkingIndex, delta: { type: "signature_delta", signature: pendingSig } });
      sigSent = true;
    }
    send("content_block_stop", { type: "content_block_stop", index: thinkingIndex });
    thinkingOpen = false;
  }

  function closeOpenBlocks() {
    closeThinking();
    if (textBlockOpen) {
      send("content_block_stop", { type: "content_block_stop", index: textIndex });
      textBlockOpen = false;
    }
    for (const k of Object.keys(toolBlocks)) {
      send("content_block_stop", { type: "content_block_stop", index: toolBlocks[k].anthIndex });
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

        // ── Reasoning / thinking deltas (Copilot: delta.reasoning_text) ──
        if (delta.reasoning_text) {
          if (!thinkingOpen) {
            thinkingIndex = nextIndex++;
            thinkingOpen = true;
            send("content_block_start", { type: "content_block_start", index: thinkingIndex, content_block: { type: "thinking", thinking: "", signature: "" } });
          }
          send("content_block_delta", { type: "content_block_delta", index: thinkingIndex, delta: { type: "thinking_delta", thinking: delta.reasoning_text } });
        }
        // Opaque thinking signature arrives once; emit it when we close the block.
        if (delta.reasoning_opaque) pendingSig = delta.reasoning_opaque;

        // ── Text deltas ──
        if (delta.content) {
          closeThinking();
          if (!textBlockOpen) {
            textIndex = nextIndex++;
            textBlockOpen = true;
            send("content_block_start", { type: "content_block_start", index: textIndex, content_block: { type: "text", text: "" } });
          }
          send("content_block_delta", { type: "content_block_delta", index: textIndex, delta: { type: "text_delta", text: delta.content } });
        }

        // ── Tool-call deltas ──
        if (delta.tool_calls) {
          closeThinking();
          for (const tc of delta.tool_calls) {
            const key = tc.index !== undefined ? tc.index : 0;
            if (!toolBlocks[key]) {
              const anthIndex = nextIndex++;
              toolBlocks[key] = { anthIndex, id: tc.id || `tool_${anthIndex}`, name: (tc.function && tc.function.name) || "", jsonBuf: "" };
              send("content_block_start", {
                type: "content_block_start", index: anthIndex,
                content_block: { type: "tool_use", id: toolBlocks[key].id, name: toolBlocks[key].name, input: {} },
              });
            }
            const block = toolBlocks[key];
            if (tc.id) block.id = tc.id;
            if (tc.function && tc.function.name) block.name = tc.function.name;
            if (tc.function && tc.function.arguments) {
              block.jsonBuf += tc.function.arguments;
              send("content_block_delta", {
                type: "content_block_delta", index: block.anthIndex,
                delta: { type: "input_json_delta", partial_json: tc.function.arguments },
              });
            }
          }
        }
        if (finish) {
          const map = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use", content_filter: "end_turn" };
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
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
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
    // Tool DEFINITIONS are part of the prompt and can be 10-20K tokens in Claude
    // Code (its toolset is large). Omitting them made the estimate skew badly low,
    // which mis-triggers auto-compaction / context-overflow in Claude Code.
    if (Array.isArray(body.tools)) {
      for (const t of body.tools) {
        chars += (t.name || "").length + (t.description || "").length;
        if (t.input_schema) chars += JSON.stringify(t.input_schema).length;
      }
    }
    for (const m of body.messages || []) {
      if (typeof m.content === "string") chars += m.content.length;
      else for (const b of m.content || []) {
        if (b.type === "text") chars += (b.text || "").length;
        else if (b.type === "image") chars += 4000; // rough flat cost so images aren't counted as zero
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
  // If the user pinned a model in the kobashi UI, it overrides whatever Claude Code sent.
  if (claudeModelOverride) oaiReq.model = claudeModelOverride;
  // Remap the requested model to one Copilot actually exposes
  const requestedModel = oaiReq.model; // what Claude Code asked for (after override), before mapping
  try {
    const mapped = await mapClaudeModel(oaiReq.model);
    if (mapped !== oaiReq.model) dbg(`[Claude] model ${oaiReq.model} → ${mapped}`);
    oaiReq.model = mapped;
  } catch (e) {
    dbg("[Claude] model list fetch failed, using default:", e.message);
    oaiReq.model = CLAUDE_MODEL;
  }
  const model = oaiReq.model;

  // Record the mapping for the UI status bar. "downgraded" flags the common case
  // where the user picked a [1m] context that Copilot doesn't expose, so we
  // silently fell back to the 200k base — the user deserves to see that.
  {
    const askedFor1m = /\[1m\]$/i.test(requestedModel || "") || /-1m\b/i.test(requestedModel || "");
    const sent1m = /-1m\b/i.test(model || "");
    const downgraded = askedFor1m && !sent1m;
    lastModelMap = {
      requested: requestedModel || "(default)",
      sent: model,
      downgraded,
      note: downgraded ? "No 1M variant on Copilot, downgraded to 200K" : "",
      at: Date.now(),
    };
    if (downgraded) log(`[Claude] ⚠ ${requestedModel} → ${model} (no 1M on Copilot, downgraded to 200K)`);
    else dbg(`[Claude] mapped ${requestedModel} → ${model}`);
  }

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
    let claudeModels = [];
    // Expose the raw Copilot id (dot format) as the value so override sends exactly what Copilot expects.
    try { claudeModels = (await getClaudeCodeFacingModels()).map(m => ({ id: m._copilot, name: m.name })); } catch {}
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ connected: !!githubToken, username, codexEnabled, claudeEnabled, proxyPort: PROXY_PORT, claudePort: CLAUDE_PORT, lastModelMap, claudeModelOverride, claudeModels })); return;
  }
  if (req.method === "POST" && req.url === "/api/set-claude-model") {
    if (!githubToken) { res.writeHead(400); res.end(JSON.stringify({ error: "Not connected" })); return; }
    const chunks = []; for await (const c of req) chunks.push(c);
    const { model } = JSON.parse(Buffer.concat(chunks).toString());
    claudeModelOverride = model || null; // null = clear override (pass-through)
    log(`[Claude] model override → ${claudeModelOverride || "(pass-through)"}`);
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ claudeModelOverride })); return;
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
