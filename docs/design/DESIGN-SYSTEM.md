<!-- last-reviewed: 2026-09-24 round-126 -->
# ACUTE-CODE Design System

**Why this document exists (owner direction, round-16/2026-08-23):** "the UI
needs to be thought of properly from the start … proper design logic and a
system which we can follow" — one reference every screen follows, so the app
stays consistent by construction and new features plug in without visual
drift. Owner verdicts supersede anything here; record changes to this file
in the same round that changes the UI.

**ROUND-126 (the Clay Companion redesign) supersessions, recorded here per
the standing rule:** (1) the app's default theme is **Clay Studio** (was
Nova Cream — a one-time nova→clay migration on both the local persist leg
and the server hydration leg; TOKENS §1b). (2) The identity faces are
**Manrope + JetBrains Mono** (was Space Grotesk; TOKENS §2). (3) The
**bento 1.5px top-level card border is retired** — the clay card's default
edge is the warm `clayRim` hairline + the layered clay shadow (TOKENS §5/§9,
COMPONENTS §3); §2's border-forward paragraphs below are historical. (4)
The **surface ladder** (well/header/tint/rim/mono — TOKENS §10) and the
**status grammar** (badge tone containers + deep text tiers — TOKENS §11)
join the pipeline. (5) The chat route's borderless law (below) STANDS —
only its inner recesses adopt the well/mono-block materials. Where this
file's older text still speaks bento/nova, `docs/design-language/` (the
language layer, updated in this same round) is the operative authority.

## 1. Source of truth

- **The language layer (round-98)**: `docs/design-language/` — TOKENS
  (the color pipeline + type/spacing ladders), MOTION (the animation
  grammar + keyframe registry), COMPONENTS (the shared-primitive catalog),
  WIZARD-DNA (the owner-approved aesthetic), WINDOW-CONTROLS (the app
  frame), USAGE (the per-edit checklist + do-not list). Every UI edit
  refers to it there first (owner round-98 directive).
- **Colors**: NEVER hard-coded in components. Everything flows from
  `src/lib/themes.ts` (`THEMES` table) through `useThemeStyles()` /
  `deriveThemeStyles()` and the `--ac-*` CSS variables it bridges. Six
  themes (Nova Cream, Bento Blue, Midnight Lab, Sunset Pop, Mono Stone,
  Clay Studio — R107-g, the owner's clay substrate) × light/dark; optional
  per-theme `accentDark`. The liquid-chrome ramp (`--ac-chrome-hi/mid/lo/`
  `sheen`) is theme-independent + mode-aware — set by the same bridge,
  documented in `docs/design-language/TOKENS.md` §8; the CLAY material's
  layered soft shadows (`--ac-clay-shadow`/`-sm`, the R108-e rework of
  clay-as-form) live in TOKENS §9 — clay depth is shadow + form, never a
  painted gradient wash.
- **Documented exceptions only**: `SEMANTIC_COLORS` (success `#22c55e`,
  danger `#ef4444`, warning `#f59e0b` — R97-I: the amber for wait/attention
  states — retry waits, queued messages, thinking-loop stops) in
  `src/lib/semantics.ts`; file-type + syntax palettes
  in `src/components/project-chat/highlight.ts`; the code-panel traffic
  lights. Anything else hard-coded is a bug.
- Alpha tints: `withAlpha(color, 0.08–0.13)` from
  `src/components/dashboard/helpers.ts` (never string-suffix hacks).

## 2. Spacing & layout scale

| Token | Value | Used for |
|---|---|---|
| pad-2 | 2px | chat-route app padding (owner round-16) |
| gap-3 | 3px | between chat panels (borderless language) |
| pad-3/4 | 12/16px | normal app routes |
| gap-4 | 16px | dashboard cards |
| radius | rounded-2xl (16px) | panels/cards; rounded-xl (12px) inner controls |
| handle | 5px | drag strips between chat panels |

Rules: the **project-chat route is borderless** — panels are surfaces
(backgroundColor `card`) separated by 2–3px background gaps, NO outline
borders (owner round-16). All other routes keep the bento card + 1.5px line
borders. Fullscreen chat: app sidebar hidden, hamburger toggles it.

## 3. Typography

Font stacks + sizes are the demo's: 13px body, 12–12.5px file/mono lists,
11px labels (uppercase, tracking-[0.1em] for section headers), 10px
meta/mono chips, 9.5px stat chips. `font-mono` for anything machine (paths,
models, stats, tool pills). Bold only for names/headers; RichText parses
`**bold**` + `` `code` `` only.

## 4. Motion

`ease = [0.25, 0.1, 0.25, 1]` everywhere (`src/lib/motion.ts`). Message
enter 0.35s y+12; exit 0.2s y-8; panel width 0.25s; dropdowns 0.2s
scale-0.97; collapsibles height 0.2s. Keyframes in `src/index.css`:
`bounceDot` (thinking dots + streaming cursor), `auto-scroll` (scrollbars
appear only while scrolling — via `useScrollFade`). No new keyframes without
a slot here.

## 5. Component anatomy (inventory)

- **Skeleton primitives (R97-I)**: `SkeletonBlock` / `SkeletonRows` in
  `src/components/shared/Skeletons.tsx` — the ONE spelling for the §6
  loading rule: decorative `aria-hidden` pulse blocks in the theme's
  `subtle` surface; the call site owns the single `role="status"`
  announcement. Loading states MUST use them, never ad-hoc `animate-pulse`
  divs.
- **Chat message (ROUND-37 turn model)**: user = accent bubble, right,
  rounded-2xl rounded-br-md, max-w-[85%], hover copy. Assistant = ONE
  header-less turn per user message: a borderless **Working section**
  (muted header `Working · mm:ss` live / `Worked for Ns · N actions` done;
  one-line rows — ThoughtRow `Thought for Ns` + preview (auto-expand while
  streaming, auto-collapse when done), ToolLine verb-label + mono args +
  status glyph (expands to diff/terminal/output detail), ApprovalRow) then
  the **final answer** (RichText + hover copy + turn-level stat chips
  `s · ↑in · ↓out · tok/s · model`) BELOW the section — collapsing the work
  never hides the answer. NO avatars, NO name headers, NO Sparkles (owner
  R37: "AI slop"). The activityMode preference (Detailed/Compact/Hidden)
  sets the section's default; its popover lives on the section header.
- **Streaming states**: live Working section counts up (mm:ss) + pulses;
  streamed text renders below it as the presumptive final (a tool-call
  flushes it into the section as narration); "Thinking…" mono line before
  first delta; stream error freezes the section at "Stopped"; a
  transient-API retry wait shows the amber `RetryStatusCard` (role=status,
  attempt N/6, class chip, live countdown — R75; redesigned R77: circular
  spinner chip, attempt dot-ladder with the pulsing current dot, a
  countdown fill-bar driven by `waitMs`, reassurance line with info icon;
  R78: under the class chip the provider's REAL error text — mono,
  break-words, 3-line clamp (`data-retry-provider-error`), over 240 chars →
  excerpt + "Show full error" toggle expanding the complete scrubbed text
  in a scrollable mono block (the R77 TurnErrorCard treatment; the class
  chip is the one-glance summary, the API's words are the evidence — never
  paraphrase the provider into the class line); R80: the attempt count and
  the schedule are the RESOLVED settings (maxAttempts 2–10 configurable —
  the dot-ladder and every "attempt N/M" line follow the configured
  schedule, never a hardcoded six))
  above the work, cleared by the first content frame; terminal errors show
  `TurnErrorCard` (role=alert) with the error-class chip + "after N
  attempts" (R75) and the R77 full-error toggle — reasons over 240 chars
  collapse to an excerpt with "Show full error" expanding the COMPLETE raw
  provider text in a scrollable mono block (R80: the caps behind the
  surfaces rose — the persisted detail to 4000 chars, the user-facing
  one-liner to 600 — so the toggle reveals more of the real payload;
  scrubbing unchanged).
- **Queued-message chip (R78)**: while the agent works, a send POSTs to
  the session queue and renders as an amber chip in the live area under
  the Working section (`data-testid="queued-chip"`, `Clock` glyph,
  2-line-clamped content, queue-time ts, title "Queued — sends after the
  current step"). States: **queued** (X-remove `data-queued-remove`;
  "Send now" `data-queued-send-now` only when idle) → **delivered** (the
  `queued.delivered` frame swaps the chip for an ordinary user bubble;
  after stream end the folded `message.queued` rows own the chips). A
  Stop or crash leaves chips queued — they persist in the event log and
  deliver in order before the next send. While the stream is open the
  LIVE chip owns the render (a mid-stream refetch shows exactly one chip,
  never zero).
- **Sub-agent task-id chips (R79)**: when a delegated child is
  ADDRESSABLE (the parent model gave it a `task_id`), the id renders as
  a small MONO chip — in the Sub-agents panel's detail header beside
  the code chip (`data-testid="subagent-taskid-chip"`, `max-w-[120px]`
  truncate, tertiary-tinted) and on the chat's live SubAgentCard meta
  line between role and status (`data-testid="subagent-card-taskid"`,
  `max-w-[130px]` truncate). ONLY-when-present: `taskId: null` (every
  pre-R79 child / unaddressed delegation) renders NO chip — no empty
  affordances. Both chips carry the tooltip that teaches the resume
  affordance: `Background task id X — delegate_task {"resume":"X"}
  collects it` — the owner can read the id off the UI and reason about
  what the model will collect. The panel chip resolves LIVE-first (the
  SSE map's carried `taskId`, present from the queued frame onward)
  with the polled `/subagents` row as the fallback.
- **Retry schedule controls (R80, Settings → General → Auto-retry)**:
  below the R78 per-class switches, the Schedule section owns the
  CUSTOMIZABLE ladder — the Max attempts stepper
  (`data-testid="retry-max-attempts"` with ± buttons
  `retry-max-attempts-minus`/`-plus`, disabled at the 2/10 bounds), one
  numeric wait input per rung (`data-testid="retry-wait-<i>"`, labeled
  with the attempt it precedes `#2..#N`, step 0.5, 0–1440 min, snap-back
  on out-of-range blur), the Provider call timeout input
  (`data-testid="retry-timeout"`, 60–3600 s, step 30), and Reset to
  defaults (`data-testid="retry-reset"`, the RotateCcw glyph). Every
  control PUTs a PARTIAL patch through the card's shared mutation; the
  rung rows, the stepper, and the footnote ("6 attempts: immediately,
  1.5 min, 5 min, 10 min, 30 min") all re-render from the REFETCHED
  state — the copy never hardcodes the R75 rungs. Busy state disables
  the whole section while a PUT is pending.
- **Composer (R50 box, R75 one-row, R77 left/right split, R78 action anchor)**: one
  rounded-[18px] box (bg token, accent border + glow on focus) =
  auto-growing textarea on top (grows to exactly 5 visible lines via
  `useLayoutEffect` keyed on `input` — `flex-1` removed, the height style
  governs, maxHeight synced — then scrolls internally), attachment chip
  row when any, then ONE toolbar row inside the box built as a **wrapping
  area + a never-wrapping action anchor** (R78, owner: "the chat bottom
  buttons occasionally render in wrong positions"): the toolbar
  (`flex items-end justify-between`) has exactly TWO siblings — (1) the
  WRAP area (`flex-1 min-w-0 flex-wrap items-center gap-1`) holding the
  LEFT cluster (`data-composer-left`: attach + THE unified operating-mode
  picker — the owner's R77 left pair, R81: the task-mode pill was folded
  into the single 3-option selector; postures are agent-selected now) and
  the selector group
  (`data-composer-right`: context donut + model (leads with a `Cpu` icon,
  icon-only below the container floor) + thinking, `ml-auto shrink-0` —
  when the row is too tight the selectors wrap as a unit under the left
  cluster, right-aligned on their line); (2) **THE ANCHOR**
  (`data-composer-actions`, `shrink-0`, a DOM sibling NEVER inside the
  wrap area) holding Continue / Send / Stop + the queue-send button
  (accent ArrowUp + ListPlus, beside Stop while busy — R78), pinned
  bottom-right by `justify-between` — the action button can never wrap,
  jump lines, or drift at any width. The box is a CSS `@container` and
  the selector pills' text labels hide below 560px (icon-only; tooltips
  carry them) so the row fits at the 480px chat floor.
- **Reverted message flow (R77)**: the user-bubble hover "Revert to this
  message" rewinds to BEFORE the message — the message + its reply are
  deleted from the log (backend `seq >=` truncation) and the message's
  text returns to the composer (prefilled + focused) for edit-and-resend;
  the confirm dialog says exactly that.
- **Panels**: Explorer (34px rows, depth×14+8 indent, chevron rotate,
  per-ext icon colors), Code (48px gutter, tokenizer highlight, "Acute
  editing" chip), To-Do (progress ring 263.89 dasharray, mission, toggles),
  TopBar (h-9→48px: hamburger toggles app sidebar, brand, ⌘K file search,
  Code/Experimental/dark toggles).
- **Dialogs**: Radix, `top-1/2 left-1/2` + **base transform
  translate(-50%,-50%) matching the animation end-state** (lesson #30);
  1.5px line border, 12px radius, header/body/footer zones.

## 6. Interaction rules

Drag handles: `role="separator"` + arrow-key resize + focus ring; chat
handle sits on the chat's LEFT edge (drag right = shrink chat). Popovers:
outside-click close, `aria-haspopup/expanded`, listbox semantics. ⌘K =
TopBar file search. Buttons: active:scale-95, hover subtleHover. Loading:
the shared Skeleton primitives (§5) or spinners, NEVER blank flashes.
Errors: inline role=alert with the exact cause + retry; red only via
SEMANTIC_COLORS.danger.

## 7. Adding a screen (checklist)

1. Theme tokens only (no hex) · 2. Spacing from §2 · 3. Borderless if it's a
chat surface, carded otherwise · 4. Motion from §4 · 5. Reuse §5 anatomy
before inventing · 6. A11y: roles, labels, keyboard · 7. Screenshots at
1920×1080 + tall 1080×1600, zero console errors, recorded in
`docs/ui-iterations/round-NN.md` · 8. Update this file if anything new was
introduced.
