const assert = require("node:assert/strict");
const test = require("node:test");
const { probeCodexModel, createProbeRequest, PROBE_TOOL } = require("../lib/codex-model-probe");
const model = { id: "gpt-future", capabilities: { supports: { reasoning_effort: ["low", "high", "xhigh", "max"] } } };
function success() {
  return { status: 200, headers: { "content-type": "text/event-stream" }, body: `data: ${JSON.stringify({ type: "response.completed", response: {
    status: "completed", output: [{ type: "function_call", name: PROBE_TOOL, arguments: '{"value":"OK"}' }],
  } })}\n\n` };
}

test("probe validates the native Ultra effort, including model-specific overrides", () => {
  for (const [override, expected] of [[undefined, "max"], ["xhigh", "xhigh"]]) {
    const native = { supported_reasoning_levels: [{ effort: "ultra" }], multi_agent_reasoning_effort: override };
    assert.equal(createProbeRequest(model, native).reasoning.effort, expected);
  }
});

test("unknown model context is discovered automatically before the model is admitted", async () => {
  const calls = [];
  const result = await probeCodexModel(model, null, async body => {
    calls.push(body);
    return body.reasoning.context === "all_turns" ? { status: 400, body: { error: {
      message: "Unsupported value: 'all_turns' is not supported with the 'unreleased' model. Supported values are: 'auto' and 'current_turn'.",
    } } } : success();
  });
  assert.equal(result.state, "verified");
  assert.deepEqual(result.constraints, { "reasoning.context": ["auto", "current_turn"] });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].model, model.id);
});

test("HTTP 200 alone is insufficient; streaming and a completed valid tool call are required", async () => {
  for (const response of [
    { status: 200, headers: { "content-type": "application/json" }, body: '{}' },
    { ...success(), body: 'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n' },
  ]) assert.equal((await probeCodexModel(model, null, async () => response)).state, "unavailable");
  assert.equal((await probeCodexModel(model, null, async () => ({ ...success(), body: 'data: {"type":"response.created"}\n\n' }))).state, "transient");
});

test("limit and network errors do not mean a model is incompatible", async () => {
  for (const status of [401, 429, 503]) {
    assert.equal((await probeCodexModel(model, null, async () => ({ status, body: '{}' }))).state, "transient");
  }
  assert.equal((await probeCodexModel(model, null, async () => { throw new Error("offline"); })).state, "transient");
});

test("new parameter constraints can be negotiated together with bounded retries", async () => {
  let calls = 0;
  const result = await probeCodexModel(model, null, async body => {
    calls++;
    if (body.reasoning.context) return { status: 400, body: { error: { message: "Unknown parameter: 'reasoning.context'." } } };
    if (body.text?.verbosity) return { status: 400, body: { error: { message: "Unknown parameter: 'text.verbosity'." } } };
    return success();
  });
  assert.equal(result.state, "verified");
  assert.equal(calls, 3);
  assert.deepEqual(result.constraints, { "reasoning.context": null, "text.verbosity": null });
});

test("SSE event names and data-only errors both contribute validation evidence", async () => {
  for (const prefix of ["event: error\n", ""]) {
    let calls = 0;
    const result = await probeCodexModel(model, null, async () => ++calls === 1 ? {
      status: 200, headers: { "content-type": "text/event-stream" },
      body: prefix + 'data: {"error":{"message":"Unsupported value: \'all_turns\' is not supported with the \'future\' model. Supported values are: \'auto\' and \'current_turn\'."}}\n\n',
    } : success());
    assert.equal(result.state, "verified");
    assert.equal(calls, 2);
  }
  const response = success();
  response.body = 'event: response.completed\n' + response.body.replace('"type":"response.completed",', '');
  assert.equal((await probeCodexModel(model, null, async () => response)).state, "verified");
});

test("streamed service failures are transient, not permanent model incompatibility", async () => {
  const response = { status: 200, headers: { "content-type": "text/event-stream" },
    body: 'event: error\ndata: {"code":"server_error","message":"Try again"}\n\n' };
  assert.equal((await probeCodexModel(model, null, async () => response)).state, "transient");
});
