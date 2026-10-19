#!/usr/bin/env node
// Stop the watcher, then remove the managed block and reload. Order matters: a detached watcher
// would keep writing tokens into a sidebar that no longer shows them.
'use strict';

const { spawnSync } = require('node:child_process');
const managed = require('../lib/managed-config.js');
const herdr = require('../lib/herdr.js');

const watch = require.resolve('./watch.js');
const stop = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', watch, '--stop'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
process.stdout.write(stop.stdout || '');
const result = managed.uninstall();
console.log(`config.toml: ${result.message}${result.backup ? ` (backup: ${result.backup})` : ''}`);
if (result.changed) console.log(`herdr reload-config: ${herdr.reloadConfig() ? 'ok' : 'failed (reload manually)'}`);
