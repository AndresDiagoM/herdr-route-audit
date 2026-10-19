// Paging the operator on a routing incident. Telegram only for now, through the bot and chat
// that herdr-telegram-agents already uses (copied once by `bin/telegram.js --from-telegram-agents`).
//
// The bot token is a secret and the request path is `/bot<token>/...`, so anything that may echo
// the path (a proxy's error description, a Node error message) is never returned raw: `reason`
// is built from an allow-list and then redacted. `sendTelegram` never throws or rejects, and it
// has a hard deadline, not just a socket idle timeout.
'use strict';

const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { pluginConfigDir } = require('./paths.js');

const CONFIG_NAME = 'notify.json';
const DEADLINE_MS = 15000;
const MAX_BODY = 64 * 1024;
const TOKEN_RE = /^\d{1,20}:[A-Za-z0-9_-]{20,100}$/;

const configPath = () => path.join(pluginConfigDir(), CONFIG_NAME);

// { telegram: { bot_token, chat_id, message_thread_id? } } or null when not configured.
function loadConfig(file = configPath()) {
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    const t = cfg && cfg.telegram;
    if (!t || typeof t.bot_token !== 'string' || !t.bot_token || t.chat_id === undefined) return null;
    return cfg;
  } catch {
    return null;
  }
}

function saveConfig(cfg, file = configPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return file;
}

function removeConfig(file = configPath()) {
  try { fs.rmSync(file); return true; } catch { return false; }
}

// The text for one watcher event. Short: it lands on a phone.
function formatEvent(event) {
  const who = event.agent ? `${event.agent} (${event.pane})` : event.pane;
  if (event.event === 'degraded') {
    const how = event.state === 'FAILED' ? 'FAILED' : `FALLBACK step ${event.step}`;
    return `⚠️ route-audit: ${who} on ${event.combo} → ${how} · ${event.served_by || '?'}`;
  }
  if (event.event === 'recovered') {
    return `✅ route-audit: ${who} on ${event.combo} back on step 1 · ${event.served_by || '?'}`;
  }
  return `route-audit: ${who} on ${event.combo} → ${event.state}`;
}

// Remove every spelling of the token, and the whole bot path, from a string.
function redact(text, token) {
  let out = String(text);
  for (const needle of [token, encodeURIComponent(token)]) {
    if (needle) out = out.split(needle).join('***');
  }
  return out.replace(/\/bot[^/\s"']*/g, '/bot***');
}

// Telegram's own descriptions are short sentences ("Bad Request: chat not found"); anything else
// (an HTML page, a proxy banner) is reduced to the status code.
function safeDescription(value) {
  if (typeof value !== 'string') return '';
  const s = value.slice(0, 120);
  return /^[\w ,.:;'()\-]+$/.test(s) ? s : '';
}

const NODE_CODE = /^(E[A-Z0-9_]{2,40}|ERR_[A-Z0-9_]{2,60}|UND_ERR_[A-Z0-9_]{2,40})$/;

// POST sendMessage. Always resolves: { ok: true, message_id } or { ok: false, reason }.
function sendTelegram(telegram, text, { host = 'api.telegram.org', deadlineMs = DEADLINE_MS } = {}) {
  const token = telegram && typeof telegram.bot_token === 'string' ? telegram.bot_token : '';
  return new Promise((resolve) => {
    let settled = false;
    let req = null;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (req) req.destroy();
      if (!result.ok) result = { ok: false, reason: redact(result.reason, token) };
      resolve(result);
    };
    try {
      if (!TOKEN_RE.test(token)) return finish({ ok: false, reason: 'invalid bot token in notify.json' });
      const chatId = telegram.chat_id;
      if (!(typeof chatId === 'number' && Number.isSafeInteger(chatId)) && !(typeof chatId === 'string' && /^(-?\d{1,20}|@\w{3,64})$/.test(chatId))) {
        return finish({ ok: false, reason: 'invalid chat_id in notify.json' });
      }
      const thread = telegram.message_thread_id;
      const body = JSON.stringify({
        chat_id: chatId,
        text: String(text).slice(0, 4000),
        ...(Number.isSafeInteger(thread) && thread > 0 ? { message_thread_id: thread } : {}),
      });
      timer = setTimeout(() => finish({ ok: false, reason: 'deadline exceeded' }), deadlineMs);
      req = https.request(
        {
          host,
          method: 'POST',
          path: `/bot${token}/sendMessage`,
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
          timeout: deadlineMs,
        },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            data += chunk;
            if (data.length > MAX_BODY) finish({ ok: false, reason: `HTTP ${res.statusCode}: response too large` });
          });
          res.on('error', () => finish({ ok: false, reason: `HTTP ${res.statusCode}: response error` }));
          res.on('end', () => {
            let parsed = null;
            try { parsed = JSON.parse(data); } catch { /* not json */ }
            if (res.statusCode === 200 && parsed && parsed.ok) {
              finish({ ok: true, message_id: parsed.result && parsed.result.message_id });
            } else {
              const desc = safeDescription(parsed && parsed.description);
              finish({ ok: false, reason: `HTTP ${res.statusCode}${desc ? `: ${desc}` : ''}` });
            }
          });
        }
      );
      req.on('timeout', () => finish({ ok: false, reason: 'timeout' }));
      req.on('error', (err) => finish({ ok: false, reason: err && NODE_CODE.test(String(err.code)) ? err.code : 'request failed' }));
      req.end(body);
    } catch (err) {
      finish({ ok: false, reason: err && NODE_CODE.test(String(err.code)) ? err.code : 'request failed' });
    }
  });
}

// Send one watcher event if notifications are configured. Returns the send result or null.
async function notifyEvent(event, cfg = loadConfig()) {
  if (!cfg || !cfg.telegram) return null;
  return sendTelegram(cfg.telegram, formatEvent(event));
}

module.exports = { CONFIG_NAME, configPath, loadConfig, saveConfig, removeConfig, formatEvent, sendTelegram, notifyEvent, redact };
