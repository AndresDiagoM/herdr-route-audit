#!/usr/bin/env node
// Install, refresh or remove the managed [ui.sidebar.agents] block that shows the $route badge.
//
//   node bin/configure.js [--apply | --uninstall | --status] [--reload]
'use strict';

const managed = require('../lib/managed-config.js');
const herdr = require('../lib/herdr.js');

const args = new Set(process.argv.slice(2));
const reload = args.has('--reload');

function finish(result) {
  console.log(`config.toml: ${result.message}${result.backup ? ` (backup: ${result.backup})` : ''}`);
  if (result.changed && reload) console.log(`herdr reload-config: ${herdr.reloadConfig() ? 'ok' : 'failed (reload manually)'}`);
  process.exit(result.changed || /already|not installed/.test(result.message) ? 0 : 1);
}

if (args.has('--uninstall')) finish(managed.uninstall());
else if (args.has('--status')) {
  const s = managed.status();
  console.log(`${s.file}\n  managed block: ${s.installed ? 'installed' : 'absent'}\n  hand-written [ui.sidebar.agents]: ${s.handWritten ? 'yes (blocks install)' : 'no'}`);
} else if (args.has('--apply')) finish(managed.install());
else {
  console.error('usage: configure.js --apply|--uninstall|--status [--reload]');
  process.exit(2);
}
