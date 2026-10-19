// The one block this plugin writes into Herdr's config.toml: the Agent sidebar rows (Herdr's
// defaults plus a `$route` line styled by its first word), fenced by marker lines.
//
// Rules, each one a lesson from a pre-publish review that broke the first version:
// - Markers count only as whole lines, and exactly one START followed by one END is a fence.
//   Any other combination (orphan START from an interrupted write, two fences, END first) is
//   refused: guessing which bytes are "ours" is how a user's tables got deleted.
// - Bytes outside the fence are never rewritten. The file is handled as latin1 so invalid
//   UTF-8 survives, the block uses the file's own line ending, and the separator added before
//   the fence is recorded inside it so `uninstall` restores the original bytes exactly.
// - Writes are atomic (temp file + rename) and preceded by a uniquely named backup.
// - A hand-written agents layout (any spelling TOML allows) is refused, not merged.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { herdrConfigPath, PLUGIN_ID } = require('./paths.js');

const START = `# >>> ${PLUGIN_ID} >>> managed by the ${PLUGIN_ID} plugin; edits inside this fence are overwritten`;
const END = `# <<< ${PLUGIN_ID} <<<`;
const JOIN_PREFIX = `# ${PLUGIN_ID} join: `;

const BLOCK_LINES = [
  '[ui.sidebar.agents]',
  'row_gap = 0',
  'rows = [',
  '  ["state_icon", "machine", "workspace", "tab"],',
  '  ["agent"],',
  '  [{ token = "$route", dim = true, rules = [',
  '    { starts_with = "FAILED", fg = "#ff5555", bold = true, dim = false },',
  '    { starts_with = "ERROR", fg = "#ff5555", dim = false },',
  '    { starts_with = "FALLBACK", fg = "#ffb000", bold = true, dim = false },',
  '    { starts_with = "DEGRADED", fg = "#ffb000", dim = false },',
  '  ] }],',
  ']',
];

const BOM = 'ï»¿'; // UTF-8 BOM as latin1 characters

// The fenced block in a given line ending. `join` is the separator install added before it
// (recorded so uninstall can take exactly that back out).
function renderBlock(eol, join) {
  const joinTag = join === eol + eol ? 'blank' : join === eol ? 'newline' : 'none';
  return [START, `${JOIN_PREFIX}${joinTag}`, ...BLOCK_LINES, END].join(eol) + eol;
}
const BLOCK = renderBlock('\n', '');

function readBytes(file) {
  try {
    return fs.readFileSync(file).toString('latin1');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function detectEol(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

// Line-anchored marker positions: [{ kind: 'start'|'end', index, end }], where `end` includes
// the line terminator.
function markerLines(text) {
  const out = [];
  let pos = 0;
  while (pos < text.length) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl < 0 ? text.length : nl + 1;
    const line = text.slice(pos, nl < 0 ? text.length : nl).replace(/\r$/, '');
    if (line === START) out.push({ kind: 'start', index: pos, end: lineEnd });
    else if (line === END) out.push({ kind: 'end', index: pos, end: lineEnd });
    pos = lineEnd;
  }
  return out;
}

// { state: 'absent' | 'fenced' | 'broken', start, end, reason }
function fence(text) {
  const marks = markerLines(text);
  if (marks.length === 0) return { state: 'absent' };
  const starts = marks.filter((x) => x.kind === 'start');
  const ends = marks.filter((x) => x.kind === 'end');
  if (starts.length === 1 && ends.length === 1 && starts[0].index < ends[0].index) {
    return { state: 'fenced', start: starts[0].index, end: ends[0].end };
  }
  return {
    state: 'broken',
    reason: `found ${starts.length} start and ${ends.length} end marker line(s)${starts.length === 1 && ends.length === 1 ? ' in the wrong order' : ''}`,
  };
}

// --- hand-written layout detection -----------------------------------------------------------

// Strip a TOML comment that is not inside a string. Good enough for headers and keys.
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\' && quote === '"') { i++; continue; }
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

// "ui . \"sidebar\" . 'agents'" -> ["ui", "sidebar", "agents"]
function keyPath(raw) {
  const parts = [];
  const re = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(\.|$)/y;
  let m;
  let pos = 0;
  while (pos < raw.length) {
    re.lastIndex = pos;
    m = re.exec(raw);
    if (!m) return null;
    parts.push(m[1] ?? m[2] ?? m[3]);
    pos = re.lastIndex;
    if (m[4] === '') break;
  }
  return parts;
}

const startsWithPath = (p, prefix) => prefix.every((seg, i) => p[i] === seg);

// True when the text (outside our fence) defines anything under ui.sidebar.agents: a table or
// array-of-tables header, a dotted key, or an inline table, in any spelling TOML allows.
function definesAgentsLayout(text) {
  let table = [];
  let multiline = null;
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine;
    if (multiline) {
      const close = line.indexOf(multiline);
      if (close < 0) continue;
      line = line.slice(close + 3);
      multiline = null;
    }
    const open = line.match(/("""|''')/);
    if (open && line.indexOf(open[1], open.index + 3) < 0) {
      multiline = open[1];
      line = line.slice(0, open.index);
    }
    line = stripComment(line).trim();
    if (!line) continue;
    const header = line.match(/^\[\[?(.*?)\]\]?$/);
    if (header) {
      table = keyPath(header[1]) || [];
      if (startsWithPath(table, ['ui', 'sidebar', 'agents'])) return true;
      continue;
    }
    const kv = line.match(/^((?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_.\s-])+?)\s*=/);
    if (!kv) continue;
    const key = keyPath(kv[1].trim());
    if (!key) continue;
    if (startsWithPath([...table, ...key], ['ui', 'sidebar', 'agents'])) return true;
  }
  return false;
}

function outsideFence(text) {
  const f = fence(text);
  return f.state === 'fenced' ? text.slice(0, f.start) + text.slice(f.end) : text;
}

// --- writes ----------------------------------------------------------------------------------

let backupSeq = 0;
function backup(file) {
  const stamp = `${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 18)}-${process.pid}-${backupSeq++}`;
  const target = `${file}.bak-before-${PLUGIN_ID}-${stamp}`;
  fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL);
  return target;
}

function writeAtomic(file, latin1Text) {
  const tmp = `${file}.${PLUGIN_ID}-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, Buffer.from(latin1Text, 'latin1'), { flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

// Commit `next` over `file` (backed up first when it exists). Errors become a result, never
// an exception: the caller is a plugin action whose only output is this message.
function commit(file, existed, next, message) {
  let saved = null;
  try {
    if (existed) saved = backup(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeAtomic(file, next);
    return { changed: true, message, backup: saved };
  } catch (err) {
    if (saved) { try { fs.rmSync(saved, { force: true }); } catch { /* keep it */ } }
    return { changed: false, message: `failed to write ${file}: ${err.code || 'error'}; nothing was changed` };
  }
}

function install(file = herdrConfigPath()) {
  let text;
  try { text = readBytes(file); } catch (err) { return { changed: false, message: `cannot read ${file}: ${err.code || 'error'}` }; }
  const existed = text !== null;
  text = text ?? '';
  const f = fence(text);
  if (f.state === 'broken') {
    return { changed: false, message: `refused: ${file} has a damaged ${PLUGIN_ID} fence (${f.reason}); fix or remove the marker lines by hand` };
  }
  if (definesAgentsLayout(outsideFence(text))) {
    return { changed: false, message: `refused: ${file} already defines [ui.sidebar.agents]; add a [{ token = "$route" }] row to it yourself` };
  }
  const eol = detectEol(text);
  let next;
  if (f.state === 'fenced') {
    const join = joinOf(text.slice(f.start, f.end), eol);
    next = text.slice(0, f.start) + renderBlock(eol, join) + text.slice(f.end);
    if (next === text) return { changed: false, message: 'already installed' };
    return commit(file, existed, next, 'refreshed');
  }
  const body = text.startsWith(BOM) ? text.slice(BOM.length) : text;
  const join = body === '' ? '' : text.endsWith(eol) || text.endsWith('\n') ? eol : eol + eol;
  next = text + join + renderBlock(eol, join);
  return commit(file, existed, next, 'installed');
}

function joinOf(fenceText, eol) {
  const m = fenceText.match(new RegExp(`^${escapeRe(JOIN_PREFIX)}(blank|newline|none)\\r?$`, 'm'));
  const tag = m ? m[1] : 'blank';
  return tag === 'blank' ? eol + eol : tag === 'newline' ? eol : '';
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function uninstall(file = herdrConfigPath()) {
  let text;
  try { text = readBytes(file); } catch (err) { return { changed: false, message: `cannot read ${file}: ${err.code || 'error'}` }; }
  if (text === null) return { changed: false, message: 'not installed' };
  const f = fence(text);
  if (f.state === 'absent') return { changed: false, message: 'not installed' };
  if (f.state === 'broken') {
    return { changed: false, message: `refused: ${file} has a damaged ${PLUGIN_ID} fence (${f.reason}); remove the marker lines by hand` };
  }
  const eol = detectEol(text);
  // `join` was written as `eol` or `eol+eol`; for the newline case the last line's own
  // terminator was already present, so only the extra one comes back out.
  const join = joinOf(text.slice(f.start, f.end), eol);
  let before = text.slice(0, f.start);
  if (join && before.endsWith(join)) before = before.slice(0, before.length - join.length);
  else if (join === eol + eol && before.endsWith(eol)) before = before.slice(0, before.length - eol.length);
  const next = before + text.slice(f.end);
  return commit(file, true, next, 'removed');
}

function status(file = herdrConfigPath()) {
  const text = readBytes(file) ?? '';
  const f = fence(text);
  return {
    file,
    installed: f.state === 'fenced',
    broken: f.state === 'broken' ? f.reason : null,
    handWritten: definesAgentsLayout(outsideFence(text)),
  };
}

module.exports = { BLOCK, START, END, install, uninstall, status, fence, definesAgentsLayout, renderBlock };
