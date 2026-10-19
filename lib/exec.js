// Run a command-line tool that may be an npm `.cmd` shim on Windows (omniroute, opencode).
//
// spawn() cannot start a `.cmd` without a shell, and cmd.exe has no quoting that is safe for
// arbitrary text: `%VAR%` expands even inside quotes, and `\"` is not an escape, so a quote in
// an argument ends quoting and exposes `&` as an operator. Rather than escape, every argument
// must match a small safe alphabet (model ids, flags, a short prompt) or the call is refused.
//
// On timeout the whole process tree is killed (taskkill /T on Windows, the process group
// elsewhere): killing only cmd.exe would orphan the real tool, which keeps running.
// Output is bounded. The returned promise always resolves.
'use strict';

const { spawn, spawnSync } = require('node:child_process');

const MAX_OUTPUT = 1024 * 1024;
const SAFE_ARG = /^[A-Za-z0-9 _.,:/=@+\-]{1,300}$/;

function assertSafeArgs(args) {
  for (const a of args) {
    const s = String(a);
    if (!SAFE_ARG.test(s) || s.endsWith(' ')) {
      throw new Error(`unsafe argument for a shell-launched tool: ${JSON.stringify(s.slice(0, 40))}`);
    }
  }
}

function killTree(child) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000, stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

function runTool(cmd, args, { timeout = 60000, env, cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      assertSafeArgs([cmd, ...args]);
      const options = { env, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
      child = process.platform === 'win32'
        ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${[cmd, ...args].map((a) => (/[ ]/.test(a) ? `"${a}"` : a)).join(' ')}"`], { ...options, windowsVerbatimArguments: true })
        : spawn(cmd, args, { ...options, detached: true });
    } catch (err) {
      resolve({ status: null, signal: null, error: err.message, out: '', err: '', timedOut: false });
      return;
    }
    let out = '';
    let errText = '';
    let timedOut = false;
    let done = false;
    const cap = (acc, chunk) => (acc.length < MAX_OUTPUT ? acc + chunk.toString('utf8').slice(0, MAX_OUTPUT - acc.length) : acc);
    child.stdout.on('data', (c) => { out = cap(out, c); });
    child.stderr.on('data', (c) => { errText = cap(errText, c); });
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeout);
    const finish = (status, signal, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ status, signal, error: error || (timedOut ? 'ETIMEDOUT' : null), out: out.trim(), err: errText.trim(), timedOut, pid: child.pid });
    };
    child.on('error', (e) => finish(null, null, e.code || e.message));
    child.on('close', (status, signal) => finish(status, signal, null));
  });
}

module.exports = { runTool, assertSafeArgs, killTree, SAFE_ARG };
