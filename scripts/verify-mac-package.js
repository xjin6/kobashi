"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const EXECUTABLES = ["Contents/MacOS/kobashi",
  "Contents/Resources/bin/kobashi-arm64", "Contents/Resources/bin/kobashi-x64"];

function verifyExecutableModes(app) {
  for (const relative of EXECUTABLES) {
    const file = path.join(app, relative), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o755) {
      throw new Error(`Extracted executable must be a regular 755 file: ${relative}`);
    }
  }
}

function verifyPackage(archive) {
  if (process.platform !== "darwin") throw new Error("macOS package validation requires macOS");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kobashi-zip-check-"));
  try {
    execFileSync("/usr/bin/ditto", ["-x", "-k", path.resolve(archive), temporary]);
    const app = path.join(temporary, "Kobashi.app");
    verifyExecutableModes(app);
    const info = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-",
      path.join(app, "Contents/Info.plist")], { encoding: "utf8" }));
    if (info.CFBundleIdentifier !== "com.xjin6.kobashi" || info.CFBundleExecutable !== "kobashi") {
      throw new Error("Unexpected application identity in ZIP");
    }
    execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
    const architectures = execFileSync("/usr/bin/lipo", ["-archs", path.join(app, EXECUTABLES[0])],
      { encoding: "utf8" }).trim().split(/\s+/).sort();
    if (architectures.join(",") !== "arm64,x86_64") throw new Error("Missing wrapper architecture");
    return { version: info.CFBundleShortVersionString, executableModes: "755", architectures,
      signature: "valid ad-hoc", extractedZipVerified: true };
  } finally {
    // This is only the unique validation directory, never a live application.
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: node verify-mac-package.js Kobashi.zip");
    console.log(JSON.stringify(verifyPackage(process.argv[2])));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { EXECUTABLES, verifyExecutableModes, verifyPackage };
