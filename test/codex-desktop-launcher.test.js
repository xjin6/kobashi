"use strict";
const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { parseSystemProxy, openArguments, createCodexDesktopLauncher, createCodexOpenHandler } = require("../lib/codex-desktop-launcher");

const PROXY = '<dictionary> {\n HTTPEnable : 1\n HTTPProxy : 127.0.0.1\n HTTPPort : 1089\n HTTPSEnable : 1\n HTTPSProxy : 127.0.0.1\n HTTPSPort : 1089\n SOCKSEnable : 1\n SOCKSProxy : 127.0.0.1\n SOCKSPort : 1080\n}';
function fixture(options = {}) {
  const calls = [], appPath = "/Applications/ChatGPT.app", executable = appPath + "/Contents/MacOS/ChatGPT";
  let pids = options.running ? [100] : [], clock = 0;
  const launcher = createCodexDesktopLauncher({ platform: options.platform || "darwin", codexHome: "/fixture/.codex",
    userHome: "/fixture", nativeAccount: () => options.native !== false,
    exists: file => options.missing ? false : file.endsWith("app-server-control.sock") ? !!options.shared :
      file === appPath + "/Contents/Info.plist" || file === executable,
    now: () => clock, startupTimeoutMs: 400,
    wait: async ms => { clock += ms; await options.wait?.(); if (options.appearAfterWait) pids = [200]; },
    execute: async (command, args) => {
      calls.push({ command, args });
      if (command === "/usr/bin/plutil") return { stdout: JSON.stringify({CFBundleIdentifier:"com.openai.codex",CFBundleExecutable:"ChatGPT"}) };
      if (command === "/bin/ps") return { stdout: pids.map(pid => `${pid} ${executable}`).join("\n") };
      if (command === "/usr/sbin/scutil") return { stdout: options.proxy ?? PROXY };
      if (command === "/usr/bin/open") {
        if (options.openError) throw Error("private launch detail");
        if (!pids.length && !options.appearAfterWait && !options.neverAppears) pids = [200];
        return { stdout: "" };
      }
      throw Error("Unexpected command: " + command);
    },
  });
  return { launcher, calls };
}

test("system proxy parsing preserves endpoint scope and rejects malformed or PAC-only settings", () => {
  assert.deepEqual(parseSystemProxy(PROXY), {HTTP_PROXY:"http://127.0.0.1:1089",HTTPS_PROXY:"http://127.0.0.1:1089",ALL_PROXY:"socks5h://127.0.0.1:1080"});
  assert.deepEqual(parseSystemProxy('HTTPEnable : 0\nHTTPProxy : 127.0.0.1\nHTTPPort : 1089'), {});
  assert.equal(parseSystemProxy('HTTPEnable : 1\nHTTPProxy : ::1\nHTTPPort : 1089').HTTP_PROXY,"http://[::1]:1089");
  for (const text of ['HTTPEnable : 1', PROXY.replace('HTTPPort : 1089','HTTPPort : 99999'),
    PROXY.replace('HTTPProxy : 127.0.0.1','HTTPProxy : user:secret@host'), 'ProxyAutoConfigEnable : 1']) {
    assert.throws(() => parseSystemProxy(text), {code:"proxy_settings_unavailable"});
  }
});

test("proxy variables are scoped to the official launch and shared overrides are cleared", async () => {
  const f = fixture();
  assert.deepEqual(await f.launcher.open(), {state:"opened"});
  const call = f.calls.find(call => call.command === "/usr/bin/open");
  assert.equal(call.args.at(-1), "/Applications/ChatGPT.app");
  assert.equal(call.args.includes("-n"), false);
  for (const value of ['HTTP_PROXY=http://127.0.0.1:1089','http_proxy=http://127.0.0.1:1089',
    'HTTPS_PROXY=http://127.0.0.1:1089','https_proxy=http://127.0.0.1:1089',
    'ALL_PROXY=socks5h://127.0.0.1:1080','all_proxy=socks5h://127.0.0.1:1080',
    'NO_PROXY=127.0.0.1,localhost','CODEX_CLI_PATH=','CODEX_APP_SERVER_USE_LOCAL_DAEMON=0','OPENAI_API_KEY=','OPENAI_BASE_URL=']) assert.ok(call.args.includes(value), value);
  assert.ok(f.calls.every(call => !call.command.includes("launchctl")));
});

test("disabled proxy types clear stale per-app values without changing legacy bridge credentials", () => {
  const args = openArguments({appPath:"/Applications/ChatGPT.app",codexHome:"/fixture/.codex",userHome:"/fixture",proxies:{},nativeAccount:false});
  for (const value of ['HTTP_PROXY=','http_proxy=','HTTPS_PROXY=','https_proxy=','ALL_PROXY=','all_proxy=']) assert.ok(args.includes(value));
  assert.equal(args.some(value => value.startsWith('OPENAI_API_KEY=')),false);
  assert.equal(args.some(value => value.startsWith('OPENAI_BASE_URL=')),false);
});

test("existing desktop is activated without restarting and repeated pending opens share one launch", async () => {
  const existing = fixture({running:true});
  assert.deepEqual(await existing.launcher.open(),{state:"already_running"});
  assert.equal(existing.calls.filter(call => call.command==='/usr/bin/open').length,1);
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const f=fixture({appearAfterWait:true,wait:()=>gate});
  const first=f.launcher.open(),second=f.launcher.open();
  assert.equal(first,second);
  await new Promise(setImmediate);
  assert.equal(f.calls.filter(call=>call.command==='/usr/bin/open').length,1);
  release();assert.deepEqual(await first,{state:'opened'});
});

test("unsupported platform, absent app, old shared backend and pending launch remain safe errors", async () => {
  for(const [options,code] of [[{platform:'linux'},'unsupported_platform'],[{missing:true},'desktop_not_found'],
    [{shared:true},'shared_backend_running'],[{proxy:'HTTPEnable : 1'},'proxy_settings_unavailable'],
    [{openError:true},'launch_failed'],[{neverAppears:true},'launch_pending']]) {
    const f=fixture(options);await assert.rejects(f.launcher.open(),{code});
    assert.ok(f.calls.every(call=>!/(?:kill|launchctl)/.test(call.command)));
    if(['unsupported_platform','desktop_not_found','shared_backend_running','proxy_settings_unavailable'].includes(code)) {
      assert.equal(f.calls.some(call=>call.command==='/usr/bin/open'),false);
    }
  }
});

test("launch endpoint accepts only a local, same-origin empty JSON action", async t => {
  let opened=0,ready=true;
  const launcher={open:async()=>{opened++;return {state:'opened'};}};
  let handler;
  const server=http.createServer((req,res)=>void handler(req,res).then(hit=>{if(!hit){res.writeHead(404);res.end();}}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const port=server.address().port,origin='http://127.0.0.1:'+port;
  handler=createCodexOpenHandler({launcher,port,ready:()=>ready});
  const send=(body='{}',headers={},method='POST')=>new Promise((resolve,reject)=>{
    const request=http.request(origin+'/api/codex/open',{method,headers:{'Content-Type':'application/json',Origin:origin,...headers}},response=>{
      const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode,body:JSON.parse(Buffer.concat(chunks).toString())}));
    });request.on('error',reject);request.end(body);
  });
  for(const headers of [{Origin:'https://other.invalid'},{Host:'other.invalid'},{'Sec-Fetch-Site':'cross-site'}]) assert.equal((await send('{}',headers)).status,403);
  for(const body of ['', '[]', '{"app":"/other"}', '{"padding":"'+'x'.repeat(1500)+'"}']) assert.equal((await send(body)).status,400);
  assert.equal((await send('{}',{'Content-Type':'text/plain'})).status,400);
  assert.equal((await send('',{},'GET')).status,405);
  let blockedStatus;
  await handler({url:'/api/codex/open',method:'POST',headers:{host:`127.0.0.1:${port}`},socket:{remoteAddress:'192.168.1.2'}},
    {writeHead(status){blockedStatus=status;},end(){}});
  assert.equal(blockedStatus,403);assert.equal(opened,0);
  ready=false;assert.equal((await send()).body.error,'bridge_not_ready');assert.equal(opened,0);
  ready=true;assert.deepEqual(await send(),{status:200,body:{ok:true,state:'opened'}});assert.equal(opened,1);
});
