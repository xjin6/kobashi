const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const { createWindowsDashboard, findWindowsDashboardBrowser, DASHBOARD_SIZE } = require("../lib/windows-dashboard");

const url = "http://127.0.0.1:18922";
const local = "C:\\Users\\Example Person\\AppData\\Local";
const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const env = { LOCALAPPDATA: local, "ProgramFiles(x86)": "C:\\Program Files (x86)", ProgramFiles: "C:\\Program Files" };

test("discovers machine or user Chromium installs, including Brave, and custom App Paths without desktop shortcuts", async () => {
  for (const file of [edge, local+"\\Microsoft\\Edge\\Application\\msedge.exe", local+"\\Google\\Chrome\\Application\\chrome.exe",
    local+"\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"]) {
    assert.equal(await findWindowsDashboardBrowser({ env, exists: p => p === file,
      run: () => assert.fail("registry not needed for a known installation") }), file);
  }
  const browser = "D:\\Enterprise Apps\\edge\\msedge.exe";
  const run = async (exe, args, options) => {
    assert.equal(options.windowsHide, true);
    if (exe === "reg.exe" && args[1].startsWith("HKLM") && args[1].endsWith("msedge.exe") && args.includes("/reg:32")) {
      return { stdout: '    (Default)    REG_EXPAND_SZ    "%CustomApps%\\edge\\msedge.exe"\r\n' };
    }
    throw Error("not registered");
  };
  assert.equal(await findWindowsDashboardBrowser({ env: { ...env, CustomApps: "D:\\Enterprise Apps" },
    exists: p => p === browser, run }), browser);
});

async function captureHelper() {
  let captured;
  const controller = createWindowsDashboard({ env, discover: () => edge,
    execute: async (command, args, options) => { captured = { command, args, options }; },
    launch: () => assert.fail("unexpected fallback") });
  await controller.open(url);
  return captured;
}

test("overlapping opens share the same bounded helper and subsequent opens reuse the app's private browser profile", async () => {
  const calls = [];
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const controller = createWindowsDashboard({ env, discover: () => edge, pageAlive: () => true,
    execute: async (...args) => { calls.push(args); await hold; },
    launch: () => assert.fail("unexpected fallback") });
  const first = controller.open(url);
  assert.equal(first, controller.open(url));
  release(); await first;
  await controller.open(url);
  assert.equal(calls.length, 2);
  const payloads = calls.map(([exe, args, opts]) => {
    assert.equal(exe, "powershell.exe");
    assert.ok(args.includes("-NonInteractive") && args.includes("-EncodedCommand"));
    assert.ok(args.at(-1).length < 30000 && !args.includes(edge));
    assert.equal(opts.windowsHide, true);
    return JSON.parse(opts.env.KOBASHI_DASHBOARD);
  });
  assert.equal(payloads[0].profile, local+"\\Kobashi\\Dashboard\\msedge");
  assert.equal(payloads[0].profile, payloads[1].profile);
  assert.deepEqual(payloads.map(v => v.existingPage), [false, true]);
  assert.deepEqual([payloads[0].width, payloads[0].height], [400,576]);
  assert.ok(payloads[0].args.includes("--user-data-dir="+payloads[0].profile));
  assert.ok(payloads[0].args.includes("--app="+url));
  assert.ok(payloads[0].args.includes("--window-size=416,616"));
  assert.doesNotMatch(payloads[0].args.join(" "), /remote-debugging|start-maximized|start-fullscreen/);
});

test("restricted PowerShell retains a separate app window and a late helper failure never launches it twice", async () => {
  const launches = [];
  const controller = createWindowsDashboard({ env, discover: () => edge,
    execute: async () => { throw Error("blocked"); }, launch: async (...args) => launches.push(args) });
  await controller.open(url);
  await controller.open(url);
  assert.equal(launches.length, 1);
  assert.equal(launches[0][0], edge);
  assert.ok(launches[0][1].includes("--user-data-dir="+local+"\\Kobashi\\Dashboard\\msedge"));
  const started = createWindowsDashboard({ env, discover: () => edge,
    execute: async () => { throw Object.assign(Error("timeout"), { stdout: "launched\r\n" }); },
    launch: () => assert.fail("a browser was already launched") });
  await started.open(url);
});

test("a missing supported browser opens the system URL without resizing or focusing its windows, and avoids extra live tabs", async () => {
  let time = 0, alive = false;
  const launches = [];
  const controller = createWindowsDashboard({ env, discover: () => null, now: () => time, pageAlive: () => alive,
    execute: () => assert.fail("must not control the general-purpose browser"), launch: async (...args) => launches.push(args) });
  await controller.open(url);
  await controller.open(url);
  time += 10000; alive = true; await controller.open(url);
  assert.deepEqual(launches, [["rundll32.exe", ["url.dll,FileProtocolHandler", url]]]);
  time += 10000; alive = false; await controller.open(url);
  assert.equal(launches.length, 2);
});

// The exact controller compiled by Windows PowerShell can also be checked on
// macOS/Linux with an opt-in PowerShell binary. No real windows are changed.
const ps = process.env.KOBASHI_TEST_POWERSHELL || (process.platform === "win32" && "powershell.exe");
function runPowerShell(source, env) {
  return execFileSync(ps, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(source, "utf16le").toString("base64")], { windowsHide: true, encoding: "utf8", timeout: 20000,
    env: { ...process.env, ...env, POWERSHELL_TELEMETRY_OPTOUT: "1", POWERSHELL_UPDATECHECK: "Off" } });
}

test("the actual PowerShell focus logic skips personal, sibling and renderer processes with a similar dashboard title", { skip: !ps }, async () => {
  const { args, options } = await captureHelper();
  const payload = JSON.parse(options.env.KOBASHI_DASHBOARD);
  const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
  const fixture = `using System;
public static class KobashiDashboard {
  public static void UsePhysicalPixels() {}
  public static IntPtr Find(uint p) { Console.WriteLine("inspect:"+p); return (IntPtr)p; }
  public static void Restore(IntPtr h) { Console.WriteLine("restore:"+h); }
  public static bool Fit(IntPtr h,int w,int t) { Console.WriteLine("size:"+h+":"+w+"x"+t); return true; }
  public static bool SetForegroundWindow(IntPtr h) { Console.WriteLine("focus:"+h); return true; }
}`;
  const control = script.replace(/(Add-Type -TypeDefinition @'\r?\n)[\s\S]+?(\r?\n'@)/, "$1"+fixture+"$2");
  const stubs = `function Get-CimInstance { ConvertFrom-Json $env:KOBASHI_TEST_ROWS }
function Start-Process { throw "Unexpected second window" }
`;
  const prefix = "--user-data-dir="+payload.profile;
  const rows = [
    { ProcessId: 10, ExecutablePath: edge, CommandLine: 'msedge.exe --app='+url },
    { ProcessId: 11, ExecutablePath: edge, CommandLine: 'msedge.exe "'+prefix+'-other"' },
    { ProcessId: 12, ExecutablePath: edge, CommandLine: 'msedge.exe "'+prefix+'" --type=renderer' },
    { ProcessId: 13, ExecutablePath: local+"\\other\\msedge.exe", CommandLine: 'msedge.exe "'+prefix+'"' },
    { ProcessId: 14, ExecutablePath: edge, CommandLine: 'msedge.exe "'+prefix+'" --app='+url },
  ];
  const out = runPowerShell(stubs+control, { KOBASHI_DASHBOARD: options.env.KOBASHI_DASHBOARD, KOBASHI_TEST_ROWS: JSON.stringify(rows) });
  assert.match(out, /restore:14/);
  assert.match(out, /size:14:400x576/);
  assert.match(out, /focus:14/);
  assert.doesNotMatch(out, /inspect:1[0-3]\b/);
});

test("the actual native controller parses, compiles and sizes viewports at different DPI/work areas", { skip: !ps }, async () => {
  const { args } = await captureHelper();
  const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
  const native = script.match(/Add-Type -TypeDefinition @'\r?\n([\s\S]+?)\r?\n'@/)[1];
  const proof = `
$ErrorActionPreference='Stop'
$tokens=$null; $parseErrors=$null
[void][System.Management.Automation.Language.Parser]::ParseInput($env:KOBASHI_TEST_CONTROL,[ref]$tokens,[ref]$parseErrors)
if ($parseErrors.Count) { throw $parseErrors[0] }
Add-Type -TypeDefinition $env:KOBASHI_TEST_NATIVE
function Rect($l,$t,$r,$b) {
  $rect = New-Object 'KobashiDashboard+Rect'
  $rect.Left=$l; $rect.Top=$t; $rect.Right=$r; $rect.Bottom=$b; return $rect
}
$rows = foreach ($s in (ConvertFrom-Json $env:KOBASHI_TEST_DIMENSIONS)) {
  $a=$s.outer; $b=$s.content; $c=$s.work
  $r=[KobashiDashboard]::Target((Rect $a[0] $a[1] $a[2] $a[3]),(Rect $b[0] $b[1] $b[2] $b[3]),
    (Rect $c[0] $c[1] $c[2] $c[3]), $s.scale, ${DASHBOARD_SIZE.width}, ${DASHBOARD_SIZE.height})
  [pscustomobject]@{x=$r.Left;y=$r.Top;w=$r.Width;h=$r.Height}
}
ConvertTo-Json -InputObject @($rows) -Compress`;
  const scenarios = [
    { outer: [0,0,1920,1040], content: [0,0,1904,1000], work: [0,0,1920,1040], scale: 1 },
    // A negative monitor origin and taskbar constrain both position and dimensions.
    { outer: [-400,480,600,1280], content: [0,0,976,740], work: [-1920,0,0,1080], scale: 1.5 },
    { outer: [0,0,1920,1040], content: [2,2,3,3], work: [0,0,1920,1040], scale: 1 },
    { outer: [0,0,1800,1050], content: [0,0,1300,700], work: [0,0,1920,1080], scale: 1.5 },
    { outer: [50,50,750,900], content: [0,0,0,0], work: [0,0,540,720], scale: 1.5 },
  ];
  const result = runPowerShell(proof, { KOBASHI_TEST_CONTROL: script, KOBASHI_TEST_NATIVE: native,
    KOBASHI_TEST_DIMENSIONS: JSON.stringify(scenarios) });
  assert.deepEqual(JSON.parse(result.replace(/^\uFEFF/,"")), [
    {x:0,y:0,w:416,h:616}, {x:-624,y:156,w:624,h:924}, {x:0,y:0,w:416,h:616},
    {x:0,y:0,w:624,h:924}, {x:0,y:0,w:540,h:720},
  ]);
});
