"use strict";

const path = require("node:path").win32;

// Query the exact desktop package, not ChatGPT or the Codex runtime packages.
// The Store executable is currently named ChatGPT.exe; codex.exe on PATH is
// only the CLI and must never be used to open the desktop.
const WINDOWS_DISCOVERY = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$apps = @()
try {
  foreach ($package in @(Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending)) {
    $manifest = Get-AppxPackageManifest -Package $package.PackageFullName
    foreach ($app in @($manifest.Package.Applications.Application)) {
      if ([IO.Path]::GetFileName([string]$app.Executable) -notmatch '^(ChatGPT|Codex)\.exe$') { continue }
      $executable = Join-Path $package.InstallLocation ([string]$app.Executable)
      if (Test-Path -LiteralPath $executable -PathType Leaf) {
        $apps += [pscustomobject]@{ executable = $executable; appId = $package.PackageFamilyName + '!' + $app.Id }
      }
    }
  }
} catch {
  # A standalone installation can still be used when AppX discovery is absent.
}
ConvertTo-Json -InputObject $apps -Compress
`;

const WINDOWS_PROCESSES = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$rows = @(Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe' OR Name = 'Codex.exe'" |
  Where-Object { $_.ExecutablePath -and $_.CommandLine -notmatch '(?:^|\s)--type(?:=|\s)' } |
  ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; executable = $_.ExecutablePath } })
ConvertTo-Json -InputObject $rows -Compress
`;

// All paths/IDs are passed as data through the child environment, never inserted
// into PowerShell source. Store activation retains package identity and reuses
// its existing window, like opening Codex from the Windows Start menu.
const WINDOWS_ACTIVATE = String.raw`
$ErrorActionPreference = 'Stop'
$target = ConvertFrom-Json $env:KOBASHI_CODEX_LAUNCH_TARGET
Remove-Item Env:KOBASHI_CODEX_LAUNCH_TARGET
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IApplicationActivationManager {
  [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appId,
    [MarshalAs(UnmanagedType.LPWStr)] string arguments, uint options, out uint processId);
}
[ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
class ApplicationActivationManager { }
public static class KobashiDesktopActivation {
  public static void OpenStore(string appId) {
    var manager = (IApplicationActivationManager)new ApplicationActivationManager();
    try { uint pid; Marshal.ThrowExceptionForHR(manager.ActivateApplication(appId, "", 0, out pid)); }
    finally { Marshal.ReleaseComObject(manager); }
  }
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr handle, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
}
'@
if ($target.appId) {
  [KobashiDesktopActivation]::OpenStore($target.appId)
} else {
  $window = $null
  if ($target.pid) {
    $process = Get-Process -Id $target.pid -ErrorAction SilentlyContinue
    if ($process -and $process.Path -eq $target.executable) { $window = $process.MainWindowHandle }
  }
  if ($window -and $window -ne [IntPtr]::Zero) {
    if ([KobashiDesktopActivation]::IsIconic($window)) {
      [void][KobashiDesktopActivation]::ShowWindowAsync($window, 9)
    }
    [void][KobashiDesktopActivation]::SetForegroundWindow($window)
  } else {
    # This is the user-requested visible desktop, not a background helper.
    Start-Process -FilePath $target.executable -WorkingDirectory (Split-Path -Parent $target.executable)
  }
}
`;

function failure(code) { return Object.assign(new Error(code), { code }); }
function sameExecutable(left, right) {
  const normalize = value => path.normalize(String(value || "").replace(/^\\\\\?\\/, "")).toLowerCase();
  return normalize(left) === normalize(right);
}

function installedDesktops(env, userHome, exists) {
  const local = env.LOCALAPPDATA || path.join(userHome, "AppData", "Local");
  const roots = [path.join(local, "Programs", "OpenAI", "Codex"), path.join(local, "Programs", "Codex"),
    ...[env.ProgramFiles, env["ProgramFiles(x86)"]].filter(Boolean).map(root => path.join(root, "OpenAI", "Codex"))];
  return roots.flatMap(root => ["Codex.exe", "ChatGPT.exe", "app/Codex.exe", "app/ChatGPT.exe"]
    .map(file => path.join(root, file))).filter(exists).map(executable => ({ executable }));
}

async function launchWindowsCodex({ execute, exists, userHome, codexHome, nativeAccount,
  env = process.env, wait, now, startupTimeoutMs }) {
  async function powershell(script, childEnv = env) {
    const result = await execute("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024, env: childEnv,
    });
    return typeof result === "string" ? result : result.stdout || "";
  }
  async function readArray(script) {
    const data = JSON.parse((await powershell(script)).replace(/^\uFEFF/, ""));
    if (!Array.isArray(data)) throw failure("launch_failed");
    return data;
  }
  const store = (await readArray(WINDOWS_DISCOVERY)).filter(app =>
    typeof app.appId === "string" && /^OpenAI\.Codex_[A-Za-z0-9]+![A-Za-z0-9._-]+$/.test(app.appId) &&
    typeof app.executable === "string" && path.isAbsolute(app.executable) &&
    /^(ChatGPT|Codex)\.exe$/i.test(path.basename(app.executable)) && exists(app.executable));
  const desktops = [...store, ...installedDesktops(env, userHome, exists)];
  if (!desktops.length) throw failure("desktop_not_found");
  const processes = await readArray(WINDOWS_PROCESSES);
  const matching = (rows, desktop) => rows.filter(row => Number.isSafeInteger(row.pid) && row.pid > 0 &&
    sameExecutable(row.executable, desktop.executable));
  const desktop = desktops.find(app => matching(processes, app).length) || desktops[0];
  const before = matching(processes, desktop);
  const childEnv = { ...env };
  // Store activation uses Windows' registered application environment. For an
  // unpackaged desktop we can also pass the configured home to this launch.
  if (!desktop.appId) {
    Object.assign(childEnv, { CODEX_HOME: codexHome, CODEX_CLI_PATH: "", CODEX_APP_SERVER_WS_URL: "",
      CODEX_APP_SERVER_USE_LOCAL_DAEMON: "0", CODEX_APP_SERVER_FORCE_CLI: "", NO_PROXY: "127.0.0.1,localhost" });
    if (nativeAccount()) {
      childEnv.OPENAI_API_KEY = "";
      childEnv.OPENAI_BASE_URL = "";
    }
  }
  childEnv.KOBASHI_CODEX_LAUNCH_TARGET = JSON.stringify({ ...desktop, pid: before[0]?.pid || null });
  await powershell(WINDOWS_ACTIVATE, childEnv);
  const deadline = now() + startupTimeoutMs;
  do {
    const after = matching(await readArray(WINDOWS_PROCESSES), desktop);
    if (after.length) return { state: after.some(row => before.some(old => old.pid === row.pid)) ? "already_running" : "opened" };
    if (now() >= deadline) break;
    await wait(200);
  } while (true);
  throw failure("launch_pending");
}

module.exports = { launchWindowsCodex, WINDOWS_DISCOVERY, WINDOWS_PROCESSES, WINDOWS_ACTIVATE };
