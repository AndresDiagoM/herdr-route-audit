# herdr-route-audit

Which [OmniRoute](https://github.com/diegosouzapw/OmniRoute) combo step actually served each
agent pane: step 1 as intended, or a silent fallback.

Developed and tested on Windows 11 with Herdr 0.9.5, OmniRoute 3.8.51-3.8.52 and Node 24-26. The code
has no Windows-only paths, but Linux and macOS have not been tested yet: reports welcome.

OmniRoute priority combos fall back silently and the pane footer only shows the combo name.
`call_logs.combo_step_id` has the truth; this reads it (read-only), attributes each request to a
[Herdr](https://herdr.dev) pane, shows the answer as a `$route` line under the agent in the
sidebar, and pages you once when a pane starts being served by a fallback.

## Install

```sh
herdr plugin link C:\path\to\herdr-route-audit        # or: herdr plugin install <owner>/herdr-route-audit
herdr plugin action invoke configure --plugin route-audit     # sidebar row (backs up config.toml)
herdr plugin action invoke watch-start --plugin route-audit   # starts at every Herdr start too
```

Requires Node ≥ 22.5 (`node:sqlite`); no dependencies. OmniRoute's database is found at
`$OMNIROUTE_DATA_DIR`, `$DATA_DIR`, or `~/.omniroute` (from WSL, the Windows profile). It is
only ever opened read-only.

**Updating:** `herdr plugin update route-audit --yes` (a linked folder: pull it instead), then
`watch-stop` and `watch-start`. A running watcher keeps the code it started with until it is
restarted.

## The badge

| `$route` reads | Meaning |
| --- | --- |
| `ok · claude/claude-sonnet-5-5` | the last request was served by step 1 |
| `FALLBACK step 2 · claude/claude-sonnet-5` | the last request was served by a later step |
| `FAILED · (no step served)` | the last request failed on every step |
| `ERROR step 1 · …` | step 1 answered the last request with an error (the combo may have retried elsewhere) |
| `DEGRADED 2 fb/1 fail in last 10 · …` | the last request was fine, but 2 of the last 10 were fallbacks and 1 failed |
| `? · …` | nothing conclusive yet (only client cancels, 499) |
| `FALLBACK* step 2 · …` | `*` on the state word: at least one of the last 10 requests was placed on this pane by [correlation](#how-a-request-finds-its-pane), not by a tag. The route is what OmniRoute recorded; the pane is a guess |
| `? shared · ok · …` | requests ran while this pane and another were working and could be placed on neither, so this pane's route is unknown right now (a pane that has sent a tagged request is never marked). After the dot, its last known state |
| `stale 34m · ok · …` | nothing placed on this pane for 30 minutes or more: what the badge said then, and how long ago (`stale*` when that state was inferred). The pane may be idle, or working on requests that cannot be placed |

Herdr's default sidebar shows about 22 characters of this row (20 when the agent list scrolls), so
the state word and its `*` always come within the first 20. Steps are numbered by the combo's **current** order. A request served by a step
the combo no longer lists (edited or deleted since) is shown with the model the request itself
recorded and is never counted as primary or fallback; `report.js` marks those rows `†`.

**No badge never means healthy.** Every badge carries a TTL of about a minute and the watcher
rewrites it every 30 seconds or so; a write Herdr rejects is retried on the next tick. So all
badges disappear within a minute of the watcher stopping, or of it losing sight of Herdr or the
database (a tick that fails refreshes nothing). A Herdr server restart leaves every pane blank
until the next rewrite, up to about 35 seconds. While the watcher runs, a pane it has seen keeps a
badge until the pane closes: `stale` when the evidence is old, `? shared` when its requests cannot
be placed. A pane with no badge has not been seen (nothing placed on it since the watcher started;
a restarted watcher replays only the last 15 minutes, and untagged requests older than a few
seconds cannot be correlated because the working-pane history died with the old watcher), or the
watcher is not running or not seeing: `watch-status` shows the last beat and the last complete
tick, and says so when the watcher runs but cannot see Herdr or the database, or Herdr keeps
rejecting a pane's badge writes (`watch.log` records each change). A stale pane's next request
starts a fresh window and a fresh incident. If call_logs is emptied (OmniRoute's "Purge call
logs"), the watcher notices (the newest row falls below where it was reading, or the row there is
another one) and reads the table again from the start; only requests that ended after its last
look page.

## Paging

`herdr plugin action invoke telegram-setup --plugin route-audit` copies the bot token and chat
from herdr-telegram-agents into this plugin's `notify.json` (or `node bin/telegram.js --token T
--chat ID`). Then:

- **One page when an incident opens**: the first request of a pane served by a fallback step or
  by no step at all. `⚠️ route-audit: builder (w9:p35) on sonnet-combo → FALLBACK step 2
  · claude/claude-sonnet-5`
- **Nothing while it lasts**, however much it flaps between steps.
- **One page when it closes**: after 3 consecutive clean step-1 requests. A step-1 error resets
  that count; a client cancel (499) does not count either way.
- A page that rests on a request placed by correlation says so: `builder (w9:p35, inferred)`.
  That is the request that opened the incident, or any of the three that closed it.
- Requests logged before the watcher started are history: a restarted watcher replays the last
  15 minutes to rebuild state and never pages for them. A request logged after it started pages,
  even inside its first tick.
- **One page after a crash, if it hid something.** The watcher keeps in `watch.pid` how far it
  has read. `watch-stop` deletes the file once the watcher has exited (or after 5 seconds: a
  watcher still busy then leaves at its next beat), unless it held a gap it had not reported yet
  (then it keeps just that). Any other end (crash, kill, reboot, Ctrl-C, a signal on
  Linux/macOS) leaves it, and so does `watch-stop` on a watcher that had already died;
  `unconfigure` (before uninstalling) removes it in every case. The next start counts the combo
  requests OmniRoute logged between that point and its own start, from any client, not only Herdr
  panes. If any was served by a fallback step or by no step, it pages once (one attempt, like
  every page): `⚠️ route-audit: the watcher was down for 38m (since 2026-10-31T19:02Z) and saw
  none of the 37 combo requests OmniRoute logged meanwhile, from any client: 5 by a fallback step,
  1 by no step. codigo-5: 3 fallback · reviewer: 2 fallback, 1 failed`. A gap with only clean requests (a reboot after an idle night, say) goes to
  `events.jsonl` and `watch.log` only. The counts are totals with the combos that had trouble, not
  split by pane: untagged requests cannot be placed, because nobody recorded which panes were
  working. If OmniRoute's retention had already deleted the oldest of them, or call_logs was
  emptied meanwhile, the page says so. A watcher that dies before reporting passes its gap on to
  the next one. A pid file written by 0.2.0 has no read position, so the first start after
  upgrading from it reports nothing.
- A watcher that is down and is never started again cannot page about itself. It starts with
  Herdr; in between, `watch-status` is the check.

`telegram-test` sends one message; `telegram-off` removes the config. Failure reasons in
`watch.log` are built from status codes and Telegram's own short messages, and are redacted, so the
bot token never reaches a log.

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
2. **Correlation (inferred).** Otherwise a request goes to the one pane that was `working`
   while it ran. Badges built on a correlated request carry `*` after the state word, and pages
   say `inferred`. Two candidates is "shared": placed on neither, never paged, and the
   working panes that have not sent tagged requests read `? shared`. None is unattributed.
3. A request tagged with a pane id that is no longer open is **dropped**, never handed to
   whichever pane happens to be working. `watch.js --once` prints all four counts.

The tag is a client-supplied header: anything that can reach OmniRoute can claim a pane. Treat the
badge as diagnostics, not as an audit trail.

## The sidebar block

`configure` writes one fenced block (`# >>> route-audit >>>` … `# <<< route-audit <<<`) with Herdr's
default Agent rows plus the `$route` line. It:

- never rewrites a byte outside the fence; `unconfigure` restores the file exactly, CRLF, BOM and
  missing final newline included;
- refuses, instead of guessing, when the marker lines are damaged (one without the other, two
  fences, wrong order);
- refuses when `config.toml` already defines `[ui.sidebar.agents]` in any TOML spelling (dotted
  keys, quoted keys, inline tables, sub-tables): add `[{ token = "$route" }]` as a row yourself;
- writes atomically after a uniquely named backup (`config.toml.bak-before-route-audit-…`).

`unconfigure` stops the watcher first, then removes the block.

## Self-test

`herdr plugin action invoke probe --plugin route-audit` (or `node bin/probe.js`) opens a scratch
tab, creates a throwaway combo `route-audit-probe-<pid>-<time>` whose first step names a provider
that does not exist (it can only fail, and calls no one), sends one tagged `opencode run
--standalone` request through it, and passes when the pane's badge reads `FALLBACK step 2 ·
antigravity/gemini-3.8-flash-tiered`. It then deletes that combo (only that one) and closes the
tab, on every exit path including Ctrl-C. It spends one request on step 2 and, if paging is on,
one page (the incident goes with the scratch tab). `--step1` / `--step2` override the steps;
`--keep` leaves everything for inspection.

## Commands

```sh
node bin/report.js --since 24h                   # per combo/step, per session, fallback episodes
node bin/report.js --since 7d --combo reviewer-claude-opus --json
node bin/watch.js --once                         # one dry-run tick: what each pane would show
node bin/watch.js --status                       # pid, last beat, last complete tick, last events
node --test test/*.test.js                       # on Windows list the files: test/audit.test.js …
```

Add `--disable-warning=ExperimentalWarning` after `node` to hide Node's SQLite notice (the
manifest does). State lives in Herdr's plugin state dir (`%LOCALAPPDATA%\herdr\plugins\route-audit`
on Windows): `watch.pid` (pid, heartbeat, read position), `watch.log`, `events.jsonl`.

## Rules

- `499` is the client hanging up (opencode cancels its title/summary calls): never an error, and a
  trailing 499 does not hide the previous request's outcome.
- No step id + status ≥ 400 (not 499) is `FAILED`; no step id otherwise is unknown.
- `bin/probe.js` launches `omniroute` and `opencode` through their npm `.cmd` shims on Windows.
  Arguments are restricted to a safe alphabet (model ids, flags, a short prompt) and anything else is
  refused rather than escaped, because `cmd.exe` has no quoting that is safe for arbitrary text. A
  timeout kills the whole process tree.

## Roadmap

- Attribute panes that do not send the header, exactly, by the agent's own session id: opencode
  already sends it as `x-opencode-session` (the same id Herdr reports for the pane), and
  [OmniRoute#17125](https://github.com/diegosouzapw/OmniRoute/pull/17125) proposes storing it as
  `call_logs.client_session_id`.

## License

MIT
