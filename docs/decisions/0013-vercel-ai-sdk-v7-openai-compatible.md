<!-- last-reviewed: 2026-08-25 round-36 -->
# ADR-0013: [ASSUMPTION] LLM access — Vercel AI SDK v7 via @ai-sdk/openai-compatible

- **Status:** ACCEPTED (implementation-detail decision under the smaller-scope rule; surfaced per protocol)
- **Date:** 2026-08-22
- **Tags:** [ASSUMPTION]

## Context

The stack table fixes "Vercel AI SDK" as the provider layer but pins neither a major version nor the concrete adapter package. Phase 2 had to make both calls to ship the live single-agent round trip. Two forces tipped it now:

- **AI SDK v7 dropped `maxSteps`.** Multi-step loops now terminate through `stopWhen` combinators. Our agent field `max_turns` maps to `stopWhen: stepCountIs(Math.max(1, input.maxTurns))` (`agent-core/src/agents/chat.ts`), which also future-proofs the tool loop: when tools arrive in a later wave, the same combinator bounds it — no API migration mid-project.
- **Dev keys are OpenAI-compatible only.** The owner's dev key is OpenRouter (single allowed model `stealth/ox-alpha`), so the production path is an OpenAI-compatible base URL, which `@ai-sdk/openai-compatible` serves via `createOpenAICompatible`. The live round trip against OpenRouter is verified (model reply + usage row recorded, 2026-08-22).

Licensing was checked before adopting: `ai@7.0.73` and `@ai-sdk/openai-compatible@3.0.34` (plus the transitive `@ai-sdk/*` packages) are all **Apache-2.0** per `docs/compliance/dependency-licenses.md` — inside the allowlist.

## Options considered

- **A. AI SDK v7 (`ai`) + `@ai-sdk/openai-compatible`** — current stable; one adapter covers OpenRouter and any custom OpenAI-compatible endpoint with zero extra code; unified streaming/tool-call types we will need in Phases 3–4. Con: major-version churn (v7 itself broke `maxSteps`).
- **B. Pin the last `maxSteps`-era major** — familiar API, but adopts a dead line and forces the same migration later under time pressure.
- **C. Raw `fetch` against the OpenAI-compatible REST shape** — no new dependency and full control, but re-implements streaming, tool-call parsing, and usage extraction the SDK already owns; the native provider adapters (SPEC §F4) would each need hand-rolling.

## Decision

**LLM access goes through Vercel AI SDK v7 (`ai@^7`) with `@ai-sdk/openai-compatible` as the production adapter.** `agent-core/src/agents/chat.ts` (`aiSdkChat`) remains the single module that knows SDK types; everything downstream depends only on the `ChatFn` seam, so tests stub it and the SDK never leaks.

## Consequences

- `max_turns` → `stopWhen: stepCountIs(n)` is the canonical loop-bound mapping; documented here so the Phase 4 tool loop reuses it instead of inventing a second mechanism.
- **Native adapters (Anthropic, OpenAI, Google) remain fixture-tested until their own keys exist.** OpenRouter exercises the live OpenAI-compatible path today; adding a native adapter later is a registry change (ARCHITECTURE §9), not a rewrite.
- SDK major upgrades are breaking by nature (v7 already removed `maxSteps` once). The `ChatFn` seam keeps the blast radius to one file; upgrade only with a reason, via ADR if non-trivial.
- Reversal cost is low: swapping the body of `aiSdkChat` (e.g., to raw fetch) touches one module and its tests.
