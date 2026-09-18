<!-- last-reviewed: 2026-09-18 round-105 -->
# Round 105 — the Linux browser panel made whole + the composer's whole-section focus + the planning corpus (CLI · Android · oh-my-pi adoption) + the free-model benchmarks

The fifteenth-walkthrough round. The owner ran v0.101.0 in the field and
confirmed the R104 update system WORKS on both platforms ("Now it is in
the updated version properly") and the R102 Linux API-key store WORKS
("the API keys get properly saved exactly like how they were meant to
be") — the two standing field risks retired. The report then filed this
round's four directives:

- **The Linux in-app browser** (the round's headline defect): "In the
  Linux version the browser was not handled properly. It was showing
  that the whole application was split into two parts: the top part
  showed me the application itself and the bottom part showed me the
  preview of the web page. This is something which needs to be looked
  into properly."
- **The chat composer's focus state**: "If I clicked on the message,
  then around where the message was supposed to be entered, a border
  appeared. Clearly what should have happened is that the bottom
  section, which is for the input of the text and to configure the
  settings and such, should have been properly managed… the whole
  section should be highlighted when it is in selection."
- **The oh-my-pi study**: "take the best parts from this GitHub
  repository, learn from them… with proper care, proper understanding,
  and proper planning."
- **The platform program**: model benchmarks (OpenRouter free models +
  NVIDIA Nemotron — best test model, fastest, most reliable, most
  capable), a CLI for the agent, and the Android companion app (clean
  minimalistic animation-filled UI, explicitly NOT Material 3; thorough
  documentation of the linking/communication; APK builds on GitHub
  Actions, never in the sandbox) — with the standing meta-directive:
  "multiple rounds of planning with your subagents before implementing…
  quality over speed over time."

## §0 The owner's report, itemized (the round's contract)

1. **The Linux browser split** → §1 A + §2 A: root-caused at EVERY layer
   of the stack (tauri-runtime-wry's Linux `add_child` routing, wry's
   `add_to_container` GtkBox packing, wry's `set_bounds` no-op for
   box-packed webviews — all verified against the actual 0.55.1 source,
   not guessed) and fixed with a source-verified GTK surgery
   (`gtk_child_webviews.rs`).
2. **The composer focus border** → §1 B + §2 B: root-caused as a CASCADE
   LAYERS bug (the unlayered global `:focus-visible` rule could never be
   beaten by Tailwind's layered `outline-none` utility — the comment that
   claimed "overrides by class specificity" was wrong twice over: the
   `:focus-visible` pseudo-class also contributes specificity, and
   layers outrank specificity entirely). Fixed in the layer structure,
   plus the owner's refined directive implemented: the whole composer
   section highlights as ONE cohesive unit.
3. **The oh-my-pi study** → §2 C: the full research report (12 ranked
   adoption candidates, MIT-licensed, no conflicts) + the adoption
   roadmap (R105/R106/LATER/SKIP verdicts, grounded in agent-core's real
   files).
4. **The model benchmarks** → §2 D: 8 free OpenRouter models + 2
   NVIDIA-hosted nemotrons, tool-call + streaming-speed + reliability
   tested with the 4 provided keys.
5. **The CLI + Android planning rounds** → §2 C: two complete planning
   documents (the `acute` CLI design — attach-or-spawn, command surface,
   SSE→terminal rendering, M1/M2/M3; the Android Round 1 architecture —
   stack decision, pairing/auth/linking design, feature tiers, APK CI
   outline, and the explicit OPEN QUESTIONS list for Round 2).

## §1 The diagnosis — both defects, root-caused before any fix

### A — the Linux browser split: three verified layers, one shape

The owner's description — "the whole application was split into two
parts: the top part showed me the application itself and the bottom part
showed me the preview of the web page" — is a LITERAL description of
GTK's vertical box layout, and that is exactly what the stack does on
Linux:

1. **tauri-runtime-wry 2.11.4** routes `WebviewKind::WindowChild` (what
   `Window::add_child` creates) on Linux to
   `window.default_vbox().unwrap()` + `webview_builder.build_gtk(vbox)`
   — with the comment "only way to account for menu bar height, and also
   works for multiwebviews :)".
2. **wry 0.55.1**'s `add_to_container` sees a `"GtkBox"` container and
   `pack_start(webview, true, true, 0)`s every child webview INTO tao's
   VERTICAL `GtkBox` — the main app webview and every browser tab webview
   STACK VERTICALLY, each expanding to its half of the window. The split
   is the vbox doing precisely what a vbox does.
3. **wry's `set_bounds`** only honors geometry for webviews built into a
   `GtkFixed` (`is_in_fixed_parent`, captured at BUILD time): for
   box-packed webviews every `set_position`/`set_size` — every bounds
   sync the BrowserPanel has ever sent — was a SILENT NO-OP. The panel's
   geometry logic was never broken; it was never arriving.

The wry documentation itself prescribes the fix's shape: "The webview
bounds… is only effective… on Linux, if was created by
`WebViewExtUnix::new_gtk` or `WebViewBuilderExtUnix::new_gtk` with
`gtk::Fixed`" — with a documented example of building webviews into a
`gtk::Fixed`. We cannot change how tauri packs `add_child` webviews (the
routing is unconditional), so the fix RE-PARENTS them after creation —
into a `gtk::Fixed` of our own, floating OVER the app.

### B — the composer focus border: the specificity story was a layers story

The R102-E fix ("focus paints NOTHING") removed the
`.composer-shell:focus-within` border leg and left a comment claiming the
global rule could be beaten "by class specificity." Two facts make that
claim wrong:

1. **Cascade layers outrank specificity.** The global
   `:where(button, a, input, textarea, select, [tabindex]):focus-visible`
   rule sat UNLAYERED in index.css; Tailwind v4's utilities live in
   `@layer utilities`. An unlayered rule beats EVERY layered rule
   regardless of specificity — so the textarea's `outline-none` utility
   never had a chance.
2. **Text-entry elements ALWAYS match `:focus-visible` when focused —
   including by mouse click** (the spec's carve-out for text inputs: the
   caret alone is not deemed sufficient indication). And a click on a
   NON-FOCUSABLE element (a chat message) never moves focus — the
   textarea kept its focus (autoFocus/previous click), kept matching
   `:focus-visible`, and kept painting the 2px accent ring with its 2px
   offset while the owner read the transcript. That ring — around ONLY
   the text-entry area, not the toolbar beneath it — is the "border
   appeared around where the message was supposed to be entered."

The live-browser verification (dev server + computed styles) confirmed
it before the fix: the textarea's computed outline was
`solid 2px rgb(255, 107, 44)` — the accent — while `outline-none` sat
right there in its class list, beaten by a rule it was documented to
beat.

## §2 The workstreams

### A — the GTK surgery: `src-tauri/src/gtk_child_webviews.rs` (R105-A)

A one-time, idempotent, STATELESS widget-tree surgery per window that
hosts browser tabs (the main window + the pop-out), dispatched through
`Webview::with_webview` (whose closure runs on the event-loop thread —
which on Linux IS the GTK main thread, the only thread allowed to touch
the widget tree):

```text
tao's default GtkBox (vbox)                ← untouched, still the window's child
└── gtk::Overlay (pack_start expand/fill)  ← NEW — gets the full client area
    ├── the window's chrome webview        ← the Overlay's BASE child — still
    │                                        gets the full allocation; the app
    │                                        renders pixel-identically
    └── gtk::Fixed (halign/valign Fill,    ← NEW — the TAB LAYER: full-size,
        pass-through input)                  above the app, click-transparent
        ├── tab webview 1                    outside the tab webviews' own
        └── tab webview 2 …                  windows
```

Every property of that tree was verified against the GTK 3.24.43 source
before a line was written:

- `gtk_overlay_get_child_position` with `GTK_ALIGN_FILL` takes the
  `MAX(alloc, main_alloc)` branch — the Fixed gets the Overlay's full
  client area (tab bounds anywhere in the window are reachable).
- `gtk_fixed_size_allocate` re-allocates each VISIBLE child at its
  recorded `move_()` position with its REQUISITION — so
  `fixed.move_(x, y)` + `widget.set_size_request(w, h)` is DURABLE across
  window resizes (the exact pair wry itself uses for fixed children),
  and a direct `size_allocate` gives the IMMEDIATE effect for live
  repositioning.
- Overlay children get their own INPUT window
  (`gtk_overlay_create_child_window`) — `pass-through`
  (`gdk_window_set_pass_through`, "does not affect main child") makes it
  transparent to pointer events, so the app UI underneath stays fully
  clickable; the tab webviews' own (higher-stacked) gdk windows keep
  receiving theirs.
- `gtk_overlay_forall` visits the base child AND every overlay child, so
  the structural `find_browser_fixed` walk (`children()` DFS for the one
  Fixed-whose-parent-is-an-Overlay) reaches the Fixed from any ancestor.

The integration (all `#[cfg(target_os = "linux")]`, Windows untouched):

- `browser_tab_create` calls `ensure_fixed_overlay(&host_window)` BEFORE
  `add_child` (the idempotent surgery — a no-op on the second tab), then
  `adopt_tab_webview(&webview)` right after the `hide()` — the tab moves
  from the vbox into the Fixed WHILE HIDDEN (a hidden widget takes no
  vbox space and paints nothing — the split never becomes visible for
  even one frame).
- `browser_tab_set_bounds` and the R91-B2 show-re-assert ride
  `position_tab` (the GTK geometry path) instead of Tauri's
  no-op `set_position`/`set_size`.
- **Self-healing**: `position_tab` adopts any webview still sitting in
  the vbox AT the commanded bounds — the geometry command IS the recovery
  path. A destroyed pop-out takes its overlay with it (no registry, no
  bookkeeping — the widget tree IS the state); the next tab in a fresh
  window re-runs the idempotent surgery.
- `Cargo.toml` gains `gtk = "0.18"` target-gated to Linux — the SAME
  crate instance wry/tauri-runtime-wry already resolve (same semver,
  feature-unified).

The first push failed CI with 6 honest errors (§5) — four E0433s (the
missing `use crate::gtk_child_webviews;` in browser.rs) and two E0515s
(the `and_then(|p| p.downcast_ref::<Fixed>())` borrow-of-own-parameter);
the hotfix (83b98c9) landed both classes and the re-run went GREEN on
rust-linux AND rust-linux-arm64, with the full verify job.

### B — the composer's whole-section focus highlight (R105-B)

Two changes, one in each layer of the focus story:

1. **The layer fix** (index.css): the global
   `:where(...):focus-visible` rule moved INTO `@layer base` — below
   Tailwind's utilities — which is what actually makes the documented
   scoping work: element-level focus presentation (`outline-none`,
   `focus:*` utilities, custom painting) now overrides the global rule.
   The textarea paints NOTHING (its `outline-none` finally wins); the
   caret is the input's own focus indicator (the WCAG text-entry
   exception).
2. **The whole-section highlight** (the owner's refined directive): the
   composer-shell IS the whole bottom section — the textarea + the
   attachment chips + the toolbar row with the settings pills (mode,
   context donut, model, thinking, actions) all live inside it — so the
   focus state lands on the SHELL as one cohesive unit:
   `.composer-shell:focus-within` paints the accent edge at 50%
   (`color-mix`) plus a 3px `accent-soft` halo ring (9%/11% by mode —
   the Slack/Discord composer idiom: the whole box LIFTS as one selected
   surface). Both legs ride the shell's
   `transition-[border-color,background-color,box-shadow] duration-200`
   — the highlight fades in and out smoothly; no border "pops" (the
   R102-E verdict on hard swaps). Clicking a message KEEPS the highlight
   (focus stays within the shell — exactly "the whole section is in
   selection"); clicking a sidebar button moves focus OUT of the shell
   and the highlight fades.

Verified live in the browser (dev server): the textarea's computed
outline flipped from `solid 2px rgb(255,107,44)` to `none 2px`; the
shell renders `color(srgb 1 0.42 0.17 / 0.5)` border + the
`accent@0.11 0px 0px 0px 3px` halo; clicking an article keeps the
whole-shell highlight with the textarea still focused; a VLM read of
the screenshot confirms "the entire composer section has a visible
highlighted border as one unit… no stray or separate border around only
the text input part… clean and cohesive."

`Composer.test.tsx` re-pinned from the R102-E contract to the R105-B
contract (the R102-E verdict is documented INSIDE the test as the
misdiagnosis it was — the ring the owner saw was the textarea's, not
the container's).

### C — the planning corpus (the subagent planning rounds)

Per the owner's "multiple rounds of planning with your subagents before
implementing," three planning documents were produced by three
independent planning agents (each grounded read-only in the real code),
and are recorded under `docs/planning/`:

- **`docs/planning/CLI-DESIGN.md`** (PLAN-CLI) — the `acute` CLI: the
  attach-or-spawn architecture (the R98-K portal-discovery file → the
  sidecar's `ACUTE_READY` handshake, the Node port of
  `sidecar.rs::spawn_and_handshake`), the full command table (`acute`,
  `acute -p`, `sessions`, `models`, `providers`, `config`, `status`,
  `raw`), the zero-dep file layout (`cli/` workspace package), the
  SSE→terminal rendering spec (incremental-only — each frame writes its
  own delta, never re-rendering; the quadratic-snapshot lesson), the
  auth story (attach needs no keys; spawn resolves env → `~/.acute/*.key`
  → OS-keyring probe), and M1/M2/M3 milestones.
- **`docs/planning/ANDROID-R1-ARCHITECTURE.md`** (PLAN-ANDROID-R1) — the
  Android companion, Round 1: React Native + Expo with a CUSTOM design
  system (nothing Material anywhere — the owner's directive), the LAN
  direct-to-sidecar communication architecture (QR pairing with a
  one-time PIN + per-machine self-signed TLS + TOFU pinning + a
  `mobile_devices` token table — the mandatory auth layer for a sidecar
  that today trusts only loopback), the linking model (one paired
  desktop host; project/session mirroring; read-only file access
  deferred), the REMOTE-APPROVALS killer feature (the approval rows +
  notification bus already exist — the phone becomes a genuine remote
  brake pedal because R42 turns survive closed windows), the feature
  tiers, the 8-screen inventory with the "quiet instrument" design
  language (8-pt grid, grotesque ladder, spring physics ~180/22, no
  ripple — press = 8% tint + 0.98 scale), the `mobile/` repo layout
  (standalone package, outside pnpm-workspace), the APK CI workflow
  outline (extends the house release pattern), the sidecar change list,
  and TEN explicit open questions for planning Round 2.
- **`docs/planning/OMP-ADOPTION-ROADMAP.md`** (PLAN-ADOPT) — the
  oh-my-pi study turned into a grounded roadmap: for each of the 11
  applicable candidates, the exact landing spot in agent-core (real file
  + function names), inter-candidate dependencies, risk against the
  repo's gates, and a verdict — **R105**: tool-call dialects (scoped to
  two dialects, default-off) + the rate-limit reason taxonomy;
  **R106**: StablePrefix cache reuse + model roles/fallback chains (fed
  by the taxonomy and seeded with the benchmark winners); **LATER**:
  compaction shake, edit auto-repair, read summarization, todo nudges,
  the single-loop dedupe (its own parity round); **SKIP**: session tree
  (the R44-c fork-as-copy contract already covers it), prompts-as-.md
  (the R59-F override registry already covers it).

The oh-my-pi repo itself: MIT-licensed (no conflict with the
license-audit allow-list), an exceptionally active Bun+TS monorepo whose
per-model-family tool-call DIALECTS are the single most valuable idea
for our free-model reliability problem.

### D — the free-model benchmarks (the owner's testing strategy)

Ten models tested with the four provided OpenRouter keys + the NVIDIA
key (two probes each: a structured tool-call round-trip and a streamed
speed probe measuring TTFT + tokens/sec):

- **`cohere/north-mini-code:free` — the single best pick for agent-app
  testing**: tools PASS in 317ms, fastest TTFT (471ms), the ONLY true
  fine-grained streamer (78 tok/s measured), 2/2 clean first-try, zero
  429s, code-specialized.
- **`nvidia/nemotron-3-super-120b-a12b:free`** — the capable fallback:
  fastest tool-call (110ms), 120B MoE tier, 262k context, clean stop;
  slower stream.
- **`deepseek/deepseek-v4-flash-0731:free`** — solid tool calls, 1M
  context, slowest streaming of the working set.
- Field hazards cataloged: OpenRouter free 429s are MODEL-LEVEL upstream
  ("temporarily rate-limited upstream" — key rotation does NOT help);
  geo-blocks surface as HTTP 400 "User location is not supported";
  missing capability surfaces as HTTP 404 "No endpoints found that
  support tool use" (pre-filter on the catalog's `supported_parameters`);
  and STREAMING GRANULARITY varies wildly — two "streaming" models emit
  the entire answer as ONE chunk (fake streaming, unusable for agent UX)
  and one emitted a 13.7s stream with zero `delta.content`.

The findings feed directly into the adoption roadmap (the dialect work
converts tool-call-failing free models into working ones; the taxonomy
work routes the rate-limit failures honestly).

### E — the first oh-my-pi adoption: the rate-limit REASON taxonomy (R105-C)

The adoption roadmap's R105-B item, implemented this round (the other
R105 item — the tool-call DIALECTS — is deliberately deferred to a focused
next round: it is the roadmap's M-L effort and "quality over speed" wins):

- **`agents/error-classification.ts`**: the new `RateLimitReason` taxonomy
  (`quota` | `rate` | `capacity`) + the pure
  `classifyRateLimitReason(message, status)` — quota shapes first
  (OpenRouter's literal `free-models-per-day`, daily/monthly caps, quota
  exhausted, the credits family), then capacity (at capacity / overloaded
  / capacity exceeded), then the generic rate shapes (RPM/TPM,
  too-many-requests, bare 429). `ProviderErrorClassification` gains the
  additive `rateLimitReason?` field, threaded at both rate_limit return
  sites — and ONLY there: no existing class ever changes (a 503-overloaded
  stays `network` exactly as before — the reason only ever REFINES an
  existing rate_limit classification).
- **`lib/retry.ts`**: `effectiveRungWaitMs(scheduleMs, retryAfterMs,
  reason)` — a QUOTA floors the wait at the new
  `RATE_LIMIT_QUOTA_FLOOR_MS` (10 minutes — the owner's own ladder's
  first "patient" rung): the free-model benchmark's core hazard
  (OpenRouter's daily-cap 429 riding 90-second rungs that re-burn attempts
  against a cap that resets at midnight) can no longer happen. A LONGER
  provider Retry-After still wins; rate/capacity/undefined keep the
  pre-R105 semantics byte-identically.
- **`runtime.ts`** (both catch blocks — the streamed turn AND the child
  runner): the ladder's `retryAfterMs ?? scheduleMs` becomes
  `effectiveRungWaitMs(...)`; the `meta.retry` frame gains the additive
  `rateLimitReason` field (typed in `src/lib/api.ts`; the retry card's
  reason surfacing is R106 work — the field rides the wire now so the
  reason is never lost); the `provider.retry_ladder` log line carries it.
- **Migration `0039_provider_lessons.sql`** + `storage/provider-lessons.ts`
  (the oh-my-pi "lessons learned" pattern): every rate-limit-with-reason
  upserts `(provider, model, reason) → count + first/last ts` — the
  honest, queryable memory of what actually fails on the owner's machine,
  ready for the R106 ModelsProvidersTab surfacing and the roles/fallback
  chain seeding. Write-only this round (no UI, no routes — the
  design-audit ratchet untouched); `recordProviderLesson` never throws
  (the telemetry rule: a failed lesson write must never take a turn down).
- **Tests** (`tests/r105-rate-limit-reason.test.ts`, 16 cases): the
  taxonomy's pattern table (quota/capacity/rate/undefined + the
  specific-first ordering), the classification threading (including the
  "non-rate classes never carry a reason" pin), the floor's unit table,
  the storage upsert + never-throws, and the RUN-LEVEL integration leg —
  a real streamed turn whose chat throws the owner's literal
  `free-models-per-day` body sees its meta.retry frame floored at 10
  minutes EVEN with a customized 0-ms rung (an AbortSignal escapes the
  wait; the documented abort self-correction — the next call routes to
  the honest ABORTED outcome — is pinned as 2 calls, not a hang).
- **The honest re-pins**: the R80/R78 fixtures that rode rung 1 (0 ms)
  with quota-shaped bodies moved to rate-shaped bodies (their purpose is
  the SETTINGS-driven rungs and the ladder gating — a quota body would
  now floor them into 10-minute hangs; the quota path has its own
  coverage); the storage test's migration list pin gained 0039.

## §3 Verification

- **In-sandbox (true exit codes, no pipes — the R104 lesson)**: lint 0,
  tsc 0, design-audit clean (101 files, R2 at baseline 1526), full
  vitest suite 3823 passed, agent-core tsc 0, license-audit clean (247
  deps), docs:check 0 failures, production build + mermaid chunk check
  green.
- **Live browser verification** (agent-browser against the dev server):
  the composer textarea's computed outline is `none`; the shell renders
  the accent border + halo while focused; clicking a message keeps the
  whole-section highlight; VLM screenshot review confirms the cohesive
  unit ("no stray or separate border around only the text input part").
- **CI (the compile gate that matters for the Rust leg)**: first push
  RED (6 honest errors — §5); hotfix 83b98c9 GREEN on ALL THREE jobs:
  rust-linux, rust-linux-arm64, and the full verify job. The GTK
  surgery compiles on both Linux architectures.

## §4 The owner's TEST CHECKLIST

**v0.102.0 on LINUX (both fixes are Linux-visible; Windows behavior is
unchanged by construction):**

1. Open a project → chat → open the right sidebar's **Browser** tab.
   Expect: the browser renders INSIDE the panel's page area — one
   window, one app, the page floating over the UI exactly like the
   Windows build. The "split into two parts" (app on top, preview on
   bottom) is GONE.
2. Resize the window while a page is loaded. Expect: the page area
   follows the panel (the frontend's bounds sync now actually lands —
   it was always firing).
3. Switch tabs / collapse the sidebar / pop the browser out and back.
   Expect: sessions persist as before (hide/show is widget-level);
   positions hold on re-show (the R91-B2 re-assert now rides the GTK
   path).
4. Click the app UI AROUND the browser page (sidebar, transcript).
   Expect: every click lands on the app — the Fixed is pass-through.
5. Click a chat message, then look at the composer. Expect: NO ring
   around the text area alone; the WHOLE composer section (input +
   settings row) carries the accent border + soft halo as one unit.
   Click a sidebar button — the highlight fades smoothly (200ms).
6. Type — the caret is the input's own indicator; nothing else paints.
7. Drag a file over the composer — the dragActive accent tint still
   paints (the one REAL state that ever paints inline).

**Also unchanged (regression sweep):** Windows update flow, Linux
API-key saves (the owner's confirmed-working list), and every gate the
CI verify job runs.

## §5 Lessons (the round's AGENT-MEMORY entries)

(a) CASCADE LAYERS OUTRANK SPECIFICITY — THE COMMENT THAT SAYS
"OVERRIDES BY CLASS SPECIFICITY" MUST ALSO SAY WHICH LAYER THE RULE LIVES
IN. The composer ring survived two rounds of fixes (R101-D softened it,
R102-E deleted the wrong leg) because the mental model was specificity
while the mechanism was layers: an UNLAYERED rule beats every layered
utility regardless of specificity — and the `:where()` zero-specificity
trick was beside the point (the outer `:focus-visible` pseudo-class
contributes its own (0,1,0) anyway, exactly tying `.outline-none`). The
fix was moving the global rule INTO `@layer base` — one line, and the
documented architecture became true. Every future global CSS rule gets a
layer decision AT THE RULE ("base if it's a default, utilities must be
able to beat it; unlayered only for true singletons like the
`.composer-shell` pair").

(b) TEXT-ENTRY ELEMENTS ALWAYS MATCH :focus-visible — INCLUDING ON
MOUSE CLICK. The spec's carve-out (the caret is not deemed sufficient
indication for text inputs) combined with "clicking a non-focusable
element never moves focus" produced the exact "I clicked a message and a
border appeared around the input" report shape: the ring had been there
since the textarea was focused, and the message click was innocent.
When a focus-ring report says "appeared when I clicked X," check whether
focus EVER LEFT the input before blaming X.

(c) THE LINUX CHILD-WEBVIEW CONTRACT IS THE WRY DOC'S FINE PRINT:
bounds are only honored for GtkFixed children, and tauri packs add_child
webviews into the vertical GtkBox — the split is the DEFAULT, not a bug
in our geometry code. The surgery pattern (reparent into an
Overlay+Fixed, pass-through input, move_+size_request durable +
size_allocate immediate) is reusable for ANY future child-webview
feature on Linux (the mini window's browser legs, overlays, picture-in-
picture). The E0515 lesson inside it: `opt.and_then(|p| p.downcast_ref::
<T>())` borrows the closure's own parameter — bind the Option first,
`.as_ref()`, then downcast.

(d) NO LOCAL RUST TOOLCHAIN MEANS THE GTK 0.18 API SURFACE MUST BE
SOURCE-VERIFIED BEFORE WRITING. Every method signature (`OverlayExt::
add_overlay`, `FixedExt::put/move_`, `ContainerExt::add/remove/children`,
`WidgetExt::parent/toplevel/set_halign/size_allocate/is_visible`,
`Allocation::new`), the PartialEq story for glib objects, the prelude
exports, and the GTK 3.24 C source of `gtk_overlay_get_child_position` /
`gtk_fixed_size_allocate` / `gtk_overlay_forall` / pass-through were all
read from the actual crates/sources first. The payoff: the first CI
compile had exactly SIX errors, all borrow/import mechanics, ZERO API
misuse — the hotfix was one push.
