// Paging the operator on a routing transition. Telegram only for now, through the bot and chat
// that herdr-telegram-agents already uses (copied once by `bin/telegram.js --from-telegram-agents`).
// The bot token is a secret: it never appears in logs, errors or thrown messages.
'use strict';

const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { pluginConfigDir } = require('./paths.js');

const CONFIG_NAME = 'notify.json';
const TIMEOUT_MS = 10000;

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

// POST sendMessage. Resolves { ok: true, message_id } or { ok: false, reason } — never throws,
// never includes the token or the URL in `reason`.
function sendTelegram(telegram, text, { host = 'api.telegram.org' } = {}) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      chat_id: telegram.chat_id,
      text: String(text).slice(0, 4000),
      ...(telegram.message_thread_id ? { message_thread_id: telegram.message_thread_id } : {}),
    });
    const req = https.request(
      {
        host,
        method: 'POST',
        path: `/bot${telegram.bot_token}/sendMessage`,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { if (data.length < 64 * 1024) data += chunk; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(data); } catch { /* not json */ }
          if (res.statusCode === 200 && parsed && parsed.ok) {
            resolve({ ok: true, message_id: parsed.result && parsed.result.message_id });
          } else {
            const desc = parsed && typeof parsed.description === 'string' ? parsed.description.slice(0, 120) : '';
            resolve({ ok: false, reason: `HTTP ${res.statusCode}${desc ? `: ${desc}` : ''}` });
          }
        });
      }
    );
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (err) => resolve({ ok: false, reason: err.code || err.message || 'request failed' }));
    req.end(body);
  });
}

// Send one watcher event if notifications are configured. Returns the send result or null.
async function notifyEvent(event, cfg = loadConfig()) {
  if (!cfg || !cfg.telegram) return null;
  return sendTelegram(cfg.telegram, formatEvent(event));
}

module.exports = { CONFIG_NAME, configPath, loadConfig, saveConfig, removeConfig, formatEvent, sendTelegram, notifyEvent };
