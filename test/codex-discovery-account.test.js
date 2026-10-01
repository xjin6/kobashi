const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));

test("late model discovery from a previous account cannot populate or clear the new account cache", async () => {
  const context = vm.createContext({
    ensureCopilotToken: async () => "test", isAuthFailureBody: () => false,
    codexCapabilities: { setAccount() {} }, stopCodexClientWatch() {}, dbg() {}, copilotToken: null, copilotTokenExpiry: 0,
  });
  vm.runInContext(source.slice(source.indexOf("let copilotModelsCache ="), source.indexOf("async function getCopilotClaudeModelsRaw")), context);
  const replies = [];
  context.requestCopilotModels = () => new Promise(resolve => replies.push(resolve));
  const old = context.getCopilotModelsRaw();
  const rejected = assert.rejects(old, /account changed/);
  await tick(); context.clearCopilotModelCache();
  const fresh = context.getCopilotModelsRaw(); await tick();
  replies[0]({ status: 200, raw: JSON.stringify({ data: [{ id: "old" }] }) });
  await rejected;
  const deduped = context.getCopilotModelsRaw(); await tick();
  assert.equal(replies.length, 2, "old request must not clear the new in-flight promise");
  replies[1]({ status: 200, raw: JSON.stringify({ data: [{ id: "new" }] }) });
  assert.equal((await fresh)[0].id, "new");
  assert.equal((await deduped)[0].id, "new");
  assert.equal((await context.getCopilotModelsRaw())[0].id, "new");
});

test("late token results cannot overwrite or sign out a newly connected account", async () => {
  for (const status of [200, 401, 403]) {
    let reply, restores = 0;
    const context = vm.createContext({
      githubToken: "old-account", copilotToken: null, copilotTokenExpiry: 0,
      codexEnabled: true, claudeEnabled: true, username: "new-user",
      httpsRequest: () => new Promise(resolve => { reply = resolve; }),
      restoreCodexConfig: () => restores++, restoreClaudeConfig: () => restores++,
      clearCopilotModelCache() {}, deleteSession() {},
    });
    vm.runInContext(source.slice(source.indexOf("async function ensureCopilotToken()"), source.indexOf("// ─── Copilot premium-request usage")), context);
    const pending = context.ensureCopilotToken();
    context.githubToken = "new-account"; context.copilotToken = "new-token";
    reply({ status, body: { token: "old-token", expires_at: Date.now() / 1000 + 3600 } });
    await assert.rejects(pending, /account changed/);
    assert.equal(context.githubToken, "new-account");
    assert.equal(context.copilotToken, "new-token");
    assert.equal(restores, 0);
  }
});
