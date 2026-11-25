const assert = require("node:assert/strict");
const test = require("node:test");
const { createStreamTranslator, decodeChatSignature, decodeResponsesReasoning, translateResponse } = require("../lib/claude-output");
const { translateRequest } = require("../lib/claude-input");

const model = "claude-sonnet-4-6";
const reasoning = {
  type: "reasoning", id: "rs-1", encrypted_content: "provider-issued-ciphertext",
  summary: [{ type: "summary_text", text: "先查看目录。" }],
};
const tools = [
  { type: "function_call", id: "fc-1", call_id: "call-a", name: "Read", arguments: '{"path":"甲"}' },
  { type: "function_call", id: "fc-2", call_id: "call-b", name: "Glob", arguments: '{"pattern":"*.js"}' },
];

function capture(format) {
  const events = [];
  const translator = createStreamTranslator(format, model, frame => {
    events.push(JSON.parse(frame.split("\ndata: ")[1]));
  }, 19);
  return {
    events, translator,
    feed(payload, name) {
      const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
      const frame = Buffer.from(`${name ? "event: " + name + "\r\n" : ""}data: ${raw}\r\n\r\n`);
      // Deliberately split within Chinese UTF-8 code points and CRLF separators.
      for (let i = 0; i < frame.length; i += 2) translator.feed(frame.subarray(i, i + 2));
    },
  };
}

function assembled(events) {
  assert.equal(events[0].type, "message_start");
  assert.deepEqual(events.slice(-2).map(e => e.type), ["message_delta", "message_stop"]);
  const content = [];
  let current;
  let json;
  for (const event of events.slice(1, -2)) {
    if (event.type === "content_block_start") {
      assert.equal(current, undefined, "content blocks must not overlap");
      assert.equal(event.index, content.length);
      current = { ...event.content_block };
      json = "";
    } else if (event.type === "content_block_delta") {
      assert.ok(current);
      assert.equal(event.index, content.length);
      const d = event.delta;
      if (d.type === "thinking_delta") current.thinking += d.thinking;
      else if (d.type === "signature_delta") current.signature = d.signature;
      else if (d.type === "text_delta") current.text += d.text;
      else if (d.type === "input_json_delta") json += d.partial_json;
      else assert.fail("Unknown delta " + d.type);
    } else {
      assert.equal(event.type, "content_block_stop");
      assert.equal(event.index, content.length);
      assert.ok(current);
      if (json) current.input = JSON.parse(json);
      if (current.signature === "") delete current.signature;
      content.push(current);
      current = undefined;
    }
  }
  assert.equal(current, undefined, "no open blocks after message stop");
  return { content, stop: events.at(-2).delta.stop_reason, usage: events.at(-2).usage };
}

test("Responses semantic output and opaque replay survive streaming, rotating IDs and repeated snapshots", () => {
  const start = { ...reasoning, summary: [], encrypted_content: undefined };
  const finalBody = {
    id: "resp-1", status: "completed", output: [
      { ...reasoning, status: "completed", content: [{ type: "reasoning_text", text: "output-only" }] }, ...tools,
    ],
    usage: { input_tokens: 40, output_tokens: 9, input_tokens_details: { cached_tokens: 12 } },
  };
  const stream = capture("responses");
  stream.feed({ response: { id: "resp-1" } }, "response.created");
  stream.feed({ type: "response.output_item.added", item: start, output_index: 0 });
  stream.feed({ type: "response.reasoning_summary_text.delta", delta: "先查看", output_index: 0, summary_index: 0 });
  assert.equal(stream.events.at(-1).delta.thinking, "先查看", "thinking appears before completion");
  stream.feed({ type: "response.reasoning_summary_text.done", text: reasoning.summary[0].text, output_index: 0 });
  stream.feed({ type: "response.output_item.done", item: finalBody.output[0], output_index: 0 });
  for (const [index, call] of tools.entries()) {
    stream.feed({ type: "response.output_item.added", item: { ...call, arguments: "" }, output_index: index + 1 });
    stream.feed({ type: "response.function_call_arguments.delta", output_index: index + 1, delta: call.arguments.slice(0, 5) });
  }
  for (const [index, call] of tools.entries()) {
    stream.feed({ type: "response.function_call_arguments.done", output_index: index + 1, arguments: call.arguments });
    stream.feed({ type: "response.output_item.done", output_index: index + 1, item: { ...call, id: "rotated", call_id: "rotated" } });
  }
  stream.feed({ type: "response.completed", response: finalBody });
  stream.feed("[DONE]");
  stream.translator.end();
  const out = assembled(stream.events);
  const json = translateResponse("responses", finalBody, model);
  assert.deepEqual(out.content, json.content);
  assert.equal(out.stop, "tool_use");
  assert.deepEqual(out.usage, { input_tokens: 28, cache_read_input_tokens: 12, cache_creation_input_tokens: 0, output_tokens: 9 });
  assert.deepEqual(decodeResponsesReasoning(out.content[0].signature), reasoning);
  assert.equal(decodeResponsesReasoning("foreign-opaque-signature"), null);
  assert.equal(decodeResponsesReasoning("kobashi.responses.v1.%%%"), null);
});

test("Responses terminal snapshots fill missing text, tool calls and encrypted-only reasoning", () => {
  const body = { status: "completed", output: [
    { ...reasoning, summary: [] },
    { type: "message", content: [{ type: "output_text", text: "处理完毕" }] },
    ...tools,
  ] };
  const stream = capture("responses");
  stream.feed({ type: "response.output_item.added", item: { type: "reasoning", id: "rs-1", summary: [] }, output_index: 0 });
  stream.feed({ type: "response.output_text.delta", delta: "处理", output_index: 1 });
  stream.feed({ type: "response.completed", response: body });
  const { content } = assembled(stream.events);
  assert.deepEqual(content, translateResponse("responses", body, model).content);
  assert.equal(content[0].thinking, "");
  assert.equal(decodeResponsesReasoning(content[0].signature).encrypted_content, reasoning.encrypted_content);
});

test("Responses restores terminal-only encrypted state before its original tool without holding up execution", () => {
  const backend = { id: "gpt-test", vendor: "OpenAI" };
  for (const summaryParts of [reasoning.summary, []]) {
    const stream = capture("responses");
    const text = { type: "message", content: [{ type: "output_text", text: "Starting." }] };
    const partial = { type: "reasoning", id: reasoning.id, summary: summaryParts };
    const complete = { ...partial, encrypted_content: reasoning.encrypted_content };
    stream.feed({ type: "response.created", response: { id: "resp", model: backend.id } });
    for (const [output_index, item] of [text, partial, ...tools].entries()) {
      stream.feed({ type: "response.output_item.done", output_index, item });
    }
    const toolBlocks = stream.events.filter(e => e.content_block?.type === "tool_use").map(e => e.index);
    assert.equal(toolBlocks.length, 2);
    assert.ok(toolBlocks.every(i => stream.events.some(e => e.type === "content_block_stop" && e.index === i)),
      "both tools close before the terminal event arrives");
    const body = { model: backend.id, status: "completed", output: [text, complete, ...tools] };
    stream.feed({ type: "response.completed", response: body });
    for (const content of [assembled(stream.events).content, translateResponse("responses", body, model).content]) {
      const request = { messages: [{ role: "assistant", content }] };
      const replay = translateRequest("responses", request, backend);
      assert.deepEqual(replay.input.map(item => item.type || item.role), ["assistant", "reasoning", "function_call", "function_call"]);
      assert.deepEqual(replay.input[1], complete);
      const switched = translateRequest("responses", request, { id: "gpt-another", vendor: "OpenAI" });
      assert.deepEqual(switched.input.map(item => item.type || item.role), ["assistant", "function_call", "function_call"]);
    }
  }
});

test("a chat stream preserves parallel functions, fragmented names, opaque thinking and trailing usage", () => {
  const stream = capture("chat");
  const chunk = (delta, finish_reason) => stream.feed({ choices: [{ delta, finish_reason }] });
  chunk({ reasoning_content: "正在想", reasoning_opaque: "copilot-opaque" });
  chunk({ content: "我看一下" });
  chunk({ tool_calls: [{ index: 0, id: "call-a", function: { name: "Re" } }] });
  chunk({ tool_calls: [{ index: 0, function: { name: "ad", arguments: '{"path":' } },
    { index: 1, id: "call-b", function: { name: "Glob", arguments: tools[1].arguments } }] });
  chunk({ tool_calls: [{ index: 0, function: { arguments: '"甲"}' } }] }, "tool_calls");
  stream.feed({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 7 } });
  stream.feed("[DONE]");
  stream.translator.end();
  const out = assembled(stream.events);
  assert.equal(out.stop, "tool_use");
  assert.equal(out.usage.output_tokens, 7);
  const reasoning = out.content[0];
  assert.equal(reasoning.type, "thinking");
  assert.equal(reasoning.thinking, "正在想");
  assert.equal(decodeChatSignature(reasoning.signature, model).reasoning_opaque, "copilot-opaque");
  assert.deepEqual(out.content.slice(1), [
    { type: "text", text: "我看一下" },
    { type: "tool_use", id: "call-a", name: "Read", input: { path: "甲" } },
    { type: "tool_use", id: "call-b", name: "Glob", input: { pattern: "*.js" } },
  ]);
});

test("Gemini Chat tool signatures replay with the same call and model, including late SSE metadata", () => {
  const backend = { id: "gemini-test", vendor: "Google" };
  const modelMessage = {
    content: null, reasoning_text: "Inspect both files.", reasoning_opaque: "opaque-step",
    tool_calls: tools.map((tool, i) => ({
      index: i, id: tool.call_id, type: "function", function: { name: tool.name, arguments: tool.arguments },
      extra_content: { google: { thought_signature: "sig-" + i, ignored: 42 }, ignored: true },
    })),
  };
  const body = { model: backend.id, choices: [{ message: modelMessage, finish_reason: "tool_calls" }] };
  const json = translateResponse("chat", body, model);
  const stream = capture("chat");
  const send = delta => stream.feed({ model: backend.id, choices: [{ delta }] });
  send({ reasoning_text: modelMessage.reasoning_text, reasoning_opaque: modelMessage.reasoning_opaque });
  send({ tool_calls: [{ index: 0, extra_content: modelMessage.tool_calls[0].extra_content }] });
  send({ tool_calls: modelMessage.tool_calls.map(({extra_content, ...tool}) => tool) });
  send({ tool_calls: [{ index: 1, extra_content: modelMessage.tool_calls[1].extra_content }] });
  stream.feed("[DONE]");
  for (const content of [json.content, assembled(stream.events).content]) {
    const request = { model, messages: [{ role: "assistant", content }, { role: "user", content: tools.map(tool =>
      ({ type: "tool_result", tool_use_id: tool.call_id, content: "ready" })) }] };
    const replay = translateRequest("chat", request, backend).messages[0];
    assert.equal(replay.reasoning_opaque, "opaque-step");
    assert.deepEqual(replay.tool_calls.map(c => c.extra_content), [
      { google: { thought_signature: "sig-0" } }, { google: { thought_signature: "sig-1" } },
    ]);
    const switched = translateRequest("chat", request, { ...backend, id: "gemini-other" }).messages[0];
    assert.equal(switched.reasoning_opaque, undefined);
    assert.ok(switched.tool_calls.every(call => !call.extra_content));
  }
});

test("SSE failures and truncated transfers have a single error terminal and never report success", () => {
  for (const format of ["responses", "chat"]) {
    const stream = capture(format);
    stream.feed(format === "responses"
      ? { type: "response.output_text.delta", output_index: 0, delta: "partial" }
      : { choices: [{ delta: { content: "partial" } }] });
    stream.translator.end();
    stream.translator.fail(new Error("second notification"));
    assert.equal(stream.events.at(-1).type, "error");
    assert.equal(stream.events.filter(e => e.type === "error").length, 1);
    assert.ok(!stream.events.some(e => e.type === "message_stop"));
  }
  const stream = capture("responses");
  stream.feed({ type: "response.failed", response: { status: "failed", error: { message: "Account quota exhausted" } } });
  stream.feed({ type: "response.completed", response: { output: [] } });
  assert.deepEqual(stream.events, [{ type: "error", error: { type: "api_error", message: "Account quota exhausted" } }]);
});

test("token limits, refusal, empty reasoning and invalid tools stay distinguishable from successful tool use", () => {
  const stream = capture("responses");
  const body = { output: [{ type: "message", content: [{ type: "output_text", text: "partial" }] }],
    status: "incomplete", incomplete_details: { reason: "max_output_tokens" } };
  stream.feed({ type: "response.incomplete", response: body });
  assert.equal(assembled(stream.events).stop, "max_tokens");
  const refusal = translateResponse("chat", { choices: [{ finish_reason: "content_filter", message: { reasoning_content: "", refusal: "Declined" } }] }, model);
  assert.deepEqual(refusal.content, [{ type: "text", text: "Declined" }]);
  assert.equal(refusal.stop_reason, "refusal");
  const bad = capture("responses");
  bad.feed({ type: "response.completed", response: { output: [{ ...tools[0], arguments: '{"incomplete":' }] } });
  assert.equal(bad.events.at(-1).type, "error");
  assert.ok(!bad.events.some(e => e.type === "message_stop"));
  assert.throws(() => translateResponse("responses", { output: [{ ...tools[0], arguments: "[1]" }] }, model), /Invalid arguments/);
});
