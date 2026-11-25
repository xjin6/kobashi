"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { translateRequest } = require("../lib/claude-input");
const { translateResponse } = require("../lib/claude-output");

const model = {
  id: "gpt-5-example", vendor: "OpenAI", capabilities: {
    supports: { reasoning_effort: ["low", "medium", "high"] }, limits: { max_output_tokens: 8192 },
  },
};
const tools = [
  { name: "Read", input_schema: { type: "object", properties: { file: { type: "string" }, offset: { type: "integer" } }, required: ["file"] }, defer_loading: true },
  { name: "ToolSearch", description: "Find tools", input_schema: { type: "object", properties: { query: { type: "string" } } } },
];
const screenshot = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };
const request = {
  model: "claude-sonnet-4-6", system: [{ type: "text", text: "Use the tools", cache_control: { type: "ephemeral" } }],
  stream: true, max_tokens: 16000, temperature: 0, thinking: { type: "adaptive" }, output_config: { effort: "xhigh" },
  tools, tool_choice: { type: "tool", name: "Read", disable_parallel_tool_use: true },
  messages: [
    { role: "user", content: "inspect" },
    { role: "assistant", content: [
      { type: "text", text: "Looking." },
      { type: "tool_use", id: "call_1", name: "ToolSearch", input: { query: "Read" } },
      { type: "tool_use", id: "call_2", name: "Read", input: { file: "screen.png" } },
    ] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "call_1", content: [{ type: "tool_reference", tool_name: "Read" }] },
      { type: "tool_result", tool_use_id: "call_2", content: [screenshot, { type: "text", text: "capture" }] },
      { type: "text", text: "What changed?" },
    ] },
  ],
};

test("native Messages only replaces the model and preserves signed content, cache controls, betas and tools", () => {
  const native = { ...request, anthropic_beta: ["test"], extra_future_field: true };
  assert.deepEqual(translateRequest("messages", native, model), { ...native, model: model.id });
  assert.equal(native.model, "claude-sonnet-4-6");
});

test("Responses keeps the ordered tool loop, callable deferred schemas, mixed media and effort", () => {
  const out = translateRequest("responses", request, model);
  assert.equal(out.model, model.id);
  assert.equal(out.instructions, "Use the tools");
  assert.equal(out.store, false);
  assert.equal(out.max_output_tokens, 8192);
  assert.equal(out.temperature, undefined);
  assert.deepEqual(out.reasoning, { effort: "high", summary: "auto" });
  assert.deepEqual(out.include, ["reasoning.encrypted_content"]);
  assert.deepEqual(out.tools[0], { type: "function", name: "Read", parameters: tools[0].input_schema, strict: false });
  assert.deepEqual(out.tool_choice, { type: "function", name: "Read" });
  assert.equal(out.parallel_tool_calls, false);
  assert.deepEqual(out.input.map(i => i.type || i.role), ["user", "assistant", "function_call", "function_call", "function_call_output", "function_call_output", "user"]);
  assert.deepEqual(out.input[2], { type: "function_call", call_id: "call_1", name: "ToolSearch", arguments: '{"query":"Read"}' });
  assert.deepEqual(out.input[4], { type: "function_call_output", call_id: "call_1", output: "Tool reference: Read" });
  assert.deepEqual(out.input[5].output, [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }, { type: "input_text", text: "capture" }]);
  assert.equal(out.input[6].content[0].text, "What changed?");
});

test("Chat preserves all parallel call IDs and delivers mixed tool results and user follow-up", () => {
  const out = translateRequest("chat", request, model);
  assert.equal(out.max_completion_tokens, 8192);
  assert.equal(out.reasoning_effort, "high");
  assert.deepEqual(out.stream_options, { include_usage: true });
  assert.deepEqual(out.tools[0].function.parameters.required, ["file"]);
  assert.deepEqual(out.tool_choice, { type: "function", function: { name: "Read" } });
  assert.equal(out.parallel_tool_calls, false);
  assert.deepEqual(out.messages.map(m => m.role), ["system", "user", "assistant", "tool", "tool", "user"]);
  assert.deepEqual(out.messages[2].tool_calls.map(t => t.id), ["call_1", "call_2"]);
  assert.equal(out.messages[3].tool_call_id, "call_1");
  assert.match(out.messages[3].content, /Read/);
  assert.deepEqual(out.messages[4], { role: "tool", tool_call_id: "call_2", content: "capture" });
  assert.deepEqual(out.messages[5].content, [
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }, { type: "text", text: "What changed?" },
  ]);
});

test("Responses restores only bridge-owned encrypted state followed by generated content in the same turn", () => {
  const item = { type: "reasoning", id: "rs", encrypted_content: "opaque", summary: [], status: "completed" };
  const [block] = translateResponse("responses", { output: [item], status: "completed" }, request.model).content;
  const next = { messages: [
    { role: "assistant", content: [block] },
    { role: "user", content: "Continue." },
    { role: "assistant", content: [{ type: "thinking", thinking: "private", signature: "foreign" }, block, request.messages[1].content[1], block] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", is_error: true, content: "unavailable" }] },
  ] };
  const out = translateRequest("responses", next, model);
  assert.deepEqual(out.input.map(i => i.type || i.role), ["user", "reasoning", "function_call", "function_call_output"]);
  assert.deepEqual(out.input[1], { type: "reasoning", id: "rs", encrypted_content: "opaque", summary: [] });
  assert.match(out.input.at(-1).output, /tool error.*\nunavailable/);
  assert.doesNotMatch(JSON.stringify(out), /private|foreign/);
});

test("endpoints keep client ToolSearch and expand hosted search into the supplied deferred client tools", () => {
  for (const format of ["responses", "chat"]) {
    const hosted = { type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" };
    const common = { messages: [], tools: [...tools, hosted], tool_choice: { type: "any" } };
    const out = translateRequest(format, common, model);
    assert.deepEqual(out.tools.map(t => t.name || t.function.name), ["Read", "ToolSearch"]);
    assert.equal(out.tool_choice, "required");
    const forced = { ...common, tool_choice: { type: "tool", name: hosted.name } };
    assert.throws(() => translateRequest(format, forced, model), /tool_search_tool_regex.*cannot run/);
    const search = { type: "web_search_20250305", name: "web_search" };
    assert.throws(() => translateRequest(format, { messages: [], tools: [search] }, model), /web_search.*cannot run/);
    const mixed = { messages: [], tools: [search, ...tools] };
    assert.deepEqual(translateRequest(format, mixed, model).tools, out.tools);
    assert.throws(() => translateRequest(format, { ...mixed, tool_choice: { type: "tool", name: search.name } }, model), /web_search.*cannot run/);
  }
});

test("per-model capabilities control sampling, requested reasoning level and minimum probe output", () => {
  const normal = { id: "gemini-chat", capabilities: { supports: { reasoning_effort: false } } };
  const base = { messages: [], max_tokens: 1, stream: false, temperature: 0, thinking: { type: "enabled", budget_tokens: 4000 } };
  const chat = translateRequest("chat", base, normal);
  assert.equal(chat.max_tokens, 1);
  assert.equal(chat.temperature, 0);
  assert.equal(chat.reasoning_effort, undefined);
  assert.equal(chat.stream_options, undefined);
  assert.equal(translateRequest("responses", base, model).max_output_tokens, 16);
  const future = { id: "future", capabilities: { supports: { reasoning_effort: ["minimal", "high", "ultra"], reasoning_summary: false } } };
  const on = translateRequest("responses", { ...base, output_config: { effort: "ultra" } }, future);
  assert.deepEqual(on.reasoning, { effort: "ultra" });
  assert.deepEqual(translateRequest("responses", { ...base, thinking: { type: "disabled" }, output_config: { effort: "high" } }, future).reasoning, { effort: "minimal" });
});

test("catalogue fallbacks respect absent versus explicitly disabled capabilities", () => {
  const legacy = { id: "future-vendor", capabilities: {
    reasoning_effort: ["HIGH", "low", 7], supports: { parallel_tool_calls: false, reasoning_summary: false },
  } };
  const params = { ...request, tool_choice: { type: "auto", disable_parallel_tool_use: false } };
  for (const format of ["responses", "chat"]) {
    const out = translateRequest(format, params, legacy);
    assert.equal(out.reasoning?.effort ?? out.reasoning_effort, "high");
    assert.equal(out.reasoning?.summary, undefined);
    assert.equal(out.parallel_tool_calls, undefined);
  }
  const explicit = { id: "gpt-5-chat-latest", capabilities: {
    reasoning_effort: ["high"], supports: { reasoning_effort: [], reasoning_summary: false },
  } };
  const response = translateRequest("responses", request, explicit);
  assert.equal(response.reasoning, undefined);
  assert.equal(response.include, undefined);
});
