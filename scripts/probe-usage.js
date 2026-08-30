#!/usr/bin/env node
// Probe: find an endpoint that reports Copilot premium-request / AI-credit usage
// (the number github.com/settings/copilot/features renders as "X / Y AI credits").
//
// Read-only. Every request is a GET; nothing is written and no config is touched.
// Reuses the GitHub token kobashi already stores in ~/.kobashi/session.json.
//
//   node scripts/probe-usage.js            # summary
//   node scripts/probe-usage.js --full     # dump full JSON bodies
//
// Token precedence: $GITHUB_TOKEN, else ~/.kobashi/session.json.

const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");

const FULL = process.argv.includes("--full");

function loadToken() {
  if (process.env.GITHUB_TOKEN) return { tok: process.env.GITHUB_TOKEN, src: "$GITHUB_TOKEN" };
  const p = path.join(os.homedir(), ".kobashi", "session.json");
  try {
    const t = JSON.parse(fs.readFileSync(p, "utf-8")).github_token;
    if (t) return { tok: t, src: "~/.kobashi/session.json" };
  } catch {}
  return null;
}

// The exact header set kobashi already sends, so we look like the editor client
// the internal endpoints expect.
const HDRS = (tok) => ({
  Authorization: `token ${tok}`,
  "User-Agent": "GitHubCopilotChat/0.38.2",
  "Editor-Version": "vscode/1.110.1",
  "Editor-Plugin-Version": "copilot-chat/0.38.2",
  "Copilot-Integration-Id": "vscode-chat",
  Accept: "application/json",
});

function get(hostname, p, headers) {
  return new Promise((resolve) => {
    const req = https.request({ hostname, path: p, method: "GET", headers, timeout: 15000 }, (res) => {
      const c = [];
      res.on("data", (d) => c.push(d));
      res.on("end", () => {
        const raw = Buffer.concat(c).toString();
        let body = raw;
        try { body = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body, raw });
      });
    });
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, body: null, raw: "timeout" }); });
    req.on("error", (e) => resolve({ status: 0, body: null, raw: e.message }));
    req.end();
  });
}

// Walk a JSON tree and surface anything that smells like a quota/usage counter.
const KEY_RE = /quota|usage|credit|premium|entitle|remaining|limit|percent|reset|allowance|balance|snapshot|overage/i;
function findQuota(obj, prefix = "", out = []) {
  if (obj === null || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (KEY_RE.test(k) && (typeof v !== "object" || v === null)) out.push([p, v]);
    else if (KEY_RE.test(k) && typeof v === "object") {
      out.push([p, `<${Array.isArray(v) ? "array[" + v.length + "]" : "object"}>`]);
      findQuota(v, p, out);
    } else if (typeof v === "object") findQuota(v, p, out);
  }
  return out;
}

const TARGETS = [
  // Most likely: the same endpoint kobashi already calls for the Copilot token.
  // Its response carries far more than {token, expires_at} - historically it has
  // included entitlement and quota_snapshots blocks.
  ["api.github.com", "/copilot_internal/v2/token", "token endpoint kobashi already uses"],
  ["api.github.com", "/copilot_internal/user",     "internal user/entitlement record"],
  ["api.github.com", "/copilot_internal/user/quota", "speculative quota subresource"],
  // Public REST surface.
  ["api.github.com", "/user",                      "sanity check: is the token alive?"],
  ["api.github.com", "/rate_limit",                "unrelated, but proves auth works"],
  ["api.github.com", "/user/copilot/usage",        "speculative public usage route"],
  ["api.github.com", "/user/copilot/billing",      "speculative public billing route"],
  // The page you looked at is server-rendered; this is the JSON its client calls
  // would hit if one exists.
  ["github.com",     "/settings/copilot/features", "the HTML page itself (look for embedded JSON)"],
];

(async () => {
  const t = loadToken();
  if (!t) {
    console.error("No token. Set $GITHUB_TOKEN or connect kobashi first.");
    process.exit(1);
  }
  console.log(`token: ${t.tok.slice(0, 4)}…${t.tok.slice(-2)}  (from ${t.src})\n`);

  const hits = [];
  for (const [host, p, why] of TARGETS) {
    const r = await get(host, p, HDRS(t.tok));
    const tag = r.status === 200 ? "OK " : r.status === 0 ? "ERR" : String(r.status);
    console.log(`[${tag}] https://${host}${p}`);
    console.log(`      ${why}`);

    if (r.status === 200 && typeof r.body === "object" && r.body) {
      const q = findQuota(r.body);
      if (q.length) {
        console.log("      ── quota-ish fields ──");
        for (const [k, v] of q) console.log(`        ${k} = ${JSON.stringify(v)}`);
        hits.push({ url: `https://${host}${p}`, fields: q });
      } else {
        console.log(`      (200, but no quota-looking keys; top-level: ${Object.keys(r.body).join(", ").slice(0, 160)})`);
      }
      if (FULL) console.log("      FULL: " + JSON.stringify(r.body, null, 2).replace(/\n/g, "\n      "));
    } else if (r.status === 200) {
      // HTML page: hunt for the rendered numbers / embedded JSON payloads.
      const m = r.raw.match(/[\d,]{3,}\s*\/\s*[\d,]{3,}\s*AI credits/i);
      if (m) console.log(`      >>> found in HTML: "${m[0]}"`);
      const j = r.raw.match(/quota[^"]{0,40}"\s*:\s*[^,}]{1,40}/gi);
      if (j) console.log("      embedded json-ish: " + j.slice(0, 6).join(" | "));
      if (!m && !j) console.log("      (200 HTML, no obvious credit string - likely needs a browser session cookie)");
    } else if (r.status !== 0) {
      const msg = typeof r.body === "object" && r.body ? (r.body.message || "") : String(r.raw).slice(0, 120);
      if (msg) console.log(`      → ${msg}`);
    } else {
      console.log(`      → ${r.raw}`);
    }
    console.log();
  }

  console.log("=".repeat(60));
  if (hits.length) {
    console.log("USABLE SOURCES:");
    for (const h of hits) console.log("  " + h.url + "  (" + h.fields.length + " fields)");
  } else {
    console.log("No quota fields found. Re-run with --full to inspect raw bodies.");
  }
})();
