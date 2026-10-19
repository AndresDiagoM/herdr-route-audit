#!/usr/bin/env node
// Telegram paging setup.
//
//   node bin/telegram.js --from-telegram-agents   copy bot token + chat from herdr-telegram-agents
//   node bin/telegram.js --token T --chat ID [--thread N]
//   node bin/telegram.js --test                   send one message through the saved config
//   node bin/telegram.js --status | --off
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const notify = require('../lib/notify.js');
const { pluginConfigDir } = require('../lib/paths.js');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

function fromTelegramAgents() {
  const file = path.join(pluginConfigDir('permgps.telegram-agents'), 'config.json');
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { ok: false, message: `herdr-telegram-agents config not found or unreadable: ${file}` }; }
  if (typeof cfg.bot_token !== 'string' || !cfg.bot_token || cfg.chat_id === undefined) return { ok: false, message: `no bot_token/chat_id in ${file}` };
  const saved = notify.saveConfig({ telegram: { bot_token: cfg.bot_token, chat_id: cfg.chat_id, source: 'permgps.telegram-agents' } });
  return { ok: true, message: `saved ${saved} (bot @${cfg.bot_username || '?'}, chat "${cfg.chat_title || cfg.chat_id}")` };
}

async function main() {
  if (flag('--from-telegram-agents')) {
    const r = fromTelegramAgents();
    console.log(r.message);
    process.exit(r.ok ? 0 : 1);
  }
  if (value('--token') && value('--chat')) {
    const chat = /^-?\d+$/.test(value('--chat')) ? Number(value('--chat')) : value('--chat');
    const telegram = { bot_token: value('--token'), chat_id: chat };
    if (value('--thread')) telegram.message_thread_id = Number(value('--thread'));
    console.log(`saved ${notify.saveConfig({ telegram })}`);
    return;
  }
  if (flag('--off')) {
    console.log(notify.removeConfig() ? 'telegram paging removed' : 'not configured');
    return;
  }
  if (flag('--status')) {
    const cfg = notify.loadConfig();
    console.log(cfg ? `configured: chat ${cfg.telegram.chat_id}${cfg.telegram.source ? ` (from ${cfg.telegram.source})` : ''} — ${notify.configPath()}` : `not configured (${notify.configPath()})`);
    return;
  }
  if (flag('--test')) {
    const cfg = notify.loadConfig();
    if (!cfg) { console.error('not configured; run --from-telegram-agents or --token/--chat first'); process.exit(1); }
    const r = await notify.sendTelegram(cfg.telegram, `🔔 route-audit: test message (${new Date().toISOString().slice(0, 16)}Z). Fallbacks will be paged here.`);
    console.log(r.ok ? `delivered (message ${r.message_id})` : `failed: ${r.reason}`);
    process.exit(r.ok ? 0 : 1);
  }
  console.error('usage: telegram.js --from-telegram-agents | --token T --chat ID [--thread N] | --test | --status | --off');
  process.exit(2);
}

main();
