'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { paneFromTag, attribute, tokenText, staleText, sharedText, formatAge, parseTime } = require('../lib/attribute.js');

const panes = ['w9:p35', 'w9:p36'];

test('paneFromTag accepts the bare id, herdr: prefix, and an appended session', () => {
  assert.equal(paneFromTag('w9:p35', panes), 'w9:p35');
  assert.equal(paneFromTag('herdr:w9:p36', panes), 'w9:p36');
  assert.equal(paneFromTag('w9:p35:ses_abc', panes), 'w9:p35');
  assert.equal(paneFromTag('conv_1234', panes), null);
  assert.equal(paneFromTag('w9:p3', panes), null, 'a prefix of a pane id is not that pane');
  assert.equal(paneFromTag(null, panes), null);
});

test('paneFromTag: the longest matching id wins whatever the list order', () => {
  assert.equal(paneFromTag('w1:p1:x:y', ['w1:p1', 'w1:p1:x']), 'w1:p1:x');
  assert.equal(paneFromTag('w1:p1:x:y', ['w1:p1:x', 'w1:p1']), 'w1:p1:x');
});

const t0 = Date.parse('2026-10-16T18:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const row = (endMs, over) => ({ timestamp: iso(endMs), duration: 5000, session_tag: 'conv_x', combo_name: 'c', ...over });

test('attribute: tagged rows go to their pane regardless of state history', () => {
  const r = attribute([row(t0, { session_tag: 'w9:p36' })], panes, []);
  assert.equal(r.byPane.get('w9:p36')[0].attributed, 'tag');
});

test('attribute: an untagged row goes to the one pane working while it ran', () => {
  const history = [
    { t: t0 - 20000, working: new Set(['w9:p35']) },
    { t: t0 - 3000, working: new Set(['w9:p35']) },
    { t: t0 + 2000, working: new Set([]) },
  ];
  const r = attribute([row(t0)], panes, history, { slackMs: 1000 });
  assert.equal(r.byPane.get('w9:p35')[0].attributed, 'correlated');
});

// F9: a pane-shaped tag naming a closed pane is never handed to another pane.
test('attribute: a tag naming a closed pane is dropped, not correlated to whoever is working', () => {
  const history = [{ t: t0 - 1000, working: new Set(['w9:p35']) }];
  const r = attribute([row(t0, { session_tag: 'wB:p99' }), row(t0, { session_tag: 'herdr:wB:p99:ses' })], panes, history, { slackMs: 1000 });
  assert.equal(r.byPane.size, 0);
  assert.equal(r.orphanTagged.length, 2);
});

test('attribute: two working panes make the row shared, none makes it unattributed', () => {
  const both = [{ t: t0 - 1000, working: new Set(['w9:p35', 'w9:p36']) }];
  const r1 = attribute([row(t0)], panes, both, { slackMs: 1000 });
  assert.equal(r1.byPane.size, 0);
  assert.deepEqual(r1.shared[0].candidates.sort(), panes);
  const r2 = attribute([row(t0)], panes, [{ t: t0 - 60000, working: new Set(['w9:p35']) }], { slackMs: 1000 });
  assert.equal(r2.unattributed.length, 1);
});

test('attribute: unusable timestamps are unattributed, not matched against epoch 0', () => {
  const history = [{ t: 0, working: new Set(['w9:p35']) }, { t: 5, working: new Set(['w9:p35']) }];
  for (const timestamp of ['not a time', '2026-10-18 09:00:00', '', null]) {
    const r = attribute([{ timestamp, duration: 0, session_tag: 'conv' }], panes, history, { slackMs: 10 ** 13 });
    assert.equal(r.unattributed.length, 1, String(timestamp));
  }
  assert.ok(Number.isNaN(parseTime('2026-10-18 09:00:00')), 'zone-less times are rejected (they would be read as local time)');
});

test('attribute: a huge duration is capped instead of spanning the whole history', () => {
  const history = [{ t: t0 - 3 * 3600 * 1000, working: new Set(['w9:p36']) }, { t: t0 - 1000, working: new Set(['w9:p35']) }];
  const r = attribute([row(t0, { duration: 1e12 })], panes, history, { slackMs: 1000 });
  assert.equal(r.byPane.get('w9:p35').length, 1);
});

test('attribute: an unsorted history (clock stepped back) still finds the candidate', () => {
  const history = [{ t: t0 + 60000, working: new Set([]) }, { t: t0 - 1000, working: new Set(['w9:p35']) }];
  const r = attribute([row(t0)], panes, history, { slackMs: 1000 });
  assert.equal(r.byPane.get('w9:p35').length, 1);
});

test('attribute: a pane that is gone is never a candidate', () => {
  const r = attribute([row(t0)], panes, [{ t: t0 - 1000, working: new Set(['w9:p35', 'w9:p99']) }], { slackMs: 1000 });
  assert.equal(r.byPane.get('w9:p35').length, 1);
});

test('tokenText puts the state first, stays under 80 code points, and strips control characters', () => {
  assert.equal(tokenText({ state: 'PRIMARY', lastLabel: 'claude/claude-sonnet-5-5' }), 'ok · claude/claude-sonnet-5-5');
  assert.equal(tokenText({ state: 'FALLBACK', lastStep: 2, lastLabel: 'antigravity/claude-opus-4-6-thinking' }), 'FALLBACK step 2 · antigravity/claude-opus-4-6-thinking');
  assert.equal(tokenText({ state: 'ERROR', lastStep: 1, lastLabel: 'x' }), 'ERROR step 1 · x');
  assert.equal(tokenText({ state: 'DEGRADED', windowFallbacks: 2, windowFailed: 1, window: 10, lastLabel: 'x' }), 'DEGRADED 2 fb/1 fail in last 10 · x');
  assert.equal(tokenText({ state: 'PRIMARY', lastLabel: 'a\nb\u0007c' }), 'ok · a b c');
  const long = tokenText({ state: 'FALLBACK', lastStep: 3, lastLabel: '😀'.repeat(100) });
  assert.equal([...long].length, 80);
  assert.equal(tokenText(null), null);
});

// Discussion #5400: a pane found by correlation (the only one working) must not read as sure.
// Herdr 0.9.5's default sidebar (26 columns) leaves 22 for the row, 21 when the agent list shows a
// scrollbar, and truncate_end then keeps 20 characters plus "…". So the marker is glued to the
// state word, and every variant must show both within 20 characters.
const VISIBLE = 20;
test('tokenText: an inferred pane is marked right on the state word, inside the first 20 columns', () => {
  const s = (o) => tokenText({ lastLabel: 'claude/claude-sonnet-5-5', window: 10, ...o, inferred: true });
  assert.equal(s({ state: 'FALLBACK', lastStep: 2 }), 'FALLBACK* step 2 · claude/claude-sonnet-5-5');
  assert.equal(s({ state: 'PRIMARY' }), 'ok* · claude/claude-sonnet-5-5');
  assert.equal(s({ state: 'FAILED', lastLabel: '(no step served)' }), 'FAILED* · (no step served)');
  assert.equal(s({ state: 'ERROR', lastStep: 1 }), 'ERROR* step 1 · claude/claude-sonnet-5-5');
  assert.equal(s({ state: 'DEGRADED', windowFallbacks: 2, windowFailed: 1 }), 'DEGRADED* 2 fb/1 fail in last 10 · claude/claude-sonnet-5-5');
  assert.equal(s({ state: 'UNKNOWN' }), '?* · claude/claude-sonnet-5-5');
  for (const state of ['FALLBACK', 'PRIMARY', 'FAILED', 'ERROR', 'DEGRADED', 'UNKNOWN']) {
    const visible = s({ state, lastStep: 2, windowFallbacks: 2, windowFailed: 1 }).slice(0, VISIBLE);
    assert.match(visible, /^(FALLBACK|ok|FAILED|ERROR|DEGRADED|\?)\*/, `${state}: state and marker visible in "${visible}"`);
  }
  assert.equal(tokenText({ state: 'PRIMARY', lastLabel: 'p/a', inferred: false }), 'ok · p/a');
  assert.equal(tokenText({ state: 'PRIMARY', lastLabel: 'p/a' }), 'ok · p/a', 'no flag (report.js rows): no marker');
  const long = tokenText({ state: 'FALLBACK', lastStep: 3, lastLabel: 'x'.repeat(100), inferred: true });
  assert.equal([...long].length, 80);
  assert.match(long, /^FALLBACK\* step 3 · x+…$/);
});

test('formatAge: seconds, minutes, hours up to two days, then days', () => {
  assert.equal(formatAge(-5), '0s');
  assert.equal(formatAge(59 * 1000), '59s');
  assert.equal(formatAge(60 * 1000), '1m');
  assert.equal(formatAge(34 * 60 * 1000 + 59 * 1000), '34m');
  assert.equal(formatAge(3600 * 1000), '1h');
  assert.equal(formatAge(47 * 3600 * 1000), '47h');
  assert.equal(formatAge(48 * 3600 * 1000), '2d');
});

test('staleText says how old the evidence is, keeps the previous state visible, never claims "idle"', () => {
  assert.equal(staleText('FALLBACK step 2 · p/b', 34 * 60 * 1000), 'stale 34m · FALLBACK step 2 · p/b');
  assert.equal(staleText('ok* · p/a', 5 * 3600 * 1000), 'stale* 5h · ok · p/a', 'the marker moves up to `stale*`');
  assert.equal(staleText('?* · x', 31 * 60 * 1000), 'stale* 31m · ? · x');
  assert.equal(staleText(null, 40 * 60 * 1000), 'stale 40m · ? shared', 'a pane only ever seen sharing requests');
  for (const prev of ['FALLBACK* step 2 · p/b', 'DEGRADED* 2 fb/1 fail in last 10 · x', 'ERROR* step 1 · x', 'FAILED* · (no step served)']) {
    const visible = staleText(prev, 31 * 60 * 1000).slice(0, VISIBLE);
    assert.match(visible, /^stale\* 31m · [A-Z]+/, `marker and state visible in "${visible}"`);
  }
  assert.equal(staleText('a*b · x', 31 * 60 * 1000), 'stale 31m · a*b · x', 'only a marker glued to the end of the state word moves');
  const long = staleText(tokenText({ state: 'FALLBACK', lastStep: 2, lastLabel: 'y'.repeat(100) }), 60 * 60 * 1000);
  assert.equal([...long].length, 80);
  assert.match(long, /^stale 1h · FALLBACK step 2 · y+…$/);
  assert.doesNotMatch(long.slice(0, -1), /…/, 'one ellipsis, at the end');
});

test('sharedText: the route is unknown now, whatever the pane showed before', () => {
  assert.equal(sharedText('ok* · p/a'), '? shared · ok* · p/a');
  assert.equal(sharedText(null), '? shared with another pane');
  for (const prev of ['FALLBACK* step 2 · p/b', 'DEGRADED* 2 fb/1 fail in last 10 · x']) {
    assert.match(sharedText(prev).slice(0, VISIBLE), /^\? shared · [A-Z]+\*$/, 'the longest states keep their marker at column 20');
  }
  assert.equal([...sharedText(`ok · ${'z'.repeat(100)}`)].length, 80);
});
