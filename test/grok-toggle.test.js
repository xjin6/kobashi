const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const vm = require("node:vm");
const test = require("node:test");
const { createGrokGateway, listGrokModels } = require("../lib/grok-gateway");
const { createDesktopOpenHandler } = require("../lib/desktop-open-handler");
const { CLAUDE_LAUNCH_ERRORS } = require("../lib/claude-desktop-launcher");
const { GROK_LAUNCH_ERRORS } = require("../lib/grok-desktop-launcher");
const { createGrokSessionReader, grokSessionFromRecord, isLocalGrokControl } = require("../lib/grok-local");

const index = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");
function section(start, end) { return index.slice(index.indexOf(start), index.indexOf(end)); }
// Exercise the application's real session, UI and gateway entry points in
// disposable homes, on ephemeral loopback ports, with no external requests.
const source = section("function writeTextAtomic(", "function readCodexModelCatalog(") +
  section("function saveSession(", "function httpsRequest(") +
  section("const readGrokSession =", "// ─── UI server") +
  section("const ui = http.createServer(", "function cleanupOnExit()") + "\nglobalThis.uiServer = ui;";

function sessionFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kobashi-grok-toggle-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "session.json");
}

async function runtime(t, filename, standalone = false) {
  const servers = [];
  const state = { discoveries: 0, generations: 0, claudeOpens: 0, windowFocuses: 0 };
  const ctx = vm.createContext({
    fs, path, Buffer, process: { pid: process.pid }, randomUUID,
    grokSessionFromRecord, isLocalGrokControl, createGrokSessionReader, createGrokGateway, listGrokModels,
    createDesktopOpenHandler, GROK_LAUNCH_ERRORS, KOBASHI_DIR: path.dirname(filename),
    CLAUDE_LAUNCH_ERRORS, createClaudeDesktopLauncher: () => ({
      supported: true, open: async () => { state.claudeOpens++; return { state: "opened" }; },
    }),
    createGrokDesktopLauncher: options => ({ supported: true, open: async () => {
      await options.prepareProfile(); return { state: "opened" };
    } }),
    ensureGrokLaunchProfile: (root, catalog, baseUrl, key) => { state.profile = { root, catalog, baseUrl, key }; },
    focusAppWindow: () => { state.windowFocuses++; },
    http: { createServer(fn) { const server = http.createServer(fn); servers.push(server); return server; } },
    SESSION_FILE: filename, LEGACY_SESSION_FILE: filename + ".old", GROK_ONLY: standalone, GROK_PORT: 0,
    GROK_BASE_URL: "local fixture", loadGrokGatewayKey: () => "fixture-key", COPILOT_API: "copilot.invalid",
    getCopilotModelsRaw: async () => { state.discoveries++; return [
      { id: "grok-test", vendor: "xAI", capabilities: { type: "chat" }, supported_endpoints: ["/responses"] },
    ]; },
    ensureCopilotToken: async () => { if (state.beforeToken) await state.beforeToken(); return "fixture-copilot"; },
    upstreamHttpsRequest: async () => { state.generations++; throw Error("unexpected inference"); },
    isAuthFailureBody: () => false, copilotModelsGeneration: 0,
    clearCopilotModelCache: () => { ctx.copilotModelsGeneration++; },
    migrateLegacySession() {}, log() {}, dbg() {}, writeCodexConfig() {}, writeClaudeConfig() {},
    restoreCodexConfig() {}, restoreClaudeConfig() {}, codexOpenHandler: async () => false, getCopilotUsage: async () => null,
    codexDesktopLauncher: {}, PROXY_PORT: 1, CLAUDE_PORT: 2, codexCapabilities: { status: () => ({}) },
    APP_VERSION: "test", APP_DATE: "", usageCache: null, usageCacheAt: 0,
    validateCandidateToken: async () => ({ ok: true, login: "fixture", copilot: "valid", copilotExpiry: 100 }),
    httpsRequest: async ({ path }) => ({ body: path === "/user" ? { login: "fixture" } : { access_token: "device" } }),
    GITHUB_CLIENT_ID: "fixture",
  });
  vm.runInContext(source, ctx);
  t.after(async () => {
    for (const server of servers.filter(s => s.listening)) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
  if (!standalone) {
    await ctx.loadSession();
    ctx.uiServer.listen(0, "127.0.0.1");
    await once(ctx.uiServer, "listening");
    ctx.UI_PORT = ctx.uiServer.address().port;
    ctx.GROK_APP_BASE_URL = "http://127.0.0.1:" + ctx.UI_PORT + "/grok/v1";
    vm.runInContext(section("const claudeDesktopLauncher =", "const codexDesktopLauncher ="), ctx);
  }
  ctx.startGrokGateway();
  const gateway = servers.at(-1);
  await once(gateway, "listening");
  const ui = "http://127.0.0.1:" + ctx.UI_PORT;
  const api = "http://127.0.0.1:" + gateway.address().port;
  return { state, ui, get: route => fetch(ui + route),
    post: (route = "/api/toggle-grok", opts = {}) => fetch(ui + route, { method: "POST", ...opts }),
    models: () => fetch(api + "/v1/models", { headers: { authorization: "Bearer fixture-key" } }),
    infer: () => fetch(api + "/v1/responses", { method: "POST", headers: { authorization: "Bearer fixture-key" },
      body: JSON.stringify({ model: "grok-test", input: "hi" }) }),
  };
}

test("singleton focus accepts the local launcher and ignores foreign requests", async t => {
  const app = await runtime(t, sessionFile(t));
  assert.equal((await app.post("/api/focus", { headers: { origin: "https://example.invalid" } })).status, 403);
  assert.equal(app.state.windowFocuses, 0);
  assert.equal((await app.post("/api/focus")).status, 200);
  assert.equal(app.state.windowFocuses, 1);
});

test("opening Claude from a paused bridge launches the desktop without changing the session", async t => {
  const filename = sessionFile(t);
  const original = JSON.stringify({ github_token: "fake", codexEnabled: false, claudeEnabled: false });
  fs.writeFileSync(filename, original);
  const app = await runtime(t, filename);
  const post = (origin, body = "{}") => app.post("/api/claude/open", {
    headers: { "content-type": "application/json", origin }, body,
  });
  assert.equal((await (await app.get("/api/status")).json()).claudeDesktopLaunchSupported, true);
  assert.equal((await post("https://example.invalid")).status, 403);
  assert.equal((await post(app.ui, '{"args":["--other"]}')).status, 400);
  assert.equal(app.state.claudeOpens, 0);
  assert.deepEqual(await (await post(app.ui)).json(), { ok: true, state: "opened" });
  assert.equal(app.state.claudeOpens, 1);
  assert.equal(fs.readFileSync(filename, "utf8"), original);
});

test("the Grok icon provisions the dashboard's authenticated gateway and obeys its own bridge switch", async t => {
  const filename = sessionFile(t);
  fs.writeFileSync(filename, JSON.stringify({ github_token: "fake", codexEnabled: false, claudeEnabled: false }));
  const app = await runtime(t, filename);
  const open = (headers = {}, body = "{}") => app.post("/api/grok/open", {
    headers: { "content-type": "application/json", origin: app.ui, ...headers }, body,
  });
  const models = (headers = {}) => fetch(app.ui + "/grok/v1/models", { headers: { authorization: "Bearer fixture-key", ...headers } });
  assert.equal((await (await app.get("/api/status")).json()).grokDesktopLaunchSupported, true);
  assert.equal((await open({ origin: "https://example.invalid" })).status, 403);
  assert.equal((await open({}, '{"path":"/tmp/other.app"}')).status, 400);
  assert.equal(app.state.profile, undefined);
  assert.deepEqual(await (await open()).json(), { ok: true, state: "opened" });
  assert.equal(app.state.profile.root, path.join(path.dirname(filename), "grok-desktop"));
  assert.equal(app.state.profile.baseUrl, app.ui + "/grok/v1");
  assert.equal(app.state.profile.key, "fixture-key");
  assert.deepEqual(app.state.profile.catalog.data.map(model => model.id), ["grok-test"]);
  assert.equal((await models({ origin: "https://example.invalid" })).status, 403);
  assert.equal((await models({ authorization: "Bearer wrong" })).status, 401);
  assert.equal((await models()).status, 200);
  await app.post();
  assert.deepEqual(await (await open()).json(), { ok: false, error: "bridge_not_ready" });
  assert.equal((await models()).status, 401);
  await app.post();
  assert.equal((await models()).status, 200);
});

test("Grok defaults on for legacy sessions, persists across restart and leaves the other bridge switches independent", async t => {
  const filename = sessionFile(t);
  fs.writeFileSync(filename, JSON.stringify({ github_token: "old-account", codexEnabled: false, claudeEnabled: true }));
  const app = await runtime(t, filename);
  assert.equal((await (await app.get("/api/status")).json()).grokEnabled, true);
  for (const headers of [{ origin: "https://example.invalid" }, { "sec-fetch-site": "cross-site" },
    { origin: app.ui.replace("127.0.0.1", "localhost") }]) {
    assert.equal((await app.post("/api/toggle-grok", { headers })).status, 403, JSON.stringify(headers));
  }
  const badHost = await new Promise((resolve, reject) => {
    const req = http.request(app.ui + "/api/toggle-grok", { method: "POST", headers: { host: "invalid.example" } },
      res => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject); req.end();
  });
  assert.equal(badHost, 403);
  assert.equal((await app.get("/api/toggle-grok")).status, 405);
  assert.equal((await app.post("/api/toggle-grok", { body: "{}" })).status, 400);
  assert.equal((await app.models()).status, 200);
  assert.deepEqual(await (await app.post("/api/toggle-grok", { headers: { origin: app.ui, "sec-fetch-site": "same-origin" } })).json(),
    { grokEnabled: false });
  assert.equal((await app.models()).status, 401);
  const saved = () => JSON.parse(fs.readFileSync(filename, "utf8"));
  assert.equal(saved().grokEnabled, false);
  assert.equal(saved().codexEnabled, false);
  assert.equal(saved().claudeEnabled, true);
  const revision = saved().grokRevision;
  assert.ok(revision);
  await app.post("/api/toggle-codex");
  assert.equal(saved().grokRevision, revision, "other bridge writes leave Grok requests valid");
  const restarted = await runtime(t, filename);
  assert.equal((await (await restarted.get("/api/status")).json()).grokEnabled, false);
  assert.equal((await restarted.infer()).status, 401);
  assert.deepEqual(await (await restarted.post()).json(), { grokEnabled: true });
  await restarted.post("/api/disconnect");
  assert.equal((await restarted.models()).status, 401);
  assert.equal((await (await restarted.get("/api/status")).json()).grokEnabled, false);
  assert.equal((await restarted.post()).status, 400);
  assert.equal(fs.existsSync(filename), false);
});

test("new device-flow and token sessions enable Grok and publish a new persisted revision", async t => {
  const filename = sessionFile(t);
  const owner = await runtime(t, filename);
  assert.equal((await (await owner.get("/api/status")).json()).grokEnabled, false);
  const revisions = [];
  for (const [route, body] of [["/api/token-login", { token: "token" }], ["/api/poll", { device_code: "fixture" }]]) {
    assert.equal((await owner.post(route, { body: JSON.stringify(body) })).status, 200);
    const data = JSON.parse(fs.readFileSync(filename, "utf8"));
    assert.equal(data.grokEnabled, true);
    assert.equal((await owner.models()).status, 200);
    revisions.push(data.grokRevision);
    await owner.post("/api/disconnect");
  }
  assert.ok(revisions.every(Boolean));
  assert.notEqual(...revisions);
});

test("a quick off/on invalidates waiting inference in both packaged and standalone modes", async t => {
  const filename = sessionFile(t);
  fs.writeFileSync(filename, JSON.stringify({ github_token: "account", grokEnabled: true, grokRevision: "original" }));
  const app = await runtime(t, filename);
  const standalone = await runtime(t, filename, true);
  const runtimes = [app, standalone];
  let resume;
  const hold = new Promise(resolve => { resume = resolve; });
  t.after(resume);
  const entered = runtimes.map(({ state }) => new Promise(resolve => {
    state.beforeToken = () => { resolve(); return hold; };
  }));
  const waiting = runtimes.map(client => client.infer());
  await Promise.all(entered);
  assert.deepEqual(await (await app.post()).json(), { grokEnabled: false });
  assert.deepEqual(await (await app.post()).json(), { grokEnabled: true });
  // Neither gateway checked its session in between the two writes.
  resume();
  for (const response of await Promise.all(waiting)) assert.equal(response.status, 401);
  for (const client of runtimes) {
    assert.equal(client.state.generations, 0);
    assert.equal((await client.models()).status, 200);
  }
  await app.post();
  for (const client of runtimes) {
    const before = client.state.discoveries;
    assert.equal((await client.models()).status, 401);
    assert.equal((await client.infer()).status, 401);
    assert.equal(client.state.discoveries, before, "off denies requests before catalog access");
  }
  await app.post();
  await app.post("/api/disconnect");
  assert.equal((await standalone.models()).status, 401);
});
