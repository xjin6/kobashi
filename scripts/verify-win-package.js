"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

function verify(file, version) {
  const bytes = fs.readFileSync(file);
  const offset = bytes.readUInt32LE(0x3c);
  if (bytes.toString("ascii", 0, 2) !== "MZ" || bytes.readUInt32LE(offset) !== 0x4550 ||
      bytes.readUInt16LE(offset + 4) !== 0x8664 || bytes.readUInt16LE(offset + 0x5c) !== 2) {
    throw new Error("Expected a Windows x64 GUI executable");
  }
  // Cross-compilation still checks the PE; native Windows builds also execute
  // the finished file in a directory that contains no source/assets beside it.
  if (process.platform !== "win32") return { nativeSelfTest: false };
  const parent = fs.realpathSync(os.tmpdir());
  const scratch = fs.mkdtempSync(path.join(parent, "kobashi-package-check-"));
  try {
    const executable = path.join(scratch, "Kobashi.exe");
    fs.copyFileSync(file, executable);
    const options = { cwd: scratch, windowsHide: true, encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] };
    const info = JSON.parse(execFileSync(executable, ["--self-test"], options));
    if (!info.ok || info.version !== version || info.platform !== "win32" || info.architecture !== "x64" ||
        !info.windowsNativeAccountAuth || !info.legacyAuthMigration || !info.desktopLaunchSupported ||
        execFileSync(executable, ["--version"], options).trim() !== version) {
      throw new Error("Packaged runtime self-test or version check failed");
    }
    for (const [asset, digest] of Object.entries(info.assetHashes)) {
      const actual = crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "..", "assets", asset))).digest("hex");
      if (digest !== actual) throw new Error("Packaged asset mismatch: " + asset);
    }
    if (fs.readdirSync(scratch).length !== 1) throw new Error("Self-test unexpectedly wrote files");
    return { ...info, nativeSelfTest: true };
  } finally {
    const resolved = fs.realpathSync(scratch);
    if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith("kobashi-package-check-")) {
      throw new Error("Unexpected verification cleanup path");
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

if (require.main === module) console.log(JSON.stringify(verify(process.argv[2], process.argv[3])));
module.exports = { verify };
