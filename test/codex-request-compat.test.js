const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeCodexRequest, retryCodexRequest, isModelUnavailable } = require("../lib/codex-request-compat");

function error(value, supported, param) {
  return { error: { message: `Unsupported value: '${value}' is not supported with the 'brand-new-model' model. Supported values are: ${supported.map(value => `'${value}'`).join(' and ')}.`, param } };
}

test("any model learns context support from the server without model-name rules", () => {
  for (const model of ["gpt-5-mini", "gpt-5.3-codex", "gpt-future-unseen"]) {
    const body = { model, reasoning: { context: "all_turns", effort: "high" },
      input: [{ role: "user", content: "Remember 42" }], tools: [{ name: "tool" }] };
    assert.equal(normalizeCodexRequest(body).body, body, "names alone must never trigger a rewrite");
    const repaired = retryCodexRequest(body, error("all_turns", ["auto", "current_turn"]));
    assert.equal(repaired.body.reasoning.context, "current_turn");
    assert.equal(repaired.body.model, model);
    assert.equal(repaired.body.input, body.input);
    assert.equal(repaired.body.tools, body.tools);
    assert.equal(body.reasoning.context, "all_turns");
    assert.deepEqual(normalizeCodexRequest(body, { constraints: repaired.constraints }).body, repaired.body);
  }
});

test("supported context values are negotiated, not assumed to always be current_turn", () => {
  const body = { model: "future", reasoning: { context: "all_turns" } };
  assert.equal(retryCodexRequest(body, error("all_turns", ["auto"])).body.reasoning.context, "auto");
  assert.equal(retryCodexRequest(body, error("all_turns", ["made_up"])).body, body);
});

test("reasoning and verbosity enum changes are learned only for unambiguous fields", () => {
  const body = { model: "future", reasoning: { effort: "max" }, text: { verbosity: "high" } };
  const repaired = retryCodexRequest(body, error("max", ["low", "medium", "high"], "reasoning.effort"));
  assert.equal(repaired.body.reasoning.effort, "high");
  const next = retryCodexRequest(repaired.body, error("high", ["low", "medium"], "text.verbosity"));
  assert.equal(next.body.text.verbosity, "medium");
  assert.equal(next.body.reasoning.effort, "high");
  assert.equal(retryCodexRequest(repaired.body, error("high", ["low", "medium"])).body, repaired.body);
});

test("explicit unsupported optional fields can be omitted without modifying payload data", () => {
  const body = { reasoning: { summary: "auto", effort: "high" }, input: "content" };
  const repaired = retryCodexRequest(body, { error: { message: "Unknown parameter: 'reasoning.summary'." } });
  assert.deepEqual(repaired.body, { reasoning: { effort: "high" }, input: "content" });
  assert.deepEqual(repaired.constraints, { "reasoning.summary": null });
  for (const field of ["model", "input", "tools", "max_output_tokens", "__proto__"]) {
    assert.equal(retryCodexRequest(body, { error: { message: `Unknown parameter: '${field}'.` } }).body, body);
  }
});

test("unknown IDs and legacy names are never silently remapped", () => {
  for (const model of ["gpt-5", "gpt-5-codex", "gpt-4o", "toString", "future"]) {
    const body = { model, reasoning: { effort: "max" } };
    assert.equal(normalizeCodexRequest(body, { copilotModels: [{ id: "gpt-5.5" }] }).body, body);
  }
});

test("live supported efforts are authoritative until corrected by a validation result", () => {
  const copilotModels = [{ id: "future", capabilities: { supports: { reasoning_effort: ["none", "low", "high", "xhigh"] } } }];
  for (const [wanted, expected] of [["max", "xhigh"], ["minimal", "low"], ["none", "none"], ["HIGH", "high"]]) {
    const result = normalizeCodexRequest({ model: "future", reasoning: { effort: wanted } }, { copilotModels });
    assert.equal(result.body.reasoning.effort, expected);
  }
  const result = normalizeCodexRequest({ model: "future", reasoning: { effort: "xhigh" } }, {
    copilotModels, constraints: { "reasoning.effort": ["low", "high"] },
  });
  assert.equal(result.body.reasoning.effort, "high");
});

test("unrelated errors, ambiguous values and already-repaired requests never retry", () => {
  const body = { model: "future", reasoning: { context: "all_turns" } };
  for (const response of ["not json", { error: { message: "unauthorized" } },
    error("all_turns", ["auto", "current_turn"], "input"), error("all_turns", ["all_turns", "auto"]),
    error("different", ["auto", "current_turn"])]) {
    assert.equal(retryCodexRequest(body, response).body, body);
  }
  const repaired = retryCodexRequest(body, error("all_turns", ["auto", "current_turn"]));
  assert.equal(retryCodexRequest(repaired.body, error("all_turns", ["auto", "current_turn"])).body, repaired.body);
  for (const body of [null, undefined, [], "input"]) assert.equal(normalizeCodexRequest(body).body, body);
});

test("only model-specific permanent failures affect availability", () => {
  assert.ok(isModelUnavailable(404, { error: { code: "model_not_found" } }));
  for (const status of [401, 429, 500, 503]) assert.equal(isModelUnavailable(status, { error: { code: "model_not_found" } }), false);
  assert.equal(isModelUnavailable(400, { error: { code: "invalid_request_body" } }), false);
});
