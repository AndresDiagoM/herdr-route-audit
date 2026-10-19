# herdr-route-audit

**Prototype — not published.** Which [OmniRoute](https://github.com/diegosouzapw/OmniRoute)
combo step actually served each agent pane: step 1 as intended, or a silent fallback.

OmniRoute priority combos fall back silently and the pane footer only shows the combo name.
`call_logs.combo_step_id` has the truth; this reads it (read-only), attributes each request to a
[Herdr](https://herdr.dev) pane and shows the answer as a `$route` line under the agent in the
sidebar: `ok · claude/claude-sonnet-5-5`, `FALLBACK step 2 · antigravity/claude-opus-4-6-thinking`,
`FAILED · (no step served)`.

## Install

```sh
herdr plugin link C:\path\to\herdr-route-audit        # or: herdr plugin install <owner>/herdr-route-audit
herdr plugin action invoke configure --plugin route-audit     # sidebar row (backs up config.toml)
herdr plugin action invoke watch-start --plugin route-audit   # starts at every Herdr start too
```

Requires Node ≥ 22.5 (`node:sqlite`); no dependencies. OmniRoute's database is found at
`$OMNIROUTE_DATA_DIR`, `$DATA_DIR`, or `~/.omniroute` (from WSL, the Windows profile).

`configure` refuses a hand-written `[ui.sidebar.agents]` rather than merging it: add
`[{ token = "$route" }]` as a row yourself in that case. `unconfigure` stops the watcher and
removes the block.

## How a request finds its pane

1. **Tag (exact).** If the pane's opencode sends `X-Omniroute-Session-Id: <HERDR_PANE_ID>`,
   OmniRoute stores it as the request's `session_tag`. Add to the OmniRoute provider in
   `opencode.json`:

   ```json
   "options": { "headers": { "X-Omniroute-Session-Id": "{env:HERDR_PANE_ID}" } }
   ```

   and run opencode with `--standalone` inside the pane: the default background service
   evaluates the config once, with *its* environment, so every pane would get the same id.
   `{env:…}` is empty outside Herdr, and OmniRoute ignores an empty header.
2. **Correlation (approximate).** Otherwise a request goes to the one pane that was `working`
   while it ran. Two candidates is "shared" (no badge); none is unattributed. `report.js` and
   `watch.js --once` print those counts.

## Commands

```sh
node bin/report.js --since 24h                   # per combo/step, per session, fallback episodes
node bin/report.js --since 7d --combo reviewer-claude-opus --json
node bin/watch.js --once                         # one dry-run tick: what each pane would show
node bin/watch.js --status                       # pid + last events (events.jsonl)
node --test test/audit.test.js test/attribute.test.js test/managed-config.test.js
```

Add `--disable-warning=ExperimentalWarning` after `node` to hide Node's SQLite notice (the
manifest does). State lives in Herdr's plugin state dir (`%LOCALAPPDATA%\herdr\plugins\route-audit`
on Windows): `watch.pid`, `watch.log`, `events.jsonl`.

## Rules

- Step numbers follow the combo's *current* `models[]` order; the `-model-<n>-` suffix in the step
  id is historical and survives reordering. Rows older than the combo's last edit are judged
  against today's order.
- `499` is the client hanging up (opencode cancels its title/summary calls) — never an error, and
  a trailing 499 does not hide the previous request's outcome.
- No step id + status ≥ 400 is `FAILED`; no step id otherwise is unknown.
- Badges carry a TTL of four poll intervals, so a dead watcher's badges disappear by themselves.

Spec and roadmap: `C:\Users\felip\Documents\ClaudeMaster\tool-ideas\01-route-audit.md`.
