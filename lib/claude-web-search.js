"use strict";

const { webSearchBlocks } = require("./claude-web-search-result");
const { createWebSearchMessage } = require("./claude-output");

// Copilot's catalog advertises the Responses transport, but not whether it
// executes hosted search. Only use a helper from the current account's list.
const VERIFIED_SEARCH_MODEL = "gpt-5.6-sol";

function responsesRoute(route) {
  if (route.format === "responses") return route;
  const endpoints = route.model.supported_endpoints ?? [];
  const path = Array.isArray(endpoints) && endpoints.find(endpoint => /^\/(v1\/)?responses\/?$/.test(endpoint));
  return path ? { ...route, format: "responses", path } : null;
}

function searchRoutes(selected, catalog) {
  const primary = responsesRoute(selected);
  const alternatives = catalog.filter(r => r.model.id !== primary?.model.id).map(responsesRoute).filter(Boolean);
  const helper = alternatives.find(r => r.model.id === VERIFIED_SEARCH_MODEL) ||
    alternatives.find(r => /^openai$/i.test(r.model.vendor)) || alternatives[0];
  return [primary, helper].filter(Boolean);
}

function domainHosts(domains, allow) {
  if (domains == null) return [];
  if (!Array.isArray(domains)) throw new Error("WebSearch domain filters must be arrays");
  const hosts = new Set();
  for (const pattern of domains) {
    if (typeof pattern !== "string" || !pattern || /[\s?#@\\]/.test(pattern) || pattern.includes("://")) {
      throw new Error("Invalid WebSearch domain filter");
    }
    const [host, ...path] = pattern.split("/");
    if (!host || host.includes("*")) throw new Error("Expected a domain name in the WebSearch filter");
    let url;
    try { url = new URL("https://" + host); } catch { throw new Error("Invalid WebSearch domain name"); }
    // Responses has host filters; the result adapter enforces the original
    // path rules too. A blocked path must not suppress its entire host.
    if (allow || !path.some(Boolean)) hosts.add(url.hostname);
  }
  return [...hosts];
}

function planWebSearch(body, selected, catalog, headers) {
  // CCD first calls the client function WebSearch, then makes a *separate*
  // Messages request with just the hosted web_search tool and the query.
  // Keep ordinary conversation, permissions and client tool calls on their
  // selected model. The gateway tries native Messages before this adapter.
  if (!Array.isArray(body.tools) || body.tools.length !== 1) return null;
  const [tool] = body.tools;
  if (!/^web_search(?:_|$)/.test(tool?.type) || body.tool_choice?.type === "none") return null;
  if (body.tool_choice?.type === "tool" && body.tool_choice.name !== tool.name) return null;
  if (!tool.name || body.messages.length !== 1 || body.messages[0]?.role !== "user") return null;
  const content = body.messages[0].content;
  const text = typeof content === "string" ? content :
    Array.isArray(content) && content.every(b => b?.type === "text") ? content.map(b => b.text).join("\n") : "";
  const query = text.replace(/^Perform a web search for the query:\s*/i, "").trim();
  if (!query) throw new Error("Expected a text query for the hosted WebSearch tool");
  if (tool.type !== "web_search_20250305" && tool.type !== "web_search") {
    throw new Error("Unsupported hosted WebSearch tool version: " + tool.type);
  }
  if ((tool.search_profile != null && tool.search_profile !== "fast") || tool.response_inclusion != null) {
    throw new Error("Unsupported WebSearch search_profile or response_inclusion on this Copilot route");
  }
  if (tool.allowed_callers && !(Array.isArray(tool.allowed_callers) && tool.allowed_callers.length === 1 && tool.allowed_callers[0] === "direct")) {
    throw new Error("Only direct WebSearch calls are supported");
  }
  if (tool.max_uses != null && (!Number.isSafeInteger(tool.max_uses) || tool.max_uses <= 0)) {
    throw new Error("WebSearch max_uses must be a positive integer");
  }
  const allowed = domainHosts(tool.allowed_domains, true);
  const blocked = domainHosts(tool.blocked_domains, false);
  if (tool.allowed_domains?.length && tool.blocked_domains?.length) throw new Error("Use either allowed_domains or blocked_domains for WebSearch");
  const searchTool = { type: "web_search" };
  if (tool.search_profile === "fast") searchTool.search_context_size = "low";
  if (allowed.length) searchTool.filters = { allowed_domains: allowed };
  if (blocked.length) searchTool.filters = { blocked_domains: blocked };
  if (tool.user_location) searchTool.user_location = tool.user_location;
  const routes = searchRoutes(selected, catalog);
  if (!routes.length) throw new Error("This Copilot account has no eligible Responses model for hosted WebSearch");
  const resultsOnly = String(headers["anthropic-beta"] || "").split(",").some(v => /^web-search-results-only-/.test(v.trim()));
  return { tool, searchTool, query, routes, resultsOnly };
}

function searchPayload(plan, model, maxTokens) {
  const requested = Number.isSafeInteger(maxTokens) && maxTokens > 0 ? Math.max(16, maxTokens) : 1024;
  const limit = model.capabilities?.limits?.max_output_tokens;
  return {
    model: model.id, stream: false, store: false,
    instructions: "Use web search once for the user's query, then give a brief summary with cited sources.",
    input: [{ role: "user", content: plan.query }],
    tools: [plan.searchTool], tool_choice: { type: "web_search" }, include: ["web_search_call.action.sources"],
    max_output_tokens: Number.isSafeInteger(limit) && limit > 0 ? Math.min(requested, limit) : requested,
    ...(plan.tool.max_uses && { max_tool_calls: plan.tool.max_uses }),
  };
}

function modelLacksSearch(error) {
  if (error.code === "NO_WEB_SEARCH_CALL") return true;
  if (![400, 422].includes(error.status)) return false;
  const message = error.message;
  if (!/\bweb[_ -]?search\b/i.test(message)) return false;
  // Retry an unsupported tool type, never an unsupported filter, a policy
  // rejection or an invalid search query on a model that implements the tool.
  if (/allowed_domains|blocked_domains|filters?|user_location|context_size|max_tool_calls|max_uses|policy|organi[sz]ation|permission|quota|billing/i.test(message)) return false;
  const parameter = error.upstreamParameter;
  if (parameter && !/^(?:tools(?:\[\d+\]|\.\d+)?(?:\.type)?|tool_choice(?:\.type)?)$/.test(parameter)) return false;
  return /not supported|does not support|unsupported|not available (?:for|on|with) this model|not a supported tool/i.test(message) ||
    (!!parameter && /supported values (?:are|include)/i.test(message));
}

async function runWebSearch(plan, body, fetchResponse) {
  for (const [index, candidate] of plan.routes.entries()) {
    try {
      const upstream = await fetchResponse(candidate, searchPayload(plan, candidate.model, body.max_tokens));
      const blocks = webSearchBlocks(upstream, plan.tool, plan);
      return createWebSearchMessage(upstream, body.model, blocks);
    } catch (error) {
      if (index + 1 === plan.routes.length || !modelLacksSearch(error)) throw error;
    }
  }
}

// Use a single final Responses snapshot for both JSON and SSE clients:
// citations often arrive after the search item is done. CCD reads the atomic
// result block on content_block_start, and query progress from input_json_delta.
function webSearchEvents(message) {
  const frames = [];
  function send(type, fields = {}) {
    frames.push("event: " + type + "\ndata: " + JSON.stringify({ type, ...fields }) + "\n\n");
  }
  send("message_start", { message: { ...message, content: [], stop_reason: null,
    usage: { ...message.usage, output_tokens: 0 } } });
  for (const [index, block] of message.content.entries()) {
    if (block.type === "server_tool_use") {
      send("content_block_start", { index, content_block: { ...block, input: {} } });
      send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    } else if (block.type === "text") {
      send("content_block_start", { index, content_block: { type: "text", text: "" } });
      send("content_block_delta", { index, delta: { type: "text_delta", text: block.text } });
    } else send("content_block_start", { index, content_block: block });
    send("content_block_stop", { index });
  }
  send("message_delta", { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: message.usage });
  send("message_stop");
  return frames.join("");
}

module.exports = { planWebSearch, runWebSearch, webSearchEvents, modelLacksSearch };
