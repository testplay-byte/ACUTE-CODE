<!-- last-reviewed: 2026-09-17 round-102 -->
# Round 47 — Provider management, clean + reliable: one API layer · slot+model-scoped connection tests · the served model catalog (hand-copied duplicates deleted) · enabled enforced at turn time · raw-key route removed · launcher key scrub (the R44 leak) + the credentials-parser bug it exposed

**Date:** 2026-08-29 · **Branch:** `main` · **Owner directives:** *"focus on the
providers management and such so we have a smooth experience with them — a
clean interface and a reliable one"* + *"look into the main files and handle
them properly: the basic launching file, acute.bat, acute.sh, acute
launcher.py, the credentials.example.txt — make it look better, proper, and
well-maintained"* + *"It should not be for you to paste in the Open Router
API keys by default in it."* Plan: `agent-ctx/R47-plan.md` (sandbox) — the
recon found the credentials template shipping three REAL sub-agent keys
since R44, three parallel provider HTTP layers in the frontend, a
hand-copied 47-entry model catalog, an Enabled toggle that did nothing at
turn time, and a raw-key-reading route that contradicted the
keys-never-leave-the-keyring invariant.

**Commits (in order):** `862af5d` (launcher overhaul + key-material scrub —
the owner's loudest complaint) · `2f4d375` (backend provider reliability) ·
`0643ac9` (frontend consolidation + version 0.47.0). Tip = `0643ac9`.

## What shipped

### A. Launcher overhaul + key scrub — no key material ships with the launcher anymore (`862af5d`)

The owner's directive was explicit: the example credentials file "should not
be for you to paste in the Open Router API keys by default in it" — and yet
`launcher/credentials.example.txt` had shipped three REAL sub-agent keys
(KEY_2/3/4) since R44, and the same three keys were baked into
`acute_launcher.py`'s `DEFAULT_SUB_KEYS`. Both gone:

- **`credentials.example.txt` redesigned** as a clean ASCII template: a single
  obvious PASTE ZONE with exactly two REQUIRED lines (`GITHUB_PAT`,
  `OPENROUTER_KEY`) + three clearly-OPTIONAL sub-agent slots, every value a
  `PASTE_YOURS_HERE` placeholder, where-to-get notes per key, and the parser
  rules documented in the file itself. The provenance line states the
  owner-only rule explicitly.
- **`DEFAULT_SUB_KEYS` deleted** from `acute_launcher.py`;
  `ensure_subagent_keys()` reworked from "inject the baked-in defaults" to
  "keep placeholder LINES present" — it appends clearly-marked placeholder
  lines for missing `OPENROUTER_SUBn_KEY` entries and NEVER writes or
  rewrites values.
- **THE R44 PARSER BUG (found by simulation this round):** the credentials
  parser regex `^([A-Za-z_]+)` could not match names containing DIGITS —
  `OPENROUTER_SUB1/2/3_KEY` lines were silently never parsed, so the owner's
  own pool-key values in `credentials.txt` were ALWAYS ignored
  (`ACUTE.bat status` always showed slots unset) and the whole R44 sub-key
  flow only ever worked through the baked-in defaults. Deleting the defaults
  (this round) is what surfaced it. Regex is now
  `[A-Za-z_][A-Za-z0-9_]*`.
- `ACUTE.bat` / `acute.sh`: comment-structure polish only — every executable
  line byte-identical (chcp/order/fallback chain/winget offer untouched).
- `launcher/README.md` credentials section rewritten for the paste-zone flow
  + no-baked-keys policy.
- Verified: `py_compile` clean, `bash -n` clean, LF endings preserved, no
  `sk-or-v1` real keys remain under `launcher/`, and a **6-step live
  simulation** (parse placeholders → empty; a filled sub key parses — the
  bug-fix proof; no-op ensure with all lines present; a legacy file gets
  placeholders appended with owner values untouched; partial append adds
  only the missing line; quoted values + alias lines tolerated).

### B. Backend provider reliability (`2f4d375`)

- **`GET /providers/:id/key` REMOVED** — it returned the RAW key value,
  contradicting the route group's keys-never-in-responses invariant.
  Ripgrep-verified zero callers across `src/`, `src-tauri/`, `scripts/`,
  `onboarding/` (only the PUT at the same path survives, with a ROUND-47
  removal note). The route now 404s; the tests assert GET 404s while PUT
  survives and no key leaks.
- **`POST /providers/:id/test` extended** to `{model?, slot?}`: a slot (0–31,
  `400 VALIDATION` otherwise) selects the keyring POOL key to probe — an
  empty slot is an honest `409 "no API key stored for provider '<id>' slot
  <n> — save one in Settings → Models & Providers"`; slot omitted → primary
  key, behavior identical. `model` + `slot` combine: the one-token completion
  probe runs with the SLOT key. One deliberate reorder: body validation
  (400s) now runs before the keyless-409 — observable only for invalid bodies
  against keyless providers (was 409, now 400); no test or client relied on
  the old order.
- **`provider.enabled` is now HONORED at turn time:** `prepareTurn` returns
  `409 {code: "PROVIDER_DISABLED", message: "Provider '<name>' is disabled —
  enable it in Settings → Models & Providers"}` on the same clean path as
  the no-key 409 (disablement — the owner's explicit choice — wins over a
  missing key; no user event appended, session stays retryable; propagates
  to the sync route envelope, the SSE error frame, and orchestrator child
  turns). The Enabled toggle had been cosmetic since R37.
- **NEW `GET /models/catalog`**: serves `MODEL_CATALOG` (46 models, 18 free)
  + `defaultModelId` + `subagentDefaultModelId` + `recommendedModelIds` from
  the `storage/models.ts` constants — one source of truth for every model
  picker, behind the same bearer wall, no cache. This kills the drift class
  where the frontend maintained its own hand-copied copy (the exact gap
  lesson #65 flagged: routes had no drift guard, and the frontend duplicate
  could silently diverge for rounds).

### C. Frontend consolidation — one API layer, honest tests, served catalog everywhere (`0643ac9`)

- **`src/lib/api.ts` is now THE provider layer** (+~210 lines): the whole
  surface moved in — `fetchProviders` / `createProvider` / `updateProvider`
  / `deleteProvider` / `storeProviderKey` /
  `testProviderConnection(id, {model?, slot?})` (an `ok:false` result at
  HTTP 200 RESOLVES — only transport/agent-core failures throw `ApiError`,
  including the empty-slot 409) / `fetchModelsCatalog` / the models-config
  CRUD quartet — all typed against the real agent-core wire shapes.
  `ModelsProvidersTab`'s local `useApi()` — **the third parallel HTTP
  plumbing layer — DELETED**; every call rewired, behavior identical.
  `OrchestrationSettings` gained the missing `subagentModel: string | null`
  (backend field since R43).
- **KeyPoolSection slot-collision BUG FIX:** add-slot computed
  `slots.length + 2` and silently OVERWROTE an existing slot's key when the
  pool had gaps (slots 2 & 4 held → the next add hit 4 again). Now a pure
  `nextFreeSlot(held, 2, 31)` helper (`src/lib/key-pool.ts`) with an honest
  "the key pool is full (slots 2–31)" error; unit-tested including the
  collision case.
- **The connection test became a real instrument:** TWO selectors before the
  Test button — key ("Primary key" + held pool slots) and model
  ("(reachability only)" + the live catalog) — so a test can prove a
  specific key + specific model combination. Results are shown honestly:
  server-measured `latencyMs` + echoed model in green, `ok:false` messages
  in red, the backend's own reachability-only note surfaced verbatim.
  Browser-dev key inputs now carry the honest warning that keys live in
  server memory only until restart (`isTauri`-aware) — on the key input AND
  the pool section.
- **SubAgentsTab de-drifted:** the 47-entry hand-copied
  `SUBAGENT_MODEL_CATALOG` is GONE — the picker consumes
  `GET /models/catalog` (`["models-catalog"]` query), same visible UX
  (free-only default, tool-less rows disabled, one recommended badge — now
  data-driven from `subagentDefaultModelId`), honest loading +
  error-with-Retry states, ZERO hidden fallback copy.
- **AgentFormDialog de-hardcoded:** the provider dropdown now lists
  providers from the API (custom providers finally assignable; clean
  fallback to the built-in list with a dim notice on failure), model +
  visionModel inputs gained catalog-fed datalists (free-first, the exact
  modelId as the value, the vision list filtered to `supportsVision`), the
  dead `openrouter/ox-alpha` placeholder → the live `defaultModelId`, and
  the literal `"null"` vision placeholder → a real catalog example id.
- **Dead code deleted:** legacy `ApiTab` / `ProviderKeyCard` (~196 lines,
  unrouted since the R37 rebuild) removed from `SettingsPage`.

### D. Version 0.47.0 + CHANGELOG (`0643ac9`)

Version single-sourced at **0.47.0** across all four manifests
(`version:check` gates CI); the `CHANGELOG.md` `[0.47.0]` section is the
user-facing summary of everything above (one API layer, slot+model tests,
served catalog, enabled enforcement, key scrub + the two silent-failure
fixes: the launcher parser bug and the slot collision).

## Verification

- `pnpm lint` / `pnpm typecheck` clean (root + agent-core); `version:check`
  ok; all files LF.
- **Tests: 683 in 56 files** (`pnpm test`, run by the orchestrator at
  integration; the R46 record was 622 in 53). Split: **671 unit + 12 e2e**
  (8 sidecar + 4 terminal). The changed suites, before → after (each side
  run-verified): `api` 30→56 (every new fn: URL/method/body/auth + happy +
  error paths incl. the empty-slot 409 wording and ok:false-at-200) ·
  `providers` 32→44 (slot probes provably carry THAT key via fetch-mock
  Bearer capture with neither key leaking into any body; catalog shape +
  spot checks + 401; GET key → 404 while PUT survives) · `sessions` 35→36
  (disable → PROVIDER_DISABLED with zero events appended → re-enable → the
  same turn falls through to the normal no-key 409) · `SubAgentsTab` 9→11
  (catalog failure → verbatim error + Retry, zero rows — no silent
  fallback; fail-then-recover) · NEW `key-pool` 6 (gaps, full, empty,
  bounds, dupes/out-of-range) · NEW `ModelsProvidersTab` 8 (the collision
  regression through the real KeyPoolSection, full-pool guard, selector
  wiring + the `{slot, model}` POST body, reachability note, ok:false red
  render) · NEW `AgentFormDialog` 5 (live provider options, fallback,
  vanished-provider, datalists, placeholder). Per-suite deltas sum to +60;
  the +61 net against the R46 record includes the R46 baseline itself being
  one short (its own CI log shows 623 root-run entries vs the recorded 622
  — R46's delta list summed to 58 against its claimed +57 net). CI agrees
  with 683: run 33243501373's log shows exactly 683 root-run entries.
- **CI (GitHub Actions API, not hand-claimed):** run `33243501373` @
  `0643ac9` (the tip) **completed/success** (push event) — re-verified via
  the API by this round's docs agent before any dashboard claim.
- **Live battery on the dev sidecar (real keys, real disk):**
  `GET /models/catalog` serves 46 models / 18 free with the correct
  defaults · the slot-scoped test contract proven end-to-end — empty slot →
  409, invalid slot → 400, REAL key reachability ok in 139 ms, a REAL model
  probe honestly 429 (free-tier throttling reported as-is), a bogus key
  honestly 401 "User not found" · removed raw-key GET → 404 ·
  disabled-provider turn → 409 PROVIDER_DISABLED, re-enable → the SAME turn
  completed for real (473 in / 117 out tokens) · providers CRUD round-trip
  (add custom → edit → delete) · the launcher's 6-step credentials
  simulation all passed (Section A).
- **VLM/UI pass (desktop):** the providers tab renders clean with a REAL
  probe through the new key+model selectors ("Connected · 1207ms ·
  z-ai/glm-5.3-flash"); the Sub-agents tab counts "Free only (18) / All
  models (46)" matching the served catalog exactly; the agent form datalist
  offers all 46 options recommended-first; 375px mobile shows no horizontal
  overflow; the console is clean.

## Known limitations (honest)

- **The scrubbed keys remain in git HISTORY.** The repo is private and the
  keys were sub-agent pool keys, but the R44-era commits still contain
  KEY_2/3/4 values. **The owner should rotate those three keys at OpenRouter
  when convenient** — rotation is a two-minute operation and makes the
  history residue harmless.
- **The Tauri desktop shell's `store_provider_key` has no slot param** — a
  pool key pasted in the desktop app lands on the PRIMARY key.
  `src-tauri/` was out of scope this round (no cargo in the sandbox to
  verify a Rust change); a slot-aware shell command is the obvious
  next-round candidate.
- **Slot 1 is addressable but conventionally unused** (the launcher numbers
  sub keys from 2; the keyring uniformly covers slots 0–31). Kept as-is —
  harmless and consistent with the keyring's own semantics.
- **SubAgentsTab is still the temporary tab it always was** — the picker is
  de-drifted (it reads the served catalog now) but remains its own
  hand-rolled surface rather than a shared model-picker component; a future
  round should unify it with the connection-card model selector.
- **In browser-dev WITHOUT the sidecar, the sub-agent model picker now shows
  an honest error card** (previously it rendered the stale compiled-in
  catalog) — the intended honesty trade of deleting the fallback, recorded
  here because it is a visible behavior change in the offline case.
- Two `AgentsScreen.test.tsx` tests log happy-dom "Cross-Origin Request
  Blocked" stderr since the dialog's live queries fire against the
  unmocked baseUrl in that file — deterministic, network-free (blocked
  pre-I/O → the PROVIDER_IDS fallback engages), all 6 tests green; a
  one-line fetch stub would silence it.
- The bundled installer workstream (sidecar.rs production spawn) remains
  deferred by owner verdict (ADR-0003; CHANGELOG `[Unreleased]`).
