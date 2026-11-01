// Pure classification and aggregation over OmniRoute call_logs rows. No I/O here so the
// rules can be tested with literal rows (see test/audit.test.js).
'use strict';

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// What the row itself says served it. OmniRoute writes the combo name into provider/model when
// no step served, so that pair is not a model.
function rowLabel(row) {
  if (row && row.provider && row.model && row.provider !== row.combo_name) return `${row.provider}/${row.model}`;
  return null;
}

// The `-model-<n>-` number OmniRoute put in the step id when the step was added (1-based). It is
// assignment order, not position: reordering a combo keeps it. Anchored to the combo name so a
// combo called `my-model-3-combo` is not read as step 3.
function idSuffix(row) {
  const id = row.combo_step_id;
  if (!id) return null;
  const re = row.combo_name ? new RegExp(`^${escapeRe(row.combo_name)}-model-(\\d{1,4})-`) : /-model-(\d{1,4})-/;
  const m = re.exec(id);
  const n = m ? Number(m[1]) : NaN;
  return n >= 1 ? n : null;
}

// 0-based position of the row's step in the combo as it is defined now, or -1.
function listedIndex(row, combo) {
  if (!row.combo_step_id || !combo || !Array.isArray(combo.models)) return -1;
  return combo.models.findIndex((m) => m && m.id === row.combo_step_id);
}

// 499 is the client closing the connection (opencode cancels its title/summary calls); it says
// nothing about the step, so it is never an error here.
function isError(status) {
  return status >= 400 && status !== 499;
}

// Outcome of one row against its combo:
//   PRIMARY     served by step 1 of a priority combo as it is defined now
//   FALLBACK    served by a later step of a priority combo as it is defined now
//   ANY         served by a step of a non-priority combo (round-robin, quota-share, ...)
//   HISTORICAL  served by a step the combo no longer lists (combo edited or deleted since), so
//               "was this a fallback" has no honest answer; the label comes from the row
//   FAILED      no step served and the request errored (status >= 400, not 499)
//   UNKNOWN     no step recorded and no error (e.g. 499 client closed)
// `step` is the 1-based position for PRIMARY/FALLBACK/ANY, else null. `label` is the model.
function classify(row, combo) {
  const status = Number(row.status) || 0;
  const error = isError(status);
  if (!row.combo_step_id) {
    return { outcome: error ? 'FAILED' : 'UNKNOWN', step: null, error, label: '(no step served)' };
  }
  const i = listedIndex(row, combo);
  if (i < 0) {
    const n = idSuffix(row);
    return { outcome: 'HISTORICAL', step: null, idStep: n, error, label: rowLabel(row) || (n ? `step id ${n}` : 'unlisted step') };
  }
  const model = combo.models[i] && combo.models[i].model;
  const label = model || rowLabel(row) || `step ${i + 1}`;
  const strategy = combo.strategy ? String(combo.strategy) : 'priority';
  if (strategy !== 'priority') return { outcome: 'ANY', step: i + 1, error, label };
  return { outcome: i === 0 ? 'PRIMARY' : 'FALLBACK', step: i + 1, error, label };
}

const isBad = (c) => c.outcome === 'FALLBACK' || c.outcome === 'FAILED';

// Per combo × step counts: listed steps in order, then steps the combo no longer lists, then
// the no-step bucket.
function perComboSteps(rows, combos) {
  const out = new Map();
  for (const row of rows) {
    const combo = combos.get(row.combo_name);
    const c = classify(row, combo);
    const key = row.combo_name;
    if (!out.has(key)) out.set(key, { combo: key, strategy: combo ? combo.strategy || 'priority' : 'deleted', steps: new Map() });
    const sk = c.step !== null ? `s${c.step}` : c.outcome === 'HISTORICAL' ? `h${row.combo_step_id}` : 'none';
    const steps = out.get(key).steps;
    if (!steps.has(sk)) {
      steps.set(sk, { step: c.step, historical: c.outcome === 'HISTORICAL', label: c.label, outcome: c.outcome, count: 0, errors: 0, last: null });
    }
    const s = steps.get(sk);
    s.count += 1;
    if (c.error) s.errors += 1;
    if (!s.last || row.timestamp > s.last) s.last = row.timestamp;
    if (c.outcome === 'FAILED') s.outcome = 'FAILED'; // the no-step bucket shows the worse of the two
  }
  const rank = (s) => (s.step !== null ? s.step : s.historical ? 1e6 : 1e9);
  return [...out.values()].map((e) => ({ ...e, steps: [...e.steps.values()].sort((a, b) => rank(a) - rank(b)) }));
}

const byTimestamp = (a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0);

// Consecutive fallback/failure stretches per session tag, which is what an operator wants to
// read: "from 18:05 to 18:31 this session was served by step 2/3, with N errors".
function episodes(rows, combos, { minLength = 1 } = {}) {
  const byTag = new Map();
  for (const row of rows) {
    const tag = row.session_tag || '(untagged)';
    if (!byTag.has(tag)) byTag.set(tag, []);
    byTag.get(tag).push(row);
  }
  const out = [];
  for (const [tag, list] of byTag) {
    list.sort(byTimestamp);
    let cur = null;
    for (const row of list) {
      const c = classify(row, combos.get(row.combo_name));
      if (isBad(c)) {
        if (!cur || cur.combo !== row.combo_name) {
          if (cur && cur.count >= minLength) out.push(cur);
          cur = { tag, combo: row.combo_name, start: row.timestamp, end: row.timestamp, count: 0, errors: 0, steps: new Set(), labels: new Set() };
        }
        cur.end = row.timestamp;
        cur.count += 1;
        if (c.error) cur.errors += 1;
        cur.steps.add(c.step === null ? 'none' : c.step);
        cur.labels.add(c.label);
      } else if (cur && c.outcome !== 'UNKNOWN') {
        if (cur.count >= minLength) out.push(cur);
        cur = null;
      }
    }
    if (cur && cur.count >= minLength) out.push(cur);
  }
  return out
    .map((e) => ({ ...e, steps: [...e.steps], labels: [...e.labels] }))
    .sort((a, b) => (a.start < b.start ? 1 : -1));
}

// State of one stream of requests (a session, or a pane): the last request that tells us
// something, plus a rolling window. `list` need not be sorted. Null for an empty list.
//   FAILED    last request: no step served
//   FALLBACK  last request: served by a later step
//   ERROR     last request: step 1 answered with an error (the combo may retry elsewhere)
//   DEGRADED  last request fine, but the window holds fallbacks or failures
//   PRIMARY / ANY / UNKNOWN otherwise (HISTORICAL rows count as ANY)
function summarizeRows(list, combos, { window = 10 } = {}) {
  if (!list || list.length === 0) return null;
  const sorted = [...list].sort(byTimestamp);
  const recent = sorted.slice(-window);
  const classes = recent.map((r) => classify(r, combos.get(r.combo_name)));
  // A trailing 499 must not hide a fallback.
  let li = classes.length - 1;
  while (li > 0 && classes[li].outcome === 'UNKNOWN') li -= 1;
  const last = classes[li];
  const lastRow = recent[li];
  const fallbacks = classes.filter((c) => c.outcome === 'FALLBACK').length;
  const failed = classes.filter((c) => c.outcome === 'FAILED').length;
  let state;
  if (last.outcome === 'FAILED') state = 'FAILED';
  else if (last.outcome === 'FALLBACK') state = 'FALLBACK';
  else if (last.outcome === 'PRIMARY' && last.error) state = 'ERROR';
  else if (fallbacks + failed > 0) state = 'DEGRADED';
  else if (last.outcome === 'ANY' || last.outcome === 'HISTORICAL') state = 'ANY';
  else state = last.outcome;
  return {
    combo: lastRow.combo_name,
    state,
    lastStep: last.step,
    lastLabel: last.label,
    lastAt: lastRow.timestamp,
    requests: sorted.length,
    window: recent.length,
    windowFallbacks: fallbacks,
    windowFailed: failed,
    // The state covers the whole window (ok means "no fallback in the last N"), so it is only as
    // sure as its weakest row: one row placed on this pane by correlation makes it inferred.
    // Only rows the watcher attributed say how; report.js rows do not, so they get no flag.
    ...(recent.some((r) => r.attributed !== undefined) ? { inferred: recent.some((r) => r.attributed === 'correlated') } : {}),
  };
}

// Current state per session tag.
function perTag(rows, combos, opts) {
  const byTag = new Map();
  for (const row of rows) {
    const tag = row.session_tag || '(untagged)';
    if (!byTag.has(tag)) byTag.set(tag, []);
    byTag.get(tag).push(row);
  }
  const out = [];
  for (const [tag, list] of byTag) out.push({ tag, ...summarizeRows(list, combos, opts) });
  return out.sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
}

module.exports = { classify, isBad, isError, idSuffix, perComboSteps, episodes, perTag, summarizeRows };
