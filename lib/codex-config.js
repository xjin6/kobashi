const DEFAULT_CONTEXT_WINDOW = 1_000_000;
const DEFAULT_AUTO_COMPACT_TOKEN_LIMIT = 900_000;
const KOBASHI_DEFAULT_COMMENT = "Kobashi default";
const UTF8_BOM = "\uFEFF";

function sourceText(source) {
  if (Buffer.isBuffer(source)) return source.toString("utf8");
  return String(source || "");
}

function withoutBom(source) {
  const text = sourceText(source);
  return text.startsWith(UTF8_BOM)
    ? { bom: UTF8_BOM, body: text.slice(1) }
    : { bom: "", body: text };
}

function detectNewline(source) {
  const match = source.match(/\r\n|\n|\r/);
  return match ? match[0] : "\n";
}

function linesWithOffsets(source) {
  const lines = [];
  let start = 0;
  while (start < source.length) {
    const newline = source.indexOf("\n", start);
    const end = newline === -1 ? source.length : newline + 1;
    let contentEnd = newline === -1 ? end : newline;
    if (contentEnd > start && source[contentEnd - 1] === "\r") contentEnd -= 1;
    lines.push({ start, end, text: source.slice(start, contentEnd) });
    start = end;
  }
  return lines;
}

function parseTableHeader(line) {
  let index = 0;
  while (index < line.length && /[ \t]/.test(line[index])) index += 1;
  if (line[index] !== "[") return null;

  const arrayTable = line[index + 1] === "[";
  const openingLength = arrayTable ? 2 : 1;
  const contentStart = index + openingLength;
  index = contentStart;
  let quote = null;
  let escaped = false;

  for (; index < line.length; index += 1) {
    const char = line[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    const closes = arrayTable
      ? char === "]" && line[index + 1] === "]"
      : char === "]";
    if (!closes) continue;

    const contentEnd = index;
    index += arrayTable ? 2 : 1;
    const rest = line.slice(index).trimStart();
    if (rest && !rest.startsWith("#")) return null;
    return {
      arrayTable,
      path: line.slice(contentStart, contentEnd),
    };
  }
  return null;
}

function neutralState(state) {
  return state.string === null && state.squareDepth === 0 && state.curlyDepth === 0;
}

// Track just enough TOML lexical state to distinguish real statements from
// header-looking text inside multiline strings, arrays, and inline tables.
function scanTomlLine(line, state) {
  let index = 0;
  while (index < line.length) {
    const char = line[index];

    if (state.string === "multiline-basic") {
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (line.startsWith('"""', index)) {
        while (line[index] === '"') index += 1;
        state.string = null;
        continue;
      }
      index += 1;
      continue;
    }
    if (state.string === "multiline-literal") {
      if (line.startsWith("'''", index)) {
        while (line[index] === "'") index += 1;
        state.string = null;
        continue;
      }
      index += 1;
      continue;
    }
    if (state.string === "basic") {
      if (char === "\\") index += 2;
      else {
        if (char === '"') state.string = null;
        index += 1;
      }
      continue;
    }
    if (state.string === "literal") {
      if (char === "'") state.string = null;
      index += 1;
      continue;
    }

    if (char === "#") break;
    if (line.startsWith('"""', index)) {
      state.string = "multiline-basic";
      index += 3;
      continue;
    }
    if (line.startsWith("'''", index)) {
      state.string = "multiline-literal";
      index += 3;
      continue;
    }
    if (char === '"') state.string = "basic";
    else if (char === "'") state.string = "literal";
    else if (char === "[") state.squareDepth += 1;
    else if (char === "]" && state.squareDepth > 0) state.squareDepth -= 1;
    else if (char === "{") state.curlyDepth += 1;
    else if (char === "}" && state.curlyDepth > 0) state.curlyDepth -= 1;
    index += 1;
  }

  // Valid TOML basic and literal strings cannot cross a physical newline.
  if (state.string === "basic" || state.string === "literal") state.string = null;
}

function scanToml(source) {
  const tables = [];
  const assignments = [];
  const state = { string: null, squareDepth: 0, curlyDepth: 0 };
  let currentTable = null;
  let activeAssignment = null;

  for (const line of linesWithOffsets(source)) {
    const structuralLine = neutralState(state);
    const header = structuralLine ? parseTableHeader(line.text) : null;
    if (header) {
      currentTable = {
        ...header,
        start: line.start,
        bodyStart: line.end,
        end: source.length,
      };
      tables.push(currentTable);
      activeAssignment = null;
      continue;
    }

    if (structuralLine) {
      const match = line.text.match(/^\s*([A-Za-z0-9_-]+)\s*=/);
      if (match) {
        activeAssignment = {
          key: match[1].toLowerCase(),
          start: line.start,
          end: line.end,
          table: currentTable,
        };
        assignments.push(activeAssignment);
      }
    }

    scanTomlLine(line.text, state);
    if (activeAssignment) {
      activeAssignment.end = line.end;
      if (neutralState(state)) activeAssignment = null;
    }
  }

  for (let index = 0; index < tables.length; index += 1) {
    tables[index].end = index + 1 < tables.length ? tables[index + 1].start : source.length;
  }
  return { assignments, tables };
}

function rootAssignments(scan, key) {
  const normalized = key.toLowerCase();
  return scan.assignments.filter(assignment =>
    assignment.table === null && assignment.key === normalized);
}

function assignmentText(source, assignment) {
  return source.slice(assignment.start, assignment.end);
}

function assignmentStringValue(source, assignment) {
  const text = assignmentText(source, assignment).trim();
  const match = text.match(/^[A-Za-z0-9_-]+\s*=\s*(?:"((?:\\.|[^"\\])*)"|'([^']*)')\s*(?:#.*)?$/s);
  if (!match) return null;
  if (match[2] !== undefined) return match[2];
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return null;
  }
}

function providerName(table) {
  const match = table.path.match(/^\s*(?:model_providers|"model_providers"|'model_providers')\s*\.\s*(?:([A-Za-z0-9_-]+)|"([^"]+)"|'([^']+)')\s*$/i);
  return match ? (match[1] || match[2] || match[3]).toLowerCase() : null;
}

function isKobashiProviderName(name) {
  return name === "kobashi" || name === "copilot-bridge";
}

function isManagedProviderTable(table, scan, source, proxyPort) {
  const name = providerName(table);
  if (!isKobashiProviderName(name)) return false;
  const baseUrl = scan.assignments.find(assignment =>
    assignment.table === table && assignment.key === "base_url");
  if (!baseUrl) return false;
  const value = assignmentStringValue(source, baseUrl);
  if (!value) return false;
  const escapedPort = proxyPort === undefined ? "\\d+" : String(proxyPort).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^https?://127\\.0\\.0\\.1:${escapedPort}(?:/|$)`, "i").test(value);
}

function removeRanges(source, ranges) {
  const sorted = ranges
    .filter(range => range && range.end > range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  if (!sorted.length) return source;

  const merged = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ start: range.start, end: range.end });
  }

  let result = "";
  let cursor = 0;
  for (const range of merged) {
    result += source.slice(cursor, range.start);
    cursor = range.end;
  }
  return result + source.slice(cursor);
}

function hasTopLevelKey(scan, key) {
  return rootAssignments(scan, key).length > 0;
}

function tomlString(value) {
  // TOML basic strings and JSON strings share the escaping needed for Windows
  // paths, quotes, and control characters.
  return JSON.stringify(String(value));
}

function normalizeOptions(options = {}) {
  return {
    modelCatalogPath: options.modelCatalogPath || "",
    defaultContextWindow: Number.isFinite(options.defaultContextWindow)
      ? options.defaultContextWindow
      : DEFAULT_CONTEXT_WINDOW,
    defaultAutoCompactTokenLimit: Number.isFinite(options.defaultAutoCompactTokenLimit)
      ? options.defaultAutoCompactTokenLimit
      : DEFAULT_AUTO_COMPACT_TOKEN_LIMIT,
  };
}

function kobashiDefaultLine(key, value) {
  return `${key} = ${value} # ${KOBASHI_DEFAULT_COMMENT}`;
}

function kobashiCatalogLine(modelCatalogPath) {
  return kobashiDefaultLine("model_catalog_json", tomlString(modelCatalogPath));
}

function endsWithLineBreak(value) {
  return /(?:\r\n|\n|\r)$/.test(value);
}

function endsWithBlankLine(value) {
  return /(?:\r\n|\n|\r)[ \t]*(?:\r\n|\n|\r)$/.test(value);
}

function injectCodexConfig(source, proxyPort, options = {}) {
  const opts = normalizeOptions(options);
  const { bom, body } = withoutBom(source);
  const newline = detectNewline(body);
  const scan = scanToml(body);
  const removalRanges = [];

  // Kobashi must become the active provider while running, so replace any
  // existing top-level selection. The caller's backup remains the baseline
  // used by restoreCodexConfigContents.
  removalRanges.push(...rootAssignments(scan, "model_provider"));
  for (const assignment of rootAssignments(scan, "base_url")) {
    const value = assignmentStringValue(body, assignment);
    if (value && /127\.0\.0\.1/i.test(value)) removalRanges.push(assignment);
  }

  // Versions before the model catalog carried these as global defaults. That
  // made smaller models claim a 1M window too. Migrate only our exact marked
  // lines; an unmarked or edited user setting remains authoritative.
  const legacyDefaults = new Set([
    kobashiDefaultLine("model_context_window", opts.defaultContextWindow),
    kobashiDefaultLine("model_auto_compact_token_limit", opts.defaultAutoCompactTokenLimit),
  ]);
  for (const assignment of scan.assignments) {
    if (assignment.table === null && legacyDefaults.has(assignmentText(body, assignment).trim())) {
      removalRanges.push(assignment);
    }
  }
  for (const table of scan.tables) {
    if (isKobashiProviderName(providerName(table))) removalRanges.push(table);
  }

  const cleaned = removeRanges(body, removalRanges);
  const cleanScan = scanToml(cleaned);
  const firstTable = cleanScan.tables[0];
  const providerOffset = firstTable ? firstTable.start : cleaned.length;
  const prefix = cleaned.slice(0, providerOffset);
  const suffix = cleaned.slice(providerOffset);

  const injectedTop = [`model_provider = "kobashi"`];
  if (opts.modelCatalogPath && !hasTopLevelKey(cleanScan, "model_catalog_json")) {
    injectedTop.push(kobashiCatalogLine(opts.modelCatalogPath));
  }
  let result = `${injectedTop.join(newline)}${newline}${prefix}`;
  if (result && !endsWithLineBreak(result)) result += `${newline}${newline}`;
  else if (!endsWithBlankLine(result)) result += newline;

  const provider = [
    `[model_providers.kobashi]`,
    `name = "Kobashi"`,
    `base_url = "http://127.0.0.1:${proxyPort}/v1"`,
    `env_key = "OPENAI_API_KEY"`,
    `wire_api = "responses"`,
  ].join(newline);
  result += provider;
  result += suffix ? `${newline}${newline}${suffix}` : newline;
  return `${bom}${result}`;
}

function restoredProviderAssignment(backupBody, backupScan) {
  const assignment = rootAssignments(backupScan, "model_provider")[0];
  return assignment ? assignmentText(backupBody, assignment).trimEnd() : "";
}

// Restore only fields and sections demonstrably owned by Kobashi. Everything
// else comes from the live file so settings added while Kobashi is running are
// never rolled back to an old .bak snapshot.
function restoreCodexConfigContents(liveSource, backupSource = "", options = {}) {
  const opts = normalizeOptions(options);
  const live = withoutBom(liveSource);
  const newline = detectNewline(live.body || sourceText(backupSource));
  const liveScan = scanToml(live.body);

  // Old Kobashi versions could accidentally snapshot their own injected config.
  // Such a backup is not a user baseline and must never resurrect the bridge.
  const usableBackup = isKobashiManagedConfig(backupSource) ? "" : sourceText(backupSource);
  const backup = withoutBom(usableBackup);
  const backupScan = scanToml(backup.body);
  const managedTables = liveScan.tables.filter(table =>
    isManagedProviderTable(table, liveScan, live.body));
  const managedNames = new Set(managedTables.map(providerName));
  const removalRanges = [...managedTables];

  // A non-Kobashi selection may have been added while the bridge was running;
  // never delete it. Remove only a selection tied to a managed local section.
  for (const assignment of rootAssignments(liveScan, "model_provider")) {
    const value = assignmentStringValue(live.body, assignment);
    if (value && managedNames.has(value.toLowerCase())) removalRanges.push(assignment);
  }

  const defaults = [
    ["model_context_window", opts.defaultContextWindow],
    ["model_auto_compact_token_limit", opts.defaultAutoCompactTokenLimit],
  ];
  if (opts.modelCatalogPath) {
    defaults.push(["model_catalog_json", tomlString(opts.modelCatalogPath)]);
  }
  for (const [key, value] of defaults) {
    if (hasTopLevelKey(backupScan, key)) continue;
    const ownedLine = kobashiDefaultLine(key, value);
    for (const assignment of rootAssignments(liveScan, key)) {
      if (assignmentText(live.body, assignment).trim() === ownedLine) removalRanges.push(assignment);
    }
  }

  let restored = removeRanges(live.body, removalRanges);
  let restoredScan = scanToml(restored);
  const backupProvider = restoredProviderAssignment(backup.body, backupScan);
  if (backupProvider && !hasTopLevelKey(restoredScan, "model_provider")) {
    restored = `${backupProvider}${newline}${restored}`;
    restoredScan = scanToml(restored);
  }

  // Injection replaces a same-named provider table. Restore a pre-existing,
  // non-local table from the backup once, but never duplicate it on restore.
  const existingNames = new Set(restoredScan.tables.map(providerName).filter(Boolean));
  const providerBlocks = backupScan.tables
    .filter(table => isKobashiProviderName(providerName(table)) && !existingNames.has(providerName(table)))
    .map(table => backup.body.slice(table.start, table.end).trimEnd());
  if (providerBlocks.length) {
    const tableOffset = restoredScan.tables[0] ? restoredScan.tables[0].start : restored.length;
    let prefix = restored.slice(0, tableOffset);
    const suffix = restored.slice(tableOffset);
    if (prefix && !endsWithLineBreak(prefix)) prefix += `${newline}${newline}`;
    else if (prefix && !endsWithBlankLine(prefix)) prefix += newline;
    restored = `${prefix}${providerBlocks.join(`${newline}${newline}`)}`;
    restored += suffix ? `${newline}${newline}${suffix}` : newline;
  }

  return `${live.bom}${restored}`;
}

function isKobashiManagedConfig(source, proxyPort) {
  const { body } = withoutBom(source);
  const scan = scanToml(body);
  const selectedNames = new Set(
    rootAssignments(scan, "model_provider")
      .map(assignment => assignmentStringValue(body, assignment))
      .filter(Boolean)
      .map(value => value.toLowerCase())
      .filter(isKobashiProviderName),
  );
  if (!selectedNames.size) return false;
  return scan.tables.some(table =>
    selectedNames.has(providerName(table)) &&
      isManagedProviderTable(table, scan, body, proxyPort));
}

function isKobashiManagedAuth(source) {
  try {
    const auth = typeof source === "string" || Buffer.isBuffer(source)
      ? JSON.parse(String(source))
      : source;
    return !!auth && typeof auth === "object" &&
      auth.OPENAI_API_KEY === "PROXY_MANAGED";
  } catch {
    return false;
  }
}

module.exports = {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_AUTO_COMPACT_TOKEN_LIMIT,
  injectCodexConfig,
  restoreCodexConfigContents,
  isKobashiManagedConfig,
  isKobashiManagedAuth,
};
