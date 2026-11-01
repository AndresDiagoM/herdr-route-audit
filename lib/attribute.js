// Which pane a call_logs row belongs to, and what its badge should say. Pure; no I/O.
'use strict';

// A tag shaped like a herdr pane id (`w9:p35`, `herdr:w9:p35`, optionally `:<anything>` after).
const PANE_TAG = /^(?:herdr:)?w[A-Za-z0-9]+:p[A-Za-z0-9]+(?::|$)/;
const MAX_DURATION_MS = 10 * 60 * 1000;

// A pane that sends `X-Omniroute-Session-Id` carries its own id in `session_tag`. Accept the bare
// pane id, `herdr:<id>`, and `<id>:<anything>`; when several live ids match (one is a prefix of
// another at a colon), the longest wins, whatever order the panes are listed in.
function paneFromTag(tag, paneIds) {
  if (!tag) return null;
  let best = null;
  for (const id of paneIds) {
    if (tag === id || tag === `herdr:${id}` || tag.startsWith(`${id}:`) || tag.startsWith(`herdr:${id}:`)) {
      if (!best || id.length > best.length) best = id;
    }
  }
  return best;
}

const looksLikePaneTag = (tag) => typeof tag === 'string' && PANE_TAG.test(tag);

// Strict ISO-8601 with a zone, as OmniRoute writes it; anything else is not a usable time.
function parseTime(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/.test(iso)) return NaN;
  return Date.parse(iso);
}

// Panes that were `working` at some poll inside [start - slack, end + slack]. `history` is the
// watcher's poll log: [{ t: ms, working: Set<paneId> }]. Order is not assumed (clocks step).
function workingDuring(history, startMs, endMs, slackMs) {
  const out = new Set();
  for (const poll of history) {
    if (poll.t < startMs - slackMs || poll.t > endMs + slackMs) continue;
    for (const id of poll.working) out.add(id);
  }
  return out;
}

// Attribute rows to panes. A tag that names a live pane wins. A tag that looks like a pane id
// but names no live pane (the pane closed, or the row is older than a reused id) is dropped:
// correlating it would hand it to whichever pane happens to be working. Otherwise a row goes to
// the one pane that was working while the request ran; two candidates is "shared", zero (or an
// unusable timestamp) is unattributed.
// Returns { byPane: Map<paneId, rows[]>, shared, unattributed, orphanTagged }.
function attribute(rows, paneIds, history, { slackMs = 10000 } = {}) {
  const byPane = new Map();
  const shared = [];
  const unattributed = [];
  const orphanTagged = [];
  const push = (id, row, how) => {
    if (!byPane.has(id)) byPane.set(id, []);
    byPane.get(id).push({ ...row, attributed: how });
  };
  for (const row of rows) {
    const tagged = paneFromTag(row.session_tag, paneIds);
    if (tagged) { push(tagged, row, 'tag'); continue; }
    if (looksLikePaneTag(row.session_tag)) { orphanTagged.push(row); continue; }
    const end = parseTime(row.timestamp);
    if (Number.isNaN(end)) { unattributed.push(row); continue; }
    const d = Number(row.duration);
    const duration = Number.isFinite(d) && d > 0 ? Math.min(d, MAX_DURATION_MS) : 0;
    const candidates = [...workingDuring(history, end - duration, end, slackMs)].filter((id) => paneIds.includes(id));
    if (candidates.length === 1) push(candidates[0], row, 'correlated');
    else if (candidates.length > 1) shared.push({ row, candidates });
    else unattributed.push(row);
  }
  return { byPane, shared, unattributed, orphanTagged };
}

// Herdr caps token values at 80 chars; count code points, not UTF-16 units.
const cap = (text) => ([...text].length > 80 ? `${[...text].slice(0, 79).join('')}…` : text);

// Herdr's default sidebar (26 columns) leaves about 22 for this row and cuts the rest, so what
// matters goes first: the state word (Herdr styles tokens by prefix, lib/managed-config.js),
// then the marker, glued to it so no width can cut one without the other. `*` = the pane was
// guessed by correlation (it was the only one working); the route itself is what OmniRoute
// recorded either way. Control characters from a model name never reach the sidebar.
function tokenText(summary) {
  if (!summary) return null;
  const label = String(summary.lastLabel || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
  const mark = summary.inferred ? '*' : '';
  let head;
  switch (summary.state) {
    case 'FAILED':
      head = `FAILED${mark}`;
      break;
    case 'FALLBACK':
      head = `FALLBACK${mark} step ${summary.lastStep}`;
      break;
    case 'ERROR':
      head = `ERROR${mark} step ${summary.lastStep}`;
      break;
    case 'DEGRADED':
      head = `DEGRADED${mark} ${summary.windowFallbacks} fb/${summary.windowFailed} fail in last ${summary.window}`;
      break;
    case 'UNKNOWN':
      head = `?${mark}`;
      break;
    default:
      head = `ok${mark}`;
  }
  return cap(`${head} · ${label}`);
}

// `34m`, `5h`, `3d`; under a minute, seconds.
function formatAge(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 48 * 3600) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const uncap = (text) => String(text).replace(/…$/, '');

// Badge for a pane whose evidence is old: nothing placed on it for 30 minutes. It says how old,
// not "idle": the pane may be working on requests that could not be placed. Never styled as an
// alert, and never blank, so while the watcher runs a pane it has seen keeps a badge.
// An inferred marker moves up to `stale*`: behind `stale 34m · ` it would sit at column 21, which a
// sidebar with a scrollbar (20 visible) cuts.
function staleText(lastText, ageMs) {
  const base = lastText ? uncap(lastText) : '? shared';
  const marked = /^\S+?\*(?=\s|$)/.test(base);
  return cap(`stale${marked ? '*' : ''} ${formatAge(ageMs)} · ${marked ? base.replace('*', '') : base}`);
}

// Badge for a pane whose latest requests ran while another pane was working too, so they could
// not be told apart and were placed on neither: the route is unknown right now, whatever the
// pane showed before. A pane that tags its requests is never marked (lib's caller skips it).
function sharedText(lastText) {
  return cap(lastText ? `? shared · ${uncap(lastText)}` : '? shared with another pane');
}

module.exports = { paneFromTag, looksLikePaneTag, parseTime, workingDuring, attribute, tokenText, staleText, sharedText, formatAge };
