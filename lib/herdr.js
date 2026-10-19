// Calls to the herdr CLI. Every call is bounded (timeout, maxBuffer) and a failure returns
// null rather than an empty result: to a caller tracking which panes exist those are opposite
// claims, and acting on nothing-as-empty would clear every badge over one timed-out call.
'use strict';

const { spawnSync } = require('node:child_process');
const { herdrBinary, PLUGIN_ID } = require('./paths.js');

const TIMEOUT_MS = 10000;

function call(...args) {
  try {
    const result = spawnSync(herdrBinary(), args, {
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result.status !== 0 || !result.stdout || !result.stdout.trim()) return null;
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

// Panes hosting an agent: [{ pane_id, agent, agent_status, agent_session?, cwd, label? }], or null.
function agents() {
  const reply = call('agent', 'list');
  if (!reply || !reply.result || !Array.isArray(reply.result.agents)) return null;
  return reply.result.agents;
}

// Set and clear sidebar tokens on a pane in one call. `tokens` maps name -> value; null clears.
// `ttlMs` lets a badge expire by itself if the watcher dies.
function reportMetadata(paneId, tokens, { ttlMs = null } = {}) {
  const args = ['pane', 'report-metadata', paneId, '--source', PLUGIN_ID];
  for (const [name, value] of Object.entries(tokens)) {
    if (value === null || value === undefined || value === '') args.push('--clear-token', name);
    else args.push('--token', `${name}=${value}`);
  }
  if (ttlMs) args.push('--ttl-ms', String(ttlMs));
  return call(...args) !== null;
}

function reloadConfig() {
  return call('server', 'reload-config') !== null;
}

module.exports = { call, agents, reportMetadata, reloadConfig };
