"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { planNativeAuthMigration, migrateNativeAuth } = require("../lib/codex-native-auth");

const placeholder = '{"OPENAI_API_KEY":"PROXY_MANAGED"}';
const account = JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: {
  access_token: "FAKE-ACCESS", id_token: "FAKE-ID", refresh_token: "FAKE-REFRESH", account_id: "FAKE-ACCOUNT",
} });

test("legacy placeholder restores a native backup and leaves unrelated current credentials alone", () => {
  assert.deepEqual(planNativeAuthMigration(placeholder, account), { action: "restore", contents: account });
  for (const live of [undefined, "", "{malformed", account, '{"OPENAI_API_KEY":"USER-KEY"}',
    '{"OPENAI_API_KEY":"PROXY_MANAGED","tokens":{"access_token":"FAKE"}}',
    '{"OPENAI_API_KEY":"PROXY_MANAGED","extra":true}', '[]']) {
    assert.deepEqual(planNativeAuthMigration(live, account), { action: "none" });
  }
});

test("unusable, partial or competing-key backups cannot replace native account authentication", () => {
  const partial = JSON.parse(account); delete partial.tokens.refresh_token;
  const apiMode = { ...JSON.parse(account), auth_mode: "apikey" };
  const competing = { ...JSON.parse(account), OPENAI_API_KEY: "USER-KEY" };
  const blank = JSON.parse(account); blank.tokens.id_token = " ";
  for (const backup of [undefined, "{malformed", placeholder, JSON.stringify(partial),
    JSON.stringify(apiMode), JSON.stringify(competing), JSON.stringify(blank)]) {
    assert.deepEqual(planNativeAuthMigration(placeholder, backup), { action: "remove" });
  }
  const olderNative = JSON.parse(account); delete olderNative.auth_mode;
  assert.equal(planNativeAuthMigration(placeholder, JSON.stringify(olderNative)).action, "restore");
});

function fixture(live, backup, options = {}) {
  const authPath = "/fixture/auth.json", files = new Map(), writes = [], reads = [];
  if (live !== undefined) files.set(authPath, live);
  if (backup !== undefined) files.set(authPath + ".bak", backup);
  const fs = {
    readFileSync(file) {
      reads.push(file);
      if (file === authPath && reads.filter(p => p === authPath).length === 2 && options.newLogin) {
        files.set(authPath, options.newLogin);
      }
      if (options.readError === file) throw Object.assign(Error("fixture denied"), { code: "EACCES" });
      if (!files.has(file)) throw Object.assign(Error("fixture missing"), { code: "ENOENT" });
      return files.get(file);
    },
    unlinkSync(file) { writes.push(["remove", file]); files.delete(file); },
  };
  const writeTextAtomic = (file, contents, mode) => { writes.push(["write", file, mode]); files.set(file, contents); };
  return { files, writes, reads, authPath, migrate: () => migrateNativeAuth({ authPath, fs, writeTextAtomic }) };
}

test("migration preserves backup, restores privately and is idempotent", () => {
  const f = fixture(placeholder, account);
  assert.equal(f.migrate(), "restore");
  assert.equal(f.files.get(f.authPath), account);
  assert.equal(f.files.get(f.authPath + ".bak"), account);
  assert.deepEqual(f.writes, [["write", f.authPath, 0o600]]);
  assert.equal(f.migrate(), "none");
  assert.equal(f.writes.length, 1);
});

test("migration removes only the owned placeholder and never resurrects a logged-out account", () => {
  const unusable = '{"OPENAI_API_KEY":"USER-KEY"}', f = fixture(placeholder, unusable);
  assert.equal(f.migrate(), "remove");
  assert.equal(f.files.has(f.authPath), false);
  assert.equal(f.files.get(f.authPath + ".bak"), unusable);
  const loggedOut = fixture(undefined, account);
  assert.equal(loggedOut.migrate(), "none");
  assert.equal(loggedOut.files.has(loggedOut.authPath), false);
  assert.deepEqual(loggedOut.writes, []);
  assert.deepEqual(loggedOut.reads, [loggedOut.authPath]);
});

test("migration preserves a login written after the first read and fails closed on unreadable backup", () => {
  const changed = fixture(placeholder, account, { newLogin: account });
  assert.equal(changed.migrate(), "none");
  assert.equal(changed.files.get(changed.authPath), account);
  assert.deepEqual(changed.writes, []);
  const denied = fixture(placeholder, account, { readError: "/fixture/auth.json.bak" });
  assert.throws(() => denied.migrate(), { code: "EACCES" });
  assert.equal(denied.files.get(denied.authPath), placeholder);
  assert.deepEqual(denied.writes, []);
});
