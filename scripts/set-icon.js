// Sets icon on a pkg-built exe without corrupting the pkg payload.
// Strategy: extract the pkg payload appended after PE sections,
// run rcedit (which only modifies PE), then re-append the payload.
const fs = require("fs");
const { execFileSync } = require("child_process");
const path = require("path");

const exe = process.argv[2];
const ico = process.argv[3];
if (!exe || !ico) { console.error("Usage: node set-icon.js <exe> <ico>"); process.exit(1); }

const buf = fs.readFileSync(exe);

// Parse PE to find end of PE image (last section's raw end)
const peOff = buf.readUInt32LE(0x3C);
const numSections = buf.readUInt16LE(peOff + 6);
const optHeaderSize = buf.readUInt16LE(peOff + 20);
const sectionTableOff = peOff + 24 + optHeaderSize;

let peEnd = 0;
for (let i = 0; i < numSections; i++) {
  const off = sectionTableOff + i * 40;
  const rawSize = buf.readUInt32LE(off + 16);
  const rawPtr = buf.readUInt32LE(off + 20);
  const sectionEnd = rawPtr + rawSize;
  if (sectionEnd > peEnd) peEnd = sectionEnd;
}

console.log(`PE image ends at: ${peEnd} (0x${peEnd.toString(16)})`);
console.log(`Total file size:  ${buf.length}`);
console.log(`Payload size:     ${buf.length - peEnd}`);

// Extract payload (everything after PE image)
const payload = buf.slice(peEnd);

// Run rcedit on the exe
const { execSync } = require("child_process");
const npmRoot = execSync("npm root -g").toString().trim();
const rceditCandidates = [
  path.join(npmRoot, "rcedit/bin/rcedit-x64.exe"),
  path.join(process.env.APPDATA || "", "npm/node_modules/rcedit/bin/rcedit-x64.exe"),
];
const rcedit = rceditCandidates.find(p => fs.existsSync(p));
if (!rcedit) { console.error("rcedit not found. Install with: npm install -g rcedit"); process.exit(1); }
console.log(`Running rcedit from ${rcedit}...`);
// On macOS/Linux, rcedit-x64.exe is a Windows binary; run via wine if available.
if (process.platform !== "win32") {
  try {
    execFileSync("wine", [rcedit, exe, "--set-icon", ico], { stdio: "inherit" });
  } catch (e) {
    console.error("wine not available; skipping icon embed. Install wine or build on Windows for custom icon.");
    process.exit(0);
  }
} else {
  execFileSync(rcedit, [exe, "--set-icon", ico]);
}

// Read modified exe and re-append payload
const modified = fs.readFileSync(exe);
// Find new PE end
const newBuf = Buffer.from(modified);
const newPeOff = newBuf.readUInt32LE(0x3C);
const newNumSections = newBuf.readUInt16LE(newPeOff + 6);
const newOptHeaderSize = newBuf.readUInt16LE(newPeOff + 20);
const newSectionTableOff = newPeOff + 24 + newOptHeaderSize;

let newPeEnd = 0;
for (let i = 0; i < newNumSections; i++) {
  const off = newSectionTableOff + i * 40;
  const rawSize = newBuf.readUInt32LE(off + 16);
  const rawPtr = newBuf.readUInt32LE(off + 20);
  const sectionEnd = rawPtr + rawSize;
  if (sectionEnd > newPeEnd) newPeEnd = sectionEnd;
}

console.log(`New PE image ends at: ${newPeEnd}`);

// Pad modified PE to original PE end offset, then append payload
// This preserves the absolute offset where pkg expects to find its data
const pePart = newBuf.slice(0, newPeEnd);
const padding = Buffer.alloc(Math.max(0, peEnd - newPeEnd), 0);
console.log(`Padding: ${padding.length} bytes to match original offset ${peEnd}`);
const final = Buffer.concat([pePart, padding, payload]);
fs.writeFileSync(exe, final);
console.log(`Final size: ${final.length} (original: ${buf.length}) — icon set, payload restored.`);
