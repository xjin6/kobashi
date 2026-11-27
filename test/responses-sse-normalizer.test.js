const assert = require("assert/strict");
const { once } = require("events");
const test = require("node:test");
const { createResponsesSseNormalizer, normalizeModelAliasHeaders } = require("../lib/responses-sse-normalizer");

async function normalize(chunks, options) {
  const stream = createResponsesSseNormalizer(options);
  let output = "";
  stream.setEncoding("utf8");
  stream.on("data", chunk => { output += chunk; });
  for (const chunk of chunks) stream.write(chunk);
  stream.end();
  await once(stream, "end");
  return output;
}

function eventsFrom(sse) {
  const events = [];
  for (const block of sse.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/)
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data || data === "[DONE]") continue;
    try { events.push(JSON.parse(data)); } catch {}
  }
  return events;
}

test("uses one item and response id for an entire streamed message", async () => {
  const source = [
    ["response.created", { type: "response.created", response: { id: "resp-first", output: [] } }],
    ["response.in_progress", { type: "response.in_progress", response: { id: "resp-random", output: [] } }],
    ["response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { id: "msg-first", type: "message", content: [] } }],
    ["response.content_part.added", { type: "response.content_part.added", output_index: 0, item_id: "msg-random-1", content_index: 0 }],
    ["response.output_text.delta", { type: "response.output_text.delta", output_index: 0, item_id: "msg-random-2", content_index: 0, delta: "hello" }],
    ["response.output_text.done", { type: "response.output_text.done", output_index: 0, item_id: "msg-random-3", content_index: 0, text: "hello" }],
    ["response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { id: "msg-random-4", type: "message", content: [] } }],
    ["response.completed", { type: "response.completed", response: { id: "resp-random-2", output: [{ id: "msg-random-5", type: "message", content: [] }] } }],
  ].map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");

  const events = eventsFrom(await normalize([source]));
  assert.deepEqual(events.map(event => event.response && event.response.id).filter(Boolean), [
    "resp-first", "resp-first", "resp-first",
  ]);
  const itemIds = events.flatMap(event => [
    event.item && event.item.id,
    event.item_id,
    ...(event.response && event.response.output || []).map(item => item.id),
  ]).filter(Boolean);
  assert.deepEqual([...new Set(itemIds)], ["msg-first"]);
});

test("keeps parallel output items separate and stabilizes tool call ids", async () => {
  const frames = [
    { type: "response.output_item.added", output_index: 0, item: { id: "msg-0", type: "message" } },
    { type: "response.output_item.added", output_index: 1, item: { id: "tool-1", call_id: "call-1", type: "function_call" } },
    { type: "response.function_call_arguments.delta", output_index: 1, item_id: "tool-random-1", delta: "{}" },
    { type: "response.output_item.done", output_index: 1, item: { id: "tool-random-2", call_id: "call-random", type: "function_call" } },
    { type: "response.output_item.done", output_index: 0, item: { id: "msg-random", type: "message" } },
    { type: "response.completed", response: { id: "resp", output: [
      { id: "msg-random-2", type: "message" },
      { id: "tool-random-3", call_id: "call-random-2", type: "function_call" },
    ] } },
  ];
  const source = frames.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
  const events = eventsFrom(await normalize([source]));

  assert.equal(events[2].item_id, "tool-1");
  assert.equal(events[3].item.id, "tool-1");
  assert.equal(events[3].item.call_id, "call-1");
  assert.equal(events[4].item.id, "msg-0");
  assert.deepEqual(events[5].response.output.map(item => item.id), ["msg-0", "tool-1"]);
  assert.equal(events[5].response.output[1].call_id, "call-1");
});

test("handles split UTF-8, CRLF and multiline data without touching other frames", async () => {
  const added = "event: response.output_item.added\r\ndata: {\"type\":\"response.output_item.added\",\r\ndata: \"output_index\":0,\"item\":{\"id\":\"消息-id\",\"type\":\"message\"}}\r\n\r\n";
  const delta = "event: response.output_text.delta\r\ndata: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"item_id\":\"random\",\"delta\":\"你\"}\r\n\r\n";
  const untouched = ": keepalive\r\n\r\ndata: [DONE]\r\n\r\n";
  const bytes = Buffer.from(added + delta + untouched);
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 3) chunks.push(bytes.subarray(offset, offset + 3));

  const output = await normalize(chunks);
  const events = eventsFrom(output);
  assert.equal(events[0].item.id, "消息-id");
  assert.equal(events[1].item_id, "消息-id");
  assert.equal(events[1].delta, "你");
  assert.match(output, /: keepalive\r\n\r\n/);
  assert.match(output, /data: \[DONE\]\r\n\r\n/);
});

test("passes malformed and non-JSON SSE data through byte-for-byte", async () => {
  const source = "event: custom\ndata: not-json\n\n: ping\n\ndata: [DONE]\n\n";
  assert.equal(await normalize([source]), source);
});

test("observes named SSE errors without changing the forwarded payload", async () => {
  const source = 'event: error\ndata: {"error":{"code":"model_not_found"}}\n\n';
  const observed = [];
  const stream = createResponsesSseNormalizer({ onEvent: event => observed.push(event) });
  let output = "";
  stream.on("data", chunk => { output += chunk; });
  stream.end(source);
  await once(stream, "end");
  assert.equal(output, source);
  assert.equal(observed[0].type, "error");
  assert.equal(observed[0].error.code, "model_not_found");
});

test("aliases exact model headers without mutating the upstream headers", () => {
  const alias = { from: "gpt-fixture-fast", to: "gpt-fixture" };
  const headers = Object.freeze({
    "openai-model": alias.from,
    "OpenAI-Model": alias.from,
    "OPENAI-MODEL": "gpt-unexpected",
    "x-model": alias.from,
    "content-type": "text/event-stream",
  });
  assert.deepEqual(normalizeModelAliasHeaders(headers, alias), {
    ...headers, "openai-model": alias.to, "OpenAI-Model": alias.to,
  });
  assert.equal(headers["openai-model"], alias.from);
  assert.equal(normalizeModelAliasHeaders(headers), headers);
  assert.equal(normalizeModelAliasHeaders(headers, { from: alias.from, to: alias.from }), headers);
  const unexpected = Object.freeze({ "OpenAI-Model": `${alias.from}-snapshot` });
  assert.equal(normalizeModelAliasHeaders(unexpected, alias), unexpected);
  assert.equal(normalizeModelAliasHeaders(null, alias), null);
});

test("aliases native response model metadata while preserving payloads and upstream observations", async () => {
  const modelAlias = { from: "gpt-fixture-fast", to: "gpt-fixture" };
  const sourceEvent = {
    type: "response.completed",
    response: {
      id: "resp-fast", status: "completed", model: modelAlias.from,
      headers: { "oPeNaI-mOdEl": modelAlias.from, "x-request-id": "request-fast" },
      output: [{ id: "msg-fast", type: "message", content: [{ type: "output_text", text: modelAlias.from }] }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  };
  const observed = [];
  const source = `event: response.completed\ndata: ${JSON.stringify(sourceEvent)}\n\n`;
  const output = await normalize([source], {
    modelAlias, onEvent: event => observed.push(JSON.parse(JSON.stringify(event))),
  });
  const [event] = eventsFrom(output);
  assert.deepEqual(event, {
    ...sourceEvent, response: {
      ...sourceEvent.response, model: modelAlias.to,
      headers: { ...sourceEvent.response.headers, "oPeNaI-mOdEl": modelAlias.to },
    },
  });
  assert.deepEqual(observed, [sourceEvent]);
});

test("retains unexpected response model identities and bytes when no alias applies", async () => {
  const source = 'event: response.created\r\ndata: { "response": { "id": "resp-one", "model": "gpt-other", "headers": { "OpenAI-Model": "gpt-other" } } }\r\n\r\n';
  assert.equal(await normalize([source], {
    modelAlias: { from: "gpt-fixture-fast", to: "gpt-fixture" },
  }), source);
  const aliasedSource = source.replaceAll("gpt-other", "gpt-fixture-fast");
  assert.equal(await normalize([aliasedSource]), aliasedSource);
  assert.equal(await normalize([aliasedSource], {
    modelAlias: { from: "gpt-fixture-fast", to: "gpt-fixture-fast" },
  }), aliasedSource);
});

test("supports an explicitly verified reverse alias without inferring other model names", async () => {
  const source = 'data: {"response":{"model":"gpt-fixture","headers":{"OpenAI-Model":"gpt-fixture-fast-v2"}}}\n\n';
  const [event] = eventsFrom(await normalize([source], {
    modelAlias: { from: "gpt-fixture", to: "gpt-fixture-fast" },
  }));
  assert.equal(event.response.model, "gpt-fixture-fast");
  assert.equal(event.response.headers["OpenAI-Model"], "gpt-fixture-fast-v2");
});
