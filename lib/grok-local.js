const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomBytes } = require("node:crypto");

const GROK_PORT = 18924;
const GROK_BASE_URL = `http://127.0.0.1:${GROK_PORT}/v1`;

function grokGatewayKeyPath() {
  return path.join(os.homedir(), ".kobashi", "grok-gateway.key");
}

function loadGrokGatewayKey(keyPath = grokGatewayKeyPath()) {
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(keyPath, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const key = fs.readFileSync(keyPath, "utf8").trim();
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("Invalid local Grok gateway key file");
  return key;
}

function grokSessionFromRecord(saved, fallbackRevision) {
  if (typeof saved?.github_token !== "string" || !saved.github_token.length) return null;
  return {
    account: saved.github_token,
    enabled: saved.grokEnabled === undefined || saved.grokEnabled === true,
    revision: typeof saved.grokRevision === "string" && saved.grokRevision ? saved.grokRevision : fallbackRevision,
  };
}

// In standalone mode the desktop owns the session file. The persisted revision
// distinguishes a quick off/on pair even if no request observed the off state.
function createGrokSessionReader(filename) {
  let previous, session = null;
  return () => {
    try {
      const { ino, ctimeNs } = fs.statSync(filename, { bigint: true });
      const revision = ino + "/" + ctimeNs;
      if (revision !== previous) {
        session = grokSessionFromRecord(JSON.parse(fs.readFileSync(filename, "utf8")), revision);
        previous = revision;
      }
    } catch {
      // The owning app may be writing, signed out, or still on its first login.
      session = null;
      previous = undefined;
    }
    return session;
  };
}

function isLocalGrokControl(req, port) {
  const host = req.headers.host;
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress) &&
    [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host) &&
    (req.headers.origin === undefined || req.headers.origin === "http://" + host) &&
    [undefined, "none", "same-origin"].includes(req.headers["sec-fetch-site"]);
}

module.exports = { GROK_PORT, GROK_BASE_URL, grokGatewayKeyPath, loadGrokGatewayKey,
  createGrokSessionReader, grokSessionFromRecord, isLocalGrokControl };
