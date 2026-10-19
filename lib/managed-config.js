// The one block this plugin writes into Herdr's config.toml: the Agent sidebar rows (Herdr's
// defaults plus a `$route` line styled by its first word). Fenced by marker comments; nothing
// outside the fence is touched, and a hand-written [ui.sidebar.agents] is refused, not merged.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { herdrConfigPath, PLUGIN_ID } = require('./paths.js');

const START = `# >>> ${PLUGIN_ID} >>> managed by the ${PLUGIN_ID} plugin; edits inside this fence are overwritten`;
const END = `# <<< ${PLUGIN_ID} <<<`;

const BLOCK = `${START}
[ui.sidebar.agents]
row_gap = 0
rows = [
  ["state_icon", "machine", "workspace", "tab"],
  ["agent"],
  [{ token = "$route", dim = true, rules = [
    { starts_with = "FAILED", fg = "#ff5555", bold = true, dim = false },
    { starts_with = "FALLBACK", fg = "#ffb000", bold = true, dim = false },
    { starts_with = "DEGRADED", fg = "#ffb000", dim = false },
  ] }],
]
${END}
`;

function readConfig(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

function fenceRange(text) {
  const s = text.indexOf(START);
  if (s < 0) return null;
  const e = text.indexOf(END, s);
  if (e < 0) return null;
  return [s, e + END.length];
}

function outsideFence(text) {
  const range = fenceRange(text);
  return range ? text.slice(0, range[0]) + text.slice(range[1]) : text;
}

const hasAgentsTable = (text) => /^\s*\[ui\.sidebar\.agents(\.rows_by_agent)?\]\s*$/m.test(outsideFence(text));

function backup(file) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const target = `${file}.bak-before-${PLUGIN_ID}-${stamp}`;
  fs.copyFileSync(file, target);
  return target;
}

// Install or refresh the block. Returns { changed, message, backup? }.
function install(file = herdrConfigPath()) {
  const text = readConfig(file);
  if (hasAgentsTable(text)) {
    return { changed: false, message: `refused: ${file} already has [ui.sidebar.agents] written by hand; merge the $route row yourself or remove it` };
  }
  const range = fenceRange(text);
  const next = range
    ? text.slice(0, range[0]) + BLOCK.trimEnd() + text.slice(range[1])
    : `${text.replace(/\s*$/, '')}\n\n${BLOCK}`;
  if (next === text) return { changed: false, message: 'already installed' };
  let saved = null;
  if (text) saved = backup(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next, 'utf8');
  return { changed: true, message: range ? 'refreshed' : 'installed', backup: saved };
}

function uninstall(file = herdrConfigPath()) {
  const text = readConfig(file);
  const range = fenceRange(text);
  if (!range) return { changed: false, message: 'not installed' };
  const saved = backup(file);
  // Undo exactly what install added: the blank line before the fence and the newline after it.
  const before = text.slice(0, range[0]).replace(/\n{2,}$/, '\n');
  const after = text.slice(range[1]).replace(/^\n/, '');
  const next = (before + after).replace(/^\n+/, '');
  fs.writeFileSync(file, next, 'utf8');
  return { changed: true, message: 'removed', backup: saved };
}

function status(file = herdrConfigPath()) {
  const text = readConfig(file);
  return { file, installed: fenceRange(text) !== null, handWritten: hasAgentsTable(text) };
}

module.exports = { BLOCK, START, END, install, uninstall, status, fenceRange, hasAgentsTable };
