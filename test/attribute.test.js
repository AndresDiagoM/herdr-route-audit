'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { paneFromTag, attribute, tokenText, parseTime } = require('../lib/attribute.js');

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
