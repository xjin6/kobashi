const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const test = require("node:test");
const { buildLocal, assertLocal } = require("../scripts/build-local");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kobashi-build-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "OneDrive", "repo with spaces");
  fs.mkdirSync(sourceRoot, { recursive: true });
  for (const name of ["lib", "assets", "macos", "scripts", "node_modules", ".git", ".claude", "dist"]) {
    fs.mkdirSync(path.join(sourceRoot, name));
    fs.writeFileSync(path.join(sourceRoot, name, "fixture.txt"), name);
  }
  fs.writeFileSync(path.join(sourceRoot, "index.js"), "/* BUILD_STAMP */");
  fs.writeFileSync(path.join(sourceRoot, "package.json"), '{"version":"2.1.6"}');
  fs.writeFileSync(path.join(sourceRoot, "dist", "Kobashi.zip"), "old mac");
  fs.writeFileSync(path.join(sourceRoot, "dist", "Kobashi.exe"), "old win");
  fs.writeFileSync(path.join(sourceRoot, "dist", "SHA256SUMS.txt"), "old checksums");
  const tempRoot = path.join(root, "local temp");
  const options = { sourceRoot, env: { ...process.env, KOBASHI_BUILD_TMPDIR: tempRoot }, log() {} };
  return { root, sourceRoot, tempRoot, options };
}

for (const [target, name] of [["mac", "Kobashi.zip"], ["win", "Kobashi.exe"]]) {
  test(`${target} builds in a local copy and publishes only the finished package and checksums`, async t => {
    const f = fixture(t);
    let staged;
    const output = await buildLocal(target, { ...f.options, run: async (script, workspace, env) => {
      staged = workspace;
      assert.equal(path.dirname(workspace), fs.realpathSync(f.tempRoot));
      assert.equal(script, `scripts/build-${target === "mac" ? "mac-app" : "win"}.sh`);
      assert.equal(env.KOBASHI_BUILD_STAGED, "1");
      assert.equal(fs.readFileSync(path.join(workspace, "node_modules", "fixture.txt"), "utf8"), "node_modules");
      for (const ignored of [".git", ".claude", "dist"]) assert.ok(!fs.existsSync(path.join(workspace, ignored)));
      fs.writeFileSync(path.join(workspace, "index.js"), "stamped copy");
      fs.writeFileSync(path.join(workspace, "node_modules", "fixture.txt"), "tool-generated change");
      fs.mkdirSync(path.join(workspace, "dist", "Kobashi.app"), { recursive: true });
      fs.writeFileSync(path.join(workspace, "dist", "Kobashi.app", "intermediate"), "discard");
      fs.writeFileSync(path.join(workspace, "dist", name), `new ${target}`);
    } });
    assert.equal(output, path.join(f.sourceRoot, "dist", name));
    assert.equal(fs.readFileSync(output, "utf8"), `new ${target}`);
    assert.equal(fs.readFileSync(path.join(f.sourceRoot, "index.js"), "utf8"), "/* BUILD_STAMP */");
    assert.equal(fs.readFileSync(path.join(f.sourceRoot, "node_modules", "fixture.txt"), "utf8"), "node_modules");
    assert.ok(!fs.existsSync(staged));
    assert.deepEqual(fs.readdirSync(path.join(f.sourceRoot, "dist")).sort(),
      ["Kobashi.exe", "Kobashi.zip", "SHA256SUMS.txt", "fixture.txt"].sort());
    for (const line of fs.readFileSync(path.join(f.sourceRoot, "dist", "SHA256SUMS.txt"), "utf8").trim().split("\n")) {
      const [hash, file] = line.split(/\s+/);
      assert.equal(hash, createHash("sha256").update(fs.readFileSync(path.join(f.sourceRoot, "dist", file))).digest("hex"));
    }
  });
}

test("failed builds leave existing releases untouched and remove their temporary workspace", async t => {
  const f = fixture(t);
  let staged;
  await assert.rejects(buildLocal("mac", { ...f.options, run: async (_script, workspace) => {
    staged = workspace;
    fs.writeFileSync(path.join(workspace, "index.js"), "partly stamped");
    throw new Error("compiler failed");
  } }), /compiler failed/);
  assert.ok(!fs.existsSync(staged));
  assert.equal(fs.readFileSync(path.join(f.sourceRoot, "index.js"), "utf8"), "/* BUILD_STAMP */");
  assert.equal(fs.readFileSync(path.join(f.sourceRoot, "dist", "Kobashi.zip"), "utf8"), "old mac");
  assert.equal(fs.readFileSync(path.join(f.sourceRoot, "dist", "SHA256SUMS.txt"), "utf8"), "old checksums");
});

test("an empty build product cannot replace the previous release", async t => {
  const f = fixture(t);
  await assert.rejects(buildLocal("win", { ...f.options, run: async (_script, workspace) => {
    fs.mkdirSync(path.join(workspace, "dist"));
    fs.writeFileSync(path.join(workspace, "dist", "Kobashi.exe"), "");
  } }), /Missing release file/);
  assert.equal(fs.readFileSync(path.join(f.sourceRoot, "dist", "Kobashi.exe"), "utf8"), "old win");
  assert.deepEqual(fs.readdirSync(f.tempRoot), []);
});

test("source edits during packaging block publication and preserve the user's edits", async t => {
  const f = fixture(t);
  await assert.rejects(buildLocal("win", { ...f.options, run: async (_script, workspace) => {
    fs.mkdirSync(path.join(workspace, "dist"));
    fs.writeFileSync(path.join(workspace, "dist", "Kobashi.exe"), "stale staged build");
    fs.writeFileSync(path.join(f.sourceRoot, "lib", "new-runtime.js"), "user's new source");
  } }), /Source changed during packaging/);
  assert.equal(fs.readFileSync(path.join(f.sourceRoot, "dist", "Kobashi.exe"), "utf8"), "old win");
  assert.equal(fs.readFileSync(path.join(f.sourceRoot, "lib", "new-runtime.js"), "utf8"), "user's new source");
  assert.deepEqual(fs.readdirSync(f.tempRoot), []);
});

test("temporary paths inside the checkout, OneDrive, or cloud symlinks are rejected", t => {
  const f = fixture(t);
  for (const directory of [path.join(f.sourceRoot, "tmp"), path.join(f.root, "OneDrive", "scratch"),
    path.join(f.root, "Library", "CloudStorage", "provider", "scratch")]) {
    assert.throws(() => assertLocal(directory, f.sourceRoot, {}), /outside the checkout and OneDrive/);
  }
  const link = path.join(f.root, "seems-local");
  fs.symlinkSync(path.join(f.root, "OneDrive"), link, "junction");
  assert.throws(() => assertLocal(path.join(link, "new-temp"), f.sourceRoot, {}), /outside the checkout and OneDrive/);
  assert.throws(() => assertLocal(path.join(f.root, "custom-cloud", "temp"), f.sourceRoot,
    { OneDriveCommercial: path.join(f.root, "custom-cloud") }), /outside the checkout and OneDrive/);
});

test("cloud-backed pkg and npm cache overrides are redirected into the local workspace", async t => {
  const f = fixture(t);
  await buildLocal("win", { ...f.options, env: { ...f.options.env,
    PKG_CACHE_PATH: path.join(f.sourceRoot, "pkg-cache"),
    NPM_CONFIG_CACHE: path.join(f.sourceRoot, "npm-cache"), npm_config_cache: "",
  }, run: async (_script, workspace, env) => {
    assert.equal(env.PKG_CACHE_PATH, path.join(workspace, "tmp", ".pkg-cache"));
    assert.equal(env.npm_config_cache, path.join(workspace, "tmp", ".npm"));
    assert.equal(env.NPM_CONFIG_CACHE, undefined);
    fs.mkdirSync(path.join(workspace, "dist"));
    fs.writeFileSync(path.join(workspace, "dist", "Kobashi.exe"), "new win");
  } });
  assert.ok(!fs.existsSync(path.join(f.sourceRoot, "pkg-cache")));
  assert.ok(!fs.existsSync(path.join(f.sourceRoot, "npm-cache")));
});
