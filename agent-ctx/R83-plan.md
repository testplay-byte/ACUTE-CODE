# R83 — Honest Token & Context Metering

**Round:** 83 · **Version:** 0.81.0 → 0.82.0
**Owner's brief:** "the context, the token count, and this stuff — they are being highly misleading. They are not being handled properly. All of those things need to be looked into properly and handled much better, using robust systems."
**Spec:** `agent-ctx/research/token-counting-robustness.md` (Research Agent C, Task ID 6) — §3 recommended design, §4 file-by-file list.
**Baseline:** 1932a9e (R82), agent-core 90 files / 1,853 tests green.

## Scope decisions (from the spec, adjusted to post-R82 reality)

- Migration number: the spec's "0029" is taken (R81 0029_unified_modes, R82 0030_model_capabilities) → **0031_usage_calls_origin.sql**.
- `resolveTurnBudget` lives in `runtime.ts` (next to `getModelContextWindow` + `computeCost` — the db-injected resolution helpers already live there; context.ts stays pure/dependency-free).
- The guard message keeps the honest actionable text WITHOUT the phantom `/compact` — AND we ship the real `POST /sessions/:id/compact` route (spec §3.4 "option: ship the route" — the 800K guard already promised it; shipping it makes the affordance real).
- taskHints/modeHints stay OUT of the meter's PromptContext (per-turn ephemeral, depend on the NEXT user message which cannot be known — honest omission, documented in the route).
- Frontend keeps estimation as the ring's live filler with the MEASURED value as the labeled ground-truth line (spec §3.1).

## Work items

### A. Budget unification (runtime.ts)
1. `resolveTurnBudget(db, providerId, modelId): TurnBudget` — window (override→catalog→200K **with source label**), maxOutputTokens (models.max_output_tokens → catalog → 32_768 — honors the owner's editable column for the first time), margin 8_000, available.
2. Both turn budgets (sync ~1652, streamed ~2333) call it.
3. Guard: `usedTokens > budget.available` (model-relative, not 800K); `meta.context_limit` carries the real limit; message drops "run /compact".
4. recordUsage cached-null: `sawCachedReport` tracking in both paths; all ~8 usage rows write `cachedInputTokens: null` when NO call reported a cache tier (the shared type's documented NULL contract, finally honored).

### B. Usage truth (migration 0031 + sessions.ts + runtime.ts + compaction.ts + server.ts debug-analyst)
5. `0031_usage_calls_origin.sql`: `provider_calls INTEGER NOT NULL DEFAULT 1`, `origin TEXT NOT NULL DEFAULT 'turn'`.
6. `recordUsage(db, usage, keySlot, meta?)` — providerCalls + origin pass-through; `UsageOrigin = "turn" | "compaction" | "debug"`.
7. Sync path gains `totalRequests` (it never had one); both paths pass `providerCalls: totalRequests`.
8. Compaction summarizer: usage row (origin "compaction", agentId null) recorded in `assembleWithCompaction` after the chat call — real spend finally visible.
9. Debug analyst: usage row (origin "debug") after its chat/chatStream calls.
10. usage.ts aggregates: SUM(provider_calls), origin breakdown availability, per-model `costKnown` (lookupPricing both-sides-null → unpriced marker).

### C. Context route overhaul (server.ts GET /sessions/:id/context)
11. Full PromptContext: skills (resolveEffectiveSkills), taskModes + activeTaskMode (resolveEffectiveModes/findMode — read-only, no stale-clearing write), environment (buildPromptEnvironment), backgroundTasks, computerUse, maxOuterLoops.
12. Schema-measured systemTools: new `measureToolSchemaTokens(root, toolNames)` in tools/index.ts (in-process cache) replaces `350 × count`.
13. Compaction applied to the messages estimate (findLatestCompaction + applyCompaction) + `compaction` field in the report.
14. `actual` block: newest message.assistant stats-carrier (inputTokens/outputTokens/cachedInputTokens?/at/model) — the provider's own number, labeled with ts + model.
15. `contextWindowSource` + `maxOutputTokens` + `available` + `usedTokensBasis: "estimated"`; hitRate null-safe (no COALESCE for the rate — SUM NULL = not reported).
16. Stats carriers gain `cachedInputTokens` on the payload when the iteration reported one.

### D. POST /sessions/:id/compact
17. Force-compaction route: 404/409 honest gates (agent/provider/key), runs assembleWithCompaction with force, returns {compacted, throughSeq, droppedMessages, tokensSaved} — never a 500.

### E. Frontend (api.ts, ContextDonut, stream-store, ChatView, usage screens)
18. `SessionContextReport` additive fields.
19. ContextDonut: "measured at last request" primary line + "~projected" secondary, compaction badge, budget marker (compaction line), window-source badge, cache "— not reported", requests→"turns".
20. stream-store: invalidate ["session-context"] on outer done + meta.compaction; render meta.compaction/meta.context_limit as liveTurn notes.
21. ChatView chip: "per model call".
22. Usage screens: "turns · N provider calls" + "(unpriced)" cost marker.

### F. Tests
23. context-report.test.ts: extend (actual block, compaction-applied estimate, schema-measured tools, source labels, hitRate-null-when-unreported, usedTokensBasis).
24. usage.test.ts: provider_calls/origin/costKnown.
25. r80-silent-stops.test.ts: guard pins re-based (available-based limit, no "/compact" text).
26. context-compaction.test.ts: summarizer usage row + meter application.
27. NEW r83-budget.test.ts: resolveTurnBudget resolution order + source + available; guard threshold behavior.
28. NEW r83-compact-route.test.ts: route contract (200/404/409, force path).
29. storage.test.ts: migration 0031 idempotent-list entry.
30. Frontend: Composer.test.tsx (measured/projected labels + honest-error pin kept), api.test.ts, stream-store.test.ts.

### G. Docs + close-out
31. CHANGELOG 0.82.0, IMPLEMENTED-API (context route contract + compact route), docs/runbooks/CONTEXT-METER.md (new — estimate vs measured contract), status.json (round 83, milestone 43), HANDOFF header, ui-iterations/round-83.md, ORCHESTRATION-WORKLOG R83.
32. Version ×4 → 0.82.0; full verification (root suite, e2e, lint, typechecks, docs:check); commit + push.

## Gates
- agent-core `npx vitest run` green; root suite green; `npx tsc --noEmit` clean (root + agent-core); e2e 12/12; `bun run lint` clean; `node scripts/docs/check-stale.mjs` 0/0.
- Wire compat: every new field additive; old consumers keep working (the R51 usage-split precedent).
