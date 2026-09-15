<!-- last-reviewed: 2026-09-15 round-99 -->
# Round 95 — the sixth-walkthrough round (v0.92.0 → v0.93.0)

<!-- round: 95 -->
<!-- version: 0.93.0 -->

The owner's sixth walkthrough, answered end to end: the Models & Providers
UI overhaul, the provider-test error surfacing, the native browser's local
files, the thinking-area scroll + reasoning levels + the thinking-loop
guard, the chat robustness pass, and the REAL-API live-fire verification
(OpenRouter, free Nemotron models — the owner's explicit testing directive).
Every item traces to the owner's own words in the report.

## §1 The Models & Providers tab (workstream A, commit d2035eb)

- **The provider rail is taller by default**: `h-fit` content-adaptive
  height → a fixed-tall panel (`h-full`, 280px min floor) that matches the
  detail pane — only the inner list scrolls when providers outgrow it.
- **Back-to-dashboard lives in ONE place**: the settings content-area pill
  is GONE from every tab; the left sidebar's settings-mode back is now a
  proper labeled button (icon + "Dashboard", bordered pill, hover fill);
  the minimized rail keeps its icon; the Project-not-found recovery link
  stays (an error state, not a page button).
- **Key 2..N match Key 1 exactly**: the pool rows render the same
  input-styled bordered field (accent border when revealed), the same
  bordered h-10 eye with per-row spinner, the same ANIMATED fade/slide-in
  labeled Copy shown only while revealed, and a matching bordered trash
  (hover-red). Key 1 remains the visual reference; "primary" stays Key-1-only.
- **Styled confirmations everywhere**: the new ConfirmDialog (blurred
  backdrop, ESC + outside-click, cancel-focused, danger styling) replaces
  EVERY `window.confirm` in the tab — key removal, model deletion, and
  provider deletion.
- **Add-then-configure**: the pencil "Configure and add" is GONE; the row's
  "+ Add" adds the model AND opens the config dialog on the created row
  (the upsert's returned row — no refetch dependency). Already-added models
  are FILTERED OUT of the picker entirely (honest "All matches are already
  added." note); the batch strip behaves as before.
- **Hidden models sort to the bottom — LIVE**: not-hidden rows first,
  hidden last (stable within groups), derived from the cached rows so the
  R94-C optimistic toggle re-sorts with zero refetch; each card rides a
  framer-motion `layout` spring so rows visibly glide; the scroll position
  survives (pure reorder).
- **The Test button**: one button labeled exactly "Test" → a single
  HORIZONTAL row of three options separated by 1px dividers —
  [ Test All | Test Only Failed | Test Only Working ] — with the honest
  disabled states + hints (failed/working counts) preserved. All five
  testids preserved.
- **Provider delete at the TOP**: the bottom Danger zone is retired; a
  quiet red-on-hover trash in the header card opens the ConfirmDialog
  with the owner's exact message ("Do you want to delete this provider
  and all the models added in it?"); the "N agent(s) use this provider"
  warning rides the dialog body; all invalidation + Tauri key cleanup
  preserved.
- **Model separation**: list gap 2.5→3 + the card boundary dialed up one
  notch — each model reads as its own card at a glance.

## §2 The provider-test error surfacing (workstream B, commit c4820ca)

The reachability branch of `testProviderConnection` (the "(reachability
only)" default probe) now appends `upstreamErrorDetail` — the provider's
RAW error body, scrubbed + 2000-char capped — to both the 401/403 and
generic non-ok messages. Testing a connection with no model picked now
shows the actual provider error, exactly like the model test always did.

## §3 Per-model reasoning metadata (workstream B, commit c4820ca)

Migration 0035 adds `reasoning_support` (JSON blob) to the models_config
table; the OpenRouter catalog merge captures each model's
`supported_parameters`-derived reasoning capability
(`{supported, efforts[]}` — verified against the LIVE catalog: 445
entries, 312 reasoning-capable, 169 with effort ladders; e.g.
nemotron-3-super → [low, medium], gpt-5.2 → [low, medium, high],
qwen3-max → supported:false). The wire payloads carry it
(models-config rows / models/catalog / models/configured), the routes
validate it strictly (400 on shape drift), and
`resolveModelReasoningSupport(db, providerId, modelId)` is the
runtime-facing resolution helper. NULL = unknown — never blocked on.

## §4 Model-aware thinking levels (workstream E, commit 51c9023)

- **The button adapts to the model**: unknown support → the classic four
  options + an honest "capabilities unknown" hint; `supported:false` →
  the button disables ("This model does not support reasoning"); a
  detected ladder → Default + the supported levels (a "medium" option
  joins the vocabulary — shared ThinkingLevel widened additively), with
  stored levels falling back to the nearest supported rung visually.
- **The wire mapping**: `buildThinkingFetch` is capability-aware —
  unknown → effort verbatim (R50 shape); `supported:false` → NO reasoning
  key (a 400 avoided); a ladder → the level mapped onto it (max rides the
  highest rung; unsupported falls to the nearest lower — never a 400).
- **THE LIVE-FIRE CORRECTION (§8)**: OpenRouter REJECTS
  `reasoning.effort` + `reasoning.max_tokens` TOGETHER ("Only one of
  reasoning.effort and reasoning.max_tokens can be specified"). The two
  knobs are now mutually exclusive: a ladder → effort only; ladder-less
  reasoning (e.g. nemotron-3.5-lightning) → the max_tokens budget only
  (2048/4096/8192/16384 by level — the runaway-thinking bound); unknown
  → the R50 shape. A provider-set max_tokens always wins.

## §5 The thinking-loop guard (workstream E, commit 51c9023)

`streamAiSdkChat` watches for the owner's exact complaint — "stuck in
thinking, way too long, never gets out": >120s with NO progress (no text,
tool call, or finish) AND >24KB of reasoning accumulated → a dedicated
`ThinkingLoopError` (classified `thinking_loop`, retryable) → ONE
immediate de-escalating retry (medium/high/max → low; low/default →
default) with a visible meta.retry card naming the downgrade; a second
occurrence fails honestly. The streamed path only (the sync sub-agent
path is documented future work).

## §6 The native browser opens local files (workstream C, commit 94052a7)

The owner's exact error — "Native browser unavailable. Only HTTP/HTTPS
URLs are supported by the embedded browser." — died at ONE root: the
Rust shell's `parse_http_url` refused every non-http(s) scheme. The fix
is end-to-end file:// acceptance:

- **Rust** (`parse_web_url`): http/https/file accepted (about:/data:/
  javascript:/tauri: still refused); `on_navigation` emits history for
  file navigations; the WebView2 renders local files natively — scripts,
  the agent-hands cursor, and eval all work on file pages.
- **The panel**: the address bar accepts local paths (Windows drive
  paths, POSIX absolutes, UNC) via `normalizeBrowserUrl` → `file:///`
  URLs; agent navigate frames carry file URLs; web-dev (proxy) mode
  routes local files through the sidecar.
- **The sidecar**: `browserNavigateCore` accepts file:// (validation
  updated); a ticket-gated `GET /browser/local-file` route serves local
  files from disk (extension-mapped content-types, 10 MiB cap,
  directory/binary refusals — all honest).
- **The agent tool**: navigate accepts file:// AND bare local paths
  (normalized agent-side); `read` on a file:// URL reads from disk;
  read_dom/source/eval ride the native bridge; the tool DESCRIPTION +
  the per-turn prompt + the seeded skill text all teach the local-file
  vocabulary.

## §7 The chat (workstreams D + F, commits da4d40a + e12f2eb)

- **The thinking area follows its own stream** (the owner: "The thinking
  area was not auto-scrolling to the very bottom… It should only scroll
  if I scroll to the very bottom and leave it there"): the new
  `useStickToBottom` hook powers the live thinking block — auto-follows
  while at its bottom, stops when the user scrolls up inside it, and an
  inner frosted "Jump to latest" pill (bottom-right in the block) re-pins.
- **The chat-level pill bug** (the owner: "The Jump to Latest button was
  showing even though I was at the very bottom"): the transcript's wheel
  listener no longer detaches the pin when the wheel's target sits inside
  a NESTED scroller (the thinking block, code blocks, any .auto-scroll)
  that hasn't reached its own top — the inner consumes the scroll; once
  it hits top, later wheels chain to the transcript naturally. The R94-D2
  machinery is otherwise byte-identical.
- **Chat formatting robustness**: three real bugs found + fixed with
  regression tests (53-test ChatMarkdown suite): peeled punctuation
  VANISHED from the DOM (an autolink's trailing period/quotes were
  dropped), GFM autolink trailing `*_~` sets weren't peeled (a dangling
  `**` glommed onto URLs), and quoted paths like `"src/app.ts",` lost
  their file pill since R40. Plus break-all on long inline tokens, the
  empty-markdown case, wide-table inner scroll, streaming-tolerant
  dangling fences — all pinned.
- **The entry-renderer registry**: a kind→renderer map with
  compile-time exhaustiveness, per-surface context, and honest
  placeholders — the modular adoption path for the owner's "display
  various other info in the future" (shipped standalone + tested this
  round; the WorkingSection wire-up is the follow-up).
- **The context donut**: audited against CONTEXT-METER.md — the MEASURED
  number (the provider's own prompt size) now renders prominently inline
  beside the ring (not hover-only), promoted in the popover, with the
  at+model mismatch warning visible; the estimate stays clearly
  ~-labeled.

## §8 The REAL-API live-fire (the owner's explicit directive)

`scripts/r95-live-fire.mjs` — the BUILT sidecar driven end-to-end through
a RECORDING PROXY against the REAL https://openrouter.ai, with the REAL
free Nemotron models the owner named:

| Check | Result |
|---|---|
| nemotron-3-super + thinkingLevel high → reasoning.effort "medium" (the model's [low, medium] ladder) | PASS |
| NO reasoning.max_tokens alongside the effort (the mutual-exclusion bug the harness CAUGHT live — fixed same round) | PASS |
| The system prompt carries the SKILLS section (names + one-line descriptions + read_skill) | PASS |
| The turn completes with real streamed assistant text | PASS |
| **Token usage truth**: app-recorded input/output EXACTLY match the provider's numbers (in=17075/out=45 — zero deviation; the owner's app-vs-API concern) | PASS |
| Ladder-less reasoning model (nemotron-3.5-lightning): the max_tokens budget rides with NO effort key | PASS |
| supported:false row: NO reasoning key on the wire | PASS |
| POST /browser/navigate accepts file:// (history entry recorded) | PASS |
| GET /browser/local-file serves a real local HTML file (ticket-gated, text/html) | PASS |
| The local-file route refuses without a ticket (401) | PASS |

Plus the R94 harness re-verified GREEN (its hardcoded repo root fixed to
derive from the script location), the full pipeline: lint clean, both
typechecks clean, root 3,258/3,258 (175 files), e2e 12/12, build green,
license audit 134 clean.

CI run 34774855473 + Release run 34774862744 both SUCCESS on 3f6bd20.
v0.93.0 PUBLISHED (release 387996130, latest): ACUTE-CODE_0.93.0_x64-setup.exe
37,616,713 B (sha256 32a75056…) + acute-launcher-kit-v0.93.0.zip 113,757 B
(sha256 db295496…) — both verified against GitHub's server-side digests via
fresh downloads; the kit scanned for real-key values (clean).

## §9 The owner's TEST CHECKLIST (v0.93.0)

1. **Models & Providers** — the left rail is tall (scrolls only when
   many); no back-pill at the top of any settings page (the sidebar's
   labeled Dashboard button instead); Key 2..N look exactly like Key 1
   (bordered eye, animated Copy on reveal); deleting a key/model/provider
   shows the styled confirmation popup (never the browser's).
2. **Add models** — the picker shows only NOT-yet-added models; the row's
   "+ Add" adds AND opens the config dialog; the batch strip still batches.
3. **The models list** — hidden models sit at the bottom; toggle one and
   watch it glide (scroll stays put); the Test button says "Test" and its
   three options sit in one divider-separated row.
4. **Provider delete** — the trash at the TOP of the header opens the
   confirmation ("Do you want to delete this provider and all the models
   added in it?").
5. **Test connection** — a FAILING provider test (no model picked) now
   shows the provider's actual error message.
6. **Thinking levels** — pick a reasoning model (e.g. Nemotron Super):
   the menu offers Default/Low/Medium (its ladder); a non-reasoning
   model disables the button honestly.
7. **The thinking area** — during a live turn, expand the thinking: it
   follows the stream at the bottom; scroll up inside it — it stops; the
   inner "Jump to latest" pill brings you back. The CHAT's jump pill no
   longer appears while you scroll inside the thinking block.
8. **The browser** — give the agent (or the address bar) a local HTML
   file path (C:\…\page.html or /home/…/page.html): it opens NATIVELY;
   the agent can read it; the address bar shows the file:// URL.
9. **Stuck-thinking models** — a model that loops in reasoning now
   recovers (the meta.retry card names the downgrade) instead of hanging.

## §10 Known/standing

- The Rust side was NOT compile-verified locally (no cargo in the
  sandbox — CI's Windows build is the gate; the diff is surgical).
- The seeded browser-use SKILL body updates only fresh databases (the
  seed is INSERT OR IGNORE; existing rows keep user edits) — the per-turn
  prompt + the tool description teach local files everywhere regardless.
- The entry-renderer registry ships standalone (the WorkingSection
  wire-up is the follow-up); a literal `|` inside inline code still
  splits table cells (GFM wants `\|` — surgical scope).
- The sync sub-agent path has no thinking-loop watchdog (streamed-only,
  documented); the pop-out's address bar passes file:// through but
  doesn't normalize bare paths.
- Reasoning budgets ride ladder-less reasoning models ONLY (OpenRouter's
  effort XOR max_tokens rule — §4).
