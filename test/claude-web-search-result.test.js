const test = require("node:test");
const assert = require("node:assert/strict");
const { webSearchBlocks, matchesWebSearchDomain } = require("../lib/claude-web-search-result");

const tool = { type: "web_search_20250305", name: "web_search" };
const source = (url, extra = {}) => ({ type: "url", url, ...extra });
const citation = (url, title) => ({ type: "url_citation", url, title });
const answer = (text, annotations = []) => ({ type: "message", content: [{ type: "output_text", text, annotations }] });
const call = (id, sources) => ({ type: "web_search_call", id, status: "completed",
  action: { type: "search", query: "documentation", sources } });
const terminal = (...output) => ({ status: "completed", output });

test("real Responses sources form native search blocks and URL-only hits acquire their citation titles", () => {
  const url = "https://docs.example.org/guide";
  const annotated = url + "?utm_source=openai";
  const body = terminal(call("+opaque/copilot=id", [
    ...Array.from({ length: 13 }, (_, i) => source(`https://results.example/${i}`)),
    source(url), source(annotated), source("javascript:ignored()"),
  ]), answer("Consult the documentation.", [citation(annotated, "The [real] guide")]));
  const blocks = webSearchBlocks(body, tool);
  assert.deepEqual(blocks.map(b => b.type), ["server_tool_use", "web_search_tool_result", "text"]);
  assert.match(blocks[0].id, /^srvtoolu_[A-Za-z0-9_-]+$/);
  assert.equal(blocks[1].tool_use_id, blocks[0].id);
  assert.deepEqual(blocks[0].input, { query: "documentation" });
  const hits = blocks[1].content;
  assert.equal(hits.length, 10);
  assert.deepEqual(hits[0], { type: "web_search_result", title: "The [real] guide", url, encrypted_content: "", page_age: null });
  assert.equal(hits[1].url, "https://results.example/0");
  assert.match(blocks[2].text, /^Consult the documentation\./);
  assert.ok(blocks[2].text.includes("[The \\[real\\] guide](<" + annotated + ">)"));
  assert.deepEqual(blocks, webSearchBlocks(body, tool));
});

test("results-only carries genuine snippets and leaves a result block last on 2.1.331", () => {
  const a = "https://docs.example.org/item?id=3";
  const b = "https://docs.example.org/item?id=4";
  const body = terminal(call("ws_1", [source(a, { snippet: "Retrieved page excerpt.", page_age: "today" }), source(b)]),
    answer("Model-produced summary is separate from page excerpts.", [citation(a + "&utm_campaign=test", "Three"), citation(b, "Four")]));
  const blocks = webSearchBlocks(body, tool, { resultsOnly: true });
  assert.deepEqual(blocks.map(block => block.type), ["server_tool_use", "web_search_tool_result"]);
  assert.equal(blocks[1].tool_use_id, "ws_1");
  assert.deepEqual(blocks[1].content.map(hit => [hit.url, hit.title, hit.encrypted_content]),
    [[a, "Three", "Retrieved page excerpt."], [b, "Four", ""]]);
  assert.equal(blocks[1].content[0].page_age, "today");
  assert.doesNotMatch(JSON.stringify(blocks), /Model-produced/);
});

test("structured annotations can supply results when per-call sources are omitted", () => {
  const a = "https://example.org/cited";
  const prose = `Genuine answer. [Source](${a})`;
  const only = call("ws_1");
  const blocks = webSearchBlocks(terminal(only, answer(prose, [citation(a, "Source")])), tool);
  assert.deepEqual(blocks[1].content.map(hit => hit.url), [a]);
  assert.equal(blocks[2].text, prose);
  const next = webSearchBlocks(terminal(only, call("ws_2", []), answer(prose, [citation(a, "Source")])), tool);
  assert.deepEqual(next.map(block => block.type), ["server_tool_use", "web_search_tool_result", "server_tool_use", "web_search_tool_result", "text"]);
  assert.deepEqual(next[1].content, []);
  assert.deepEqual(next[3].content, []);
  assert.equal(next[4].text, prose);
});

test("withholds unsupported assertions from empty results and unverified links from otherwise grounded searches", () => {
  const real = "https://example.org/real";
  const none = webSearchBlocks(terminal(call("ws_1", []), answer("I found a definitive answer.")), tool);
  assert.deepEqual(none.map(block => block.type), ["server_tool_use", "web_search_tool_result"]);
  assert.deepEqual(none[1].content, []);
  for (const text of [
    `[Confirmed](${real}) but also see https://example.org/unverified.`,
    `See [unrelated](https://unverified.invalid/guide)`,
    "Follow www.unverified.invalid", "[Other page](/relative/path)", "[Contact](mailto:a@example.org)",
  ]) {
    const blocks = webSearchBlocks(terminal(call("ws_1", [source(real)]), answer(text, [citation(real, "Confirmed")])), tool);
    assert.equal(blocks.length, 2, text);
    assert.deepEqual(blocks[1].content.map(hit => hit.url), [real]);
  }
});

test("filters retain true matches and withhold summaries that contain excluded sources", () => {
  const allowed = "https://python.example/2026/articles/one";
  const excluded = "https://python.example/account";
  const malicious = "https://python.example.evil.invalid/2026/articles/two";
  const out = webSearchBlocks(terminal(call("ws_filter", [source(allowed), source(excluded), source(malicious),
    source("https://user@python.example/2026/articles/three")]),
  answer("Prose from an excluded page", [citation(excluded, "account")])), { ...tool, allowed_domains: ["python.example/*/articles"] });
  assert.deepEqual(out[1].content.map(hit => hit.url), [allowed]);
  assert.equal(out.length, 2);

  const hidden = webSearchBlocks(terminal(call("ws_block", [source(allowed)]), answer("Link: https://tracking.example/guess")),
    { ...tool, blocked_domains: ["tracking.example"] });
  assert.equal(hidden.length, 2);
  assert.equal(matchesWebSearchDomain("https://docs.python.example/2026/articles/two", "python.example/*/articles"), true);
  assert.equal(matchesWebSearchDomain(malicious, "python.example"), false);
  assert.equal(matchesWebSearchDomain("https://PYTHON.example./abc", "python.example"), true);
});

test("open-page and page-find actions cannot publish a prohibited address through their input", () => {
  const forbidden = "https://blocked.example/private";
  const allowed = "https://allowed.example/research";
  const restricted = { ...tool, blocked_domains: ["blocked.example"] };
  for (const type of ["open_page", "find_in_page"]) {
    const item = { ...call("ws_page"), action: { type, url: forbidden, pattern: "match", sources: [source(allowed)] } };
    const blocks = webSearchBlocks(terminal(item, answer("Unsupported summary")), restricted, { query: "original" });
    assert.equal(blocks.length, 2);
    assert.deepEqual(blocks[0].input, {});
    assert.doesNotMatch(JSON.stringify(blocks), /blocked\.example/);
    item.action.url = allowed;
    item.action.pattern = `search ${forbidden}`;
    assert.deepEqual(webSearchBlocks(terminal(item), restricted)[0].input, { url: allowed });
  }
});

test("clips the title and results-only excerpt without truncating a source URL into another destination", () => {
  const url = "https://example.org/";
  const limit = url.padEnd(8192, "a");
  const over = limit + "z";
  const snippet = "Captured text. ".repeat(300);
  const body = terminal(call("ws_bounds", [source(over), source(url, { title: "   " + "t".repeat(2300), snippet }), source(limit)]),
    answer("", [citation(over, "Overlong")]));
  const hits = webSearchBlocks(body, tool, { resultsOnly: true })[1].content;
  assert.deepEqual(hits.map(hit => hit.url), [url, limit]);
  assert.equal(hits[0].title, "t".repeat(2000));
  assert.equal(hits[0].encrypted_content, snippet.slice(0, 2000).trimEnd());
  assert.equal(hits[1].title, limit.slice(0, 2000));
});

test("preserves true zero results and maps failed or unfinished search items to native errors", () => {
  assert.deepEqual(webSearchBlocks(terminal(call("ws_empty", [])), tool)[1].content, []);
  for (const [item, code] of [
    [{ status: "failed", error: { code: "rate_limit_exceeded" } }, "too_many_requests"],
    [{ status: "failed", error: "provider unavailable" }, "unavailable"],
    [{ status: "searching" }, "unavailable"],
    [{ status: "failed", error: { code: "query_too_long" } }, "query_too_long"],
  ]) {
    const blocks = webSearchBlocks(terminal({ ...call("failed", [source("https://example.org/stale")]), ...item },
      answer("Ignored unverified result")), tool);
    assert.equal(blocks.length, 2);
    assert.deepEqual(blocks[1].content, { type: "web_search_tool_result_error", error_code: code });
  }
  const over = webSearchBlocks(terminal(call("ws_1", []), call("ws_2", []), answer("Ignored after the limit")),
    { ...tool, max_uses: 1 });
  assert.equal(over.length, 4);
  assert.equal(over[3].content.error_code, "max_uses_exceeded");
});

test("a budget-limited response can deliver already completed searches with verified hits only", () => {
  const url = "https://docs.example/finished";
  const pending = { ...call("next", [source("https://unverified.invalid")]), status: "in_progress" };
  const body = { ...terminal(call("finished", [source(url, { title: "Source" })]), pending, call("empty", []),
    answer("Truncated model-written answer")), status: "incomplete", incomplete_details: { reason: "max_output_tokens" } };
  const blocks = webSearchBlocks(body, tool);
  assert.deepEqual(blocks.map(block => block.type), ["server_tool_use", "web_search_tool_result"]);
  assert.equal(blocks[0].id, "finished");
  assert.deepEqual(blocks[1].content.map(hit => hit.url), [url]);
  for (const incomplete of [
    { ...body, incomplete_details: { reason: "content_filter" } },
    { ...body, output: [pending] },
    { ...body, output: [call("no_evidence", []), answer("incomplete", [citation(url, "partial citation")])] },
  ]) {
    assert.throws(() => webSearchBlocks(incomplete, tool), error => error.code !== "NO_WEB_SEARCH_CALL");
  }
});

test("completed prose without activity is distinct from failed, truncated and malformed upstream data", () => {
  assert.throws(() => webSearchBlocks(terminal(answer("I ran the search", [citation("https://example.org", "Example")])), tool),
    error => error.code === "NO_WEB_SEARCH_CALL");
  for (const malformed of [
    { status: "completed" }, { status: "failed", error: { message: "invalid authentication" }, output: [] },
    { ...terminal(call("ws", [])), status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
    terminal({ ...call("ws", []), action: undefined }), terminal(call("ws", { url: "invalid" })),
    terminal(call("", [])), terminal(call("ws", []), call("ws", [])),
    terminal(null), terminal({ type: "message", content: {} }),
    terminal({ type: "message", content: [{ type: "refusal", refusal: "The search was declined." }] }),
  ]) {
    assert.throws(() => webSearchBlocks(malformed, tool), error => error.code !== "NO_WEB_SEARCH_CALL");
  }
});
