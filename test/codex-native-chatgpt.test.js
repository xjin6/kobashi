const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const { spawn, execFileSync } = require("node:child_process");
const { injectCodexConfig } = require("../lib/codex-config");
const { migrateNativeAuth } = require("../lib/codex-native-auth");

const executable = process.env.KOBASHI_TEST_CODEX;
const ACCOUNT_TOKEN = "KOBASHI_FAKE_CHATGPT_ACCOUNT";

function certificate(root) {
  fs.writeFileSync(path.join(root, "ca.cnf"), "[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n" +
    "[dn]\nCN=Kobashi fixture CA\n[v3]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyCertSign\n");
  fs.writeFileSync(path.join(root, "leaf.ext"), "subjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\n" +
    "keyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n");
  const local = file => path.join(root, file);
  for (const args of [
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-config", local("ca.cnf"), "-keyout", local("ca.key"), "-out", local("ca.pem")],
    ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=127.0.0.1", "-keyout", local("leaf.key"), "-out", local("leaf.csr")],
    ["x509", "-req", "-in", local("leaf.csr"), "-CA", local("ca.pem"), "-CAkey", local("ca.key"), "-CAcreateserial", "-days", "1",
      "-extfile", local("leaf.ext"), "-out", local("leaf.pem")],
  ]) execFileSync("openssl", args, { stdio: "ignore" });
  return { cert: fs.readFileSync(local("leaf.pem")), key: fs.readFileSync(local("leaf.key")), ca: local("ca.pem") };
}

function fixtureJwt(payload) {
  return Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url") + "." +
    Buffer.from(JSON.stringify(payload)).toString("base64url") + ".fixture";
}

for (const scenario of ["existing", "upgraded", "no-backup"]) {
const legacyUpgrade = scenario !== "existing";
const nativeLogin = scenario !== "no-backup";
test(`${scenario} native account state supports Kobashi`, {
  skip: !executable, timeout: 60000,
}, async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "kobashi-native-chatgpt-"));
  const home = path.join(root, "codex-home");
  fs.mkdirSync(home);
  let child, modelServer, controlServer;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = new Promise(resolve => child.once("close", resolve));
      child.kill(); await closed;
    }
    for (const server of [modelServer, controlServer]) if (server?.listening) {
      await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const keys = certificate(root), requests = [];
  let controlOrigin;
  const handler = async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ url: request.url, authorization: request.headers.authorization,
      accountId: request.headers["chatgpt-account-id"], tls: !!request.socket.encrypted });
    const reply = (status, value) => {
      const bytes = Buffer.from(JSON.stringify(value));
      response.writeHead(status, { "content-type": "application/json", "content-length": bytes.length });
      response.end(bytes);
    };
    if (request.url === "/backend-api/wham/accounts/check") {
      reply(200, { accounts: [{ id: "fixture-account", name: "Fixture workspace",
        workspace_backend_origin: controlOrigin, account_routing_override: "NO_CONSTRAINT" }] });
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      reply(404, { error: "local fixture endpoint only" }); return;
    }
    const item = { id: "msg_fixture", type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "KOBASHI_NATIVE_ROUTING_OK", annotations: [] }] };
    const completed = { id: "resp_fixture", object: "response", status: "completed", output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    const events = [
      { type: "response.created", response: { ...completed, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
      { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "KOBASHI_NATIVE_ROUTING_OK" },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: completed },
    ];
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(""));
  };
  modelServer = http.createServer(handler);
  controlServer = https.createServer(keys, handler);
  await new Promise(resolve => modelServer.listen(0, "127.0.0.1", resolve));
  await new Promise(resolve => controlServer.listen(0, "127.0.0.1", resolve));
  controlOrigin = "https://127.0.0.1:" + controlServer.address().port;
  const source = 'model="gpt-6-astra"\ncli_auth_credentials_store="file"\nmcp_oauth_credentials_store="file"\n' +
    'chatgpt_base_url=' + JSON.stringify(controlOrigin + "/backend-api") + "\ncheck_for_update_on_startup=false\n";
  const config = injectCodexConfig(source, modelServer.address().port, { chatgptAuth: true });
  fs.writeFileSync(path.join(home, "config.toml"), config);
  const jwt = fixtureJwt({ email: "fixture@example.invalid", exp: Math.floor(Date.now() / 1000) + 86400,
    "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account", chatgpt_plan_type: "free" } });
  const auth = JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: {
    id_token: jwt, access_token: ACCOUNT_TOKEN, refresh_token: "KOBASHI_FAKE_REFRESH", account_id: "fixture-account",
  }, last_refresh: new Date().toISOString() });
  const authPath = path.join(home, "auth.json");
  if (legacyUpgrade) {
    fs.writeFileSync(authPath, '{"OPENAI_API_KEY":"PROXY_MANAGED"}', { mode: 0o600 });
    if (nativeLogin) fs.writeFileSync(authPath + ".bak", auth, { mode: 0o600 });
    assert.equal(migrateNativeAuth({ authPath, writeTextAtomic(file, contents, mode) {
      fs.writeFileSync(file, contents, { mode });
    } }), nativeLogin ? "restore" : "remove");
    if (nativeLogin) assert.equal(fs.readFileSync(authPath + ".bak", "utf8"), auth);
  } else fs.writeFileSync(authPath, auth, { mode: 0o600 });
  const env = {};
  for (const key of ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "SystemRoot", "WINDIR"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, { HOME: root, USERPROFILE: root, CODEX_HOME: home,
    CODEX_CA_CERTIFICATE: keys.ca, SSL_CERT_FILE: keys.ca,
    NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" });
  // Windows Store activation inherits Windows' environment. Verify that old
  // bridge sentinels cannot replace the restored account or provider route.
  if (legacyUpgrade) Object.assign(env, { OPENAI_API_KEY: "PROXY_MANAGED",
    OPENAI_BASE_URL: "http://127.0.0.1:1/v1" });
  child = spawn(executable, ["app-server", "--stdio"], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "", sequence = 0, errorLog = "";
  const pending = new Map(), turns = new Map();
  child.stderr.on("data", bytes => { errorLog = (errorLog + bytes).slice(-8000); });
  child.stdout.on("data", bytes => {
    buffer += bytes.toString();
    for (let end; (end = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      if (pending.has(message.id)) {
        const entry = pending.get(message.id); pending.delete(message.id); clearTimeout(entry.timer);
        message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
      } else if (message.method === "turn/completed") {
        turns.get(message.params.threadId)?.(message.params.turn);
      }
    }
  });
  child.on("error", error => { for (const entry of pending.values()) entry.reject(error); });
  child.on("exit", () => { for (const entry of pending.values()) entry.reject(new Error("Fixture native server exited: " + errorLog)); });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Fixture RPC timed out: " + method)); }, 12000);
    timer.unref(); pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  await call("initialize", { clientInfo: { name: "kobashi-native-chatgpt-fixture", version: "1" }, capabilities: { experimentalApi: true } });
  child.stdin.write('{"method":"initialized","params":{}}\n');
  const account = await call("account/read", { refreshToken: false });
  if (!nativeLogin) {
    assert.equal(account.account, null, "A removed placeholder must permit official sign-in, not API mode");
    assert.equal(account.requiresOpenaiAuth, true);
    assert.equal(fs.existsSync(authPath), false);
    assert.equal(requests.length, 0);
    return;
  }
  assert.equal(account.account.type, "chatgpt");
  assert.equal(account.account.planType, "free");
  assert.equal(account.requiresOpenaiAuth, true);
  assert.equal(account.workspaceRouting.backendOrigin, controlOrigin);
  for (const modelProvider of ["kobashi"]) {
    const started = await call("thread/start", { modelProvider, model: "gpt-6-astra", cwd: root,
      ephemeral: true, approvalPolicy: "never", sandbox: "read-only" });
    const threadId = started.thread.id;
    const completed = new Promise(resolve => turns.set(threadId, resolve));
    await call("turn/start", { threadId, input: [{ type: "text", text: "Reply with the fixture response." }] });
    const turn = await completed;
    assert.equal(turn.status, "completed", JSON.stringify(turn));
    assert.equal(started.thread.modelProvider, modelProvider);
  }
  const modelRequests = requests.filter(request => request.url === "/v1/responses");
  assert.equal(modelRequests.length, 1);
  assert.ok(modelRequests.every(request => request.authorization === "Bearer " + ACCOUNT_TOKEN && !request.tls));
  assert.ok(requests.some(request => request.url === "/backend-api/wham/accounts/check" && request.tls));
  assert.equal(fs.readFileSync(path.join(home, "auth.json"), "utf8"), auth);
});
}
