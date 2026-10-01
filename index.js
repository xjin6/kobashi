const http = require("http");
const https = require("https");
const net = require("net");
const tls = require("tls");
const fs = require("fs");
const path = require("path");
const { execSync, spawn } = require("child_process");
const {
  injectCodexConfig,
  restoreCodexConfigContents,
  isKobashiManagedConfig,
  isKobashiManagedAuth,
} = require("./lib/codex-config");
const {
  EMPTY_CATALOG_MODEL_ID,
  buildKobashiModelCatalog,
  loadBundledCodexModelCatalog,
  writeModelCatalogAtomic,
  getKobashiModelCatalogPath,
  selectCopilotOpenAIModels,
} = require("./lib/codex-model-catalog");
const { createResponsesSseNormalizer } = require("./lib/responses-sse-normalizer");
const { normalizeCodexRequest, retryCodexRequest } = require("./lib/codex-request-compat");
const { CodexModelCapabilities } = require("./lib/codex-model-capabilities");
const { CodexClientLifecycle } = require("./lib/codex-client-lifecycle");
const { probeCodexModel } = require("./lib/codex-model-probe");
const { createCodexProbeTransport } = require("./lib/codex-probe-transport");

const DEBUG = process.argv.includes("--debug");
const log = (...a) => console.log(...a);
const dbg = (...a) => { if (DEBUG) console.log(...a); };

// ─── Last-resort crash guards ──────────────────────────────────────────────
// The bridge proxies long-lived streaming responses. A single unhandled error
// on any socket/stream (upstream reset mid-response, a listener that throws)
// would otherwise take the whole process down — turning one failed request into
// "Connection closed mid-response" and then ConnectionRefused for every request
// after, since nothing is left listening on the proxy ports. Log and keep
// serving instead; the affected request already failed, but the bridge lives.
process.on("uncaughtException", (e) => {
  log(`[Bridge] uncaughtException (ignored, staying up): ${e && e.stack ? e.stack : e}`);
});
process.on("unhandledRejection", (e) => {
  log(`[Bridge] unhandledRejection (ignored, staying up): ${e && e.stack ? e.stack : e}`);
});

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
      spawn(BROWSER_PATH, [`--app=${url}`, "--window-size=400,560", "--no-default-browser-check"], {
        detached: true, stdio: "ignore",
      }).unref();
    } else {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } else {
    if (BROWSER_PATH) {
      // Anti-freeze flags: stop Edge/Chrome from throttling or suspending this
      // window's timers when it's backgrounded/minimized/occluded, so the UI's
      // status polling keeps running instead of the window going to 0 K working
      // set. Best-effort (ignored if the browser is already running), which is
      // why the real fix is the pagehide beacon + removal of the suicide watchdog.
      const antiFreeze = "--disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding";
      execSync(`start "" "${BROWSER_PATH}" --app=${url} --window-size=400,560 ${antiFreeze}`, { stdio: "ignore", shell: true, windowsHide: true });
    } else {
      execSync(`start "" "${url}"`, { stdio: "ignore", shell: true, windowsHide: true });
    }
  }
}

const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const COPILOT_API = "api.githubcopilot.com";
// Version + release date shown in the UI footer. The footer used to hard-code
// these in ui.html, which silently drifted from package.json (v1.9.2 shipped
// still displaying "v1.9.1"). Read from package.json when running from source;
// pkg has no package.json at runtime, so scripts/build-*.sh stamps the literals
// below at build time. Either way there is exactly one source of truth per build.
let APP_VERSION = "0.0.0", APP_DATE = "";
/* BUILD_STAMP */
if (APP_VERSION === "0.0.0") {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf-8"));
    APP_VERSION = pkg.version || APP_VERSION;
  } catch {}
}
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
  // A long streaming turn can idle for tens of seconds while the model "thinks"
  // with no bytes flowing. On our self-managed upstream socket Node applies no
  // idle timeout and no TCP keep-alive by default, so a NAT / proxy / OS can
  // silently drop the connection mid-response — which the client then reports as
  // "Connection closed mid-response". Enable keep-alive probes and pin the idle
  // timeout to "never" so the socket stays healthy across quiet stretches.
  // (node22's socket defaults differ from node18/20, which is why this only
  // started biting on the Windows build.)
  try { socket.setKeepAlive(true, 15000); socket.setTimeout(0); } catch {}
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

// No longer templated: the UI used to print the port numbers in a config panel,
// but the ports are written straight into ~/.codex and ~/.claude/settings.json,
// so showing them was asking the reader to check work already done for them.
const HTML = getAssetText("ui.html");

// ─── Codex config paths ────────────────────────────────────────────────────
// Codex supports relocating its home directory. Honor that before falling back
// to the conventional ~/.codex path so Kobashi config reaches the same install
// the user is actually running.
const CODEX_DIR = path.resolve(
  process.env.CODEX_HOME || path.join(process.env.HOME || process.env.USERPROFILE, ".codex"),
);
const CODEX_AUTH = path.join(CODEX_DIR, "auth.json");
const CODEX_CONFIG = path.join(CODEX_DIR, "config.toml");
const CODEX_MODEL_CATALOG = getKobashiModelCatalogPath();
let codexModelSessionStarted = false;
let codexModelSessionAwaitingClient = false;
let codexModelSessionRequest = null;
let codexModelSessionGeneration = 0;
let codexBundledCatalog = { models: [] };
const requestCodexProbe = createCodexProbeTransport({
  request: upstreamHttpsRequest, token: ensureCopilotToken, hostname: COPILOT_API,
  invalidateToken: () => { copilotToken = null; copilotTokenExpiry = 0; },
  isAuthFailure: isAuthFailureBody,
});
const codexCapabilities = new CodexModelCapabilities({
  probe: (model, native) => probeCodexModel(model, native, requestCodexProbe),
  cachePath: path.join(path.dirname(CODEX_MODEL_CATALOG), "codex-model-capabilities.json"),
  onChange: () => {
    if (githubToken && codexEnabled) {
      try { publishCodexModelCatalog(); }
      catch (error) { dbg("[Codex] capability catalog publish failed:", error.message); }
    }
  },
});

const codexClientWatcher = new CodexClientLifecycle({
  onStart: ({ initial }) => {
    // The first request can arrive before the first process snapshot. Treat
    // those as one startup, not two paid validation rounds.
    if (codexModelSessionStarted && (initial || codexModelSessionAwaitingClient)) {
      codexModelSessionAwaitingClient = false;
      return;
    }
    if (githubToken && codexEnabled) return beginCodexModelSession();
  },
  onStop: () => {
    codexModelSessionGeneration++;
    codexModelSessionStarted = false;
    codexModelSessionAwaitingClient = false;
    codexModelSessionRequest = null;
    codexCapabilities.pause();
  },
  onError: error => dbg("[Codex] local client detection failed:", error.message),
});

function writeTextAtomic(filePath, contents, mode) {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    fs.writeFileSync(tempPath, contents, {
      encoding: "utf8",
      flag: "wx",
      ...(mode === undefined ? {} : { mode }),
    });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch {}
    throw error;
  }
}

function readCodexModelCatalog() {
  try {
    const catalog = JSON.parse(fs.readFileSync(CODEX_MODEL_CATALOG, "utf8"));
    if (!catalog || !Array.isArray(catalog.models)) return null;
    // Codex requires a non-empty on-disk catalog. Its disabled storage sentinel
    // represents an empty picker and must never appear in the models endpoint.
    return { ...catalog, models: catalog.models.filter(model => model.slug !== EMPTY_CATALOG_MODEL_ID) };
  } catch {
    return null;
  }
}

function beginCodexModelSession({ awaitingClient = false } = {}) {
  const generation = ++codexModelSessionGeneration;
  codexModelSessionStarted = true;
  codexModelSessionAwaitingClient = awaitingClient;
  codexCapabilities.pause();
  const request = refreshCodexModelCatalog({ force: true, revalidate: true,
    sessionGeneration: generation }).finally(() => {
    if (codexModelSessionRequest === request) codexModelSessionRequest = null;
  });
  codexModelSessionRequest = request;
  return request;
}

function ensureCodexModelSession() {
  if (!codexModelSessionStarted) return beginCodexModelSession({ awaitingClient: true });
  return codexModelSessionRequest || Promise.resolve();
}

async function refreshCodexModelCatalog(options = {}) {
  const account = githubToken;
  codexCapabilities.setAccount(account);
  codexCapabilities.resume();
  let copilotModels;
  try {
    copilotModels = Object.hasOwn(options, "copilotModels")
      ? options.copilotModels : await getCopilotModelsRaw({ force: !!options.force });
  } catch (error) {
    dbg("[Codex] model discovery unavailable; retaining the last verified snapshot:", error.message);
  }
  if (githubToken !== account || !codexEnabled || (options.sessionGeneration !== undefined &&
      options.sessionGeneration !== codexModelSessionGeneration)) {
    return { catalogPath: CODEX_MODEL_CATALOG, catalog: { models: [] } };
  }
  try {
    // Re-read native capabilities independently of the Copilot catalog. No
    // model-name table or rebuild is needed for a new native model/Ultra mode.
    codexBundledCatalog = loadBundledCodexModelCatalog({ timeout: 5000 });
  } catch (error) {
    dbg("[Codex] native capability refresh unavailable:", error.message);
  }
  if (copilotModels !== undefined) codexCapabilities.update(copilotModels, codexBundledCatalog, {
    revalidate: !!options.revalidate,
  });
  return publishCodexModelCatalog();
}

function publishCodexModelCatalog() {
  const before = readCodexModelCatalog();
  const catalog = codexCapabilities.hasSnapshot
    ? buildKobashiModelCatalog(codexBundledCatalog, codexCapabilities.models())
    // v2.1.5 saved verdicts without discovery metadata. Migrate only entries
    // proven for this account; never preserve another account's picker.
    : { models: (before?.models || []).filter(model => codexCapabilities.wasVerified(model.slug)) };
  writeModelCatalogAtomic(CODEX_MODEL_CATALOG, catalog);
  const result = { catalogPath: CODEX_MODEL_CATALOG, catalog };
  const changed = JSON.stringify(before) !== JSON.stringify(catalog);
  if (changed) {
    log(`[Codex] live models: ${result.catalog.models.map(model => model.slug).join(", ")}`);
    // The native app server reads model_catalog_json only at process start.
    // Rewriting config.toml (even with new contents) does not refresh model/list.
    // Keep the file ready for the next launch instead of sending fake nudges.
  }
  return { ...result, changed };
}

function stopCodexClientWatch() {
  codexClientWatcher.stop();
  codexModelSessionGeneration++;
  codexModelSessionStarted = false;
  codexModelSessionAwaitingClient = false;
  codexModelSessionRequest = null;
  codexCapabilities.pause();
}

function startCodexClientWatch() {
  // Polling here inspects local process IDs only. Remote discovery and real
  // inference checks are triggered by a new client process, never a clock.
  void codexClientWatcher.start();
}

async function writeCodexConfig() {
  const account = githubToken;
  fs.mkdirSync(CODEX_DIR, { recursive: true });

  const authExists = fs.existsSync(CODEX_AUTH);
  const authSource = authExists ? fs.readFileSync(CODEX_AUTH, "utf-8") : "";
  if (authExists && !isKobashiManagedAuth(authSource)) {
    writeTextAtomic(CODEX_AUTH + ".bak", authSource, 0o600);
  }

  const configExists = fs.existsSync(CODEX_CONFIG);
  const backupPath = CODEX_CONFIG + ".bak";
  const backupExists = fs.existsSync(backupPath);
  let src = "";
  if (configExists) src = fs.readFileSync(CODEX_CONFIG, "utf-8");
  // Refresh the baseline whenever the live file belongs to the user (or
  // another tool), rather than trusting an old .bak that Kobashi may itself
  // have created in a previous version.
  if (configExists && !isKobashiManagedConfig(src)) {
    writeTextAtomic(backupPath, src);
  } else if (!configExists && backupExists) {
    const candidate = fs.readFileSync(backupPath, "utf-8");
    src = isKobashiManagedConfig(candidate)
      ? restoreCodexConfigContents(candidate, "", { modelCatalogPath: CODEX_MODEL_CATALOG })
      : candidate;
  }

  let modelCatalogPath = "";
  try {
    codexCapabilities.setAccount(githubToken);
    let prepared = publishCodexModelCatalog();
    if (!prepared.catalog.models.length) {
      // First install / account switch: prepare an actual verified directory
      // before injecting its path. The watcher adopts this same startup round.
      await ensureCodexModelSession();
      await codexCapabilities.idle();
      prepared = publishCodexModelCatalog();
    }
    modelCatalogPath = prepared.catalogPath;
  } catch (error) {
    dbg("[Bridge] model catalog write failed:", error.message);
  }

  if (githubToken !== account || !codexEnabled) return;
  // First-time validation can take a while; preserve any user edits made while
  // it was running instead of injecting into the pre-validation file contents.
  if (fs.existsSync(CODEX_CONFIG)) {
    src = fs.readFileSync(CODEX_CONFIG, "utf8");
    if (!isKobashiManagedConfig(src)) writeTextAtomic(backupPath, src);
  }
  if (fs.existsSync(CODEX_AUTH)) {
    const currentAuth = fs.readFileSync(CODEX_AUTH, "utf8");
    if (!isKobashiManagedAuth(currentAuth)) writeTextAtomic(CODEX_AUTH + ".bak", currentAuth, 0o600);
  }

  writeTextAtomic(
    CODEX_AUTH,
    `${JSON.stringify({ OPENAI_API_KEY: "PROXY_MANAGED" }, null, 2)}\n`,
    0o600,
  );

  // The live file may have been edited since the backup was created. Always
  // merge from it first; the backup is only the restoration baseline.
  writeTextAtomic(
    CODEX_CONFIG,
    injectCodexConfig(src, PROXY_PORT, { modelCatalogPath }),
  );

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
  startCodexClientWatch();
  log("[Bridge] Codex config injected");
}

// Remove only what writeCodexConfig() injected, leaving every other section
// intact. Deleting the whole file (the old behaviour when no .bak existed) took
// the user's notify/marketplaces/plugins config with it.
function stripInjectedCodexConfig(backupSource = "", restoreEmptyFile = false) {
  try {
    const src = fs.readFileSync(CODEX_CONFIG, "utf-8");
    const out = restoreCodexConfigContents(src, backupSource, {
      modelCatalogPath: CODEX_MODEL_CATALOG,
    });
    if (out || restoreEmptyFile) writeTextAtomic(CODEX_CONFIG, out);
    else fs.unlinkSync(CODEX_CONFIG);   // nothing of the user's left
    return true;
  } catch (e) {
    dbg("[Bridge] strip codex config failed:", e.message);
    return false;
  }
}

function restoreCodexConfig() {
  stopCodexClientWatch();
  const authBackupPath = CODEX_AUTH + ".bak";
  const authBackupExists = fs.existsSync(authBackupPath);
  let authRestored = false;
  try {
    const liveExists = fs.existsSync(CODEX_AUTH);
    const liveSource = liveExists ? fs.readFileSync(CODEX_AUTH, "utf-8") : "";
    const backupSource = authBackupExists ? fs.readFileSync(authBackupPath, "utf-8") : "";
    const liveIsManaged = liveExists && isKobashiManagedAuth(liveSource);
    const backupIsUsable = authBackupExists && !isKobashiManagedAuth(backupSource);

    if (backupIsUsable && (!liveExists || liveIsManaged)) {
      writeTextAtomic(CODEX_AUTH, backupSource, 0o600);
    } else if (liveIsManaged) {
      fs.unlinkSync(CODEX_AUTH);
    }
    authRestored = true;
  } catch (e) {
    dbg("[Bridge] restore codex auth failed:", e.message);
  }
  if (authRestored && authBackupExists) {
    try { fs.unlinkSync(authBackupPath); } catch (e) { dbg("[Bridge] remove codex auth backup failed:", e.message); }
  }

  const backupPath = CODEX_CONFIG + ".bak";
  const backupExists = fs.existsSync(backupPath);
  let configRestored = false;
  try {
    const backupSource = backupExists ? fs.readFileSync(backupPath, "utf-8") : "";
    const backupIsUsable = backupExists && !isKobashiManagedConfig(backupSource);
    if (fs.existsSync(CODEX_CONFIG)) {
      configRestored = stripInjectedCodexConfig(backupSource, backupIsUsable && backupSource === "");
    } else {
      const recovered = backupIsUsable
        ? backupSource
        : (backupExists
          ? restoreCodexConfigContents(backupSource, "", { modelCatalogPath: CODEX_MODEL_CATALOG })
          : "");
      if (recovered) writeTextAtomic(CODEX_CONFIG, recovered);
      configRestored = true;
    }
  } catch (e) {
    dbg("[Bridge] restore codex config failed:", e.message);
  }
  if (configRestored && backupExists) {
    try { fs.unlinkSync(backupPath); } catch (e) { dbg("[Bridge] remove codex config backup failed:", e.message); }
  }

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
const KOBASHI_DIR = path.join(process.env.HOME || process.env.USERPROFILE, ".kobashi");
const SESSION_FILE = path.join(KOBASHI_DIR, "session.json");
// Legacy location: kobashi's own state used to live inside Codex's config dir,
// under a "ccb-" prefix from when this was called Copilot Bridge. Both were
// wrong: the file is ours, not Codex's. Migrated on first run; the old file is
// removed so it can't drift or be resurrected by a stale sync.
const LEGACY_SESSION_FILE = path.join(process.env.HOME || process.env.USERPROFILE, ".codex", "ccb-session.json");

function migrateLegacySession() {
  try {
    if (fs.existsSync(SESSION_FILE) || !fs.existsSync(LEGACY_SESSION_FILE)) return;
    fs.mkdirSync(KOBASHI_DIR, { recursive: true });
    fs.copyFileSync(LEGACY_SESSION_FILE, SESSION_FILE);
    try { fs.chmodSync(SESSION_FILE, 0o600); } catch {}
    fs.unlinkSync(LEGACY_SESSION_FILE);
    log("[Bridge] Migrated session from ~/.codex/ccb-session.json to ~/.kobashi/session.json");
  } catch (e) { dbg("[Session] migration failed:", e.message); }
}

function saveSession() {
  try {
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ github_token: githubToken, username, codexEnabled, claudeEnabled, authMethod }, null, 2));
    try { fs.chmodSync(SESSION_FILE, 0o600); } catch {}
  } catch (e) { dbg("[Session] save failed:", e.message); }
}

function deleteSession() {
  try { if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE); } catch {}
  try { if (fs.existsSync(LEGACY_SESSION_FILE)) fs.unlinkSync(LEGACY_SESSION_FILE); } catch {}
}

async function loadSession() {
  try {
    migrateLegacySession();
    if (!fs.existsSync(SESSION_FILE)) return false;
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
    if (!data.github_token) return false;
    githubToken = data.github_token;
    username = data.username || "";
    // Backward compat: old sessions used single bridgeEnabled flag (Codex only)
    codexEnabled = data.codexEnabled !== undefined ? data.codexEnabled : (data.bridgeEnabled !== false);
    claudeEnabled = !!data.claudeEnabled;
    // Sessions written before token sign-in existed have no authMethod, and every
    // one of them came from the device flow — so absent means "device", not unknown.
    authMethod = data.authMethod === "token" ? "token" : "device";
    await ensureCopilotToken();
    if (codexEnabled) await writeCodexConfig();
    if (claudeEnabled) writeClaudeConfig();
    log("[Bridge] Session restored for", username);
    return true;
  } catch (e) {
    dbg("[Session] restore failed:", e.message);
    githubToken = null; username = null; codexEnabled = false; claudeEnabled = false;
    copilotToken = null; copilotTokenExpiry = 0;
    deleteSession();
    return false;
  }
}

// ─── State ─────────────────────────────────────────────────────────────────
let githubToken = null, copilotToken = null, copilotTokenExpiry = 0;
let username = null, codexEnabled = false, claudeEnabled = false;
// How this machine signed in: "device" (GitHub device flow) or "token" (a token
// pasted by the user). Device flow authenticates as the *account holder*, so it
// needs their password — a friend running Kobashi off a shared token can never
// complete it. Recording the method lets Disconnect send each user back to the
// screen they can actually get through, instead of a dead end.
//
// Deliberately NOT cleared on disconnect or on an upstream token revocation: it
// describes how the machine last signed in, not whether it is signed in now, and
// that is exactly what the post-logout routing needs to know.
let authMethod = null;
// Records the most recent thinking→effort mapping so an inspector can see, live,
// exactly what reasoning_effort a given slider position produced.
let lastEffort = null; // { source, requested, effort, at }

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

// Validate a token the user pasted, WITHOUT touching global auth state. A failed
// paste must leave an already-working session exactly as it was, so nothing here
// assigns to githubToken/copilotToken — the caller commits only on success.
//
// The two checks are deliberately separate because they fail for unrelated
// reasons and have opposite remedies:
//   /user                        → is this string a real GitHub token?
//   /copilot_internal/v2/token   → does that account actually have Copilot?
// A lapsed subscription leaves the token perfectly valid and fails only the
// second call. Collapsing both into "invalid token" would send the user hunting
// for a better token, which cannot fix a subscription problem.
async function validateCandidateToken(token) {
  const headers = { Authorization: `token ${token}`, "User-Agent": "GitHubCopilotChat/0.38.2" };
  let who;
  try {
    who = await httpsRequest({ hostname: "api.github.com", path: "/user", method: "GET", headers });
  } catch (e) {
    return { ok: false, reason: "network", detail: e.message };
  }
  if (who.status === 401) return { ok: false, reason: "invalid_token" };
  if (who.status !== 200 || !who.body || !who.body.login) {
    return { ok: false, reason: "github_error", detail: `GitHub returned ${who.status}` };
  }

  let cop;
  try {
    cop = await httpsRequest({
      hostname: "api.github.com", path: "/copilot_internal/v2/token", method: "GET",
      headers: { ...headers, "Editor-Version": "vscode/1.110.1", "Editor-Plugin-Version": "copilot-chat/0.38.2" },
    });
  } catch (e) {
    return { ok: false, reason: "network", detail: e.message };
  }
  // 401 here after /user returned 200 means the token is real but carries no
  // Copilot entitlement — same user-facing meaning as an explicit 403.
  if (cop.status === 401 || cop.status === 403) return { ok: false, reason: "no_copilot", login: who.body.login };
  if (cop.status !== 200 || !cop.body || !cop.body.token) {
    return { ok: false, reason: "github_error", detail: `Copilot returned ${cop.status}` };
  }

  // Hand back the minted Copilot token so a successful paste doesn't immediately
  // re-request one it already holds.
  return { ok: true, login: who.body.login, copilot: cop.body.token, copilotExpiry: cop.body.expires_at };
}

async function ensureCopilotToken() {
  if (copilotToken && Date.now() / 1000 < copilotTokenExpiry - 120) return copilotToken;
  const account = githubToken;
  if (!account) throw new Error("GitHub account is not connected");
  const res = await httpsRequest({
    hostname: "api.github.com", path: "/copilot_internal/v2/token", method: "GET",
    headers: { Authorization: `token ${account}`, "User-Agent": "GitHubCopilotChat/0.38.2", "Editor-Version": "vscode/1.110.1", "Editor-Plugin-Version": "copilot-chat/0.38.2" },
  });
  if (account !== githubToken) throw new Error("GitHub account changed during token refresh");
  if (res.status === 401 || res.status === 403) {
    if (codexEnabled) restoreCodexConfig();
    if (claudeEnabled) restoreClaudeConfig();
    githubToken = null; copilotToken = null; copilotTokenExpiry = 0; username = null; codexEnabled = false; claudeEnabled = false;
    clearCopilotModelCache();
    usageCache = null; usageCacheAt = 0;   // never show the revoked account's numbers
    deleteSession();
    throw new Error(`GitHub token revoked (${res.status})`);
  }
  if (res.status !== 200) throw new Error(`Copilot token error: ${res.status}`);
  copilotToken = res.body.token;
  copilotTokenExpiry = res.body.expires_at;
  return copilotToken;
}

// ─── Copilot premium-request usage (cached) ────────────────────────────────
// The number github.com/settings/copilot/features shows as "X / Y AI credits"
// lives in /copilot_internal/user under quota_snapshots.premium_interactions.
// Verified live: credits_used 324157, entitlement 10000000, and it moves within
// a single conversation — so it is a real-time counter, not a daily rollup.
//
// Deliberately NOT folded into ensureCopilotToken(): that response carries only
// `limited_user_quotas: null` (checked — the quota block is not there), and its
// cache is pinned to a ~30-minute token lifetime, whereas usage changes every
// turn. So this is its own request on its own 60s cache.
//
// Never throws: the UI treats a null as "hide the bar". A usage read failing
// must never break /api/status, which the window polls every 2s and which also
// carries the connection state the whole UI depends on.
let usageCache = null;      // { creditsUsed, entitlement, resetDate, unlimited }
let usageCacheAt = 0;
const USAGE_TTL = 60000;

async function getCopilotUsage() {
  if (!githubToken) return null;
  if (usageCache && Date.now() - usageCacheAt < USAGE_TTL) return usageCache;
  try {
    const res = await httpsRequest({
      hostname: "api.github.com", path: "/copilot_internal/user", method: "GET",
      headers: {
        Authorization: `token ${githubToken}`,
        "User-Agent": "GitHubCopilotChat/0.38.2",
        "Editor-Version": "vscode/1.110.1",
        "Editor-Plugin-Version": "copilot-chat/0.38.2",
        "Copilot-Integration-Id": "vscode-chat",
        Accept: "application/json",
      },
    });
    if (res.status !== 200 || !res.body || typeof res.body !== "object") {
      dbg(`[Usage] /copilot_internal/user → ${res.status}`);
      return usageCache;   // keep the last good value rather than blanking the bar
    }
    const snap = (res.body.quota_snapshots || {}).premium_interactions;
    if (!snap) { dbg("[Usage] no premium_interactions snapshot"); return usageCache; }
    // Seats with unlimited premium requests report entitlement 0 — there is no
    // ratio to draw, so report it as unlimited and let the UI hide the bar.
    const entitlement = Number(snap.entitlement) || 0;
    const creditsUsed = Number(snap.credits_used) || 0;
    usageCache = {
      creditsUsed,
      entitlement,
      unlimited: !!snap.unlimited || entitlement <= 0,
      // Outer field, not snap.quota_reset_at (which is a useless 0 here).
      resetDate: res.body.quota_reset_date_utc || res.body.quota_reset_date || null,
    };
    usageCacheAt = Date.now();
    return usageCache;
  } catch (e) {
    dbg("[Usage] fetch failed:", e.message);
    return usageCache;
  }
}

// ─── Copilot model list (cached) + Claude model mapping ───────────────────
let copilotModelsCache = null;
let copilotModelsCacheAt = 0;
let copilotModelsRequest = null;
const COPILOT_MODELS_TTL = 60 * 1000;
let copilotModelsGeneration = 0;

function clearCopilotModelCache() {
  copilotModelsCache = null;
  copilotModelsCacheAt = 0;
  copilotModelsRequest = null;
  copilotModelsGeneration++;
  stopCodexClientWatch();
  codexCapabilities.setAccount(null);
}

async function requestCopilotModels(token) {
  return new Promise((resolve, reject) => {
    let settled = false, request, response;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { request?.destroy(); response?.destroy(); reject(error); }
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error("Copilot model discovery timed out")), 20_000);
    (async () => {
      request = await upstreamHttpsRequest({
        hostname: COPILOT_API, path: "/models", method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Editor-Version": "vscode/1.110.1", "Editor-Plugin-Version": "copilot-chat/0.38.2",
          "User-Agent": "GitHubCopilotChat/0.38.2", "Copilot-Integration-Id": "vscode-chat",
          "X-GitHub-Api-Version": "2025-10-01", Accept: "application/json",
        },
      }, incoming => {
        response = incoming;
        if (settled) { incoming.destroy(); return; }
        const chunks = [];
        let size = 0;
        incoming.on("data", chunk => {
          size += chunk.length;
          if (size > 4 * 1024 * 1024) { finish(new Error("Copilot model catalog exceeds limit")); return; }
          chunks.push(chunk);
        });
        incoming.on("end", () => finish(null, { status: incoming.statusCode,
          raw: Buffer.concat(chunks).toString("utf8") }));
        incoming.on("error", error => finish(error));
        incoming.on("aborted", () => finish(new Error("Copilot model discovery interrupted")));
      });
      request.on("error", error => finish(error));
      if (settled) { request.destroy(); return; }
      request.end();
    })().catch(error => finish(error));
  });
}

async function getCopilotModelsRaw(options = {}) {
  const now = Date.now();
  if (!options.force && copilotModelsCache &&
      now - copilotModelsCacheAt < COPILOT_MODELS_TTL) return copilotModelsCache;
  if (copilotModelsRequest) return copilotModelsRequest;

  const previous = copilotModelsCache;
  const generation = copilotModelsGeneration;
  const request = (async () => {
    let token = await ensureCopilotToken();
    let response = await requestCopilotModels(token);
    if (generation !== copilotModelsGeneration) throw new Error("Copilot account changed during discovery");
    if (response.status === 401 ||
        (response.status === 400 && isAuthFailureBody(response.raw))) {
      copilotToken = null;
      copilotTokenExpiry = 0;
      token = await ensureCopilotToken();
      response = await requestCopilotModels(token);
    }

    if (response.status !== 200) {
      throw new Error(`Copilot model list returned ${response.status}`);
    }
    let data;
    try {
      data = JSON.parse(response.raw);
    } catch {
      throw new Error("Copilot model list returned invalid JSON");
    }
    if (!data || !Array.isArray(data.data)) {
      throw new Error("Copilot model list did not contain a data array");
    }
    if (generation !== copilotModelsGeneration) throw new Error("Copilot account changed during discovery");
    copilotModelsCache = data.data;
    copilotModelsCacheAt = Date.now();
    return copilotModelsCache;
  })();
  copilotModelsRequest = request;

  try {
    return await request;
  } catch (error) {
    if (previous && generation === copilotModelsGeneration) {
      dbg("[Models] live refresh failed; using stale cache:", error.message);
      return previous;
    }
    throw error;
  } finally {
    if (copilotModelsRequest === request) copilotModelsRequest = null;
  }
}

async function getCopilotClaudeModelsRaw() {
  return (await getCopilotModelsRaw()).filter(model => /claude/i.test(model.id || ""));
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

// Copilot signals a dead/expired token in two different ways: HTTP 401, or HTTP
// 400 whose body says the key is invalid. Only the latter is ambiguous — plenty
// of legitimate client errors are also 400 (bad model id, invalid
// reasoning.effort, oversized payload). Retrying THOSE is pure waste: it burns a
// token mint, re-uploads the entire body, doubles the latency, and can bury the
// real error message. So the 400-retry is gated on the body actually looking
// like an auth failure.
function isAuthFailureBody(body) {
  if (!body) return false;
  const s = String(body).toLowerCase();
  return s.includes("not a valid api key")
    || s.includes("authorization header is badly formatted")
    || s.includes("invalid api key")
    || s.includes("bad credentials")
    || s.includes("token expired")
    || s.includes("unauthorized");
}

const proxy = http.createServer(async (req, res) => {
  if (!githubToken || !codexEnabled) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Codex bridge not active" }));
    return;
  }
  // The API and native picker share the verified startup snapshot. Repeated
  // list reads do not trigger additional discovery or paid validation probes.
  if (req.method === "GET" && (req.url === "/v1/models" || req.url.startsWith("/v1/models?"))) {
    try {
      await ensureCodexModelSession();
    } catch (error) {
      dbg("[Codex] GET /v1/models refresh failed:", error.message);
    }
    // This is the same verified registry used to write the native picker.
    // Disk files from older versions/accounts never bypass online validation.
    const models = codexCapabilities.models();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: models.map(model => ({
        id: model.id,
        object: "model",
        created: Number(model.created) || 0,
        owned_by: String(model.vendor || "copilot").toLowerCase().replace(/\s+/g, "-"),
      })),
    }));
    return;
  }
  const bodyChunks = [];
  for await (const chunk of req) bodyChunks.push(chunk);
  let bodyBuf = Buffer.concat(bodyChunks);
  let currentRequest = null;
  let capabilityToken = null;
  // Keep wire compatibility separate from the picker: a supported model may
  // still reject a newer client's optional parameter (e.g. GPT-5 mini context).
  if (req.method === "POST" && bodyBuf.length && req.url.includes("/responses")) {
    try {
      const body = JSON.parse(bodyBuf.toString());
      try {
        await ensureCodexModelSession();
      } catch (error) {
        dbg("[Codex] startup capability lookup failed:", error.message);
      }
      const copilotModels = codexCapabilities.rawModels();
      capabilityToken = codexCapabilities.token(body.model);
      const normalized = normalizeCodexRequest(body, {
        copilotModels, constraints: codexCapabilities.constraints(body.model),
      });
      currentRequest = normalized.body;
      if (normalized.body !== body) {
        bodyBuf = Buffer.from(JSON.stringify(normalized.body));
        for (const change of normalized.changes) {
          log(`[Codex] ${change.field} ${JSON.stringify(change.from)} → ${JSON.stringify(change.to)} (${change.reason})`);
        }
      }
    } catch (error) {
      // Invalid JSON remains an upstream validation error, without retrying it
      // as an authentication failure or changing the original request bytes.
      dbg("[Codex] request normalization skipped:", error.message);
    }
  }
  try {
    // Same 30-minute token expiry problem as the Claude path: a stale Copilot
    // token answers 401 / 400 "Not a valid API key for this workspace". Passing
    // that straight through made Codex CLI treat it as an auth failure and
    // reconnect over and over. Replay once with a fresh token instead — nothing
    // has been written to the client yet at that point.
    const sendCodex = async (attempt, compatibilityRetries = 0) => {
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
      // 401 is always auth. A 400 is only auth-related when it carries the
      // "not a valid API key" / "Authorization header is badly formatted" text —
      // every other 400 (bad model, invalid reasoning.effort, oversized body) is a
      // real client error. Treating ALL 400s as auth used to nuke the token cache
      // and re-upload the whole request (images included) for nothing, doubling
      // latency on errors that could never succeed. So peek at the body first.
      if (upstreamRes.statusCode === 401 && attempt === 0) {
        upstreamRes.resume(); // drain; we replay instead of surfacing this
        copilotToken = null; copilotTokenExpiry = 0;
        log(`[Codex] token rejected (401) — refreshing and retrying once`);
        sendCodex(1, compatibilityRetries).catch(e => {
          try { res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: e.message })); } catch {}
        });
        return;
      }
      if ([400, 403, 404, 410].includes(upstreamRes.statusCode)) {
        // Buffer the error before writing client headers. Authentication and
        // safe optional-parameter compatibility errors have separate bounds;
        // all other request errors are surfaced unchanged.
        const eb = [];
        upstreamRes.on("data", d => eb.push(d));
        upstreamRes.on("end", () => {
          const body = Buffer.concat(eb).toString();
          if (upstreamRes.statusCode === 400 && isAuthFailureBody(body) && attempt === 0) {
            copilotToken = null; copilotTokenExpiry = 0;
            log(`[Codex] token rejected (400) — refreshing and retrying once`);
            sendCodex(1, compatibilityRetries).catch(e => {
              try { res.writeHead(502, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: e.message })); } catch {}
            });
          } else {
            codexCapabilities.observeFailure(currentRequest?.model, capabilityToken, upstreamRes.statusCode, body);
            if (upstreamRes.statusCode === 400 && compatibilityRetries < 3 && currentRequest) {
              try {
                const request = currentRequest;
                const repaired = retryCodexRequest(request, body);
                if (repaired.body !== request) {
                  codexCapabilities.learn(request.model, capabilityToken, repaired.constraints);
                  currentRequest = repaired.body;
                  bodyBuf = Buffer.from(JSON.stringify(currentRequest));
                  log(`[Codex] ${request.model} learned ${repaired.changes.map(change => change.field).join(", ")} — retrying`);
                  sendCodex(attempt, compatibilityRetries + 1).catch(e => {
                    try { res.writeHead(502, { "Content-Type": "application/json" });
                      res.end(JSON.stringify({ error: e.message })); } catch {}
                  });
                  return;
                }
              } catch {}
            }
            // Genuine client error — surface it verbatim, immediately.
            try {
              res.writeHead(upstreamRes.statusCode, { "Content-Type": upstreamRes.headers["content-type"] || "application/json" });
              res.end(body);
            } catch {}
          }
        });
        upstreamRes.on("error", () => { try { res.writeHead(502); res.end(); } catch {} });
        return;
      }
      if (upstreamRes.statusCode === 401 || upstreamRes.statusCode === 400) {
        // Second attempt still failing — clear the token so the NEXT request re-mints.
        if (upstreamRes.statusCode === 401) { copilotToken = null; copilotTokenExpiry = 0; }
      }
      const contentType = String(upstreamRes.headers["content-type"] || "").toLowerCase();
      const contentEncoding = String(upstreamRes.headers["content-encoding"] || "").toLowerCase();
      const normalizeResponsesSse = upstreamRes.statusCode === 200
        && p.includes("/responses")
        && contentType.includes("text/event-stream")
        && (!contentEncoding || contentEncoding === "identity");
      const responseHeaders = { ...upstreamRes.headers };
      if (normalizeResponsesSse) delete responseHeaders["content-length"];
      res.writeHead(upstreamRes.statusCode, responseHeaders);
      if (normalizeResponsesSse) {
        const normalizer = createResponsesSseNormalizer({ onEvent: event => {
          if (!currentRequest || (!["error", "response.failed"].includes(event.type) &&
              !event.error && !event.response?.error)) return;
          const error = { error: event.error || event.response?.error || event };
          const repair = retryCodexRequest(currentRequest, error);
          if (repair.changes.length) codexCapabilities.learn(currentRequest.model, capabilityToken, repair.constraints);
          codexCapabilities.observeFailure(currentRequest.model, capabilityToken, 400, error);
        } });
        normalizer.on("error", (e) => {
          dbg(`[Codex] SSE id normalizer error: ${e.message}`);
          try { res.end(); } catch {}
        });
        upstreamRes.pipe(normalizer).pipe(res);
      } else {
        upstreamRes.pipe(res);
      }
      // pipe() does not end the destination when the source errors, so a
      // mid-stream upstream drop would leave the client hanging. Close both ends
      // explicitly, and tear down the upstream if the client disconnects first.
      upstreamRes.on("error", (e) => { dbg(`[Codex] upstream stream error: ${e.message}`); try { res.end(); } catch {} });
      res.on("close", () => { try { upstreamRes.destroy(); } catch {} });
    });
    upstream.on("error", e => { try { res.writeHead(502); res.end(JSON.stringify({ error: e.message })); } catch {} });
    if (bodyBuf.length) upstream.write(bodyBuf);
    upstream.end();
    };
    await sendCodex(0);
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
      else if (b.type === "thinking" || b.type === "redacted_thinking") {
        // Anthropic thinking blocks. OpenAI's chat/completions has no equivalent
        // field on an INBOUND assistant message — reasoning_text only ever comes
        // back FROM the model — so these used to be dropped on the floor.
        //
        // That silently broke interruption. When a turn is stopped mid-flight,
        // Claude Code keeps the partial assistant turn in history, and a lot of
        // "what I was in the middle of doing" lives in the thinking block. Drop
        // it and the replayed history looks like a turn that simply finished, so
        // the model happily carries on with the old task instead of noticing it
        // was cut off and following the new instruction.
        //
        // Folding the text into the assistant message is the closest thing this
        // wire format allows. redacted_thinking carries no readable text (it is
        // an encrypted blob), so it only leaves a marker — enough for the model
        // to see that a reasoning step happened and was cut short.
        if (b.type === "redacted_thinking") {
          contentParts.push({ type: "text", text: "[reasoning redacted]" });
        } else if (b.thinking) {
          contentParts.push({ type: "text", text: `[reasoning]\n${b.thinking}` });
        }
      }
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
  // Effort slider → reasoning_effort. Claude Code (post effort-2025-11-24 beta)
  // sends the slider as a STRING in output_config.effort ("low"/"medium"/"high"/
  // "xhigh"; ultracode collapses to "xhigh" internally). thinking is separately
  // {type:"adaptive"} with NO budget_tokens — so the old budget-based mapping
  // never fired and the slider had zero effect over this bridge. We now read
  // output_config.effort directly and pass it through FAITHFULLY.
  //
  // Copilot's reasoning_effort accepts low/medium/high/xhigh/max (verified live:
  // those return 200; extra_high/ultracode/minimal return 400). So we forward the
  // slider value as-is when it's an accepted tier — every notch maps 1:1, honouring
  // the user's exact choice. Only genuinely-unknown values are coerced to a safe
  // neighbour so they never 400. Older clients that still send thinking.budget_tokens
  // fall through to the numeric bucket below.
  const COPILOT_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
  const ocEffort = req.output_config && typeof req.output_config.effort === "string"
    ? req.output_config.effort.toLowerCase() : null;
  if (ocEffort) {
    // ultracode isn't a Copilot value; Claude Code already collapses it to xhigh,
    // but guard anyway. Unknown strings fall back to "high" so they never 400.
    const mapped = COPILOT_EFFORTS.has(ocEffort) ? ocEffort
      : ocEffort === "ultracode" ? "xhigh"
      : ocEffort === "extra_high" ? "xhigh"
      : "high";
    out.reasoning_effort = mapped;
    lastEffort = { source: "output_config.effort", requested: ocEffort, effort: mapped, passthrough: mapped === ocEffort, at: Date.now() };
    dbg(`[Claude] effort: output_config.effort="${ocEffort}" → reasoning_effort="${mapped}"`);
  } else if (req.thinking && req.thinking.type === "enabled") {
    // Legacy path: older clients encode effort as thinking.budget_tokens.
    let b = req.thinking.budget_tokens;
    if (typeof b === "string") b = parseInt(b, 10);
    if (typeof b === "number" && !isNaN(b)) {
      out.reasoning_effort = b <= 4096 ? "low" : b <= 9000 ? "medium" : b <= 16000 ? "high" : "max";
      lastEffort = { source: "thinking.budget_tokens", budgetTokens: b, effort: out.reasoning_effort, at: Date.now() };
      dbg(`[Claude] effort: budget_tokens=${b} → reasoning_effort=${out.reasoning_effort}`);
    } else {
      lastEffort = { source: "thinking.budget_tokens", budgetTokens: null, effort: "(enabled but no numeric budget)", at: Date.now(), raw: JSON.stringify(req.thinking) };
    }
  } else {
    lastEffort = { source: "none", effort: "(no effort/thinking sent)", at: Date.now(), raw: JSON.stringify(req.thinking) };
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
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

// Rough input-token estimate from an Anthropic request body. Copilot only
// reports usage at the END of a stream, but Claude Code reads
// message_start.usage.input_tokens to draw its context-window ring the moment a
// turn begins. Seeding message_start with this estimate makes the ring appear
// (and stay roughly accurate); the exact count from upstream corrects it at the
// end. Shared with the /count_tokens endpoint so both agree.
//
// Divisor: measured against real Copilot prompt_tokens on live payloads —
// 104ch→44tok, 9010ch→3613tok, 142010ch→70013tok — i.e. ~2.0–2.5 chars/token
// for Claude Code traffic (o200k_base on prose + JSON tool schemas). The old
// char/4 under-counted by ~40–50%, so the ring read half-empty and Claude Code
// mistimed auto-compaction. 2.5 hugs the real counts without over-counting.
function estimateInputTokens(body) {
  let chars = 0;
  if (typeof body.system === "string") chars += body.system.length;
  else if (Array.isArray(body.system)) chars += body.system.reduce((n, b) => n + (b.text || "").length, 0);
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
      else if (b.type === "image") chars += 4000;
      else if (b.type === "tool_use") chars += JSON.stringify(b.input || {}).length + (b.name || "").length;
      else if (b.type === "tool_result") chars += (typeof b.content === "string" ? b.content : JSON.stringify(b.content || "")).length;
    }
  }
  return Math.max(1, Math.ceil(chars / 2.5));
}

// SSE translator: parses OpenAI delta stream and emits Anthropic events
function makeStreamTranslator(model, write, estInputTokens) {
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
  let inputTokens = estInputTokens || 0, outputTokens = 0;
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
        // cache_* fields must be present (even as 0): Claude Code's context-ring
        // math sums input+cache_creation+cache_read with NO null-guard, so a
        // missing field makes the sum NaN and the ring silently fails to render.
        usage: { input_tokens: estInputTokens || 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
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
    // NOTE: there is deliberately no "aborted" branch here. When the user
    // interrupts, Claude Code closes the socket first, so res.on("close") has
    // already set finished=true and end() never runs — and even if it did, the
    // bytes would go to a closed socket. The interruption is therefore recorded
    // entirely on the CLIENT side; what matters for the next turn is that the
    // partial assistant turn it saved (thinking blocks included) survives the
    // translation back to OpenAI, which is what the thinking-block handling in
    // anthropicToOpenAI() now does.
    end() {
      ensureStart();
      closeOpenBlocks();
      send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { input_tokens: inputTokens, output_tokens: outputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
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
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ input_tokens: estimateInputTokens(body) }));
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
  const requestedModel = oaiReq.model; // what Claude Code asked for, before mapping
  try {
    const mapped = await mapClaudeModel(oaiReq.model);
    if (mapped !== oaiReq.model) dbg(`[Claude] model ${oaiReq.model} → ${mapped}`);
    oaiReq.model = mapped;
  } catch (e) {
    dbg("[Claude] model list fetch failed, using default:", e.message);
    oaiReq.model = CLAUDE_MODEL;
  }
  const model = oaiReq.model;

  // The UI no longer displays the mapping, but a silent downgrade still deserves
  // a line in the log: asking for a [1m] context and quietly getting the 200k one
  // is exactly the kind of thing someone needs to be able to find afterwards.
  {
    const askedFor1m = /\[1m\]$/i.test(requestedModel || "") || /-1m\b/i.test(requestedModel || "");
    const sent1m = /-1m\b/i.test(model || "");
    if (askedFor1m && !sent1m) log(`[Claude] ⚠ ${requestedModel} → ${model} (no 1M on Copilot, downgraded to 200K)`);
    else dbg(`[Claude] mapped ${requestedModel} → ${model}`);
  }

  try {
    // Copilot tokens live only ~30 min. When one goes stale mid-session the API
    // answers 401 — or 400 "Not a valid API key for this workspace" — and the
    // request fails in the user's face. Wrap the upstream call so that on those
    // two statuses we drop the cached token, mint a fresh one and replay the
    // request ONCE. Nothing has been written to the client at that point (the
    // error body is only emitted after the upstream response completes), so the
    // replay is safe for both streaming and non-streaming turns.
    const sendUpstream = async (attempt) => {
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
        // An expired/invalid Copilot token comes back as 401 OR as 400 with
        // "Not a valid API key for this workspace" — Copilot uses both. Only
        // clearing on 401 left the dead token cached, so every later request
        // kept failing until the bridge was restarted ("works, then suddenly
        // 400 forever").
        //
        // 401 is unambiguous: clear + replay immediately. A 400 is NOT — bad
        // model ids, oversized payloads and malformed requests are 400 too, and
        // replaying those just doubles the latency and can bury the real error.
        // So for 400 we read the body first and only replay when it actually
        // reads as an auth failure.
        if (upstreamRes.statusCode === 401 && attempt === 0) {
          upstreamRes.resume(); // drain, we're replaying instead of surfacing this
          copilotToken = null; copilotTokenExpiry = 0;
          log(`[Claude] token rejected (401) — refreshing and retrying once`);
          sendUpstream(1).catch(e => {
            try { res.writeHead(502, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: e.message } })); } catch {}
          });
          return;
        }
        if (upstreamRes.statusCode === 401) { copilotToken = null; copilotTokenExpiry = 0; }
        const errChunks = [];
        upstreamRes.on("data", d => errChunks.push(d));
        upstreamRes.on("end", () => {
          const raw = Buffer.concat(errChunks).toString();
          dbg(`[Claude] upstream error body: ${raw.slice(0, 500)}`);
          // Auth-flavoured 400: drop the dead token and replay once.
          if (upstreamRes.statusCode === 400 && attempt === 0 && isAuthFailureBody(raw)) {
            copilotToken = null; copilotTokenExpiry = 0;
            log(`[Claude] token rejected (400) — refreshing and retrying once`);
            sendUpstream(1).catch(e => {
              try { res.writeHead(502, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: e.message } })); } catch {}
            });
            return;
          }
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
        const trans = makeStreamTranslator(model, c => res.write(c), estimateInputTokens(anthropicReq));
        let finished = false;
        // Close the SSE stream exactly once, always leaving Claude Code with a
        // well-formed message_delta + message_stop. Without this, a mid-stream
        // upstream drop (idle timeout, proxy/NAT reset, network blip on a long
        // "thinking" turn) leaves the response dangling and the client reports
        // "Connection closed mid-response."
        const finish = () => {
          if (finished) return;
          finished = true;
          try { trans.end(); } catch {}
          try { res.end(); } catch {}
        };
        upstreamRes.on("data", d => trans.feed(d));
        upstreamRes.on("end", finish);
        upstreamRes.on("error", (e) => { dbg(`[Claude] upstream stream error: ${e.message}`); finish(); });
        upstreamRes.on("aborted", () => { dbg("[Claude] upstream stream aborted"); finish(); });
        // If Claude Code hangs up first, tear down the upstream so the socket
        // isn't leaked and no further writes hit a closed response.
        res.on("close", () => { finished = true; try { upstreamRes.destroy(); } catch {} });
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
    upstream.on("error", e => { try { res.writeHead(502); res.end(JSON.stringify({ error: e.message })); } catch {} });
    upstream.write(JSON.stringify(oaiReq));
    upstream.end();
    };
    await sendUpstream(0);
  } catch (e) { try { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); } catch {} }
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
      copilotToken = null;
      copilotTokenExpiry = 0;
      clearCopilotModelCache();
      const u = await httpsRequest({ hostname: "api.github.com", path: "/user", method: "GET", headers: { Authorization: `token ${githubToken}`, "User-Agent": "GitHubCopilotChat/0.38.2" } });
      username = u.body.login || "";
      authMethod = "device";
      codexEnabled = true;
      claudeEnabled = true;
      await writeCodexConfig();
      writeClaudeConfig();
      saveSession();
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ access_token: githubToken, username }));
    } else {
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ pending: true, error: r.body.error }));
    }
    return;
  }
  if (req.method === "POST" && req.url === "/api/token-login") {
    const chunks = []; for await (const c of req) chunks.push(c);
    let token = "";
    try { token = (JSON.parse(Buffer.concat(chunks).toString()).token || "").trim(); } catch {}
    if (!token) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: "invalid_token" })); return;
    }

    const v = await validateCandidateToken(token);
    if (!v.ok) {
      // Nothing has been mutated at this point, so a bad paste over a live
      // session is a no-op rather than a logout.
      log(`[Bridge] Token sign-in rejected: ${v.reason}${v.detail ? ` (${v.detail})` : ""}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: v.reason, login: v.login })); return;
    }

    clearCopilotModelCache();
    githubToken = token;
    username = v.login;
    copilotToken = v.copilot;
    copilotTokenExpiry = v.copilotExpiry;
    authMethod = "token";
    codexEnabled = true;
    claudeEnabled = true;
    await writeCodexConfig();
    writeClaudeConfig();
    saveSession();
    log("[Bridge] Signed in via pasted token as", username);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, username })); return;
  }
  if (req.method === "POST" && req.url === "/api/heartbeat") {
    lastHeartbeat = Date.now();
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true })); return;
  }
  // Explicit "the window was really closed" signal, sent by the UI via
  // navigator.sendBeacon on pagehide. This replaces the old heartbeat-timeout
  // watchdog, which could not tell a genuinely-closed window from one that Edge
  // merely FROZE in the background (Efficiency Mode / sleeping tabs) — the frozen
  // window stops sending heartbeats, so the bridge used to kill itself while the
  // user was still working, producing ConnectionRefused. A frozen window does NOT
  // fire pagehide, so relying on this beacon lets the bridge survive minimization.
  if (req.method === "POST" && req.url === "/api/closing") {
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true }));
    if (!process.argv.includes("--no-open")) {
      log("[Bridge] Window closed, shutting down");
      cleanupOnExit();
      setTimeout(() => process.exit(0), 50);
    }
    return;
  }
  if (req.method === "POST" && req.url === "/api/focus") {
    focusAppWindow();
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true })); return;
  }
  if (req.url === "/api/status") {
    // Usage is best-effort and served from a 60s cache, so this stays cheap even
    // though the window polls this route every 2 seconds. A null just hides the
    // bar; it must never take the rest of the status payload down with it.
    let usage = null;
    try { usage = await getCopilotUsage(); } catch { usage = null; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ connected: !!githubToken, username, authMethod, codexEnabled, claudeEnabled, proxyPort: PROXY_PORT, claudePort: CLAUDE_PORT, lastEffort, usage, codexModels: codexCapabilities.status(), version: APP_VERSION, releaseDate: APP_DATE })); return;
  }
  if (req.method === "POST" && req.url === "/api/toggle-codex") {
    if (!githubToken) { res.writeHead(400); res.end(JSON.stringify({ error: "Not connected" })); return; }
    codexEnabled = !codexEnabled;
    if (codexEnabled) await writeCodexConfig(); else restoreCodexConfig();
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
    // Expiry must be zeroed alongside the token it describes: a stale non-zero
    // expiry paired with a fresh token from the *next* sign-in would make the
    // cache look valid when it is not.
    copilotTokenExpiry = 0;
    clearCopilotModelCache();
    // Same reasoning for the usage cache: signing in as someone else must not
    // briefly show the previous account's credit count.
    usageCache = null; usageCacheAt = 0;
    deleteSession();
    // authMethod survives, so the UI can offer the screen this machine can
    // actually complete: device-flow users get the GitHub button back, token
    // users get the paste field rather than a password prompt they cannot pass.
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, next: authMethod === "token" ? "token" : "idle" })); return;
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
    // Shutdown is now driven by an explicit /api/closing beacon the UI sends on
    // genuine window close (see the route above). We deliberately no longer kill
    // the bridge on a heartbeat gap: Edge/Windows freezes backgrounded windows
    // (0 K working set), which stalls the heartbeat and used to make the bridge
    // commit suicide mid-session → ConnectionRefused. Surviving a frozen window
    // is far more important than promptly reaping a force-killed one (the latter
    // just lingers on localhost and is reused by the single-instance guard on the
    // next launch).
  });
});
testReq.end();
