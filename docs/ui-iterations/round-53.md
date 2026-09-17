<!-- last-reviewed: 2026-09-17 round-102 -->
# Round 53 — The connection round: the packaged app's "Could not reach agent-core at 127.0.0.1:55963" (stale ephemeral port + handshake race + invisible startup failures), the connection splash/offline screen, restart-engine recovery, and sidecar.log diagnostics

**Date:** 2026-08-30 · **Branch:** `main` · **Version:** 0.53.0 · **Owner directives:** the sixth Windows test session's report — "the application ran into some issues… it was unable to create projects… Could not reach agent-core at http://127.0.0.1:55963 (TypeError: Failed to fetch)… Agent core unreachable — start the app (or pnpm dev:full) to pick a sub-agent model… the pre saved api keys were not loaded by default… quality over speed and verify the things too."

**The owner's three symptoms, one root cause:**

- "Could not reach agent-core at http://127.0.0.1:55963 (TypeError: Failed to fetch)" while creating a project.
- "Agent core unreachable — start the app (or pnpm dev:full) to pick a sub-agent model." (Settings → Sub-agents)
- "The pre-saved API keys were not loaded by default."

All three are the UI talking to a dead endpoint. The keys were never lost — they sit in Windows Credential Manager exactly where the launcher put them; the key-pool screen just couldn't reach the engine that reports them. (Also noted by the owner as OK: the desktop app opens a window, not a browser — the designed behavior of the packaged flow.)

---

## The failure chain (reconstructed from the code, then fixed at every link)

1. **Ephemeral port.** `startServer({ port: 0 })` → the OS assigns a fresh port per launch (55963 was ONE session's port).
2. **The store persisted it.** `config-store.ts` `partialize` wrote `baseUrl` + `demoData: false` to localStorage. The token was (correctly) never persisted — but the port was.
3. **Next boot rehydrated the dead port** — with `demoData: false`, so not even the demo fallback ran. Every request → `TypeError: Failed to fetch` at the previous session's port.
4. **The handshake race made adoption unreliable.** The Rust `setup` ran the handshake SYNCHRONOUSLY (spawn → ready line → health poll, up to 15s + 10s), while the webview loaded in parallel. `getSidecarInfo()` fired exactly ONCE at module load: if `sidecar_info` answered "sidecar not running" (handshake still in flight), the catch swallowed it and NOTHING retried — the app stayed on the stale port for the entire session. This also froze the first paint for the handshake's duration.
5. **Failures were invisible.** A sidecar that failed to start in the packaged app printed its error with `eprintln!` — into a GUI process with no console. The owner's only symptom was the fetch error, and we (the agents) had no channel to see the real reason remotely.
6. **Broken queries stayed broken.** React Query (`retry: 1`, `refetchOnWindowFocus: false`) had no invalidation hook on endpoint adoption, so even a late adoption didn't heal already-failed screens.

## The fixes

### A — Rust shell (`src-tauri/src/sidecar.rs`)

- **Non-blocking start:** `start()` manages the state and spawns the handshake on a BACKGROUND thread; `setup` returns instantly — the window paints while the engine boots.
- **Phase machine:** `Starting → Running{port, token} | Failed{error} | Stopped`, behind one RwLock, with a **child monitor thread** that flips Running → Failed("agent-core exited unexpectedly (code N)") on a mid-session death (checked every 500ms, quietly stops when a restart/shutdown takes over).
- **New commands:** `sidecar_status` → `{phase, port?, error?}` (the diagnostics channel — the REAL spawn failure string), and `restart_sidecar` → graceful teardown (authed `/internal/shutdown` → 3s grace → `taskkill /T /F`) then a fresh handshake on a new thread; serialized by a restart lock; "already starting" is a no-op.
- **`sidecar.log`:** every lifecycle line (boot, spawn command, ready, health, injected provider keys as id+length ONLY — never values, stdout tail, failures, exits) appends to `%APPDATA%\acute-code\sidecar.log` (XDG data dir on Linux dev); best-effort, never fatal; rotated at 1 MB once per boot.
- `state_dir()` also fixes dev-on-Linux (`default_db_path` used to hard-require `APPDATA`).
- The provider-key injection line makes "keys not loaded" definitively answerable from the log: `injected provider keys: openrouter (len 73), openrouter-slot2 (len 73), …`.

### B — Webview connect loop (`src/lib/sidecar-connection.ts`, NEW)

- **Poll, don't one-shot:** `sidecar_info` every 400ms, deadline 90s (a cold first boot runs SQLite migrations).
- **Fail fast on real failure:** each refused attempt asks `sidecar_status`; `failed`/`stopped` → offline IMMEDIATELY with the shell's error string (no 90s burn when the answer is known).
- **Adoption heals everything:** on success → `adoptEndpoint` + `invalidateQueries()` (ALL — pre-adoption failures refetch) + start the watchdog.
- **Watchdog:** `ping_sidecar` every 20s while connected; a dead ping re-enters the loop → transient blips reconnect (re-adoption + re-invalidate), real deaths land on the offline screen with the exit reason.
- **`retryConnection()`** (the offline banner's button): `restart_sidecar` through the shell, then poll. Browser mode never enters the loop — behavior identical to pre-R53.

### C — The connection gate (`src/components/shell/ConnectionGate.tsx`, NEW; `App.tsx`)

- Tauri + `connecting` → branded splash (logo + spinner + "first launch can take a little longer"): **no route mounts, no query fires, until the endpoint is live.** This kills the race class entirely rather than outrunning it.
- `offline` → full-screen card: the REAL error (mono), **Restart engine** button (spinner while the shell tears down/respawns), the sidecar.log pointer.
- `connected` / browser → children, unchanged.
- FirstRunCheck now runs only after connection — the wizard's provider probe is finally reliable (its own 6-retry shim stays as a harmless belt-and-suspenders).

### D — The stale-port retirement (`src/lib/config-store.ts`)

- **In Tauri, persist NOTHING:** `partialize → {}`; the persisted v1 blob (baseUrl+demoData) is dropped on merge. Store version 2 (zustand discards v1 blobs without a migrator — verified by test, then pinned: a v1 blob must never rehydrate a dead port anywhere).
- New state: `connection: "connecting" | "connected" | "offline"` + `connectionError` (browser defaults connected; Tauri starts connecting).
- `baseUrl` default now `||` (an empty-string env var falls through to the safe default instead of becoming the endpoint).

### E — Copy honesty (`SubAgentsTab`)

- The "start the app (or pnpm dev:full)" advice was DEV advice shown inside a packaged install. Mode-aware now: the desktop app points at the connection banner's Restart engine.

## Verification

- **Unit:** 23 new tests across `config-store.test.ts` (the stale-port regression incl. the v1-blob retirement, adoptEndpoint, connection states), `sidecar-connection.test.ts` (adopt-after-N-failures, fail-fast on failed/stopped, honest timeout, browser no-op, watchdog death + transient-blip reconnect, retry-through-shell), `sidecar.test.ts` (+7 for the command wrappers). Suite: **1058/1058 in 75 files** (was 1035/73). Lint + typecheck clean.
- **Rust:** `cargo check` green on the **x86_64-pc-windows-gnu target** — every `cfg(windows)` path (CREATE_NO_WINDOW, taskkill) type-checked in THIS sandbox via a user-local mingw (binutils + gcc extracted from .debs — no root needed; windres needed a gcc-preprocessor symlink). `cargo fmt` clean. CI re-verifies on windows-latest.
- **Live battery (browser mode against the real sidecar):** fresh-profile boot → setup wizard (provider list from the LIVE /providers, PlugBrain renders OpenRouter + base URL + model) → skip → dashboard on real data → **created the project `r53-battery-project` via the Add-project dialog (the owner's exact failing path)** → opened a session → sent "Reply with exactly: R53 CONNECTION GATE VERIFIED" → the live model replied exactly that (8.3s, 1.1 tok/s, z-ai/glm-5.2:free) → Usage screen on real ledger data (653K tokens / 11 requests / 53 tool calls) → Settings → Sub-agents fully live (key slots + 18 free/46 all model catalog, no unreachable message). **Zero console errors, zero page errors.** Screenshot: agent-ctx/r53/subagents-live.png.
- What CANNOT be verified in this sandbox: the actual packaged Windows exe (the splash/offline/restart flows run through `window.__TAURI__`, exercised here only through unit tests with the mocked shell; the Rust lifecycle is compile-verified + CI-verified). The owner's next ACUTE.bat run is the final judge — and now sidecar.log + the offline screen make any failure self-explaining.

## The R52 lesson, applied

R52 taught that CI-on-Windows is the only oracle for Windows semantics. R53 adds its sibling: **the packaged app is a production environment without a console — if a failure can happen there, its reason must be observable from there** (sidecar.log, `sidecar_status`, the offline screen). The stale-port bug itself was born from persisting something ephemeral — the fix deletes the persistence rather than patching around it.

---

## For the next agent

- The four shell commands live in `src-tauri/src/sidecar.rs`; the wire types in `src/lib/sidecar.ts`. New shell commands must keep the never-log-values rule (id + length only).
- The connect loop is generation-guarded (`beginSidecarConnect` bumps a module counter; StrictMode double-mounts and watchdog re-entries supersede cleanly). Test seam: `__resetConnectionLoopForTests`.
- `config-store` version is 2; if the shape ever changes again, bump and remember zustand DISCARDS non-migrated persisted blobs (that behavior is now load-bearing — pinned by test).
- The dev stack on Linux binds vite to `::1` (use `http://[::1]:5173`) and the sidecar to `127.0.0.1:5178`; start it detached with `(node scripts/dev.mjs > log 2>&1 &)` — plain `&` dies with the tool call.
