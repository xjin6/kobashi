// Sets icon on a pkg-built exe without corrupting the pkg payload.
// Uses resedit (pure JS) so this works on macOS/Linux without wine.
// Strategy: extract the pkg payload appended after PE sections,
// run resedit to inject icon resources, then re-append the payload.
const fs = require("fs");
const path = require("path");

const exe = process.argv[2];
const ico = process.argv[3];
if (!exe || !ico) { console.error("Usage: node set-icon.js <exe> <ico>"); process.exit(1); }

const buf = fs.readFileSync(exe);

function peEndOf(b) {
  const peOff = b.readUInt32LE(0x3C);
  const numSections = b.readUInt16LE(peOff + 6);
  const optHeaderSize = b.readUInt16LE(peOff + 20);
  const sectionTableOff = peOff + 24 + optHeaderSize;
  let end = 0;
  for (let i = 0; i < numSections; i++) {
    const off = sectionTableOff + i * 40;
    const rawSize = b.readUInt32LE(off + 16);
    const rawPtr = b.readUInt32LE(off + 20);
    const sectionEnd = rawPtr + rawSize;
    if (sectionEnd > end) end = sectionEnd;
  }
  return end;
}

const peEnd = peEndOf(buf);
console.log(`PE image ends at: ${peEnd} (0x${peEnd.toString(16)})`);
console.log(`Total file size:  ${buf.length}`);
console.log(`Payload size:     ${buf.length - peEnd}`);

// Extract pkg payload appended after PE image.
const payload = buf.slice(peEnd);
const peOnly  = buf.slice(0, peEnd);

// Use resedit to inject icon resources into the PE portion.
const ResEdit    = require("resedit");
const PELibrary  = require("pe-library");

const exeTmp = exe + ".pe-only";
fs.writeFileSync(exeTmp, peOnly);

const exeBin   = PELibrary.NtExecutable.from(fs.readFileSync(exeTmp));
const resource = PELibrary.NtExecutableResource.from(exeBin);

const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(ico));
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
  resource.entries,
  1,                    // resource id
  1033,                  // language (en-US, matches rcedit default)
  iconFile.icons.map(i => i.data),
);

resource.outputResource(exeBin);
const newPeBuf = Buffer.from(exeBin.generate());
fs.unlinkSync(exeTmp);

console.log(`New PE size:      ${newPeBuf.length}`);

// Re-append payload at original offset. Pad if PE shrank so the payload's
// absolute offset matches what pkg stamped into the binary.
const newPeEnd = peEndOf(newPeBuf);
console.log(`New PE image ends at: ${newPeEnd}`);
const padding = Buffer.alloc(Math.max(0, peEnd - newPeEnd), 0);
console.log(`Padding: ${padding.length} bytes to match original offset ${peEnd}`);
const pePart = newPeBuf.slice(0, newPeEnd);
const final  = Buffer.concat([pePart, padding, payload]);

fs.writeFileSync(exe, final);
console.log(`Final size: ${final.length} (original: ${buf.length}) — icon set, payload restored.`);
