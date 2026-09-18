<!-- last-reviewed: 2026-09-18 round-105 -->
<!-- status: planning (PLAN-CLI, R105) — implementation wave follows in a later round -->
<!-- planning-round: 1 of N (the owner's multi-round directive) -->

# The `acute` Command-Line Interface — Design (PLAN-CLI)

Round 105's planning artifact for the owner's directive: "I feel like our
agent should be usable using a command-line interface too, so that you
can easily check it out, work with it, and handle it much better."
Grounded read-only in the real code: the sidecar spawn protocol
(`src-tauri/src/sidecar.rs` → `ACUTE_TOKEN`/`ACUTE_DB_PATH`/`ACUTE_READY`
ready-line), the R98-K portal-discovery file, the existing 1,006-line
dev harness (`scripts/acute.mjs` — the seed, not the product), the full
`/api/v1` route surface, the `StreamTurnEvent` frame union, the
launcher-kit release asset, WAL-mode SQLite, and the app's theme tokens.
Reference blueprint: the oh-my-pi CLI study (MIT) — lazy command loading,
flag tables as the single source of truth, and streaming output shaping
that never re-serializes snapshots.

## 1. Architecture: attach-or-spawn

```
┌──────────── terminal ─────────────┐
│ acute (Node ≥20, zero-dep ESM)    │
│ cli/ — new pnpm workspace package │
└──────┬────────────────┬───────────┘
   1 ATTACH            2 SPAWN (fallback)
   resolve portal      node agent-core/dist/main.js
   file → GET /health  env: ACUTE_TOKEN (256-bit hex)
       │               ACUTE_DB_PATH, ACUTE_PROVIDER_*
       ▼               ▼ (ACUTE_READY line handshake)
┌──────────────────────────────────────────────┐
│ agent-core sidecar (Fastify, loopback)       │
│ GET /health (no auth) · /api/v1/* (Bearer)   │
│ POST /sessions/:id/messages/stream → SSE     │
│ writes <dbDir>/acute-portal.json             │
│   {port, token, pid, startedAt}, mode 0600   │
└──────────────────────────────────────────────┘
```

**Resolution order** (the repo's existing R98-K contract): explicit
`ACUTE_BASE_URL` + `ACUTE_TOKEN` (both or neither) → discovery file —
`<repo>/.dev/acute-portal.json`, then the installed app's state dir
(`%APPDATA%\acute-code` / `$XDG_DATA_HOME/acute-code`) → spawn.

**Spawn** is the Node port of `sidecar.rs::spawn_and_handshake`
(~70 lines; the `scripts/dev.mjs` precedent): mint
`randomBytes(32).toString("hex")`, default `ACUTE_DB_PATH` to the app's
DB (WAL makes concurrent CLI + desktop sidecars safe; `--db` isolates),
await the `ACUTE_READY {"port":…}` stdout line (25s, 3 attempts, kill
the orphan on failure), health-poll, verify the portal file appeared. A
CLI-spawned sidecar is a detached daemon: the CLI sends SIGTERM on exit
**only when it owns the pid** recorded in the portal file; attaching
never tears anything down. The portal file is last-boot-wins — the CLI
writes it only when it spawns.

## 2. Command surface

| Command | Routes used |
|---|---|
| `acute` | REPL — `/model /agent /sessions /stop /compact /exit` slash commands |
| `acute -p "prompt"` | one-shot: create session → stream → exit (M1) |
| `acute sessions ls/resume/rm/show/ctx/events` | `GET/PATCH/DELETE /sessions…`, `/sessions/:id/context` |
| `acute models [provider]` · `models test <id>` | `/models/catalog`, `/models/configured`, `/models/:id/test` |
| `acute providers` · `acute keys status` | `GET /providers` (hasKey flags, never values) |
| `acute config get/set` | `~/.acute/cli.json` (default agent/model/db) |
| `acute status` | portal file + `/health` + version |
| `acute raw <METHOD> <path> [json]` | authenticated escape hatch (inherited from acute.mjs) |

Global flags: `-p/--print`, `--mode text|json`, `--agent`, `--model`,
`--session`, `--db`, `--quiet`, `--no-color`, `--auto-approve`.
**`--mode json`** = NDJSON: sidecar frames pass through verbatim, one per
line, wrapped with `cli.session`/`cli.attach`/`cli.exit` lifecycle
events; exit code from the terminal frame (done/stopped → 0, error → 1).
One `flags.ts` table drives parsing *and* `--help` generation (single
source of truth); command modules load lazily via `await import()`.

## 3. File layout

```
cli/                    # package "acute-cli", bin: { acute: bin/acute.mjs }
  package.json          # zero runtime deps (Node built-ins only)
  tsconfig.json         # tsc → dist/, mirrors agent-core's build
  bin/acute.mjs         # shim → dist/main.js
  src/main.ts           # flag-table parse, lazy dispatch
  src/connection.ts     # env → portal discovery → spawn+handshake
  src/spawn.ts          # Node port of sidecar.rs handshake
  src/api.ts            # Bearer fetch + {error:{code,message}} envelope → ApiError
  src/stream.ts         # SSE reader (the api.ts "\n\n" buffer-split loop)
  src/render/           # text.ts (markdown-lite), status.ts (spinner),
                        #   tools.ts (tool cards), json.ts
  src/commands/*.ts     # one file per group
  src/repl.ts · src/config.ts
```

`scripts/acute.mjs` stays untouched (dev harness, referenced by round
docs); `cli/` re-implements the discovery resolver in TS. The package
joins `pnpm-workspace.yaml`, `pnpm verify`, and the version-bump set.

## 4. SSE → terminal rendering spec

**Incremental only — each frame writes its own delta, nothing is ever
re-rendered** (the oh-my-pi fix: no accumulated snapshot, no quadratic
re-serialization).

- `text-delta` → stdout verbatim; pending status line cleared first
  (`\r\x1b[2K`).
- `thinking-delta` → one overwritten dim stderr line `thinking… (N
  chars)`; non-TTY: count only.
- `tool-input-start/-delta` → spinner line gains tool name + first
  streamed arg.
- `tool-call` → newline + orange `▸ toolName(argsSummary)`;
  `tool-output` streams beneath; `tool-result` → ` ok`/`FAIL` + dim
  140-char summary.
- `meta.retry|key|queue_continue|compaction|overflow_recovery` → dim
  status lines; `subagent-status` → `[A1] running · task…`.
- `approval.requested` → yellow card; y/n prompt in REPL,
  `--auto-approve` elsewhere (`POST /approvals/:id/decision`).
- Terminal: `done` → dim `— done · model · N in · N out · $X` (exit 0);
  `stopped` (exit 0); `error` → red envelope (exit 1); stream dies
  without a terminal frame → synthesized `STREAM_DISCONNECTED` (the R43
  rule).
- **Markdown-lite** applied as a streaming state machine: `**bold**`,
  `*italic*`, `` `code` `` (accent-tinted), fences → indented dim block,
  `##` → bold orange.
- **Ctrl+C**: 1st press during a turn → `POST /sessions/:id/stop`, keep
  reading until `stopped` (10s give-up); 2nd → exit 130. Idle in REPL:
  clears the line; double-press exits. Resize: status lines are
  single-line and re-padded — SIGWINCH needs no special handling.

Colors: accent `#ff6b2c` → truecolor `38;2;255;107;44`, ok green, fail
red, meta dim; `NO_COLOR` and non-TTY auto-disable (acute.mjs's existing
rule).

## 5. Auth / provider keys

Keys live in the sidecar's in-memory keyring, snapshotted from spawn env
— the desktop shell injects from the OS keyring (ADR-0031); a Node CLI
cannot. **Attach mode needs no keys at all** (the running sidecar
already holds them). For CLI-spawned sidecars, resolve per provider,
dev.mjs-style: `ACUTE_PROVIDER_<ID>` env → `~/.acute/<id>.key` (0600) →
OS keyring probe (`scripts/credential.ps1` on Windows; `secret-tool` on
Linux; absent on headless → honest "no key"). Never argv (visible in
/proc), never logged — length only, the repo's convention.
**Follow-up (M3+):** `acute keyring pull` bridges OS-keyring keys into
`~/.acute/*.key` once, closing the loop with the desktop store.

## 6. Milestones, effort, tests

- **M1 — smallest useful thing: `acute -p` against a running sidecar.**
  Env + discovery only (no spawn). Default agent = first registry agent
  (`GET /agents`), `POST /sessions`, stream, render, exit code. ≈1.5
  days. Tests: renderer units with recorded frame fixtures (pure
  frame→string functions); one live smoke (the `scripts/smoke.mjs`
  pattern) against `pnpm dev:full`.
- **M2 — spawn-or-attach + REPL + `sessions/models/status` +
  `--mode json`.** ≈3–4 days. Tests: handshake integration against a
  real `agent-core/dist/main.js` on a temp DB (ephemeral port, kill on
  exit); REPL via fake stdin.
- **M3 — ship + polish.** Bundle `cli` (esbuild single file, still
  zero-dep) into the **launcher-kit** zip — the shipping vehicle, since
  the repo is proprietary (no npm publish); `acute.sh`/`ACUTE.bat` gain
  an `acute` setup mode installing to `~/.acute/bin`. Plus approvals,
  markdown polish, `config`. ≈2–3 days.

## 7. Risks

1. **Two sidecars, one DB** (CLI + desktop concurrent): WAL-safe, but
   portal file last-boot-wins — attach-first, write only on own spawn,
   `--db` escape hatch.
2. **Version skew** CLI↔sidecar: unknown frames ignored (acute.mjs
   precedent); `acute status` reports both versions.
3. **Windows verbatim-path EISDIR** (R55 lesson): spawn must pass plain
   paths; spawning the *installed* resource tree (M3) must copy
   `simplified_path` behavior — M1/M2 spawn only the repo's `dist`.
4. **Zero-dep discipline**: hand-rolled ANSI/spinner/markdown; a library
   would trigger license-audit + bundling decisions each time.
5. **REPL complexity creep**: readline + one status line only; no
   full-screen TUI in scope.
