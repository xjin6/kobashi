const { getCopilotReasoningEfforts } = require("./codex-model-catalog");

// These are protocol fields/values, never model-name exceptions. Only explicit
// upstream validation can teach an override; model IDs and user data are immutable.
const VALUES = Object.freeze({
  "reasoning.context": ["auto", "current_turn", "all_turns"],
  "reasoning.effort": ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  "reasoning.summary": ["none", "auto", "concise", "detailed"],
  "text.verbosity": ["low", "medium", "high"],
});
const RANK = { none: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6, ultra: 6 };
const QUOTED = /['"‘’“”`]([^'"‘’“”`\r\n]+)['"‘’“”`]/g;

function valueAt(body, field) {
  const [group, key] = field.split(".");
  return body?.[group]?.[key];
}

function chooseValue(field, wanted, allowed) {
  if (allowed.includes(wanted)) return wanted;
  if (field === "reasoning.context") {
    return ["current_turn", "auto", "all_turns"].find(value => allowed.includes(value));
  }
  if (field === "reasoning.summary") {
    return ["auto", "concise", "detailed", "none"].find(value => allowed.includes(value));
  }
  const rank = Object.hasOwn(RANK, wanted) ? RANK[wanted] : RANK.high;
  const ordered = [...allowed].sort((a, b) => RANK[a] - RANK[b]);
  let selected = ordered.filter(value => RANK[value] <= rank).at(-1);
  if (rank > 0 && (!selected || selected === "none")) {
    selected = ordered.find(value => RANK[value] > 0) || selected;
  }
  return selected || ordered[0];
}

function applyConstraints(body, constraints = {}) {
  let normalized = body;
  const changes = [];
  for (const field of Object.keys(VALUES)) {
    const original = valueAt(body, field);
    if (typeof original !== "string" || !Object.hasOwn(constraints, field)) continue;
    const rule = constraints[field];
    const allowed = Array.isArray(rule) ? VALUES[field].filter(value => rule.includes(value)) : [];
    if (rule !== null && !allowed.length) continue;
    const next = rule === null ? undefined : chooseValue(field, original.toLowerCase(), allowed);
    if (next === original) continue;
    const [group, key] = field.split(".");
    if (normalized === body) normalized = { ...body };
    normalized[group] = { ...normalized[group] };
    if (next === undefined) delete normalized[group][key];
    else normalized[group][key] = next;
    if (!Object.keys(normalized[group]).length) delete normalized[group];
    changes.push({ field, from: original, to: next ?? null, reason: "verified upstream capability" });
  }
  return { body: normalized, changes };
}

function normalizeCodexRequest(body, { copilotModels, constraints = {} } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { body, changes: [] };
  const models = Array.isArray(copilotModels) ? copilotModels : copilotModels?.data || [];
  const model = models.find(model => model?.id === body.model);
  const efforts = getCopilotReasoningEfforts(model);
  return applyConstraints(body, {
    ...(efforts.length ? { "reasoning.effort": efforts } : {}),
    ...constraints,
  });
}

function parseError(value) {
  try {
    if (Buffer.isBuffer(value)) value = value.toString("utf8");
    if (typeof value === "string") value = JSON.parse(value);
    return value?.error || value?.response?.error || null;
  } catch { return null; }
}

// Learn only from an explicit rejected parameter/value and the server's stated
// alternatives. Ambiguous errors, unsupported tools, input, model and budgets
// are never rewritten. A caller bounds retries and scopes rules to an account.
function retryCodexRequest(body, errorBody) {
  const unchanged = { body, changes: [], constraints: {} };
  if (!body || typeof body !== "object" || Array.isArray(body)) return unchanged;
  const error = parseError(errorBody);
  if (typeof error?.message !== "string") return unchanged;
  const message = error.message.trim();
  const unknown = /^(?:Unknown|Unrecognized|Unsupported) parameter:\s*['"`]([^'"`]+)['"`]\.?$/i.exec(message);
  if (unknown && Object.hasOwn(VALUES, unknown[1]) &&
      (!error.param || error.param === unknown[1]) && valueAt(body, unknown[1]) !== undefined) {
    const constraints = { [unknown[1]]: null };
    return { ...applyConstraints(body, constraints), constraints };
  }
  const rejected = /^Unsupported value:\s*['"‘’“”`]([^'"‘’“”`]+)['"‘’“”`]/i.exec(message)?.[1];
  const supportedText = /Supported values are:\s*(.+)$/i.exec(message)?.[1];
  if (!rejected || (!supportedText && !Array.isArray(error.supported_values))) return unchanged;
  const supported = Array.isArray(error.supported_values)
    ? error.supported_values : [...supportedText.matchAll(QUOTED)].map(match => match[1]);
  const candidates = Object.keys(VALUES).filter(field => valueAt(body, field) === rejected &&
    (!error.param || error.param === field) && supported.length &&
    supported.every(value => VALUES[field].includes(value)) && !supported.includes(rejected));
  if (candidates.length !== 1) return unchanged;
  const constraints = { [candidates[0]]: [...new Set(supported)] };
  return { ...applyConstraints(body, constraints), constraints };
}

function isModelUnavailable(status, errorBody) {
  const error = parseError(errorBody);
  return [400, 403, 404, 410].includes(status) &&
    ["model_not_found", "model_not_supported", "model_not_available", "model_access_denied", "model_retired"].includes(error?.code);
}

module.exports = { normalizeCodexRequest, retryCodexRequest, isModelUnavailable, parseError };
