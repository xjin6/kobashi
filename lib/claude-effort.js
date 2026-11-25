"use strict";

const DESKTOP_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const WIRE_LEVELS = ["none", "minimal", ...DESKTOP_LEVELS];

function advertisedEfforts(model) {
  const caps = model.capabilities;
  return caps?.supports?.reasoning_effort ?? caps?.reasoning_effort;
}

function knownOpenAIReasoning(id) {
  const gpt = /^gpt-(\d+)/i.exec(id);
  return /^o\d+(?:-|$)/i.test(id) || Number(gpt?.[1]) >= 5;
}

function canonicalEffort(value) {
  const level = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^extra[ _-]high$/.test(level) ? "xhigh" : level;
}

function effortValues(advertised) {
  const values = new Map();
  for (const value of advertised) {
    if (typeof value !== "string") continue;
    const wire = value.trim();
    const level = canonicalEffort(wire);
    const standard = wire.toLowerCase() === level;
    // Keep the spelling used by the endpoint (e.g. extra_high). If it offers
    // several spellings, prefer the standard one regardless of catalog order.
    if (level && (!values.has(level) || standard)) values.set(level, standard ? level : wire);
  }
  return values;
}

function desktopEffortProfile(model) {
  const advertised = advertisedEfforts(model);
  if (!Array.isArray(advertised) || /^anthropic$/i.test(String(model.vendor ?? "").trim()) ||
      /^(?:anthropic\/)?claude(?:-|$)/i.test(model.id)) return {};
  const values = effortValues(advertised);
  // These are CCD's built-in Code picker templates. maxEffort only removes
  // options above a ceiling. Sonnet 4.6 skips xhigh between high and max.
  if (!values.has("xhigh") && ["low", "medium", "high", "max"].every(level => values.has(level))) {
    return { behavesAs: "claude-sonnet-4-6", maxEffort: "max" };
  }
  const gap = DESKTOP_LEVELS.findIndex(level => !values.has(level));
  const count = gap < 0 ? DESKTOP_LEVELS.length : gap;
  if (count === 0) return {};
  if (count === 1 && DESKTOP_LEVELS.slice(1).some(level => values.has(level))) return {};
  return { behavesAs: "claude-sonnet-5", maxEffort: DESKTOP_LEVELS[count - 1] };
}

function chooseEffort(request, model, advertised) {
  // The existing wire fallback lets older GPT/o-series catalog entries and a
  // boolean support flag work. Only explicit enumerations populate the picker.
  if (advertised === false || (advertised == null && !knownOpenAIReasoning(model.id))) return;
  const values = effortValues(Array.isArray(advertised) ? advertised : ["low", "medium", "high"]);
  const thinking = request.thinking;
  let wanted = request.output_config?.effort;
  if (thinking?.type === "disabled") wanted = "none";
  else if (wanted == null && thinking?.type === "adaptive") wanted = "xhigh";
  else if (wanted == null && thinking?.type === "enabled") {
    const budget = thinking.budget_tokens;
    wanted = budget < 4000 ? "low" : budget < 16000 ? "medium" : "high";
  }
  wanted = canonicalEffort(wanted);
  if (!wanted || !values.size) return;
  if (values.has(wanted)) return values.get(wanted);
  if (wanted === "ultracode") wanted = "xhigh";
  const target = WIRE_LEVELS.indexOf(wanted);
  if (target < 0) return;
  const available = WIRE_LEVELS.filter(level => values.has(level));
  const selected = available.filter(level => WIRE_LEVELS.indexOf(level) <= target).at(-1) ?? available[0];
  return values.get(selected);
}

module.exports = { advertisedEfforts, chooseEffort, desktopEffortProfile, knownOpenAIReasoning };
