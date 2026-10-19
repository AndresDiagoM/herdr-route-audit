// Pure classification and aggregation over OmniRoute call_logs rows. No I/O here so the
// rules can be tested with literal rows (see test/audit.test.js).
'use strict';

const STEP_RE = /-model-(\d+)-/;

// Index (0-based) of the step that served a row, or null when OmniRoute recorded no step.
// Prefer the combo definition (ids are opaque to us in principle); fall back to the `-model-<n>-`
// convention OmniRoute uses today, which is 1-based.
function stepIndex(row, combo) {
  const id = row.combo_step_id;
  if (!id) return null;
  if (combo && Array.isArray(combo.models)) {
    const i = combo.models.findIndex((m) => m && m.id === id);
    if (i >= 0) return i;
  }
  const m = STEP_RE.exec(id);
  return m ? Number(m[1]) - 1 : null;
}

// Outcome of one row against its combo.
//   PRIMARY   served by the step a priority combo is meant to use (models[0])
//   FALLBACK  served by a later step of a priority combo
//   ANY       served by some step of a non-priority combo (round-robin, quota-share, ...)
//   FAILED    no step served and the request errored (status >= 400)
//   UNKNOWN   no step recorded but the request did not error (e.g. 499 client closed)
// 499 is the client closing the connection (opencode cancels its title/summary calls); it says
// nothing about the step, so it is never an error here.
function isError(status) {
  return status >= 400 && status !== 499;
}

function classify(row, combo) {
  const idx = stepIndex(row, combo);
  const status = Number(row.status) || 0;
  const error = isError(status);
  if (idx === null) {
    return { outcome: error ? 'FAILED' : 'UNKNOWN', step: null, error };
  }
  const strategy = combo && combo.strategy ? String(combo.strategy) : 'priority';
  if (strategy !== 'priority') return { outcome: 'ANY', step: idx + 1, error };
  return { outcome: idx === 0 ? 'PRIMARY' : 'FALLBACK', step: idx + 1, error };
}

// Human label for a step of a combo: "claude/claude-sonnet-5-5" or the provider/model the row saw.
function stepLabel(step, combo, row) {
  if (!step) return '(no step served)';
  const m = combo && Array.isArray(combo.models) ? combo.models[step - 1] : null;
  if (m && m.model) return m.model;
  // OmniRoute writes the combo name into provider/model when no step served; only trust the
  // row's pair when it names something else.
  if (row && row.provider && row.model && row.provider !== row.combo_name) return `${row.provider}/${row.model}`;
  return `step ${step}`;
}

// Per combo × step counts, in step order, with the no-step bucket last.
function perComboSteps(rows, combos) {
  const out = new Map();
  for (const row of rows) {
    const combo = combos.get(row.combo_name);
    const c = classify(row, combo);
    const key = row.combo_name;
    if (!out.has(key)) out.set(key, { combo: key, strategy: (combo && combo.strategy) || '?', steps: new Map() });
    const sk = c.step === null ? 'none' : String(c.step);
    const steps = out.get(key).steps;
    if (!steps.has(sk)) {
      steps.set(sk, { step: c.step, label: stepLabel(c.step, combo, row), outcome: c.outcome, count: 0, errors: 0, last: null });
    }
    const s = steps.get(sk);
    s.count += 1;
    if (c.error) s.errors += 1;
    if (!s.last || row.timestamp > s.last) s.last = row.timestamp;
    // A FAILED/UNKNOWN bucket is shared; show the worse of the two.
    if (c.outcome === 'FAILED') s.outcome = 'FAILED';
  }
  return [...out.values()].map((e) => ({
    ...e,
    steps: [...e.steps.values()].sort((a, b) => (a.step ?? 1e9) - (b.step ?? 1e9)),
  }));
}

// Consecutive non-PRIMARY stretches per session tag, which is what an operator wants to read:
// "from 18:05 to 18:31 this session was served by step 2/3, with N errors".
function episodes(rows, combos, { minLength = 1 } = {}) {
  const byTag = new Map();
  for (const row of rows) {
    const tag = row.session_tag || '(untagged)';
    if (!byTag.has(tag)) byTag.set(tag, []);
    byTag.get(tag).push(row);
  }
  const out = [];
  for (const [tag, list] of byTag) {
    list.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
    let cur = null;
    for (const row of list) {
      const combo = combos.get(row.combo_name);
      const c = classify(row, combo);
      const bad = c.outcome === 'FALLBACK' || c.outcome === 'FAILED';
      if (bad) {
        if (!cur || cur.combo !== row.combo_name) {
          if (cur && cur.count >= minLength) out.push(cur);
          cur = { tag, combo: row.combo_name, start: row.timestamp, end: row.timestamp, count: 0, errors: 0, steps: new Set(), labels: new Set() };
        }
        cur.end = row.timestamp;
        cur.count += 1;
        if (c.error) cur.errors += 1;
        cur.steps.add(c.step === null ? 'none' : c.step);
        cur.labels.add(stepLabel(c.step, combo, row));
      } else if (cur) {
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

// Current state per session tag: the last request's outcome plus a rolling window.
function perTag(rows, combos, { window = 10 } = {}) {
  const byTag = new Map();
  for (const row of rows) {
    const tag = row.session_tag || '(untagged)';
    if (!byTag.has(tag)) byTag.set(tag, []);
    byTag.get(tag).push(row);
  }
  const out = [];
  for (const [tag, list] of byTag) {
    list.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
    const recent = list.slice(-window);
    const classes = recent.map((r) => classify(r, combos.get(r.combo_name)));
    // The last request that tells us something; a trailing 499 must not hide a fallback.
    let li = classes.length - 1;
    while (li > 0 && classes[li].outcome === 'UNKNOWN') li -= 1;
    const last = classes[li];
    const lastRow = recent[li];
    const fallbacks = classes.filter((c) => c.outcome === 'FALLBACK').length;
    const failed = classes.filter((c) => c.outcome === 'FAILED').length;
    let state = 'PRIMARY';
    if (last.outcome === 'FAILED') state = 'FAILED';
    else if (last.outcome === 'FALLBACK') state = 'FALLBACK';
    else if (fallbacks + failed > 0) state = 'DEGRADED';
    else if (last.outcome === 'ANY') state = 'ANY';
    else if (last.outcome === 'UNKNOWN') state = 'UNKNOWN';
    out.push({
      tag,
      combo: lastRow.combo_name,
      state,
      lastStep: last.step,
      lastLabel: stepLabel(last.step, combos.get(lastRow.combo_name), lastRow),
      lastAt: lastRow.timestamp,
      requests: list.length,
      windowFallbacks: fallbacks,
      windowFailed: failed,
    });
  }
  return out.sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
}

module.exports = { stepIndex, classify, stepLabel, perComboSteps, episodes, perTag };
