// Which pane a call_logs row belongs to, and what its badge should say. Pure; no I/O.
'use strict';

// A pane that sends `X-Omniroute-Session-Id` carries its own id in `session_tag`. Accept the bare
// pane id, `herdr:<id>`, and `<id>:<anything>` so a future tag can append the agent session.
function paneFromTag(tag, paneIds) {
  if (!tag) return null;
  for (const id of paneIds) {
    if (tag === id || tag === `herdr:${id}` || tag.startsWith(`${id}:`) || tag.startsWith(`herdr:${id}:`)) return id;
  }
  return null;
}

const toMs = (iso) => Date.parse(iso) || 0;

// Panes that were `working` at some poll inside [start - slack, end + slack]. `history` is the
// watcher's poll log, oldest first: [{ t: ms, working: Set<paneId> }].
function workingDuring(history, startMs, endMs, slackMs) {
  const out = new Set();
  for (const poll of history) {
    if (poll.t < startMs - slackMs) continue;
    if (poll.t > endMs + slackMs) break;
    for (const id of poll.working) out.add(id);
  }
  return out;
}

// Attribute rows to panes. Explicit tags win; otherwise a row goes to the one pane that was
// working while the request ran. Two candidates is "shared" (listed, attributed to none); zero
// is unattributed. Returns { byPane: Map<paneId, rows[]>, shared: [{row, candidates}], unattributed: rows[] }.
function attribute(rows, paneIds, history, { slackMs = 10000 } = {}) {
  const byPane = new Map();
  const shared = [];
  const unattributed = [];
  const push = (id, row, how) => {
    if (!byPane.has(id)) byPane.set(id, []);
    byPane.get(id).push({ ...row, attributed: how });
  };
  for (const row of rows) {
    const tagged = paneFromTag(row.session_tag, paneIds);
    if (tagged) { push(tagged, row, 'tag'); continue; }
    const end = toMs(row.timestamp);
    const start = end - (Number(row.duration) || 0);
    const candidates = [...workingDuring(history, start, end, slackMs)].filter((id) => paneIds.includes(id));
    if (candidates.length === 1) push(candidates[0], row, 'correlated');
    else if (candidates.length > 1) shared.push({ row, candidates });
    else unattributed.push(row);
  }
  return { byPane, shared, unattributed };
}

// Badge text for one pane, from audit.summarizeRows(). Herdr caps token values at 80 chars and
// styles them by prefix (see bin/configure.js), so the state word comes first.
function tokenText(summary) {
  if (!summary) return null;
  const label = summary.lastLabel || '';
  let text;
  switch (summary.state) {
    case 'FAILED':
      text = `FAILED · ${label}`;
      break;
    case 'FALLBACK':
      text = `FALLBACK step ${summary.lastStep} · ${label}`;
      break;
    case 'DEGRADED':
      text = `DEGRADED ${summary.windowFallbacks} fb/${summary.windowFailed} fail in ${summary.window} · ${label}`;
      break;
    case 'UNKNOWN':
      text = `? · ${label}`;
      break;
    default:
      text = `ok · ${label}`;
  }
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

// A transition worth telling the operator about: into trouble, or back out of it.
function transition(prevState, nextState) {
  const bad = (s) => s === 'FALLBACK' || s === 'FAILED';
  if (!bad(prevState) && bad(nextState)) return 'degraded';
  if (bad(prevState) && nextState === 'PRIMARY') return 'recovered';
  return null;
}

module.exports = { paneFromTag, workingDuring, attribute, tokenText, transition };
