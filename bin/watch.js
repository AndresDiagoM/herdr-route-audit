#!/usr/bin/env node
// The watcher: every few seconds, read the combo-routed call_logs rows OmniRoute appended,
// attribute them to herdr panes, keep one `$route` sidebar token per pane current, and page
// once per incident (lib/incident.js).
//
//   node bin/watch.js --once            one tick, print what it would report, no tokens written
//   node bin/watch.js --loop            run in the foreground
//   node bin/watch.js --daemon          start a detached --loop (what the manifest's startup does)
//   node bin/watch.js --stop [--forget] | --status
'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');
const db = require('../lib/db.js');
const { summarizeRows, classify } = require('../lib/audit.js');
const { attribute, tokenText, staleText, sharedText, formatAge, parseTime } = require('../lib/attribute.js');
const incident = require('../lib/incident.js');
const realHerdr = require('../lib/herdr.js');
const realNotify = require('../lib/notify.js');
const { stateFile } = require('../lib/paths.js');

const INTERVAL_MS = Number(process.env.ROUTE_AUDIT_INTERVAL_MS) || 5000;
const HISTORY_MS = 30 * 60 * 1000; // poll log kept for correlation
const REPLAY_MS = 15 * 60 * 1000; // rows replayed when the watcher starts
const STALE_MS = 30 * 60 * 1000; // nothing placed on a pane for this long: its badge turns `stale`
const PANE_ROWS = 50; // rows remembered per pane
const BATCH = 5000; // rows read per query
// Long enough to outlast a slow tick (each herdr call may take up to 10 s), short enough that a
// dead watcher's badges disappear within a minute or so.
const TTL_MS = Math.max(INTERVAL_MS * 4, 60000);
const HEARTBEAT_STALE_MS = 2 * 60 * 1000;
const GAP_ATTEMPTS = 3; // a gap report that keeps failing stops retrying (and logging) after this
const PENDING_MAX = 200; // undecided rowids kept by name in the heartbeat
const STOP_WAIT_MS = 5000;
const PID = () => stateFile('watch.pid');
const EVENTS = () => stateFile('events.jsonl');

// --- pid file with heartbeat ------------------------------------------------------------------
// A bare pid is not proof: after a crash or reboot Windows reuses pids, and a stale file would
// both block the daemon and make --stop kill an unrelated process. The watcher rewrites
// { pid, startedAt, beat, seen, seenId, tickAt, pending?, gaps?, gapSince?, skippedSince?,
// writeFailingSince? } every tick; only a recent beat from a live pid counts as running.
//   seen      every combo row with rowid <= seen is accounted for (handled live, history at this
//             watcher's start, or listed in `pending` or `gaps`); seenId is that row's TEXT id,
//             which tells a purged-and-renumbered table apart
//   pending   rowids <= seen read but not decided yet (waiting for a correlation decision)
//   tickAt    when the last tick completed (a fresh beat with an old tickAt = running but blind)
//   gaps      [[from, to], ...] rowid ranges no watcher saw, not reported yet; gapSince = when
//             the oldest of them began
// --stop removes the file once the watcher is gone, or, if it still held an unreported gap,
// rewrites it as { stopped: true, gaps } so the gap survives. Any other death leaves the file,
// and the next start reports what OmniRoute logged after `seen`. The running watcher exits as
// soon as the file is gone or no longer names it, so it can never write a stopped file back.

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// { info } | { missing: true } | { error } (unreadable for now: an antivirus lock, or a file that
// is empty or garbled). Only a file that is not there at all counts as missing.
function pidFileState() {
  let raw;
  try { raw = fs.readFileSync(PID(), 'utf8').trim(); } catch (err) { return err && err.code === 'ENOENT' ? { missing: true } : { error: err }; }
  try {
    const info = raw.startsWith('{') ? JSON.parse(raw) : { pid: Number(raw), beat: 0, legacy: true };
    return Number.isInteger(info.pid) && info.pid > 0 ? { info } : { error: new Error('no valid pid in watch.pid') };
  } catch (err) { return { error: err }; }
}

function readPidFile() {
  return pidFileState().info || null;
}

// A watcher is running when its file is not stopped, its beat is fresh and its pid is alive. The
// caller's own pid never counts: a process that finds its own pid in the file (reused after a
// crash) is looking at a dead predecessor's file, not at itself.
function runningWatcher(now = Date.now()) {
  const info = readPidFile();
  if (!info) return null;
  const fresh = now - (Number(info.beat) || 0) < HEARTBEAT_STALE_MS;
  const alive = info.pid !== process.pid && pidAlive(info.pid);
  return { ...info, alive, fresh, running: !info.stopped && fresh && alive };
}

// Write through a temp file and a rename, so a kill or a power cut mid-write leaves the old file
// or the new one, never an empty one. Where the rename is refused (a reader holding the file on
// Windows), write in place. True when the content landed.
function writeFileAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* */ }
    try { fs.writeFileSync(file, text); return true; } catch { return false; }
  }
}

function writeHeartbeat(startedAt, progress = {}) {
  return writeFileAtomic(PID(), JSON.stringify({ pid: process.pid, startedAt, beat: Date.now(), ...progress }));
}

// Why a running watcher should leave, from what its pid file says now, or null. Only once its own
// last write landed: after a failed write (disk full, a file held by another program) the file on
// disk proves nothing, and leaving would blank every badge until the next Herdr start.
function leaveReason(state, pid, lastWriteOk) {
  if (!lastWriteOk) return null;
  if (state.missing) return 'pid file removed';
  if (state.info && state.info.stopped) return 'pid file marked stopped';
  if (state.info && state.info.pid !== pid) return `pid file taken over by pid ${state.info.pid}`;
  return null;
}

function appendEvent(event) {
  try { fs.appendFileSync(EVENTS(), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`); } catch { /* best effort */ }
}

const isRowid = (n) => Number.isSafeInteger(n) && n >= 0;
const isTime = (t) => Number.isFinite(t) && t > 0 && t < 8.64e15;
const validRanges = (ranges) => (Array.isArray(ranges) ? ranges : [])
  .filter((g) => Array.isArray(g) && isRowid(g[0]) && isRowid(g[1]) && g[0] < g[1])
  .map(([a, b]) => [a, b]);

function mergeRanges(ranges) {
  const out = [];
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

// What a predecessor that died without --stop left unwatched, for a watcher whose history ends
// at rowid `replayEnd`: the ranges it had not reported yet, the rows it had not decided, and
// everything after its `seen`. `since` is the last moment a watcher is known to have been
// looking. A running predecessor, a deliberate stop (no file, or a `stopped` one: only its
// carried ranges) or a pre-0.2.1 file (no `seen`) add nothing of their own. `idAt(rowid)` tells
// whether call_logs was purged meanwhile (rowids start again at 1): then the old positions mean
// nothing, and everything the table holds now went unwatched. Carried ranges come with an anchor
// (the TEXT id of the row at their end): a different row there means they were renumbered too.
function inheritGaps(prev, replayEnd, idAt = null) {
  const none = { gaps: [], since: null };
  if (!prev || prev.running || prev.legacy) return none;
  const watched = [prev.tickAt, prev.beat].map(Number).find(isTime) || null;
  let since = isTime(Number(prev.gapSince)) ? Number(prev.gapSince) : null;
  const from = (t) => { if (t && (since === null || t < since)) since = t; };
  const renumberedAt = (rowid, id) => { // a missing row is retention, not a purge
    if (!idAt || typeof id !== 'string') return false;
    const now = idAt(rowid);
    return now !== null && now !== id;
  };
  const seen = isRowid(prev.seen) ? prev.seen : null;
  const renumbered = seen !== null && (seen > replayEnd || (seen > 0 && renumberedAt(seen, prev.seenId)));
  if (renumbered) {
    if (prev.stopped || replayEnd === 0) return { ...none, reset: true };
    from(watched);
    return { gaps: [[0, replayEnd]], since, reset: true };
  }
  let gaps = validRanges(prev.gaps);
  let reset = gaps.length > 0 && prev.gapReset === true;
  const anchor = Array.isArray(prev.gapAnchor) && isRowid(prev.gapAnchor[0]) ? prev.gapAnchor : null;
  if (gaps.length && anchor && renumberedAt(anchor[0], anchor[1])) { gaps = []; reset = true; }
  if (!prev.stopped && seen !== null) {
    if (seen < replayEnd) { gaps.push([seen, replayEnd]); from(watched); }
    for (const r of Array.isArray(prev.pending) ? prev.pending : []) {
      if (isRowid(r) && r >= 1 && r <= seen) { gaps.push([r - 1, r]); from(watched); }
    }
  }
  if (!gaps.length) return reset ? { ...none, reset: true } : none;
  return { gaps: mergeRanges(gaps), since, ...(reset ? { reset: true } : {}) };
}

// The unreported-gap fields of a pid file, as they travel from one file to the next.
function carriedGap(src) {
  const gaps = validRanges(src.gaps);
  if (!gaps.length) return {};
  return {
    gaps,
    ...(isTime(Number(src.gapSince)) ? { gapSince: Number(src.gapSince) } : {}),
    ...(src.gapReset === true ? { gapReset: true } : {}),
    ...(Array.isArray(src.gapAnchor) && isRowid(src.gapAnchor[0]) && typeof src.gapAnchor[1] === 'string' ? { gapAnchor: [src.gapAnchor[0], src.gapAnchor[1]] } : {}),
  };
}

// The predecessor's evidence, for the first heartbeat a new watcher writes before it has any of
// its own: dying between claiming the pid file and opening the database then loses nothing.
function carryForward(prev) {
  if (!prev || prev.running || prev.legacy) return {};
  const out = {};
  if (!prev.stopped) {
    if (isRowid(prev.seen)) out.seen = prev.seen;
    if (typeof prev.seenId === 'string') out.seenId = prev.seenId;
    if (Array.isArray(prev.pending) && prev.pending.length) out.pending = prev.pending;
    const watched = [prev.tickAt, prev.beat].map(Number).find(isTime);
    if (watched) out.tickAt = watched;
  }
  return { ...out, ...carriedGap(prev) };
}

// Whether a starting watcher must leave, and what it inherits. Its own pid in the file means the
// pid was reused: the file is a dead predecessor's, however fresh its beat.
function startPlan(other, pid) {
  if (!other) return { previous: null };
  if (other.pid === pid) return { previous: { ...other, running: false } };
  if (other.running) return { exit: `watcher already running (pid ${other.pid})` };
  return { previous: other };
}

// What --stop leaves behind for a watcher's last pid file: null (delete it) unless it still holds
// a gap nobody reported, which a later start must still report. --forget (unconfigure) drops it.
function fileAfterStop(info, { forget = false } = {}) {
  if (forget || !info || info.legacy) return null;
  const gap = carriedGap(info);
  if (!gap.gaps) return null;
  return { pid: info.pid, beat: info.beat, stopped: true, ...gap };
}

// Lines for watch.log when the watcher starts or stops being blind, once per change.
function transitionLines(before, after, iso) {
  const lines = [];
  if (!before.skippedSince && after.skippedSince) lines.push(`${iso} herdr pane/agent list failing: badges lapse until it recovers`);
  if (before.skippedSince && !after.skippedSince) lines.push(`${iso} herdr pane/agent list back`);
  if (!before.writeFailingSince && after.writeFailingSince) lines.push(`${iso} herdr rejects badge writes: badges lapse until it accepts them`);
  if (before.writeFailingSince && !after.writeFailingSince) lines.push(`${iso} herdr accepts badge writes again`);
  return lines;
}

class Watcher {
  constructor({ dryRun = false, herdr = realHerdr, notify = realNotify, dbPath = null, now = () => Date.now(), onEvent = null, log = console, previous = null } = {}) {
    this.dryRun = dryRun;
    this.herdr = herdr;
    this.notify = notify;
    this.now = now;
    this.onEvent = onEvent;
    this.log = log;
    this.db = db.openReadOnly(dbPath);
    this.combos = db.loadCombos(this.db);
    // Rows up to here were logged before this watcher started: history. They rebuild each
    // pane's state and never page; the part of them no watcher saw is the inherited gap.
    this.replayEnd = db.maxRowid(this.db);
    this.cursor = db.cursorBefore(this.db, REPLAY_MS, now());
    const inherited = inheritGaps(previous, this.replayEnd, (r) => db.idAt(this.db, r));
    this.gaps = inherited.gaps;
    this.gapSince = inherited.since;
    this.gapReset = Boolean(inherited.reset);
    this.gapAnchor = null; // [rowid, id] of the row at the gap's end, for a successor to check
    if (this.gaps.length) {
      const end = Math.max(...this.gaps.map((g) => g[1]));
      const id = db.idAt(this.db, end);
      if (id !== null) this.gapAnchor = [end, id];
    }
    this.gapAttempts = 0;
    this.seen = this.replayEnd;
    this.seenId = db.idAt(this.db, this.seen);
    this.pendingRowids = [];
    this.tickAt = null;
    this.liveAfter = null; // after a purge seen live: rows that ended before this are history
    this.skippedSince = null;
    this.writeFailingSince = null;
    this.history = []; // [{ t, working: Set }]
    this.rowsByPane = new Map(); // paneId -> rows
    this.written = new Map(); // paneId -> { text, at }: what Herdr accepted, and when
    this.rejected = new Set(); // panes whose latest badge write Herdr rejected
    this.stale = new Map(); // paneId -> { text, lastAt }: what a pane showed when it went stale
    this.sharedAt = new Map(); // paneId -> end time of the newest request it shared with another pane
    this.tagging = new Set(); // panes that have sent a tagged request: they never get `? shared`
    this.incidents = new Map(); // paneId -> incident state
    this.combosRefreshedAt = now();
    this.pending = []; // untagged rows waiting for a correlation decision
    // The first successful tick drains the replay, however many batches it takes.
    this.seeding = true;
  }

  // For the heartbeat.
  progress() {
    return {
      seen: this.seen,
      ...(this.seenId !== null ? { seenId: this.seenId } : {}),
      tickAt: this.tickAt,
      ...(this.pendingRowids.length ? { pending: this.pendingRowids } : {}),
      ...(this.gaps.length ? carriedGap({ gaps: this.gaps, gapSince: this.gapSince, gapReset: this.gapReset, gapAnchor: this.gapAnchor }) : {}),
      ...(this.skippedSince ? { skippedSince: this.skippedSince } : {}),
      ...(this.writeFailingSince ? { writeFailingSince: this.writeFailingSince } : {}),
    };
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

  emit(kind, paneId, info, now) {
    const event = { event: kind, pane: paneId, agent: info.agent, combo: info.combo, state: info.state, served_by: info.servedBy, step: info.step, inferred: info.inferred };
    if (this.onEvent) this.onEvent(event);
    if (this.dryRun) return;
    appendEvent(event);
    this.log.log(`${new Date(now).toISOString()} ${kind.toUpperCase()} ${paneId}${info.inferred ? ' (inferred)' : ''} ${info.combo} -> ${info.servedBy}`);
    this.page(event);
  }

  // Fire and forget; a slow Telegram must not delay the next tick. reason is pre-redacted.
  page(event) {
    Promise.resolve(this.notify.notifyEvent(event)).then((r) => {
      if (r && !r.ok) this.log.error(`telegram: ${r.reason}`);
    }).catch(() => {});
  }

  // What OmniRoute logged while no watcher was looking (the inherited rowid ranges), from any
  // client: one `gap` event, always logged, paged when any of it was a fallback or a failure, so a
  // reboot after an idle night stays quiet. Totals plus the combos that had trouble, not split by
  // pane: untagged requests cannot be placed, since nobody recorded which panes were working.
  reportGap(now) {
    const rows = this.gaps.flatMap(([from, to]) => db.loadRowsInRange(this.db, from, to));
    const oldest = db.minRowid(this.db);
    let fallbacks = 0;
    let failed = 0;
    const byCombo = new Map();
    for (const row of rows) {
      const c = classify(row, this.combos.get(row.combo_name));
      const kind = c.outcome === 'FALLBACK' ? 'fallbacks' : c.outcome === 'FAILED' ? 'failed' : null;
      if (!kind) continue;
      if (kind === 'fallbacks') fallbacks += 1; else failed += 1;
      if (!byCombo.has(row.combo_name)) byCombo.set(row.combo_name, { combo: row.combo_name, fallbacks: 0, failed: 0 });
      byCombo.get(row.combo_name)[kind] += 1;
    }
    const since = this.gapSince;
    const event = {
      event: 'gap',
      since: since ? `${new Date(since).toISOString().slice(0, 16)}Z` : 'unknown',
      down_for: since ? formatAge(now - since) : 'an unknown time',
      requests: rows.length,
      fallbacks,
      failed,
      by_combo: [...byCombo.values()].sort((a, b) => b.fallbacks + b.failed - (a.fallbacks + a.failed)),
      rowids: this.gaps,
      ...(this.gapReset ? { reset: true } : this.gaps.some(([from]) => oldest > from + 1) ? { trimmed: true } : {}),
    };
    this.gaps = [];
    this.gapSince = null;
    this.gapReset = false;
    this.gapAnchor = null;
    if (this.onEvent) this.onEvent(event);
    if (this.dryRun) return;
    appendEvent(event);
    this.log.log(`${new Date(now).toISOString()} GAP watcher was down ${event.down_for} since ${event.since}: ${rows.length} requests, ${fallbacks} fallbacks, ${failed} failed${event.reset ? ' (call_logs was emptied meanwhile)' : event.trimmed ? ' (oldest already deleted)' : ''}`);
    if (fallbacks + failed > 0) this.page(event);
  }

  // A failing gap read must cost only the gap report, never the tick (and the replay with it).
  tryReportGap(now) {
    if (!this.gaps.length || this.gapAttempts >= GAP_ATTEMPTS) return;
    this.gapAttempts += 1;
    try {
      this.reportGap(now);
    } catch (err) {
      this.log.error(`gap report failed (attempt ${this.gapAttempts}/${GAP_ATTEMPTS}): ${err && err.message}`);
      if (this.gapAttempts >= GAP_ATTEMPTS) this.log.error('gap report given up for this run; the ranges stay in watch.pid');
    }
  }

  // call_logs emptied while this watcher runs: its rowids start again at 1, where loadRowsAfter
  // would see nothing for thousands of requests. Seen either as the newest rowid falling below
  // the cursor, or as another row at `seen` (refilled past the old position before this watcher
  // looked again). Read the table again from the start. Rows that ended after this watcher's last
  // complete look are new and page; older ones are history, so even a mistaken reset can never
  // page a whole table.
  checkRenumbered(now) {
    const top = db.maxRowid(this.db);
    let why = null;
    if (top < Math.max(this.cursor, this.replayEnd)) why = `newest rowid ${top}, was reading after ${this.cursor}`;
    else if (this.seenId !== null) {
      const id = db.idAt(this.db, this.seen);
      if (id !== null && id !== this.seenId) why = `row ${this.seen} is not the one read before`;
    }
    if (!why) return;
    this.log.error(`${new Date(now).toISOString()} call_logs was emptied (${why}): reading it from the start`);
    if (this.gaps.length) this.log.error(`unreported gap ranges ${JSON.stringify(this.gaps)} dropped: their rows were purged`);
    this.cursor = 0;
    this.replayEnd = 0;
    this.pending = [];
    this.pendingRowids = [];
    this.gaps = [];
    this.gapSince = null;
    this.gapReset = false;
    this.gapAnchor = null;
    this.seen = 0;
    this.seenId = null;
    this.liveAfter = (this.tickAt === null ? now : this.tickAt) - INTERVAL_MS * 2;
  }

  tick() {
    const now = this.now();
    // Both need only the database, not Herdr, so they run even while Herdr cannot be listed; a
    // purge first, so a gap is never counted on rows that were renumbered under it.
    this.checkRenumbered(now);
    this.tryReportGap(now);
    // Universe = every pane (a tag may name a shell pane); correlation = agents that are working.
    const panes = this.herdr.panes();
    const agents = this.herdr.agents();
    if (panes === null || agents === null) {
      if (this.skippedSince === null) this.skippedSince = now;
      return { skipped: 'herdr pane/agent list failed' };
    }
    this.skippedSince = null;
    const paneIds = panes.map((p) => p.pane_id);
    const working = new Set(agents.filter((a) => a.agent_status === 'working').map((a) => a.pane_id));
    this.history.push({ t: now, working });
    this.history = this.history.filter((p) => p.t >= now - HISTORY_MS && p.t <= now + HISTORY_MS);
    // Reading moves the cursor; if anything up to the combo reload throws, put it back, so the
    // next tick reads the same rows again instead of `seen` passing over rows nobody handled.
    const cursor0 = this.cursor;
    let fresh;
    try {
      fresh = this.readFresh();
      // Reload combo definitions when they may be stale: on a timer, and at once when a new row
      // names a combo or step the cache does not know (a combo created or edited since the last
      // load). Classifying against a stale definition would call a fresh fallback "historical".
      const unknown = fresh.some((r) => {
        const c = this.combos.get(r.combo_name);
        return !c || (r.combo_step_id && !c.models.some((m) => m && m.id === r.combo_step_id));
      });
      if (unknown || now - this.combosRefreshedAt > 60000) { this.combos = db.loadCombos(this.db); this.combosRefreshedAt = now; }
    } catch (err) {
      this.cursor = cursor0;
      throw err;
    }
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

    // Pages: per pane, per new request, in time order. History (rows logged before this watcher
    // started) rebuilds the incident state and never pages; a row logged after the start pages
    // even inside the first tick.
    for (const [paneId, list] of byPane) {
      list.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
      if (!this.incidents.has(paneId)) this.incidents.set(paneId, incident.newIncidentState());
      const events = incident.advance(this.incidents.get(paneId), list, this.combos);
      for (const e of events) {
        if (!(e.row.rowid > this.replayEnd)) continue;
        if (this.liveAfter !== null && !(parseTime(e.row.timestamp) >= this.liveAfter)) continue;
        this.emit(e.event, paneId, {
          agent: agentName(paneId), combo: e.row.combo_name, state: e.c.outcome === 'PRIMARY' ? 'PRIMARY' : e.c.outcome, servedBy: e.c.label, step: e.c.step, inferred: e.inferred,
        }, now);
      }
      if (list.some((row) => row.attributed === 'tag')) this.tagging.add(paneId);
      const have = this.rowsByPane.get(paneId) || [];
      this.rowsByPane.set(paneId, [...have, ...list].slice(-PANE_ROWS));
      this.stale.delete(paneId);
    }
    // A request that ran while several panes were working is placed on none of them; remember
    // that each of them had one, so none of their badges keeps claiming a known route. A pane
    // that has sent tagged requests did not send this untagged one: its route is still known (a
    // pane's tag setting is fixed when its tab is created, so this holds for the pane's life).
    for (const { row, candidates } of shared) {
      const t = parseTime(row.timestamp);
      if (!Number.isFinite(t)) continue;
      for (const id of candidates) {
        if (this.tagging.has(id)) continue;
        if (!(this.sharedAt.get(id) >= t)) this.sharedAt.set(id, t);
      }
    }

    // Forget panes that closed; Herdr drops their metadata with them.
    const maps = [this.rowsByPane, this.stale, this.sharedAt, this.tagging, this.rejected, this.written, this.incidents];
    for (const paneId of new Set(maps.flatMap((m) => [...m.keys()]))) {
      if (!paneIds.includes(paneId)) for (const m of maps) m.delete(paneId);
    }

    const reports = [];
    let writeFailures = 0;
    for (const paneId of paneIds) {
      const list = this.rowsByPane.get(paneId);
      const times = list ? list.map((r) => parseTime(r.timestamp)).filter(Number.isFinite) : [];
      const lastAt = times.length ? Math.max(...times) : -Infinity;
      // A pane with nothing placed on it for STALE_MS keeps a dim `stale 34m · …` badge, not last
      // night's state as if it were current, and not a blank (blank must only mean "not seen" or
      // "no watcher"). Its window and incident start afresh with its next request.
      if (list && lastAt > -Infinity && now - lastAt > STALE_MS) {
        this.stale.set(paneId, { text: tokenText(summarizeRows(list, this.combos)), lastAt });
        this.rowsByPane.delete(paneId);
        this.incidents.delete(paneId);
      }
      const active = this.rowsByPane.get(paneId);
      const st = active ? null : this.stale.get(paneId);
      const base = active ? tokenText(summarizeRows(active, this.combos)) : st ? st.text : null;
      const baseAt = active ? lastAt : st ? st.lastAt : -Infinity;
      const sharedAt = this.sharedAt.has(paneId) ? this.sharedAt.get(paneId) : -Infinity;
      let text = null;
      let badge = null;
      if (sharedAt > baseAt && now - sharedAt <= STALE_MS) { text = sharedText(base); badge = 'shared'; }
      else if (active) { text = base; badge = 'active'; }
      // The age is that of the newest evidence, and so is the state shown with it: when that was
      // a shared request, the pane's own last state is older than the age would suggest.
      else if (st || sharedAt > -Infinity) { text = staleText(sharedAt > baseAt ? null : base, now - Math.max(baseAt, sharedAt)); badge = 'stale'; }
      const prev = this.written.get(paneId);
      // Rewrite on change, and refresh unchanged tokens well before their TTL lapses. Only a
      // write Herdr accepted counts: a failed one is retried on the next tick, not in 30 s.
      const due = !prev || prev.text !== text || now - prev.at > TTL_MS / 2;
      let writeFailed = false;
      if (text && due) {
        if (this.dryRun || this.herdr.reportMetadata(paneId, { route: text }, { ttlMs: TTL_MS })) { this.written.set(paneId, { text, at: now }); this.rejected.delete(paneId); }
        else { writeFailed = true; writeFailures += 1; this.rejected.add(paneId); }
      }
      reports.push({ paneId, text, badge, attributed: (active || []).length, ...(writeFailed ? { writeFailed } : {}) });
    }
    // Per pane: Herdr may keep rejecting one pane's writes (its 32-token limit, say) while it
    // accepts the others'. Failing from the first rejection until no pane's latest write is rejected.
    if (this.rejected.size === 0) this.writeFailingSince = null;
    else if (this.writeFailingSince === null) this.writeFailingSince = now;
    // Progress for the heartbeat: everything up to the cursor is handled, except live rows still
    // waiting for a correlation decision, which are named (or, past PENDING_MAX, hold `seen` back).
    const livePending = this.pending.filter((r) => r.rowid > this.replayEnd);
    if (livePending.length <= PENDING_MAX) {
      this.seen = Math.max(this.cursor, this.replayEnd);
      this.pendingRowids = livePending.map((r) => r.rowid);
    } else {
      this.seen = Math.min(...livePending.map((r) => r.rowid)) - 1;
      this.pendingRowids = [];
    }
    this.seenId = db.idAt(this.db, this.seen);
    this.tickAt = now;
    this.seeding = false;
    return {
      fresh: fresh.length,
      shared: shared.length,
      orphanTagged: orphanTagged.length,
      unattributed: unattributed.length - this.pending.length,
      pending: this.pending.length,
      writeFailures,
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
  const plan = startPlan(runningWatcher(), process.pid); // read before this watcher overwrites the file
  if (plan.exit) { console.error(plan.exit); process.exit(0); }
  const previous = plan.previous;
  const startedAt = Date.now();
  writeHeartbeat(startedAt, carryForward(previous));
  const w = new Watcher({ previous });
  let lastWriteOk = writeHeartbeat(startedAt, w.progress());
  // No pid-file cleanup on a signal: --stop handles the file once this process is gone, so a
  // deliberate stop is never reported as a gap, and any other way of dying leaves the evidence.
  const stop = () => {
    w.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  console.log(`route-audit watcher pid ${process.pid}, every ${INTERVAL_MS} ms, cursor rowid ${w.cursor}, history up to rowid ${w.replayEnd}${w.gaps.length ? `, unwatched ranges ${JSON.stringify(w.gaps)}` : ''}`);
  let before = w.progress();
  setInterval(() => {
    try { w.tick(); } catch (err) { console.error(`tick failed: ${err && err.message}`); }
    // --stop removed the file, marked it stopped, or another watcher took it over: leave rather
    // than write it back (which would pass a deliberate stop off as a crash). An unreadable file
    // (a transient lock), or one this watcher failed to write itself, is not a reason to stop.
    const reason = leaveReason(pidFileState(), process.pid, lastWriteOk);
    if (reason) {
      console.log(`${new Date().toISOString()} ${reason}: stopping`);
      stop();
    }
    const after = w.progress();
    lastWriteOk = writeHeartbeat(startedAt, after);
    for (const line of transitionLines(before, after, new Date().toISOString())) console.error(line);
    before = after;
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

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const beatText = (info) => (isTime(Number(info.beat)) ? `last beat ${new Date(Number(info.beat)).toISOString()}, ${formatAge(Date.now() - Number(info.beat))} ago` : 'no beat recorded');

function settleFile(forget) {
  const keep = fileAfterStop(readPidFile(), { forget });
  if (keep) writeFileAtomic(PID(), JSON.stringify(keep));
  else { try { fs.rmSync(PID(), { force: true }); } catch { /* */ } }
  return keep;
}

function stopDaemon({ forget = false } = {}) {
  const info = runningWatcher();
  if (!info) {
    // No readable file. With --forget, remove whatever is there (empty, garbled) all the same.
    const there = fs.existsSync(PID());
    if (forget && there) { try { fs.rmSync(PID(), { force: true }); } catch { /* */ } }
    console.log(`watcher not running${there ? (forget ? '; unreadable pid file removed' : '; pid file unreadable, left as it is') : ''}`);
    return;
  }
  if (!info.running) {
    // Never signal a pid we cannot vouch for: it may belong to another program by now. And keep
    // the file (unless forgetting): it is the dead watcher's last progress, which the next start
    // reports as a gap.
    if (forget) { try { fs.rmSync(PID(), { force: true }); } catch { /* */ } }
    console.log(`watcher not running (pid ${info.pid}: ${beatText(info)}${info.legacy ? ', old format' : ''}${info.stopped ? ', stopped' : ''}); ${forget ? 'pid file removed' : 'pid file kept so the next start can report what it missed'}`);
    return;
  }
  try { process.kill(info.pid); } catch { /* already gone */ }
  // Settle the file once the process is gone. A watcher still busy after the wait (a slow tick on
  // Linux/macOS) leaves by itself at its next beat, when it finds the file gone or stopped.
  const deadline = Date.now() + STOP_WAIT_MS;
  while (pidAlive(info.pid) && Date.now() < deadline) sleepMs(100);
  const gone = !pidAlive(info.pid);
  const kept = settleFile(forget);
  console.log(`${gone ? `watcher stopped (pid ${info.pid})` : `signalled pid ${info.pid}; still busy after ${STOP_WAIT_MS / 1000} s, it leaves at its next beat`}${kept ? '; pid file kept as stopped: it held a gap not reported yet' : ''}`);
}

function status() {
  const info = runningWatcher();
  const now = Date.now();
  if (!info) console.log('not running');
  else if (info.running) {
    const tickAt = Number(info.tickAt);
    // A pre-0.2.1 watcher writes no progress: say nothing about ticks rather than "none yet".
    const tick = isTime(tickAt) ? `, last complete tick ${formatAge(now - tickAt)} ago` : isRowid(info.seen) ? ', no complete tick yet' : '';
    const sinceTick = isTime(tickAt) ? now - tickAt : isRowid(info.seen) && isTime(Number(info.startedAt)) ? now - Number(info.startedAt) : 0;
    const warnings = [];
    if (sinceTick > 4 * INTERVAL_MS) warnings.push('running but not seeing Herdr or the database, see watch.log');
    if (isTime(Number(info.skippedSince))) warnings.push(`Herdr's pane/agent list failing since ${new Date(Number(info.skippedSince)).toISOString()}`);
    if (isTime(Number(info.writeFailingSince))) warnings.push(`Herdr rejecting badge writes since ${new Date(Number(info.writeFailingSince)).toISOString()}`);
    console.log(`running (pid ${info.pid}, last beat ${Math.round((now - info.beat) / 1000)} s ago${tick})${warnings.length ? `: ${warnings.join('; ')}` : ''}`);
  } else {
    console.log(`not running (pid ${info.pid}: ${beatText(info)}${info.legacy ? ', old format' : ''}${info.stopped ? ', stopped' : ''}${info.alive && !info.stopped ? ', pid now belongs to another process or a hung watcher' : ''})`);
    const tickAt = Number(info.tickAt);
    if (!info.stopped && isRowid(info.seen)) console.log(`  the next start reports what OmniRoute logged after its last complete tick${isTime(tickAt) ? ` (${new Date(tickAt).toISOString()}, ${formatAge(now - tickAt)} ago)` : ''}`);
  }
  if (info && Array.isArray(info.gaps) && info.gaps.length) console.log(`  unwatched rowid ranges not reported yet: ${JSON.stringify(info.gaps)}`);
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
  else if (ARGS.has('--stop')) stopDaemon({ forget: ARGS.has('--forget') });
  else if (ARGS.has('--status')) status();
  else { console.error('usage: watch.js --once|--loop|--daemon|--stop [--forget]|--status'); process.exit(2); }
}

module.exports = { Watcher, TTL_MS, STALE_MS, inheritGaps, carryForward, mergeRanges, startPlan, fileAfterStop, transitionLines, leaveReason, writeFileAtomic, pidFileState, runningWatcher, stopDaemon };
