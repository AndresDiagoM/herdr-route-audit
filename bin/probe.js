#!/usr/bin/env node
// Self-test: make a real, harmless fallback and check that the badge appears.
//
//   node bin/probe.js [--workspace ID] [--step1 provider/model] [--step2 provider/model] [--keep]
//
// Creates a scratch tab, a throwaway OmniRoute combo whose first step the catalog rejects, sends
// one tagged request through it with `opencode run --standalone`, waits for the pane's `$route`
// token to read FALLBACK, then deletes the combo and closes the tab. Costs one request on step 2.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const herdr = require('../lib/herdr.js');
const { runTool } = require('../lib/exec.js');

const COMBO = 'route-audit-probe';
const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const keep = argv.includes('--keep');
const step1 = opt('--step1', 'claude/claude-sonnet-5-5-low');
const step2 = opt('--step2', 'antigravity/gemini-3.8-flash-tiered');

const omni = (...args) => runTool('omniroute', ['--no-color', ...args]);
const describe = (r) => (r.error ? `${r.error} (is it on PATH for this process?)` : (r.err || r.out || `exit ${r.status}`).split('\n').filter((l) => !/^\s*at |Loaded env|is ignored/.test(l)).slice(-3).join(' | '));
const contextJson = () => { try { return JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || 'null'); } catch { return null; } };

function pickWorkspace() {
  const ctx = contextJson();
  if (opt('--workspace')) return opt('--workspace');
  if (ctx && ctx.workspace_id) return ctx.workspace_id;
  const reply = herdr.call('workspace', 'list');
  const ws = reply && reply.result && reply.result.workspaces;
  if (!ws || !ws.length) return null;
  return (ws.find((w) => w.focused) || ws[0]).workspace_id;
}

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function fail(msg, cleanup) { console.error(`FAIL: ${msg}`); if (cleanup) cleanup(); process.exit(1); }

function main() {
  const started = Date.now();
  const workspace = pickWorkspace();
  if (!workspace) fail('no herdr workspace found');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'route-audit-probe-'));

  // 1. Scratch tab: its pane id is the tag, and closing it removes the badge afterwards.
  const tab = herdr.call('tab', 'create', '--workspace', workspace, '--cwd', cwd, '--label', 'route-audit-probe', '--no-focus');
  const paneId = tab && tab.result && tab.result.root_pane && tab.result.root_pane.pane_id;
  const tabId = tab && tab.result && (tab.result.tab_id || (tab.result.tab && tab.result.tab.tab_id) || (tab.result.root_pane && tab.result.root_pane.tab_id));
  if (!paneId) fail('tab create failed');
  const closeTab = () => { if (tabId && !keep) herdr.call('tab', 'close', tabId); };
  console.log(`pane ${paneId} in workspace ${workspace}`);

  // 2. Throwaway combo. Delete a leftover first; `combo create` refuses duplicates.
  omni('combo', 'delete', COMBO, '--yes');
  const created = omni('combo', 'create', COMBO, '--strategy', 'priority', '--model', step1, '--model', step2);
  if (created.status !== 0) fail(`combo create: ${describe(created)}`.slice(0, 300), closeTab);
  const dropCombo = () => { if (!keep) omni('combo', 'delete', COMBO, '--yes'); };
  const cleanup = () => { dropCombo(); closeTab(); };
  console.log(`combo ${COMBO}: [${step1}, ${step2}]`);

  // 3. One tagged request. stdin must be closed or `opencode run` waits on it forever.
  const cfg = JSON.stringify({ provider: { omniroute: { options: { headers: { 'X-Omniroute-Session-Id': '{env:HERDR_PANE_ID}' } }, models: { [COMBO]: { name: COMBO } } } } });
  const env = { ...process.env, HERDR_PANE_ID: paneId, OPENCODE_CONFIG_CONTENT: cfg };
  const reqStart = Date.now();
  const r = runTool('opencode', ['run', '--standalone', '-m', `omniroute/${COMBO}`, 'Reply with exactly: OK'], { cwd, env, timeout: 120000 });
  const answered = /\bOK\b/.test(r.out);
  console.log(`opencode run: exit ${r.status}${r.signal ? ` (${r.signal})` : ''}, ${Math.round((Date.now() - reqStart) / 1000)} s, answered=${answered}`);
  if (r.status !== 0 && !answered) fail(`opencode run failed: ${describe(r)}`, cleanup);

  // 4. The watcher polls every 5 s; give it four polls.
  let token = null;
  for (let i = 0; i < 8; i++) {
    sleep(2500);
    const pane = herdr.call('pane', 'get', paneId);
    token = pane && pane.result && pane.result.pane && pane.result.pane.tokens && pane.result.pane.tokens.route;
    if (token && /^FALLBACK/.test(token)) break;
  }
  cleanup();
  if (!token) fail('no $route token on the pane after 20 s — is the watcher running? (bin/watch.js --status)');
  if (!/^FALLBACK step 2/.test(token)) fail(`token was "${token}", expected "FALLBACK step 2 · ${step2}"`);
  console.log(`PASS: ${token} (${Math.round((Date.now() - started) / 1000)} s)${keep ? ' — combo and tab kept (--keep)' : ''}`);
}

main();
