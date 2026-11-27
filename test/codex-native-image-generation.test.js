const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");

const executable = process.env.KOBASHI_TEST_CODEX;

test("native Codex exposes image generation for the Kobashi-shaped Responses provider", {
  skip: !executable, timeout: 20000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kobashi-native-image-"));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exit = new Promise(resolve => child.once("exit", resolve));
      child.kill(); await exit;
    }
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("kobashi-native-image-"));
    await fs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const provider = "{ name = \"Kobashi fixture\", base_url = \"http://127.0.0.1:1/v1\", " +
    "wire_api = \"responses\", requires_openai_auth = true }";
  child = spawn(executable, ["app-server", "--stdio",
    "-c", 'model_provider="kobashi"',
    "-c", `model_providers.kobashi=${provider}`,
  ], { cwd: root, env: { ...process.env, CODEX_HOME: root }, stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true });
  child.stderr.resume();
  let buffer = "", sequence = 0;
  const pending = new Map();
  child.stdout.on("data", chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id);
      message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result);
    }
  });
  child.on("error", error => { for (const request of pending.values()) request.reject(error); });
  child.on("exit", () => { for (const request of pending.values()) request.reject(new Error("native app-server exited")); });
  const call = (method, params) => new Promise((resolve, reject) => {
    pending.set(++sequence, { resolve, reject });
    child.stdin.write(JSON.stringify({ id: sequence, method, params }) + "\n");
  });

  await call("initialize", {
    clientInfo: { name: "kobashi-native-image-test", version: "1" },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write('{"method":"initialized","params":{}}\n');
  assert.deepEqual(await call("modelProvider/capabilities/read", {}), {
    imageGeneration: true,
    webSearch: true,
  });
});
