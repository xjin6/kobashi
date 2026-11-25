const assert = require("node:assert/strict");
const test = require("node:test");
const { desktopEffortProfile } = require("../lib/claude-effort");
const { translateRequest } = require("../lib/claude-input");

function model(efforts) {
  return { id: "new-vendor-model", vendor: "New vendor", capabilities: { supports: { reasoning_effort: efforts } } };
}

test("the Desktop cap exposes the levels declared for the selected model", () => {
  for (const [levels, maxEffort] of [
    [["none", "low"], "low"],
    [["low", "medium"], "medium"],
    [["HIGH", "low", " medium ", "high"], "high"],
    [["max", "extra_high", "high", "medium", "low", "ultra"], "max"],
    [["low", "medium", "high", "extra-high"], "xhigh"],
  ]) {
    assert.deepEqual(desktopEffortProfile(model(levels)), { behavesAs: "claude-sonnet-5", maxEffort });
  }
  const legacy = { id: "unseen", capabilities: { reasoning_effort: ["low", "medium", "high"] } };
  assert.deepEqual(desktopEffortProfile(legacy), { behavesAs: "claude-sonnet-5", maxEffort: "high" });
  assert.deepEqual(desktopEffortProfile({ ...legacy, capabilities: { ...legacy.capabilities, supports: { reasoning_effort: [] } } }), {});
});

test("sparse declarations use a matching native template or the longest truthful range", () => {
  assert.deepEqual(desktopEffortProfile(model(["low", "medium", "high", "max"])), { behavesAs: "claude-sonnet-4-6", maxEffort: "max" });
  assert.deepEqual(desktopEffortProfile(model(["low", "medium", "xhigh"])), { behavesAs: "claude-sonnet-5", maxEffort: "medium" });
  for (const unsupported of [["low", "high"], ["medium", "high"], ["minimal", "high"], ["none", "minimal", "ultra"],
    ["unknown", null], [], true, false, undefined]) {
    assert.deepEqual(desktopEffortProfile(model(unsupported)), {});
  }
  assert.deepEqual(desktopEffortProfile({ ...model(["low", "medium"]), vendor: "Anthropic" }), {});
  assert.deepEqual(desktopEffortProfile({ ...model(["low", "medium"]), id: "claude-sonnet-5" }), {});
});

test("upstream effort uses advertised spelling and the established caps on both translated protocols", () => {
  for (const format of ["chat", "responses"]) {
    function wire(levels, effort, thinking, id = "future") {
      const request = { messages: [], output_config: { effort }, thinking };
      const result = translateRequest(format, request, { ...model(levels), id });
      return result.reasoning?.effort ?? result.reasoning_effort;
    }
    for (const [list, asked, sent] of [
      [["low", "high", "extra_high"], "xhigh", "extra_high"],
      [["low", "EXTRA-HIGH"], "max", "EXTRA-HIGH"],
      [["low", "xhigh", "extra_high"], "extra_high", "xhigh"],
      [["HIGH", "low"], "medium", "low"],
      [["HIGH", "low"], "max", "high"],
      [["high", "extra-high"], "ultracode", "extra-high"],
      [["high", "ultra"], "ultra", "ultra"],
    ]) assert.equal(wire(list, asked), sent);
    assert.equal(wire(["none", "low"], "high", { type: "disabled" }), "none");
    assert.equal(wire(["minimal", "high"], "high", { type: "disabled" }), "minimal");
    assert.equal(wire(undefined, "high"), undefined);
    assert.equal(wire(undefined, "max", undefined, "gpt-6-test"), "high");
    assert.equal(wire([], "high", undefined, "gpt-6-test"), undefined);
  }
});
