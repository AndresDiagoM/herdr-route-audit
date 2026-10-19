'use strict';
// The watcher end to end against a temp SQLite file shaped like OmniRoute's, with herdr and
// Telegram faked. Covers F3 (restart never pages history, however long), F8 (one page per
// incident through the real tick), F9 (closed-pane tags) and F14 (idle panes lose their badge).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

process.env.HERDR_PLUGIN_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'route-audit-state-'));
const { Watcher, STALE_MS } = require('../bin/watch.js');

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
  return { file, add, bulk, close: () => db.close() };
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

function watcher(dbFile, { herdr = fakeHerdr(), clock }) {
  const events = [];
  const w = new Watcher({ dbPath: dbFile, herdr, notify: { notifyEvent: async () => null }, now: () => clock.t, onEvent: (e) => events.push(e), log: { log() {}, error() {} } });
  return { w, events, herdr };
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

test('F14: a pane idle for longer than STALE_MS loses its badge', () => {
  const db = makeDb();
  const clock = { t: Date.now() };
  db.add(clock.t - 1000, 2);
  db.close();
  const { w, herdr } = watcher(db.file, { clock });
  w.tick();
  assert.match(herdr.calls.at(-1).tokens.route, /^FALLBACK/);
  clock.t += STALE_MS + 60000;
  const r = w.tick();
  w.close();
  assert.deepEqual(herdr.calls.at(-1), { paneId: 'w1:p1', tokens: { route: null }, opts: undefined });
  assert.equal(r.reports[0].expired, true);
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
