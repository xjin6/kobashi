const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");
const { selectCopilotOpenAIModels } = require("./codex-model-catalog");
const { PROBE_VERSION } = require("./codex-model-probe");
const { isModelUnavailable } = require("./codex-request-compat");

function digest(value) {
  function ordered(value) {
    if (Array.isArray(value)) return value.map(ordered);
    if (value && typeof value === "object") return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, ordered(value[key])]),
    );
    return value;
  }
  return createHash("sha256").update(JSON.stringify(ordered(value))).digest("hex");
}

class CodexModelCapabilities {
  constructor({ probe, cachePath, onChange = () => {}, now = Date.now, concurrency = 2 } = {}) {
    Object.assign(this, { probe, cachePath, onChange, now, concurrency });
    this.account = null;
    this.generation = 0;
    this.latest = new Map();
    this.hasSnapshot = false;
    this.records = new Map();
    this.inflight = new Set();
    this.queued = new Set();
    this.active = 0;
    this.waiters = [];
    this.enabled = true;
  }

  setAccount(identity) {
    const account = identity ? digest(identity) : null;
    if (account === this.account) return;
    this.account = account;
    this.generation++;
    this.latest.clear();
    this.hasSnapshot = false;
    this.records.clear();
    this.queued.clear();
    if (account && this.cachePath) {
      try {
        const saved = JSON.parse(fs.readFileSync(this.cachePath, "utf8"));
        if (saved.version === PROBE_VERSION && saved.account === account && Array.isArray(saved.records)) {
          for (const record of saved.records) {
            if (typeof record.id === "string" && typeof record.signature === "string" &&
                ["verified", "unavailable", "unknown"].includes(record.state) &&
                Number.isFinite(record.checkedAt) && record.checkedAt <= this.now()) {
              // Ignore legacy timed-recheck fields when migrating old caches.
              const { nextProbeAt, ...savedRecord } = record;
              this.records.set(record.id, savedRecord);
            }
          }
          // Keep the account-scoped discovery snapshot as well as verdicts so
          // a bridge restart can publish verified models before Codex starts.
          for (const entry of saved.latest || []) {
            if (selectCopilotOpenAIModels([entry?.model]).length &&
                this.records.get(entry.model.id)?.signature === entry.signature) {
              this.latest.set(entry.model.id, entry);
            }
          }
          this.hasSnapshot = Array.isArray(saved.latest);
        }
      } catch {}
    }
    this.changed();
  }

  update(models, bundledCatalog, { revalidate = false } = {}) {
    if (revalidate) {
      this.generation++;
      this.queued.clear();
    }
    const native = new Map((bundledCatalog?.models || []).map(model => [model.slug, model]));
    const latest = new Map();
    for (const model of selectCopilotOpenAIModels(models)) {
      const template = native.get(model.id) || null;
      const signature = digest({ protocol: PROBE_VERSION, model: {
        id: model.id, version: model.version, vendor: model.vendor, policy: model.policy,
        supported_endpoints: model.supported_endpoints, capabilities: model.capabilities,
      }, native: template });
      latest.set(model.id, { model, native: template, signature });
      const previous = this.records.get(model.id);
      if (previous?.signature !== signature) {
        const oldEntry = this.latest.get(model.id);
        // A metadata update needs a new check, but does not revoke an earlier
        // success. Keep its exact model/native snapshot until validation ends.
        this.records.set(model.id, previous?.state === "verified" ? {
          ...previous, signature,
          verifiedModel: previous.verifiedModel || oldEntry?.model || model,
          verifiedNative: Object.hasOwn(previous, "verifiedNative") ? previous.verifiedNative : oldEntry?.native ?? template,
        } : { id: model.id, signature, state: "unknown", constraints: {}, checkedAt: 0 });
        this.queued.add(model.id);
      } else if (revalidate) {
        // Recheck once per launch without blanking the last verified picker.
        // Explicit access failures still remove the model immediately.
        this.queued.add(model.id);
      }
    }
    this.latest = latest;
    this.hasSnapshot = true;
    for (const id of this.records.keys()) if (!latest.has(id)) {
      this.records.delete(id); this.queued.delete(id);
    }
    this.changed();
    this.pump();
  }

  token(id) {
    const entry = this.latest.get(id);
    return entry ? `${this.generation}:${entry.signature}` : null;
  }

  constraints(id) {
    return this.latest.has(id) ? this.records.get(id)?.constraints || {} : {};
  }

  rawModels() { return [...this.latest.values()].map(entry => entry.model); }

  wasVerified(id) { return this.records.get(id)?.state === "verified"; }

  models() {
    const visible = [];
    for (const [id, entry] of this.latest) {
      const record = this.records.get(id);
      if (record?.state !== "verified") continue;
      const model = JSON.parse(JSON.stringify(record.verifiedModel || entry.model));
      const rule = record.constraints?.["reasoning.effort"];
      if (rule === null || Array.isArray(rule)) {
        // A server validation response can correct stale /models metadata.
        model.capabilities.supports.reasoning_effort = rule || [];
      }
      model.kobashi_verified = { constraints: record.constraints, checkedAt: record.checkedAt,
        native: Object.hasOwn(record, "verifiedNative") ? record.verifiedNative : entry.native };
      visible.push(model);
    }
    return visible;
  }

  learn(id, token, constraints) {
    if (!token || token !== this.token(id)) return;
    const record = this.records.get(id);
    record.constraints = { ...record.constraints, ...constraints };
    // A running probe began with older rules. Its eventual success must not
    // erase an explicit validation result observed in a real request meanwhile.
    record.revision = (record.revision || 0) + 1;
    this.changed();
  }

  observeFailure(id, token, status, error) {
    if (!token || token !== this.token(id) || !isModelUnavailable(status, error)) return;
    const record = this.records.get(id);
    record.state = "unavailable";
    record.reason = "model_unavailable";
    record.revision = (record.revision || 0) + 1;
    this.queued.delete(id);
    this.changed();
  }

  status() {
    return { verified: this.models().length, discovered: this.latest.size,
      checking: this.active, queued: this.queued.size, unavailable: [...this.records.values()].filter(r => r.state === "unavailable").length };
  }

  pump() {
    if (!this.account || !this.enabled) return;
    for (const id of this.queued) {
      if (this.active >= this.concurrency) break;
      const entry = this.latest.get(id);
      if (!entry) { this.queued.delete(id); continue; }
      const record = this.records.get(id);
      const token = this.token(id);
      if (this.inflight.has(token)) continue;
      this.queued.delete(id);
      this.inflight.add(token);
      this.active++;
      const revision = record.revision || 0;
      Promise.resolve().then(() => this.probe(entry.model, entry.native)).catch(() => ({
        state: "transient", reason: "probe_failed", constraints: {},
      })).then(result => {
        if (this.token(id) !== token || !this.account) return;
        const current = this.records.get(id);
        const newerEvidence = (current.revision || 0) !== revision;
        if (newerEvidence && current.state === "unavailable") return;
        const constraints = newerEvidence
          ? { ...(result.constraints || {}), ...current.constraints }
          : result.constraints || {};
        if (result.state === "verified") {
          Object.assign(current, { state: "verified", constraints,
            checkedAt: this.now(), checkedEffort: result.checkedEffort, reason: null,
            verifiedModel: entry.model, verifiedNative: entry.native });
        } else if (result.state === "unavailable") {
          if (!newerEvidence) Object.assign(current, { state: "unavailable", constraints,
            checkedAt: this.now(), reason: result.reason });
        } else {
          // No timed retry. A restart explicitly requests a new validation
          // round. Preserve an earlier success, but never promote an
          // untested model merely because a request timed out.
          current.reason = result.reason;
        }
      }).finally(() => {
        this.active--;
        this.inflight.delete(token);
        this.changed();
        this.pump();
        if (!this.active) this.waiters.splice(0).forEach(resolve => resolve());
      });
    }
  }

  idle() { return this.active ? new Promise(resolve => this.waiters.push(resolve)) : Promise.resolve(); }

  pause() { this.enabled = false; this.generation++; this.queued.clear(); }
  resume() { this.enabled = true; }

  changed() {
    if (this.cachePath) {
      const temporary = `${this.cachePath}.${process.pid}.tmp`;
      try {
        fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
        fs.writeFileSync(temporary, JSON.stringify({ version: PROBE_VERSION, account: this.account,
          records: [...this.records.values()],
          ...(this.hasSnapshot ? { latest: [...this.latest.values()] } : {}) }), { mode: 0o600 });
        fs.renameSync(temporary, this.cachePath);
      } catch { try { fs.unlinkSync(temporary); } catch {} }
    }
    try { this.onChange(); } catch {}
  }
}

module.exports = { CodexModelCapabilities };
