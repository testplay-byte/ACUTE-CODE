# R80 plan — the silent-stops + raw-errors + retry-customization + NVIDIA round

Owner's verbatim asks (this round's four clauses):
1. "the issue I have been having the chat ends without any error message or anything some times — this needs to be fixed"
2. "for error messages raw messages should be shown too"
3. "in the settings retry customization is needed"
4. "make sure it works with the nvidia api key too" (+ key distribution: KEY_1 main, KEY_2/3/4 sub-agents, nvapi- key for NVIDIA)

## A. Silent-termination fixes (ask 1) — three root causes, three fixes
- A1 `chat.ts streamAiSdkChat`: the provider can close the SSE stream CLEANLY mid-generation
  (no error part, no finish-step) → the adapter synthesized a finish and the turn "completed"
  with truncated text and NO error. FIX: count finish-step parts; zero finish-steps + content
  deltas arrived → throw the honest truncation error (message crafted to classify as `network`
  → the retry ladder engages). Conservative: only when content was streaming.
- A2 `runtime.ts` context/request guards (800K tokens / 200 requests): emitted SSE-only meta
  frames nobody renders, then broke with ok:true → the chat just stopped. FIX: mirror the
  LOOP_GUARD exit — persisted turn.error (codes CONTEXT_LIMIT / REQUEST_LIMIT, honest
  actionable messages, usage recorded, session reset to queued) + the 502 outcome.
- A3 `server.ts` route catch: an unexpected crash in the route itself sent the live error frame
  but persisted NOTHING (reload = the turn vanishes, session stuck running). FIX: best-effort
  persistTurnError (export from runtime) + task_failed notification, both crash-guarded.

## B. Raw error text (ask 2)
- providerErrorDetail cap 500 → 4000 (error-classification.ts).
- honestUserMessage cap 240 → 600.
- providers/registry.ts scrub cap 500 → 4000; upstreamErrorDetail 160 → 2000.
- debug-analyst error slice 300 → 2000 (server.ts).
- UI already has the R77 expand-toggle; the RAW text it reveals is now the real payload.

## C. Retry customization (ask 3)
- RetrySettings += maxAttempts (2..10, default 6), waitMinutes (rung waits, default
  [0, 1.5, 5, 10, 30]), providerTimeoutSeconds (60..3600, default 600).
- retry.ts: resolveRetrySchedule(settings) → {ladderMs, totalAttempts, timeoutMs} +
  describeRetrySchedule; the R75 constants stay as the DEFAULTS (r75 pins keep passing).
- runtime.ts both catch sites: resolved schedule replaces RETRY_LADDER_MS /
  RETRY_TOTAL_ATTEMPTS; timeoutMs threaded into chat + chatStream calls.
- server.ts task_failed body: the schedule line built from the real settings.
- /settings/retry GET/PUT: validation for the new fields.
- SettingsPage RetryConfigCard: the switches + max-attempts stepper + per-rung wait inputs +
  provider timeout + Reset to defaults + dynamic footnote.

## D. NVIDIA support (ask 4)
- BUILTIN_PROVIDER_SEEDS + RESERVED_PROVIDER_IDS += nvidia (https://integrate.api.nvidia.com/v1,
  chat-completions — the OpenAI-compatible adapter already speaks it).
- ModelsProvidersTab PRESETS + PRESET_PROVIDER_IDS += nvidia.
- keys.rs provider_key_env_targets: + ("ACUTE_PROVIDER_NVIDIA", "nvidia") (packaged-app spawn).
- dev.mjs: readNvidiaKey (env ACUTE_PROVIDER_NVIDIA → ~/.acute/nvidia.key) → sidecar spawn env.
- nvapi- scrub patterns: error-bus.ts SCRUB_PATTERNS + chat.ts summarizeToolOutput.
- Live keys: ~/.acute/openrouter.key (KEY_1) + openrouter-slot{2,3,4}.key (KEY_2/3/4) + nvidia.key.

## E. Verification
- Unit: new r80 tests (truncation guard, guard persistence, schedule resolution + storage
  round-trip, raw caps, nvidia seed) + r78 pins updated for the additive defaults.
- Gates: pnpm lint + typecheck + full root suite.
- Live: dev:full stack on the real keys — a real OpenRouter turn end-to-end, the Settings
  retry card + NVIDIA provider + connection test, curl the NVIDIA endpoint.

## F. Close-out
- round-80.md, CHANGELOG [0.79.0], HANDOFF, status.json, DESIGN-SYSTEM + IMPLEMENTED-API rows,
  version:set 0.79.0, docs:check, commit + tag v0.79.0 + push + CI watch + release +
  DASHBOARD truth-sync + ntfy TASKISDONE.
