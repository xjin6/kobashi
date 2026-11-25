// Build from a disposable local copy. Only finished release files are published
// to the source checkout, which may live in OneDrive.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { spawn, execFileSync } = require("node:child_process");

const SOURCE_ENTRIES = ["package.json", "index.js", "lib", "assets", "macos", "scripts"];
const RELEASE_FILES = { mac: "Kobashi.zip", win: "Kobashi.exe" };

function within(file, directory) {
  const relative = path.relative(directory, file);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

// Resolve existing ancestors too, so a nonexistent child of a symlink into
// OneDrive cannot accidentally become our local build directory.
function resolvedLocation(directory) {
  let parent = path.resolve(directory);
  const suffix = [];
  while (!fs.existsSync(parent)) {
    const next = path.dirname(parent);
    if (next === parent) throw new Error(`Cannot resolve build path: ${directory}`);
    suffix.unshift(path.basename(parent)); parent = next;
  }
  return path.join(fs.realpathSync(parent), ...suffix);
}

function assertLocal(directory, sourceRoot, env = process.env) {
  const resolved = resolvedLocation(directory);
  const cloudRoots = [env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial].filter(Boolean);
  if (within(resolved, resolvedLocation(sourceRoot)) ||
      /(?:^|[\\/])OneDrive[^\\/]*(?:[\\/]|$)/i.test(resolved) ||
      /[\\/]Library[\\/]CloudStorage(?:[\\/]|$)/i.test(resolved) ||
      cloudRoots.some(root => within(resolved, resolvedLocation(root)))) {
    throw new Error(`Build scratch/cache must be outside the checkout and OneDrive: ${directory}`);
  }
  return resolved;
}

function localTempRoot(sourceRoot, env = process.env) {
  if (env.KOBASHI_BUILD_TMPDIR) return assertLocal(env.KOBASHI_BUILD_TMPDIR, sourceRoot, env);
  for (const candidate of [os.tmpdir(), path.join(os.homedir(), ".kobashi", "build-tmp")]) {
    try { return assertLocal(candidate, sourceRoot, env); } catch {}
  }
  throw new Error("No local temporary directory available; set KOBASHI_BUILD_TMPDIR outside OneDrive.");
}

function copySource(sourceRoot, workspace) {
  for (const name of SOURCE_ENTRIES) {
    fs.cpSync(path.join(sourceRoot, name), path.join(workspace, name), { recursive: true, dereference: true });
  }
  // Icon tooling lives here. Copy dependencies, rather than symlinking them to
  // the synced checkout where a tool could write caches or generated files.
  if (fs.existsSync(path.join(sourceRoot, "node_modules"))) {
    fs.cpSync(path.join(sourceRoot, "node_modules"), path.join(workspace, "node_modules"), {
      recursive: true, dereference: true,
    });
  }
}

function runScript(script, workspace, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [script], { cwd: workspace, env, stdio: "inherit",
      detached: process.platform !== "win32" });
    let interrupted = false;
    const stop = signal => {
      interrupted = true;
      if (!child.pid) return;
      try {
        if (process.platform === "win32") {
          execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        } else process.kill(-child.pid, signal);
      } catch {}
    };
    const onInterrupt = () => stop("SIGINT"), onTerminate = () => stop("SIGTERM");
    process.once("SIGINT", onInterrupt); process.once("SIGTERM", onTerminate);
    const finish = error => {
      process.removeListener("SIGINT", onInterrupt); process.removeListener("SIGTERM", onTerminate);
      error ? reject(error) : resolve();
    };
    child.once("error", finish);
    child.once("exit", (code, signal) => finish(code === 0 && !interrupted ? null
      : new Error(`Build ${interrupted ? "interrupted" : `failed (${signal || code})`}`)));
  });
}

function sha256(file) { return createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }

function sourceSnapshot(root) {
  const files = {};
  function visit(relative) {
    const full = path.join(root, relative);
    if (fs.statSync(full).isDirectory()) {
      for (const name of fs.readdirSync(full).sort()) visit(relative + "/" + name);
    } else files[relative] = sha256(full);
  }
  for (const entry of SOURCE_ENTRIES) visit(entry);
  return files;
}

function assertSourcesMatch(before, after) {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  if ([...names].some(name => before[name] !== after[name])) {
    throw new Error("Source changed during packaging; rebuild before publishing the release.");
  }
}

function publishRelease(sourceRoot, workspace, name) {
  const built = path.join(workspace, "dist", name);
  if (!fs.statSync(built).isFile() || fs.statSync(built).size === 0) throw new Error(`Missing release file: ${name}`);
  const output = path.join(sourceRoot, "dist");
  fs.mkdirSync(output, { recursive: true });
  const id = randomUUID();
  const temporary = path.join(output, `.${name}.${id}.tmp`);
  const sumTemporary = path.join(output, `.SHA256SUMS.${id}.tmp`);
  try {
    fs.copyFileSync(built, temporary, fs.constants.COPYFILE_EXCL);
    const digest = sha256(built);
    if (sha256(temporary) !== digest) throw new Error("Release copy checksum mismatch");
    const sums = Object.values(RELEASE_FILES).flatMap(file => {
      const existing = path.join(output, file);
      return file === name ? [`${digest}  ${file}`]
        : fs.existsSync(existing) ? [`${sha256(existing)}  ${file}`] : [];
    });
    fs.writeFileSync(sumTemporary, sums.join("\n") + "\n", { flag: "wx" });
    fs.renameSync(temporary, path.join(output, name));
    fs.renameSync(sumTemporary, path.join(output, "SHA256SUMS.txt"));
    return path.join(output, name);
  } finally {
    for (const file of [temporary, sumTemporary]) {
      try { fs.unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
}

async function buildLocal(target, { sourceRoot = path.resolve(__dirname, ".."), env = process.env,
  run = runScript, log = console.log } = {}) {
  if (!RELEASE_FILES[target]) throw new Error("Usage: node scripts/build-local.js <mac|win>");
  const tempRoot = localTempRoot(sourceRoot, env);
  fs.mkdirSync(tempRoot, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(tempRoot, "kobashi-build-"));
  try {
    log(`==> Local build workspace: ${workspace}`);
    const sources = sourceSnapshot(sourceRoot);
    copySource(sourceRoot, workspace);
    assertSourcesMatch(sources, sourceSnapshot(workspace));
    const scratch = path.join(workspace, "tmp");
    fs.mkdirSync(scratch);
    const childEnv = { ...env, KOBASHI_BUILD_STAGED: "1", TMPDIR: scratch.replace(/\\/g, "/"), TMP: scratch, TEMP: scratch };
    // Retain local download caches, but redirect any cloud-backed overrides.
    for (const [key, fallback] of [["PKG_CACHE_PATH", ".pkg-cache"], ["npm_config_cache", ".npm"]]) {
      const configured = env[key] || (key === "npm_config_cache" ? env.NPM_CONFIG_CACHE : null);
      try { childEnv[key] = assertLocal(configured || path.join(os.homedir(), fallback), sourceRoot, env); }
      catch { childEnv[key] = path.join(scratch, fallback); }
    }
    delete childEnv.NPM_CONFIG_CACHE;
    await run(`scripts/build-${target === "mac" ? "mac-app" : "win"}.sh`, workspace, childEnv);
    assertSourcesMatch(sources, sourceSnapshot(sourceRoot));
    const output = publishRelease(sourceRoot, workspace, RELEASE_FILES[target]);
    const provenance = path.join(sourceRoot, "output", `last-${target === "win" ? "windows" : "mac"}-build.json`);
    fs.mkdirSync(path.dirname(provenance), { recursive: true });
    fs.writeFileSync(provenance, JSON.stringify({
      product: "Kobashi", version: JSON.parse(fs.readFileSync(path.join(sourceRoot, "package.json"), "utf8")).version,
      target, createdUTC: new Date().toISOString(), file: output, sha256: sha256(output),
      bytes: fs.statSync(output).size, sources, sourceUnchangedDuringBuild: true,
    }, null, 2) + "\n");
    log(`Done! ${output}`);
    return output;
  } finally {
    // This is exactly the unique directory created above, never the temp root.
    const resolved = fs.realpathSync(workspace);
    if (path.dirname(resolved) !== fs.realpathSync(tempRoot) || !path.basename(resolved).startsWith("kobashi-build-")) {
      throw new Error("Unexpected build cleanup path");
    }
    await fs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

if (require.main === module) buildLocal(process.argv[2]).catch(error => {
  console.error(error.message); process.exitCode = 1;
});
module.exports = { assertLocal, localTempRoot, buildLocal };
