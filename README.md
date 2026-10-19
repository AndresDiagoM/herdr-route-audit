# herdr-route-audit

**Prototype — not published.** Which [OmniRoute](https://github.com/diegosouzapw/OmniRoute)
combo step actually served each request: step 1 as intended, or a silent fallback.

OmniRoute priority combos fall back silently and the pane footer only shows the combo name.
`call_logs.combo_step_id` has the truth; this reads it (read-only) and tells you.

```sh
node bin/report.js --since 24h          # per combo/step, per session, fallback episodes
node bin/report.js --since 7d --combo reviewer-claude-opus
node bin/report.js --since 2h --json    # for scripts
node --test test/audit.test.js          # classification rules
```

Requires Node ≥ 22.5 (`node:sqlite`); no dependencies. Add `--disable-warning=ExperimentalWarning`
after `node` to hide Node's SQLite notice. Database path: `$OMNIROUTE_DATA_DIR`, `$DATA_DIR`, or
`~/.omniroute` (from WSL, the Windows profile is found automatically).

Step numbers follow the combo's *current* `models[]` order (what OmniRoute's priority strategy
tries first today), not the historical `-model-<n>-` suffix in the step id; rows older than the
combo's last edit are judged against today's order.

Spec and roadmap: `C:\Users\felip\Documents\ClaudeMaster\tool-ideas\01-route-audit.md`.
