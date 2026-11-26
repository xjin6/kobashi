const fs = require("node:fs");
const path = require("node:path");

// Grok App's generic providers have one API backend per provider. The desktop
// stores its picker catalog as JSON inside TOML; Grok Build reads the sections.
function desktopProviders(catalog) {
  if (!Array.isArray(catalog?.data)) throw new Error("Invalid model list from the Grok gateway");
  const providers = new Map();
  const seen = new Set();
  for (const model of catalog.data) {
    if (!model || model.owned_by !== "xai" || typeof model.id !== "string" || !model.id || seen.has(model.id)) continue;
    if (!Array.isArray(model.supported_endpoints)) continue;
    const endpoints = model.supported_endpoints;
    let backend;
    if (endpoints.includes("/responses") || endpoints.includes("/v1/responses")) backend = "responses";
    else if (endpoints.includes("/chat/completions") || endpoints.includes("/v1/chat/completions")) backend = "chat_completions";
    else continue;
    seen.add(model.id);
    const efforts = Array.isArray(model.reasoning_efforts)
      ? [...new Set(model.reasoning_efforts.filter(level => typeof level === "string" && level.trim()))]
        .map(id => ({ id, name: id }))
      : [];
    // Grok App copies the parent's native reasoning flag to every child. Keep
    // a fixed-effort model out of a provider whose children accept an effort.
    const group = backend + ":" + Boolean(efforts.length);
    if (!providers.has(group)) {
      const responses = backend === "responses";
      providers.set(group, {
        id: responses ? "kobashi-responses" : "kobashi-chat",
        name: responses ? "Kobashi · GitHub Copilot (Responses)" : "Kobashi · GitHub Copilot (Chat Completions)",
        backend, models: [],
      });
    }
    const row = { id: model.id, name: model.display_name || model.id };
    if (Number.isSafeInteger(model.context_window) && model.context_window > 0) row.contextWindow = model.context_window;
    if (typeof model.supports_vision === "boolean") row.supportsVision = model.supports_vision;
    if (efforts.length) row.efforts = efforts;
    providers.get(group).models.push(row);
  }
  if (!providers.size) throw Object.assign(new Error("The connected Copilot account lists no supported Grok models."), { code: "no_grok_models" });
  for (const provider of providers.values()) {
    if (!provider.models[0].efforts && providers.has(provider.backend + ":true")) {
      provider.id += "-fixed";
      provider.name += " · Fixed effort";
    }
  }
  return [...providers.values()];
}

function profileConfig(providers, baseUrl, key, childIds = new Map()) {
  const ids = [];
  const sections = [];
  function section(id, fields) {
    ids.push(id);
    sections.push("[model." + id + "]", ...Object.entries(fields).map(([k, v]) => k + " = " + JSON.stringify(v)), "");
  }
  for (const provider of providers) {
    const first = provider.models.find(model => model.id === provider.activeModel) || provider.models[0];
    const common = {
      base_url: baseUrl, api_key: key, api_backend: provider.backend,
      app_provider_mode: "generic", supports_reasoning_effort: Boolean(first.efforts?.length),
    };
    section(provider.id, {
      ...common, name: provider.name, model: first.id, app_models: JSON.stringify(provider.models),
      ...(first.contextWindow && { context_window: first.contextWindow }),
      ...(typeof first.supportsVision === "boolean" && { app_supports_vision: String(first.supportsVision) }),
      ...(first.efforts && { app_efforts: JSON.stringify(first.efforts) }),
    });
    for (const [i, model] of provider.models.entries()) {
      // The desktop preserves existing child section IDs by app_parent_provider
      // and model. Generated numeric suffixes also work with arbitrary upstream IDs.
      section(childIds.get(model.id) || provider.id + "__" + (i + 1), {
        ...common, name: model.name, model: model.id, app_parent_provider: provider.id,
        ...(model.contextWindow && { context_window: model.contextWindow }),
      });
    }
  }
  // Grok App's Model layers panel uses these four Grok Build side-task slots.
  // An explicit section ID keeps their requests on the same local provider.
  const defaultId = JSON.stringify(providers[0].id);
  return [
    "[models]", "default = " + defaultId, "allowed_models = " + JSON.stringify(ids),
    ...["image_description", "web_search", "session_summary", "prompt_suggestion"].map(slot => slot + " = " + defaultId),
    "", ...sections,
  ].join("\n");
}

function prepareDesktopProfile(directory, providers, baseUrl, key) {
  const root = path.resolve(directory);
  const config = profileConfig(providers, baseUrl, key);
  // v0.2.51 requires each of these non-optional settings for deserialization.
  // Give new chats a custom route and disable the independent official-aux MCP.
  const settings = {
    theme: "system", permissionPolicy: "ask", mode: "agent", proxyMode: "system",
    onboardingDone: true, setupSkipped: false, setupWizardCompleted: true,
    sessionDataMode: "independent", officialAuxInject: false,
    modelId: providers[0].models[0].id, officialModelDefaultMigrated: true, officialModel47Migrated: true,
  };
  // mkdir is exclusive. A repeat run, including one in parallel, cannot replace
  // an existing profile. Never merge with the user's active App/CLI homes.
  fs.mkdirSync(root, { mode: 0o700 });
  const agentHome = path.join(root, "agent-home");
  try {
    fs.mkdirSync(agentHome, { mode: 0o700 });
    fs.writeFileSync(path.join(agentHome, "config.toml"), config, { flag: "wx", mode: 0o600 });
    fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify(settings, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  } catch (err) {
    // This invocation created the directory; clean only its two expected files.
    for (const file of [path.join(agentHome, "config.toml"), path.join(root, "settings.json")]) {
      try { fs.unlinkSync(file); } catch {}
    }
    try { fs.rmdirSync(agentHome); } catch {}
    try { fs.rmdirSync(root); } catch {}
    throw err;
  }
  return { root, agentHome };
}

module.exports = { desktopProviders, prepareDesktopProfile, profileConfig };
