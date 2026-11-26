const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const html = fs.readFileSync(path.join(__dirname, "../assets/ui.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const settle = () => new Promise(resolve => setImmediate(resolve));
const response = (data, ok = true) => ({ ok, json: async () => data });
const state = (enabled, supported = false) => response({
  connected: true, username: "test", grokEnabled: enabled, grokDesktopLaunchSupported: supported,
});

function page(fetch) {
  const nodes = new Map(), timers = new Map();
  let timerId = 0;
  function element(id) {
    if (!nodes.has(id)) {
      const classes = new Set(), attributes = new Map();
      nodes.set(id, {
        style: {}, disabled: id === "grok-toggle" || id === "grok-launch", value: "", textContent: "",
        classList: {
          add: name => classes.add(name), remove: name => classes.delete(name),
          contains: name => classes.has(name),
          toggle: (name, on) => on ? classes.add(name) : classes.delete(name),
        },
        setAttribute: (k, v) => attributes.set(k, v), getAttribute: k => attributes.get(k),
        hasAttribute: k => attributes.has(k), removeAttribute: k => attributes.delete(k),
      });
    }
    return nodes.get(id);
  }
  const window = { matchMedia: () => ({ addEventListener() {} }), addEventListener() {} };
  const context = vm.createContext({
    document: { getElementById: element, documentElement: element("html") },
    fetch, window, setInterval() {},
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(script, context);
  return { element, window, run: code => vm.runInContext(code, context), expire() {
    const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback());
  } };
}

test("Grok switch tracks the account through device and token sign-in", async () => {
  assert.match(html, /<button class="toggle" id="grok-toggle" [^>]*role="switch"[^>]*aria-label="Grok Bridge"[^>]*disabled/);
  for (const [login, enabled] of [["device", false], ["token", true]]) {
    let connected = false;
    const client = page(async url => {
      if (url === "/api/status") return connected ? state(enabled) : response({ connected: false });
      assert.equal(url, login === "device" ? "/api/poll" : "/api/token-login");
      connected = true;
      return response({ ok: true, username: "test", access_token: "test" });
    });
    await settle();
    client.element("token-input").value = "test";
    await client.run(login === "device" ? "poll('test')" : "submitToken()");
    await settle();
    assert.equal(client.element("view-connected").style.display, "block");
    assert.equal(client.element("grok-text").textContent, enabled ? "Active" : "Paused");
    assert.equal(client.element("grok-toggle").getAttribute("aria-checked"), String(enabled));
    assert.equal(client.element("grok-toggle").disabled, false);
  }
});

test("a Grok toggle ignores duplicate clicks and stale status, and keeps the footer active on its own", async () => {
  const requests = [];
  const client = page((url, options) => new Promise(resolve => requests.push({ url, options, resolve })));
  const animation = [];
  client.window.kobashiAnimState = active => animation.push(active);
  requests.shift().resolve(state(false));
  await settle();
  assert.equal(client.element("grok-text").textContent, "Paused");
  const oldPoll = client.run("refreshStatus()");
  const toggle = client.run("toggleGrok()");
  await client.run("toggleGrok()");
  assert.equal(requests.length, 2);
  const [poll, change] = requests;
  assert.equal(change.url, "/api/toggle-grok");
  assert.equal(change.options.method, "POST");
  assert.equal(change.options.body, undefined);
  assert.equal(client.element("grok-toggle").getAttribute("aria-busy"), "true");
  change.resolve(response({ grokEnabled: true }));
  await toggle;
  poll.resolve(state(false));
  await oldPoll;
  assert.equal(client.element("grok-text").textContent, "Active");
  assert.equal(animation.at(-1), true);
});

test("a rejected toggle preserves the last switch state and lets the user retry", async () => {
  let fail = true;
  const client = page(async url => {
    if (url === "/api/status") return state(true);
    return fail ? response({ error: "internal detail" }, false) : response({ grokEnabled: false });
  });
  await settle();
  await client.run("toggleGrok()");
  assert.equal(client.element("grok-toggle").disabled, false);
  assert.equal(client.element("grok-toggle").getAttribute("aria-checked"), "true");
  assert.equal(client.element("grok-error").hidden, false);
  assert.doesNotMatch(client.element("grok-error").textContent, /internal detail/);
  fail = false;
  await client.run("toggleGrok()");
  assert.equal(client.element("grok-error").hidden, true);
  assert.equal(client.element("grok-toggle").getAttribute("aria-checked"), "false");
});

test("the Grok launch button requires a connected account, an active bridge and platform support", async () => {
  assert.match(html, /<button class="bridge-logo" id="grok-launch" type="button" onclick="openGrokDesktop\(\)" aria-label="Open Grok"/);
  let status = state(false, true);
  const client = page(async url => {
    assert.equal(url, "/api/status");
    return status;
  });
  for (const sample of [state(false, true), state(true), state(true, "true"),
    response({ connected: false, grokEnabled: true, grokDesktopLaunchSupported: true })]) {
    status = sample;
    await client.run("refreshStatus()");
    assert.equal(client.element("grok-launch").disabled, true);
    await client.run("openGrokDesktop()");
  }
});

test("clicking Grok launches its desktop profile once and leaves the bridge active", async () => {
  let resolveLaunch;
  const calls = [];
  const client = page((url, options) => {
    if (url === "/api/status") return Promise.resolve(state(true, true));
    calls.push({ url, options });
    return new Promise(resolve => { resolveLaunch = resolve; });
  });
  await settle();
  assert.equal(client.element("grok-launch").disabled, false);
  const launch = client.run("openGrokDesktop()");
  await client.run("openGrokDesktop()");
  await client.run("refreshStatus()");
  assert.equal(client.element("grok-launch").getAttribute("aria-busy"), "true");
  assert.equal(client.element("grok-launch").disabled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/grok/open");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["Content-Type"], "application/json");
  assert.equal(calls[0].options.body, "{}");
  resolveLaunch(response({ ok: true, state: "already_running" }));
  await launch;
  assert.match(client.element("grok-launch-feedback").textContent, /already open with Kobashi/);
  client.expire();
  assert.equal(client.element("grok-launch-feedback").textContent, "");
  assert.equal(client.element("grok-toggle").getAttribute("aria-checked"), "true");
});

test("Grok launch errors give visible, retryable guidance without displaying backend details", async () => {
  let result;
  const client = page(async url => url === "/api/status" ? state(true, true) : result);
  await settle();
  const expected = {
    grok_other_profile_running: /Quit Grok.*click the Grok icon/,
    desktop_not_found: /Install the Grok desktop app/,
    launch_pending: /starting.*system prompt/,
    no_grok_models: /account.*model access/,
    bridge_not_ready: /Enable Grok Bridge/,
    catalog_unavailable: /load Grok models from Copilot/,
    profile_conflict: /Back up and check ~\/.kobashi\/grok-desktop/,
    profile_unavailable: /profile.*writable/,
    unsupported_platform: /unavailable on this platform/,
    arbitrary_private_detail: /Could not open Grok/,
  };
  const feedback = client.element("grok-launch-feedback");
  for (const [error, pattern] of Object.entries(expected)) {
    result = response({ ok: false, error }, false);
    await client.run("openGrokDesktop()");
    assert.match(feedback.textContent, pattern);
    assert.equal(feedback.classList.contains("failed"), true);
    assert.equal(client.element("grok-launch").disabled, false);
  }
  result = response({ ok: true, state: "opened" });
  await client.run("openGrokDesktop()");
  assert.match(feedback.textContent, /Grok opened with Kobashi/);
  assert.equal(feedback.classList.contains("failed"), false);
});

test("the single Claude logo opens the desktop with the bridge paused, and concurrent clicks cannot toggle it", async () => {
  assert.equal((html.match(/id="claude-launch"/g)||[]).length,1);
  assert.match(html, /<button class="bridge-logo claude" id="claude-launch" type="button"[^>]*aria-label="Open Claude"[^>]*disabled/);
  let connected=true,supported=false,complete;
  const calls=[];
  const client=page((url,options)=>{
    if(url==="/api/status")return Promise.resolve(response({
      connected,claudeDesktopLaunchSupported:supported,claudeEnabled:false,grokEnabled:false,
    }));
    calls.push([url,options]);
    return new Promise(resolve=>{complete=resolve;});
  });
  await settle();
  const button=client.element("claude-launch");
  assert.equal(button.disabled,true);
  await client.run("openClaudeDesktop()");
  supported=true;connected=false;
  await client.run("refreshStatus()");
  await client.run("openClaudeDesktop()");
  assert.equal(calls.length,0);
  connected=true;
  await client.run("refreshStatus()");
  assert.equal(button.disabled,false);
  const first=client.run("openClaudeDesktop()");
  await client.run("openClaudeDesktop()");
  await client.run("refreshStatus()");
  assert.equal(button.getAttribute("aria-busy"),"true");
  assert.equal(calls.length,1);
  assert.equal(calls[0][0],"/api/claude/open");
  assert.equal(calls[0][1].method,"POST");
  assert.equal(calls[0][1].headers["Content-Type"],"application/json");
  assert.equal(calls[0][1].body,"{}");
  complete(response({ok:true,state:"already_running"}));
  await first;
  assert.equal(button.disabled,false);
  assert.equal(client.element("claude-toggle").getAttribute("aria-checked"),"false");
  assert.equal(client.element("claude-launch-feedback").textContent,"Claude is already running.");
  assert.equal(client.element("dashboard-description").classList.contains("replaced"),true);
  client.expire();
  assert.equal(client.element("dashboard-description").classList.contains("replaced"),false);
});

test("a delayed Claude launch outcome leaves a newer Grok notice visible", async () => {
  let complete;
  const client=page(url=>{
    if(url==="/api/status")return Promise.resolve(response({
      connected:true,claudeDesktopLaunchSupported:true,grokDesktopLaunchSupported:true,grokEnabled:true,
    }));
    if(url==="/api/claude/open")return new Promise(resolve=>{complete=resolve;});
    return Promise.resolve(response({ok:false,error:"grok_other_profile_running"},false));
  });
  await settle();
  const first=client.run("openClaudeDesktop()");
  await client.run("openGrokDesktop()");
  complete(response({ok:false,error:"private transport detail"},false));
  await first;
  assert.match(client.element("grok-launch-feedback").textContent,/Quit Grok/);
  assert.equal(client.element("claude-launch-feedback").hidden,true);
  assert.equal(client.element("grok-launch-feedback").hidden,false);
});

test("a failed Claude launch shows public recovery guidance in the subtitle area", async () => {
  const client=page(async url=>url==="/api/status"
    ?response({connected:true,claudeDesktopLaunchSupported:true})
    :response({ok:false,error:"desktop_not_found",details:"private"},false));
  await settle();
  await client.run("openClaudeDesktop()");
  const feedback=client.element("claude-launch-feedback");
  assert.match(feedback.textContent,/Install the Claude desktop app/);
  assert.doesNotMatch(feedback.textContent,/private/);
  assert.equal(feedback.hidden,false);
  assert.equal(feedback.classList.contains("failed"),true);
  assert.equal(client.element("claude-launch").disabled,false);
});
