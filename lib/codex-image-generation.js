const CODEX_IMAGE_MODEL_ALIAS = "gpt-image-2";
const PREFERRED_COPILOT_IMAGE_MODEL = "gpt-image-2.5-flare";
const IMAGE_ENDPOINTS = new Map([
  ["/images/generations", "/v1/images/generations"],
  ["/v1/images/generations", "/v1/images/generations"],
  ["/images/edits", "/v1/images/edits"],
  ["/v1/images/edits", "/v1/images/edits"],
]);

function parseCopilotModels(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray(value.data)) return value.data;
  return [];
}

function imageEndpointForPath(value) {
  if (typeof value !== "string") return null;
  return IMAGE_ENDPOINTS.get(value.split("?", 1)[0]) || null;
}

function isEnabledGptImageModel(model) {
  if (!model || typeof model !== "object" || typeof model.id !== "string" || !model.id.trim()) return false;
  const family = String(model.capabilities?.family || "");
  if (!/^gpt-image-/i.test(model.id) && !/^gpt-image-/i.test(family)) return false;
  if (model.capabilities?.type !== "image") return false;
  const policyState = model.policy && typeof model.policy === "object"
    ? String(model.policy.state || "").toLowerCase() : "";
  if (policyState && policyState !== "enabled") return false;
  return Array.isArray(model.supported_endpoints) &&
    model.supported_endpoints.some(endpoint => IMAGE_ENDPOINTS.has(endpoint));
}

/**
 * Image models are a separate account capability, not Codex chat-picker rows.
 * `model_picker_enabled: false` is expected for the dedicated image endpoint
 * and deliberately does not disqualify an otherwise enabled model here.
 */
function selectCopilotImageModels(copilotCatalog, endpoint) {
  const requiredEndpoint = imageEndpointForPath(endpoint);
  const seen = new Set();
  return parseCopilotModels(copilotCatalog)
    .filter(isEnabledGptImageModel)
    .filter(model => !requiredEndpoint || model.supported_endpoints.includes(requiredEndpoint))
    .filter(model => {
      const id = model.id.trim();
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort((left, right) => {
      if (left.id === PREFERRED_COPILOT_IMAGE_MODEL) return -1;
      if (right.id === PREFERRED_COPILOT_IMAGE_MODEL) return 1;
      return String(left.id).localeCompare(String(right.id));
    });
}

function imageError(code, param, message) {
  return { type: "invalid_request_error", code, param, message };
}

/**
 * Resolve only Codex's native Images API requests. The client currently uses
 * the fixed `gpt-image-2` name; Copilot publishes the account's real image
 * endpoint separately. Never apply this alias to Responses/chat traffic or to
 * an arbitrary requested image model.
 */
function resolveCodexImageRequest(requestPath, body, copilotCatalog) {
  const endpoint = imageEndpointForPath(requestPath);
  if (!endpoint) return { body, changes: [], imageModel: null };
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { body, changes: [], imageModel: null, endpoint, error: imageError(
      "invalid_request_body", null, "Image requests must use a JSON object body.",
    ) };
  }

  const models = selectCopilotImageModels(copilotCatalog, endpoint);
  if (!models.length) {
    return { body, changes: [], imageModel: null, endpoint, error: imageError(
      "image_generation_unavailable", "model",
      "Image generation is not available through the current Copilot account.",
    ) };
  }

  const requested = typeof body.model === "string" ? body.model.trim() : "";
  if (!requested) {
    return { body, changes: [], imageModel: null, endpoint, error: imageError(
      "missing_required_parameter", "model", "An image model is required.",
    ) };
  }

  let target = models.find(model => model.id === requested) || null;
  if (!target && requested === CODEX_IMAGE_MODEL_ALIAS) {
    target = models.find(model => model.id === PREFERRED_COPILOT_IMAGE_MODEL) ||
      (models.length === 1 ? models[0] : null);
  }
  if (!target) {
    return { body, changes: [], imageModel: null, endpoint, error: imageError(
      "model_not_supported", "model",
      "The requested image model is not available through the current Copilot account.",
    ) };
  }

  if (target.id === requested) return { body, changes: [], imageModel: target, endpoint };
  return {
    body: { ...body, model: target.id },
    changes: [{ field: "model", from: requested, to: target.id,
      reason: "Codex image model route" }],
    imageModel: target,
    endpoint,
  };
}

module.exports = {
  CODEX_IMAGE_MODEL_ALIAS,
  PREFERRED_COPILOT_IMAGE_MODEL,
  imageEndpointForPath,
  resolveCodexImageRequest,
  selectCopilotImageModels,
};
