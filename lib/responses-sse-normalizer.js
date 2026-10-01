const { StringDecoder } = require("string_decoder");
const { Transform } = require("stream");

// GitHub Copilot currently encrypts the same Responses item id independently
// in each SSE event. The ciphertext therefore changes between item.added,
// text.delta and item.done even though all of those events refer to one
// output_index. OpenAI clients use the id to correlate that lifecycle; without
// a stable value, a streamed assistant message and its completed form can be
// rendered as two different messages.
//
// Keep the first upstream id we see for each output_index. It is still a valid
// upstream-issued id (important if a client sends it back in later input), and
// rewrite the rest of that output item's lifecycle to match it.

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function createEventNormalizer() {
  const outputs = new Map();
  let responseId = null;

  function outputState(index) {
    let state = outputs.get(index);
    if (!state) {
      state = { itemId: null, callId: null };
      outputs.set(index, state);
    }
    return state;
  }

  function normalizeField(owner, key, state, stateKey) {
    if (!isObject(owner) || typeof owner[key] !== "string" || !owner[key]) return false;
    if (!state[stateKey]) {
      state[stateKey] = owner[key];
      return false;
    }
    if (owner[key] === state[stateKey]) return false;
    owner[key] = state[stateKey];
    return true;
  }

  function normalizeItem(item, index) {
    if (!isObject(item) || !Number.isInteger(index)) return false;
    const state = outputState(index);
    let changed = normalizeField(item, "id", state, "itemId");
    changed = normalizeField(item, "call_id", state, "callId") || changed;
    return changed;
  }

  function normalizeResponse(response) {
    if (!isObject(response)) return false;
    let changed = false;
    if (typeof response.id === "string" && response.id) {
      if (!responseId) responseId = response.id;
      else if (response.id !== responseId) {
        response.id = responseId;
        changed = true;
      }
    }
    if (Array.isArray(response.output)) {
      for (let index = 0; index < response.output.length; index++) {
        changed = normalizeItem(response.output[index], index) || changed;
      }
    }
    return changed;
  }

  return function normalizeEvent(event) {
    if (!isObject(event)) return false;
    let changed = false;

    changed = normalizeResponse(event.response) || changed;

    if (typeof event.response_id === "string" && event.response_id) {
      if (!responseId) responseId = event.response_id;
      else if (event.response_id !== responseId) {
        event.response_id = responseId;
        changed = true;
      }
    }

    if (Number.isInteger(event.output_index)) {
      const state = outputState(event.output_index);
      changed = normalizeItem(event.item, event.output_index) || changed;
      changed = normalizeField(event, "item_id", state, "itemId") || changed;
      changed = normalizeField(event, "call_id", state, "callId") || changed;
    }

    return changed;
  };
}

function parseSseLine(line) {
  const colon = line.indexOf(":");
  const field = colon === -1 ? line : line.slice(0, colon);
  let value = colon === -1 ? "" : line.slice(colon + 1);
  if (value.startsWith(" ")) value = value.slice(1);
  return { field, value };
}

function rewriteEventBlock(block, normalizeEvent) {
  const lineEnding = block.includes("\r\n") ? "\r\n" : "\n";
  const lines = block.split(/\r?\n/);
  const dataIndexes = [];
  const data = [];

  for (let index = 0; index < lines.length; index++) {
    const parsed = parseSseLine(lines[index]);
    if (parsed.field !== "data") continue;
    dataIndexes.push(index);
    data.push(parsed.value);
  }

  if (!dataIndexes.length) return block;
  const raw = data.join("\n");
  if (!raw || raw === "[DONE]") return block;

  let event;
  try { event = JSON.parse(raw); }
  catch { return block; }
  const eventName = lines.map(parseSseLine).find(line => line.field === "event")?.value;
  if (!normalizeEvent(event, eventName)) return block;

  const firstDataIndex = dataIndexes[0];
  const skipped = new Set(dataIndexes.slice(1));
  const rewritten = [];
  for (let index = 0; index < lines.length; index++) {
    if (index === firstDataIndex) rewritten.push(`data: ${JSON.stringify(event)}`);
    else if (!skipped.has(index)) rewritten.push(lines[index]);
  }
  return rewritten.join(lineEnding);
}

function createResponsesSseNormalizer({ onEvent } = {}) {
  const decoder = new StringDecoder("utf8");
  const normalize = createEventNormalizer();
  const normalizeEvent = (event, eventName) => {
    try { onEvent?.(event.type ? event : { ...event, type: eventName }); } catch {}
    return normalize(event);
  };
  let buffered = "";

  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        buffered += decoder.write(chunk);
        while (true) {
          const separator = /\r?\n\r?\n/.exec(buffered);
          if (!separator) break;
          const block = buffered.slice(0, separator.index);
          buffered = buffered.slice(separator.index + separator[0].length);
          this.push(rewriteEventBlock(block, normalizeEvent) + separator[0]);
        }
        callback();
      } catch (error) {
        callback(error);
      }
    },
    flush(callback) {
      try {
        buffered += decoder.end();
        if (buffered) this.push(rewriteEventBlock(buffered, normalizeEvent));
        callback();
      } catch (error) {
        callback(error);
      }
    },
  });
}

module.exports = { createResponsesSseNormalizer };
