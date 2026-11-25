const { createHash } = require("node:crypto");
const { advertisedEfforts, desktopEffortProfile } = require("./claude-effort");

// Desktop requires a role-shaped ID. The embedded CLI recognizes specific
// versions anywhere in an ID before it consults behavesAs: "sonnet-4-6"
// silently downgrades xhigh to high. A version-neutral ID honors the profile.
const ALIAS_PREFIX = "claude-sonnet-kb-";
const LEGACY_ALIAS_PREFIX = "claude-sonnet-4-6-kb-";
const ENDPOINTS = {
  messages: ["/v1/messages"],
  responses: ["/responses", "/v1/responses"],
  chat: ["/chat/completions", "/v1/chat/completions"],
};

function copilotTransport(model) {
  const paths = model.supported_endpoints;
  // Older Copilot Chat records omit supported_endpoints. An explicit list
  // (including a WebSocket-only list) is authoritative.
  if (paths == null) return { format: "chat", path: "/chat/completions" };
  if (!Array.isArray(paths)) return null;
  const advertised = paths.map(p => String(p).split("?")[0].replace(/\/+$/, ""));
  const order = /^anthropic$/i.test(model.vendor) || /^claude-/.test(model.id)
    ? ["messages", "chat", "responses"]
    : /^openai$/i.test(model.vendor) || /^(gpt-|o\d)/i.test(model.id)
      ? ["responses", "chat", "messages"] : ["chat", "responses", "messages"];
  for (const format of order) {
    const path = ENDPOINTS[format].find(p => advertised.includes(p));
    if (path) return { format, path };
  }
  return null;
}

function pickerId(model) {
  if (/^claude-(?:sonnet|opus|haiku|fable)-[a-z0-9.-]+$/i.test(model.id)) {
    return model.id.replace(/(\d)\.(\d)/g, "$1-$2");
  }
  // All-numeric segments pass Desktop's provider-name filter. Six-digit
  // groups also avoid its eight-digit date-suffix normalization. Hash the
  // actual ID so catalog reordering or removing a neighbor cannot reroute it.
  const hash = createHash("sha256").update(model.id).digest();
  const digits = offset => String(hash.readUInt32BE(offset) % 1000000).padStart(6, "0");
  return ALIAS_PREFIX + digits(0) + "-" + digits(4);
}

function buildClaudeRoutes(models) {
  const routes = [];
  const seen = new Set();
  for (const model of models) {
    if (!model || typeof model.id !== "string" || !model.id.trim() || seen.has(model.id)) continue;
    const { supports, limits, type } = model.capabilities || {};
    if (type !== "chat" || supports?.tool_calls !== true || supports.streaming !== true) continue;
    if (model.model_picker_enabled === false || (model.policy?.state && model.policy.state !== "enabled")) continue;
    if (/\binternal(?:\s+only)?\b/i.test([model.id, model.name, model.description].join(" "))) continue;
    const transport = copilotTransport(model);
    if (!transport) continue;
    seen.add(model.id);
    routes.push({ id: pickerId(model), name: model.name || model.id, model, ...transport, ...desktopEffortProfile(model),
      supports1m: Number(limits?.max_context_window_tokens ?? limits?.max_prompt_tokens) >= 1000000 || /-1m$/i.test(model.id) });
  }
  // The first profile entry becomes Desktop's default. Prefer the account's
  // designated chat default, then a native Sonnet and models with reasoning.
  function rank({ model }) {
    if (model.is_chat_default) return 0;
    if (/^claude-sonnet-/.test(model.id)) return 1;
    return advertisedEfforts(model)?.length ? 2 : 3;
  }
  routes.sort((a, b) => rank(a) - rank(b) || b.model.id.localeCompare(a.model.id, "en", { numeric: true }));
  return routes;
}

function resolveClaudeRoute(routes, requested) {
  if (typeof requested !== "string" || !requested.trim()) return null;
  // Old chats can keep sending the 4-6 alias (including its [1m] form).
  // Both spellings identify the same Copilot model by the same stable hash.
  const spelling = requested.trim().replace(/^anthropic\//i, "").toLowerCase();
  const id = spelling.startsWith(LEGACY_ALIAS_PREFIX)
    ? ALIAS_PREFIX + spelling.slice(LEGACY_ALIAS_PREFIX.length) : spelling;
  const base = id.replace(/\s*\[1m\]$/i, "");
  const matches = (route, value) => route.id.toLowerCase() === value || route.model.id.toLowerCase() === value;
  if (id !== base) {
    const long = routes.find(r => matches(r, base + "-1m"));
    if (long) return long;
  }
  const exact = routes.find(r => matches(r, base));
  if (exact) return exact;
  // A saved explicit choice which has since disappeared must fail. Only
  // CCD's built-in role requests (including dated subagents) use a default.
  if (base.startsWith(ALIAS_PREFIX)) return null;
  if (base === "default") return routes[0] || null;
  const role = /^(?:claude-(?:\d+(?:-\d+)?-)?)?(sonnet|haiku|opus|fable)(?:plan)?(?:-\d+(?:[.\-]\d+)*(?:-1m)?)?$/.exec(base)?.[1];
  if (!role) return null;
  return routes.find(r => new RegExp("^claude-(?:[\\d.-]+-)?" + role + "(?:-|$)").test(r.model.id))
    || routes[0] || null;
}

function listClaudeModels(routes, desktop) {
  const data = routes.map(route => {
    // Standalone clients do not receive Desktop's managed behavesAs settings.
    // Keep publishing their existing IDs on the unprefixed gateway.
    let id = route.id;
    if (!desktop) {
      if (id.startsWith(ALIAS_PREFIX)) id = LEGACY_ALIAS_PREFIX + id.slice(ALIAS_PREFIX.length);
      id = id.replace(/-1m$/i, "[1m]");
    }
    return { type: "model", id, display_name: route.name, description: "GitHub Copilot · " + route.model.id,
      created_at: "2024-01-01T00:00:00Z", ...(route.supports1m && { supports1m: true }) };
  });
  return { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null };
}

module.exports = { buildClaudeRoutes, resolveClaudeRoute, listClaudeModels };
