// Run a command-line tool that may be an npm `.cmd` shim on Windows (omniroute, opencode).
// `spawnSync('omniroute')` is ENOENT there — only `.exe` resolves without a shell — and Node's
// `shell: true` joins arguments with spaces and no quoting, so this quotes them itself and goes
// through cmd.exe. On other platforms it is a plain spawnSync. Output is bounded either way.
'use strict';

const { spawnSync } = require('node:child_process');

const MAX_BUFFER = 8 * 1024 * 1024;

// cmd.exe quoting for an argument that reaches a .cmd shim: wrap when needed and escape quotes
// the way the shim's own `%*` forwarding survives. Arguments here are model ids, flags and one
// short prompt; anything with cmd metacharacters is wrapped too.
function winQuote(arg) {
  const s = String(arg);
  if (s === '') return '""';
  if (!/[\s"&|<>^()%!]/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

function runTool(cmd, args, { timeout = 60000, env, cwd, stdin = 'ignore' } = {}) {
  const common = { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: MAX_BUFFER, env, cwd, stdio: [stdin, 'pipe', 'pipe'] };
  let r;
  if (process.platform === 'win32') {
    const line = [cmd, ...args].map(winQuote).join(' ');
    r = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...common, windowsVerbatimArguments: true });
  } else {
    r = spawnSync(cmd, args, common);
  }
  return {
    status: r.status,
    signal: r.signal,
    error: r.error ? r.error.code || r.error.message : null,
    out: (r.stdout || '').trim(),
    err: (r.stderr || '').trim(),
  };
}

module.exports = { runTool, winQuote };
