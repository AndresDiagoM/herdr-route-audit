#!/usr/bin/env node
// The watcher: every few seconds, read the combo-routed call_logs rows OmniRoute appended,
// attribute them to herdr panes, keep one `$route` sidebar token per pane current, and page
// once per incident (lib/incident.js).
//
//   node bin/watch.js --once            one tick, print what it would report, no tokens written
//   node bin/watch.js --loop            run in the foreground
//   node bin/watch.js --daemon          start a detached --loop (what the manifest's startup does)
//   node bin/watch.js --stop | --status
'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');
const db = require('../lib/db.js');
const { summarizeRows } = require('../lib/audit.js');
const { attribute, tokenText, parseTime } = require('../lib/attribute.js');
const incident = require('../lib/incident.js');
const realHerdr = require('../lib/herdr.js');
const realNotify = require('../lib/notify.js');
const { stateFile } = require('../lib/paths.js');

const INTERVAL_MS = Number(process.env.ROUTE_AUDIT_INTERVAL_MS) || 5000;
const HISTORY_MS = 30 * 60 * 1000; // poll log kept for correlation
const REPLAY_MS = 15 * 60 * 1000; // rows replayed when the watcher starts
const STALE_MS = 30 * 60 * 1000; // a pane with no request for this long loses its badge
const PANE_ROWS = 50; // rows remembered per pane
const BATCH = 5000; // rows read per query
// Long enough to outlast a slow tick (each herdr call may take up to 10 s), short enough that a
// dead watcher's badges disappear within a minute or so.
const TTL_MS = Math.max(INTERVAL_MS * 4, 60000);
const HEARTBEAT_STALE_MS = 2 * 60 * 1000;
const PID = () => stateFile('watch.pid');
const EVENTS = () => stateFile('events.jsonl');

// --- pid file with heartbeat ------------------------------------------------------------------
// A bare pid is not proof: after a crash or reboot Windows reuses pids, and a stale file would
// both block the daemon and make --stop kill an unrelated process. The watcher rewrites
// { pid, startedAt, beat } every tick; only a recent beat from a live pid counts as running.

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readPidFile() {
  try {
    const raw = fs.readFileSync(PID(), 'utf8').trim();
    const info = raw.startsWith('{') ? JSON.parse(raw) : { pid: Number(raw), beat: 0, legacy: true };
    return Number.isInteger(info.pid) && info.pid > 0 ? info : null;
  } catch { return null; }
}

function runningWatcher(now = Date.now()) {
  const info = readPidFile();
  if (!info) return null;
  const fresh = now - (Number(info.beat) || 0) < HEARTBEAT_STALE_MS;
  return { ...info, alive: pidAlive(info.pid), fresh, running: fresh && pidAlive(info.pid) };
}

function writeHeartbeat(startedAt) {
  try { fs.writeFileSync(PID(), JSON.stringify({ pid: process.pid, startedAt, beat: Date.now() })); } catch { /* best effort */ }
}

function appendEvent(event) {
  try { fs.appendFileSync(EVENTS(), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`); } catch { /* best effort */ }
}

class Watcher {
  constructor({ dryRun = false, herdr = realHerdr, notify = realNotify, dbPath = null, now = () => Date.now(), onEvent = null, log = console } = {}) {
    this.dryRun = dryRun;
    this.herdr = herdr;
    this.notify = notify;
    this.now = now;
    this.onEvent = onEvent;
    this.log = log;
    this.db = db.openReadOnly(dbPath);
    this.combos = db.loadCombos(this.db);
    this.cursor = db.cursorBefore(this.db, REPLAY_MS, now());
    this.history = []; // [{ t, working: Set }]
    this.rowsByPane = new Map(); // paneId -> rows
    this.written = new Map(); // paneId -> { text, at }
    this.incidents = new Map(); // paneId -> incident state
    this.combosRefreshedAt = now();
    this.pending = []; // untagged rows waiting for a correlation decision
    // Until the cursor has caught up with the table, rows are history: they rebuild each pane's
    // state but never page. Draining happens inside the first successful tick, however many
    // batches it takes, so "seeding" cannot end halfway through the replay.
    this.seeding = true;
  }

  readFresh() {
    const out = [];
    for (;;) {
      const batch = db.loadRowsAfter(this.db, this.cursor, { limit: BATCH });
      if (batch.length) { this.cursor = batch[batch.length - 1].rowid; out.push(...batch); }
      if (batch.length < BATCH) return out;
      if (!this.seeding) return out; // live: one batch per tick is plenty; the rest comes next tick
    }
  }

  emit(kind, paneId, summary, info, now) {
    const event = { event: kind, pane: paneId, agent: info.agent, combo: info.combo, state: info.state, served_by: info.servedBy, step: info.step };
    if (this.onEvent) this.onEvent(event);
    if (this.dryRun) return;
    appendEvent(event);
    this.log.log(`${new Date(now).toISOString()} ${kind.toUpperCase()} ${paneId} ${info.combo} -> ${info.servedBy}`);
    // Fire and forget; a slow Telegram must not delay the next tick. reason is pre-redacted.
    Promise.resolve(this.notify.notifyEvent(event)).then((r) => {
      if (r && !r.ok) this.log.error(`telegram: ${r.reason}`);
    }).catch(() => {});
  }

  tick() {
    const now = this.now();
    // Universe = every pane (a tag may name a shell pane); correlation = agents that are working.
    const panes = this.herdr.panes();
    const agents = this.herdr.agents();
    if (panes === null || agents === null) return { skipped: 'herdr pane/agent list failed' };
    const paneIds = panes.map((p) => p.pane_id);
    const working = new Set(agents.filter((a) => a.agent_status === 'working').map((a) => a.pane_id));
    this.history.push({ t: now, working });
    this.history = this.history.filter((p) => p.t >= now - HISTORY_MS && p.t <= now + HISTORY_MS);
    const fresh = this.readFresh();
    // Reload combo definitions when they may be stale: on a timer, and at once when a new row
    // names a combo or step the cache does not know (a combo created or edited since the last
    // load). Classifying against a stale definition would call a fresh fallback "historical".
    const unknown = fresh.some((r) => {
      const c = this.combos.get(r.combo_name);
      return !c || (r.combo_step_id && !c.models.some((m) => m && m.id === r.combo_step_id));
    });
    if (unknown || now - this.combosRefreshedAt > 60000) { this.combos = db.loadCombos(this.db); this.combosRefreshedAt = now; }
    // A row that ended a moment ago may still be waiting for the poll that shows its pane
    // working; hold untagged rows for two intervals before deciding.
    const rows = [...this.pending, ...fresh];
    this.pending = [];
    const { byPane, shared, unattributed, orphanTagged } = attribute(rows, paneIds, this.history, { slackMs: INTERVAL_MS * 2 });
    for (const row of unattributed) {
      if (parseTime(row.timestamp) > now - INTERVAL_MS * 2) this.pending.push(row);
    }

    const agentName = (paneId) => {
      const a = agents.find((x) => x.pane_id === paneId) || panes.find((x) => x.pane_id === paneId) || {};
      return a.name || a.label || a.agent || null;
    };

    // Pages: per pane, per new request, in time order.
    for (const [paneId, list] of byPane) {
      list.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
      if (!this.incidents.has(paneId)) this.incidents.set(paneId, incident.newIncidentState());
      const events = incident.advance(this.incidents.get(paneId), list, this.combos);
      if (!this.seeding) {
        for (const e of events) {
          this.emit(e.event, paneId, null, {
            agent: agentName(paneId), combo: e.row.combo_name, state: e.c.outcome === 'PRIMARY' ? 'PRIMARY' : e.c.outcome, servedBy: e.c.label, step: e.c.step,
          }, now);
        }
      }
      const have = this.rowsByPane.get(paneId) || [];
      this.rowsByPane.set(paneId, [...have, ...list].slice(-PANE_ROWS));
    }

    // Forget panes that closed; Herdr drops their metadata with them.
    for (const paneId of [...this.rowsByPane.keys()]) {
      if (!paneIds.includes(paneId)) { this.rowsByPane.delete(paneId); this.written.delete(paneId); this.incidents.delete(paneId); }
    }

    const reports = [];
    for (const paneId of paneIds) {
      const list = this.rowsByPane.get(paneId);
      const lastAt = list && list.length ? Math.max(...list.map((r) => parseTime(r.timestamp)).filter(Number.isFinite)) : NaN;
      // An idle pane loses its badge instead of showing last night's state forever.
      if (list && Number.isFinite(lastAt) && now - lastAt > STALE_MS) {
        this.rowsByPane.delete(paneId);
        this.incidents.delete(paneId);
        if (this.written.has(paneId)) {
          if (!this.dryRun) this.herdr.reportMetadata(paneId, { route: null });
          this.written.delete(paneId);
        }
        reports.push({ paneId, text: null, attributed: 0, expired: true });
        continue;
      }
      const summary = summarizeRows(list, this.combos);
      const text = tokenText(summary);
      const prev = this.written.get(paneId);
      // Rewrite on change, and refresh unchanged tokens well before their TTL lapses.
      const due = !prev || prev.text !== text || now - prev.at > TTL_MS / 2;
      if (text && due) {
        if (!this.dryRun) this.herdr.reportMetadata(paneId, { route: text }, { ttlMs: TTL_MS });
        this.written.set(paneId, { text, at: now });
      }
      reports.push({ paneId, text, attributed: (list || []).length });
    }
    this.seeding = false;
    return {
      fresh: fresh.length,
      shared: shared.length,
      orphanTagged: orphanTagged.length,
      unattributed: unattributed.length - this.pending.length,
      pending: this.pending.length,
      reports,
    };
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
  const other = runningWatcher();
  if (other && other.running && other.pid !== process.pid) { console.error(`watcher already running (pid ${other.pid})`); process.exit(0); }
  const startedAt = Date.now();
  writeHeartbeat(startedAt);
  const w = new Watcher();
  const stop = () => {
    const mine = readPidFile();
    if (mine && mine.pid === process.pid) { try { fs.rmSync(PID(), { force: true }); } catch { /* */ } }
    w.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  console.log(`route-audit watcher pid ${process.pid}, every ${INTERVAL_MS} ms, cursor rowid ${w.cursor}`);
  setInterval(() => {
    writeHeartbeat(startedAt);
    try { w.tick(); } catch (err) { console.error(`tick failed: ${err && err.message}`); }
  }, INTERVAL_MS);
}

function daemon() {
  const other = runningWatcher();
  if (other && other.running) { console.log(`watcher already running (pid ${other.pid})`); return; }
  const out = fs.openSync(stateFile('watch.log'), 'a');
  spawn(process.execPath, ['--disable-warning=ExperimentalWarning', __filename, '--loop'], {
    detached: true, stdio: ['ignore', out, out], windowsHide: true,
  }).unref();
  console.log('watcher started');
}

function stopDaemon() {
  const info = runningWatcher();
  if (!info) { console.log('watcher not running'); return; }
  if (!info.running) {
    // Never signal a pid we cannot vouch for: it may belong to another program by now.
    try { fs.rmSync(PID(), { force: true }); } catch { /* */ }
    console.log(`watcher not running (removed a stale pid file for pid ${info.pid}${info.legacy ? ', old format' : ''})`);
    return;
  }
  try { process.kill(info.pid); } catch { /* already gone */ }
  try { fs.rmSync(PID(), { force: true }); } catch { /* */ }
  console.log(`watcher stopped (pid ${info.pid})`);
}

function status() {
  const info = runningWatcher();
  if (!info) console.log('not running');
  else if (info.running) console.log(`running (pid ${info.pid}, last beat ${Math.round((Date.now() - info.beat) / 1000)} s ago)`);
  else console.log(`not running (stale pid file: pid ${info.pid}${info.legacy ? ', old format' : ''}${info.alive ? ', pid now belongs to another process or a hung watcher' : ''})`);
  console.log(`events: ${EVENTS()}`);
  try {
    const lines = fs.readFileSync(EVENTS(), 'utf8').trim().split('\n').slice(-5);
    for (const l of lines) console.log(`  ${l}`);
  } catch { /* no events yet */ }
}

if (require.main === module) {
  const ARGS = new Set(process.argv.slice(2));
  if (ARGS.has('--once')) once();
  else if (ARGS.has('--loop')) loop();
  else if (ARGS.has('--daemon')) daemon();
  else if (ARGS.has('--stop')) stopDaemon();
  else if (ARGS.has('--status')) status();
  else { console.error('usage: watch.js --once|--loop|--daemon|--stop|--status'); process.exit(2); }
}

module.exports = { Watcher, TTL_MS, STALE_MS };
