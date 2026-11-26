"use strict";

const { createHash } = require("node:crypto");

// CCD puts the links into the parent model's context. Prefer cited results before
// filling the remaining slots with the search engine's ranked sources.
const MAX_HITS_PER_CALL = 10;
const MAX_URL_LENGTH = 8192;
const MAX_TITLE_LENGTH = 2000;
const MAX_SNIPPET_LENGTH = 2000;

function webUrl(raw) {
  if (typeof raw !== "string" || raw.length > MAX_URL_LENGTH || !/^https?:\/\//i.test(raw) || /[\s<>\\]/.test(raw)) return null;
  try {
    const url = new URL(raw);
    return url.username || url.password ? null : url;
  } catch { return null; }
}

function matchesWebSearchDomain(url, pattern) {
  if (typeof url === "string") url = webUrl(url);
  if (!url || typeof pattern !== "string") return false;
  const [host, ...parts] = pattern.split("/");
  if (!host || /[*?#@\\\s]/.test(host) || pattern.includes("://")) return false;
  const rule = webUrl("https://" + host);
  if (!rule) return false;
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const domain = rule.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname !== domain && !hostname.endsWith("." + domain)) return false;
  if (rule.port && rule.port !== url.port) return false;

  // Anthropic permits wildcards only after the host. Paths match a prefix.
  // Matching the literal pieces avoids turning a supplied glob into a regex.
  const [prefix, ...pieces] = ("/" + parts.join("/")).split("*");
  if (!url.pathname.startsWith(prefix)) return false;
  let position = prefix.length;
  for (const piece of pieces) {
    const found = url.pathname.indexOf(piece, position);
    if (found < 0) return false;
    position = found + piece.length;
  }
  return true;
}

function sourceKey(url) {
  // The annotated link often has ?utm_source=openai whereas action.sources has
  // the direct URL. Preserve meaningful query parameters (including order)
  // and fragments. Return genuine upstream links unchanged to the client.
  const key = new URL(url.href);
  for (const parameter of [...key.searchParams.keys()]) {
    if (/^utm_/i.test(parameter)) key.searchParams.delete(parameter);
  }
  return key.href;
}

function callId(raw) {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("Copilot web search call is missing its ID");
  if (/^[A-Za-z0-9_-]{1,100}$/.test(raw)) return raw;
  // Some Copilot ids are long opaque base64 strings. The Messages client
  // only needs a valid, stable ID linking its activity and result blocks.
  return "srvtoolu_" + createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

function errorCode(item) {
  const failure = [item.error?.code, item.error?.type, item.error?.message,
    typeof item.error === "string" ? item.error : ""].filter(Boolean).join(" ").toLowerCase();
  if (/max.uses|max.tool.calls/.test(failure)) return "max_uses_exceeded";
  if (/rate.limit|too.many.requests/.test(failure)) return "too_many_requests";
  if (/query.too.long/.test(failure)) return "query_too_long";
  if (/request.too.large/.test(failure)) return "request_too_large";
  if (/invalid/.test(failure)) return "invalid_tool_input";
  return "unavailable";
}

function searchInput(action, fallbackQuery, permitted) {
  const query = action?.query || (Array.isArray(action?.queries) && action.queries.find(value => typeof value === "string" && value.trim()));
  if (action?.type === "open_page" || action?.type === "find_in_page") {
    if (!permitted(webUrl(action.url))) return {};
    const input = { url: action.url };
    if (typeof action.pattern === "string" && linksInText(action.pattern).every(raw => permitted(webUrl(raw)))) input.pattern = action.pattern;
    return input;
  }
  const value = typeof query === "string" && query.trim() ? query : fallbackQuery;
  return typeof value === "string" && value.trim() ? { query: value } : {};
}

function boundedText(raw, limit) {
  if (typeof raw !== "string") return "";
  return raw.trim().slice(0, limit).replace(/[\uD800-\uDBFF]$/, "").trimEnd();
}

function sourceRecord(source, url, cited) {
  return {
    key: sourceKey(url), url: source.url, cited,
    title: boundedText(source.title, MAX_TITLE_LENGTH),
    snippet: boundedText(source.snippet, MAX_SNIPPET_LENGTH),
    age: typeof source.page_age === "string" ? source.page_age : null,
  };
}

function mergeSource(set, hit) {
  const existing = set.get(hit.key);
  if (!existing) { set.set(hit.key, { ...hit }); return; }
  if (hit.title && (!existing.title || hit.cited)) existing.title = hit.title;
  existing.snippet ||= hit.snippet;
  existing.age ||= hit.age;
  existing.cited ||= hit.cited;
}

function linksInText(text) {
  return text.match(/\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>"'`]+/gi) || [];
}

function verifiedLink(raw, evidence) {
  // Autolinks and Markdown links may be followed by prose punctuation or
  // closing parentheses. First try the full URL, including significant ones.
  if (/^www\./i.test(raw)) raw = "https://" + raw;
  if (raw.indexOf("://", raw.indexOf("://") + 3) >= 0) return;
  const clean = raw.replace(/[)\]},:;.?!*_]+$/, "");
  for (const value of [raw, clean]) {
    const url = webUrl(value);
    if (!url) continue;
    const key = sourceKey(url);
    if (evidence.has(key)) return key;
  }
}

function citedText(part, citations, evidence) {
  if (typeof part.text !== "string" || !part.text.trim()) return;
  const text = part.text;
  // A search can coexist with an unsourced suggestion in the generated
  // answer. Keep the verified hits but withhold prose containing such a link.
  if (/\]\(\s*(?![\s<]|https?:\/\/)|\]\(\s*<(?!https?:\/\/)/i.test(text)) return;
  const linked = new Set();
  for (const raw of linksInText(text)) {
    const key = verifiedLink(raw, evidence);
    if (!key) return;
    linked.add(key);
  }
  const missing = [];
  for (const hit of citations.values()) {
    if (linked.has(hit.key)) continue;
    const label = (hit.title || hit.url).replace(/\s+/g, " ").replace(/[\\[\]]/g, "\\$&");
    missing.push(`[${label}](<${hit.url}>)`);
  }
  return missing.length ? text + "\n\nSources: " + missing.join(", ") : text;
}

function webSearchBlocks(body, tool, { query, resultsOnly = false } = {}) {
  const truncated = body?.status === "incomplete" && body.incomplete_details?.reason === "max_output_tokens";
  if ((body?.status !== "completed" && !truncated) || body.error) {
    throw new Error(body?.error?.message || `Copilot web search did not complete (${body?.incomplete_details?.reason || body?.status || "missing response status"})`);
  }
  if (!Array.isArray(body.output)) throw new Error("Copilot web search response is missing its output");
  const calls = [];
  const texts = [];
  const ids = new Set();
  const restricted = !!(tool.allowed_domains?.length || tool.blocked_domains?.length);
  let filtered = false;

  function permitted(url) {
    return !!url && (!tool.allowed_domains?.length || tool.allowed_domains.some(rule => matchesWebSearchDomain(url, rule))) &&
      !tool.blocked_domains?.some(rule => matchesWebSearchDomain(url, rule));
  }
  function addSource(hits, source, cited) {
    const url = webUrl(source?.url);
    if (!permitted(url)) { filtered = true; return; }
    mergeSource(hits, sourceRecord(source, url, cited));
  }

  for (const [index, item] of body.output.entries()) {
    if (typeof item?.type !== "string") throw new Error("Copilot web search returned a malformed output item");
    if (item.type === "web_search_call") {
      if (truncated && (item.status !== "completed" || item.error)) continue;
      const id = callId(item.id);
      if (ids.has(id)) throw new Error("Copilot returned duplicate web search call IDs");
      ids.add(id);
      const hits = new Map();
      const call = { index, id, input: searchInput(item.action, query, permitted), hits };
      if (restricted && item.action?.url && !permitted(webUrl(item.action.url))) filtered = true;
      calls.push(call);
      if (tool.max_uses > 0 && calls.length > tool.max_uses) {
        call.error = "max_uses_exceeded";
        break;
      }
      if (item.status !== "completed" || item.error) { call.error = errorCode(item); continue; }
      if (!["search", "open_page", "find_in_page"].includes(item.action?.type)) {
        throw new Error("Copilot returned a completed web search without a recognized action");
      }
      if (item.action?.sources != null && !Array.isArray(item.action.sources)) {
        throw new Error("Copilot web search returned a malformed source list");
      }
      for (const source of item.action?.sources ?? []) addSource(hits, source, false);
    } else if (item.type === "message") {
      if (truncated) continue;
      if (!Array.isArray(item.content)) throw new Error("Copilot web search returned malformed message content");
      for (const part of item.content) {
        if (typeof part?.type !== "string") throw new Error("Copilot web search returned a malformed message part");
        if (part.type === "refusal") throw new Error(part.refusal || "Copilot declined the web search");
        if (part.type !== "output_text") continue;
        if (typeof part.text !== "string") throw new Error("Copilot web search returned malformed answer text");
        const citations = new Map();
        if (part.annotations != null && !Array.isArray(part.annotations)) throw new Error("Copilot web search returned malformed annotations");
        for (const annotation of part.annotations ?? []) {
          if (annotation?.type === "url_citation") addSource(citations, annotation, true);
        }
        texts.push({ index, part, citations });
      }
    }
  }
  if (truncated && !calls.some(call => !call.error && call.hits.size)) {
    throw new Error("Copilot web search reached max_output_tokens before returning any confirmed results");
  }
  if (!calls.length) {
    const error = new Error("Copilot did not return a hosted web_search_call");
    error.code = "NO_WEB_SEARCH_CALL";
    throw error;
  }
  const completed = calls.filter(call => !call.error);
  for (const { citations } of texts) {
    for (const hit of citations.values()) {
      // An annotation without a call ID can enrich a matching source. When
      // several searches took place, an unmatched citation stays with its text.
      const matching = completed.filter(call => call.hits.has(hit.key));
      for (const call of matching.length ? matching : completed.length === 1 ? completed : []) {
        mergeSource(call.hits, hit);
      }
    }
  }
  const included = truncated ? completed.filter(call => call.hits.size) : calls;
  const ordered = included.map(call => {
    const hits = [...call.hits.values()].sort((a, b) => Number(b.cited) - Number(a.cited)).slice(0, MAX_HITS_PER_CALL);
    const content = call.error ? { type: "web_search_tool_result_error", error_code: call.error } :
      hits.map(hit => ({
        type: "web_search_result", url: hit.url, title: hit.title || boundedText(hit.url, MAX_TITLE_LENGTH),
        // CCD's results-only protocol reads actual page text from this field.
        // A URL or model-written answer supplies no page text or native signature.
        encrypted_content: resultsOnly ? hit.snippet : "", page_age: hit.age,
      }));
    return { index: call.index, blocks: [
      { type: "server_tool_use", id: call.id, name: tool.name || "web_search", input: call.input },
      { type: "web_search_tool_result", tool_use_id: call.id, content },
    ] };
  });
  // A summary can repeat excluded sources without marking every sentence as a
  // citation. In that case only return the vetted hits from the actual calls.
  if (!truncated && !resultsOnly && completed.length && !calls.some(call => call.error) && !(restricted && filtered)) {
    const evidence = new Set(completed.flatMap(call => [...call.hits.keys()]));
    for (const { citations } of texts) for (const key of citations.keys()) evidence.add(key);
    for (const { index, part, citations } of texts) {
      const text = evidence.size && citedText(part, citations, evidence);
      if (text) ordered.push({ index, blocks: [{ type: "text", text }] });
    }
  }
  return ordered.sort((a, b) => a.index - b.index).flatMap(entry => entry.blocks);
}

module.exports = { matchesWebSearchDomain, webSearchBlocks };
