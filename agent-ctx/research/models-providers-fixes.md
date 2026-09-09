# Models & Providers — Root-Cause Analysis + Implementation Spec

**Research agent:** B (Task ID 5, ACUTE-CODE analysis project)
**Repo state analyzed:** commit `6e9e3d7` (R80.5 docs-only on top of `6f512aa` / tag v0.79.0)
**Scope:** owner's three field reports — (P1) custom-provider models route to OpenRouter, (P2) NVIDIA NIM workflow "not proper", (P3a) per-model TEST button, (P3b) model-edit dialog redesign.
**Method:** full read of agent-core/src/providers/registry.ts, storage/{providers,models,agents,settings,db}.ts, agents/{chat,runtime,orchestrator,error-classification,debug-analyst}.ts, server.ts (route-by-route), computer/vision.ts, tools/plugins/{vision,computer-use}.ts, src-tauri/src/{keys,sidecar}.rs, src/components/settings/ModelsProvidersTab.tsx (full), composer/ModelSelector.tsx (full), composer/composer-utils.ts, lib/{api,settings-store,stream-store}.ts, AgentChatPanel.tsx (send path). All line numbers below were verified against the working tree.

---

## §1 Root cause: the custom-provider → OpenRouter misroute

### 1.1 The one-sentence cause

**The per-send model override carries a providerId in the UI but the wire protocol and the entire backend resolution chain use the AGENT's providerId only — so a custom model picked under any provider in the composer's model picker is sent, verbatim, to whatever provider the session's agent is bound to (default agent "Acute" = `openrouter`).**

### 1.2 The exact trace (every hop, with lines)

1. **Frontend stores `{model, providerId}`** — `src/components/project-chat/composer/composer-utils.ts:49-54`:
   ```ts
   export interface ModelOverride {
     model: string;       // e.g. "meta/llama-3.1-70b-instruct"
     providerId: string;  // e.g. "prv_my-gateway"  ← captured, then never used
   }
   ```
   Persisted per session in localStorage (`saveModelOverride`, composer-utils.ts:208-216; loaded at AgentChatPanel.tsx:1685-1686).
2. **The picker sets it** — `ModelSelector.tsx:268-272`:
   ```ts
   const pickModel = (model: string, providerId: string): void => {
     onModelChange(model === agent?.model ? null : { model, providerId });
   ```
   The flyout is provider-grouped (R64-d: config-only rows per provider), so the UI *visually promises* per-provider routing.
3. **The send drops providerId** — `AgentChatPanel.tsx:1704` `const effectiveModel = modelOverride?.model ?? agent?.model ?? null;` and `AgentChatPanel.tsx:2119-2128`:
   ```ts
   await useStreamStore.getState().startStream(sid, text, {
     model: effectiveModel ?? undefined,   // ← providerId silently discarded
     ...
   ```
4. **The API layer has no field for it** — `src/lib/api.ts:3115-3144` `streamSessionMessage` POST body: `{ content, model?, thinkingLevel?, attachments? }`. No `providerId`. (The sync `SendMessageOptions`, api.ts:374-377, doesn't even carry `model`.)
5. **The routes read a bare string** — `agent-core/src/server.ts:3816-3817` (sync route) and `:3877-3878` (streamed route):
   ```ts
   const modelOverride = typeof raw.model === "string" && raw.model.trim() !== "" ? raw.model : undefined;
   ```
   A `body.providerId` sent today would be silently ignored.
6. **prepareTurn resolves the provider from the AGENT only** — `agent-core/src/agents/runtime.ts:1049-1103`:
   - `:1049` gate `agent.providerId === null || agent.model === null`
   - `:1060` `const provider = resolveProvider(db, agent.providerId);`  ← **THE CULPRIT LINE**
   - `:1090` `const apiKey = keyring.get(provider.id);`
   - `:1414-1416` `PreparedTurn = { provider: {id, baseUrl, apiFormat}, apiKey, model: modelOverride?.trim() ?? agent.model }` — the override changes the **model string only**.
7. **The chat adapter then builds the client from that provider** — `agents/chat.ts:131-180` `buildModel()` uses `input.provider.baseUrl` + `input.provider.id`; the only provider-specific branch is the OpenRouter `:free` fallback (`chat.ts:165-177`, gated on `input.provider.id === "openrouter"`). There is **no** model→provider lookup, no prefix parsing, no fallback default here — the misroute is fully decided upstream in prepareTurn.
8. **The error surfaces with the wrong provider name** — `agents/error-classification.ts:343-357` `providerFailureMessage(providerId, …)` renders ``provider 'openrouter' call failed for session <sid> (class: unknown)`` plus `providerErrorDetail` (raw OpenRouter body: `"No endpoints found for model '<custom-model>'"`). This is *exactly* the owner's report: "unknown-model error… the error message says the provider was set to OpenRouter even though it was set to custom."
9. **Why OpenRouter specifically:** `storage/agents.ts:339-379` `ensureDefaultAgent` seeds the default agent "Acute" with `providerId: "openrouter"` (`:369`) and `model: DEFAULT_MODEL_ID`. Every fresh session binds that agent, so the agent-side provider is openrouter unless the owner hand-edited the agent.

### 1.3 The same defect in four more resolution sites (blast radius)

- **main-model vision relay** — `runtime.ts:1207-1210`: `mainModel: { providerId: agent.providerId, modelId: modelOverride ?? agent.model }`. `tools/plugins/computer-use.ts:649-664` `relayVision` → `findModelRow(db, mainModel.providerId, mainModel.modelId)` (`:668-678`) — a cross-provider override looks up the model row under the WRONG provider → "the turn's model does not support vision (or its row isn't marked supports_vision)". Same class in `tools/plugins/vision.ts:216-228` and `browser.ts`.
- **context meter + cost** — `runtime.ts:1609` / `:2290` `getModelContextWindow(db, provider.id, model)` and every `computeCost(db, provider.id, model, …)` call (`:1973, 2019, 2097, 2136, 2143…` via `lookupPricing`, `:3161-3176`): pricing/context rows are keyed `UNIQUE(provider_id, model_id)` (migration 0004) → cross-provider override silently reads NULL pricing/ctx.
- **context route** — `server.ts:2707-2711`: `?model=` query + `agent.providerId` → same mismatch (`fetchSessionContext`, api.ts:1924-1930; ContextDonut.tsx:362).
- **debug analyst** — `server.ts:3986-3987`: `model = modelOverride ?? agent.model` against the agent's provider triple (`:3998`) → a debug run after a custom-model turn calls OpenRouter with the custom id.
- **sub-agent children** — `orchestrator.ts:778` and `:1211` `const providerId = agent.providerId ?? "openrouter";` + `modelOverride: subagentModel ?? undefined` (`:787`). `subagentModel` is a bare string validated against the OpenRouter catalog (`storage/settings.ts:122-138`), so children can *only* ever run catalog ids on the parent agent's provider. (OpenRouter-catalog "nvidia/…" ids work here by coincidence — see §2.)

### 1.4 Secondary custom-provider defects found while tracing (verify with the owner, but all confirmed in code)

1. **Custom-provider keys die on app restart (packaged/Tauri app).** `src-tauri/src/keys.rs:49-57` `provider_key_env_targets()` is a **hardcoded 5-entry array** — `openrouter`, `nvidia`, `openrouter-slot{2,3,4}` — and `sidecar.rs:486-504` injects only those (+ vision keys via the `~/.acute/vision-providers.txt` note file, keys.rs:69-123). The Settings flow (ModelsProvidersTab.tsx:693-720 → `storeProviderKey` → keys.rs:252-286) writes a custom provider's key to Credential Manager `ACUTE-CODE/provider/<id>` and pushes it into the RUNNING sidecar via `POST /internal/providers/keys` (registry.ts:142-147) — but the next spawn never re-injects it. Result: works this session, then `409 "no API key for provider 'prv_…'"` forever after. (Browser-dev keys are documented ephemeral — ModelsProvidersTab.tsx:124-125 — but the packaged app's custom keys are NOT supposed to be ephemeral.)
2. **Free-only default hides custom/NIM models.** `src/lib/settings-store.ts:53` `modelsFreeOnly: true` default; `isFreeModelEntry` (`:22-31`) treats a NULL input price as **not free** → newly added custom models (no pricing prefill) are filtered out of the composer flyout (`ModelSelector.tsx:232` `filterModelsForPicker`) behind the "N paid models hidden — show all" footer (`:407-424`), and out of the Add-models picker's "Free only" scope (ModelsProvidersTab.tsx:2027-2039). "I added the model but it's not in the picker" is this, not a storage bug.
3. **Queued messages lose the override entirely.** `server.ts:4317-4320` `appendQueuedMessage(db, id, { content, attachments })` — the R78 queue carries no model/provider; a queued follow-up runs on the agent default even when the sender had a per-send override.

### 1.5 The minimal correct fix (recommended shape)

Thread the override's providerId end-to-end, keeping every existing guard:

1. **Wire:** both send routes accept `body.providerId?: string` (validate: non-empty slug, `providerExists` (server.ts:387-396 uses it for agents) else `400 VALIDATION`). Build `modelOverride: { model, providerId? }`.
2. **runtime.ts `prepareTurn`** (signature `modelOverride?: string | { model: string; providerId?: string }` — keep `string` accepted for the orchestrator/tests, normalize at entry):
   - `const effectiveProviderId = typeof modelOverride === "object" && modelOverride.providerId ? modelOverride.providerId : agent.providerId;`
   - `resolveProvider(db, effectiveProviderId)` then run the **existing** 409/`PROVIDER_DISABLED`/no-key/baseUrl guards unchanged (`runtime.ts:1060-1103`).
   - `model = overrideModel ?? agent.model`; `mainModel = { providerId: effectiveProviderId, modelId: model }` (`:1207-1210`).
   - Because `provider` in `PreparedTurn` is now the effective provider, **`getModelContextWindow`, `computeCost`, the ChatTurnInput, the vision relay and the retry ladder are fixed automatically** — they all read `provider.id`.
3. **server.ts debug phase** (`:3986-4002`): resolve the provider triple from `modelOverride.providerId ?? agent.providerId`.
4. **server.ts context route** (`:2699-2811`): accept `?providerId=` alongside `?model=` (default agent's).
5. **Frontend:** `streamSessionMessage` options + body gain `providerId?: string` (api.ts:3119-3142); AgentChatPanel passes `modelOverride?.providerId`; ContextDonut's query passes it too. `SendMessageOptions` gains `model`/`providerId` for parity.
6. **Do NOT** change orchestrator child routing in the same edit (subagentModel is catalog-scoped by design; see §2.4 for the follow-up).
7. **Queue route:** add `model`/`providerId` to `appendQueuedMessage` payloads + the loop-top delivery (server.ts:4317-4326 and the stream-loop's queued-chip handling ~4100-4126). Can be a follow-up patch; flag in the round plan.

**Blast radius:** prepareTurn is the shared pre-flight for sync + streamed + delegated turns; the signature change is additive (callers passing `undefined` or a string compile unchanged). ~8 backend call sites, ~5 frontend files, plus the provider-key injection fix in Rust (§1.4.1: extend `provider_key_env_targets` to also read a note file of stored custom provider ids — mirror the vision pattern `keys.rs:69-123`, written by `store_provider_key`).

---

## §2 NVIDIA — current state and every gap found

### 2.1 What R80 shipped (verified)

- Seeded built-in row: `storage/providers.ts:48-55` — id `nvidia`, `https://integrate.api.nvidia.com/v1`, chat-completions, reserved id (`:14-20`).
- Key injection: `keys.rs:49-57` (`ACUTE_PROVIDER_NVIDIA` ← Credential Manager `ACUTE-CODE/provider/nvidia`); dev path `scripts/dev.mjs:112-165` (env or `~/.acute/nvidia.key`).
- Keyring reads it: `ProviderKeyring.envVarName("nvidia") === "ACUTE_PROVIDER_NVIDIA"` (registry.ts:46-48).
- `nvapi-…` scrub: `chat.ts:342-346`, `src/lib/error-bus.ts:84`.
- Settings preset: `ModelsProvidersTab.tsx:210-221` + `PRESET_PROVIDER_IDS` (`:232-238`).
- Chat path works with no special-casing: `chat.ts:147-179` `createOpenAICompatible({name:"nvidia", baseURL, apiKey, includeUsage:true})`.
- Tests: `agent-core/tests/r80-raw-errors-nvidia.test.ts:123-153` (seed, reserved, keyring), `providers.test.ts:82-97, 137-140, 187, 208`.
- Known R80 residual (HANDOFF.md:31): the account's NIM model functions are EOL'd server-side — 410 raw bodies; nothing code-side can do.

### 2.2 Gap list (each with the code reason)

1. **NIM models can't be sub-agent models.** `storage/settings.ts:128-137` rejects any `subagentModel` not in the OpenRouter `MODEL_CATALOG` (`isKnownCatalogModelId`, models.ts:924-926) and requires `supportsTools`. NIM ids (`meta/llama-3.1-…`, `nvidia/llama-…`) are not in the catalog → the Sub-agents settings picker (`SubAgentsTab.tsx:31-34, 314-330, 403-425`, fed by `GET /models/catalog`, server.ts:1504-1512) can never select them. Sub-agents are thereby OpenRouter-only.
2. **No capability metadata ever lands on NIM rows.** The live catalog parse (`registry.ts:205-218` `parseModels`) reads only `{id, name}`; the `supportsVision` INSERT prefill consults `getCatalogModel(input.modelId)` (models.ts:169-173) — the **OpenRouter** catalog — so NIM ids always default `supports_vision=0`, `supports_thinking=0`. The main-mode vision relay then refuses (computer-use.ts:654-658) and thinking-level rows are mislabeled. (Needs §4's capability toggles + optional NIM `/models` metadata pass.)
3. **Free-only default hides every NIM model** (§1.4.2): NIM ids don't end `:free` and have no price → invisible in the Add-models "Free only" scope and the composer flyout until "All models"/"show all" is toggled. For a provider whose catalog contains *zero* free-classified entries, the picker's honest hint is "No free models match — switch to All models" (ModelsProvidersTab.tsx:2303-2305) — functional but reads as broken.
4. **No pricing/context prefill**: the Add-models picker prefills only from the static OpenRouter catalog (`staticById`, ModelsProvidersTab.tsx:2019-2022, 2058-2076) → NIM rows land with all pricing/ctx NULL → "pricing not set" italic (list row, `:1914-1916`) and NULL context window feeding the estimator.
5. **The id spaces collide by name.** The OpenRouter catalog carries OpenRouter-hosted NVIDIA models whose ids also start `nvidia/` (models.ts:328-338 `nvidia/nemotron-3.5-lightning:free` — also `SUBAGENT_DEFAULT_MODEL_ID`, `:269`; `:445-468` three more). The composer's openrouter flyout and the nvidia provider flyout both show "nvidia/…" rows that mean DIFFERENT endpoints. Combined with the §1 misroute this is the most confusing surface the owner hits; the per-model TEST button (§3) is the disambiguator.
6. **Connection test is provider-level with a dropdown of the live catalog** (ModelsProvidersTab.tsx:1220-1294): the model must be picked from `catalogIds` (the fetched `/models` list) — a configured row whose id is NOT in the live list (EOL'd/renamed) can't be probed at all. No per-row button. The probe itself (`registry.ts:287-349`) hardcodes `POST {base}/chat/completions` + `max_tokens: 1` — fine for NIM, wrong for anthropic-messages providers (the UI admits it: ModelsProvidersTab.tsx:1289-1293).
7. **Anthropic/responses format test coverage** — same point, general (not NVIDIA-specific) but blocks "test every configured model" for those providers.

### 2.3 What is NOT broken (checked, so the fix doesn't churn it)

- Key auth in the model-resolution path: `prepareTurn:1090` `keyring.get(provider.id)` reads `ACUTE_PROVIDER_NVIDIA` correctly (r80 test pins it).
- `buildModel` for nvidia is correct as-is (openai-compatible, includeUsage true).
- Catalog fetch for NIM works (`GET /providers/nvidia/models` → 81 ids, parseModels shape matches NIM's `{data:[{id,…}]}`).
- Error surfacing: 410/EOL bodies ride `providerErrorDetail` verbatim (R80 caps) — already honest.

### 2.4 NVIDIA fix list (ordered)

1. §1 fix (override providerId) — makes a NIM model picked in the composer actually reach `integrate.api.nvidia.com`.
2. §1.4.1 (spawn injection for custom providers) — pattern already proven for nvidia.
3. §3 per-model TEST button — turns "EOL'd NIM function" into a visible per-row verdict with the raw body.
4. §4 capability toggles + prefill improvements — mark NIM rows vision/tool/reasoning by hand once, persisted per row.
5. `subagentModel` → `{providerId, modelId}` (settings JSON), validated against the provider's configured rows (with a `supportsTools`-style gate where known); SubAgentsTab picker lists per-provider configured models. Backfill: existing string values are OpenRouter ids → map to `{providerId: "openrouter"}`. (Design decision for the owner — see §8-style approval list.)
6. Add-models picker scope default: when a provider's catalog yields zero free-classified entries, auto-switch that picker's scope to "All models" for that provider (or per-provider scope state) so NIM/other-vendor catalogs aren't hidden behind a toggle.

---

## §3 Model-test feature design (per-model TEST button)

### 3.1 Endpoint

**`POST /api/v1/models/:id/test`** (row id `mdl_<uuid>` — the same id PATCH/DELETE `/models/:id` use; registered in the same authenticated scope as the other model routes, server.ts after `:1491`).

Request body: `{ "slot"?: number }` (key-pool slot, mirroring `POST /providers/:id/test`'s R47-b contract; default primary).

Response (HTTP 200 both ways — a probe that RAN and got a NO is a successful test call, same semantics as registry.ts:173-181):

```jsonc
// ok:true
{
  "ok": true,
  "latencyMs": 812,
  "providerId": "nvidia",
  "model": "meta/llama-3.1-70b-instruct",
  "checks": { "http": true, "auth": true, "modelAccepted": true, "nonEmptyContent": true },
  "contentPreview": "pong",            // first 200 chars, scrubbed
  "usage": { "inputTokens": 9, "outputTokens": 1 }   // when the provider reports usage
}
// ok:false (probe ran, provider said no)
{ "ok": false, "reason": "model rejected by provider (HTTP 404): {\"error\":{\"message\":\"...\"}} — check the model id", "checks": { "http": true, "auth": true, "modelAccepted": false } }
```
Transport/agent-core failures → `502 PROVIDER_ERROR` envelope (`ProviderFetchError`, scrubbed); missing key → `409 CONFLICT` naming provider (and slot when scoped) — reuse the route-level guards from `/providers/:id/test` (server.ts:1296-1384) verbatim.

### 3.2 What the probe does (the "is the response reasonable" contract)

New `testModelResponse(keyring, provider, modelId, modelRow, keyOverride?)` in `providers/registry.ts` beside `testProviderConnection` (registry.ts:287-381) so it inherits the scrub/caps/timeout discipline:

1. Resolve provider record + key (route has already 404/409'd the missing cases).
2. **Branch on `provider.apiFormat`** (the piece the old probe lacks):
   - `chat-completions` (OpenRouter/NVIDIA/most custom): `POST {base}/chat/completions` with
     `{ model, messages: [{ role: "user", content: "Reply with exactly one word: pong" }], max_tokens: 64, temperature: 0, stream: false }`.
   - `anthropic-messages`: `POST {base}/messages` with `x-api-key` + `anthropic-version: 2023-06-01` headers and `{ model, max_tokens: 64, messages: [...] }` — **reuse the exact request/parse pattern already live in `computer/vision.ts:128-200` `describeRaster`** (it handles both formats for the vision relay).
   - `responses`: `POST {base}/responses` `{ model, input: "Reply with exactly one word: pong", max_output_tokens: 64 }`; if unimplemented, return an honest `ok:false, reason: "responses-format probe not implemented yet"` (same posture as the R37 adapter note) — flagged as a decision.
3. **Checks, in order:**
   - `http` — response.ok (or the anthropic 4xx parse).
   - `auth` — 401/403 → `key rejected by provider (HTTP <s>)` (mirrors registry.ts:340-342).
   - `modelAccepted` — 400/404/410/422 → `provider rejected the request (HTTP <s>)<detail> — check the model id`; a 200 body that *contains* an `error` object (some OpenAI-compatible gateways do this) also fails here.
   - `nonEmptyContent` — parse the content (`choices[0].message.content` / anthropic `content[].text` / responses `output_text`), trim; empty/whitespace → `ok:false, reason: "model returned an empty response"`.
   - **Sanity, deliberately shallow:** report `contentPreview` (≤200 chars, scrubbed) and do NOT grade the text semantically — a one-word "pong"-style prompt makes "non-empty + on-task" visually verifiable by the owner in the UI. (Attempting LLM-judged "reasonableness" would add cost, latency, and a second failure mode; recommend against — decision point.)
4. **Timeout:** 30 s (reasoning models are slow to first token; the provider-level probe's 15 s `TEST_TIMEOUT_MS`, registry.ts:21, stays as-is). `AbortSignal.timeout(30_000)`.
5. **Key scrubbing:** reuse `scrub()` (registry.ts:195-198) with the resolved key, PLUS the prefix regexes (`sk-…`, `nvapi-…`, `github_pat_…`) already in `chat.ts:342-346` — hoist that regex block into a shared `scrubSecretShapes(text)` helper (chat.ts + registry.ts + error-bus.ts each hold a copy today; consolidating is a 3-file, low-risk touch). `max_tokens: 64` also caps the spend (~fractions of a cent on paid models; free on free-tier).

### 3.3 Frontend

- **api.ts:** `testModelConnection(modelRowId: string, opts?: { slot?: number }): Promise<ModelTestResult>` + `ModelTestResult` type (mirror `ProviderTestResult`, api.ts:2593-2614).
- **Placement:** `ModelListSection`'s configured rows (ModelsProvidersTab.tsx:1920-1951) gain a Zap button between Pencil and Trash; the `ModelConfigDialog` footer (`:2704-2721`) gains a secondary "Test model" too. Extract a small `ModelTestButton({ model })` component (own local state) so a running test doesn't re-render the whole list.
- **States:** `idle` (Zap icon, tooltip "Send a real test request to this model") → `testing` (spinner, row disabled) → `pass` (green `✓ <latency>ms` + expandable preview line, mono, `break-all`, auto-collapses to one line + "show reply" toggle) → `fail` (red reason line, full raw text via the R77-style expand toggle already used by TurnErrorCard). No-key case: button click surfaces the 409 message + a hint line "Save a key for '<provider>' first" (the key field is on the same page).
- **Invalidation:** none needed (read-only probe); keep `retry: false` on the mutation, one test at a time per row, no auto-retest.
- Optional stretch: "Test all" in the Models card header (sequential, abortable) — defer to a later round; per-row is the owner's ask.

---

## §4 Model edit UI redesign

### 4.1 What exists today (ModelConfigDialog, ModelsProvidersTab.tsx:2364-2725)

Fields: `displayName`, `contextWindow`, `maxOutputTokens`, `inputPricePerMtok`, `outputPricePerMtok`, `inputPriceCachedPerMtok` (all string-draft → `"" = null`), toggles `supportsThinking`, `supportsVision`, `hidden`. Sections: Sizing / Pricing — USD per 1M tokens / Behavior (3 On-Off segmented toggles). Wire: `PATCH /models/:id` (server.ts:1448-1489, strict field gate `:483-533`). Storage: `models` table (migration 0004) — `supports_thinking`, `supports_vision` INTEGER flags; the rest nullable numerics.

**Missing vs the owner's ask:** no tool-use / audio / video / reasoning-capability toggles; reasoning is named "thinking" with no hint tying it to the composer's thinking-level feature; no way to see WHERE each flag is consumed; the dialog is a flat stack of inputs (the owner's "poorly designed" verdict).

### 4.2 Proposed schema (migration `0029_model_capabilities.sql`)

```sql
-- 0029: per-model capability flags (owner: proper capability toggles in the edit dialog).
-- reasoning == the existing supports_thinking column (renamed in API-speak only).
ALTER TABLE models ADD COLUMN supports_tools  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE models ADD COLUMN supports_audio  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE models ADD COLUMN supports_video  INTEGER NOT NULL DEFAULT 0;
```
Backfill (code-side, one idempotent function called from `openDatabase` after `seedBuiltinProviders`, db.ts:151-166): for rows whose `model_id` is in `MODEL_CATALOG`, set `supports_tools` from `getCatalogModel(id).supportsTools` **only where the row currently has 0 AND the user has never touched it** — simplest honest rule: only backfill rows whose `updated_at == created_at` (untouched since insert). Catalog ids not in the table keep 0 (unknown). Document the trade-off (a user-untouched row that was wrongly 0 gets corrected; a deliberately-off row that was edited stays off).

**Stored vs computed:**
- **Stored** (models table, per provider): all capabilities, sizing, pricing, `hidden`, `sortOrder` (never edited in UI today).
- **Computed/prefilled on INSERT only** (upsertModel, models.ts:169-173): `supportsVision` ← OpenRouter catalog today; extend to `supportsTools` after 0029. NIM/custom ids: never prefilled (no source) — the dialog's "unknown" state must be visible, not silently false.
- **Not stored anywhere (display-only)**: FREE/PAID badge (derived: `isFreeModelEntry`), pricing summary, ctx badge.

### 4.3 Dialog redesign (same file, ~700-line component region)

- **Layout:** two-column at ≥560px (left: Identity + Capabilities; right: Sizing + Pricing), single column below; sticky footer (Cancel / Test model / Save). Sections keep the existing SectionLabel rhythm.
- **Capabilities card** — 5 rows, each a tri-state segmented control **On / Off / Unknown** (Unknown = `null` → column stays 0 but the API needs a third state; simpler alternative: keep On/Off + a muted "unknown — set after testing" hint chip on rows never edited — **decision point, recommend tri-state since 0004 semantics make 0 mean both false-and-unknown today**):
  - `supportsTools` — "Tool use — the model can call the app's tools (required for agentic turns)".
  - `supportsThinking` — "Reasoning — emits thinking tokens; enables the composer's thinking-level control" (rename from "Supports thinking", wire the hint to ThinkingLevelButton).
  - `supportsVision` — "Vision — image inputs; gates the main-mode vision relay" (existing hint kept).
  - `supportsAudio` — "Audio input".
  - `supportsVideo` — "Video input".
  - One-line "consumed by" micro-hint under each (the R62-2b pattern the vision toggle already uses, `:2671-2678`).
- **Identity card:** display name + read-only mono modelId + provider chip.
- **Sizing + Pricing cards:** current fields, unchanged contracts (`"" = null`, decimals, per-1M labels — R62-2b).
- **Visibility:** `hidden` toggle stays (moved to Identity as "Hide from chat picker").
- **Footer:** `Test model` (§3.3) next to Save — the natural pairing the owner is asking for.

**API changes:** `ProviderModelConfig`, `ProviderModelConfigInput`, `ProviderModelConfigPatch` (api.ts:2620-2699) + the server field gates (`MODEL_NUMERIC_FIELDS` stays; `readModelScalarFields`, server.ts:516-533, adds the three booleans) + `upsertModel` (models.ts:101-180) prefill/keep logic for the new flags. All additive; old clients unaffected.

---

## §5 File-by-file change list (sizes = estimated LOC touched, risk H/M/L)

| # | File | Change | LOC | Risk |
|---|------|--------|-----|------|
| 1 | `agent-core/src/agents/runtime.ts` | prepareTurn: override type + effective provider resolution + mainModel; normalizeModelOverride helper | ~60 | **H** (shared turn core; every turn flows through it) |
| 2 | `agent-core/src/server.ts` | both send routes read `providerId`; debug phase + context route provider resolution; new `POST /models/:id/test` route + guards | ~140 | **H** (5,086-line god file; route additions follow the existing scope/guard patterns) |
| 3 | `agent-core/src/providers/registry.ts` | `testModelResponse()` + shared scrub helper hoist | ~150 | M (pure probe, mirrors testProviderConnection) |
| 4 | `agent-core/src/agents/chat.ts` | export the secret-shape regex as a shared helper (behavior-neutral) | ~10 | L |
| 5 | `agent-core/src/storage/models.ts` | `supportsTools/Audio/Video` in ModelRecord/ModelInput/ModelRow/upsertModel + catalog prefill + backfill fn | ~80 | M |
| 6 | `agent-core/src/storage/migrations/0029_model_capabilities.sql` | 3 ALTERs | ~10 | L |
| 7 | `agent-core/src/storage/db.ts` | call the backfill after seeding | ~5 | L |
| 8 | `agent-core/src/storage/settings.ts` | (only if subagentModel → {providerId, modelId}) validation + JSON storage | ~40 | M |
| 9 | `src-tauri/src/keys.rs` + `sidecar.rs` | custom-provider id note file (vision pattern) + injection loop reads it | ~60 | M (Rust; mirror keys.rs:69-123; cargo check gate) |
| 10 | `src/lib/api.ts` | `providerId` in stream/send options; `testModelConnection`; capability fields in the 3 model types | ~70 | M |
| 11 | `src/components/project-chat/AgentChatPanel.tsx` | pass `providerId` on send + context donut query | ~15 | L |
| 12 | `src/components/project-chat/composer/ContextDonut.tsx` | providerId into fetchSessionContext | ~8 | L |
| 13 | `src/components/settings/ModelsProvidersTab.tsx` | `ModelTestButton` + row wiring; ModelConfigDialog redesign (capabilities card, tri-states, footer test); Add-models scope default when no free entries | ~350 | M (3,006-line file; dialog region is self-contained) |
| 14 | `src/components/settings/SubAgentsTab.tsx` | (only with §2.4.5) per-provider sub-agent model picker | ~120 | M |
| 15 | Queue route (server.ts) — model/provider on queued chips | follow-up | ~40 | M |

Suggested sequencing for the implementing round: **Fix 1 (§1.5 items 1-5) → tests green → Fix 9 (Rust keys) → §3 endpoint+UI → §4 dialog+migration → §2.4.5/§2.4.6 last (each independently shippable).**

---

## §6 Test impact inventory

**Backend (agent-core/tests/)** — files that pin behavior this spec changes:
- `providers.test.ts` — POST /providers/:id/test contract pins (409s, slot scoping, ok:false@200, scrub); **extend** with POST /models/:id/test cases (happy, empty content, 401, 404, wrong format, no key, slot, scrub); catalog route pins unaffected.
- `server.test.ts` — send-route bodies; agent validation (providerExists at :387-396); **extend**: `body.providerId` unknown → 400; override provider honored end-to-end (stub chat records `input.provider.id`); debug-analyst + context route provider.
- `storage.test.ts` — upsertModel/PATCH null-clear contract (R50-d) + **new capability columns round-trip + backfill idempotence**.
- `models-catalog.test.ts` — catalog pins; add `supportsTools` backfill spot-checks (e.g. `getCatalogModel("nvidia/nemotron-3.5-content-safety:free")?.supportsTools === false` already pinned at :100 — keep).
- `r43-subagent-provider.test.ts` — subagentModel validation pins (:115-127, :218-225); **only if §2.4.5 lands** rewrite to {providerId, modelId} semantics + backfill test.
- `r43-turn-error.test.ts`, `r75-retry-ladder.test.ts`, `r78-error-classification.test.ts`, `r80-silent-stops.test.ts`, `r58-stop-and-replay.test.ts`, `r44-status-reset.test.ts`, `composer-attachments.test.ts`, `chat-format.test.ts`, `sessions.test.ts`, `r75-mode-policy.test.ts`, `orchestrator.test.ts`, `r79-delegation.test.ts` — all construct turns via `runSingleAgentTurn`/`runStreamedAgentTurn`/prepareTurn: **compile-level** signature acceptance (`string` must keep working) + one new test each asserting an object override with providerId switches `chat.input.provider.id` (spyChat pattern already exists in r43-subagent-provider.test.ts:73-84).
- `r80-raw-errors-nvidia.test.ts` — untouched (scrub + seed pins stay valid).
- **New:** `migration-0029.test.ts` (pattern of migration-0024/25/26 tests) + the model-test suite can live in providers.test.ts or a new `r81-model-test.test.ts`.
- `r45-security.test.ts` — add a no-key-leak pin for the new endpoint's error paths (scrub with nvapi-/sk- shapes).

**Frontend (src/)**:
- `components/settings/ModelsProvidersTab.test.tsx` — extend: per-row test button states (idle/testing/pass/fail + reason render), dialog capability toggles PATCH the new fields, tri-state behavior, Add-models scope default.
- `components/project-chat/composer/Composer.test.tsx` — context fetch now carries providerId (:1681 pin updates).
- `components/project-chat/AgentChatPanel.test.tsx` — send body includes `providerId` when an override is active.
- `lib/api.test.ts` — streamSessionMessage body shape pin (new field), `testModelConnection` happy/409/502 mapping, `fetchSessionContext` `?providerId=`.
- `lib/stream-store.test.ts` — opts threading (model → model+providerId).
- `components/onboarding/SetupWizard.test.tsx` — unaffected (wizard uses provider+model explicitly).

---

## §7 Risks + edge cases

1. **prepareTurn semantics drift (H):** switching the provider per-send changes which key/enabled/baseUrl guards fire. Keep the exact 409 bodies (`PROVIDER_DISABLED`, no-key naming `ACUTE_PROVIDER_<ID>`) — sessions tests pin them (sessions.test.ts:36 PROVIDER_DISABLED case). An override to a *disabled* provider must 409 before any event is appended (same clean-state contract, runtime.ts:1072-1089).
2. **Key absence on custom providers after restart** — §1.4.1: until the Rust fix ships, a per-send override to a custom provider that lost its key fails with the honest 409; the fix removes the restart cliff. The note-file approach inherits the vision pattern's known limits (a hand-edited note file with junk lines is skipped, keys.rs:100-102).
3. **OpenAI-compatible quirks on the test probe:** 200-with-`error`-body gateways (checked in §3.2 step 3); non-JSON bodies (`upstreamErrorDetail` already tolerates); SSE-only endpoints (we force `stream:false`; a provider that can't — NIM/Anthropic can — would fail `http`; acceptable, surfaced honestly).
4. **anthropic-messages probe:** header set differs (`x-api-key`, version header) — copy computer/vision.ts's proven branch verbatim rather than re-deriving; `responses` format probe flagged unimplemented-first (honest note in the UI, same as the existing connection-test caveat, ModelsProvidersTab.tsx:1289-1293).
5. **Catalog refresh / re-add overwrite:** upsert semantics overwrite PRESENT fields (models.ts:117-143) — the Add-models bulk add passes catalog meta always (ModelsProvidersTab.tsx:2060-2076), so re-adding an existing row would clobber user-edited pricing. Mitigated today by disabled already-added rows (`:2245-2247`); keep that invariant when touching the picker (and consider `skipIfConfigured` in the mutation as belt-and-suspenders).
6. **Cross-provider model-id collisions:** same `model_id` under two providers is legal (`UNIQUE(provider_id, model_id)`); with the fix, routing is keyed on providerId so both coexist. The vision relay's `findModelRow(db, providerId, modelId)` becomes correct only if `mainModel.providerId` uses the effective provider — covered by fix item 2.
7. **`max_tokens: 1` legacy probe vs new probe spend:** the new probe costs ~64 output tokens per click; on paid models that's real money if spammed — cap at one in-flight test per row (UI) and document; no server-side rate limit needed for a single-user desktop app.
8. **Free-only filter UX:** any change to defaults (§2.4.6) touches the shared persisted `modelsFreeOnly` pref — scope it per-provider in the Add-models dialog only, do not silently flip the global pref the composer also reads.
9. **localStorage override shape:** already `{model, providerId}` (composer-utils.ts:198-201 rejects malformed), so no client migration is needed; old sessions pick up correct routing immediately after the backend fix.
10. **Tri-state capability storage:** 0004's INTEGER 0 conflates "false" and "unknown". If tri-state is approved, prefer a nullable `supports_*` (new columns NULLable, 0/1 for set values) in 0029 instead of NOT NULL DEFAULT 0 — one more ALTER, but honest semantics; the NOT NULL variant forces "unknown" to render as Off (the current lie the owner is complaining about).
11. **God-file discipline (MODULE-BOUNDARIES.md):** server.ts route additions and ModelsProvidersTab edits should follow the R80.5 modularity contract (register routes in the existing scope block; extract `ModelTestButton`/capability card as local components rather than inlining more JSX into the 3,006-line file).
12. **NIM 410 EOL bodies:** nothing code-side; the test button surfaces them verbatim — set owner expectations in the round notes so "NVIDIA not proper" isn't re-filed as a bug when the raw 410 is the answer.

---

## §8 Uncertainties (explicit)

- Whether the owner's "custom model routes to OpenRouter" report came **only** via the composer override (traced here) or also via an agent-level binding — the agent-level path (prepareTurn with `agent.providerId = prv_…`) is correct in code *except* the restart key loss (§1.4.1), which produces a different error (409 no key, not unknown-model). The unknown-model + "provider was set to OpenRouter" wording matches the override path precisely; both fixes are specified.
- NIM `/models` field richness (whether any capability/pricing metadata is exposed beyond `{id, name}`) — not verifiable offline; the design assumes none (manual toggles), which is safe either way.
- The exact NIM validation behavior for `max_tokens: 1` (legacy probe) — R80 live-verified the endpoint + key auth, so the shape is proven; only the 64-token variant is new.
- Whether `subagentModel` provider-awareness (§2.4.5) is in the owner's intended scope for "NVIDIA workflow" — flagged as a decision, not silently included.
