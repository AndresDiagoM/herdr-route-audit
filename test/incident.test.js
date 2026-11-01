'use strict';
// F8: one page per incident, the reviewer's scenarios replayed request by request.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { advance, newIncidentState, RECOVERY_CLEAN } = require('../lib/incident.js');

const combo = { strategy: 'priority', models: [{ id: 'c-model-1-a', model: 'p/a' }, { id: 'c-model-2-b', model: 'p/b' }] };
const combos = new Map([['c', combo]]);
let seq = 0;
const req = (kind) => {
  seq += 1;
  const timestamp = new Date(Date.parse('2026-10-19T00:00:00.000Z') + seq * 1000).toISOString();
  if (kind === 1) return { timestamp, combo_name: 'c', combo_step_id: 'c-model-1-a', status: 200 };
  if (kind === 2) return { timestamp, combo_name: 'c', combo_step_id: 'c-model-2-b', status: 200 };
  if (kind === 'fail') return { timestamp, combo_name: 'c', combo_step_id: null, status: 400 };
  if (kind === 'err1') return { timestamp, combo_name: 'c', combo_step_id: 'c-model-1-a', status: 502 };
  if (kind === '499') return { timestamp, combo_name: 'c', combo_step_id: null, status: 499 };
  throw new Error(kind);
};
// Feed one request per "tick" and collect the events.
const run = (kinds, { perTick = 1 } = {}) => {
  const state = newIncidentState();
  const events = [];
  for (let i = 0; i < kinds.length; i += perTick) {
    for (const e of advance(state, kinds.slice(i, i + perTick).map(req), combos)) events.push(e.event);
  }
  return { events, state };
};

test('fallback then steady recovery: one degraded page, one recovered page after the clean streak', () => {
  const { events, state } = run([2, 2, 1, 1, 1, 1]);
  assert.deepEqual(events, ['degraded', 'recovered']);
  assert.equal(state.open, false);
});

test('recovery is announced after RECOVERY_CLEAN clean step-1 requests, not after a full window', () => {
  const { events } = run([2, ...Array(RECOVERY_CLEAN).fill(1)]);
  assert.deepEqual(events, ['degraded', 'recovered']);
  const notYet = run([2, ...Array(RECOVERY_CLEAN - 1).fill(1)]);
  assert.deepEqual(notYet.events, ['degraded']);
});

test('flapping 2,1,2,1,2 is one incident and one page', () => {
  assert.deepEqual(run([2, 1, 2, 1, 2]).events, ['degraded']);
});

test('FALLBACK -> FAILED -> FALLBACK inside one incident does not page again', () => {
  assert.deepEqual(run([2, 'fail', 2, 'fail']).events, ['degraded']);
});

test('a fallback that recovers inside one poll is still paged, then closed', () => {
  const { events } = run([2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], { perTick: 11 });
  assert.deepEqual(events, ['degraded', 'recovered']);
});

test('a step-1 error or a 499 neither opens an incident nor counts toward recovery', () => {
  assert.deepEqual(run(['err1', 'err1', '499']).events, []);
  assert.deepEqual(run([2, 1, 'err1', 1, '499', 1]).events, ['degraded'], 'the err1 reset the streak; 499 did not count');
  assert.deepEqual(run([2, 1, 'err1', 1, '499', 1, 1]).events, ['degraded', 'recovered']);
});

test('a second incident after recovery pages again', () => {
  assert.deepEqual(run([2, 1, 1, 1, 'fail', 1, 1, 1]).events, ['degraded', 'recovered', 'degraded', 'recovered']);
});

// Discussion #5400: a page says "inferred" when a request it rests on was placed by correlation.
test('events carry inferred: the opening request for degraded, any of the clean run for recovered', () => {
  const at = (kind, attributed) => ({ ...req(kind), attributed });
  const state = newIncidentState();
  const open = advance(state, [at(2, 'correlated')], combos);
  assert.deepEqual(open.map((e) => [e.event, e.inferred]), [['degraded', true]]);
  const close = advance(state, [at(1, 'tag'), at(1, 'correlated'), at(1, 'tag')], combos);
  assert.deepEqual(close.map((e) => [e.event, e.inferred]), [['recovered', true]], 'the third clean row is tagged, but the run is not');
  const s2 = newIncidentState();
  const e2 = [...advance(s2, [at(2, 'tag')], combos), ...advance(s2, [at(1, 'correlated'), at('err1', 'tag'), at(1, 'tag'), at(1, 'tag'), at(1, 'tag')], combos)];
  assert.deepEqual(e2.map((e) => [e.event, e.inferred]), [['degraded', false], ['recovered', false]], 'a step-1 error resets the run, and its guess with it');
});
