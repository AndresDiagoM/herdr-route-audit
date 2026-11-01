'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classify, idSuffix, summarizeRows, episodes, perComboSteps } = require('../lib/audit.js');

const combo = {
  strategy: 'priority',
  models: [
    { id: 'c-model-1-claude-claude-sonnet-5-5-conn', model: 'claude/claude-sonnet-5-5' },
    { id: 'c-model-3-claude-claude-sonnet-5-conn', model: 'claude/claude-sonnet-5' },
  ],
};
const combos = new Map([['c', combo]]);
const row = (over) => ({ timestamp: '2026-10-16T18:00:00.000Z', combo_name: 'c', combo_step_id: combo.models[0].id, status: 200, session_tag: 's1', provider: 'claude', model: 'claude-sonnet-5-5', ...over });

test('step 1 of a priority combo is PRIMARY, labelled with the combo model', () => {
  assert.deepEqual(classify(row({}), combo), { outcome: 'PRIMARY', step: 1, error: false, label: 'claude/claude-sonnet-5-5' });
});

test('a later listed step is FALLBACK even when it returns 200; position, not id suffix, decides', () => {
  const c = classify(row({ combo_step_id: combo.models[1].id, provider: 'claude', model: 'claude-sonnet-5' }), combo);
  assert.equal(c.outcome, 'FALLBACK');
  assert.equal(c.step, 2, 'the -model-3- id sits at position 2 today');
});

// F7: a step the combo no longer lists is labelled from the row, never from today's step n.
test('an unlisted step is HISTORICAL and labelled with what the row says served it', () => {
  const c = classify(row({ combo_step_id: 'c-model-2-antigravity-claude-sonnet-4-6', provider: 'antigravity', model: 'claude-sonnet-4-6' }), combo);
  assert.equal(c.outcome, 'HISTORICAL');
  assert.equal(c.step, null);
  assert.equal(c.idStep, 2);
  assert.equal(c.label, 'antigravity/claude-sonnet-4-6', 'not "claude/claude-sonnet-5" (today\'s step 2)');
});

test('a deleted combo is never guessed to be priority', () => {
  for (const id of ['gone-model-1-x-y', 'gone-model-2-x-y']) {
    const c = classify(row({ combo_name: 'gone', combo_step_id: id, provider: 'x', model: 'y' }), undefined);
    assert.equal(c.outcome, 'HISTORICAL');
    assert.equal(c.label, 'x/y');
  }
});

test('idSuffix is anchored to the combo name and bounded', () => {
  assert.equal(idSuffix({ combo_name: 'my-model-3-combo', combo_step_id: 'my-model-3-combo-model-1-a-b' }), 1);
  assert.equal(idSuffix({ combo_name: 'c', combo_step_id: 'c-model-0-a' }), null);
  assert.equal(idSuffix({ combo_name: 'c', combo_step_id: 'c-model-99999999999999999999-a' }), null);
  assert.equal(idSuffix({ combo_name: 'c', combo_step_id: 'opaque' }), null);
});

test('no step + error is FAILED; no step + 499 is UNKNOWN, never FAILED', () => {
  assert.equal(classify(row({ combo_step_id: null, status: 502 }), combo).outcome, 'FAILED');
  assert.equal(classify(row({ combo_step_id: null, status: 499 }), combo).outcome, 'UNKNOWN');
  assert.equal(classify(row({ combo_step_id: null, status: 200 }), combo).outcome, 'UNKNOWN');
});

test('non-priority combos never report FALLBACK', () => {
  const rr = { strategy: 'round-robin', models: combo.models };
  assert.equal(classify(row({ combo_step_id: combo.models[1].id }), rr).outcome, 'ANY');
});

test('summarizeRows: last request decides, window marks DEGRADED', () => {
  const rows = [
    row({ timestamp: '2026-10-16T18:05:00.000Z', combo_step_id: combo.models[1].id, status: 502 }),
    row({ timestamp: '2026-10-16T18:05:01.000Z', combo_step_id: combo.models[1].id }),
    row({ timestamp: '2026-10-16T18:09:00.000Z' }),
  ];
  const t = summarizeRows(rows, combos);
  assert.equal(t.state, 'DEGRADED');
  assert.equal(t.windowFallbacks, 2);
  assert.equal(t.lastLabel, 'claude/claude-sonnet-5-5');
  const t2 = summarizeRows(rows.slice(0, 2), combos);
  assert.equal(t2.state, 'FALLBACK');
  assert.equal(t2.lastStep, 2);
});

// F15: a session whose last decisive request was a step-1 error is not "ok".
test('a step-1 error as the last request is ERROR, not PRIMARY', () => {
  const t = summarizeRows([row({}), row({ timestamp: '2026-10-16T18:01:00.000Z', status: 502 })], combos);
  assert.equal(t.state, 'ERROR');
  assert.equal(t.lastStep, 1);
});

test('a trailing 499 does not hide the previous outcome', () => {
  const t = summarizeRows([
    row({ combo_step_id: combo.models[1].id }),
    row({ timestamp: '2026-10-16T18:00:01.000Z', combo_step_id: null, status: 499 }),
  ], combos);
  assert.equal(t.state, 'FALLBACK');
});

test('episodes: consecutive fallbacks collapse into one stretch per tag and combo', () => {
  const rows = [
    row({ timestamp: '2026-10-16T18:05:00.000Z', combo_step_id: combo.models[1].id, status: 502 }),
    row({ timestamp: '2026-10-16T18:05:01.000Z', combo_step_id: combo.models[1].id }),
    row({ timestamp: '2026-10-16T18:07:00.000Z' }),
    row({ timestamp: '2026-10-16T18:09:00.000Z', combo_step_id: null, status: 400 }),
    row({ timestamp: '2026-10-16T18:09:01.000Z', combo_step_id: combo.models[1].id }),
    row({ timestamp: '2026-10-16T18:11:00.000Z', combo_step_id: combo.models[1].id }),
  ];
  const eps = episodes(rows, combos);
  assert.equal(eps.length, 2);
  assert.equal(eps[0].start, '2026-10-16T18:09:00.000Z');
  assert.equal(eps[0].count, 3);
  assert.equal(eps[0].errors, 1);
  assert.deepEqual(eps[0].steps.map(String).sort(), ['2', 'none']);
  assert.equal(eps[1].count, 2);
});

test('perComboSteps: listed steps in order, then historical, then no-step; errors counted', () => {
  const rows = [
    row({}), row({}),
    row({ combo_step_id: combo.models[1].id, status: 429 }),
    row({ combo_step_id: 'c-model-2-antigravity-claude-sonnet-4-6', provider: 'antigravity', model: 'claude-sonnet-4-6' }),
    row({ combo_step_id: null, status: 502 }), row({ combo_step_id: null, status: 499 }),
  ];
  const [c] = perComboSteps(rows, combos);
  assert.deepEqual(c.steps.map((s) => [s.step, s.historical, s.label, s.count, s.errors, s.outcome]), [
    [1, false, 'claude/claude-sonnet-5-5', 2, 0, 'PRIMARY'],
    [2, false, 'claude/claude-sonnet-5', 1, 1, 'FALLBACK'],
    [null, true, 'antigravity/claude-sonnet-4-6', 1, 0, 'HISTORICAL'],
    [null, false, '(no step served)', 2, 1, 'FAILED'],
  ]);
});

test('summarizeRows: inferred when any row in the window was attributed by correlation', () => {
  const tagged = (ts) => row({ timestamp: ts, attributed: 'tag' });
  const guessed = (ts) => row({ timestamp: ts, attributed: 'correlated' });
  assert.equal(summarizeRows([tagged('2026-10-16T18:00:00.000Z'), tagged('2026-10-16T18:00:01.000Z')], combos).inferred, false);
  assert.equal(summarizeRows([guessed('2026-10-16T18:00:00.000Z'), tagged('2026-10-16T18:00:01.000Z')], combos).inferred, true,
    'an older guessed row still counts: ok means "no fallback in the whole window"');
  const old = [guessed('2026-10-16T17:00:00.000Z')];
  for (let i = 0; i < 10; i++) old.push(tagged(`2026-10-16T18:00:${String(i).padStart(2, '0')}.000Z`));
  assert.equal(summarizeRows(old, combos).inferred, false, 'a guessed row that left the window no longer counts');
  assert.equal('inferred' in summarizeRows([row({})], combos), false, 'report.js rows carry no attribution: no flag at all');
});
