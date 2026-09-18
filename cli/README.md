# The `acute` CLI

The ACUTE-CODE terminal client — attach to a running sidecar (the desktop
app's own agent server) or spawn one, then work with the agent from any
terminal. Built per `docs/planning/CLI-DESIGN.md` (M1+M2); zero runtime
dependencies (Node ≥ 20 built-ins only).

## Run it (from the repo root)

```bash
node cli/bin/acute.mjs --help          # the full surface
node cli/bin/acute.mjs status          # portal file + /health + versions (never spawns)
node cli/bin/acute.mjs -p "explain this repo"   # one-shot: session → stream → exit
node cli/bin/acute.mjs                 # the REPL (/model /agent /sessions /stop /compact /exit)
```

Build from source once (the bin shim imports `dist/`):
`pnpm --filter acute-cli run build`.

## The command surface

| Command | What |
|---|---|
| `acute` | the REPL — slash commands, one status line, approval y/n + agent-question prompts |
| `acute -p "prompt"` | one-shot: create a session, stream the reply, exit with the turn's code |
| `acute sessions ls/show/events/ctx/rm/rename/resume` | session management (`ls`/`events` take `--limit N`) |
| `acute models [provider]` · `acute models test <id>` | catalog, configured rows, probes |
| `acute providers` · `acute keys status` | provider rows (hasKey flags — never values) |
| `acute approvals ls [--status pending]` | the human permission queue (GET /approvals) |
| `acute approvals <id> approve|deny` | POST the decision (`--remember once\|always`) |
| `acute config get/set` | `~/.acute/cli.json` — default agent/model/db |
| `acute status` | portal file + `/health` + both versions |
| `acute raw <METHOD> <path> [json]` | the authenticated escape hatch |

Global flags: `-p/--print`, `--mode text|json` (NDJSON frame passthrough
with `cli.session`/`cli.attach`/`cli.exit` lifecycle), `--agent`,
`--model`, `--session`, `--db`, `--quiet`, `--no-color`, `--auto-approve`,
`--version`. Unknown commands/flags get a did-you-mean hint; every
argument error fires before any sidecar spawn.

## How it connects (attach-or-spawn)

1. **Env:** `ACUTE_BASE_URL` + `ACUTE_TOKEN` (both or neither).
2. **Portal discovery:** `<repo>/.dev/acute-portal.json`, then the
   installed app's state dir — whichever sidecar booted last.
3. **Spawn:** `node agent-core/dist/main.js` with a fresh 256-bit token,
   the `ACUTE_READY {"port":…}` stdout handshake (25s, 3 attempts, orphan
   killed on failure), a health-poll, and the portal file written ONLY
   when the CLI owns the spawn. Exit SIGTERMs the sidecar ONLY when the
   CLI spawned it — attaching never tears anything down.

## Provider keys

Attach mode needs NO keys (the running sidecar holds them). Spawn mode
resolves per provider: `ACUTE_PROVIDER_<ID>` env → `~/.acute/<id>.key`
(0600) → honest "no key". Keys are never passed as arguments and never
logged (length only). Example:

```bash
ACUTE_PROVIDER_OPENROUTER=sk-or-v1-… node cli/bin/acute.mjs -p "hello"
```

## Ctrl-C discipline

First press during a running turn: sends `POST /sessions/:id/stop` and
keeps reading until the `stopped` frame (10s give-up). Second press:
exit 130. Idle in the REPL: clears the line; double-press exits.

## Approvals & agent questions mid-turn

When the agent asks permission (`approval.requested` frames) or asks you a
question (`agent-question` frames from the `ask_user` tool), a terminal
session prompts inline — y/N for approvals, numbered options (or free
text) for questions — and POSTs the decision. Piped stdin gets the card
plus the `acute raw POST …` hint instead (nothing blocks on a dead stdin).
`acute approvals ls` / `acute approvals <id> approve|deny` settle pending
approvals from any terminal.

## Tests

`pnpm --filter acute-cli run test` — renderer fixtures, the SSE reader
(including mid-frame chunk boundaries), connection resolution order, and
a REAL handshake integration against `agent-core/dist/main.js` on a temp
database.
