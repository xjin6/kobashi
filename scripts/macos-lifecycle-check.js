const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

assert.equal(process.platform, "darwin", "Lifecycle checks require macOS and a graphical login session");
const root = path.resolve(__dirname, "..");
const smoke = process.argv.includes("--smoke");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "appkit-lifecycle-"));
try {
  const source = fs.readFileSync(path.join(root, "macos/main.swift"), "utf8");
  const entryPoint = "\nlet app = NSApplication.shared\n";
  assert.equal(source.split(entryPoint).length, 2, "Expected one standalone app entry point");
  // Replace only the launch entry point: exercise the real delegate without
  // launching the bundled bridge or touching the user's ports/configuration.
  const harness = fs.readFileSync(path.join(root, smoke ? "test/macos-smoke.swift" : "test/macos-lifecycle.swift"), "utf8");
  const main = path.join(temporary, "main.swift");
  const contents = path.join(temporary, "Kobashi Lifecycle Test.app", "Contents");
  fs.mkdirSync(path.join(contents, "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>lifecycle-check</string>
<key>CFBundleName</key><string>Kobashi Lifecycle Test</string>
<key>CFBundleIdentifier</key><string>com.xjin6.kobashi.lifecycle-test</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`);
  const executable = path.join(contents, "MacOS", "lifecycle-check");
  fs.writeFileSync(main, source.slice(0, source.indexOf(entryPoint)) + "\n" + harness);
  for (const [command, args] of [
    ["/usr/bin/xcrun", ["--toolchain", "XcodeDefault", "swiftc", "-framework", "Cocoa", "-framework", "WebKit", main, "-o", executable]],
    [executable, []],
  ]) {
    const result = spawnSync(command, args, {
      stdio: "inherit",
      ...(smoke && command === executable ? {} : { timeout: 120000 }),
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${command} failed (${result.signal || result.status})`);
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
