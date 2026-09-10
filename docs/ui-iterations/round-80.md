<!-- last-reviewed: 2026-09-10 round-84 -->
# Round 80 — The Reliability Round (silent stops + raw errors + retry customization + NVIDIA)

**Provenance:** the owner's verbatim field report, four clauses:
1. *"the issue I have been having the chat ends without any error message or
   anything some times — this needs to be fixed"*
2. *"for error messages raw messages should be shown too"*
3. *"in the settings retry customization is needed"*
4. *"make sure it works with the nvidia api key too"* (+ the key
   distribution: KEY_1 → the main project, KEY_2/3/4 → the sub-agent pool,
   the `nvapi-…` key → NVIDIA).

The plan is `agent-ctx/R80-plan.md`. This session continued an in-flight
tree left by the context break — the implementation was verified
line-by-line, two typing bugs and five stale-test-pin classes were fixed
honestly, and the whole stack was re-proven from the gates up.

**Everything is implemented, unit-tested (+31 net), live-verified on the
real keys, and version 0.79.0.**

---

## 1. The silent stops: three root causes, three honest terminal paths

The owner's complaint — a chat that just STOPS, no error, no card, nothing —
had three distinct producers. All three now end through the honest terminal
path (persisted `turn.error` + the 502 outcome + the session reset to
`queued` so the retry affordance stands):

| # | root cause | pre-R80 behavior | the R80 fix |
|---|---|---|---|
| A1 | the provider closes the SSE stream CLEANLY mid-generation (no error part, no finish-step — the clean-close drop) | `streamAiSdkChat` synthesized a finish; the turn "completed" with truncated text; no error | the truncation guard: zero finish-step parts + content deltas → the honest throw ("provider stream ended without a finish signal — the connection closed mid-response") — `connection closed` matches the classifier's network pattern → the retry ladder engages; the partial text is preserved by the R75 flush |
| A2 | the 800k-token context guard / the 200-request guard tripped mid-loop | the guards emitted SSE-only meta frames nobody rendered and broke the loop `ok:true` — a silent stop | the `guardStop` — the LOOP_GUARD pattern exactly: persisted `turn.error` (codes `CONTEXT_LIMIT` / `REQUEST_LIMIT`, honest actionable messages), usage recorded, the 502 outcome, the session back to `queued` |
| A3 | an unexpected crash INSIDE the stream route (after the turn machinery handed off) | the live error frame fired but NOTHING persisted — reload showed the conversation ending at the user message; the session row stayed `running` until the boot sweep | best-effort `persistTurnError` (export from runtime; crash-guarded — the handler never throws) + the honest `task_failed` notification, both inside the route catch |

The A1 guard is deliberately conservative: it only fires when content WAS
streaming (an empty stream stays on the existing NO_OUTPUT paths — no false
positives on legitimately-empty replies), and a healthy stream (finish-step
present) passes untouched — pinned by both unit tests and the live OpenRouter
turn below.

## 2. Raw error messages (ask 2)

The caps existed for card readability, but the UI's R77 expand-toggle
already collapses long text with a scrollable mono block — the caps only
ever HID the provider's real payload:

| surface | before | after |
|---|---|---|
| `providerErrorDetail` (error-classification.ts) | 500 | 4000 |
| `honestUserMessage` / userMessage one-liner | 240 | 600 |
| providers/registry `scrub` (connection-test lines) | 500 | 4000 |
| `upstreamErrorDetail` slice | 160 | 2000 |
| debug-analyst error slice (server.ts) | 300 | 2000 |

The key-scrub discipline is unchanged — every surface still splits the API
key out; the NVIDIA `nvapi-…` prefix joined the scrub patterns
(`error-bus.ts SCRUB_PATTERNS` + `chat.ts summarizeToolOutput`).

## 3. Retry customization (ask 3)

`RetrySettings` (storage/settings.ts, the `/settings/retry` GET/PUT) gained
three fields, every one validated at BOTH the route and the storage layer
with the exact bounds the runtime resolves with:

- **`maxAttempts`** — total provider attempts per turn (initial + rungs),
  integer 2–10, default 6 (the R75 spec).
- **`waitMinutes`** — the rung waits in minutes (JSON array; rung i = the
  wait before attempt i+2), 1–9 entries of 0–1440 each, default
  `[0, 1.5, 5, 10, 30]` (the R75 ladder verbatim).
- **`providerTimeoutSeconds`** — the per-call provider ceiling, integer
  60–3600, default 600 (= the old hardcoded `PROVIDER_CALL_TIMEOUT_MS`).

The resolution is defensive-by-construction (`retry.ts
resolveRetrySchedule`): missing/out-of-bounds values fall back rung-by-rung
to the R75 defaults, so a corrupt row can never produce a zero-rung or
negative-wait ladder — and the DEFAULT schedule is byte-identical to
pre-R80 behavior (the R75 pins still pass unmodified). Both runtime catch
sites (sync + streamed) resolve the schedule per turn; the provider-call
timeout threads into `chat`/`chatStream` as `timeoutMs`; the
`task_failed` notification's schedule line and the Settings footnote are
built from the REAL resolved settings (`describeRetrySchedule`) — never the
hardcoded rungs again.

The Settings **General → Auto-retry card** grew the schedule section: the
max-attempts stepper (`retry-max-attempts` ±), one editable wait input per
rung (`retry-wait-N`, attempt-labeled), the provider-call timeout input
(`retry-timeout`), and Reset to defaults (`retry-reset`) — every control
PUTs a partial patch through the same mutation; the rung rows and the
footnote re-render from the refetched state.

## 4. NVIDIA NIM support (ask 4)

- **The seed:** `nvidia` joins `RESERVED_PROVIDER_IDS` +
  `BUILTIN_PROVIDER_SEEDS` (https://integrate.api.nvidia.com/v1,
  chat-completions — the OpenAI-compatible adapter speaks it as-is; models
  load through the existing `/models` fetch, no catalog seeds).
- **The key:** `ACUTE_PROVIDER_NVIDIA` joins `keys.rs
  provider_key_env_targets` (the packaged app's spawn injection — Credential
  Manager under ACUTE-CODE/provider/nvidia) and `dev.mjs readNvidiaKey`
  (env → `~/.acute/nvidia.key`, never printed, length only). The Settings
  Add-Provider dialog's preset list routes to the same id.
- **The scrub:** the `nvapi-…` prefix joins every redaction surface.
- **Live state (2026-09-09, the real key):** endpoint reachable (198 ms),
  the 81-model catalog fetches, the key authenticates (account-named
  responses; a bad key would 401) — and the account's NIM model functions
  have nearly all reached EOL (real 410 bodies: "reached its end of life on
  2026-08-26"), which the raw-error surfaces now show verbatim. The
  integration is done; model availability is NVIDIA's account state.

## 5. Verification

- **Unit:** four new suites — `r80-silent-stops.test.ts` (A1's three guard
  tests + A2's two guard-stop tests), `r80-route-crash.test.ts` (A3: the
  route crash persists + notifies), `r80-retry-schedule.test.ts` (the
  resolver's bounds/fallbacks/padding + the storage round-trip + the route
  validation + the runtime threading), `r80-raw-errors-nvidia.test.ts`
  (the caps + the scrub patterns + the seed) — plus the honest pin updates
  where the round deliberately changed behavior: the R78 cap pins
  (240→600, 500→4000), the providers seed pins (the nvidia row), the
  R58/R78 stream mocks now model the healthy wire (a finish-step part —
  the missing finish-step was exactly the silent-stop shape the guard
  exists to catch; the mocks were teaching the wrong wire), and the
  SettingsPage mock models the current server shape with 4 new
  schedule-control tests. Net +31: **2772/2772 in 149 files** (from 2741
  in 145).
- **Gates:** `pnpm lint` clean; root typecheck clean; agent-core typecheck
  clean; `pnpm --filter agent-core run build` ships.
- **Live (the real keys, `dev:full` on a fresh DB):** the provider list
  seeds nvidia with `hasKey:true` (the env-injected key); the retry GET
  carries the new fields; PUT maxAttempts/waitMinutes/timeout round-trips
  and out-of-bounds values get honest 400s naming the field; the NVIDIA
  connection test + models fetch work (§4); and a REAL OpenRouter streamed
  turn ("Reply with exactly: R80 LIVE TURN OK" → `R80 LIVE TURN OK`,
  114 thinking + 7 text deltas, finish + done) — the healthy-path proof
  that the truncation guard has no false positives against a real
  provider's finish-step.

## 6. Honest notes

- The in-flight tree from the context break was a CLAIM until verified
  (AGENT-MEMORY lesson #82): the implementation was real and correct, but
  one test file didn't typecheck (untyped `AsyncGenerator` fakes) and five
  test-pin classes predated the round's behavior changes. All fixed in
  this session, honestly recorded here.
- The NVIDIA account's model functions are EOL'd server-side — the
  connection test reports the honest raw bodies; no code can fix a
  provider-side retirement. The catalog fetch + key validation + raw
  error surfacing (the round's actual asks) are all verified working.
- `meta.context_limit` / `meta.request_limit` / `meta.continuation_complete`
  frames are now TYPED in the frontend StreamTurnEvent union (they ride
  the stream before the terminal error frame) — the store takes no action
  on them by design: the persisted `turn.error` + the error card own the
  render.

## 7. Files touched

`agent-core/src/agents/chat.ts` (A1 guard + nvapi scrub) ·
`agent-core/src/agents/runtime.ts` (A2 guard stops + the resolved schedule
threading + `persistTurnError` export) · `agent-core/src/server.ts` (A3
route-crash persistence + the retry-route validation + the schedule line +
the error-slice raises) · `agent-core/src/lib/retry.ts`
(`resolveRetrySchedule` + `describeRetrySchedule` + the bounds constants) ·
`agent-core/src/agents/error-classification.ts` (the caps) ·
`agent-core/src/providers/registry.ts` (the scrub caps) ·
`agent-core/src/storage/providers.ts` (the nvidia seed) ·
`agent-core/src/storage/settings.ts` (the three fields + read/write
validation) · `scripts/dev.mjs` (readNvidiaKey) · `src-tauri/src/keys.rs`
(the env target) · `src/lib/api.ts` (RetrySettings + the typed frames) ·
`src/lib/error-bus.ts` (the scrub pattern) ·
`src/components/settings/ModelsProvidersTab.tsx` (the preset) ·
`src/pages/SettingsPage.tsx` (the schedule section) · tests: the four new
r80 suites + `r78-retry-settings` / `r78-error-classification` /
`r78-queue` / `r58-stop-and-replay` / `providers` / `SettingsPage` pin
updates.
