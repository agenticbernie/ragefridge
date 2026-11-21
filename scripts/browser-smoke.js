import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import WebSocket from 'ws';
import { createServer } from '../server/index.js';

await mkdir('/tmp/opencode', { recursive: true });
const profile = await mkdtemp('/tmp/opencode/ragefridge-browser-');
const server = createServer({ port: 0 });
await server.listen();
const port = server.httpServer.address().port;
const browser = spawn(process.env.CHROMIUM_BIN || 'chromium', [
  '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, `http://127.0.0.1:${port}/`,
], { stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
const watchdog = setTimeout(() => { browser.kill('SIGKILL'); }, 45_000);
try {
  const endpoint = await new Promise((resolve, reject) => {
    browser.once('error', reject);
    browser.once('exit', () => reject(new Error('Chromium exited before debugger startup.')));
    browser.stderr.on('data', (data) => {
      const match = data.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) resolve(new URL(match[1]).origin.replace('ws:', 'http:'));
    });
  });
  const pages = await (await fetch(`${endpoint}/json`)).json();
  socket = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl);
  await once(socket, 'open');
  let sequence = 0;
  const requests = new Map();
  const exceptions = [];
  socket.on('close', () => {
    for (const request of requests.values()) request.reject(new Error('Browser debugger connection closed.'));
    requests.clear();
  });
  socket.on('message', (raw) => {
    const message = JSON.parse(raw);
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
    const request = requests.get(message.id);
    if (request) {
      requests.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    requests.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const waitFor = async (expression, label) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${label}.`);
  };
  await call('Runtime.enable');
  await waitFor("document.readyState === 'complete' && !!window.RageFridgeWallet", 'application load');
  await evaluate("document.querySelector('#open-room').click(); document.querySelector('#player-name').value='Browser QA'; document.querySelector('#demo-submit').click(); true");
  await waitFor("!document.querySelector('#lobby-panel').classList.contains('is-hidden')", 'demo lobby');
  await evaluate("document.querySelector('#start-match').click(); true");
  const roast = `document.querySelector('[data-action="roast"][data-tier="1"]')`;
  await waitFor(`!document.querySelector('#active-panel').classList.contains('is-hidden') && !${roast}.disabled`, 'active controls after role reveal');
  await evaluate(`${roast}.click(); true`);
  await waitFor("document.querySelector('#events-log').textContent.includes('stage fright')", 'accepted roast caption');
  await evaluate("window.confirm=()=>true; document.querySelector('#safety-stop').click(); true");
  await waitFor("!document.querySelector('#result-panel').classList.contains('is-hidden')", 'safety-stop results');
  assert.equal(await evaluate("document.querySelector('#result-stamp').textContent"), 'TECHNICAL VOID');
  // A separate, explicitly mocked wallet-history pass. This does not connect to Fuji.
  await call('Page.enable');
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `
    const originalFetch = window.fetch.bind(window);
    window.historyRequests = [];
    window.historyMode = 'normal';
    window.fetch = async (url, options) => {
      if (url === '/api/chain/config') return new Response(JSON.stringify({ enabled: true, chainId: 43113,
        token: '0x0000000000000000000000000000000000000002', escrow: '0x0000000000000000000000000000000000000003' }));
      if (String(url).startsWith('/api/wallet/matches')) {
        window.historyRequests.push(String(url));
        if (window.historyMode === 'expired') return new Response('', { status: 401 });
        const offset = Number(new URL(url, location.origin).searchParams.get('offset'));
        const page = { matches: [{ matchId: '0x' + (offset ? 'bb' : 'aa').repeat(32), state: 'REFUNDABLE', stake: '100' }], nextOffset: offset ? null : 50 };
        if (window.historyMode === 'deferred') return new Promise(resolve => { window.releaseHistory = () => resolve(new Response(JSON.stringify(page))); });
        return new Response(JSON.stringify(page));
      }
      return originalFetch(url, options);
    };
  ` });
  await call('Page.reload');
  await waitFor("document.readyState === 'complete' && !document.querySelector('#open-history').classList.contains('is-hidden')", 'mock history configuration');
  await evaluate(`window.authCalls = 0; window.RageFridgeWallet = {
    authenticate: async () => { window.authCalls++; return { address: '0x0000000000000000000000000000000000000001', token: 'mock-session' }; },
    pendingTransaction: () => null,
    inspect: async () => ({ claimed: false, matchState: 'REFUNDABLE' }),
    transact: async () => ({ pending: false, hash: '0x' + '12'.repeat(32) })
  }; document.querySelector('#open-history').click(); true`);
  await waitFor("document.querySelector('#history-list')?.textContent.includes('0x' + 'aa'.repeat(32))", 'newest history');
  await evaluate("[...document.querySelectorAll('#info-content button')].find(b=>b.textContent==='OLDER MATCHES').click(); true");
  await waitFor("document.querySelector('#history-list')?.textContent.includes('0x' + 'bb'.repeat(32))", 'history pagination');
  assert.equal(await evaluate('window.historyRequests.at(-1)'), '/api/wallet/matches?offset=50');
  await evaluate("window.confirm=()=>true; document.querySelector('#history-list button').click(); true");
  await waitFor("document.querySelector('#history-status')?.textContent.includes('Claim confirmed')", 'mock history claim');
  await evaluate("window.historyMode='expired'; document.querySelector('#history-refresh').click(); true");
  await waitFor("document.querySelector('#info-content').textContent.includes('401')", 'expired history auth');
  await evaluate("window.historyMode='normal'; document.querySelector('#info-content button').click(); true");
  await waitFor("!!document.querySelector('#history-refresh')", 'history retry');
  assert.equal(await evaluate('window.authCalls'), 2);
  await evaluate("window.historyMode='deferred'; document.querySelector('#history-refresh').click(); true");
  await waitFor("!!window.releaseHistory", 'in-flight history request');
  await evaluate("window.dispatchEvent(new CustomEvent('ragewallet:invalidated')); window.releaseHistory(); true");
  await waitFor("document.querySelector('#info-content').textContent.includes('Wallet identity changed')", 'history identity invalidation');
  assert.equal(await evaluate("document.querySelector('#history-list') === null"), true);
  await evaluate("window.historyMode='normal'; document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'})); document.querySelector('#open-history').click(); true");
  await waitFor("!!document.querySelector('#history-refresh')", 'history reopen after invalidation');
  await evaluate("window.historyMode='deferred'; window.releaseHistory=null; document.querySelector('#history-refresh').click(); true");
  await waitFor("!!window.releaseHistory", 'history dialog close race');
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'})); document.querySelector('#open-how').click(); window.releaseHistory(); true");
  await waitFor("document.querySelector('#info-kicker').textContent==='KITCHEN RULES'", 'rules dialog preserved');
  assert.equal(await evaluate("document.querySelector('#history-list') === null"), true);
  assert.deepEqual(exceptions, []);
  console.log('Browser smoke passed: demo gameplay; mocked wallet history pagination, claim, auth expiry, identity change and dialog races. No live Fuji transactions.');
} finally {
  clearTimeout(watchdog);
  socket?.terminate();
  browser.kill('SIGTERM');
  if (browser.exitCode === null && browser.signalCode === null) await once(browser, 'exit');
  await server.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
