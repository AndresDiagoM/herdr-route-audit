'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const notify = require('../lib/notify.js');

const TOKEN = '123456:FAKE-SECRET-TOKEN-abcdefghijklmnop';
const tg = (over = {}) => ({ bot_token: TOKEN, chat_id: -1001, ...over });
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'route-audit-notify-')), 'notify.json');
const noLeak = (reason) => {
  assert.ok(!reason.includes('FAKE-SECRET-TOKEN'), `token leaked: ${reason}`);
  assert.ok(!reason.includes(encodeURIComponent(TOKEN)), `encoded token leaked: ${reason}`);
  assert.ok(!/\/bot[^*]/.test(reason), `bot path leaked: ${reason}`);
};

// Replace https.request for one call with a fake that plays a scripted response or error.
function withFakeRequest(script, fn) {
  const real = https.request;
  https.request = (opts, onResponse) => {
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => setImmediate(() => script(req, onResponse, opts));
    return req;
  };
  return Promise.resolve(fn()).finally(() => { https.request = real; });
}
function respond(status, body) {
  return (req, onResponse) => {
    const res = new EventEmitter();
    res.statusCode = status;
    res.setEncoding = () => {};
    onResponse(res);
    res.emit('data', body);
    res.emit('end');
  };
}

test('formatEvent: degraded names the pane, combo, step and model; recovered says step 1', () => {
  const ev = { event: 'degraded', pane: 'w9:p35', agent: 'builder', combo: 'sonnet-combo', state: 'FALLBACK', step: 2, served_by: 'claude/claude-sonnet-5' };
  assert.equal(notify.formatEvent(ev), '⚠️ route-audit: builder (w9:p35) on sonnet-combo → FALLBACK step 2 · claude/claude-sonnet-5');
  assert.equal(notify.formatEvent({ ...ev, state: 'FAILED', served_by: '(no step served)' }), '⚠️ route-audit: builder (w9:p35) on sonnet-combo → FAILED · (no step served)');
  assert.equal(notify.formatEvent({ ...ev, agent: null, event: 'recovered', state: 'PRIMARY', step: 1, served_by: 'claude/claude-sonnet-5-5' }), '✅ route-audit: w9:p35 on sonnet-combo back on step 1 · claude/claude-sonnet-5-5');
});

test('config round-trip; incomplete or missing config loads as null', () => {
  const file = tmpFile();
  assert.equal(notify.loadConfig(file), null);
  notify.saveConfig({ telegram: tg() }, file);
  assert.deepEqual(notify.loadConfig(file).telegram, tg());
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

test('success returns the message id', async () => {
  await withFakeRequest(respond(200, JSON.stringify({ ok: true, result: { message_id: 42 } })), async () => {
    assert.deepEqual(await notify.sendTelegram(tg(), 'hi'), { ok: true, message_id: 42 });
  });
});

// F2: every failure path the reviewer used to leak the token.
for (const [name, script] of [
  ['proxy description echoes the path', respond(404, JSON.stringify({ ok: false, description: `no route /bot${TOKEN}/sendMessage` }))],
  ['error with message and no code', (req) => req.emit('error', new Error(`getaddrinfo failed for path /bot${TOKEN}/sendMessage`))],
  ['socket hang up naming the path', (req) => req.emit('error', Object.assign(new Error(`socket hang up at /bot${TOKEN}`), { code: `weird /bot${TOKEN}` }))],
  ['HTML error page', respond(502, `<html>bad gateway for /bot${TOKEN}/sendMessage</html>`)],
  ['URL-encoded token in description', respond(400, JSON.stringify({ ok: false, description: `path ${encodeURIComponent(TOKEN)}` }))],
]) {
  test(`no token in the failure reason: ${name}`, async () => {
    await withFakeRequest(script, async () => {
      const r = await notify.sendTelegram(tg(), 'hi');
      assert.equal(r.ok, false);
      noLeak(r.reason);
    });
  });
}

test("Telegram's own short description is kept", async () => {
  await withFakeRequest(respond(400, JSON.stringify({ ok: false, description: 'Bad Request: chat not found' })), async () => {
    assert.equal((await notify.sendTelegram(tg(), 'hi')).reason, 'HTTP 400: Bad Request: chat not found');
  });
});

test('a real DNS failure reports only the error code', async () => {
  const r = await notify.sendTelegram(tg(), 'hi', { host: 'invalid.' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^E[A-Z]+$|^request failed$/);
  noLeak(r.reason);
});

// F12: malformed config resolves, never rejects or throws.
for (const [name, cfg] of [
  ['token with a space', tg({ bot_token: '123:abc def' })],
  ['token with a newline', tg({ bot_token: '123:abc\ndef' })],
  ['BigInt chat id', tg({ chat_id: 1n })],
  ['object chat id', tg({ chat_id: { x: 1 } })],
  ['missing telegram', undefined],
]) {
  test(`sendTelegram resolves on malformed config: ${name}`, async () => {
    const r = await notify.sendTelegram(cfg, 'hi');
    assert.equal(r.ok, false);
    assert.match(r.reason, /invalid/);
  });
}

// F13: a server that drips bytes cannot hold the call past its deadline.
test('a dripping server is cut off at the deadline', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    const t = setInterval(() => res.write('x'), 50);
    res.on('close', () => clearInterval(t));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const realRequest = https.request;
  https.request = (opts, cb) => http.request({ ...opts, host: '127.0.0.1', port: server.address().port }, cb);
  try {
    const started = Date.now();
    const r = await notify.sendTelegram(tg(), 'hi', { deadlineMs: 400 });
    assert.equal(r.ok, false);
    assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
    assert.match(r.reason, /deadline|timeout/);
  } finally {
    https.request = realRequest;
    server.closeAllConnections();
    server.close();
  }
});

test('an oversized body stops the read instead of consuming it', async () => {
  await withFakeRequest((req, onResponse) => {
    const res = new EventEmitter();
    res.statusCode = 200;
    res.setEncoding = () => {};
    onResponse(res);
    for (let i = 0; i < 100; i++) res.emit('data', 'y'.repeat(4096));
    res.emit('end');
  }, async () => {
    const r = await notify.sendTelegram(tg(), 'hi');
    assert.equal(r.ok, false);
    assert.match(r.reason, /too large/);
  });
});
