'use strict';
// Herdr's `pane report-metadata` prints nothing on success (Output::Quiet in Herdr 0.9.x), so
// success is the exit status. Treating "no output" as failure made every write look failed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const herdr = require('../lib/herdr.js');

// `herdr` is node itself, run from a directory holding a script named `pane`: `node pane
// report-metadata …` runs it. It prints nothing and exits with FAKE_HERDR_EXIT.
function withFakeHerdr(exitCode, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-audit-herdr-'));
  fs.writeFileSync(path.join(dir, 'pane'), 'process.exit(Number(process.env.FAKE_HERDR_EXIT || 0));\n');
  const saved = { cwd: process.cwd(), bin: process.env.HERDR_BIN_PATH, code: process.env.FAKE_HERDR_EXIT };
  process.chdir(dir);
  process.env.HERDR_BIN_PATH = process.execPath;
  process.env.FAKE_HERDR_EXIT = String(exitCode);
  try {
    return fn();
  } finally {
    process.chdir(saved.cwd);
    if (saved.bin === undefined) delete process.env.HERDR_BIN_PATH; else process.env.HERDR_BIN_PATH = saved.bin;
    if (saved.code === undefined) delete process.env.FAKE_HERDR_EXIT; else process.env.FAKE_HERDR_EXIT = saved.code;
  }
}

test('reportMetadata: exit 0 with no output is success; a non-zero exit is failure', () => {
  assert.equal(withFakeHerdr(0, () => herdr.reportMetadata('w1:p1', { route: 'ok · p/a' }, { ttlMs: 60000 })), true);
  assert.equal(withFakeHerdr(1, () => herdr.reportMetadata('w1:p1', { route: 'ok · p/a' }, { ttlMs: 60000 })), false);
  assert.equal(withFakeHerdr(0, () => herdr.call('pane', 'report-metadata', 'w1:p1')), null, 'why call() cannot be used for it');
});

test('reportMetadata: a binary that cannot be started is failure, not a throw', () => {
  const saved = process.env.HERDR_BIN_PATH;
  process.env.HERDR_BIN_PATH = path.join(os.tmpdir(), 'no-such-herdr-binary');
  try {
    assert.equal(herdr.reportMetadata('w1:p1', { route: 'x' }), false);
  } finally {
    if (saved === undefined) delete process.env.HERDR_BIN_PATH; else process.env.HERDR_BIN_PATH = saved;
  }
});
