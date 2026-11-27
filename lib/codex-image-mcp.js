"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const readline = require("node:readline");

const MCP_SERVER_NAME = "kobashi_image";
const MCP_TOOL_NAME = "imagegen";
const DEFAULT_PROTOCOL_VERSION = "2025-03-26";
const DEFAULT_GATEWAY_BASE_URL = "http://127.0.0.1:18921/v1";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_PROMPT_CHARS = 32_000;
const MAX_REFERENCE_IMAGES = 5;
const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_REFERENCE_IMAGE_BYTES = 80 * 1024 * 1024;
const MAX_OUTPUT_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES = Math.ceil(MAX_OUTPUT_IMAGE_BYTES * 4 / 3) + 2 * 1024 * 1024;
const QUALITY_VALUES = new Set(["low", "medium", "high", "auto"]);

const TOOL_DESCRIPTION =
  "Generate or edit an image through Kobashi's GitHub Copilot image model. " +
  "Use this directly when the user asks to create, draw, render, restyle, or edit an image. " +
  "It needs neither OPENAI_API_KEY nor a third-party plugin. The result includes a preview and a saved local file.";

const TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    prompt: {
      type: "string",
      description: "A precise description of the image to generate or the edit to apply.",
    },
    referenced_image_paths: {
      type: "array",
      description: "Optional PNG, JPEG, or WebP paths under ~/.kobashi/generated_images only " +
        "(maximum 5). Copy any project image there with normal permission-controlled file tools first.",
      maxItems: MAX_REFERENCE_IMAGES,
      items: { type: "string" },
    },
    transparent_background: {
      type: "boolean",
      description: "Generate a transparent background. Defaults to false.",
      default: false,
    },
    quality: {
      type: "string",
      enum: [...QUALITY_VALUES],
      description: "Rendering quality. Defaults to auto.",
      default: "auto",
    },
    size: {
      type: "string",
      description: "Image size: auto or WIDTHxHEIGHT within supported limits. Defaults to auto.",
      default: "auto",
    },
  },
  required: ["prompt"],
  additionalProperties: false,
};

function codexImageMcpLaunchConfig(options = {}) {
  const packaged = options.packaged === undefined ? !!process.pkg : options.packaged === true;
  const execPath = options.execPath || process.execPath;
  const entryPath = options.entryPath || path.join(__dirname, "..", "index.js");
  return {
    command: execPath,
    args: packaged ? ["--image-mcp"] : [entryPath, "--image-mcp"],
    startupTimeoutSec: 15,
    toolTimeoutSec: 660,
  };
}

function mimeFromBytes(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return { mimeType: "image/png", extension: "png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimeType: "image/jpeg", extension: "jpg" };
  }
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP") {
    return { mimeType: "image/webp", extension: "webp" };
  }
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) {
    return { mimeType: "image/gif", extension: "gif" };
  }
  return null;
}

function validateSize(value) {
  if (value === undefined || value === null || value === "") return "auto";
  if (value === "auto") return value;
  if (typeof value !== "string") throw new Error("size must be auto or WIDTHxHEIGHT");
  const match = value.match(/^(\d{2,4})x(\d{2,4})$/);
  if (!match) throw new Error("size must be auto or WIDTHxHEIGHT");
  const width = Number(match[1]), height = Number(match[2]);
  const pixels = width * height;
  if (width % 16 || height % 16 || width > 3840 || height > 3840 ||
      Math.max(width, height) / Math.min(width, height) > 3 ||
      pixels < 655_360 || pixels > 8_294_400) {
    throw new Error("size is outside the supported image dimensions");
  }
  return `${width}x${height}`;
}

function validateArgs(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("imagegen arguments must be an object");
  }
  const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
  if (!prompt) throw new Error("prompt is required");
  if (prompt.length > MAX_PROMPT_CHARS) throw new Error("prompt exceeds 32000 characters");

  const paths = value.referenced_image_paths === undefined ? [] : value.referenced_image_paths;
  if (!Array.isArray(paths) || paths.some(item => typeof item !== "string" || !item.trim())) {
    throw new Error("referenced_image_paths must contain local path strings");
  }
  if (paths.length > MAX_REFERENCE_IMAGES) {
    throw new Error(`referenced_image_paths supports at most ${MAX_REFERENCE_IMAGES} images`);
  }
  const quality = value.quality === undefined ? "auto" : value.quality;
  if (!QUALITY_VALUES.has(quality)) throw new Error("quality must be low, medium, high, or auto");
  if (value.transparent_background !== undefined && typeof value.transparent_background !== "boolean") {
    throw new Error("transparent_background must be a boolean");
  }
  return {
    prompt,
    referencedImagePaths: paths.map(item => path.resolve(item)),
    transparentBackground: value.transparent_background === true,
    quality,
    size: validateSize(value.size),
  };
}

function isWithin(file, directory) {
  const relative = path.relative(directory, file);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." &&
    !path.isAbsolute(relative));
}

async function loadReferences(paths, fsImpl, referenceRoot) {
  const images = [];
  let totalBytes = 0;
  let allowedRoot = null;
  if (paths.length) {
    try { allowedRoot = await fsImpl.promises.realpath(referenceRoot); }
    catch { throw new Error("Kobashi generated-image directory is unavailable for editing"); }
  }
  for (const file of paths) {
    let resolved;
    try { resolved = await fsImpl.promises.realpath(file); }
    catch { throw new Error(`reference image is unavailable: ${file}`); }
    if (!isWithin(resolved, allowedRoot)) {
      throw new Error("reference images must come from the Kobashi generated-image directory");
    }
    const stat = await fsImpl.promises.stat(resolved);
    if (!stat.isFile()) throw new Error(`reference image is not a file: ${file}`);
    if (stat.size > MAX_REFERENCE_IMAGE_BYTES) {
      throw new Error(`reference image exceeds 20 MiB: ${file}`);
    }
    totalBytes += stat.size;
    if (totalBytes > MAX_TOTAL_REFERENCE_IMAGE_BYTES) {
      throw new Error("reference images exceed the combined 80 MiB limit");
    }
    const bytes = await fsImpl.promises.readFile(resolved);
    if (bytes.length > MAX_REFERENCE_IMAGE_BYTES) {
      throw new Error(`reference image exceeds 20 MiB: ${file}`);
    }
    const previousSize = totalBytes;
    totalBytes = previousSize - stat.size + bytes.length;
    if (totalBytes > MAX_TOTAL_REFERENCE_IMAGE_BYTES) {
      throw new Error("reference images exceed the combined 80 MiB limit");
    }
    const format = mimeFromBytes(bytes);
    if (!format || format.mimeType === "image/gif") {
      throw new Error(`reference image must be PNG, JPEG, or WebP: ${file}`);
    }
    images.push({ image_url: `data:${format.mimeType};base64,${bytes.toString("base64")}` });
  }
  return images;
}

function errorText(payload, status) {
  const message = payload?.error?.message || payload?.message;
  return typeof message === "string" && message.trim()
    ? message.trim().slice(0, 1000)
    : `Kobashi image gateway returned HTTP ${status}`;
}

async function responseBytes(response, signal) {
  const declared = Number(response.headers?.get?.("content-length") || 0);
  if (declared > MAX_RESPONSE_BYTES) throw new Error("image response exceeds the local size limit");
  const chunks = [];
  let size = 0;
  const add = chunk => {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_RESPONSE_BYTES) throw new Error("image response exceeds the local size limit");
    chunks.push(bytes);
  };
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    try {
      while (true) {
        if (signal?.aborted) throw signal.reason || new Error("image request cancelled");
        const { done, value } = await reader.read();
        if (done) break;
        add(value);
      }
    } catch (error) {
      try { await reader.cancel(error); } catch {}
      throw error;
    }
  } else {
    if (!declared) throw new Error("image response length is unavailable");
    if (signal?.aborted) throw signal.reason || new Error("image request cancelled");
    add(await response.arrayBuffer());
  }
  return Buffer.concat(chunks, size);
}

function toolError(error) {
  return {
    content: [{ type: "text", text: `Kobashi image generation failed: ${error.message}` }],
    isError: true,
  };
}

function createImageTool(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const homeDir = options.homeDir || os.homedir();
  const outputDir = path.resolve(options.outputDir || path.join(homeDir, ".kobashi", "generated_images"));
  const referenceRoot = path.resolve(options.referenceRoot || outputDir);
  const gatewayBaseUrl = String(options.gatewayBaseUrl || DEFAULT_GATEWAY_BASE_URL).replace(/\/+$/, "");
  const now = options.now || Date.now;
  const uuid = options.randomUUID || randomUUID;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  return async function imagegen(rawArgs, context = {}) {
    try {
      const args = validateArgs(rawArgs);
      const images = await loadReferences(args.referencedImagePaths, fsImpl, referenceRoot);
      const endpoint = images.length ? "images/edits" : "images/generations";
      const body = {
        model: "gpt-image-2",
        prompt: args.prompt,
        n: 1,
        quality: args.quality,
        size: args.size,
        background: args.transparentBackground ? "transparent" : "opaque",
        ...(images.length ? { images } : {}),
      };
      const controller = new AbortController();
      const externalSignal = context.signal;
      const cancel = () => controller.abort(externalSignal.reason || new Error("image request cancelled"));
      if (externalSignal?.aborted) cancel();
      else externalSignal?.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(() => controller.abort(new Error("image request timed out")), timeoutMs);
      let response, raw;
      try {
        response = await fetchImpl(`${gatewayBaseUrl}/${endpoint}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
          redirect: "error",
        });
        raw = await responseBytes(response, controller.signal);
      } finally {
        clearTimeout(timer);
        externalSignal?.removeEventListener("abort", cancel);
      }
      let payload;
      try { payload = JSON.parse(raw.toString("utf8")); }
      catch { throw new Error(`Kobashi image gateway returned invalid JSON (HTTP ${response.status})`); }
      if (!response.ok) throw new Error(errorText(payload, response.status));
      const encoded = payload?.data?.[0]?.b64_json;
      if (typeof encoded !== "string" || !encoded) throw new Error("image response did not contain image data");
      const approximateBytes = Math.floor(encoded.length * 3 / 4);
      if (approximateBytes > MAX_OUTPUT_IMAGE_BYTES) throw new Error("generated image exceeds 32 MiB");
      const image = Buffer.from(encoded, "base64");
      if (!image.length || image.length > MAX_OUTPUT_IMAGE_BYTES) throw new Error("generated image exceeds 32 MiB");
      const format = mimeFromBytes(image);
      if (!format) throw new Error("generated image has an unsupported file format");

      await fsImpl.promises.mkdir(outputDir, { recursive: true, mode: 0o700 });
      const outputStat = await fsImpl.promises.lstat(outputDir);
      if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) {
        throw new Error("Kobashi generated-image directory must be a real directory");
      }
      const resolvedOutputDir = await fsImpl.promises.realpath(outputDir);
      const timestamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
      const destination = path.join(resolvedOutputDir,
        `kobashi-image-${timestamp}-${uuid()}.${format.extension}`);
      await fsImpl.promises.writeFile(destination, image, { flag: "wx", mode: 0o600 });
      return {
        content: [
          { type: "text", text: `Generated image saved to ${destination}` },
          { type: "image", data: encoded, mimeType: format.mimeType },
        ],
        structuredContent: {
          saved_path: destination,
          model: "gpt-image-2.5-flare",
          quality: payload.quality || args.quality,
          size: payload.size || args.size,
          background: payload.background || body.background,
          generation_id: payload.data[0].generation_id || null,
        },
        isError: false,
      };
    } catch (error) {
      return toolError(error instanceof Error ? error : new Error(String(error)));
    }
  };
}

function responseMessage(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function errorMessage(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function createMcpRequestHandler(options = {}) {
  const imagegen = options.imagegen || createImageTool(options);
  const version = options.version || "0.0.0";
  const inflight = new Map();
  const handle = async function handle(message) {
    if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") {
      return errorMessage(message?.id, -32600, "Invalid Request");
    }
    if (message.method === "notifications/cancelled") {
      inflight.get(message.params?.requestId)?.abort(new Error("image request cancelled"));
      return null;
    }
    if (!Object.hasOwn(message, "id")) return null;
    switch (message.method) {
      case "initialize":
        return responseMessage(message.id, {
          protocolVersion: message.params?.protocolVersion || DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, version },
        });
      case "ping":
        return responseMessage(message.id, {});
      case "tools/list":
        return responseMessage(message.id, { tools: [{
          name: MCP_TOOL_NAME,
          title: "Kobashi Image Generation",
          description: TOOL_DESCRIPTION,
          inputSchema: TOOL_INPUT_SCHEMA,
        }] });
      case "tools/call":
        if (message.params?.name !== MCP_TOOL_NAME) {
          return errorMessage(message.id, -32602, "Unknown tool");
        }
        {
          const controller = new AbortController();
          inflight.set(message.id, controller);
          try {
            return responseMessage(message.id,
              await imagegen(message.params?.arguments || {}, { signal: controller.signal }));
          } finally {
            inflight.delete(message.id);
          }
        }
      default:
        return errorMessage(message.id, -32601, "Method not found");
    }
  };
  handle.cancelAll = () => {
    for (const controller of inflight.values()) controller.abort(new Error("image MCP disconnected"));
  };
  return handle;
}

function runCodexImageMcp(options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const handle = options.handle || createMcpRequestHandler(options);
  const interface_ = readline.createInterface({ input, crlfDelay: Infinity });
  return new Promise(resolve => {
    let closed = false, pending = 0;
    const finish = () => { if (closed && pending === 0) resolve(); };
    interface_.on("line", line => {
      if (!line.trim()) return;
      pending++;
      Promise.resolve().then(async () => {
        let message;
        try { message = JSON.parse(line); }
        catch { return errorMessage(null, -32700, "Parse error"); }
        return handle(message);
      }).then(reply => {
        if (reply) output.write(`${JSON.stringify(reply)}\n`);
      }).catch(() => {
        output.write(`${JSON.stringify(errorMessage(null, -32603, "Internal error"))}\n`);
      }).finally(() => { pending--; finish(); });
    });
    interface_.once("close", () => {
      closed = true;
      try { handle.cancelAll?.(); } catch {}
      finish();
    });
  });
}

module.exports = {
  DEFAULT_GATEWAY_BASE_URL,
  MAX_OUTPUT_IMAGE_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_REFERENCE_IMAGES,
  MAX_REFERENCE_IMAGE_BYTES,
  MAX_TOTAL_REFERENCE_IMAGE_BYTES,
  MCP_SERVER_NAME,
  MCP_TOOL_NAME,
  TOOL_INPUT_SCHEMA,
  codexImageMcpLaunchConfig,
  createImageTool,
  createMcpRequestHandler,
  mimeFromBytes,
  runCodexImageMcp,
  validateArgs,
};
