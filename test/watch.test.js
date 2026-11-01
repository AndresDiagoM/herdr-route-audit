'use strict';
// The watcher end to end against a temp SQLite file shaped like OmniRoute's, with herdr and
// Telegram faked. Covers F3 (restart never pages history, however long), F8 (one page per
// incident through the real tick), F9 (closed-pane tags), F14 (stale panes keep a badge, never
// a blank that could pass for healthy), shared and inferred attribution, write failures, and the
// restart gap report.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

process.env.HERDR_PLUGIN_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'route-audit-state-'));
const { Watcher, STALE_MS, inheritGaps, carryForward, mergeRanges, startPlan, fileAfterStop, transitionLines } = require('../bin/watch.js');
const dbModule = require('../lib/db.js');

const COMBO = { strategy: 'priority', models: [{ id: 'c-model-1-p-a', model: 'p/a' }, { id: 'c-model-2-p-b', model: 'p/b' }] };

function makeDb() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'route-audit-db-')), 'storage.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE call_logs (id TEXT PRIMARY KEY, timestamp TEXT, duration INTEGER, combo_name TEXT, combo_step_id TEXT,
            provider TEXT, model TEXT, requested_model TEXT, status INTEGER, error_summary TEXT, session_tag TEXT, api_key_name TEXT);
           CREATE TABLE combos (id TEXT PRIMARY KEY, name TEXT, data TEXT);`);
  db.prepare('INSERT INTO combos VALUES (?, ?, ?)').run('1', 'c', JSON.stringify(COMBO));
  let n = 0;
  const insert = db.prepare('INSERT INTO call_logs (id, timestamp, duration, combo_name, combo_step_id, provider, model, status, session_tag) VALUES (?, ?, 100, ?, ?, ?, ?, ?, ?)');
  const add = (atMs, step, tag = 'w1:p1', status = 200) => {
    n += 1;
    insert.run(`r${n}`, new Date(atMs).toISOString(), 'c', step === null ? null : `c-model-${step}-p-${step === 1 ? 'a' : 'b'}`, 'p', step === 1 ? 'a' : 'b', status, tag);
  };
  const bulk = (rows) => {
    db.exec('BEGIN');
    for (const r of rows) add(...r);
    db.exec('COMMIT');
  };
  const maxRowid = () => Number(db.prepare('SELECT COALESCE(MAX(rowid), 0) AS r FROM call_logs').get().r);
  // OmniRoute's "Purge call logs" (DELETE FROM call_logs), and retention (the oldest rows).
  const purge = () => db.exec('DELETE FROM call_logs');
  const deleteUpTo = (rowid) => db.prepare('DELETE FROM call_logs WHERE rowid <= ?').run(rowid);
  return { file, add, bulk, maxRowid, purge, deleteUpTo, close: () => db.close() };
}

function fakeHerdr(paneIds = ['w1:p1']) {
  const calls = [];
  return {
    calls,
    panes: () => paneIds.map((pane_id) => ({ pane_id })),
    agents: () => paneIds.map((pane_id) => ({ pane_id, agent: 'opencode', agent_status: 'idle' })),
    reportMetadata: (paneId, tokens, opts) => { calls.push({ paneId, tokens, opts }); return true; },
  };
}

function watcher(dbFile, { herdr = fakeHerdr(), clock, previous = null, errors = [] }) {
  const events = [];
  const pages = [];
  const notify = { notifyEvent: async (e) => { pages.push(e); return null; } };
  const w = new Watcher({ dbPath: dbFile, herdr, notify, now: () => clock.t, onEvent: (e) => events.push(e), log: { log() {}, error: (m) => errors.push(m) }, previous });
  return { w, events, pages, herdr };
}

test('F3: a restart with more than one batch of history in the replay window pages nothing', () => {
  const db = makeDb();
  const start = Date.now();
  const rows = [];
  for (let i = 0; i < 5200; i++) rows.push([start - 14 * 60 * 1000 + i * 100, 1]);
  rows.push([start - 1000, 2]); // the fallback is the newest historical row
  db.bulk(rows);
  db.close();
  const clock = { t: start };
  const { w, events, herdr } = watcher(db.file, { clock });
  w.tick();
  clock.t += 5000;
  w.tick();
  w.close();
  assert.deepEqual(events, [], 'history must not page');
  assert.match(herdr.calls.at(-1).tokens.route, /^FALLBACK step 2/, 'but it does rebuild the pane state');
});

test('F8 through the real tick: flapping fallbacks page once, and recovery pages once', () => {
  const db = makeDb();
  const clock = { t: Date.now() };
  const { w, events } = watcher(db.file, { clock });
  w.tick(); // seed (empty)
  for (const step of [2, 1, 2, 1, 2, 1, 1, 1]) {
    clock.t += 5000;
    db.add(clock.t - 200, step);
    w.tick();
  }
  w.close();
  db.close();
  assert.deepEqual(events.map((e) => `${e.event}:${e.state}`), ['degraded:FALLBACK', 'recovered:PRIMARY']);
  assert.equal(events[0].served_by, 'p/b');
});

test('F9: a row tagged with a pane that has closed does not land on another pane', () => {
  const db = makeDb();
  const clock = { t: Date.now() };
  const herdr = fakeHerdr(['w1:p2']);
  herdr.agents = () => [{ pane_id: 'w1:p2', agent: 'opencode', agent_status: 'working' }];
  const { w } = watcher(db.file, { clock, herdr });
  w.tick();
  clock.t += 5000;
  db.add(clock.t - 200, 2, 'w1:p1'); // p1 is gone; p2 is the only pane working
  const r = w.tick();
  w.close();
  db.close();
  assert.equal(r.orphanTagged, 1);
  assert.equal(herdr.calls.filter((c) => c.paneId === 'w1:p2').length, 0, 'p2 got no badge from p1\'s request');
});

// Found by the live self-test: a combo created after the watcher's last definition load must not
// be classified against a stale cache (it would read as "historical", i.e. "ok").
test('a combo created after the watcher started is classified against its real definition', () => {
  const dbh = makeDb();
  const clock = { t: Date.now() };
  const { w, herdr, events } = watcher(dbh.file, { clock });
  w.tick();
  const raw = new DatabaseSync(dbh.file);
  raw.prepare('INSERT INTO combos VALUES (?, ?, ?)').run('2', 'fresh', JSON.stringify({ strategy: 'priority', models: [{ id: 'fresh-model-1-x-y', model: 'x/y' }, { id: 'fresh-model-2-p-b', model: 'p/b' }] }));
  clock.t += 5000;
  raw.prepare('INSERT INTO call_logs (id, timestamp, duration, combo_name, combo_step_id, provider, model, status, session_tag) VALUES (?, ?, 100, ?, ?, ?, ?, 200, ?)')
    .run('f1', new Date(clock.t - 200).toISOString(), 'fresh', 'fresh-model-2-p-b', 'p', 'b', 'w1:p1');
  raw.close();
  dbh.close();
  w.tick();
  w.close();
  assert.match(herdr.calls.at(-1).tokens.route, /^FALLBACK step 2 · p\/b/);
  assert.deepEqual(events.map((e) => e.event), ['degraded']);
});

test('badges carry a TTL of at least a minute so a slow tick cannot make them flicker', () => {
  const db = makeDb();
  const clock = { t: Date.now() };
  db.add(clock.t - 1000, 1);
  db.close();
  const { w, herdr } = watcher(db.file, { clock });
  w.tick();
  w.close();
  assert.ok(herdr.calls[0].opts.ttlMs >= 60000);
});

function herdrWith(paneIds, working = []) {
  const h = fakeHerdr(paneIds);
  h.working = new Set(working);
  h.agents = () => paneIds.map((pane_id) => ({ pane_id, agent: 'opencode', agent_status: h.working.has(pane_id) ? 'working' : 'idle' }));
  return h;
}
const lastRoute = (herdr, id) => {
  const c = herdr.calls.filter((x) => x.paneId === id).at(-1);
  return c && c.tokens.route;
};

// Discussion #5400: a blank sidebar must only ever mean "not seen" or "no watcher". A pane with
// nothing placed on it for 30 minutes keeps a dim, TTL-refreshed `stale` badge; its next request
// starts a fresh window.
test('F14: a pane with nothing placed on it for STALE_MS shows `stale Nm · …`, kept alive by the TTL', () => {
  const db = makeDb();
  const clock = { t: Date.now() };
  db.add(clock.t - 1000, 2);
  const { w, herdr, events } = watcher(db.file, { clock });
  w.tick();
  assert.equal(lastRoute(herdr, 'w1:p1'), 'FALLBACK step 2 · p/b');
  clock.t += STALE_MS + 60000;
  let r = w.tick();
  assert.equal(lastRoute(herdr, 'w1:p1'), 'stale 31m · FALLBACK step 2 · p/b');
  assert.ok(herdr.calls.at(-1).opts.ttlMs >= 60000, 'the stale badge carries the TTL too, so it vanishes with the watcher');
  assert.equal(r.reports[0].badge, 'stale');
  assert.equal(herdr.calls.filter((c) => c.tokens.route === null).length, 0, 'never cleared');
  clock.t += 60000;
  w.tick();
  assert.equal(lastRoute(herdr, 'w1:p1'), 'stale 32m · FALLBACK step 2 · p/b', 'the age keeps counting');
  clock.t += 5000;
  db.add(clock.t - 200, 1);
  r = w.tick();
  w.close();
  db.close();
  assert.equal(lastRoute(herdr, 'w1:p1'), 'ok · p/a', 'a new request: fresh window, not DEGRADED by the old fallback');
  assert.equal(r.reports[0].badge, 'active');
  assert.deepEqual(events, [], 'the replayed fallback never paged, and the incident did not survive the stale spell');
});

test('F14: a stale pane that closes is forgotten; a reused id starts blank', () => {
  const db = makeDb();
  const clock = { t: Date.now() };
  db.add(clock.t - 1000, 1);
  db.close();
  let open = ['w1:p1'];
  const herdr = fakeHerdr();
  herdr.panes = () => open.map((pane_id) => ({ pane_id }));
  herdr.agents = () => open.map((pane_id) => ({ pane_id, agent: 'opencode', agent_status: 'idle' }));
  const { w } = watcher(db.file, { clock, herdr });
  w.tick();
  clock.t += STALE_MS + 60000;
  w.tick();
  assert.equal(w.stale.size, 1);
  open = [];
  clock.t += 5000;
  w.tick();
  assert.equal(w.stale.size, 0);
  assert.equal(w.written.size, 0);
  open = ['w1:p1'];
  clock.t += 5000;
  const r = w.tick();
  w.close();
  assert.equal(r.reports[0].text, null);
});

test('a pane found by correlation is marked `*` on its badge and "inferred" in its page', () => {
  const db = makeDb();
  const clock = { t: Date.now() };
  const herdr = herdrWith(['w1:p1', 'w1:p2'], ['w1:p1']);
  const { w, events, pages } = watcher(db.file, { clock, herdr });
  w.tick();
  clock.t += 5000;
  db.add(clock.t - 200, 2, null); // untagged; p1 is the only pane working
  db.add(clock.t - 100, 2, 'w1:p2'); // tagged: exact
  w.tick();
  w.close();
  db.close();
  assert.equal(lastRoute(herdr, 'w1:p1'), 'FALLBACK* step 2 · p/b');
  assert.equal(lastRoute(herdr, 'w1:p2'), 'FALLBACK step 2 · p/b');
  assert.deepEqual(events.map((e) => `${e.pane}:${e.inferred}`).sort(), ['w1:p1:true', 'w1:p2:false']);
  assert.equal(pages.length, 2);
});

test('requests that ran while two panes worked are placed on neither, and both badges say the route is unknown', () => {
  const db = makeDb();
  const clock = { t: Date.now() };
  const herdr = herdrWith(['w1:p1', 'w1:p2'], ['w1:p1']);
  const { w, pages } = watcher(db.file, { clock, herdr });
  w.tick();
  clock.t += 5000;
  db.add(clock.t - 200, 1, null); // only p1 working: correlated to p1
  w.tick();
  assert.equal(lastRoute(herdr, 'w1:p1'), 'ok* · p/a');
  herdr.working = new Set(['w1:p1', 'w1:p2']);
  let r;
  for (let i = 0; i < 3; i++) {
    clock.t += 5000;
    db.add(clock.t - 200, 2, null);
    r = w.tick();
  }
  assert.equal(r.shared, 1);
  assert.equal(lastRoute(herdr, 'w1:p1'), '? shared · ok* · p/a', 'not "ok": its last known state is no longer the current one');
  assert.equal(lastRoute(herdr, 'w1:p2'), '? shared with another pane');
  assert.equal(pages.length, 0, 'shared requests never page (README: "shared")');
  herdr.working = new Set();
  clock.t += STALE_MS + 60000;
  w.tick();
  w.close();
  db.close();
  assert.equal(lastRoute(herdr, 'w1:p1'), 'stale 31m · ? shared', 'the newest evidence was shared: its age goes with "? shared", not with the older ok');
  assert.equal(lastRoute(herdr, 'w1:p2'), 'stale 31m · ? shared');
});

test('a badge write Herdr rejects is retried on the next tick, not 30 s later', () => {
  const db = makeDb();
  const clock = { t: Date.now() };
  db.add(clock.t - 1000, 1);
  const herdr = fakeHerdr();
  let fail = 0;
  const record = herdr.reportMetadata;
  herdr.reportMetadata = (...a) => {
    record(...a);
    if (fail > 0) { fail -= 1; return false; }
    return true;
  };
  const { w } = watcher(db.file, { clock, herdr });
  w.tick();
  assert.equal(lastRoute(herdr, 'w1:p1'), 'ok · p/a');
  clock.t += 5000;
  db.add(clock.t - 200, 2);
  fail = 1;
  const r = w.tick();
  assert.equal(r.writeFailures, 1);
  assert.equal(r.reports[0].writeFailed, true);
  const fallbackWrites = () => herdr.calls.filter((c) => c.tokens.route === 'FALLBACK step 2 · p/b').length;
  assert.equal(fallbackWrites(), 1);
  clock.t += 5000;
  w.tick();
  assert.equal(fallbackWrites(), 2, 'retried at once');
  clock.t += 5000;
  w.tick();
  w.close();
  db.close();
  assert.equal(fallbackWrites(), 2, 'and not rewritten again once accepted');
});

test('a fallback logged after the watcher started pages even inside its first tick; history does not', () => {
  const db = makeDb();
  const clock = { t: Date.now() };
  db.add(clock.t - 60000, 2, 'w1:p1'); // logged before the start: history
  const herdr = fakeHerdr(['w1:p1', 'w1:p2']);
  const { w, events } = watcher(db.file, { clock, herdr });
  db.add(clock.t - 100, 2, 'w1:p2'); // after the start, before the first tick
  w.tick();
  w.close();
  db.close();
  assert.deepEqual(events.map((e) => `${e.event}:${e.pane}`), ['degraded:w1:p2']);
});

test('progress: a live row still waiting for a correlation decision is named in `pending`, not counted as seen', () => {
  const db = makeDb();
  const clock = { t: Date.now() };
  db.add(clock.t - 3000, 1, null); // history, untagged, recent: held in pending too
  const { w } = watcher(db.file, { clock });
  const end = w.replayEnd;
  assert.equal(w.progress().seen, end, 'before any tick: everything up to the start is history');
  assert.equal(typeof w.progress().seenId, 'string');
  db.add(clock.t - 100, 2, null); // live, untagged, no pane working: pending
  w.tick();
  assert.equal(w.pending.length, 2);
  assert.equal(w.progress().seen, end + 1);
  assert.deepEqual(w.progress().pending, [end + 1], 'only the live one: the history one never pages anyway');
  assert.deepEqual(inheritGaps({ pid: 1, beat: clock.t, ...w.progress() }, end + 1).gaps, [[end, end + 1]],
    'a crash now: the successor counts the undecided row, and nothing already handled');
  clock.t += 15000;
  w.tick();
  w.close();
  db.close();
  assert.equal(w.pending.length, 0);
  assert.equal(w.progress().pending, undefined);
});

test('inheritGaps: only a predecessor that died without --stop, with 0.2.1 progress, leaves a gap', () => {
  const none = { gaps: [], since: null };
  assert.deepEqual(inheritGaps(null, 10), none, 'no file: first start, or a deliberate --stop');
  assert.deepEqual(inheritGaps({ pid: 1, beat: 5, seen: 3, running: true }, 10), none);
  assert.deepEqual(inheritGaps({ pid: 1, beat: 0, legacy: true }, 10), none);
  assert.deepEqual(inheritGaps({ pid: 1, beat: 1000, startedAt: 900 }, 10), none, 'a 0.2.0 file has no progress');
  assert.deepEqual(inheritGaps({ pid: 1, beat: 2000, tickAt: 1500, seen: 3 }, 10), { gaps: [[3, 10]], since: 1500 });
  assert.deepEqual(inheritGaps({ pid: 1, beat: 2000, seen: 3 }, 10), { gaps: [[3, 10]], since: 2000 }, 'no complete tick: the beat');
  assert.deepEqual(inheritGaps({ pid: 1, beat: 2000, tickAt: 1500, seen: 10 }, 10), none, 'nothing logged since');
  assert.deepEqual(
    inheritGaps({ pid: 1, beat: 3000, tickAt: 2500, seen: 12, gaps: [[3, 8], [7, 10], ['x', 1], [5, 5]], gapSince: 1000 }, 20),
    { gaps: [[3, 10], [12, 20]], since: 1000 },
    'carried ranges merge, junk is dropped, the oldest start wins',
  );
});

test('carryForward: a new watcher\'s first heartbeat keeps its predecessor\'s evidence', () => {
  assert.deepEqual(carryForward(null), {});
  assert.deepEqual(carryForward({ pid: 1, beat: 5, running: true, seen: 3 }), {});
  assert.deepEqual(carryForward({ pid: 1, beat: 2000, tickAt: 1500, seen: 3, gaps: [[1, 2]], gapSince: 900 }), { seen: 3, tickAt: 1500, gaps: [[1, 2]], gapSince: 900 });
  assert.deepEqual(carryForward({ pid: 1, beat: 2000, seen: 3 }), { seen: 3, tickAt: 2000 });
  const carried = { pid: 2, beat: 9999, ...carryForward({ pid: 1, beat: 2000, tickAt: 1500, seen: 3 }) };
  assert.deepEqual(inheritGaps(carried, 10), { gaps: [[3, 10]], since: 1500 }, 'dying right after claiming the file loses nothing');
});

test('mergeRanges joins overlapping and touching ranges', () => {
  assert.deepEqual(mergeRanges([[5, 9], [1, 3], [3, 4], [8, 12]]), [[1, 4], [5, 12]]);
  assert.deepEqual(mergeRanges([]), []);
});

test('restart after a crash: one gap event for what no watcher saw, and the replay still rebuilds badges', () => {
  const start = Date.now();
  const db = makeDb();
  db.add(start - 40 * 60000, 2); // seen by the old watcher before it died
  const seen = db.maxRowid();
  db.bulk([[start - 10 * 60000, 2], [start - 9 * 60000, 1], [start - 8 * 60000, null, 'w1:p1', 502], [start - 7 * 60000, null, 'w1:p1', 499]]);
  const clock = { t: start };
  const previous = { pid: 1, beat: start - 20 * 60000 + 3000, tickAt: start - 20 * 60000, seen, running: false };
  const { w, events, pages, herdr } = watcher(db.file, { clock, previous });
  assert.deepEqual(w.progress().gaps, [[seen, seen + 4]]);
  w.tick();
  clock.t += 5000;
  w.tick();
  w.close();
  db.close();
  const gaps = events.filter((e) => e.event === 'gap');
  assert.equal(gaps.length, 1, 'reported once');
  assert.deepEqual(events.filter((e) => e.event !== 'gap'), [], 'the replay itself pages nothing');
  const g = gaps[0];
  assert.deepEqual([g.requests, g.fallbacks, g.failed, g.down_for], [4, 1, 1, '20m'], 'the row seen before the crash is not counted; a 499 is neither');
  assert.equal(g.since, `${new Date(start - 20 * 60000).toISOString().slice(0, 16)}Z`, 'since the last complete tick, not the last beat');
  assert.deepEqual(g.by_combo, [{ combo: 'c', fallbacks: 1, failed: 1 }]);
  assert.deepEqual(pages, [g]);
  assert.equal(lastRoute(herdr, 'w1:p1'), 'FAILED · (no step served)', 'the badge is rebuilt from the replay');
  assert.equal(w.progress().gaps, undefined, 'reported: nothing left to carry');
});

test('a clean gap (only step-1 requests) is logged, not paged', () => {
  const start = Date.now();
  const db = makeDb();
  db.add(start - 10 * 60000, 1);
  const clock = { t: start };
  const { w, events, pages } = watcher(db.file, { clock, previous: { pid: 1, beat: start - 20 * 60000, seen: 0, running: false } });
  w.tick();
  w.close();
  db.close();
  assert.deepEqual(events.map((e) => [e.event, e.requests, e.fallbacks, e.failed]), [['gap', 1, 0, 0]]);
  assert.deepEqual(pages, []);
});

test('a gap read that fails costs only the gap report: the tick and its replay go on, and it is retried', () => {
  const start = Date.now();
  const db = makeDb();
  db.add(start - 60000, 2);
  const clock = { t: start };
  const errors = [];
  const { w, events, herdr } = watcher(db.file, { clock, previous: { pid: 1, beat: start - 120000, seen: 0, running: false }, errors });
  const real = dbModule.loadRowsInRange;
  let fail = 1;
  dbModule.loadRowsInRange = (...args) => {
    if (fail > 0) { fail -= 1; throw new Error('database is locked'); }
    return real(...args);
  };
  try {
    w.tick();
    assert.equal(lastRoute(herdr, 'w1:p1'), 'FALLBACK step 2 · p/b', 'the replay was not lost with the gap read');
    assert.deepEqual(events, []);
    assert.match(errors[0], /attempt 1\/3.*locked/);
    clock.t += 5000;
    w.tick();
  } finally {
    dbModule.loadRowsInRange = real;
    w.close();
    db.close();
  }
  assert.deepEqual(events.map((e) => `${e.event}:${e.requests}:${e.fallbacks}`), ['gap:1:1']);
});

test('a gap read that keeps failing is tried three times, then left in the heartbeat for a later start', () => {
  const start = Date.now();
  const db = makeDb();
  db.add(start - 60000, 2);
  const clock = { t: start };
  const errors = [];
  const { w, events } = watcher(db.file, { clock, previous: { pid: 1, beat: start - 120000, seen: 0, running: false }, errors });
  const real = dbModule.loadRowsInRange;
  let calls = 0;
  dbModule.loadRowsInRange = () => { calls += 1; throw new Error('no such column'); };
  try {
    for (let i = 0; i < 5; i++) { w.tick(); clock.t += 5000; }
  } finally {
    dbModule.loadRowsInRange = real;
    w.close();
    db.close();
  }
  assert.equal(calls, 3);
  assert.equal(errors.filter((m) => /given up/.test(m)).length, 1);
  assert.deepEqual(w.progress().gaps, [[0, 1]]);
  assert.deepEqual(events, []);
});

test('a watcher that dies before reporting its inherited gap passes it on, merged with its own', () => {
  const start = Date.now();
  const db = makeDb();
  db.add(start - 60000, 1); // rowid 1: seen by W1
  db.add(start - 50000, 2); // rowid 2: W1 died before seeing it
  const clock = { t: start };
  const w2 = watcher(db.file, { clock, previous: { pid: 1, beat: start - 55000, tickAt: start - 55000, seen: 1, running: false } }).w;
  const fileOfW2 = { pid: 2, beat: start, running: false, ...w2.progress() }; // W2 died before its first tick
  w2.close();
  assert.deepEqual(fileOfW2.gaps, [[1, 2]]);
  db.add(start + 1000, 2); // rowid 3: logged while W2 was dead
  const { w: w3, events } = watcher(db.file, { clock, previous: fileOfW2 });
  w3.tick();
  w3.close();
  db.close();
  const g = events.find((e) => e.event === 'gap');
  assert.deepEqual([g.requests, g.fallbacks, g.rowids], [2, 2, [[1, 3]]]);
  assert.equal(g.since, `${new Date(start - 55000).toISOString().slice(0, 16)}Z`);
});

test('no gap report without a dead predecessor', () => {
  const db = makeDb();
  const clock = { t: Date.now() };
  db.add(clock.t - 60000, 2);
  db.close();
  const { w, events } = watcher(db.file, { clock });
  w.tick();
  w.close();
  assert.deepEqual(events, []);
});

// --- second review round --------------------------------------------------------------------

test('a pane that tags its requests is never marked `? shared` by another pane\'s untagged request', () => {
  const db = makeDb();
  const clock = { t: Date.now() };
  const herdr = herdrWith(['w1:p1', 'w1:p2'], ['w1:p1', 'w1:p2']);
  const { w } = watcher(db.file, { clock, herdr });
  w.tick();
  clock.t += 5000;
  db.add(clock.t - 300, 2, 'w1:p1'); // p1 tags: exact
  db.add(clock.t - 200, 1, null); // p2's untagged request, while both work
  const r = w.tick();
  w.close();
  db.close();
  assert.equal(r.shared, 1, 'attribution itself is unchanged: still shared');
  assert.equal(lastRoute(herdr, 'w1:p1'), 'FALLBACK step 2 · p/b', 'p1 keeps its exact state, and its alert styling');
  assert.equal(lastRoute(herdr, 'w1:p2'), '? shared with another pane');
});

test('a tick that throws after reading puts the cursor back: the rows are read again, not skipped', () => {
  const db = makeDb();
  const clock = { t: Date.now() };
  const { w, events } = watcher(db.file, { clock });
  w.tick();
  db.add(clock.t + 4800, 2);
  const real = dbModule.loadCombos;
  dbModule.loadCombos = () => { throw new Error('database is locked'); };
  try {
    clock.t += 61000; // the combo reload is due
    assert.throws(() => w.tick(), /locked/);
  } finally {
    dbModule.loadCombos = real;
  }
  clock.t += 5000;
  w.tick();
  w.close();
  db.close();
  assert.deepEqual(events.map((e) => e.event), ['degraded'], 'paged on the retry');
});

test('startPlan: a running watcher makes a new one leave; its own pid in the file is a dead predecessor', () => {
  assert.deepEqual(startPlan(null, 5), { previous: null });
  assert.deepEqual(startPlan({ pid: 7, running: true }, 5), { exit: 'watcher already running (pid 7)' });
  const dead = { pid: 7, running: false, seen: 3 };
  assert.deepEqual(startPlan(dead, 5), { previous: dead });
  assert.deepEqual(startPlan({ pid: 5, running: true, seen: 3, beat: 1 }, 5), { previous: { pid: 5, running: false, seen: 3, beat: 1 } },
    'pid reused within the 2-minute beat window: still a predecessor');
});

test('--stop keeps a gap nobody reported, as a stopped file that adds no gap of its own', () => {
  assert.equal(fileAfterStop(null), null);
  assert.equal(fileAfterStop({ pid: 1, beat: 9, seen: 3 }), null, 'nothing unreported: delete');
  assert.equal(fileAfterStop({ pid: 1, beat: 9, seen: 3, gaps: [[1, 3]], gapSince: 5 }, { forget: true }), null, 'unconfigure forgets');
  const kept = fileAfterStop({ pid: 1, beat: 9, seen: 3, tickAt: 8, pending: [3], gaps: [[1, 3]], gapSince: 5 });
  assert.deepEqual(kept, { pid: 1, beat: 9, stopped: true, gaps: [[1, 3]], gapSince: 5 });
  assert.deepEqual(inheritGaps({ ...kept, running: false }, 50), { gaps: [[1, 3]], since: 5 }, 'the carried range only: the stopped time was deliberate');
  assert.deepEqual(inheritGaps({ ...kept, seen: 3, pending: [2], running: false }, 50), { gaps: [[1, 3]], since: 5 }, 'even if a stopped file carried a position');
  assert.deepEqual(carryForward({ ...kept, running: false }), { gaps: [[1, 3]], gapSince: 5 });
});

test('inheritGaps: undecided rows named in `pending` are counted one by one', () => {
  assert.deepEqual(inheritGaps({ pid: 1, beat: 2000, tickAt: 1500, seen: 10, pending: [7, 9, 'x', 11] }, 10), { gaps: [[6, 7], [8, 9]], since: 1500 },
    'a pending rowid above seen is junk');
});

test('transitionLines: one line when the watcher goes blind or comes back, none while it stays', () => {
  const iso = '2026-11-01T00:00:00.000Z';
  assert.deepEqual(transitionLines({}, {}, iso), []);
  assert.match(transitionLines({}, { skippedSince: 1 }, iso)[0], /list failing/);
  assert.deepEqual(transitionLines({ skippedSince: 1 }, { skippedSince: 1 }, iso), []);
  assert.match(transitionLines({ skippedSince: 1 }, {}, iso)[0], /back/);
  assert.match(transitionLines({}, { writeFailingSince: 1 }, iso)[0], /rejects badge writes/);
  assert.match(transitionLines({ writeFailingSince: 1 }, {}, iso)[0], /accepts badge writes again/);
});

test('progress records a blind watcher: Herdr lists failing, or every badge write rejected', () => {
  const db = makeDb();
  const clock = { t: Date.now() };
  db.add(clock.t - 1000, 1);
  const herdr = fakeHerdr();
  let lists = true;
  let writes = true;
  const panes = herdr.panes;
  herdr.panes = () => (lists ? panes() : null);
  herdr.reportMetadata = () => writes;
  const { w } = watcher(db.file, { clock, herdr });
  lists = false;
  w.tick();
  assert.equal(w.progress().skippedSince, clock.t);
  clock.t += 5000;
  lists = true;
  writes = false;
  w.tick();
  assert.equal(w.progress().skippedSince, undefined);
  assert.equal(w.progress().writeFailingSince, clock.t);
  clock.t += 5000;
  writes = true;
  w.tick();
  w.close();
  db.close();
  assert.equal(w.progress().writeFailingSince, undefined);
});

test('call_logs emptied while the watcher runs: it reads the table again from the start, and new fallbacks page', () => {
  const db = makeDb();
  const clock = { t: Date.now() };
  for (let i = 0; i < 5; i++) db.add(clock.t - 60000 + i, 1);
  const errors = [];
  const { w, events } = watcher(db.file, { clock, errors });
  w.tick();
  db.purge();
  clock.t += 5000;
  db.add(clock.t - 200, 2); // rowid 1 again
  w.tick();
  w.close();
  db.close();
  assert.deepEqual(events.map((e) => e.event), ['degraded']);
  assert.match(errors.join('\n'), /call_logs was emptied/);
});

test('call_logs emptied while no watcher ran: everything it holds now is the gap, flagged as a reset', () => {
  const db = makeDb();
  const start = Date.now();
  for (let i = 0; i < 5; i++) db.add(start - 60 * 60000 + i, 1);
  const seen = db.maxRowid();
  db.purge();
  db.add(start - 10 * 60000, 2); // rowid 1, after the purge
  const { w, events, pages } = watcher(db.file, { clock: { t: start }, previous: { pid: 1, beat: start - 30 * 60000, tickAt: start - 30 * 60000, seen, seenId: 'r5', running: false } });
  w.tick();
  w.close();
  db.close();
  const g = events.find((e) => e.event === 'gap');
  assert.deepEqual([g.requests, g.fallbacks, g.reset, g.rowids], [1, 1, true, [[0, 1]]]);
  assert.equal(pages.length, 1);
});

test('a purge refilled past the old position is told apart by the row id at `seen`', () => {
  const db = makeDb();
  const start = Date.now();
  db.add(start - 60 * 60000, 1); // rowid 1, id r1
  db.purge();
  db.bulk([[start - 10 * 60000, 2], [start - 9 * 60000, 1]]); // rowids 1, 2 again, ids r2, r3
  const { w, events } = watcher(db.file, { clock: { t: start }, previous: { pid: 1, beat: start - 30 * 60000, seen: 1, seenId: 'r1', running: false } });
  w.tick();
  w.close();
  db.close();
  const g = events.find((e) => e.event === 'gap');
  assert.deepEqual([g.requests, g.fallbacks, g.reset], [2, 1, true]);
});

test('rows that retention deleted before a restart: the gap says the oldest are gone', () => {
  const db = makeDb();
  const start = Date.now();
  db.bulk([[start - 3 * 86400000, 1], [start - 2 * 86400000, 2], [start - 86400000, 2], [start - 60000, 1]]); // rowids 1..4
  db.deleteUpTo(2); // retention took rowids 1 and 2
  const { w, events } = watcher(db.file, { clock: { t: start }, previous: { pid: 1, beat: start - 3 * 86400000, seen: 1, seenId: 'r1', running: false } });
  w.tick();
  w.close();
  db.close();
  const g = events.find((e) => e.event === 'gap');
  assert.deepEqual([g.requests, g.fallbacks, g.trimmed, g.reset], [2, 1, true, undefined], 'a missing row at `seen` is retention, not a purge');
});

test('a restart after a quiet spell replays nothing, not the newest row however old', () => {
  const db = makeDb();
  const clock = { t: Date.now() };
  db.add(clock.t - 9 * 3600000, 2); // last night's fallback
  db.close();
  const { w, herdr } = watcher(db.file, { clock });
  const r = w.tick();
  w.close();
  assert.equal(r.fresh, 0);
  assert.equal(herdr.calls.length, 0, 'no `stale 9h` badge out of an old row');
});

// --- final review round -------------------------------------------------------------------

const { leaveReason, writeFileAtomic, pidFileState, runningWatcher, stopDaemon } = require('../bin/watch.js');
const PIDFILE = path.join(process.env.HERDR_PLUGIN_STATE_DIR, 'watch.pid');
const quietly = (fn) => {
  const log = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = log; }
};

test('leaveReason: only a file that is gone, stopped or another watcher\'s, and only after this watcher\'s own write landed', () => {
  assert.equal(leaveReason({ missing: true }, 5, true), 'pid file removed');
  assert.equal(leaveReason({ info: { pid: 5, stopped: true } }, 5, true), 'pid file marked stopped');
  assert.equal(leaveReason({ info: { pid: 7 } }, 5, true), 'pid file taken over by pid 7');
  assert.equal(leaveReason({ info: { pid: 5 } }, 5, true), null);
  assert.equal(leaveReason({ error: new Error('EBUSY') }, 5, true), null, 'unreadable for now: stay');
  assert.equal(leaveReason({ missing: true }, 5, false), null, 'own write failed (disk full): the file proves nothing');
  assert.equal(leaveReason({ info: { pid: 7 } }, 5, false), null, 'a predecessor\'s file this watcher could not overwrite yet');
});

test('pid file: an empty or garbled file is unreadable, not missing; writes go through a temp file', () => {
  fs.writeFileSync(PIDFILE, '');
  assert.ok(pidFileState().error && !pidFileState().missing, 'empty');
  fs.writeFileSync(PIDFILE, '{"pid":');
  assert.ok(pidFileState().error, 'garbled');
  fs.writeFileSync(PIDFILE, '{"pid":0}');
  assert.ok(pidFileState().error, 'no valid pid');
  fs.rmSync(PIDFILE);
  assert.deepEqual(pidFileState(), { missing: true });
  assert.equal(writeFileAtomic(PIDFILE, '{"pid":1}'), true);
  assert.equal(fs.readFileSync(PIDFILE, 'utf8'), '{"pid":1}');
  assert.deepEqual(fs.readdirSync(path.dirname(PIDFILE)).filter((f) => f.endsWith('.tmp')), [], 'no temp file left');
  fs.rmSync(PIDFILE);
});

test('runningWatcher never counts the caller\'s own pid: a reused pid is a dead predecessor\'s file', () => {
  fs.writeFileSync(PIDFILE, JSON.stringify({ pid: process.pid, beat: Date.now(), seen: 3 }));
  const info = runningWatcher();
  fs.rmSync(PIDFILE);
  assert.equal(info.running, false);
  assert.equal(info.alive, false);
});

test('--stop --forget removes even an unreadable pid file; --stop alone leaves it', () => {
  fs.writeFileSync(PIDFILE, '');
  quietly(() => stopDaemon());
  assert.equal(fs.existsSync(PIDFILE), true);
  quietly(() => stopDaemon({ forget: true }));
  assert.equal(fs.existsSync(PIDFILE), false);
});

test('a purge refilled past the read position is caught live by the row id at `seen`; only new rows page', () => {
  const db = makeDb();
  const clock = { t: Date.now() };
  for (let i = 0; i < 3; i++) db.add(clock.t - 60000 + i, 1, 'w1:p1');
  const herdr = fakeHerdr(['w1:p1', 'w1:p2']);
  const errors = [];
  const { w, events } = watcher(db.file, { clock, herdr, errors });
  w.tick();
  db.purge();
  db.add(clock.t - 3600000, 2, 'w1:p2'); // refilled with an old row: history, never pages
  db.add(clock.t - 3500000, 1, 'w1:p2');
  db.add(clock.t - 3400000, 1, 'w1:p2');
  clock.t += 5000;
  db.add(clock.t - 200, 2, 'w1:p1'); // rowid 4: past the old cursor (3), and new
  w.tick();
  w.close();
  db.close();
  assert.match(errors.join('\n'), /call_logs was emptied \(row 3 is not the one read before\)/);
  assert.deepEqual(events.map((e) => `${e.event}:${e.pane}`), ['degraded:w1:p1']);
});

test('an inherited gap keeps its reset flag and an anchor on the way to a successor', () => {
  const db = makeDb();
  const start = Date.now();
  for (let i = 0; i < 5; i++) db.add(start - 60 * 60000 + i, 1);
  const seen = db.maxRowid();
  db.purge();
  db.add(start - 10 * 60000, 2); // rowid 1 again, id r6
  const real = dbModule.loadRowsInRange;
  dbModule.loadRowsInRange = () => { throw new Error('locked'); };
  let file;
  try {
    const { w } = watcher(db.file, { clock: { t: start }, previous: { pid: 1, beat: start - 30 * 60000, seen, seenId: 'r5', running: false } });
    for (let i = 0; i < 3; i++) w.tick(); // the gap read fails three times: it stays for a successor
    file = { pid: 2, beat: start, running: false, ...w.progress() };
    w.close();
  } finally {
    dbModule.loadRowsInRange = real;
  }
  assert.equal(file.gapReset, true);
  assert.deepEqual(file.gapAnchor, [1, 'r6']);
  const stopped = fileAfterStop(file);
  assert.deepEqual([stopped.gapReset, stopped.gapAnchor], [true, [1, 'r6']]);
  const { w: w2, events } = watcher(db.file, { clock: { t: start }, previous: file });
  w2.tick();
  w2.close();
  assert.deepEqual(events.map((e) => [e.event, e.reset, e.fallbacks]), [['gap', true, 1]], 'still says the log was emptied');
  db.purge(); // and again, under the carried ranges this time
  db.add(start, 1);
  const moved = inheritGaps(stopped, 1, (r) => (r === 1 ? 'r7' : null));
  db.close();
  assert.deepEqual(moved, { gaps: [], since: null, reset: true }, 'the anchor row is another one: the carried ranges mean nothing now');
});

test('one pane whose writes Herdr keeps rejecting keeps the warning up while other panes write fine', () => {
  const db = makeDb();
  const clock = { t: Date.now() };
  db.add(clock.t - 2000, 1, 'w1:p1');
  db.add(clock.t - 1000, 1, 'w1:p2');
  const herdr = fakeHerdr(['w1:p1', 'w1:p2']);
  herdr.reportMetadata = (paneId) => paneId !== 'w1:p1';
  const { w } = watcher(db.file, { clock, herdr });
  w.tick();
  const since = w.progress().writeFailingSince;
  assert.equal(since, clock.t);
  for (let i = 0; i < 8; i++) { clock.t += 5000; w.tick(); } // p2 refreshes in between
  assert.equal(w.progress().writeFailingSince, since, 'no flapping, no moving "since"');
  herdr.reportMetadata = () => true;
  clock.t += 5000;
  w.tick();
  w.close();
  db.close();
  assert.equal(w.progress().writeFailingSince, undefined);
});

test('a pane that tagged requests once is never marked `? shared`, however long ago that was', () => {
  const db = makeDb();
  const clock = { t: Date.now() };
  const herdr = herdrWith(['w1:p1', 'w1:p2'], ['w1:p1']);
  const { w } = watcher(db.file, { clock, herdr });
  w.tick();
  clock.t += 5000;
  db.add(clock.t - 200, 1, 'w1:p1');
  w.tick();
  clock.t += 40 * 60000; // 40 quiet minutes: p1 is stale
  herdr.working = new Set(['w1:p1', 'w1:p2']);
  w.tick();
  clock.t += 5000;
  db.add(clock.t - 200, 2, null); // p2's untagged request while both work
  w.tick();
  w.close();
  db.close();
  assert.match(lastRoute(herdr, 'w1:p1'), /^stale 40m · ok · p\/a$/);
  assert.equal(lastRoute(herdr, 'w1:p2'), '? shared with another pane');
});

// Discussion #5400 follow-up (antropos17): a watcher that is alive but cannot see must never keep a
// route on screen as if it were current. Neither branch of a blind tick writes a badge, so the last
// one lapses at its TTL and the pane goes blank ("no watcher that can see").
test('a live but blind watcher (Herdr list or database failing) refreshes no badge, so the last one lapses', () => {
  const { TTL_MS } = require('../bin/watch.js');
  const db = makeDb();
  const clock = { t: Date.now() };
  db.add(clock.t - 1000, 1);
  const herdr = fakeHerdr();
  let lists = true;
  const panes = herdr.panes;
  herdr.panes = () => (lists ? panes() : null);
  const { w } = watcher(db.file, { clock, herdr });
  w.tick();
  assert.equal(lastRoute(herdr, 'w1:p1'), 'ok · p/a');
  const healthy = herdr.calls.length;
  lists = false;
  for (let t = 0; t < 2 * TTL_MS; t += 5000) { clock.t += 5000; w.tick(); }
  assert.equal(herdr.calls.length, healthy, 'no write while Herdr cannot be listed');
  lists = true;
  const real = dbModule.loadRowsAfter;
  dbModule.loadRowsAfter = () => { throw new Error('database is locked'); };
  try {
    for (let t = 0; t < 2 * TTL_MS; t += 5000) { clock.t += 5000; assert.throws(() => w.tick(), /locked/); }
  } finally {
    dbModule.loadRowsAfter = real;
  }
  assert.equal(herdr.calls.length, healthy, 'no write while the database cannot be read');
  clock.t += 5000;
  w.tick();
  w.close();
  db.close();
  assert.equal(herdr.calls.length, healthy + 1, 'sight back: the badge is written again (the fake does record writes)');
});

// Same follow-up: restart catch-up reports the gap once and never places its untagged requests on
// a pane, not even on the one that is working at restart (no poll recorded who worked back then).
test('restart catch-up: untagged gap requests are counted once and placed on no pane, even one working now', () => {
  const start = Date.now();
  const db = makeDb();
  db.add(start - 40 * 60000, 1, null);
  const seen = db.maxRowid();
  db.bulk([[start - 10 * 60000, 2, null], [start - 9 * 60000, null, null, 502]]);
  const clock = { t: start };
  const previous = { pid: 1, beat: start - 20 * 60000 + 3000, tickAt: start - 20 * 60000, seen, running: false };
  const herdr = herdrWith(['w1:p1', 'w1:p2'], ['w1:p1']);
  const { w, events, pages } = watcher(db.file, { clock, previous, herdr });
  for (let i = 0; i < 3; i++) { w.tick(); clock.t += 5000; }
  const gaps = events.filter((e) => e.event === 'gap');
  assert.equal(gaps.length, 1, 'reported once over several ticks');
  assert.deepEqual([gaps[0].requests, gaps[0].fallbacks, gaps[0].failed], [2, 1, 1]);
  assert.equal(gaps[0].pane, undefined, 'the gap names no pane');
  assert.deepEqual(pages, gaps);
  assert.deepEqual(herdr.calls, [], 'no badge from the gap: neither pane gets its requests');
  // Not vacuous: the working pane is visible to correlation, so a live untagged fallback lands on it.
  db.add(clock.t - 200, 2, null);
  w.tick();
  w.close();
  db.close();
  assert.match(lastRoute(herdr, 'w1:p1'), /^FALLBACK\* step 2/);
  assert.deepEqual(events.filter((e) => e.event !== 'gap').map((e) => [e.pane, e.inferred]), [['w1:p1', true]]);
  assert.equal(events.filter((e) => e.event === 'gap').length, 1, 'still once');
});
