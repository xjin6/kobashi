const { getCopilotReasoningEfforts } = require("./codex-model-catalog");
const { retryCodexRequest, parseError } = require("./codex-request-compat");

const PROBE_TOOL = "kobashi_capability_check";
const PROBE_VERSION = 1;

function createProbeRequest(model, native) {
  const efforts = getCopilotReasoningEfforts(model);
  const ultra = native?.supported_reasoning_levels?.some(level => level.effort === "ultra")
    ? native.multi_agent_reasoning_effort || "max" : null;
  const effort = efforts.includes(ultra) ? ultra
    : ["low", "minimal", "none", "medium", "high", "xhigh", "max"].find(value => efforts.includes(value));
  return {
    model: model.id,
    input: [{ role: "user", content: `Call ${PROBE_TOOL} with value OK. Do nothing else.` }],
    tools: [{ type: "function", name: PROBE_TOOL, description: "Return the capability check result.",
      parameters: { type: "object", properties: { value: { type: "string", enum: ["OK"] } },
        required: ["value"], additionalProperties: false }, strict: true }],
    tool_choice: { type: "function", name: PROBE_TOOL },
    parallel_tool_calls: true,
    reasoning: { ...(effort ? { effort } : {}), context: "all_turns" },
    ...(native?.support_verbosity === false ? {} : { text: { verbosity: "low" } }),
    include: ["reasoning.encrypted_content"],
    store: false, stream: true, max_output_tokens: 1024,
  };
}

function inspectProbeResponse(response) {
  const type = String(response.headers?.["content-type"] || "").toLowerCase();
  if (response.status !== 200) return { error: parseError(response.body) };
  if (!type.includes("text/event-stream")) return { invalid: "streaming_not_observed" };
  let completed = false, validTool = false, error = null;
  function inspectItem(item) {
    if (item?.type !== "function_call" || item.name !== PROBE_TOOL) return;
    try { if (JSON.parse(item.arguments).value === "OK") validTool = true; } catch {}
  }
  for (const block of String(response.body).split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const data = lines.filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trimStart()).join("\n");
    let event;
    try { event = JSON.parse(data); } catch { continue; }
    const eventType = event.type || lines.find(line => line.startsWith("event:"))?.slice(6).trim();
    if (eventType === "response.output_item.done") inspectItem(event.item);
    if (eventType === "response.completed") {
      completed = event.response?.status === "completed";
      for (const item of event.response?.output || []) inspectItem(item);
    }
    if (eventType === "error" || eventType === "response.failed" || parseError(event)) {
      error = parseError(event) || { code: event.code, message: event.message };
    }
  }
  return { completed, validTool, error };
}

async function probeCodexModel(model, native, request) {
  let body = createProbeRequest(model, native);
  const constraints = {};
  // A short synthetic request, never a user's prompt. Bound multi-field
  // negotiation so a changing/invalid upstream schema cannot cause a loop.
  for (let attempt = 0; attempt < 4; attempt++) {
    let response;
    try { response = await request(body); }
    catch { return { state: "transient", constraints, reason: "network_or_timeout" }; }
    const result = inspectProbeResponse(response);
    if (response.status === 200 && result.completed && result.validTool && !result.error) {
      return { state: "verified", constraints, checkedEffort: body.reasoning?.effort || null };
    }
    if ((response.status === 400 || (response.status === 200 && result.error)) && attempt < 3) {
      const repair = retryCodexRequest(body, result.error ? { error: result.error } : response.body);
      if (repair.changes.length) {
        Object.assign(constraints, repair.constraints);
        body = repair.body;
        continue;
      }
    }
    const transient = [401, 408, 429].includes(response.status) || response.status >= 500 ||
      ["server_error", "rate_limit_exceeded", "overloaded", "insufficient_quota", "timeout"].includes(result.error?.code) ||
      (response.status === 200 && !result.completed && !result.error && !result.invalid);
    return { state: transient ? "transient" : "unavailable", constraints,
      reason: result.error?.code || result.invalid || (transient ? "incomplete_probe" : "probe_rejected") };
  }
}

module.exports = { PROBE_VERSION, PROBE_TOOL, createProbeRequest, inspectProbeResponse, probeCodexModel };
