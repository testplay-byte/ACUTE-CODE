<!-- last-reviewed: 2026-09-17 round-102 -->
<!-- the R82 history still tells the truth -->
# Round 82 — Models & Providers Hardening (the owner's field report round 2)

**Provenance:** the owner's verbatim field report (the R82 research session,
the models-providers-fixes spec's basis):

> custom models "route through openrouter" and fail with unknown-model
> errors; NVIDIA "not handled properly"; "when i test a model nothing
> happens" (no per-model test affordance); the model edit dialog "behaves
> badly… there should be proper options for it like vision, audio, video".

The spec is `agent-ctx/research/models-providers-fixes.md` (root causes with
exact line references, the 15-file change list, ~20 test files inventoried).
The implementation landed across the R82 workstreams (registry/server/
runtime/orchestrator/storage + the ModelsProvidersTab/SubAgentsTab frontend
+ keys.rs), and this file records the UI-facing half of it.

**Everything is unit-tested (root suite 2,809: agent-core 1,853 in 90 files
— four new r82 suites; frontend 944; e2e 12/12), lint + typechecks clean,
license audit 134 CLEAN, live-battery-verified 8/8 on the real keys
(`scripts/battery-r82.mjs`), and version 0.81.0.**

---

## 1. The headline fix — custom models ROUTE to their provider

The root cause was a wire-protocol omission, not a registry bug: the
composer's picker is provider-grouped and carries `{model, providerId}`
internally — but the send wire dropped the providerId, and `prepareTurn`
resolved the provider exclusively from the agent row (openrouter). A
custom-gateway model id was sent verbatim to OpenRouter → "No endpoints
found for…".

- `body.providerId` now rides `POST /sessions/:id/messages` + `/stream`
  (+ the queued-message carry, the vision relay, the context meter's
  `?providerId=`, the debug analyst, and the orchestrator's children).
- Unknown ids → an honest early `400` (the same providerExists validation
  agent edits use); absent → the agent's provider (pre-R82 behavior).
- **The sub-agent twin:** `orchestration.subagentModel` became the
  provider-scoped `{providerId, modelId}` ref — NIM/custom rows can be
  sub-agent models; `runChildTurn`/`retryChild` provision the child's key
  pool + keyring VIEW from the EFFECTIVE provider (the R82-TESTS-found
  409-before-any-chat-call defect, fixed in the close-out).
- **The Rust twin (R82-B):** custom-provider keys survive app restarts —
  `keys.rs` notes non-builtin provider ids in `~/.acute/custom-providers.txt`
  at key-save time and re-injects `ACUTE_PROVIDER_<ID>` at every sidecar
  spawn. `cargo check` green.

## 2. The per-model Test button

`POST /models/:id/test` — a REAL minimal completion probe (max_tokens 16,
30s timeout, apiFormat-branched), never a models-list lookup:

- checks: `http` / `auth` / `modelAccepted` / `nonEmptyContent`
- `latencyMs`, a scrubbed `contentPreview` (≤200 chars — the owner's
  eyeball-judge, deliberately NOT LLM-graded), provider-reported `usage`
- HTTP 200 either way — a probe that RAN and got a NO is a successful
  test call; `reason` carries the provider's own text, double-scrubbed
  (exact key + `sk-`/`nvapi-`/`github_pat_` shapes via the shared
  `lib/secret-shapes.ts`)
- In the UI: a Test button on every configured model row + INSIDE the edit
  dialog (latency + checks + preview, or the honest red reason line).

## 3. The edit dialog's capabilities card

- **Reasoning** / **Vision** — On/Off toggles (the 0004-era boolean columns,
  wire-compatible), each with a "consumed by" micro-hint.
- **Tool use** / **Audio input** / **Video** — On/Off/**?** tri-states
  (migration 0030's nullable columns; `?` = unknown). A NIM/custom row
  starts UNKNOWN — never the 0004-era silent "off" lie.
- The INSERT path's two-way ternary folded explicit `null`→false; fixed in
  the close-out (`null` records UNKNOWN — pinned by r82-capabilities).
- Context window / max output / pricing fields carry the per-1M unit labels
  (the R62-2b prose) + a live pricing summary.

## 4. NVIDIA workflow polish

- The Add-models picker's **Free only ↔ All models** toggle is now
  dialog-LOCAL: initialized from the shared pref, never written to it
  (flipping the catalog picker no longer surprises the composer's picker),
  and it AUTO-SWITCHES to All when the catalog has zero free-classified
  entries — every NIM catalog (none of the 81 ids end `:free`) previously
  opened on the "No free models match" empty state, which read as broken.
- `GET /models/configured` feeds the sub-agent card's "Your configured
  models" section: per-provider rows (deduped against the OpenRouter
  catalog), each pickable as the provider-scoped sub-agent ref — with an
  honest 400 when a row is known tool-less (sub-agents are mandated tool
  users; UNKNOWN rows stay pickable).
- The sub-agent card's running-override chip shows `providerId · modelId`
  (the routing target is visible, not implied).

## 5. Verification

- **Unit:** four new suites (`r82-provider-routing` 13, `r82-model-test` 17,
  `r82-capabilities` 11, `r82-subagent-model` 10) + the r43/r45/r78/storage
  updates; 6 stale frontend tests re-pinned to the R82 wire contracts; the
  SubAgentModelCard Rules-of-Hooks crash fixed.
- **Live battery (8/8, `scripts/battery-r82.mjs`):** a custom provider
  created live, a model added, a streamed turn with `{model, providerId}`
  — the request lands on the provider's OWN endpoint with its OWN key (a
  local mock gateway oracle), ONE provider call, reply delivered; the real
  OpenRouter probe (honest ok:false with the provider's real 404 text,
  scrubbed); the real NIM probe (the R80 EOL verdict surfaces verbatim,
  nvapi- scrubbed); a hostile gateway echoing the key back (scrubbed to
  `bad key *** rejected`); the subagentModel round-trip + honest 400;
  `GET /models/configured` across providers; the tri-state INSERT wire.
- **Typechecks + lint** clean; **license audit** 134 CLEAN; **docs:check**
  green after this round's doc updates.
