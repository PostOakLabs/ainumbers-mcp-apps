#!/usr/bin/env node
// run-chain-browser.mjs — chain-engine differential, browser leg (SPEC-CHAIN-ENGINE-DIFF-2026-08-09.md §6).
//
// Drives repo/chaingraph/runners/<chain-id>.html headlessly via CDP and reads
// back the page's OWN computed composite hash (CHAIN_HASH, a top-level `let`
// in the page's global scope — same value the page anchors as
// buildArtifact().execution_hash). This is the
// "browser leg" side of the differential; the "worker leg" is
// mcp-apps-poc/scripts/run-chain-corpus.mjs's composite_execution_hash. A
// human compares the two hashes for the same chain (§7 — mismatch is a
// finding for adjudication, never an auto-verdict); this script does not
// itself call the worker leg or decide anything.
//
// Zero new dependency: Node's built-in http server (static-serve) + Node's
// built-in global WebSocket (stable since Node 21) drive a system-installed
// Chrome/Edge over CDP. No 'ws' package, no puppeteer.
//
// Usage:
//   node scripts/run-chain-browser.mjs <chain-id>            # run the chain, print its hash
//   node scripts/run-chain-browser.mjs <chain-id> --break     # ALSO inject a deliberately
//                                                              # broken call to prove console-error
//                                                              # / exceptionThrown capture works
//
// Exit code: 0 if the run completed and a 64-char hex hash was read back
// (and, under --break, at least one finding was captured); 1 otherwise.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
// mcp-apps-poc/scripts is normally 2 levels under the workspace root (…/AINumbers/repo);
// a worktree checkout (…/AINumbers/.wt/<branch>/scripts) sits one level deeper. Try both,
// plus an explicit override, before giving up.
function resolveRepoRoot() {
  const override = process.env.AINUMBERS_REPO_ROOT;
  const candidates = [
    override,
    resolve(HERE, '..', '..', 'repo'),
    resolve(HERE, '..', '..', '..', 'repo'),
    'C:\\dev\\Claude\\Projects\\AINumbers\\repo',
  ].filter(Boolean);
  return candidates.find((p) => existsSync(resolve(p, 'chaingraph', 'runners'))) || candidates[1];
}
const REPO_ROOT = resolveRepoRoot();

const args = process.argv.slice(2);
const chainId = args.find((a) => !a.startsWith('--'));
const doBreak = args.includes('--break');

if (!chainId) {
  console.error('Usage: node scripts/run-chain-browser.mjs <chain-id> [--break]');
  process.exit(1);
}

const runnerPath = resolve(REPO_ROOT, 'chaingraph', 'runners', `${chainId}.html`);
if (!existsSync(runnerPath)) {
  console.error(`✗ no runner page at ${runnerPath}`);
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function findBrowserBinary() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  return candidates.find((p) => existsSync(p)) || null;
}

// ── 1. Serve repo/ over localhost (static-serve, stdlib only — step 1 of §6). ──
function startStaticServer(root) {
  return new Promise((resolveServer, rejectServer) => {
    const server = createServer((req, res) => {
      try {
        const urlPath = decodeURIComponent(req.url.split('?')[0]);
        const filePath = resolve(root, '.' + urlPath);
        if (!filePath.startsWith(root)) { res.writeHead(403); res.end(); return; }
        const body = readFileSync(filePath);
        res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
        res.end(body);
      } catch (err) {
        res.writeHead(404);
        res.end('not found: ' + err.message);
      }
    });
    server.on('error', rejectServer);
    server.listen(0, '127.0.0.1', () => resolveServer(server));
  });
}

// ── 2/3. Launch headless Chrome/Edge, get the CDP webSocketDebuggerUrl. ──
async function launchHeadless(binary, cdpPort, userDataDir) {
  const child = spawn(binary, [
    '--headless=new',
    '--disable-gpu',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const resp = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      const list = await resp.json();
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch { /* CDP not up yet */ }
  }
  if (!target) { child.kill(); throw new Error('CDP target never appeared'); }
  return { child, target };
}

// Minimal CDP client over Node's native global WebSocket (no 'ws' dependency).
function connectCdp(wsUrl) {
  return new Promise((resolveWs, rejectWs) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    const listeners = new Set();
    ws.addEventListener('open', () => resolveWs(api));
    ws.addEventListener('error', (e) => rejectWs(new Error('CDP socket error: ' + (e.message || e))));
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
      } else if (msg.method) {
        for (const fn of listeners) fn(msg.method, msg.params);
      }
    });
    const api = {
      send(method, params = {}) {
        const id = nextId++;
        return new Promise((res, rej) => {
          pending.set(id, { res, rej });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      on(fn) { listeners.add(fn); },
      close() { ws.close(); },
    };
  });
}

async function main() {
  const binary = findBrowserBinary();
  if (!binary) { console.error('✗ no system Chrome or Edge binary found'); process.exit(1); }

  const httpServer = await startStaticServer(REPO_ROOT);
  const httpPort = httpServer.address().port;
  const scratchDir = mkdtempSync(join(tmpdir(), 'ocg-run-chain-browser-'));
  const cdpPort = 9500 + Math.floor(Math.random() * 400);

  let child;
  let cdp;
  const findings = [];
  try {
    ({ child } = await launchHeadless(binary, cdpPort, scratchDir).then((r) => ({ child: r.child, target: r.target })));
    // re-fetch target after launch resolved (launchHeadless already waited for it)
    const listResp = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
    const list = await listResp.json();
    const target = list.find((t) => t.type === 'page');
    cdp = await connectCdp(target.webSocketDebuggerUrl);

    // ── 7. Subscribe to exceptions/console errors BEFORE navigating. ──
    cdp.on((method, params) => {
      if (method === 'Runtime.exceptionThrown') {
        findings.push({ type: 'exceptionThrown', detail: params.exceptionDetails?.exception?.description || params.exceptionDetails?.text });
      }
      if (method === 'Runtime.consoleAPICalled' && params.type === 'error') {
        findings.push({ type: 'consoleError', detail: (params.args || []).map((a) => a.value ?? a.description).join(' ') });
      }
    });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // ── 4. Navigate, await load. ──
    const loadFired = new Promise((res) => {
      cdp.on((method) => { if (method === 'Page.loadEventFired') res(); });
    });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${httpPort}/chaingraph/runners/${chainId}.html` });
    await loadFired;

    if (doBreak) {
      // ── deliberately broken injection — proves exceptionThrown capture independent of hash comparison (§7). ──
      await cdp.send('Runtime.evaluate', {
        expression: "setTimeout(() => { window.__ocgIntentionallyUndefined(); }, 10);",
        awaitPromise: false,
      });
      await new Promise((r) => setTimeout(r, 500));
    }

    // ── 5. Invoke runChain() (mirrors the click handler) and await its promise. ──
    const runResult = await cdp.send('Runtime.evaluate', {
      expression: 'window.runChain()',
      awaitPromise: true,
      returnByValue: true,
    });
    if (runResult.exceptionDetails) {
      throw new Error('runChain() threw: ' + (runResult.exceptionDetails.exception?.description || runResult.exceptionDetails.text));
    }

    // ── 6. Read back the page's own computed composite hash. ──
    // CHAIN_HASH is a top-level `let` in the page's inline script — top-level let/const
    // do NOT become window properties, so it must be read via the global lexical scope,
    // not window.CHAIN_HASH (which is always undefined here).
    const hashResult = await cdp.send('Runtime.evaluate', {
      expression: 'CHAIN_HASH',
      returnByValue: true,
    });
    const hash = hashResult.result?.value;

    console.log(JSON.stringify({
      chain_id: chainId,
      composite_execution_hash: hash || null,
      hash_ok: typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash),
      findings,
    }, null, 2));

    const hashOk = typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash);
    if (!hashOk) { console.error('✗ no valid 64-char hex composite hash read back'); process.exit(1); }
    if (doBreak && findings.length === 0) { console.error('✗ --break was passed but no finding was captured'); process.exit(1); }
    process.exit(0);
  } finally {
    try { cdp?.close(); } catch {}
    try { child?.kill(); } catch {}
    try { rmSync(scratchDir, { recursive: true, force: true }); } catch {}
    httpServer.close();
  }
}

main().catch((err) => {
  console.error('✗ run-chain-browser ERROR:', err);
  process.exit(1);
});
