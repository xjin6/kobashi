const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");

const executable = process.env.KOBASHI_TEST_CODEX;

test("native Codex automatically starts the managed Kobashi image MCP for a new thread", {
  skip: !executable, timeout: 20000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kobashi-native-image-mcp-"));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exit = new Promise(resolve => child.once("exit", resolve));
      child.kill(); await exit;
    }
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("kobashi-native-image-mcp-"));
    await fs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const entry = path.join(__dirname, "..", "index.js");
  fs.writeFileSync(path.join(root, "config.toml"), `model = "gpt-5.6-sol"\n` +
    `model_provider = "fixture"\n` +
    `[model_providers.fixture]\nname = "Fixture"\nbase_url = "http://127.0.0.1:1/v1"\n` +
    `env_key = "FIXTURE_KEY"\nwire_api = "responses"\n\n` +
    `[mcp_servers.kobashi_image]\ncommand = ${JSON.stringify(process.execPath)}\n` +
    `args = [${JSON.stringify(entry)}, "--image-mcp"]\nstartup_timeout_sec = 15\ntool_timeout_sec = 660\n`);

  child = spawn(executable, ["app-server", "--stdio"], {
    cwd: root,
    env: { ...process.env, CODEX_HOME: root, FIXTURE_KEY: "fixture" },
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  child.stderr.resume();
  let buffer = "", sequence = 0;
  const pending = new Map();
  let readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  child.stdout.on("data", chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      const request = pending.get(message.id);
      if (request) {
        pending.delete(message.id);
        message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result);
      } else if (message.method === "mcpServer/startupStatus/updated" &&
          message.params?.name === "kobashi_image" && message.params?.status === "ready") {
        readyResolve();
      }
    }
  });
  child.on("error", error => { for (const request of pending.values()) request.reject(error); });
  child.on("exit", () => { for (const request of pending.values()) request.reject(new Error("native app-server exited")); });
  const call = (method, params) => new Promise((resolve, reject) => {
    pending.set(++sequence, { resolve, reject });
    child.stdin.write(JSON.stringify({ id: sequence, method, params }) + "\n");
  });
  await call("initialize", {
    clientInfo: { name: "kobashi-native-image-mcp-test", version: "1" },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write('{"method":"initialized","params":{}}\n');
  await call("thread/start", {
    modelProvider: "fixture", model: "gpt-5.6-sol", cwd: root,
    ephemeral: true, approvalPolicy: "never", sandbox: "read-only",
  });
  let timeout;
  try {
    await Promise.race([
      ready,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("image MCP did not become ready")), 10000);
        timeout.unref();
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
});
