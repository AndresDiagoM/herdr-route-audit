// Where this plugin's files live, and which `herdr` binary to call.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PLUGIN_ID = 'route-audit';

// Herdr injects HERDR_BIN_PATH into plugin commands; a bare shell run relies on PATH.
function herdrBinary() {
  return process.env.HERDR_BIN_PATH || 'herdr';
}

function herdrConfigPath() {
  const base =
    process.platform === 'win32'
      ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
      : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'herdr', 'config.toml');
}

// Herdr's state directory (not its config directory). Same layout herdr-radar uses.
function herdrStateDir() {
  if (process.env.XDG_STATE_HOME) return path.join(process.env.XDG_STATE_HOME, 'herdr');
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'herdr');
  }
  return path.join(os.homedir(), '.local', 'state', 'herdr');
}

// The directory Herdr allots this plugin when it starts our commands; the same place when run
// from a bare shell, so the watcher and the actions agree on pid and cursor files.
function stateRoot() {
  const dir = process.env.HERDR_PLUGIN_STATE_DIR || path.join(herdrStateDir(), 'plugins', PLUGIN_ID);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const stateFile = (name) => path.join(stateRoot(), name);

module.exports = { PLUGIN_ID, herdrBinary, herdrConfigPath, herdrStateDir, stateRoot, stateFile };
