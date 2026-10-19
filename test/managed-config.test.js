'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const managed = require('../lib/managed-config.js');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'route-audit-')), 'config.toml');
const base = `[ui.toast]\ndelivery = "herdr"\n\n[theme]\nname = "tokyo-night"\n\n[[keys.command]]\nkey = "prefix+shift+u"\ncommand = "wsl-tab.open"\n`;

test('install appends the fenced block once and keeps the rest byte-identical', () => {
  const file = tmp();
  fs.writeFileSync(file, base);
  const r1 = managed.install(file);
  assert.equal(r1.changed, true);
  assert.ok(fs.existsSync(r1.backup), 'a backup is written before the first change');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.startsWith(base.trimEnd()), 'original content untouched');
  assert.equal((text.match(/\[ui\.sidebar\.agents\]/g) || []).length, 1);
  assert.ok(text.includes('$route'));
  const r2 = managed.install(file);
  assert.equal(r2.changed, false);
  assert.equal(r2.message, 'already installed');
});

test('install refuses a hand-written [ui.sidebar.agents] instead of merging', () => {
  const file = tmp();
  fs.writeFileSync(file, `${base}\n[ui.sidebar.agents]\nrows = [["agent"]]\n`);
  const r = managed.install(file);
  assert.equal(r.changed, false);
  assert.match(r.message, /refused/);
  assert.equal(fs.readFileSync(file, 'utf8').includes('$route'), false);
});

test('an edited fence is refreshed, and uninstall restores the original text', () => {
  const file = tmp();
  fs.writeFileSync(file, base);
  managed.install(file);
  const edited = fs.readFileSync(file, 'utf8').replace('"#ff5555"', '"#000000"');
  fs.writeFileSync(file, edited);
  assert.equal(managed.install(file).message, 'refreshed');
  assert.ok(fs.readFileSync(file, 'utf8').includes('"#ff5555"'));
  const r = managed.uninstall(file);
  assert.equal(r.changed, true);
  assert.equal(fs.readFileSync(file, 'utf8'), base);
  assert.equal(managed.uninstall(file).message, 'not installed');
});

test('install on a missing file creates it with only the block', () => {
  const file = tmp();
  const r = managed.install(file);
  assert.equal(r.changed, true);
  assert.equal(r.backup, null);
  assert.equal(fs.readFileSync(file, 'utf8').trim(), managed.BLOCK.trim());
});

test('status reports both the fence and a hand-written table', () => {
  const file = tmp();
  fs.writeFileSync(file, base);
  assert.deepEqual(managed.status(file), { file, installed: false, handWritten: false });
  managed.install(file);
  assert.equal(managed.status(file).installed, true);
});
