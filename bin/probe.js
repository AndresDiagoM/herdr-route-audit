#!/usr/bin/env node
// Self-test: make a real, harmless fallback and check that the badge appears.
//
//   node bin/probe.js [--workspace ID] [--step1 provider/model] [--step2 provider/model] [--keep]
//
// Creates a scratch tab and a throwaway OmniRoute combo with a unique name whose first step the
// catalog rejects, sends one tagged request through it with `opencode run --standalone`, waits
// for the pane's `$route` token to read FALLBACK, then deletes the combo and closes the tab.
// Costs one request on step 2.
//
// Cleanup runs on every exit path (success, failure, exception, Ctrl-C, SIGTERM), and only
// removes what this run created: the combo name is unique to the run and is deleted only after
// `combo create` succeeded.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const herdr = require('../lib/herdr.js');
const { runTool } = require('../lib/exec.js');

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const keep = argv.includes('--keep');
const step1 = opt('--step1', 'claude/claude-sonnet-5-5-low');
const step2 = opt('--step2', 'antigravity/gemini-3.8-flash-tiered');
const COMBO = `route-audit-probe-${process.pid}-${Date.now().toString(36)}`;

const omni = (...args) => runTool('omniroute', ['--no-color', ...args], { timeout: 60000 });
const describe = (r) => (r.error && r.status === null ? `${r.error}` : (r.err || r.out || `exit ${r.status}`).split('\n').filter((l) => !/^\s*at |Loaded env|is ignored/.test(l)).slice(-3).join(' | '));
const contextJson = () => { try { return JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || 'null'); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pickWorkspace() {
  if (opt('--workspace')) return opt('--workspace');
  const ctx = contextJson();
  if (ctx && ctx.workspace_id) return ctx.workspace_id;
  const reply = herdr.call('workspace', 'list');
  const ws = reply && reply.result && reply.result.workspaces;
  if (!ws || !ws.length) return null;
  return (ws.find((w) => w.focused) || ws[0]).workspace_id;
}

// Everything this run created, and how to undo it. Idempotent.
const created = { tabId: null, paneId: null, combo: false, dir: null };
let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (keep) {
    console.log(`--keep: left combo ${created.combo ? COMBO : '(none)'}, tab ${created.tabId || '(none)'}, dir ${created.dir || '(none)'}`);
    return;
  }
  if (created.combo) {
    const r = await omni('combo', 'delete', COMBO, '--yes');
    if (r.status !== 0) console.error(`WARN: could not delete combo ${COMBO}: ${describe(r)} — delete it by hand`);
  }
  if (created.tabId) herdr.call('tab', 'close', created.tabId);
  else if (created.paneId) console.error(`WARN: no tab id for pane ${created.paneId}; close it by hand`);
  if (created.dir) { try { fs.rmSync(created.dir, { recursive: true, force: true }); } catch { /* temp dir */ } }
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { cleanup().finally(() => process.exit(130)); });
}

async function main() {
  const started = Date.now();
  const workspace = pickWorkspace();
  if (!workspace) throw new Error('no herdr workspace found');
  created.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-audit-probe-'));

  // 1. Scratch tab: its pane id is the tag, and closing it removes the badge afterwards.
  const tab = herdr.call('tab', 'create', '--workspace', workspace, '--cwd', created.dir, '--label', 'route-audit-probe', '--no-focus');
  const result = tab && tab.result;
  created.paneId = result && result.root_pane && result.root_pane.pane_id;
  created.tabId = result && (result.tab_id || (result.tab && result.tab.tab_id) || (result.root_pane && result.root_pane.tab_id)) || null;
  if (!created.paneId) throw new Error('tab create failed');
  console.log(`pane ${created.paneId} in workspace ${workspace}`);

  // 2. Throwaway combo under a name no one else uses.
  const made = await omni('combo', 'create', COMBO, '--strategy', 'priority', '--model', step1, '--model', step2);
  if (made.status !== 0) throw new Error(`combo create: ${describe(made)}`.slice(0, 300));
  created.combo = true;
  console.log(`combo ${COMBO}: [${step1}, ${step2}]`);

  // 3. One tagged request. stdin is closed by runTool, or `opencode run` would wait on it.
  const cfg = JSON.stringify({ provider: { omniroute: { options: { headers: { 'X-Omniroute-Session-Id': '{env:HERDR_PANE_ID}' } }, models: { [COMBO]: { name: COMBO } } } } });
  const env = { ...process.env, HERDR_PANE_ID: created.paneId, OPENCODE_CONFIG_CONTENT: cfg };
  const reqStart = Date.now();
  const r = await runTool('opencode', ['run', '--standalone', '-m', `omniroute/${COMBO}`, 'Reply with exactly: OK'], { cwd: created.dir, env, timeout: 120000 });
  const answered = /\bOK\b/.test(r.out);
  console.log(`opencode run: exit ${r.status}${r.timedOut ? ' (timed out, process tree killed)' : ''}, ${Math.round((Date.now() - reqStart) / 1000)} s, answered=${answered}`);
  if (!answered) throw new Error(`opencode run failed: ${describe(r)}`);

  // 4. The watcher polls every 5 s; give it four polls.
  let token = null;
  for (let i = 0; i < 8; i++) {
    await sleep(2500);
    const pane = herdr.call('pane', 'get', created.paneId);
    token = pane && pane.result && pane.result.pane && pane.result.pane.tokens && pane.result.pane.tokens.route;
    if (token && /^FALLBACK/.test(token)) break;
  }
  if (!token) throw new Error('no $route token on the pane after 20 s — is the watcher running? (bin/watch.js --status)');
  if (!/^FALLBACK step 2/.test(token)) throw new Error(`token was "${token}", expected "FALLBACK step 2 · ${step2}"`);
  return `PASS: ${token} (${Math.round((Date.now() - started) / 1000)} s)`;
}

main()
  .then(async (msg) => { await cleanup(); console.log(msg); process.exit(0); })
  .catch(async (err) => { await cleanup(); console.error(`FAIL: ${err && err.message ? err.message : err}`); process.exit(1); });
