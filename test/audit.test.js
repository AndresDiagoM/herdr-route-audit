'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classify, stepIndex, perTag, episodes, perComboSteps } = require('../lib/audit.js');

const combo = {
  strategy: 'priority',
  models: [
    { id: 'c-model-1-claude-claude-sonnet-5-5-conn', model: 'claude/claude-sonnet-5-5' },
    { id: 'c-model-2-antigravity-claude-sonnet-4-6', model: 'antigravity/claude-sonnet-4-6' },
    { id: 'c-model-3-claude-claude-sonnet-5-conn', model: 'claude/claude-sonnet-5' },
  ],
};
const combos = new Map([['c', combo]]);
const row = (over) => ({ timestamp: '2026-10-16T18:00:00.000Z', combo_name: 'c', combo_step_id: combo.models[0].id, status: 200, session_tag: 's1', provider: 'claude', model: 'claude-sonnet-5-5', ...over });

test('step 1 of a priority combo is PRIMARY', () => {
  assert.deepEqual(classify(row({}), combo), { outcome: 'PRIMARY', step: 1, error: false });
});

test('a later step is FALLBACK even when it returns 200', () => {
  const c = classify(row({ combo_step_id: combo.models[1].id }), combo);
  assert.equal(c.outcome, 'FALLBACK');
  assert.equal(c.step, 2);
});

test('step index falls back to the -model-<n>- convention for ids the combo no longer lists', () => {
  assert.equal(stepIndex({ combo_step_id: 'c-model-3-agy-claude-sonnet-4-6' }, combo), 2);
  assert.equal(stepIndex({ combo_step_id: 'opaque' }, combo), null);
});

test('no step + error is FAILED; no step + 499 is UNKNOWN, never FAILED', () => {
  assert.equal(classify(row({ combo_step_id: null, status: 502 }), combo).outcome, 'FAILED');
  assert.equal(classify(row({ combo_step_id: null, status: 499 }), combo).outcome, 'UNKNOWN');
  assert.equal(classify(row({ combo_step_id: null, status: 200 }), combo).outcome, 'UNKNOWN');
});

test('non-priority combos never report FALLBACK', () => {
  const rr = { strategy: 'round-robin', models: combo.models };
  assert.equal(classify(row({ combo_step_id: combo.models[2].id }), rr).outcome, 'ANY');
});

test('unknown combo definition still classifies by id convention', () => {
  assert.equal(classify(row({ combo_name: 'gone' }), undefined).outcome, 'PRIMARY');
  assert.equal(classify(row({ combo_name: 'gone', combo_step_id: 'gone-model-2-x-y' }), undefined).outcome, 'FALLBACK');
});

test('perTag: last request decides, window marks DEGRADED', () => {
  const rows = [
    row({ timestamp: '2026-10-16T18:05:00.000Z', combo_step_id: combo.models[2].id, status: 502 }),
    row({ timestamp: '2026-10-16T18:05:01.000Z', combo_step_id: combo.models[1].id }),
    row({ timestamp: '2026-10-16T18:09:00.000Z' }),
  ];
  const [t] = perTag(rows, combos);
  assert.equal(t.state, 'DEGRADED');
  assert.equal(t.windowFallbacks, 2);
  assert.equal(t.lastLabel, 'claude/claude-sonnet-5-5');
  const [t2] = perTag(rows.slice(0, 2), combos);
  assert.equal(t2.state, 'FALLBACK');
  assert.equal(t2.lastStep, 2);
});

test('episodes: consecutive fallbacks collapse into one stretch per tag and combo', () => {
  const rows = [
    row({ timestamp: '2026-10-16T18:05:00.000Z', combo_step_id: combo.models[2].id, status: 502 }),
    row({ timestamp: '2026-10-16T18:05:01.000Z', combo_step_id: combo.models[1].id }),
    row({ timestamp: '2026-10-16T18:07:00.000Z' }),
    row({ timestamp: '2026-10-16T18:09:00.000Z', combo_step_id: combo.models[2].id, status: 502 }),
    row({ timestamp: '2026-10-16T18:09:01.000Z', combo_step_id: combo.models[1].id }),
    row({ timestamp: '2026-10-16T18:11:00.000Z', combo_step_id: combo.models[2].id }),
  ];
  const eps = episodes(rows, combos);
  assert.equal(eps.length, 2);
  assert.equal(eps[0].start, '2026-10-16T18:09:00.000Z');
  assert.equal(eps[0].count, 3);
  assert.equal(eps[0].errors, 1);
  assert.deepEqual(eps[0].steps.sort(), [2, 3]);
  assert.equal(eps[1].count, 2);
});

test('perComboSteps: counts per step in order, no-step bucket last, errors counted', () => {
  const rows = [
    row({}), row({}), row({ combo_step_id: combo.models[1].id, status: 429 }),
    row({ combo_step_id: null, status: 502 }), row({ combo_step_id: null, status: 499 }),
  ];
  const [c] = perComboSteps(rows, combos);
  assert.deepEqual(c.steps.map((s) => [s.step, s.count, s.errors, s.outcome]), [
    [1, 2, 0, 'PRIMARY'], [2, 1, 1, 'FALLBACK'], [null, 2, 1, 'FAILED'],
  ]);
});
