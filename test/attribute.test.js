'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { paneFromTag, attribute, tokenText, transition } = require('../lib/attribute.js');

const panes = ['w9:p35', 'w9:p36'];

test('paneFromTag accepts the bare id, herdr: prefix, and an appended session', () => {
  assert.equal(paneFromTag('w9:p35', panes), 'w9:p35');
  assert.equal(paneFromTag('herdr:w9:p36', panes), 'w9:p36');
  assert.equal(paneFromTag('w9:p35:ses_abc', panes), 'w9:p35');
  assert.equal(paneFromTag('conv_1234', panes), null);
  assert.equal(paneFromTag('w9:p3', panes), null, 'a prefix of a pane id is not that pane');
  assert.equal(paneFromTag(null, panes), null);
});

const t0 = Date.parse('2026-10-16T18:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const row = (endMs, over) => ({ timestamp: iso(endMs), duration: 5000, session_tag: 'conv_x', combo_name: 'c', ...over });

test('attribute: tagged rows go to their pane regardless of state history', () => {
  const r = attribute([row(t0, { session_tag: 'w9:p36' })], panes, []);
  assert.equal(r.byPane.get('w9:p36').length, 1);
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
  assert.equal(r.shared.length, 0);
  assert.equal(r.unattributed.length, 0);
});

test('attribute: two working panes make the row shared, none makes it unattributed', () => {
  const both = [{ t: t0 - 1000, working: new Set(['w9:p35', 'w9:p36']) }];
  const r1 = attribute([row(t0)], panes, both, { slackMs: 1000 });
  assert.equal(r1.byPane.size, 0);
  assert.deepEqual(r1.shared[0].candidates.sort(), panes);
  const r2 = attribute([row(t0)], panes, [{ t: t0 - 60000, working: new Set(['w9:p35']) }], { slackMs: 1000 });
  assert.equal(r2.unattributed.length, 1);
});

test('attribute: a pane that is gone is never a candidate', () => {
  const history = [{ t: t0 - 1000, working: new Set(['w9:p35', 'w9:p99']) }];
  const r = attribute([row(t0)], panes, history, { slackMs: 1000 });
  assert.equal(r.byPane.get('w9:p35').length, 1);
});

test('tokenText puts the state first and stays under 80 chars', () => {
  assert.equal(tokenText({ state: 'PRIMARY', lastLabel: 'claude/claude-sonnet-5-5' }), 'ok · claude/claude-sonnet-5-5');
  assert.equal(tokenText({ state: 'FALLBACK', lastStep: 2, lastLabel: 'antigravity/claude-opus-4-6-thinking' }), 'FALLBACK step 2 · antigravity/claude-opus-4-6-thinking');
  assert.match(tokenText({ state: 'DEGRADED', windowFallbacks: 2, windowFailed: 1, window: 10, lastLabel: 'x' }), /^DEGRADED 2 fb\/1 fail in 10 · x$/);
  const long = tokenText({ state: 'FALLBACK', lastStep: 3, lastLabel: 'p'.repeat(100) });
  assert.equal(long.length, 80);
  assert.equal(tokenText(null), null);
});

test('transition: into trouble and back out, nothing else', () => {
  assert.equal(transition('PRIMARY', 'FALLBACK'), 'degraded');
  assert.equal(transition(undefined, 'FAILED'), 'degraded');
  assert.equal(transition('FALLBACK', 'PRIMARY'), 'recovered');
  assert.equal(transition('FALLBACK', 'FAILED'), null);
  assert.equal(transition('PRIMARY', 'DEGRADED'), null);
  assert.equal(transition('FALLBACK', 'DEGRADED'), null);
});
