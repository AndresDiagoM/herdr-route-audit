'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runTool, assertSafeArgs } = require('../lib/exec.js');

// A fake npm-style shim: `<name>.cmd` on Windows (`node dump.js %*`), a shell script elsewhere,
// that prints the argv it received as JSON. PATH is pointed at it.
function fakeTool(body = 'console.log(JSON.stringify(process.argv.slice(2)))') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-audit-exec-'));
  fs.writeFileSync(path.join(dir, 'dump.js'), body);
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(dir, 'faketool.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0dump.js" %*\r\n`);
  } else {
    const sh = path.join(dir, 'faketool');
    fs.writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/dump.js" "$@"\n`, { mode: 0o755 });
  }
  const sep = process.platform === 'win32' ? ';' : ':';
  return { dir, env: { ...process.env, PATH: `${dir}${sep}${process.env.PATH}`, RA_SECRET: 'LEAKED-ENV-VALUE' } };
}

test('safe arguments reach the tool unchanged, spaces included', async () => {
  const { env } = fakeTool();
  const args = ['run', '--standalone', '-m', 'omniroute/route-audit-probe-1-abc', 'Reply with exactly: OK', 'claude/claude-sonnet-5-5-low'];
  const r = await runTool('faketool', args, { env });
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), args);
});

// F4: everything the reviewer used to inject or mangle is refused before cmd.exe sees it.
for (const bad of ['%RA_SECRET%', 'a b%RA_SECRET%', 'trail space\\', 'q"', 'a\\"b', 'line1\nline2', 'a" & echo PWNED & "b', 'a"&calc&"', '!PATH!', '^x', 'a|b', 'a<b', '', 'trailing ']) {
  test(`unsafe argument is refused, not escaped: ${JSON.stringify(bad)}`, async () => {
    assert.throws(() => assertSafeArgs([bad]), /unsafe argument/);
    const { env } = fakeTool();
    const r = await runTool('faketool', ['ok', bad], { env });
    assert.equal(r.status, null);
    assert.match(r.error, /unsafe argument/);
    assert.equal(r.out, '', 'the tool never ran');
  });
}

// F5: a timeout kills the real tool, not only the shell in front of it.
test('timeout kills the whole process tree', async () => {
  const marker = path.join(os.tmpdir(), `route-audit-orphan-${process.pid}-${Date.now()}`);
  const { env } = fakeTool(`setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'still alive'), 2500); setInterval(() => {}, 1000);`);
  const r = await runTool('faketool', ['x'], { env, timeout: 700 });
  assert.equal(r.timedOut, true);
  await new Promise((res) => setTimeout(res, 3500));
  assert.equal(fs.existsSync(marker), false, 'the grandchild survived the timeout and kept running');
});

test('a missing tool resolves with an error instead of throwing', async () => {
  const r = await runTool('definitely-not-a-tool-xyz', ['a'], { timeout: 10000 });
  assert.notEqual(r.status, 0);
});
