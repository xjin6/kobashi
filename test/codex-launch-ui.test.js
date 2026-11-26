const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '../assets/ui.html'), 'utf8');
const handlers = html.slice(html.indexOf('let currentNoticeId='), html.indexOf('async function toggleCodex()'));

function fixture(fetch) {
  const elements = new Map(), timers = new Map();
  let timerId = 0;
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set(), attributes = new Map();
      elements.set(id, { disabled: id === 'codex-launch', title: '', textContent: '',
        setAttribute: (key, value) => attributes.set(key, value),
        getAttribute: key => attributes.get(key),
        classList: { contains: name => classes.has(name), toggle(name, value) {
          if (value) classes.add(name); else classes.delete(name);
        } },
      });
    }
    return elements.get(id);
  }
  const context = vm.createContext({ document: { getElementById: element }, fetch,
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(handlers, context);
  return { element, run: code => vm.runInContext(code, context), expire() {
    const callbacks = [...timers.values()];timers.clear();callbacks.forEach(callback => callback());
  } };
}

test('the existing Codex tile is an accessible button separate from the bridge switch', () => {
  assert.match(html, /<button class="bridge-logo codex"[^>]*id="codex-launch"[^>]*type="button"[^>]*aria-label="Open Codex"/);
  assert.match(html, /id="codex-toggle" onclick="toggleCodex\(\)"/);
  assert.match(html, /\.bridge-logo\{width:32px;height:32px;/);
  assert.equal((html.match(/id="codex-launch"/g) || []).length, 1);
});

test('unsupported or unknown platforms keep the icon inactive without sending a launch request', async () => {
  const page = fixture(() => { throw Error('No request expected'); });
  for (const value of ['undefined', 'false', '"true"']) {
    page.run('setDesktopLaunchSupport(' + value + ')');
    await page.run('openCodexDesktop()');
    assert.equal(page.element('codex-launch').disabled, true);
    assert.equal(page.element('codex-launch').getAttribute('aria-label'), 'Codex');
  }
});

test('duplicate clicks issue one bounded action and do not change the bridge controls', async () => {
  let release;const calls = [];
  const pending = new Promise(resolve => { release = resolve; });
  const page = fixture(async (url, options) => { calls.push({url,options});return pending; });
  page.element('codex-text').textContent = 'Active';
  page.element('codex-toggle').classList.toggle('on', true);
  page.run('setDesktopLaunchSupport(true)');
  const first = page.run('openCodexDesktop()');
  await page.run('openCodexDesktop()');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/codex/open');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].options.body, '{}');
  assert.equal(page.element('codex-launch').disabled, true);
  assert.equal(page.element('codex-launch').getAttribute('aria-busy'), 'true');
  release({ok:true,json:async()=>({ok:true,state:'opened'})});await first;
  assert.equal(page.element('codex-launch').disabled, false);
  assert.equal(page.element('codex-launch').getAttribute('aria-busy'), 'false');
  assert.equal(page.element('codex-launch').title, 'Codex opened.');
  assert.equal(page.element('codex-text').textContent, 'Active');
  assert.equal(page.element('codex-toggle').classList.contains('on'), true);
  page.expire();assert.equal(page.element('codex-launch').title, 'Open Codex');
});

test('already-running feedback remains separate and permits another click later', async () => {
  let calls = 0;
  const page = fixture(async()=>{ calls++;return {ok:true,json:async()=>({ok:true,state:'already_running'})}; });
  page.run('setDesktopLaunchSupport(true)');
  await page.run('openCodexDesktop()');
  assert.equal(page.element('codex-launch-feedback').textContent, 'Codex is already running.');
  await page.run('openCodexDesktop()');
  assert.equal(calls, 2);
});

test('launch errors are bounded public feedback, recoverable on retry, and never overwrite bridge status', async () => {
  let state = 'failed';
  const page = fixture(async()=>{
    if(state==='network')throw Error('private transport detail');
    return state==='failed'?{ok:false,json:async()=>({ok:false,error:'private error including a secret'})}
      :{ok:true,json:async()=>({ok:true,state:'opened'})};
  });
  page.element('codex-text').textContent = 'Paused';
  page.run('setDesktopLaunchSupport(true)');
  await page.run('openCodexDesktop()');
  assert.equal(page.element('codex-launch').title, 'Could not open Codex. Please try again.');
  assert.equal(page.element('codex-launch').classList.contains('launch-error'), true);
  assert.equal(page.element('codex-text').textContent, 'Paused');
  state='network';await page.run('openCodexDesktop()');
  assert.equal(page.element('codex-launch').title, 'Could not reach Kobashi. Please try again.');
  assert.equal(page.element('codex-launch').disabled, false);
  state='success';await page.run('openCodexDesktop()');
  assert.equal(page.element('codex-launch').classList.contains('launch-error'), false);
  assert.equal(page.element('codex-text').textContent, 'Paused');
});
