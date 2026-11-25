const { randomUUID } = require("node:crypto");
const { StringDecoder } = require("node:string_decoder");

const REASONING_PREFIX = "kobashi.responses.v1.";
const CHAT_SIGNATURE_PREFIX = "kobashi.chat.v1.";

// Chat signatures belong to a particular model and, for Gemini, a particular
// function call. Carry only these upstream fields through CCD's saved history.
function chatSignature(model, opaque, id, thoughtSignature) {
  if (!model) return;
  const item = { model };
  if (typeof opaque === "string" && opaque) item.reasoning_opaque = opaque;
  if (typeof id === "string" && id && typeof thoughtSignature === "string" && thoughtSignature) {
    item.call_id = id;
    item.thought_signature = thoughtSignature;
  }
  if (!item.reasoning_opaque && !item.call_id) return;
  return CHAT_SIGNATURE_PREFIX + Buffer.from(JSON.stringify(item)).toString("base64url");
}

function decodeChatSignature(signature, model) {
  if (typeof signature !== "string" || !signature.startsWith(CHAT_SIGNATURE_PREFIX)) return null;
  try {
    const item = JSON.parse(Buffer.from(signature.slice(CHAT_SIGNATURE_PREFIX.length), "base64url").toString("utf8"));
    return item?.model === model && model ? item : null;
  } catch { return null; }
}

function replayableReasoning(item) {
  if (item?.type !== "reasoning" || typeof item.encrypted_content !== "string" || !item.encrypted_content) return null;
  const summary = (Array.isArray(item.summary) ? item.summary : [])
    .filter(part => part?.type === "summary_text" && typeof part.text === "string")
    .map(part => ({ type: "summary_text", text: part.text }));
  return { type: "reasoning", ...(typeof item.id === "string" && { id: item.id }), summary, encrypted_content: item.encrypted_content };
}

function reasoningSignature(item, model, before) {
  const replay = replayableReasoning(item);
  if (!replay) return;
  // The model and optional placement belong to the bridge, never Responses input.
  if (model) replay.kobashi_model = model;
  if (Number.isInteger(before)) replay.kobashi_before = before;
  return REASONING_PREFIX + Buffer.from(JSON.stringify(replay)).toString("base64url");
}

function decodeResponsesReplay(signature, model) {
  if (typeof signature !== "string" || !signature.startsWith(REASONING_PREFIX)) return null;
  try {
    const raw = JSON.parse(Buffer.from(signature.slice(REASONING_PREFIX.length), "base64url").toString("utf8"));
    if (model && raw.kobashi_model && raw.kobashi_model !== model) return null;
    const item = replayableReasoning(raw);
    const before = Number.isInteger(raw.kobashi_before) && raw.kobashi_before >= 0 ? raw.kobashi_before : undefined;
    return item ? { item, before } : null;
  } catch { return null; }
}

function decodeResponsesReasoning(signature, model) {
  return decodeResponsesReplay(signature, model)?.item || null;
}

function usageForMessages(usage = {}, estimate = 0) {
  const details = usage.input_tokens_details ?? usage.prompt_tokens_details ?? {};
  const cached = usage.cache_read_input_tokens ?? details.cached_tokens ?? 0;
  const created = usage.cache_creation_input_tokens ?? details.cache_write_tokens ?? 0;
  return {
    input_tokens: Math.max(0, (usage.input_tokens ?? usage.prompt_tokens ?? estimate) - cached - created),
    output_tokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
    cache_creation_input_tokens: created,
    cache_read_input_tokens: cached,
  };
}

function message(id, model, usage) {
  return {
    type: "message", id: id || `msg_${randomUUID()}`, role: "assistant", model,
    content: [], stop_reason: null, stop_sequence: null, usage,
  };
}

function upstreamError(error, fallback) {
  return new Error((typeof error === "string" ? error : error?.message) || fallback);
}

function stopReason(finish, hasTool, incompleteReason) {
  if (finish === "length" || (finish === "incomplete" && (!incompleteReason || incompleteReason === "max_output_tokens"))) return "max_tokens";
  if (finish === "content_filter" || incompleteReason === "content_filter") return "refusal";
  return hasTool || finish === "tool_calls" ? "tool_use" : "end_turn";
}

function toolInput(args, name) {
  try {
    const parsed = typeof args === "string" ? JSON.parse(args || "{}") : args ?? {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {}
  throw new Error(`Invalid arguments for Copilot tool call '${name}'.`);
}

function chatReasoning(part) {
  return part.reasoning_text || part.reasoning_content || part.reasoning || "";
}

function reasoningText(item) {
  return (item.summary || []).filter(part => part.type === "summary_text" || part.type === "reasoning_text").map(part => part.text || "").join("\n");
}

function toolContent(id, name, args) {
  if (!id || !name) throw new Error("Copilot returned a tool call without an ID or name.");
  return { type: "tool_use", id, name, input: toolInput(args, name) };
}

function translateResponse(format, body, model, upstreamModel) {
  if (body?.error || body?.status === "failed" || body?.status === "cancelled") {
    throw upstreamError(body.error, "Copilot did not complete the response.");
  }
  const result = message(body?.id, model, usageForMessages(body?.usage || {}));
  let finish;
  if (format === "responses") {
    if (!Array.isArray(body?.output)) throw new Error("Copilot response is missing its output.");
    for (const item of body.output) {
      if (item.type === "reasoning") {
        const thinking = reasoningText(item);
        const signature = reasoningSignature(item, upstreamModel || body.model);
        if (thinking || signature) result.content.push({ type: "thinking", thinking, ...(signature && { signature }) });
      } else if (item.type === "message") {
        for (const part of item.content || []) {
          const text = part.type === "refusal" ? part.refusal : part.type === "output_text" ? part.text : null;
          if (text) result.content.push({ type: "text", text });
        }
      } else if (item.type === "function_call") {
        result.content.push(toolContent(item.call_id, item.name, item.arguments));
      }
    }
    finish = body.status;
  } else {
    const choice = body?.choices?.[0];
    const part = choice?.message;
    if (!part) throw new Error("Copilot returned no assistant message.");
    const thinking = chatReasoning(part);
    const source = upstreamModel || body.model || model;
    const signature = chatSignature(source, part.reasoning_opaque);
    if (thinking || signature) result.content.push({ type: "thinking", thinking, ...(signature && { signature }) });
    for (const text of [part.content, part.refusal]) {
      if (typeof text === "string" && text) result.content.push({ type: "text", text });
    }
    for (const call of part.tool_calls || []) {
      const signature = chatSignature(source, null, call.id, call.extra_content?.google?.thought_signature);
      if (signature) result.content.push({ type: "thinking", thinking: "", signature });
      result.content.push(toolContent(call.id, call.function?.name, call.function?.arguments));
    }
    finish = choice.finish_reason;
  }
  result.stop_reason = stopReason(finish, result.content.some(block => block.type === "tool_use"), body.incomplete_details?.reason);
  return result;
}

// The first block streams immediately. Subsequent overlapping blocks wait their
// turn so CCD never receives a delta for another block before the first closes.
function createBlockWriter(send) {
  const pending = [];
  let nextIndex = 0;
  let generatedBlocks = 0;
  return {
    add(kind) {
      const block = { kind, value: "", sent: 0, done: false, index: null };
      pending.push(block);
      return block;
    },
    flush() {
      while (pending.length) {
        const block = pending[0];
        const { kind, id, name, value } = block;
        block.before ??= generatedBlocks;
        if (kind === "tool_use") {
          if (block.done) toolContent(id, name, value);
          if (!id || !name || (!value && !block.done)) return;
        } else if (!value && !block.signature) {
          if (!block.done) return;
          pending.shift();
          block.closed = true;
          continue;
        }
        if (block.index === null) {
          block.index = nextIndex++;
          const content_block = kind === "tool_use" ? { type: kind, id, name, input: {} }
            : kind === "thinking" ? { type: kind, thinking: "", signature: "" } : { type: kind, text: "" };
          send("content_block_start", { index: block.index, content_block });
        }
        if (value.length > block.sent) {
          const fragment = value.slice(block.sent);
          const delta = kind === "tool_use" ? { type: "input_json_delta", partial_json: fragment }
            : kind === "thinking" ? { type: "thinking_delta", thinking: fragment } : { type: "text_delta", text: fragment };
          send("content_block_delta", { index: block.index, delta });
          block.sent = value.length;
        }
        if (!block.done) return;
        if (block.signature) send("content_block_delta", { index: block.index, delta: { type: "signature_delta", signature: block.signature } });
        send("content_block_stop", { index: block.index });
        if (kind !== "thinking") generatedBlocks++;
        block.closed = true;
        pending.shift();
      }
    },
  };
}

function createChatReader(blocks, getModel) {
  const tools = new Map();
  let current;
  let finish;
  function switchTo(kind) {
    if (current?.kind !== kind) {
      if (current) current.done = true;
      current = kind ? blocks.add(kind) : null;
    }
    return current;
  }
  return {
    receive(event) {
      const choice = event.choices?.[0];
      if (!choice) return;
      const delta = choice.delta || {};
      const thinking = chatReasoning(delta);
      if (thinking || delta.reasoning_opaque) {
        const block = switchTo("thinking");
        block.value += thinking;
        if (delta.reasoning_opaque) block.signature = chatSignature(getModel(), delta.reasoning_opaque);
      }
      if (delta.content || delta.refusal) switchTo("text").value += (delta.content || "") + (delta.refusal || "");
      for (const call of delta.tool_calls || []) {
        switchTo(null);
        const key = call.index ?? 0;
        const signature = call.extra_content?.google?.thought_signature;
        if (!tools.has(key)) tools.set(key, {});
        const state = tools.get(key);
        // The signature can precede the call ID or follow the arguments.
        if (signature) {
          state.thoughtSignature = signature;
          state.carrier ||= blocks.add("thinking");
        }
        const block = state.tool ||= blocks.add("tool_use");
        block.id ||= call.id;
        if (state.carrier && block.id) {
          state.carrier.signature = chatSignature(getModel(), null, block.id, state.thoughtSignature);
          state.carrier.done = true;
        }
        if (call.function?.name) block.name = (block.name || "") + call.function.name;
        block.value += call.function?.arguments || "";
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    },
    complete(doneMarker) {
      if (!finish && !doneMarker) throw new Error("Copilot stream ended before a completion event.");
      switchTo(null);
      for (const state of tools.values()) {
        state.tool.done = true;
        if (state.carrier) state.carrier.done = true;
      }
      return stopReason(finish, tools.size > 0);
    },
  };
}

// A Responses stream can deliver the same content as deltas, *.done snapshots,
// and final response.output. Only append a suffix which wasn't already sent.
function snapshot(block, value) {
  if (typeof value !== "string" || !value || block.done) return;
  if (value.startsWith(block.value)) block.value = value;
  else if (!block.value.startsWith(value) && !block.sent) block.value = value;
}

function createResponsesReader(blocks, getModel) {
  const outputs = new Map();
  const ids = new Map();
  let hasTool = false;
  function stateFor(event) {
    const id = event.item_id || event.item?.id;
    const key = event.output_index ?? ids.get(id) ?? id;
    if (key === undefined) throw new Error("Copilot returned an output item without an index or ID.");
    if (id) ids.set(id, key);
    if (!outputs.has(key)) outputs.set(key, { parts: new Map(), summaries: new Map() });
    return outputs.get(key);
  }
  function tool(state) {
    hasTool = true;
    return state.tool ||= blocks.add("tool_use");
  }
  function text(state, index) {
    if (!state.parts.has(index)) state.parts.set(index, blocks.add("text"));
    return state.parts.get(index);
  }
  function thinking(state) {
    return state.reasoning ||= blocks.add("thinking");
  }
  function summary(state, index, value, full) {
    if (typeof value !== "string" || !value) return;
    state.summaries.set(index, full ? value : (state.summaries.get(index) || "") + value);
    snapshot(thinking(state), [...state.summaries.entries()].sort((a, b) => a[0] - b[0]).map(entry => entry[1]).join("\n"));
  }
  function itemSnapshot(state, item, done) {
    if (item.type === "function_call") {
      const block = tool(state);
      block.id ||= item.call_id;
      block.name ||= item.name;
      snapshot(block, item.arguments);
      // Some providers deliver an empty *.done before the real arguments.
      if (done && block.value) block.done = true;
    } else if (item.type === "message") {
      for (const [index, part] of (item.content || []).entries()) {
        if (part.type !== "output_text" && part.type !== "refusal") continue;
        const block = text(state, index);
        snapshot(block, part.text ?? part.refusal);
        if (done && block.value) block.done = true;
      }
    } else if (item.type === "reasoning") {
      const block = thinking(state);
      state.id ||= item.id;
      const supplied = reasoningText(item);
      if (supplied) snapshot(block, supplied);
      state.encrypted ||= item.encrypted_content;
      if (done) {
        const summaries = item.summary?.length ? item.summary : (block.value ? [{ type: "summary_text", text: block.value }] : []);
        if (state.encrypted && !state.carried) {
          // Some providers first disclose encrypted_content in response.completed,
          // after the public summary and the following tool have already closed.
          // Deliver an empty signed block now and restore its original position
          // on replay. The native tool does not have to wait for this snapshot.
          const carrier = block.closed ? blocks.add("thinking") : block;
          carrier.signature = reasoningSignature({ type: "reasoning", id: state.id, summary: summaries,
            encrypted_content: state.encrypted }, getModel(), block.closed ? block.before : undefined);
          carrier.done = true;
          state.carried = true;
        }
        block.done = true;
      }
    }
  }
  return {
    receive(event) {
      const type = event.type;
      if (type === "response.output_item.added" || type === "response.output_item.done") {
        itemSnapshot(stateFor(event), event.item, type.endsWith(".done"));
      } else if (type === "response.function_call_arguments.delta" || type === "response.function_call_arguments.done") {
        const block = tool(stateFor(event));
        block.id ||= event.call_id;
        block.name ||= event.name;
        if (type.endsWith(".delta")) block.value += event.delta || "";
        else snapshot(block, event.arguments);
      } else if (/^response\.(output_text|refusal)\.(delta|done)$/.test(type)) {
        const block = text(stateFor(event), event.content_index ?? 0);
        if (type.endsWith(".delta")) block.value += event.delta || "";
        else snapshot(block, event.text ?? event.refusal);
      } else if (/^response\.content_part\.(added|done)$/.test(type)) {
        if (event.part?.type !== "output_text" && event.part?.type !== "refusal") return;
        const block = text(stateFor(event), event.content_index ?? 0);
        snapshot(block, event.part.text ?? event.part.refusal);
        if (type.endsWith(".done") && block.value) block.done = true;
      } else if (/^response\.(reasoning_summary_text|reasoning_text|reasoning)\.(delta|done)$/.test(type)) {
        const full = type.endsWith(".done");
        summary(stateFor(event), event.summary_index ?? event.content_index ?? 0, full ? event.text : event.delta, full);
      } else if (type === "response.reasoning_summary_part.done") {
        summary(stateFor(event), event.summary_index ?? 0, event.part?.text, true);
      }
    },
    complete(body) {
      for (const [index, item] of (body.output || []).entries()) itemSnapshot(stateFor({ output_index: index, item }), item, true);
      for (const state of outputs.values()) {
        for (const block of state.parts.values()) block.done = true;
        if (state.tool) state.tool.done = true;
        if (state.reasoning && !state.reasoning.done) itemSnapshot(state, { type: "reasoning" }, true);
      }
      return stopReason(body.status, hasTool, body.incomplete_details?.reason);
    },
  };
}

function createStreamTranslator(format, model, write, estimatedInput = 0, upstreamModel) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let started = false;
  let ended = false;
  let id;
  let usage = usageForMessages({}, estimatedInput);
  function send(type, fields) {
    write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
  }
  function start() {
    if (started) return;
    started = true;
    send("message_start", { message: message(id, model, usage) });
  }
  const blocks = createBlockWriter(send);
  const isChat = format === "chat";
  const reader = isChat ? createChatReader(blocks, () => upstreamModel || model) : createResponsesReader(blocks, () => upstreamModel);
  function complete(body) {
    const reason = reader.complete(body);
    start();
    blocks.flush();
    send("message_delta", { delta: { stop_reason: reason, stop_sequence: null }, usage });
    send("message_stop", {});
    ended = true;
  }
  function fail(error) {
    if (ended) return;
    ended = true;
    send("error", { error: { type: "api_error", message: error?.message || String(error || "Copilot stream failed.") } });
  }
  function handle(frame) {
    if (ended) return;
    let eventType;
    const data = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith("event:")) eventType = line.slice(6).trim();
      if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    const raw = data.join("\n").trim();
    if (!raw) return;
    if (raw === "[DONE]") {
      if (!isChat) throw new Error("Copilot Responses stream ended without a terminal response.");
      complete(true);
      return;
    }
    const event = JSON.parse(raw);
    event.type ||= eventType;
    const body = event.response || event;
    upstreamModel ||= body.model;
    if (event.type === "error" || event.type === "response.failed" || event.type === "response.cancelled" || event.error || body.status === "failed") {
      throw upstreamError(body.error || event, "Copilot stream failed.");
    }
    id ||= body.id;
    if (body.usage) usage = usageForMessages(body.usage, estimatedInput);
    start();
    if (!isChat && (event.type === "response.completed" || event.type === "response.incomplete")) {
      complete({ ...body, status: body.status || event.type.slice("response.".length) });
    } else {
      reader.receive(event);
      blocks.flush();
    }
  }
  function consume(last) {
    let separator;
    while (!ended && (separator = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator[0].length);
      handle(frame);
    }
    if (last && buffer.trim()) handle(buffer);
  }
  return {
    feed(chunk) {
      if (ended) return;
      try {
        buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
        consume(false);
      } catch (error) { fail(error); }
    },
    end() {
      if (ended) return;
      try {
        buffer += decoder.end();
        consume(true);
        if (ended) return;
        if (isChat) complete(false);
        else throw new Error("Copilot Responses stream ended without a terminal response.");
      } catch (error) { fail(error); }
    },
    fail,
  };
}

module.exports = { createStreamTranslator, decodeChatSignature, decodeResponsesReasoning, decodeResponsesReplay, translateResponse };
