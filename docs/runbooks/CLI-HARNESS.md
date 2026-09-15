<!-- last-reviewed: 2026-09-15 round-98 -->

# CLI-HARNESS — terminal chat sessions without the UI

**Status:** reference · **Established:** round-58 (R58-e) · **Audience:** the
orchestrator, any future agent, or the owner driving real agent sessions from
a terminal

`scripts/acute.mjs` grew a `chat` command group: create sessions, run SYNC or
LIVE-STREAMED turns, watch tool calls and approvals arrive in real time, stop
a turn with Ctrl-C, and inspect context/event/usage state — everything the
web UI can do with a session, from a shell and scriptable in pipelines.
Everything below was verified live against a real sidecar + real provider
turns on `z-ai/glm-5.2:free` (round-58, R58-e).

## When

- Testing long multi-turn sessions, tool use, or stop/continue flows without
  opening the browser UI.
- Reproducing a UI bug from a terminal (same routes, same frames).
- Approving or denying pending approvals while a turn waits.
- Any scripted battery that needs a real agent turn (the R51 battery pattern,
  but interactive).

## Environment

The harness rides the same conventions as the rest of the CLI:

- `ACUTE_BASE_URL` — sidecar base (default `http://127.0.0.1:5178`).
- `ACUTE_TOKEN` — bearer token (default `acute-dev-local`).
- `NO_COLOR` — set to disable the chat commands' ANSI colors (they also
  disable themselves on non-TTY output, so `| jq` stays clean).

### Connecting to the installed app (R98-K portal discovery)

When **both** env vars are unset, the harness auto-discovers a running app:
the sidecar writes a small JSON discovery file — `<dbDir>/acute-portal.json`
`{port, token, pid, startedAt}` — next to its SQLite database at boot (and
removes it on graceful shutdown). The CLI checks, in order:

1. `<repo>/.dev/acute-portal.json` — the dev stack (`pnpm dev:full` puts
   `acute.db` in `.dev/`, so its sidecar's file lands there),
2. the installed app's per-user state dir — `%APPDATA%\acute-code` on
   Windows, `$XDG_DATA_HOME/acute-code` (default `~/.local/share/acute-code`)
   elsewhere (the Rust shell's `state_dir()`).

If a readable file is found, its port + token become the target and one dim
stderr line says so:

```
(no ACUTE_BASE_URL/ACUTE_TOKEN set — using the running app on port 53124, discovered at /home/z/.local/share/acute-code/acute-portal.json)
```

Rules of the road:

- **Explicit env vars always win** — the documented dev workflow (below) is
  byte-identical to pre-R98. Discovery only runs when BOTH are unset; a
  half-set pair never mixes a discovered value onto an explicit one.
- The token rides the user-local file only — it is **never logged** (the
  `ACUTE_READY` line stays port-only) and the file is written `0600`, the
  same trust boundary as the shell's env injection.
- A hard `SIGKILL` can leave a stale file; the next boot overwrites it
  (last boot wins). A dead-but-present target surfaces as the ordinary
  `unreachable … (is the sidecar running?)` error — same as a wrong
  `ACUTE_BASE_URL`.

So against a NORMALLY RUNNING installed app, nothing to configure at all:

```bash
node scripts/acute.mjs health
node scripts/acute.mjs usage:stats --months 6
```

Against the dev stack, nothing to configure either. For a DEDICATED
sidecar (scratch DB, spare port — the batteries' pattern):

```bash
ACUTE_TOKEN=acute-dev-local ACUTE_DB_PATH=/tmp/acute-harness.db ACUTE_PORT=5199 \
ACUTE_PROVIDER_OPENROUTER="$(cat /home/z/.acute/openrouter.key)" \
  node agent-core/dist/main.js > /tmp/acute-harness.log 2>&1 &
# wait for the ACUTE_READY {"port":5199} line, then:
export ACUTE_BASE_URL=http://127.0.0.1:5199 ACUTE_TOKEN=acute-dev-local
```

## Commands

All commands print error envelopes as one-liners (`404 NOT_FOUND: no session
with id sess_x`) and exit non-zero; payload JSON stays on stdout with status
lines on stderr, so `jq` pipelines keep working.

### `usage:stats` — the Data & Statistics window (R98-K)

```bash
node scripts/acute.mjs usage:stats
node scripts/acute.mjs usage:stats --months 6
```

`GET /usage/stats` rendered as a compact table: the window line (stderr),
turns · provider calls · tokens (in/out) · cost, the peak day (or an honest
"none" on an empty window), and one row per model (tokens-desc — the
server's order) with tokens, real provider-call count, cost, and the
provider ids that served it. `--months` mirrors the route's 1–24 window
(default 12). The same numbers the in-app Data & Statistics tab renders,
from the terminal — `--json`-free by design; use `raw GET /usage/stats` for
the raw document.

### `prompt:sections` / `prompt:show` — prompt-module inspection (offline)

Already covered by the R59-F commands (`prompt:sections [--project <dir>]`,
`prompt:show <id>`): they read the project's `.acute/prompts/` dir + the
agent-core dist directly — NO sidecar needed — and additionally show which
files WOULD override each section. The R98-K survey kept them OFFLINE on
purpose (they work when nothing is running); there is no separate
HTTP-backed `prompts:sections` variant to add.

### `chat:new` — create a session

```bash
node scripts/acute.mjs chat:new --agent agt_default_nova --title "CLI harness test"
node scripts/acute.mjs chat:new --project prj_x --agent agt_default_nova --title "with tools"
```

`--agent` may be omitted — the first agent from `GET /agents` is used.
`--project <projectId>` is optional: a projectless session chats fine but
gets NO tools (the engine's projectless contract). Returns 202 with the
session JSON on stdout (grab the `id`).

### `chat:sessions` — list sessions

```bash
node scripts/acute.mjs chat:sessions --limit 10
node scripts/acute.mjs chat:sessions --project prj_x
```

Compact `id · title · status · updatedAt` rows with the FULL session id
(copy-pasteable into the other commands). `--project` filters client-side.

### `chat` — SYNC whole turn

```bash
node scripts/acute.mjs chat <sessionId> "Say OK again"
node scripts/acute.mjs chat <sessionId> "deep think" --model z-ai/glm-5.2:free --thinking low
```

`POST /sessions/:id/messages` — waits for the whole turn, prints the
assistant reply on stdout and a dim usage line on stderr. `--json` prints the
raw `{assistantMessage, usage}` response instead. Flags: `--model <id>`,
`--thinking default|low|high|max` (the sidecar's set — there is no "medium";
the CLI validates and dies early).

### `chat:stream` — LIVE streamed turn

```bash
node scripts/acute.mjs chat:stream <sessionId> "Reply with exactly: OK"
node scripts/acute.mjs chat:stream <sessionId> "make the file" --quiet
node scripts/acute.mjs chat:stream <sessionId> "run echo hi" --auto-approve
node scripts/acute.mjs chat:stream <sessionId> "anything" --raw | jq -c 'select(.type=="tool-call")'
```

Connects to `POST /sessions/:id/messages/stream` and renders LIVE:

- `text-delta` frames append straight to stdout as they arrive.
- `thinking-delta` frames collapse into one overwritten stderr status
  (`thinking… (N chars)`), erased the moment real text starts.
- `tool-call` opens a line `[tool] write_file(path: x.ts) …` completed by the
  matching `tool-result` (`ok` / `FAIL` + a dim output summary);
  `tool-output` chunks stream live under the active tool line.
- `meta.continuation` / `subagent-status` print dim progress lines.
- `approval.requested` prints a prominent banner (see --auto-approve below).
- The terminal frame ends the turn: `done` prints a `— done · model · N in ·
  N out · $cost` summary (usage from the done frame, finish frame fallback)
  and exits 0; `stopped` prints `— stopped by user` and exits 0; `error`
  prints the red `stream error CODE: message` one-liner and exits 1.

Flags: `--model <id>`, `--thinking default|low|high|max`, `--quiet` (text +
terminal frames only — no thinking, tool, or sub-agent detail), `--raw`
(every frame as one JSON line on stdout — the jq-friendly frame log; exit
codes still follow the terminal frame), `--auto-approve`. If the stream dies
without a terminal frame the CLI says so and exits 1 (the R43 rule).

### `chat:stop` — stop a turn

```bash
node scripts/acute.mjs chat:stop <sessionId>
```

`POST /sessions/:id/stop` — aborts a live turn (the same route the UI's Stop
button uses). Honest message when no turn is live.

### `chat:events` — compact event log tail

```bash
node scripts/acute.mjs chat:events <sessionId> --limit 40
```

`GET /sessions/:id` rendered as `seq · type · short-payload` rows — the
message/tool/error history the UI folds, one line each. `--limit` takes the
LAST N events (default 40).

### `chat:ctx` — context window usage

```bash
node scripts/acute.mjs chat:ctx <sessionId>
```

`GET /sessions/:id/context` rendered: model + window, used tokens + percent,
the system/tools/memory/messages breakdown, session totals, and the
main/sub-agents/combined usage split.

### `approvals` / `approve` / `deny` — the approval flow

```bash
node scripts/acute.mjs approvals                 # pending by default
node scripts/acute.mjs approvals --status approved
node scripts/acute.mjs approve appr_686a20da-... # decides "approved"
node scripts/acute.mjs deny appr_686a20da-...    # decides "denied"
```

While a `chat:stream` turn shows an `approval.requested` banner, the stream
STAYS OPEN until the decision lands — run `approve`/`deny` from another
terminal (that is the harness's two-terminal approval test).

## Ctrl-C / SIGINT: the stop path

During `chat:stream`, SIGINT does NOT just kill the client: the harness
POSTs `/sessions/:id/stop`, keeps reading the stream, and exits 0 when the
`stopped` (or `done`) frame lands — the server-side abort, not a client
disconnect, ends the turn (the R42 contract: disconnects alone let turns
finish in the background). A second SIGINT exits immediately with 130. If no
terminal frame arrives within 10s of the stop POST, the harness says so and
exits 1. Verified live (R58-e): SIGINT after 6s of a counting turn →
`stop -> 200 {"ok":true,"stopped":true}` → `— stopped by user` → exit 0.

## --auto-approve

With `--auto-approve`, every `approval.requested` frame is auto-decided
`approved` (the same POST as `approve`), the banner shows the decision, and
the turn continues unattended. Verified live: two `run_command echo` ask-tier
approvals auto-approved inside one turn, ledger shows both approved. Use it
only on scratch sessions — it defeats the ask tier's purpose.

## Recipe: testing long sessions from the terminal

```bash
export ACUTE_BASE_URL=http://127.0.0.1:5199 ACUTE_TOKEN=acute-dev-local

# 0. dedicated sidecar (see Environment) — then:
node scripts/acute.mjs health
node scripts/acute.mjs agents                                  # pick an agent id

# 1. project + session (tools need the project)
PROJ=$(node scripts/acute.mjs raw POST /projects \
  '{"name":"long-session","rootPath":"/tmp/long-session"}' | jq -r .id)
SID=$(node scripts/acute.mjs chat:new --project "$PROJ" \
  --agent agt_default_nova --title "long run" | jq -r .id)

# 2. multi-turn drive — stream live, watch tools + approvals
node scripts/acute.mjs chat:stream "$SID" "read the project and list every file"
node scripts/acute.mjs chat:stream "$SID" "add a README summarizing the files"
node scripts/acute.mjs chat      "$SID" "now double-check the README"   # sync

# 3. watch state grow
node scripts/acute.mjs chat:ctx "$SID"        # tokens vs window, %
node scripts/acute.mjs chat:events "$SID" --limit 40
node scripts/acute.mjs chat:sessions --project "$PROJ"

# 4. interrupt test: start a long streamed turn, Ctrl-C it, confirm the
#    stop POST + clean exit 0, then continue the SAME session:
node scripts/acute.mjs chat:stream "$SID" "count slowly from 1 to 50"   # Ctrl-C
node scripts/acute.mjs chat:stream "$SID" "where were we? continue"

# 5. cleanup: kill the sidecar, remove the scratch DB — never leave one running
```

`--raw | jq` combos for batteries: count tool calls, capture usage per turn,
assert the final frame — see the R51 battery (`scripts/battery-r51.mjs`) for
the single-invocation boot/test/teardown pattern the sandbox requires.

## API notes (verified live, R58-e)

- `POST /sessions` without `projectId` returns 202 — a projectless session
  runs turns with the agent's plain prompt and NO tools.
- `thinkingLevel` accepts `default|low|high|max` (shared's THINKING_LEVELS)
  — "medium" is a 400; the CLI validates client-side.
- Frames observed on the wire: `text-delta{delta}`, `thinking-delta{delta}`,
  `tool-call{toolName,argsSummary}`,
  `tool-result{toolName,argsSummary,ok,outputSummary}`,
  `tool-output{toolName,chunk}`, `meta.continuation{iteration,reason}`,
  `subagent-status`, `approval.requested/resolved`, `finish{usage}`,
  `done{assistantMessage,usage}`, `stopped`, `error{code,message}`.
- The sync route returns `{assistantMessage, usage}` with a full UsageRecord
  (model, tokens, costUsd); the stream's `finish` frame carries per-call
  usage, `done` the turn's UsageRecord.
- Sessions list rows keep `status:"queued"` between turns — the live status
  is on the events/turn log, not the row (display only; not a harness issue).

## Troubleshooting

- `unreachable http://… — ECONNREFUSED` — the sidecar is not up (or the port
  is wrong). `acute health` against the same `ACUTE_BASE_URL` first.
- `401 UNAUTHORIZED: missing or invalid bearer token` — `ACUTE_TOKEN` does
  not match the sidecar's token.
- `409 CONFLICT: session … is completed/failed` — the session hit a terminal
  status; create a new one (`chat:new`).
- Stream ends with `stream ended without a terminal frame` — the sidecar
  died mid-turn (check its log); the harness exits 1 instead of hanging.
- Approval banner but nothing happens — the turn waits for a decision; run
  `acute approvals` + `acute approve/deny <id>` in another terminal, or
  restart the turn with `--auto-approve`.

## See also

- [TESTING](../runbooks/TESTING.md) — the verification ladder (this harness
  is the L4 live-battery driver).
- [MAINTENANCE](../runbooks/MAINTENANCE.md) — where the sidecar routes live.
- `scripts/acute.mjs` — the implementation (usage header = the full command
  list).
- `scripts/battery-r51.mjs` — the single-invocation battery pattern.
