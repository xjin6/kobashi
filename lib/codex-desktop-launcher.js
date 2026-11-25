"use strict";

const fs = require("node:fs");
const path = require("node:path").posix;
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const executeFile = promisify(execFile);
const { launchWindowsCodex } = require("./codex-windows-launcher");
const APP_PATHS = ["/Applications/ChatGPT.app", "/Applications/Codex.app"];
const SAFE_ERRORS = new Set(["unsupported_platform", "desktop_not_found", "launch_failed",
  "launch_pending", "proxy_settings_unavailable", "shared_backend_running", "bridge_not_ready",
  "invalid_origin", "invalid_request"]);

function failure(code) { return Object.assign(new Error(code), { code }); }

function parseSystemProxy(text) {
  const values = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$/);
    if (match) values[match[1]] = match[2];
  }
  const result = {};
  for (const [prefix, variable, scheme] of [
    ["HTTP", "HTTP_PROXY", "http"], ["HTTPS", "HTTPS_PROXY", "http"], ["SOCKS", "ALL_PROXY", "socks5h"],
  ]) {
    if (values[prefix + "Enable"] !== "1") continue;
    const host = values[prefix + "Proxy"], port = values[prefix + "Port"];
    if (!host || !/^[A-Za-z0-9.:[\]_-]+$/.test(host) || !/^\d+$/.test(port || "") ||
        Number(port) < 1 || Number(port) > 65535) throw failure("proxy_settings_unavailable");
    const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    try {
      const url = new URL(`${scheme}://${bracketed}:${Number(port)}`);
      if (!url.hostname || url.username || url.password) throw Error();
      result[variable] = `${scheme}://${url.host}`;
    } catch { throw failure("proxy_settings_unavailable"); }
  }
  if (!Object.keys(result).length &&
      (values.ProxyAutoConfigEnable === "1" || values.ProxyAutoDiscoveryEnable === "1")) {
    throw failure("proxy_settings_unavailable");
  }
  return result;
}

function openArguments({ appPath, codexHome, userHome, proxies, nativeAccount }) {
  const env = {
    CODEX_HOME: codexHome,
    CODEX_ELECTRON_USER_DATA_PATH: path.join(userHome, "Library/Application Support/Codex"),
    CODEX_CLI_PATH: "", CODEX_APP_SERVER_WS_URL: "",
    CODEX_APP_SERVER_USE_LOCAL_DAEMON: "0", CODEX_APP_SERVER_FORCE_CLI: "",
    NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
  };
  if (nativeAccount) {
    env.OPENAI_API_KEY = "";
    env.OPENAI_BASE_URL = "";
  }
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) {
    env[name] = proxies[name] || "";
    env[name.toLowerCase()] = proxies[name] || "";
  }
  // No -n: LaunchServices reuses a desktop opened concurrently by the user.
  // --env changes only this application's launch, never the GUI login session.
  return [...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]), appPath];
}

function createCodexDesktopLauncher({ platform = process.platform, codexHome,
  userHome = os.homedir(), nativeAccount = () => false, appPaths = APP_PATHS,
  exists = fs.existsSync, execute = executeFile, wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now, startupTimeoutMs = 8000, env = process.env } = {}) {
  let pending = null;
  const home = codexHome || (platform === "win32" ? require("node:path").win32 : path).join(userHome, ".codex");
  async function run(command, args) {
    const result = await execute(command, args, { encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 });
    return typeof result === "string" ? result : result.stdout || "";
  }
  async function findDesktop() {
    for (const appPath of appPaths) {
      const plist = path.join(appPath, "Contents/Info.plist");
      if (!exists(plist)) continue;
      let info;
      try { info = JSON.parse(await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist])); }
      catch { continue; }
      if (info.CFBundleIdentifier !== "com.openai.codex" ||
          typeof info.CFBundleExecutable !== "string" ||
          path.basename(info.CFBundleExecutable) !== info.CFBundleExecutable) continue;
      const executable = path.join(appPath, "Contents/MacOS", info.CFBundleExecutable);
      if (exists(executable)) return { appPath, executable };
    }
    throw failure("desktop_not_found");
  }
  async function running(executable) {
    const output = await run("/bin/ps", ["-axo", "pid=,comm="]);
    return output.split(/\r?\n/).flatMap(line => {
      const row = line.trim().match(/^(\d+)\s+(.+)$/);
      return row && row[2] === executable ? [Number(row[1])] : [];
    });
  }
  async function launch() {
    if (platform === "win32") return launchWindowsCodex({ execute, exists, userHome, codexHome: home,
      nativeAccount, env, wait, now, startupTimeoutMs });
    if (platform !== "darwin") throw failure("unsupported_platform");
    const desktop = await findDesktop();
    const before = await running(desktop.executable);
    if (!before.length && exists(path.join(home, "app-server-control/app-server-control.sock"))) {
      throw failure("shared_backend_running");
    }
    let proxies;
    try { proxies = parseSystemProxy(await run("/usr/sbin/scutil", ["--proxy"])); }
    catch { throw failure("proxy_settings_unavailable"); }
    await run("/usr/bin/open", openArguments({ ...desktop, codexHome: home, userHome, proxies,
      nativeAccount: nativeAccount() === true }));
    const deadline = now() + startupTimeoutMs;
    do {
      const after = await running(desktop.executable);
      if (after.length) return { state: after.some(pid => before.includes(pid)) ? "already_running" : "opened" };
      if (now() >= deadline) break;
      await wait(200);
    } while (true);
    throw failure("launch_pending");
  }
  return {
    supported: platform === "darwin" || platform === "win32",
    open() {
      if (!pending) {
        pending = launch().catch(error => {
          throw failure(SAFE_ERRORS.has(error.code) ? error.code : "launch_failed");
        }).finally(() => { pending = null; });
      }
      return pending;
    },
  };
}

function readEmptyJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [], done = false;
    const finish = error => {
      if (done) return;
      done = true;
      req.removeListener("data", data);
      req.removeListener("end", end);
      req.removeListener("error", failed);
      req.removeListener("aborted", failed);
      if (error) { chunks = []; req.resume(); reject(error); } else resolve();
    };
    const data = chunk => {
      size += chunk.length;
      if (size > 1024) finish(failure("invalid_request")); else chunks.push(chunk);
    };
    const failed = () => finish(failure("invalid_request"));
    const end = () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!value || Array.isArray(value) || typeof value !== "object" || Object.keys(value).length) throw Error();
        finish();
      } catch { finish(failure("invalid_request")); }
    };
    req.on("data", data); req.once("end", end); req.once("error", failed); req.once("aborted", failed);
  });
}

function createCodexOpenHandler({ launcher, port, ready = () => true }) {
  return async function handle(req, res) {
    if (req.url !== "/api/codex/open") return false;
    const reply = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff" });
      res.end(JSON.stringify(value));
    };
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
    const peer = req.socket?.remoteAddress;
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer) ||
        !hosts.includes(req.headers.host) ||
        req.headers.origin && !hosts.some(host => req.headers.origin === "http://" + host) ||
        req.headers["sec-fetch-site"] === "cross-site") {
      reply(403, { ok: false, error: "invalid_origin" }); return true;
    }
    if (req.method !== "POST") { reply(405, { ok: false, error: "invalid_request" }); return true; }
    try {
      if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")) throw failure("invalid_request");
      await readEmptyJson(req);
      if (!ready()) throw failure("bridge_not_ready");
      const result = await launcher.open();
      reply(200, { ok: true, ...result });
    } catch (error) {
      const code = SAFE_ERRORS.has(error.code) ? error.code : "launch_failed";
      reply(code === "invalid_request" ? 400 : 503, { ok: false, error: code });
    }
    return true;
  };
}

module.exports = { parseSystemProxy, openArguments, createCodexDesktopLauncher, createCodexOpenHandler };
