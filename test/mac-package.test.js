const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { EXECUTABLES, verifyExecutableModes } = require("../scripts/verify-mac-package");

test("extracted package validation rejects the observed 644 executable regression", { skip: process.platform === "win32" }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kobashi-exec-modes-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const relative of EXECUTABLES) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "fixture", { mode: 0o755 });
    fs.chmodSync(file, 0o755);
  }
  verifyExecutableModes(root);
  for (const relative of EXECUTABLES) {
    const file = path.join(root, relative);
    fs.chmodSync(file, 0o644);
    assert.throws(() => verifyExecutableModes(root), /regular 755 file/);
    fs.chmodSync(file, 0o755);
  }
  const target = path.join(root, EXECUTABLES[0]);
  fs.unlinkSync(target);
  fs.symlinkSync(path.join(root, EXECUTABLES[1]), target);
  assert.throws(() => verifyExecutableModes(root), /regular 755 file/);
});
