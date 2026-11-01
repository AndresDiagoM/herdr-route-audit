// Calls to the herdr CLI. Every call is bounded (timeout, maxBuffer) and a failure returns
// null rather than an empty result: to a caller tracking which panes exist those are opposite
// claims, and acting on nothing-as-empty would clear every badge over one timed-out call.
'use strict';

const { spawnSync } = require('node:child_process');
const { herdrBinary, PLUGIN_ID } = require('./paths.js');

const TIMEOUT_MS = 10000;

function run(args) {
  return spawnSync(herdrBinary(), args, {
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
}

function call(...args) {
  try {
    const result = run(args);
    if (result.status !== 0 || !result.stdout || !result.stdout.trim()) return null;
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

// For commands Herdr runs quietly (no output on success, exit 1 and a JSON error on stderr on
// failure): success is the exit status alone.
function callQuiet(...args) {
  try {
    const result = run(args);
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

// Panes hosting an agent: [{ pane_id, agent, agent_status, agent_session?, cwd, label? }], or null.
function agents() {
  const reply = call('agent', 'list');
  if (!reply || !reply.result || !Array.isArray(reply.result.agents)) return null;
  return reply.result.agents;
}

// Every pane, agent or not: [{ pane_id, agent?, agent_status, cwd, label? }], or null. A tag can
// name a pane that hosts no recognised agent (a scratch shell running `opencode run`).
function panes() {
  const reply = call('pane', 'list');
  if (!reply || !reply.result || !Array.isArray(reply.result.panes)) return null;
  return reply.result.panes;
}

// Set and clear sidebar tokens on a pane in one call. `tokens` maps name -> value; null clears.
// `ttlMs` lets a badge expire by itself if the watcher dies. True when Herdr accepted it.
// `report-metadata` prints nothing on success (Herdr 0.9.x `Output::Quiet`), so it cannot go
// through call(), which would report every success as a failure.
function reportMetadata(paneId, tokens, { ttlMs = null } = {}) {
  const args = ['pane', 'report-metadata', paneId, '--source', PLUGIN_ID];
  for (const [name, value] of Object.entries(tokens)) {
    if (value === null || value === undefined || value === '') args.push('--clear-token', name);
    else args.push('--token', `${name}=${value}`);
  }
  if (ttlMs) args.push('--ttl-ms', String(ttlMs));
  return callQuiet(...args);
}

function reloadConfig() {
  return call('server', 'reload-config') !== null;
}

module.exports = { call, callQuiet, agents, panes, reportMetadata, reloadConfig };
