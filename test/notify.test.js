'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const notify = require('../lib/notify.js');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'route-audit-notify-')), 'notify.json');

test('formatEvent: degraded names the pane, combo, step and model; recovered says step 1', () => {
  const ev = { event: 'degraded', pane: 'w9:p35', agent: 'builder', combo: 'codigo-5-claude-sonnet', state: 'FALLBACK', step: 2, served_by: 'claude/claude-sonnet-5' };
  assert.equal(notify.formatEvent(ev), '⚠️ route-audit: builder (w9:p35) on codigo-5-claude-sonnet → FALLBACK step 2 · claude/claude-sonnet-5');
  assert.equal(notify.formatEvent({ ...ev, state: 'FAILED', served_by: '(no step served)' }), '⚠️ route-audit: builder (w9:p35) on codigo-5-claude-sonnet → FAILED · (no step served)');
  assert.equal(notify.formatEvent({ ...ev, agent: null, event: 'recovered', state: 'PRIMARY', step: 1, served_by: 'claude/claude-sonnet-5-5' }), '✅ route-audit: w9:p35 on codigo-5-claude-sonnet back on step 1 · claude/claude-sonnet-5-5');
});

test('config round-trip; incomplete or missing config loads as null', () => {
  const file = tmpFile();
  assert.equal(notify.loadConfig(file), null);
  notify.saveConfig({ telegram: { bot_token: '123:abc', chat_id: -100 } }, file);
  assert.deepEqual(notify.loadConfig(file).telegram, { bot_token: '123:abc', chat_id: -100 });
  fs.writeFileSync(file, JSON.stringify({ telegram: { chat_id: 1 } }));
  assert.equal(notify.loadConfig(file), null, 'no token → not configured');
  fs.writeFileSync(file, '{not json');
  assert.equal(notify.loadConfig(file), null);
  assert.equal(notify.removeConfig(file), true);
  assert.equal(notify.removeConfig(file), false);
});

test('notifyEvent without config is a no-op', async () => {
  assert.equal(await notify.notifyEvent({ event: 'degraded', pane: 'x', combo: 'c' }, null), null);
});

test('sendTelegram failure never leaks the token into the reason', async () => {
  // An unroutable host name fails fast at DNS; the reason must be the error code only.
  const r = await notify.sendTelegram({ bot_token: 'SECRET-TOKEN-XYZ', chat_id: 1 }, 'hi', { host: 'invalid.' });
  assert.equal(r.ok, false);
  assert.ok(!/SECRET-TOKEN-XYZ/.test(r.reason), r.reason);
  assert.ok(!/api\.telegram\.org/.test(r.reason), r.reason);
});
