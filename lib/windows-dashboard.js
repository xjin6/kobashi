"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path").win32;
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");

// Logical web content, excluding the browser's caption and window frame.
const DASHBOARD_SIZE = { width: 400, height: 576 };
const BROWSERS = [
  ["msedge.exe", "Microsoft\\Edge\\Application"],
  ["chrome.exe", "Google\\Chrome\\Application"],
  ["brave.exe", "BraveSoftware\\Brave-Browser\\Application"],
];

async function findWindowsDashboardBrowser({ env = process.env, exists = fs.existsSync, run = promisify(execFile) } = {}) {
  const roots = [...new Set([env["ProgramFiles(x86)"], env.ProgramFiles, env.ProgramW6432, env.LOCALAPPDATA].filter(Boolean))];
  const options = { encoding: "utf8", windowsHide: true, timeout: 2000 };
  for (const [name, installation] of BROWSERS) {
    for (const root of roots) {
      const file = path.join(root, installation, name);
      if (exists(file)) return file;
    }
  }
  for (const [name] of BROWSERS) {
    // App Paths also covers enterprise and custom installation directories.
    for (const [hive, view] of [["HKCU", "/reg:64"], ["HKLM", "/reg:64"], ["HKLM", "/reg:32"]]) {
      try {
        const key = hive + "\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\" + name;
        const { stdout } = await run("reg.exe", ["query", key, "/ve", view], options);
        const raw = stdout.match(/\bREG_(?:EXPAND_)?SZ\s+(.+)$/im)?.[1];
        const file = raw?.trim().replace(/^"(.*)"$/, "$1").replace(/%([^%]+)%/g, (match, key) => env[key] || match);
        if (file && path.isAbsolute(file) && path.basename(file).toLowerCase() === name && exists(file)) return file;
      } catch {}
    }
    try {
      const { stdout } = await run("where.exe", [name], options);
      const files = stdout.split(/\r?\n/).map(f => f.trim());
      const file = files.find(f => path.isAbsolute(f) && path.basename(f).toLowerCase() === name && exists(f));
      if (file) return file;
    } catch {}
  }
  return null;
}

// PowerShell hosts a short-lived Win32 helper. Its target is identified by the
// executable, the process's exact --user-data-dir argument, and the app title.
// Ordinary browser windows (including a tab titled Kobashi) are never touched.
const NATIVE = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class KobashiDashboard {
  public struct Rect {
    public int Left, Top, Right, Bottom;
    public int Width { get { return Right-Left; } }
    public int Height { get { return Bottom-Top; } }
  }
  [StructLayout(LayoutKind.Sequential)] struct MonitorInfo { public int Size; public Rect Screen, Work; public uint Flags; }
  delegate bool EnumWindow(IntPtr handle, IntPtr data);
  [DllImport("user32")] static extern bool EnumWindows(EnumWindow cb, IntPtr data);
  [DllImport("user32")] static extern bool EnumChildWindows(IntPtr parent, EnumWindow cb, IntPtr data);
  [DllImport("user32")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
  [DllImport("user32")] static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr handle, StringBuilder name, int size);
  [DllImport("user32", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr handle, StringBuilder name, int size);
  [DllImport("user32")] static extern bool GetWindowRect(IntPtr handle, out Rect r);
  [DllImport("user32")] static extern IntPtr MonitorFromWindow(IntPtr handle, uint flags);
  [DllImport("user32", CharSet=CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
  [DllImport("user32")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
  [DllImport("user32")] static extern bool SetProcessDPIAware();
  [DllImport("user32")] static extern uint GetDpiForWindow(IntPtr handle);
  [DllImport("shcore")] static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint x, out uint y);
  [DllImport("user32")] static extern bool IsZoomed(IntPtr handle);
  [DllImport("user32")] static extern bool IsIconic(IntPtr handle);
  [DllImport("user32")] static extern bool ShowWindowAsync(IntPtr handle, int mode);
  [DllImport("user32")] static extern bool SetWindowPos(IntPtr handle, IntPtr order, int x, int y, int w, int h, uint flags);
  [DllImport("user32")] public static extern bool SetForegroundWindow(IntPtr handle);
  public static void UsePhysicalPixels() {
    try { if (SetThreadDpiAwarenessContext(new IntPtr(-4)) != IntPtr.Zero) return; } catch (EntryPointNotFoundException) {}
    SetProcessDPIAware();
  }
  static string Class(IntPtr h) { var s=new StringBuilder(128); GetClassName(h,s,s.Capacity); return s.ToString(); }
  public static IntPtr Find(uint pid) {
    IntPtr found=IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr unused) {
      uint owner; GetWindowThreadProcessId(h,out owner);
      if (owner!=pid || !IsWindowVisible(h) || Class(h)!="Chrome_WidgetWin_1") return true;
      var name=new StringBuilder(256); GetWindowText(h,name,name.Capacity);
      string t=name.ToString().Replace("\u200b","");
      if (t!="Kobashi" && !System.Text.RegularExpressions.Regex.IsMatch(t,@"^Kobashi [-–—] (Microsoft Edge|Google Chrome|Brave)$")) return true;
      found=h; return false;
    },IntPtr.Zero);
    return found;
  }
  public static void Restore(IntPtr h) {
    if (IsIconic(h) || IsZoomed(h)) ShowWindowAsync(h,9); // SW_RESTORE
  }
  static bool CredibleViewport(Rect outer, Rect content, double scale) {
    int dx=outer.Width-content.Width, dy=outer.Height-content.Height;
    // Renderer placeholders and docked DevTools also have this window class.
    // Treat only plausible app-mode borders/caption as window decoration.
    return content.Width>0 && content.Height>0 && dx>=0 && dy>=0 && dx<=48*scale && dy<=96*scale;
  }
  public static Rect Target(Rect outer, Rect content, Rect work, double scale, int width, int height) {
    bool measured=CredibleViewport(outer,content,scale);
    int w=(int)Math.Round(width*scale)+(measured ? outer.Width-content.Width : (int)Math.Round(16*scale));
    int h=(int)Math.Round(height*scale)+(measured ? outer.Height-content.Height : (int)Math.Round(40*scale));
    w=Math.Min(w,work.Width); h=Math.Min(h,work.Height);
    int x=Math.Max(work.Left,Math.Min(outer.Left,work.Right-w));
    int y=Math.Max(work.Top,Math.Min(outer.Top,work.Bottom-h));
    return new Rect { Left=x, Top=y, Right=x+w, Bottom=y+h };
  }
  public static bool Fit(IntPtr h, int width, int height) {
    Rect outer; if (!GetWindowRect(h,out outer) || IsZoomed(h) || IsIconic(h)) return false;
    IntPtr monitor=MonitorFromWindow(h,2);
    var info=new MonitorInfo(); info.Size=Marshal.SizeOf(info);
    if (!GetMonitorInfo(monitor,ref info)) return false;
    uint dpi=96;
    try { dpi=GetDpiForWindow(h); } catch (EntryPointNotFoundException) {
      uint x,y; if (GetDpiForMonitor(monitor,0,out x,out y)==0) dpi=x;
    }
    double scale=(dpi>0 ? dpi : 96)/96.0;
    Rect content=new Rect();
    EnumChildWindows(h,delegate(IntPtr child, IntPtr unused) {
      Rect r;
      if (Class(child)=="Chrome_RenderWidgetHostHWND" && IsWindowVisible(child) && GetWindowRect(child,out r) &&
          r.Width>0 && r.Height>0 && r.Width<=outer.Width && r.Height<=outer.Height &&
          (long)r.Width*r.Height>(long)content.Width*content.Height) content=r;
      return true;
    },IntPtr.Zero);
    // Chromium places the renderer HWND at the actual web viewport. If a build
    // does not expose it, use the app window frame estimate from the launch flags.
    Rect target=Target(outer,content,info.Work,scale,width,height);
    if (!outer.Equals(target)) {
      SetWindowPos(h,IntPtr.Zero,target.Left,target.Top,target.Width,target.Height,0x4014); // ASYNCWINDOWPOS | NOACTIVATE | NOZORDER
      return false;
    }
    return CredibleViewport(outer,content,scale);
  }
}`;

const CONTROL = String.raw`
$ErrorActionPreference = 'Stop'
$cfg = ConvertFrom-Json $env:KOBASHI_DASHBOARD
Remove-Item Env:KOBASHI_DASHBOARD
Add-Type -TypeDefinition @'
${NATIVE}
'@
[KobashiDashboard]::UsePhysicalPixels()
$p = [regex]::Escape($cfg.profile)
$profileArg = '(?:^|\s)(?:"--user-data-dir='+$p+'"|--user-data-dir="'+$p+'"|--user-data-dir='+$p+')(?=\s|$)'
$name = [IO.Path]::GetFileName($cfg.browser)
function Get-OwnedWindow {
  $rows = Get-CimInstance Win32_Process -Filter "Name='$name'" -ErrorAction Stop
  foreach ($row in $rows) {
    if ($row.ExecutablePath -ine $cfg.browser -or $row.CommandLine -notmatch $profileArg -or $row.CommandLine -match '(?:^|\s)--type=') { continue }
    $handle = [KobashiDashboard]::Find([uint32]$row.ProcessId)
    if ($handle -ne [IntPtr]::Zero) { return [pscustomobject]@{ Handle=$handle; Owner=[uint32]$row.ProcessId } }
  }
  return $null
}
$window = Get-OwnedWindow
if (!$window) {
  if ($cfg.existingPage) { return }
  # Quote complete switches. Their only variable path is a Windows directory
  # (double quotes cannot occur in a directory name). No cmd.exe is involved.
  $argsLine = ($cfg.args | ForEach-Object { '"'+$_+'"' }) -join ' '
  Start-Process -FilePath $cfg.browser -ArgumentList $argsLine -WindowStyle Normal
  Write-Output 'launched'
  $deadline = [DateTime]::UtcNow.AddSeconds(9)
  do {
    Start-Sleep -Milliseconds 180
    $window = Get-OwnedWindow
  } while (!$window -and [DateTime]::UtcNow -lt $deadline)
}
if ($window) {
  [KobashiDashboard]::Restore($window.Handle)
  # Wait briefly for restore, the renderer, or a pending cross-monitor DPI change.
  for ($i=0; $i -lt 8; $i++) {
    if ([KobashiDashboard]::Find($window.Owner) -ne $window.Handle) { return }
    if ([KobashiDashboard]::Fit($window.Handle,$cfg.width,$cfg.height)) { break }
    Start-Sleep -Milliseconds 100
  }
  if ([KobashiDashboard]::Find($window.Owner) -eq $window.Handle) {
    [void][KobashiDashboard]::SetForegroundWindow($window.Handle)
  }
}
`;

function spawnDetached(program, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { detached: true, stdio: "ignore", windowsHide: false });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

function createWindowsDashboard({ env = process.env, home = os.homedir(), discover = findWindowsDashboardBrowser,
  execute = promisify(execFile), launch = spawnDetached, pageAlive = () => false, now = Date.now } = {}) {
  let pending, presentedAt = -Infinity;
  async function open(url) {
    const browser = await discover({ env });
    const existingPage = Number.isFinite(presentedAt) && (now() - presentedAt < 2500 || pageAlive());
    if (!browser) {
      // The system default can be a user's normal browser. Leave its size and
      // active tabs alone; open the URL only if the previous dashboard is gone.
      if (!existingPage) await launch("rundll32.exe", ["url.dll,FileProtocolHandler", url]);
      if (!existingPage) presentedAt = now();
      return;
    }
    const local = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const profile = path.join(local, "Kobashi", "Dashboard", path.basename(browser, ".exe").toLowerCase());
    const { width, height } = DASHBOARD_SIZE;
    const args = ["--user-data-dir="+profile, "--app="+url, `--window-size=${width+16},${height+40}`,
      "--no-first-run", "--no-default-browser-check", "--disable-background-mode", "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"];
    try {
      await execute("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
        Buffer.from(CONTROL, "utf16le").toString("base64")], { windowsHide: true, timeout: 18000, encoding: "utf8",
        env: { ...env, KOBASHI_DASHBOARD: JSON.stringify({ browser, profile, args, width, height, existingPage }) } });
    } catch (err) {
      // Restricted PowerShell/CIM: keep the isolated Chromium app-mode route.
      // A late helper failure must not launch a second copy of the same window.
      if (!/^launched\r?$/m.test(String(err.stdout || "")) && !existingPage) await launch(browser, args);
    }
    if (!existingPage) presentedAt = now();
  }
  return { open(url) {
    if (!pending) pending = open(url).finally(() => { pending = null; });
    return pending;
  } };
}

module.exports = { createWindowsDashboard, findWindowsDashboardBrowser, DASHBOARD_SIZE };
