#!/usr/bin/env node
// The watcher: every few seconds, read the combo-routed call_logs rows OmniRoute appended,
// attribute them to herdr panes, and keep one `$route` sidebar token per agent pane current.
//
//   node bin/watch.js --once            one tick, print what it would report, no tokens written
//   node bin/watch.js --loop            run in the foreground
//   node bin/watch.js --daemon          start a detached --loop (what the manifest's startup does)
//   node bin/watch.js --stop | --status
'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { openReadOnly, loadCombos, loadRowsAfter, cursorBefore } = require('../lib/db.js');
const { summarizeRows } = require('../lib/audit.js');
const { attribute, tokenText, transition } = require('../lib/attribute.js');
const herdr = require('../lib/herdr.js');
const notify = require('../lib/notify.js');
const { stateFile } = require('../lib/paths.js');

const INTERVAL_MS = Number(process.env.ROUTE_AUDIT_INTERVAL_MS) || 5000;
const HISTORY_MS = 30 * 60 * 1000; // poll log kept for correlation
const REPLAY_MS = 15 * 60 * 1000; // rows replayed when the watcher starts
const PANE_ROWS = 50; // rows remembered per pane
const PID = () => stateFile('watch.pid');
const EVENTS = () => stateFile('events.jsonl');
const ARGS = new Set(process.argv.slice(2));

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function runningPid() {
  try {
    const pid = Number.parseInt(fs.readFileSync(PID(), 'utf8').trim(), 10);
    return pidAlive(pid) ? pid : null;
  } catch { return null; }
}

function appendEvent(event) {
  try { fs.appendFileSync(EVENTS(), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`); } catch { /* best effort */ }
}

class Watcher {
  constructor({ dryRun = false } = {}) {
    this.dryRun = dryRun;
    this.db = openReadOnly();
    this.combos = loadCombos(this.db);
    this.cursor = cursorBefore(this.db, REPLAY_MS);
    this.history = []; // [{ t, working: Set }]
    this.rowsByPane = new Map(); // paneId -> rows
    this.written = new Map(); // paneId -> { text, state, at }
    this.combosRefreshedAt = Date.now();
    this.pending = []; // untagged rows waiting for a correlation decision
    // The first tick replays up to REPLAY_MS of history to rebuild each pane's state. Those
    // transitions already happened; announcing them again on every restart would page the
    // operator for stale news.
    this.seeding = true;
  }

  tick() {
    // Universe = every pane (a tag may name a shell pane); correlation = agents that are working.
    const panes = herdr.panes();
    const agents = herdr.agents();
    if (panes === null || agents === null) return { skipped: 'herdr pane/agent list failed' };
    const now = Date.now();
    const paneIds = panes.map((p) => p.pane_id);
    const working = new Set(agents.filter((a) => a.agent_status === 'working').map((a) => a.pane_id));
    this.history.push({ t: now, working });
    while (this.history.length && this.history[0].t < now - HISTORY_MS) this.history.shift();
    if (now - this.combosRefreshedAt > 60000) { this.combos = loadCombos(this.db); this.combosRefreshedAt = now; }

    const fresh = loadRowsAfter(this.db, this.cursor);
    if (fresh.length) this.cursor = fresh[fresh.length - 1].rowid;
    // A row that ended a moment ago may still be waiting for the poll that shows its pane
    // working; hold untagged rows for one interval before deciding.
    const rows = [...this.pending, ...fresh];
    this.pending = [];
    const { byPane, shared, unattributed } = attribute(rows, paneIds, this.history, { slackMs: INTERVAL_MS * 2 });
    for (const row of unattributed) {
      if (Date.parse(row.timestamp) > now - INTERVAL_MS * 2) this.pending.push(row);
    }
    for (const [paneId, list] of byPane) {
      const have = this.rowsByPane.get(paneId) || [];
      this.rowsByPane.set(paneId, [...have, ...list].slice(-PANE_ROWS));
    }
    for (const paneId of [...this.rowsByPane.keys()]) {
      if (!paneIds.includes(paneId)) { this.rowsByPane.delete(paneId); this.written.delete(paneId); }
    }

    const reports = [];
    const agentName = (paneId) => {
      const a = agents.find((x) => x.pane_id === paneId) || panes.find((x) => x.pane_id === paneId) || {};
      return a.name || a.label || a.agent || null;
    };
    for (const paneId of paneIds) {
      const summary = summarizeRows(this.rowsByPane.get(paneId), this.combos);
      const text = tokenText(summary);
      const prev = this.written.get(paneId);
      const change = transition(prev && prev.state, summary && summary.state);
      // Rewrite on change, and refresh unchanged tokens before their TTL lapses.
      const due = !prev || prev.text !== text || now - prev.at > INTERVAL_MS * 2;
      if (text && due) {
        if (!this.dryRun) herdr.reportMetadata(paneId, { route: text }, { ttlMs: INTERVAL_MS * 4 });
        this.written.set(paneId, { text, state: summary.state, at: now });
      }
      if (change && !this.seeding) {
        const event = { event: change, pane: paneId, agent: agentName(paneId), combo: summary.combo, state: summary.state, served_by: summary.lastLabel, step: summary.lastStep };
        appendEvent(event);
        console.log(`${new Date(now).toISOString()} ${change.toUpperCase()} ${paneId} ${summary.combo} -> ${text}`);
        if (!this.dryRun) {
          // Fire and forget; a slow Telegram must not delay the next tick.
          notify.notifyEvent(event).then((r) => {
            if (r && !r.ok) console.error(`telegram: ${r.reason}`);
          }).catch(() => {});
        }
      }
      reports.push({ paneId, text, attributed: (this.rowsByPane.get(paneId) || []).length });
    }
    this.seeding = false;
    return { fresh: fresh.length, shared: shared.length, unattributed: unattributed.length - this.pending.length, pending: this.pending.length, reports };
  }

  close() { this.db.close(); }
}

function once() {
  const w = new Watcher({ dryRun: true });
  const r = w.tick();
  w.close();
  console.log(JSON.stringify(r, null, 2));
}

function loop() {
  if (runningPid()) { console.error(`watcher already running (pid ${runningPid()})`); process.exit(0); }
  fs.writeFileSync(PID(), String(process.pid));
  const w = new Watcher();
  const stop = () => { try { fs.rmSync(PID(), { force: true }); } catch { /* */ } w.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  console.log(`route-audit watcher pid ${process.pid}, every ${INTERVAL_MS} ms, cursor rowid ${w.cursor}`);
  const timer = setInterval(() => {
    try { w.tick(); } catch (err) { console.error(`tick failed: ${err.message}`); }
  }, INTERVAL_MS);
  timer.unref && timer.ref();
}

function daemon() {
  const pid = runningPid();
  if (pid) { console.log(`watcher already running (pid ${pid})`); return; }
  const out = fs.openSync(stateFile('watch.log'), 'a');
  spawn(process.execPath, ['--disable-warning=ExperimentalWarning', __filename, '--loop'], {
    detached: true, stdio: ['ignore', out, out], windowsHide: true,
  }).unref();
  console.log('watcher started');
}

function stopDaemon() {
  const pid = runningPid();
  if (!pid) { console.log('watcher not running'); return; }
  try { process.kill(pid); } catch { /* already gone */ }
  try { fs.rmSync(PID(), { force: true }); } catch { /* */ }
  console.log(`watcher stopped (pid ${pid})`);
}

function status() {
  const pid = runningPid();
  console.log(pid ? `running (pid ${pid})` : 'not running');
  console.log(`events: ${EVENTS()}`);
  try {
    const lines = fs.readFileSync(EVENTS(), 'utf8').trim().split('\n').slice(-5);
    for (const l of lines) console.log(`  ${l}`);
  } catch { /* no events yet */ }
}

if (ARGS.has('--once')) once();
else if (ARGS.has('--loop')) loop();
else if (ARGS.has('--daemon')) daemon();
else if (ARGS.has('--stop')) stopDaemon();
else if (ARGS.has('--status')) status();
else { console.error('usage: watch.js --once|--loop|--daemon|--stop|--status'); process.exit(2); }
