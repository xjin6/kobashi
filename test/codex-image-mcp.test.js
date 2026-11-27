"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const { spawn } = require("node:child_process");
const test = require("node:test");
const {
  MAX_OUTPUT_IMAGE_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_REFERENCE_IMAGE_BYTES,
  MAX_TOTAL_REFERENCE_IMAGE_BYTES,
  MCP_SERVER_NAME,
  codexImageMcpLaunchConfig,
  createImageTool,
  createMcpRequestHandler,
  runCodexImageMcp,
  validateArgs,
} = require("../lib/codex-image-mcp");

const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("fixture-png")]);

function response(payload, options = {}) {
  const bytes = Buffer.from(JSON.stringify(payload));
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    headers: { get: name => name.toLowerCase() === "content-length"
      ? String(options.contentLength ?? bytes.length) : null },
    arrayBuffer: async () => bytes,
  };
}

function tempDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kobashi-image-mcp-test-"));
  t.after(() => {
    const resolved = fs.realpathSync(directory);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("kobashi-image-mcp-test-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return directory;
}

test("stdio server implements initialize, ping, tool discovery and JSON-RPC errors", async () => {
  const input = new PassThrough(), output = new PassThrough();
  let text = "";
  output.on("data", chunk => { text += chunk; });
  const running = runCodexImageMcp({
    input, output, version: "2.4.3",
    imagegen: async () => ({ content: [{ type: "text", text: "fixture" }], isError: false }),
  });
  for (const message of [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "test-version" } },
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    { jsonrpc: "2.0", id: 2, method: "ping", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 4, method: "unknown", params: {} },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "unknown", arguments: {} } },
  ]) input.write(`${JSON.stringify(message)}\n`);
  input.write("{invalid json\n");
  input.end();
  await running;

  const replies = text.trim().split("\n").map(line => JSON.parse(line));
  const byId = new Map(replies.map(item => [item.id, item]));
  assert.equal(byId.get(1).result.protocolVersion, "test-version");
  assert.equal(byId.get(1).result.serverInfo.name, MCP_SERVER_NAME);
  assert.equal(byId.get(1).result.serverInfo.version, "2.4.3");
  assert.deepEqual(byId.get(2).result, {});
  assert.equal(byId.get(3).result.tools[0].name, "imagegen");
  assert.match(byId.get(3).result.tools[0].description, /neither OPENAI_API_KEY nor a third-party plugin/);
  assert.equal(byId.get(4).error.code, -32601);
  assert.equal(byId.get(5).error.code, -32602);
  assert.ok(replies.some(item => item.id === null && item.error?.code === -32700));
  assert.equal(replies.some(item => item.method === "notifications/initialized"), false);
});

test("launch configuration re-enters packaged builds and uses Node for source runs", () => {
  assert.deepEqual(codexImageMcpLaunchConfig({
    packaged: true, execPath: "/Applications/Kobashi/runtime", entryPath: "/source/index.js",
  }), {
    command: "/Applications/Kobashi/runtime", args: ["--image-mcp"],
    startupTimeoutSec: 15, toolTimeoutSec: 660,
  });
  assert.deepEqual(codexImageMcpLaunchConfig({
    packaged: false, execPath: "/usr/bin/node", entryPath: "/source/index.js",
  }), {
    command: "/usr/bin/node", args: ["/source/index.js", "--image-mcp"],
    startupTimeoutSec: 15, toolTimeoutSec: 660,
  });
});

test("the source entrypoint runs only the image MCP protocol in --image-mcp mode", async () => {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "index.js"), "--image-mcp"], {
    cwd: path.join(__dirname, ".."), stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-03-26" } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  child.stdin.end();
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject); child.once("exit", resolve);
  });
  const replies = stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(code, 0);
  assert.equal(stderr, "");
  assert.equal(replies.length, 2, "notifications never receive JSON-RPC replies");
  assert.equal(replies[0].result.serverInfo.name, MCP_SERVER_NAME);
  assert.equal(replies[0].result.serverInfo.version, "2.4.3");
  assert.equal(replies[1].result.tools[0].name, "imagegen");
});

test("generation calls only the loopback Kobashi gateway, saves original bytes and returns an image", async t => {
  const directory = tempDir(t), calls = [];
  const encoded = PNG.toString("base64");
  const imagegen = createImageTool({
    outputDir: directory,
    now: () => Date.UTC(2026, 10, 28, 1, 2, 3),
    randomUUID: () => "fixture-id",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({ data: [{ b64_json: encoded, generation_id: "generation-fixture" }],
        quality: "low", size: "1024x1024", background: "opaque" });
    },
  });
  const result = await imagegen({ prompt: "a blue circle", quality: "low", size: "1024x1024" });
  assert.equal(result.isError, false);
  assert.equal(result.content[1].type, "image");
  assert.equal(result.content[1].mimeType, "image/png");
  assert.equal(result.content[1].data, encoded);
  assert.equal(result.structuredContent.model, "gpt-image-2.5-flare");
  assert.equal(result.structuredContent.generation_id, "generation-fixture");
  assert.deepEqual(fs.readFileSync(result.structuredContent.saved_path), PNG);
  assert.ok(result.structuredContent.saved_path.startsWith(fs.realpathSync(directory) + path.sep));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:18921/v1/images/generations");
  assert.deepEqual(calls[0].options.headers, { "content-type": "application/json" });
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(Object.keys(calls[0].options.headers).some(key => /authorization|api.key/i.test(key)), false);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    model: "gpt-image-2", prompt: "a blue circle", n: 1, quality: "low",
    size: "1024x1024", background: "opaque",
  });
});

test("reference images select JSON edits and preserve PNG/JPEG/WebP MIME types", async t => {
  const directory = tempDir(t), references = path.join(directory, "references");
  fs.mkdirSync(references);
  const files = [
    ["one.png", PNG, "image/png"],
    ["two.jpg", Buffer.from([0xff, 0xd8, 0xff, 0x00]), "image/jpeg"],
    ["three.webp", Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]), "image/webp"],
  ];
  for (const [name, bytes] of files) fs.writeFileSync(path.join(references, name), bytes);
  let sent;
  const imagegen = createImageTool({
    outputDir: path.join(directory, "output"),
    referenceRoot: references,
    randomUUID: () => "edit",
    fetchImpl: async (url, options) => {
      sent = { url, body: JSON.parse(options.body) };
      return response({ data: [{ b64_json: PNG.toString("base64") }] });
    },
  });
  const result = await imagegen({
    prompt: "edit all references", transparent_background: true,
    referenced_image_paths: files.map(([name]) => path.join(references, name)),
  });
  assert.equal(result.isError, false);
  assert.equal(sent.url, "http://127.0.0.1:18921/v1/images/edits");
  assert.equal(sent.body.background, "transparent");
  assert.deepEqual(sent.body.images.map(item => item.image_url.slice(5, item.image_url.indexOf(";"))),
    files.map(([, , mime]) => mime));

  const outside = path.join(directory, "outside.png");
  fs.writeFileSync(outside, PNG);
  const escaped = path.join(references, "escaped.png");
  fs.symlinkSync(outside, escaped);
  const rejected = await imagegen({ prompt: "must stay inside the managed root",
    referenced_image_paths: [escaped] });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /must come from the Kobashi generated-image directory/);
});

test("argument and reference limits fail as tool results without reaching the gateway", async t => {
  assert.throws(() => validateArgs({}), /prompt is required/);
  assert.throws(() => validateArgs({ prompt: "x", quality: "max" }), /quality/);
  assert.throws(() => validateArgs({ prompt: "x", size: "100x100" }), /supported image dimensions/);
  assert.throws(() => validateArgs({ prompt: "x", referenced_image_paths: Array(6).fill("a.png") }),
    /at most 5/);

  const directory = tempDir(t), oversized = path.join(directory, "oversized.png");
  fs.writeFileSync(oversized, PNG);
  fs.truncateSync(oversized, MAX_REFERENCE_IMAGE_BYTES + 1);
  let calls = 0;
  const imagegen = createImageTool({
    outputDir: directory,
    fetchImpl: async () => { calls++; return response({}); },
  });
  const result = await imagegen({ prompt: "fixture", referenced_image_paths: [oversized] });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /exceeds 20 MiB/);
  assert.equal(calls, 0);

  const combinedImagegen = createImageTool({
    outputDir: directory,
    referenceRoot: "/",
    fsImpl: { promises: {
      realpath: async file => path.resolve(file),
      stat: async () => ({ isFile: () => true, size: 1 }),
      readFile: async () => ({
        length: Math.floor(MAX_TOTAL_REFERENCE_IMAGE_BYTES / 5) + 1,
        subarray: () => Buffer.from("89504e470d0a1a0a", "hex"),
        toString: encoding => encoding === "base64" ? "fixture" : "",
      }),
    } },
    fetchImpl: async () => { calls++; return response({}); },
  });
  const combinedResult = await combinedImagegen({
    prompt: "fixture", referenced_image_paths: Array.from({ length: 5 }, (_, index) => `image-${index}.png`),
  });
  assert.equal(combinedResult.isError, true);
  assert.match(combinedResult.content[0].text, /combined 80 MiB/);
  assert.equal(calls, 0);

  const outputTarget = path.join(directory, "output-target");
  fs.mkdirSync(outputTarget);
  const outputLink = path.join(directory, "output-link");
  fs.symlinkSync(outputTarget, outputLink);
  const symlinkOutput = createImageTool({
    outputDir: outputLink,
    fetchImpl: async () => response({ data: [{ b64_json: PNG.toString("base64") }] }),
  });
  const outputResult = await symlinkOutput({ prompt: "fixture" });
  assert.equal(outputResult.isError, true);
  assert.match(outputResult.content[0].text, /must be a real directory/);
});

test("cancellation aborts the matching call and stdin close cancels all in-flight work", async () => {
  let observedSignal;
  const handler = createMcpRequestHandler({ imagegen: async (args, { signal }) => {
    observedSignal = signal;
    return new Promise(resolve => signal.addEventListener("abort", () => resolve({
      content: [{ type: "text", text: signal.reason.message }], isError: true,
    }), { once: true }));
  } });
  const pending = handler({ jsonrpc: "2.0", id: 41, method: "tools/call",
    params: { name: "imagegen", arguments: { prompt: "fixture" } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(observedSignal.aborted, false);
  assert.equal(await handler({ jsonrpc: "2.0", method: "notifications/cancelled",
    params: { requestId: 41, reason: "user cancelled" } }), null);
  const cancelled = await pending;
  assert.equal(cancelled.result.isError, true);
  assert.match(cancelled.result.content[0].text, /cancelled/);

  let closeSignal;
  const input = new PassThrough(), output = new PassThrough();
  output.resume();
  const running = runCodexImageMcp({ input, output, imagegen: async (args, { signal }) => {
    closeSignal = signal;
    return new Promise(resolve => signal.addEventListener("abort", () => resolve({
      content: [{ type: "text", text: "disconnected" }], isError: true,
    }), { once: true }));
  } });
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 51, method: "tools/call",
    params: { name: "imagegen", arguments: { prompt: "fixture" } } })}\n`);
  await new Promise(resolve => setImmediate(resolve));
  input.end();
  await running;
  assert.equal(closeSignal.aborted, true);
  assert.match(closeSignal.reason.message, /disconnected/);
});

test("streaming response limits apply without Content-Length", async t => {
  const directory = tempDir(t);
  const bytes = Buffer.alloc(MAX_RESPONSE_BYTES + 1, 1);
  let offset = 0, cancelled = false;
  const imagegen = createImageTool({
    outputDir: directory,
    fetchImpl: async () => ({
      ok: true, status: 200, headers: { get: () => null },
      body: { getReader: () => ({
        async read() {
          if (offset >= bytes.length) return { done: true };
          const value = bytes.subarray(offset, Math.min(bytes.length, offset + 1024 * 1024));
          offset += value.length;
          return { done: false, value };
        },
        async cancel() { cancelled = true; },
      }) },
    }),
  });
  const result = await imagegen({ prompt: "fixture" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /response exceeds the local size limit/);
  assert.equal(cancelled, true);
});

test("the image timeout covers response-body streaming", async t => {
  const directory = tempDir(t);
  const imagegen = createImageTool({
    outputDir: directory,
    timeoutMs: 5,
    fetchImpl: async (url, { signal }) => ({
      ok: true, status: 200, headers: { get: () => null },
      body: { getReader: () => ({
        read: () => new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
        async cancel() {},
      }) },
    }),
  });
  const result = await imagegen({ prompt: "fixture" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /timed out/);
});

test("gateway and output failures are bounded and later MCP requests still work", async t => {
  const directory = tempDir(t);
  const tooLarge = createImageTool({
    outputDir: directory,
    fetchImpl: async () => response({}, { contentLength: Math.ceil(MAX_OUTPUT_IMAGE_BYTES * 4 / 3) + 3 * 1024 * 1024 }),
  });
  assert.equal((await tooLarge({ prompt: "fixture" })).isError, true);

  let attempts = 0;
  const handler = createMcpRequestHandler({ imagegen: async () => {
    attempts++;
    if (attempts === 1) return { content: [{ type: "text", text: "failed" }], isError: true };
    return { content: [{ type: "text", text: "ok" }], isError: false };
  } });
  assert.equal((await handler({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "imagegen", arguments: { prompt: "one" } } })).result.isError, true);
  assert.equal((await handler({ jsonrpc: "2.0", id: 2, method: "ping", params: {} })).result != null, true);
  assert.equal((await handler({ jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "imagegen", arguments: { prompt: "two" } } })).result.isError, false);
});
