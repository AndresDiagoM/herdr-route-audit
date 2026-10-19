'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const managed = require('../lib/managed-config.js');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'route-audit-')), 'config.toml');
const base = `[ui.toast]\ndelivery = "herdr"\n\n[theme]\nname = "tokyo-night"\n\n[[keys.command]]\nkey = "prefix+shift+u"\ncommand = "wsl-tab.open"\n`;
const bytes = (file) => fs.readFileSync(file);
const backups = (file) => fs.readdirSync(path.dirname(file)).filter((n) => n.includes('.bak-before-'));

function roundTrip(original) {
  const file = tmp();
  fs.writeFileSync(file, original);
  const before = bytes(file);
  const r1 = managed.install(file);
  assert.equal(r1.changed, true, r1.message);
  const r2 = managed.uninstall(file);
  assert.equal(r2.changed, true, r2.message);
  return { file, before, after: bytes(file) };
}

test('install appends the fenced block once and keeps the rest byte-identical', () => {
  const file = tmp();
  fs.writeFileSync(file, base);
  const r1 = managed.install(file);
  assert.equal(r1.changed, true);
  assert.ok(fs.existsSync(r1.backup), 'a backup is written before the first change');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.startsWith(base), 'original content untouched, including its trailing newline');
  assert.equal((text.match(/\[ui\.sidebar\.agents\]/g) || []).length, 1);
  assert.ok(text.includes('$route'));
  assert.equal(managed.install(file).message, 'already installed');
});

// F11: uninstall must give back the original bytes for every shape of file.
for (const [name, original] of [
  ['LF with trailing newline', base],
  ['LF without trailing newline', base.trimEnd()],
  ['CRLF with trailing newline', base.replace(/\n/g, '\r\n')],
  ['CRLF without trailing newline', base.trimEnd().replace(/\n/g, '\r\n')],
  ['BOM + CRLF', `﻿${base.replace(/\n/g, '\r\n')}`],
  ['three trailing blank lines', `${base}\n\n\n`],
  ['trailing spaces on the last line', `${base.trimEnd()}   \t`],
  ['leading blank lines', `\n\n${base}`],
  ['only a newline', '\n'],
  ['empty file', ''],
]) {
  test(`uninstall restores the original bytes: ${name}`, () => {
    const { before, after } = roundTrip(original);
    assert.deepEqual(after, before);
  });
}

test('invalid UTF-8 outside the fence survives install + uninstall', () => {
  const original = Buffer.concat([Buffer.from(base), Buffer.from([0x0a, 0xff, 0xfe, 0xc3, 0x28, 0x0a])]);
  const { before, after } = roundTrip(original);
  assert.deepEqual(after, before);
});

test('a CRLF config gets a CRLF block, not mixed line endings', () => {
  const file = tmp();
  fs.writeFileSync(file, base.replace(/\n/g, '\r\n'));
  managed.install(file);
  const text = fs.readFileSync(file, 'latin1');
  assert.equal((text.match(/(?<!\r)\n/g) || []).length, 0, 'no bare LF');
});

// F1: an orphan START must never make the plugin treat user config as "inside the fence".
test('an orphan START marker (interrupted write) is refused, and nothing is deleted', () => {
  const file = tmp();
  const orphan = `${managed.START}\n[keys.custom]\nimportant = "do-not-lose-me"\n[other]\nx = 1\n`;
  fs.writeFileSync(file, orphan);
  const s = managed.status(file);
  assert.equal(s.installed, false);
  assert.match(s.broken, /1 start and 0 end/);
  const r = managed.install(file);
  assert.equal(r.changed, false);
  assert.match(r.message, /damaged/);
  assert.equal(managed.uninstall(file).changed, false);
  assert.equal(fs.readFileSync(file, 'utf8'), orphan, 'file untouched');
  assert.equal(backups(file).length, 0, 'no backup litter from a refusal');
});

test('markers quoted inside a comment are not markers', () => {
  const file = tmp();
  const text = `# see ${managed.START} for how it looks\n[keys.custom]\nimportant = "do-not-lose-me"\n# reference: ${managed.END}\n`;
  fs.writeFileSync(file, text);
  assert.equal(managed.status(file).installed, false);
  const r = managed.install(file);
  assert.equal(r.message, 'installed');
  assert.ok(fs.readFileSync(file, 'utf8').startsWith(text), '[keys.custom] kept verbatim');
  managed.uninstall(file);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
});

test('two fences, or END before START, are refused by install and uninstall', () => {
  const block = managed.BLOCK;
  for (const text of [`${base}\n${block}\n${block}`, `${base}${managed.END}\n${managed.START}\n`]) {
    const file = tmp();
    fs.writeFileSync(file, text);
    assert.equal(managed.install(file).changed, false);
    assert.equal(managed.uninstall(file).changed, false);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
});

// F10: every TOML spelling of a hand-written agents layout is refused.
for (const [name, snippet] of [
  ['plain table', '[ui.sidebar.agents]\nrows = [["agent"]]'],
  ['table with trailing comment', '[ui.sidebar.agents] # mine\nrows = [["agent"]]'],
  ['spaces inside brackets', '[ ui.sidebar.agents ]\nrows = [["agent"]]'],
  ['spaces around dots', '[ui . sidebar . agents]\nrows = [["agent"]]'],
  ['quoted keys', '[ui."sidebar".agents]\nrows = [["agent"]]'],
  ['dotted key under [ui.sidebar]', '[ui.sidebar]\nagents.rows = [["agent"]]'],
  ['dotted key under [ui]', '[ui]\nsidebar.agents.rows = [["agent"]]'],
  ['inline table', '[ui.sidebar]\nagents = { rows = [["agent"]] }'],
  ['sub-table', '[ui.sidebar.agents.rows_by_agent.claude]\nrows = [["agent"]]'],
  ['array of tables', '[[ui.sidebar.agents]]\nrows = [["agent"]]'],
  ['CRLF table', '[ui.sidebar.agents]\r\nrows = [["agent"]]'],
]) {
  test(`install refuses a hand-written layout: ${name}`, () => {
    const file = tmp();
    const text = `${base}\n${snippet}\n`;
    fs.writeFileSync(file, text);
    const r = managed.install(file);
    assert.equal(r.changed, false, r.message);
    assert.match(r.message, /refused/);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  });
}

test('things that only look like the agents table do not block install', () => {
  for (const snippet of [
    'note = """\n[ui.sidebar.agents]\n"""',
    '# [ui.sidebar.agents]',
    '[ui.sidebar.spaces]\nrows = [["workspace"]]',
    'title = "[ui.sidebar.agents]"',
  ]) {
    const file = tmp();
    fs.writeFileSync(file, `${base}\n${snippet}\n`);
    assert.equal(managed.install(file).message, 'installed', snippet);
  }
});

test('an edited fence is refreshed in place; uninstall still restores the original', () => {
  const file = tmp();
  fs.writeFileSync(file, base);
  managed.install(file);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"#ff5555", bold', '"#000000", bold'));
  assert.equal(managed.install(file).message, 'refreshed');
  assert.ok(fs.readFileSync(file, 'utf8').includes('"#ff5555", bold'));
  managed.uninstall(file);
  assert.equal(fs.readFileSync(file, 'utf8'), base);
  assert.equal(managed.uninstall(file).message, 'not installed');
});

test('two writes in the same instant keep both backups', () => {
  const file = tmp();
  fs.writeFileSync(file, base);
  managed.install(file);
  managed.uninstall(file);
  managed.install(file);
  assert.equal(backups(file).length, 3);
});

test('a write failure is a result, not an exception, and leaves no backup behind', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-audit-'));
  const file = path.join(dir, 'config.toml');
  fs.mkdirSync(file); // a directory where the file should be: every write fails
  const r = managed.install(file);
  assert.equal(r.changed, false);
  assert.match(r.message, /cannot read|failed to write/);
  assert.equal(fs.readdirSync(dir).filter((n) => n.includes('.bak-before-')).length, 0);
});

test('install on a missing file creates it with only the block', () => {
  const file = tmp();
  const r = managed.install(file);
  assert.equal(r.changed, true);
  assert.equal(r.backup, null);
  assert.ok(fs.readFileSync(file, 'utf8').startsWith(managed.START));
});
