#!/usr/bin/env node
// route-audit report: which combo step actually served each request, per combo and per session.
//
//   node bin/report.js [--since 24h|7d|30m] [--combo NAME] [--tag SESSION_TAG] [--json] [--db PATH]
'use strict';

const { openReadOnly, loadCombos, loadRows } = require('../lib/db.js');
const { perComboSteps, episodes, perTag } = require('../lib/audit.js');

function parseArgs(argv) {
  const opts = { since: '24h', combo: null, tag: null, json: false, db: null, minEpisode: 1, sessions: 10 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--since') opts.since = next();
    else if (a === '--combo') opts.combo = next();
    else if (a === '--tag') opts.tag = next();
    else if (a === '--db') opts.db = next();
    else if (a === '--min-episode') opts.minEpisode = Number(next());
    else if (a === '--sessions') opts.sessions = Number(next());
    else if (a === '--json') opts.json = true;
    else if (a === '-h' || a === '--help') { usage(); process.exit(0); }
    else { console.error(`unknown argument: ${a}`); usage(); process.exit(2); }
  }
  return opts;
}

function usage() {
  console.error('usage: report.js [--since 24h|7d|30m|all] [--combo NAME] [--tag SESSION_TAG] [--min-episode N] [--sessions N] [--json] [--db PATH]');
}

function sinceIso(spec) {
  if (spec === 'all') return '1970-01-01T00:00:00.000Z';
  const m = /^(\d+)([mhd])$/.exec(spec);
  if (!m) throw new Error(`bad --since value: ${spec} (use e.g. 30m, 2h, 7d, all)`);
  const n = Number(m[1]);
  const ms = { m: 60e3, h: 3600e3, d: 86400e3 }[m[2]] * n;
  return new Date(Date.now() - ms).toISOString();
}

const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);
const short = (iso) => (iso ? iso.slice(0, 16).replace('T', ' ') : '-');

function printText({ since, combos, tags, eps, rows, sessionsCap }) {
  console.log(`route-audit — ${rows.length} combo-routed requests since ${short(since)} (UTC)\n`);

  console.log('Per combo and step');
  for (const c of combos) {
    console.log(`  ${c.combo}  [${c.strategy}]`);
    for (const s of c.steps) {
      const mark = s.outcome === 'PRIMARY' ? '●' : s.outcome === 'FALLBACK' ? '◐' : s.outcome === 'FAILED' ? '✕' : s.outcome === 'UNKNOWN' ? '?' : '○';
      const stepTxt = s.step === null ? 'none' : `step ${s.step}`;
      console.log(`    ${mark} ${pad(stepTxt, 7)} ${pad(s.label, 44)} ${rpad(s.count, 6)} req ${rpad(s.errors, 5)} err   last ${short(s.last)}`);
    }
  }

  // Every session that is not plainly healthy, plus the most recent healthy ones up to the cap.
  const shown = [];
  let healthy = 0;
  for (const t of tags) {
    if (t.state === 'PRIMARY' || t.state === 'ANY') {
      if (healthy >= sessionsCap) continue;
      healthy += 1;
    }
    shown.push(t);
  }
  const hidden = tags.length - shown.length;
  console.log(`\nSessions (last request first${hidden > 0 ? `; ${hidden} healthy sessions hidden, --sessions N to show more` : ''})`);
  console.log(`  ${pad('state', 9)} ${pad('session', 42)} ${pad('combo', 24)} ${pad('last served by', 36)} ${rpad('req', 5)}  ${pad('fb/fail in window', 18)} last`);
  for (const t of shown) {
    console.log(`  ${pad(t.state, 9)} ${pad(t.tag, 42)} ${pad(t.combo, 24)} ${pad(t.lastLabel, 36)} ${rpad(t.requests, 5)}  ${pad(`${t.windowFallbacks}/${t.windowFailed}`, 18)} ${short(t.lastAt)}`);
  }

  console.log('\nFallback / failure episodes (newest first)');
  if (eps.length === 0) console.log('  none');
  for (const e of eps) {
    const steps = e.steps.map((s) => (s === 'none' ? 'no step' : `step ${s}`)).join(', ');
    console.log(`  ${short(e.start)} → ${short(e.end)}  ${pad(e.combo, 24)} ${pad(e.tag, 42)} ${rpad(e.count, 4)} req ${rpad(e.errors, 4)} err  ${steps}: ${e.labels.join(', ')}`);
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const since = sinceIso(opts.since);
  const db = openReadOnly(opts.db);
  try {
    const comboDefs = loadCombos(db);
    const rows = loadRows(db, { sinceIso: since, combo: opts.combo, tag: opts.tag });
    const report = {
      since,
      combos: perComboSteps(rows, comboDefs),
      tags: perTag(rows, comboDefs),
      eps: episodes(rows, comboDefs, { minLength: opts.minEpisode }),
      rows,
      sessionsCap: opts.sessions,
    };
    if (opts.json) {
      const { rows: _omit, sessionsCap: _cap, ...rest } = report;
      console.log(JSON.stringify({ ...rest, requests: rows.length }, null, 2));
    } else {
      printText(report);
    }
  } finally {
    db.close();
  }
}

main();
