const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { loadGrokGatewayKey, createGrokSessionReader } = require("../lib/grok-local");

test("standalone Grok follows Kobashi sign-in, replacement and logout without modifying its session", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-session-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filename = path.join(dir, "session.json");
  const read = createGrokSessionReader(filename);
  assert.equal(read(), null);
  fs.writeFileSync(filename, JSON.stringify({ github_token: "account-A" }));
  const legacy = read();
  assert.equal(legacy.account, "account-A");
  assert.equal(legacy.enabled, true);
  assert.ok(legacy.revision);
  assert.equal(read(), legacy);
  fs.writeFileSync(filename, "{");
  assert.equal(read(), null);
  assert.equal(fs.readFileSync(filename, "utf8"), "{");
  fs.writeFileSync(filename + ".new", JSON.stringify({ github_token: "account-B", grokEnabled: false, grokRevision: "one" }));
  fs.renameSync(filename + ".new", filename);
  assert.deepEqual(read(), { account: "account-B", enabled: false, revision: "one" });
  fs.unlinkSync(filename);
  assert.equal(read(), null);

  const key = path.join(dir, "local", "grok-gateway.key");
  const firstKey = loadGrokGatewayKey(key);
  assert.match(firstKey, /^[a-f0-9]{64}$/);
  assert.equal(loadGrokGatewayKey(key), firstKey);
  if (process.platform !== "win32") assert.equal(fs.statSync(key).mode & 0o777, 0o600);
  fs.writeFileSync(key, "");
  assert.throws(() => loadGrokGatewayKey(key), /Invalid local Grok gateway key/);
});
