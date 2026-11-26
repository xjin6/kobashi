"use strict";

const { decodeChatSignature, decodeResponsesReplay } = require("./claude-output");
const { advertisedEfforts, chooseEffort, knownOpenAIReasoning } = require("./claude-effort");

function contentBlocks(content) {
  if (content == null) return [];
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content;
  throw new Error("Expected Messages content to be a string or a list of blocks");
}

function textPart(format, role, text) {
  if (format === "chat") return { type: "text", text };
  return { type: role === "assistant" ? "output_text" : "input_text", text };
}

function contentPart(block, format, role) {
  const asText = text => textPart(format, role, text);
  if (block.type === "text") return asText(block.text);
  if (block.type === "tool_reference") return asText(`Tool reference: ${block.tool_name}`);
  if (block.type === "tool_search_tool_result") {
    // Hosted tool search was performed on a previous turn. Its references point
    // to the same named functions now supplied eagerly in the tools array.
    const found = block.content?.tool_references;
    if (Array.isArray(found)) return asText(found.map(ref => ref.tool_name).join(", ") || "No tools found");
    return asText(JSON.stringify(block.content ?? {}));
  }
  const src = block.source || {};
  if (block.type === "image") {
    let url;
    if (src.type === "url" && src.url) url = src.url;
    if (src.type === "base64" && src.data) url = `data:${src.media_type};base64,${src.data}`;
    if (!url) throw new Error("Image input requires a URL or base64 source");
    return format === "responses" ? { type: "input_image", image_url: url } : { type: "image_url", image_url: { url } };
  }
  if (block.type === "document") {
    if (src.type === "text") return asText(src.data);
    if (src.type === "content" && typeof src.content === "string") return asText(src.content);
    if (src.type === "content" && Array.isArray(src.content) && src.content.every(b => b.type === "text")) {
      return asText(src.content.map(b => b.text).join("\n"));
    }
    if (format === "responses") {
      if (src.type === "url" && src.url) return { type: "input_file", file_url: src.url };
      if (src.type === "base64" && src.data) {
        return { type: "input_file", filename: block.title || "document.pdf", file_data: `data:${src.media_type};base64,${src.data}` };
      }
    }
    if (format === "chat" && (src.type === "base64" || src.type === "url")) {
      return asText(`[Document ${block.title || "attachment"} omitted: Copilot Chat cannot receive binary documents; please provide the relevant text.]`);
    }
    throw new Error(`This Copilot ${format} endpoint cannot accept this document source (${src.type})`);
  }
  if (block.type === "server_tool_use" && /tool_search/.test(block.name)) {
    return asText(`Searched for tools: ${JSON.stringify(block.input)}`);
  }
  throw new Error(`Unsupported Messages content block '${block.type}' on Copilot ${format}`);
}

function resultParts(result, format) {
  const parts = contentBlocks(result.content).map(b => contentPart(b, format, "user"));
  if (result.is_error) parts.unshift(textPart(format, "user", "[tool error]"));
  return parts;
}

function responsesInput(messages, model) {
  const input = [];
  for (const { role, content } of messages) {
    let parts = [];
    const flush = () => {
      if (parts.length) input.push({ role, content: parts });
      parts = [];
    };
    // Bind each replayable reasoning item to its next generated content block.
    // This also places signatures delivered in a terminal snapshot before their
    // original tool, and skips interrupted reasoning-only turns with no follower.
    const generated = [];
    const reasoningBefore = new Map();
    for (const block of contentBlocks(content)) {
      if (block.type === "thinking" || block.type === "redacted_thinking") {
        if (role === "assistant") {
          const replay = decodeResponsesReplay(block.signature ?? block.data, model.id);
          if (replay) {
            const before = replay.before ?? generated.length;
            if (!reasoningBefore.has(before)) reasoningBefore.set(before, []);
            reasoningBefore.get(before).push(replay.item);
          }
        }
      } else generated.push(block);
    }
    for (const [index, block] of generated.entries()) {
      const reasoning = reasoningBefore.get(index);
      if (reasoning) {
        flush();
        input.push(...reasoning);
      }
      if (block.type === "tool_use") {
        flush();
        input.push({ type: "function_call", call_id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) });
      } else if (block.type === "tool_result") {
        flush();
        const parts = resultParts(block, "responses");
        const output = parts.every(b => b.type === "input_text") ? parts.map(b => b.text).join("\n") : parts;
        input.push({ type: "function_call_output", call_id: block.tool_use_id, output });
      } else {
        parts.push(contentPart(block, "responses", role));
      }
    }
    flush();
  }
  return input;
}

function chatMessages(messages, system, model) {
  const result = system ? [{ role: "system", content: system }] : [];
  for (const { role, content } of messages) {
    const parts = [];
    const calls = [];
    const thinking = [];
    const toolSignatures = new Map();
    let reasoningOpaque;
    for (const block of contentBlocks(content)) {
      if (block.type === "tool_use") {
        calls.push({ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } });
      } else if (block.type === "tool_result") {
        const output = resultParts(block, "chat");
        const text = output.filter(b => b.type === "text").map(b => b.text).join("\n");
        // Chat tool messages only accept text. Keep image results alongside the
        // next user text, after every parallel tool call has received its result.
        const media = output.filter(b => b.type !== "text");
        result.push({ role: "tool", tool_call_id: block.tool_use_id, content: text || (media.length ? "Image attached below." : "") });
        parts.push(...media);
      } else if (block.type === "thinking" || block.type === "redacted_thinking") {
        if (block.thinking) thinking.push(block.thinking);
        const replay = decodeChatSignature(block.signature ?? block.data, model.id);
        if (typeof replay?.reasoning_opaque === "string") reasoningOpaque = replay.reasoning_opaque;
        if (typeof replay?.call_id === "string" && typeof replay.thought_signature === "string") {
          toolSignatures.set(replay.call_id, replay.thought_signature);
        }
      } else {
        parts.push(contentPart(block, "chat", role));
      }
    }
    if (!parts.length && !calls.length) continue;
    const message = { role, content: null };
    if (role === "assistant" && reasoningOpaque) message.reasoning_opaque = reasoningOpaque;
    if (parts.length) message.content = parts.every(b => b.type === "text") ? parts.map(b => b.text).join("\n") : parts;
    if (calls.length) {
      message.tool_calls = calls;
      for (const call of calls) {
        const signature = toolSignatures.get(call.id);
        if (signature) call.extra_content = { google: { thought_signature: signature } };
      }
      if (thinking.length && /deepseek|mimo|kimi|moonshot/i.test(`${model.vendor} ${model.id}`)) {
        message.reasoning_content = thinking.join("\n");
      }
    }
    result.push(message);
  }
  return result;
}

function addTools(out, format, request, supports) {
  const tools = [];
  const serverTools = new Map();
  for (const tool of request.tools ?? []) {
    if (tool.type && tool.type !== "custom") {
      // Hosted tools have no client function schema. The gateway handles
      // CCD's dedicated WebSearch subrequest before reaching this translator.
      // Deferred client tools already have their schemas in the list.
      serverTools.set(tool.name, tool.type);
      continue;
    }
    if (!tool.input_schema || !tool.name) {
      throw new Error(`Expected a name and input_schema for Messages client tool '${tool.name ?? ""}'`);
    }
    const fn = { name: tool.name, parameters: tool.input_schema, strict: false };
    if (typeof tool.description === "string") fn.description = tool.description;
    tools.push(format === "responses" ? { type: "function", ...fn } : { type: "function", function: fn });
  }
  if (tools.length) out.tools = tools;
  const choice = request.tool_choice;
  const forcedServerTool = choice?.type === "tool" && serverTools.has(choice.name);
  if (forcedServerTool || (!tools.length && serverTools.size && choice?.type !== "none")) {
    const names = forcedServerTool ? [choice.name] : [...serverTools.keys()];
    throw new Error(`Anthropic hosted tool '${names.join(", ")}' cannot run on Copilot ${format}. This endpoint supports client tools with an input_schema.`);
  }
  if (choice?.type === "tool") {
    out.tool_choice = format === "responses" ? { type: "function", name: choice.name } : { type: "function", function: { name: choice.name } };
  } else if (choice && tools.length) {
    const choiceTypes = { auto: "auto", any: "required", none: "none" };
    if (!Object.hasOwn(choiceTypes, choice.type)) throw new Error(`Unknown tool choice '${choice.type}'`);
    out.tool_choice = choiceTypes[choice.type];
  }
  if (tools.length && supports.parallel_tool_calls !== false && typeof choice?.disable_parallel_tool_use === "boolean") {
    out.parallel_tool_calls = !choice.disable_parallel_tool_use;
  }
}

function translateRequest(format, request, model) {
  if (format === "messages") return { ...request, model: model.id };
  if (format !== "chat" && format !== "responses") throw new Error(`Unknown Copilot protocol '${format}'`);
  if (!Array.isArray(request.messages)) throw new Error("Expected messages to be an array");
  const system = contentBlocks(request.system).map(block => {
    if (block.type !== "text") throw new Error(`Unsupported system block '${block.type}'`);
    return block.text;
  }).join("\n\n");
  const responses = format === "responses";
  const out = { model: model.id, stream: !!request.stream };
  const supports = model.capabilities?.supports || {};
  // Copilot has used both locations across catalogue versions. An explicit
  // empty array means this model accepts no effort setting.
  const efforts = advertisedEfforts(model);
  const effort = chooseEffort(request, model, efforts);
  if (responses) {
    out.store = false;
    out.input = responsesInput(request.messages, model);
    if (system) out.instructions = system;
    if (effort) out.reasoning = { effort };
    const summary = supports.reasoning_summary;
    const summarySupported = summary === true || (Array.isArray(summary) && summary.includes("auto")) ||
      (summary == null && knownOpenAIReasoning(model.id));
    if (request.thinking?.type !== "disabled" && effort && effort !== "none" && summarySupported) out.reasoning.summary = "auto";
    const canReason = Array.isArray(efforts) ? efforts.length > 0 : (efforts ?? knownOpenAIReasoning(model.id));
    if (canReason) out.include = ["reasoning.encrypted_content"];
  } else {
    out.messages = chatMessages(request.messages, system, model);
    if (effort) out.reasoning_effort = effort;
    if (out.stream) out.stream_options = { include_usage: true };
    if (request.stop_sequences?.length) out.stop = request.stop_sequences;
  }
  if (Number.isInteger(request.max_tokens) && request.max_tokens > 0) {
    const limit = model.capabilities?.limits?.max_output_tokens;
    let budget = responses ? Math.max(16, request.max_tokens) : request.max_tokens;
    if (Number.isInteger(limit) && limit > 0) budget = Math.min(limit, budget);
    const field = responses ? "max_output_tokens" : knownOpenAIReasoning(model.id) ? "max_completion_tokens" : "max_tokens";
    out[field] = budget;
  }
  // Copilot's o-series and GPT reasoning routes reject sampling controls. A
  // catalogue that explicitly allows them takes precedence over the family.
  for (const key of ["temperature", "top_p"]) {
    if (request[key] != null && (supports[key] === true || (supports[key] !== false && !knownOpenAIReasoning(model.id)))) out[key] = request[key];
  }
  addTools(out, format, request, supports);
  const outputFormat = request.output_config?.format ?? request.output_format;
  if (outputFormat?.type === "json_schema") {
    const schema = { name: "response", schema: outputFormat.schema, strict: false };
    if (responses) out.text = { format: { type: "json_schema", ...schema } };
    else out.response_format = { type: "json_schema", json_schema: schema };
  }
  return out;
}

module.exports = { translateRequest };
