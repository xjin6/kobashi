const assert = require("node:assert/strict");
const test = require("node:test");
const {
  CODEX_IMAGE_MODEL_ALIAS,
  PREFERRED_COPILOT_IMAGE_MODEL,
  imageEndpointForPath,
  resolveCodexImageRequest,
  selectCopilotImageModels,
} = require("../lib/codex-image-generation");

function imageModel(id = PREFERRED_COPILOT_IMAGE_MODEL, overrides = {}) {
  const base = {
    id,
    name: id,
    vendor: "Experimental",
    model_picker_enabled: false,
    policy: { state: "enabled" },
    supported_endpoints: ["/v1/images/generations", "/v1/images/edits"],
    capabilities: {
      type: "image",
      family: id,
      limits: { max_prompt_tokens: 32000 },
      supports: {},
    },
  };
  return {
    ...base,
    ...overrides,
    capabilities: { ...base.capabilities, ...(overrides.capabilities || {}) },
  };
}

test("discovers enabled GPT Image endpoints independently of the chat picker", () => {
  const flare = imageModel();
  const generationOnly = imageModel("gpt-image-future-flare", {
    model_picker_enabled: false,
    supported_endpoints: ["/v1/images/generations"],
  });
  const selected = selectCopilotImageModels({ data: [
    flare,
    generationOnly,
    { ...flare },
    imageModel("gpt-image-disabled", { policy: { state: "disabled" } }),
    imageModel("gpt-image-chat", { capabilities: { type: "chat" } }),
    imageModel("gpt-image-no-http", { supported_endpoints: ["ws:/images/generations"] }),
    imageModel("gpt-image-hidden-policy", { policy: { state: "blocked" } }),
    imageModel("other-image", { capabilities: { type: "image", family: "other-image" } }),
  ] });
  assert.deepEqual(selected.map(model => model.id), [flare.id, generationOnly.id]);
  assert.deepEqual(selectCopilotImageModels(selected, "/v1/images/edits").map(model => model.id), [flare.id]);
  assert.deepEqual(selectCopilotImageModels(selected, "/images/generations?stream=false").map(model => model.id),
    [flare.id, generationOnly.id]);
});

test("routes Codex's fixed image alias to the exact account image model on both endpoints", () => {
  const flare = imageModel();
  const catalog = [flare];
  for (const path of ["/images/generations", "/v1/images/generations?client=codex", "/v1/images/edits"]) {
    const body = {
      model: CODEX_IMAGE_MODEL_ALIAS,
      prompt: "Keep every field unchanged",
      quality: "auto",
      size: "auto",
      background: "transparent",
      images: [{ image_url: "data:image/png;base64,fixture" }],
    };
    const result = resolveCodexImageRequest(path, body, catalog);
    assert.equal(result.error, undefined);
    assert.equal(result.imageModel, flare);
    assert.equal(result.body.model, flare.id);
    assert.deepEqual({ ...result.body, model: body.model }, body);
    assert.notEqual(result.body, body);
    assert.equal(body.model, CODEX_IMAGE_MODEL_ALIAS, "the caller's body remains immutable");
    assert.deepEqual(result.changes, [{
      field: "model", from: CODEX_IMAGE_MODEL_ALIAS, to: flare.id,
      reason: "Codex image model route",
    }]);
  }
});

test("allows an exact eligible image ID without copying or rewriting the request", () => {
  const flare = imageModel();
  const body = { model: flare.id, prompt: "fixture", extra_future_field: { keep: true } };
  const result = resolveCodexImageRequest("/v1/images/generations", body, [flare]);
  assert.equal(result.body, body);
  assert.equal(result.imageModel, flare);
  assert.deepEqual(result.changes, []);
});

test("the native alias uses the preferred Flare and never guesses among ambiguous image models", () => {
  const preferred = imageModel();
  const futureA = imageModel("gpt-image-future-a");
  const futureB = imageModel("gpt-image-future-b");
  assert.equal(resolveCodexImageRequest("/v1/images/generations",
    { model: CODEX_IMAGE_MODEL_ALIAS }, [futureB, preferred, futureA]).imageModel, preferred);
  const ambiguous = resolveCodexImageRequest("/v1/images/generations",
    { model: CODEX_IMAGE_MODEL_ALIAS }, [futureA, futureB]);
  assert.equal(ambiguous.error.code, "model_not_supported");
  const only = resolveCodexImageRequest("/v1/images/generations",
    { model: CODEX_IMAGE_MODEL_ALIAS }, [futureA]);
  assert.equal(only.imageModel, futureA, "one dedicated account image model remains unambiguous");
});

test("image routing rejects missing capabilities and unsupported requested models locally", () => {
  const flare = imageModel();
  for (const [body, catalog, code] of [
    [{ model: CODEX_IMAGE_MODEL_ALIAS }, [], "image_generation_unavailable"],
    [{ model: CODEX_IMAGE_MODEL_ALIAS }, [imageModel("gpt-image-disabled", { policy: { state: "disabled" } })],
      "image_generation_unavailable"],
    [{ prompt: "fixture" }, [flare], "missing_required_parameter"],
    [{ model: "gpt-image-unavailable", prompt: "fixture" }, [flare], "model_not_supported"],
    [[], [flare], "invalid_request_body"],
  ]) {
    const result = resolveCodexImageRequest("/v1/images/generations", body, catalog);
    assert.equal(result.error.code, code);
    assert.deepEqual(result.changes, []);
    assert.equal(result.imageModel, null);
  }
});

test("aliases are scoped to Images API paths and never affect Responses chat traffic", () => {
  const body = { model: CODEX_IMAGE_MODEL_ALIAS, input: "chat fixture" };
  for (const path of ["/v1/responses", "/responses", "/v1/models", undefined]) {
    const result = resolveCodexImageRequest(path, body, [imageModel()]);
    assert.equal(result.body, body);
    assert.deepEqual(result.changes, []);
    assert.equal(result.imageModel, null);
    assert.equal(result.error, undefined);
  }
  assert.equal(imageEndpointForPath("/v1/images/generations?stream=true"), "/v1/images/generations");
  assert.equal(imageEndpointForPath("/v1/images/edits"), "/v1/images/edits");
  assert.equal(imageEndpointForPath("/v1/responses"), null);
});
