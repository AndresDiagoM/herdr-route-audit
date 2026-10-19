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
   OmniRoute stores it as the request's `session_tag`. Inject the header per pane and give the
   pane its own opencode server:

   ```sh
   CFG='{"provider":{"omniroute":{"options":{"headers":{"X-Omniroute-Session-Id":"{env:HERDR_PANE_ID}"}}}}}'
   herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd "$PWD" --label builder --no-focus --env "OPENCODE_CONFIG_CONTENT=$CFG"
   herdr agent start builder --kind opencode --pane <pane_id> -- --standalone
   ```

   `OPENCODE_CONFIG_CONTENT` is deep-merged over `opencode.json` (keys and URLs stay there).
   `--standalone` matters: opencode's default background service evaluates the config once,
   with *its* environment, so every pane would inherit one id. Don't put the header in the
   global file for the same reason. Scripted `opencode run …` must close stdin (`</dev/null`)
   or it hangs.
2. **Correlation (approximate).** Otherwise a request goes to the one pane that was `working`
   while it ran. Two candidates is "shared" (no badge); none is unattributed. `report.js` and
   `watch.js --once` print those counts.

## Paging

`herdr plugin action invoke telegram-setup --plugin route-audit` copies the bot token and chat
from herdr-telegram-agents into this plugin's `notify.json` (or `node bin/telegram.js --token T
--chat ID`). From then on every transition into a fallback or failure, and the recovery, is one
Telegram message: `⚠️ route-audit: builder (w9:p35) on codigo-5-claude-sonnet → FALLBACK step 2 ·
claude/claude-sonnet-5`. `telegram-test` sends one message; `telegram-off` removes the config.
A restarted watcher replays recent history silently — it never pages for transitions that
happened before it started.

## Self-test

`herdr plugin action invoke probe --plugin route-audit` (or `node bin/probe.js`) opens a scratch
tab, creates a throwaway combo `route-audit-probe` whose first step the catalog rejects, sends one
tagged `opencode run --standalone` request through it, and passes when the pane's badge reads
`FALLBACK step 2 · antigravity/gemini-3.8-flash-tiered` — then deletes the combo and closes the tab.
It spends one request on step 2 and, if paging is on, one Telegram message. Override the steps
with `--step1` / `--step2`; `--keep` leaves the combo and tab for inspection.

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
