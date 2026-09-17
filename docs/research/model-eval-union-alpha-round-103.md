<!-- last-reviewed: 2026-09-17 round-103 -->
# Model evaluation — `stealth/union-alpha` on OpenRouter (round 103)

The owner's directive: "I would prefer for you to check out this new model,
which we can work with, and see how it is and how things look with it and
such. It is a new model which we should look into and we should test with.
It is slow but it does work and it is a fully functioning one so maybe we
should handle it properly… it has two thinking modes on and off."

This is the full record of the evaluation: **23 live API calls** across 8
test families, evidence preserved under `/tmp/union-alpha-tests/` (each call
with its request body, response body, headers, and curl metadata; the
run's own index and tables in `00-SUMMARY.md`). The four replacement
OpenRouter keys (the owner rotated them this round — the old set was
deleted) were verified valid before testing and rotated across the matrix.

## 0. The model's OpenRouter facts (verified live)

| Field | Value |
| --- | --- |
| id | `stealth/union-alpha` (display name "Union Alpha"; upstream provider string "Stealth") |
| context | 262,144 tokens |
| pricing | prompt 0 / completion 0 — **free** |
| modality | text+image → text |
| supported_parameters | `max_tokens`, `response_format`, `temperature`, `tool_choice`, `tools`, `top_p` — **no `reasoning`** |

## 1. THE headline question — do the "two thinking modes" exist at the API level?

**No.** Seven probes, three mechanisms, one consistent answer:

| Probe | Result | Evidence |
| --- | --- | --- |
| `"reasoning": {"enabled": true}` | HTTP 200, **silently ignored** | `message.reasoning` = `null`, `usage.completion_tokens_details.reasoning_tokens` = 0, token counts byte-identical to the no-param baseline |
| `"reasoning": {"effort": "high"}` | HTTP 200, silently ignored | same — and on the logic puzzle the output was *shorter and faster* than default |
| `"reasoning": {"effort": "low"}` | HTTP 200, silently ignored | same |
| `"reasoning": true` (legacy bool) | **HTTP 400** | `{"error":{"message":"reasoning: Invalid input: expected object, received boolean","code":400}}` — this is OpenRouter's own zod schema validation (64 ms response), not model behavior |
| `include_reasoning: true` | HTTP 200, ignored | identical to baseline |
| `stealth/union-alpha:thinking` (variant id) | **HTTP 404** | "No endpoints found for stealth/union-alpha:thinking." — no thinking variant exists |
| control: fully unknown param | HTTP 200, ignored | proves OpenRouter silently DROPS unknown params for this model — so "200 + no reasoning output" means "dropped," not "honored quietly" |

Across all 23 calls: `message.reasoning` is present in every response but
always `null`; `reasoning_tokens` always 0; no streaming chunk ever carried
a reasoning field; no hidden thinking traces ever appear unprompted. Direct
prompt-engineering probes (a "think step by step" instruction; an
inline-reasoning instruction) DO modulate verbosity — but that is ordinary
prompting, not a mode. **Conclusion: any app-level thinking on/off toggle
for this model would have to be client-side prompt injection, and wiring
OpenRouter `reasoning` params to it is actively harmful — the boolean form
400s, the object forms do nothing.** (For ACUTE: the app's reasoning-model
handling should treat union-alpha as a non-reasoning model.)

## 2. Tool calling — the strongest capability (✅)

- **Non-streaming** (1.46 s): `finish_reason: "tool_calls"`,
  `message.tool_calls[0]` = `{type:"function", id:"d6d2f7f6-…",
  function:{name:"get_weather", arguments:"{\"location\": \"Tokyo\"}"}}` —
  valid JSON arguments, proper call id.
- **Streaming** (1.61 s): textbook OpenAI-style deltas — first chunk
  carries the id + function name + empty arguments, then incremental
  argument fragments (`{"location": "Tok` → `yo"}`), then
  `finish_reason: "tool_calls"`, then `[DONE]`.

This matters most for ACUTE: the agent loop (tool call → result → next
turn) would function correctly with this model.

## 3. Vision (✅)

A 73-byte 4×4 solid-red PNG as a `data:image/png;base64` `image_url` part
→ HTTP 200 in 1.58 s with: "The image is a solid, uniform red rectangle
with no discernible objects, details, or variations in color." — a correct
description. Minor quirk: `image_tokens: 0` in usage (token accounting is
unreliable across the board — see §6).

## 4. Streaming (✅ functional, ⚠️ degraded UX)

SSE parses cleanly; role+content deltas arrive; the final chunk carries
`usage`; `data: [DONE]` terminates; ~11 `: OPENROUTER PROCESSING`
heartbeat comments cover the initial wait. **Caveat:** content arrives in
**sentence-sized chunks** (a two-sentence answer = two content events),
not token-by-token — a live-typing UI will visibly "jump." TTFB ≈ 10 s on
medium prompts.

| Streaming test | TTFB | total |
| --- | --- | --- |
| medium prompt | 10.03 s | 15.04 s |
| medium prompt + `{"effort":"high"}` | 9.84 s | 9.85 s |
| tool call (streaming) | 1.61 s | 1.61 s |

## 5. Structured output (✅ genuinely enforced)

`response_format: {"type": "json_object"}` held against an adversarial
instruction ("respond in plain prose, do not use JSON") — the response was
still strict, parseable JSON. For an agentic app that needs reliable JSON,
this is the second-strongest capability after tool calling.

## 6. Latency and reliability — the blocking concern

23 calls: **min 1.4 s, median ~10 s, max 40.1 s — on comparable trivial
prompts.** The same "17*23, answer with just the number" one-liner took
2.55 s, 9.07 s, 11.41 s, and 40.07 s on four different runs. Tool and
vision calls were occasionally fast (1.4–1.6 s). Variance, not slowness,
is the disqualifier for an interactive agent: a five-step tool chain at
these percentiles stretches from seconds to minutes run-to-run.

Other reliability notes: non-streaming bodies begin with 1–15
whitespace-only lines before the JSON (harmless to real JSON parsers, a
trap for byte-strict consumers); token accounting is unreliable (the same
prompt scored 14/25/30 prompt_tokens; one response's "391" answer was
billed as 20 completion tokens) — usage/budget features cannot trust it;
no `x-ratelimit*` or `retry-after` headers on any response (no observable
rate-limit signaling); zero 429s across 23 sequential calls on KEY_1.

## 7. The four replacement keys (all ✅)

`/api/v1/auth/key`: all four valid, free tier, zero usage at round start.
Direct model calls: KEY_1 (21 calls), KEY_2 (11.9 s round trip), KEY_3
(5.5 s), KEY_4 (9.7 s) — all 200/"KEY-OK". The keys are entered in-app by
the owner (BYO-key provider) — nothing to commit, per the no-secrets rule.

## 8. Output quality spot-checks

The sheep puzzle ("A farmer has 17 sheep. All but 9 run away. How many are
left?") → **"9"** in all four configurations (default, effort-high,
think-step-by-step, inline-reasoning-instructed) with clean, well-formatted
explanations ("The phrase 'all but 9 run away' means that 9 sheep remained
behind, while the rest (17 − 9 = 8) ran away."). Exact-instruction
compliance ("reply with exactly ACUTE-PING"), arithmetic (17×23=391), a
coherent short story, and the correct image description. Basic competence
is not the problem — the delivery is.

## 9. Verdict for ACUTE-CODE

| Need (the agent loop's) | Verdict |
| --- | --- |
| Tool calling | ✅ excellent (both transports, valid args, proper ids) |
| Reliable JSON | ✅ enforced even adversarially |
| Streaming | ⚠️ functional but coarse (≈10 s TTFB, sentence-jumps) |
| Predictable latency | ❌ 1.4–40 s variance on identical prompts |

**Not a primary-model candidate.** The owner's "it is slow but it does
work" is precisely confirmed — fully functioning, genuinely free, and too
irregular for interactive multi-step agent loops where variance compounds.
Reasonable role: **a free experimental / vision-capable fallback** where a
10–40 s turn is tolerable. It works in ACUTE today through the BYO-key
OpenRouter provider with the custom model id `stealth/union-alpha` — no
catalog change was made this round; if the owner wants it surfaced as a
named catalog entry with a "slow/free" chip, that is a small follow-up.
The thinking-modes claim should inform UI copy if it is ever added:
honest wording is "no separate thinking channel" (§1).
