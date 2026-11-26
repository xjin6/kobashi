"use strict";

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const windowsPath = require("node:path").win32;

const BUNDLE_ID = "com.anthropic.claudefordesktop";
const CLAUDE_LAUNCH_ERRORS = new Set(["unsupported_platform", "desktop_not_found", "launch_failed", "launch_pending"]);

// Anthropic.Claude's Windows distribution includes MSIX (this exact publisher
// family) and a per-user Squirrel installation with product code AnthropicClaude.
// Activate the ordinary desktop just as its Start menu entry does.
const WINDOWS_OPEN_CLAUDE = String.raw`
$ErrorActionPreference = 'Stop'
$storeId = $null
$storeExe = $null
try {
  $package = Get-AppxPackage -Name Claude | Where-Object PackageFamilyName -eq 'Claude_pzs8sxrjxfjjc' | Select-Object -First 1
  if ($package) {
    $manifest = Get-AppxPackageManifest -Package $package.PackageFullName
    foreach ($app in @($manifest.Package.Applications.Application)) {
      if ([IO.Path]::GetFileName([string]$app.Executable) -ne 'Claude.exe') { continue }
      $exe = Join-Path $package.InstallLocation ([string]$app.Executable)
      if (Test-Path -LiteralPath $exe -PathType Leaf) {
        $storeId = $package.PackageFamilyName + '!' + $app.Id
        $storeExe = $exe
        break
      }
    }
  }
} catch {
  # Older Windows installations may only provide the standalone client.
}
$root = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'AnthropicClaude'
$desktopExes = @(
  $stub = Join-Path $root 'Claude.exe'
  if (Test-Path -LiteralPath $stub -PathType Leaf) { $stub }
  Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
    Where-Object Name -Match '^app-[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?$' |
    Sort-Object { [version]$_.Name.Substring(4) } -Descending |
    ForEach-Object {
      $exe = Join-Path $_.FullName 'Claude.exe'
      if (Test-Path -LiteralPath $exe -PathType Leaf) { $exe }
    }
)
if (!$storeId -and !$desktopExes.Count) { 'desktop_not_found'; return }
function DesktopWindows($paths) {
  Get-Process -Name Claude -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $paths -contains $_.Path -and $_.MainWindowHandle -ne [IntPtr]::Zero }
}
$standaloneWindow = @(DesktopWindows $desktopExes)
$storeWindow = @(if ($storeId) { DesktopWindows @($storeExe) })
if ($storeId -and ($storeWindow.Count -or !$standaloneWindow.Count)) {
  $before = $storeWindow
  $paths = @($storeExe)
  $item = (New-Object -ComObject Shell.Application).NameSpace('shell:AppsFolder').ParseName($storeId)
  if (!$item) { 'launch_failed'; return }
  $item.InvokeVerb()
} else {
  $before = $standaloneWindow
  $paths = $desktopExes
  $exe = if ($before.Count) { $before[0].Path } else { $desktopExes[0] }
  Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe)
}
$deadline = [DateTime]::UtcNow.AddSeconds(7)
do {
  $after = @(DesktopWindows $paths)
  if ($after.Count) {
    if (@($after | Where-Object { $before.Id -contains $_.Id }).Count) { 'already_running' } else { 'opened' }
    return
  }
  Start-Sleep -Milliseconds 200
} while ([DateTime]::UtcNow -lt $deadline)
'launch_pending'
`;

function failure(code) { return Object.assign(new Error(code), { code }); }

function createClaudeDesktopLauncher({
  platform = process.platform, execute = promisify(execFile), wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now, startupTimeoutMs = 7000, windowsRoot = process.env.SystemRoot || "C:\\Windows",
} = {}) {
  let pending = null;
  async function run(file, args, timeout = 3500) {
    const result = await execute(file, args, { encoding: "utf8", windowsHide: true, timeout, maxBuffer: 128 * 1024 });
    return (typeof result === "string" ? result : result.stdout || "").trim();
  }
  async function macInstances() {
    const names = await run("/usr/bin/lsappinfo", ["-nonames", "find", "-bundleid", BUNDLE_ID]);
    return names.match(/ASN:0x[\da-f]+-0x[\da-f]+:/gi) || [];
  }
  async function open() {
    if (platform === "win32") {
      const powershell = windowsPath.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const result = await run(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_OPEN_CLAUDE], 12500);
      if (result === "opened" || result === "already_running") return { state: result };
      throw failure(CLAUDE_LAUNCH_ERRORS.has(result) ? result : "launch_failed");
    }
    if (platform !== "darwin") throw failure("unsupported_platform");
    const before = await macInstances();
    try {
      await run("/usr/bin/open", ["-b", BUNDLE_ID]);
    } catch (error) {
      if (/Unable to find application with bundle identifier|kLSApplicationNotFoundErr|-10814/i.test(String(error.stderr))) {
        throw failure("desktop_not_found");
      }
      throw error;
    }
    const deadline = now() + startupTimeoutMs;
    do {
      const after = await macInstances();
      if (after.length) return { state: after.some(asn => before.includes(asn)) ? "already_running" : "opened" };
      if (now() >= deadline) break;
      await wait(200);
    } while (true);
    throw failure("launch_pending");
  }
  return {
    supported: platform === "darwin" || platform === "win32",
    open() {
      if (!pending) {
        pending = open().catch(error => {
          throw failure(CLAUDE_LAUNCH_ERRORS.has(error.code) ? error.code : "launch_failed");
        }).finally(() => { pending = null; });
      }
      return pending;
    },
  };
}

module.exports = { createClaudeDesktopLauncher, CLAUDE_LAUNCH_ERRORS };
