const { findCopilotFastModel } = require("./codex-model-catalog");

// Codex describes speed with service_tier; Copilot exposes a separate model
// endpoint. Only an explicit Fast selection may choose the verified sibling.
// Never send OpenAI's service_tier field to Copilot or silently downgrade it.
function resolveCodexServiceTier(body, verifiedModels = []) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { body, changes: [] };
  const verified = verifiedModels.filter(model => model?.kobashi_verified);
  // Copilot identifies a directly selected Fast endpoint by its base model in
  // responses. Keep that known alias consistent with the client's selection.
  const directFast = typeof body.model === "string" && body.model.endsWith("-fast")
    ? findCopilotFastModel(body.model, verified) : null;
  let modelAlias = directFast && directFast.id === body.model
    ? { from: body.model.slice(0, -5), to: body.model } : undefined;
  const unchanged = { body, changes: [], modelAlias };
  if (!Object.hasOwn(body, "service_tier")) return unchanged;

  const tier = body.service_tier;
  const standard = tier == null || tier === "default" || tier === "auto";
  let target = body.model;
  if (!standard) {
    if (tier !== "priority" && tier !== "fast") {
      return { ...unchanged, error: {
        type: "invalid_request_error", code: "unsupported_value", param: "service_tier",
        message: "This speed tier is not supported through GitHub Copilot. Choose Standard or an available Fast option.",
      } };
    }
    const fast = findCopilotFastModel(body.model, verified);
    if (!fast) {
      return { ...unchanged, error: {
        type: "invalid_request_error", code: "unsupported_value", param: "service_tier",
        message: "Fast is not available for this model through the current Copilot account. Choose Standard or a model with a verified Fast option.",
      } };
    }
    target = fast.id;
  }

  const routed = { ...body };
  delete routed.service_tier;
  const changes = [{ field: "service_tier", from: tier, to: null,
    reason: standard ? "Copilot standard request" : "Copilot Fast model route" }];
  if (target !== body.model) {
    routed.model = target;
    modelAlias = { from: target, to: body.model };
    changes.push({ field: "model", from: body.model, to: target, reason: "explicit Fast selection" });
  }
  return { body: routed, changes, modelAlias };
}

module.exports = { resolveCodexServiceTier };
