<!-- last-reviewed: 2026-09-24 round-126 -->
# Components — the primitive catalog and composition rules

Serves DESIGN-SYSTEM §5 (anatomy inventory). The inventory there names the
behavioral contracts; this file names the **shared visual primitives** —
the "one spelling" rule that kills the AI-slop repetition smell (round-98
C2's mandate: no idiom re-implemented per file).

**ROUND-126 (the Clay Companion redesign):** the card/chip/button grammar
moves onto the clay surface ladder (TOKENS §10) + the status grammar
(TOKENS §11). The mobile primitives' recipes (`mobile/src/design/
primitives.tsx` — ClayCard, ChromeButton, Chip, Badge, ClayIconChip,
SegmentedControl) are the adapted references: same materials, PC densities.
§7's chat anatomy rides the R119/R120 owner-approved contracts UNCHANGED —
only its materials re-skin.

## 1. The primitives (one spelling each)

ROUND-100 (R100-C): the token-level rules in TOKENS.md (the 5-step radius
scale, the weight law, the 10px floor, hairline-vs-1.5px borders) supersede
any legacy numbers still quoted below; waves D–G apply them per screen, and
each row touched updates here in the same round. The first three extracted
`src/components/ui/` primitives (Kicker / SectionCard / SettingsRow) are the
rows the waves import instead of re-implementing.

| Primitive | Source | Contract |
|---|---|---|
| `SkeletonBlock` / `SkeletonRows` | `src/components/shared/Skeletons.tsx` | ALL loading states. Decorative `aria-hidden` pulse in `subtle` surface; the call site owns the single `role="status"` announcement. |
| `ChoiceCard` | `src/pages/SettingsPage.tsx` | radio-circle + label + one-line description; the pattern for every pick-one setting (text size, timestamps, tool activity, search engine, link opening — R99-A, wrapped in a labeled `role="group"` when the pair is one radio decision). |
| `SettingsLoadErrorCard` | `src/pages/SettingsPage.tsx` | the honest error card for a failed settings GET: `role="alert"`, danger tint, exact cause, one Retry. |
| `Kicker` | `src/components/ui/Kicker.tsx` | ROUND-100 (R100-C, research §C1.1): THE label-tier heading — 11px/500 uppercase `tracking-[0.08em]` tertiary ink, optional 12px lucide glyph, `as` h2/h3/div. The ONE kicker spelling; every 10.5px-black / 11px-bold variant is drift the waves retire. |
| `SectionCard` | `src/components/ui/SectionCard.tsx` | ROUND-100 (R100-C, research §C1.4): the settings/panel bento card — `rounded-2xl` (the 16px radius step) + 1.5px `border-line` + `bg-card`, p-5/p-6, optional `softShadow`, optional Kicker + 13px/600 title header. The card species of §3, extracted. |
| `SettingsRow` | `src/components/ui/SettingsRow.tsx` | ROUND-100 (R100-C, research §C1.2): the label+control row — 36px min-height, 13px/400 label + optional 11px tertiary description (`flex-1 min-w-[200px]`), right-aligned shrink-0 control slot, optional top hairline. NO JS hover (the parent owns the CSS wash). |
| `CommitNumberInput` | `src/pages/SettingsPage.tsx` | numeric stepper that PUTs only on blur/Enter (never mid-typing). |
| `ConfirmDialog` | `src/components/settings/ConfirmDialog.tsx` | every destructive action's guard — exact enumeration of what will be destroyed. |
| `withAlpha()` / `bdr()` | `src/components/dashboard/helpers.ts` | the only sanctioned alpha-tint + border helpers. |
| `ClampedText` | `src/components/shared/ClampedText.tsx` | N-line clamp + expand affordance. |
| `CodeBlock` | `src/components/project-chat/` (ChatMarkdown) | fenced-code rendering: Prism tokens, gutter, wrap contract. |
| `ChatMarkdown` | `src/components/project-chat/ChatMarkdown.tsx` | the message-body renderer (headings/lists/tables/fences/PathPills). |

**The rule**: before writing a new pill/chip/card/error/loading idiom,
check this table. If it exists, import it; if it doesn't and two surfaces
need it, make it a primitive and add the row here in the same round.

## 2. The chip grammar

Chips are the app's densest idiom. One grammar:

- **Stat chip**: `meta-mono` tier (10px mono tabular — ROUND-100 R100-C: the
  9.5px `stat` step is RETIRED, TOKENS §2's hard floor), `subtle` bg,
  hairline border, tertiary text — usage: `s · ↑in · ↓out · tok/s · model`.
- **Status chip — ROUND-126 (R126)**: the badge TONE CONTAINERS
  (TOKENS §11): `bg-badge-success` + `text-badge-success-fg` (and
  warning/danger/running/accent/neutral likewise) — the tinted container +
  deep-on-tint ink pair, never `withAlpha` hacks, never flat-hue text, never
  white-on-saturated fills. `role="status"` unless it IS an alert.
- **Identity chip**: mono, `subtle` bg, truncate — models, task ids, paths.
- **Action chip**: quiet until hover (the hover-actions cluster pattern:
  Copy/Revert/Timestamp reveal on group-hover-within — keyboard parity via
  group-focus-within).

Never more than one tinted status chip per row; never a chip inside a chip.

## 3. The card grammar

Two card species only:

1. **Clay card — ROUND-126 (R126, mobile ClayCard adapted)** (default
   outside the chat route): `card` surface, the warm `clayRim` hairline on
   all four sides (`border-clay-rim`), 16px radius (`rounded-2xl`),
   `--ac-clay-shadow` (`.ac-clay`) + the dark-mode-only matte top edge
   (`.ac-clay-edge-dark`); hover = rim→border-strong swap (120ms, no lift,
   no bloom). Compact tiles use `.ac-clay-sm`. Sections inside step 12/16px;
   recessed content sinks into `bg-well` (TOKENS §10's ladder). The
   pre-R126 bento card (1.5px border + softShadow) is RETIRED — waves
   convert as they touch each screen.
2. **Chat surface** (the borderless route): no border, no shadow —
   surface-on-background separation via 2–3px gaps. Depth is expressed by
   the working/folded state, not by shadow. Recessed wells INSIDE the chat
   card (the activity well, terminal blocks) use `bg-well` /
   `.ac-mono-block` like everywhere else — the borderless ROUTE law governs
   the route's panels, not its inner recesses.

Section headers inside cards: `label` type (11px uppercase tracked) or
`section` type (13px semibold) — pick per density, then be consistent
within the card.

## 4. The button grammar

**ROUND-126 (R126, mobile ChromeButton/QuietButton adapted):** the
working-UI button family is quiet-solid clay — gradient fills, bento hard
shadows, and glow hovers are RETIRED from working screens (they survive in
the WIZARD only, per WIZARD-DNA).

| Species | Anatomy | Motion |
|---|---|---|
| Primary (working UI) | **quiet-solid**: `bg-accent-deep` fill + `text-accent-text` ink, `rounded-lg` (12px input radius reads better on PC than mobile's 14 at our densities), h-9 (36px) standard, `font-semibold` 13px label | press: scale 0.98 on SPRING + shadow collapse to `.ac-clay-pressed`; disabled = `bg-subtle` + `text-tertiary`, opacity intact |
| Secondary | outlined: `bg-transparent` + 1px `border-strong` + `text-secondary`, same radius/height | press 0.98; hover `bg-subtle` |
| Ghost | text/icon only, `subtle-hover` wash | press 0.95 |
| Danger | `bg-danger-deep`-family: outlined danger (1px danger border + danger-deep text) for co-primary; solid `#DC2626`+white ONLY for the one destructive confirm | press 0.98 |
| Icon | 28–32px square hit target, `rounded-lg` | same as ghost |

Press feedback (`active:scale-95` universal floor; `0.98` + shadow collapse
on clay-primary buttons) — a button without it is a bug. **One primary per
screen** (mobile law, adopted): the primary is the screen's single intent,
everything else is secondary/ghost.

## 5. The layout grammar

- Chat route: borderless surfaces + gaps; the transcript is a centered
  column (max-w-[1080px]) with graduated padding; panels flank.
- App routes: bento cards on the app background; 12–16px gutters.
- **Master-detail-lite** (round-99 F, Settings → Prompts): a scope-grouped,
  searchable master list (~300px, its own `max-h` + the app's thin pill
  scrollbar — the long-list discipline) beside the selected row's detail
  pane, inside the page's normal scrolling column — NOT the api tab's
  viewport-locked two-pane (reserve that for wide forms). Below `md` the
  panes STACK: list first, the selected row hides while its editor is open,
  and a "← All sections"-style back affordance on the detail header closes
  it (`hidden md:flex` toggling — never both `hidden` and `flex` in one
  class list). The active row uses the provider-list grammar: `aria-current`,
  `bg-accent-soft` wash + 2.5px accent bar on the CSS-var leg, hover via
  `hover:bg-hover`.
- Popovers/flyouts: 12px radius, `border-strong`, `bentoShadow`, 1.5–2px
  border, outside-click close, `aria` semantics (DESIGN-SYSTEM §6).
- Dialogs: Radix center, 12px radius, header/body/footer zones, base
  transform = end-state.

## 6. The data-display grammar (round-98 I2 adds; round-99 E adds the
anti-jitter + danger-zone rules; **ROUND-127 adds the chart-interaction
laws** — the owner's walkthrough: hovers that only fire above the bar,
tooltips that overflow the card edge, a too-thin donut, empty 7-day
views, charts that open at the oldest end)

- **Stat cards**: big number (22px **600** tabular — ROUND-100 R100-C: the
  value tier is 600, never font-black; TOKENS §2's weight law) + label + one
  supporting line; icon quiet-tinted; never a rainbow. R99-E: pinned
  `h-[92px]` (the exact height every StatCard-shaped skeleton reserves
  app-wide) and the value renders `tabular-nums`.
- **Charts**: theme accent for the primary series; per-model/per-category
  series get STABLE palette hues keyed by name (same name = same color,
  everywhere in the app — the model palette in
  `src/components/usage/usage-helpers.ts`, the usage segment palette
  precedent in `src/lib/menu-overlay.ts`).
- **Heatmap**: intensity = accent alpha ladder (0 → 0.15 → 0.35 → 0.6 →
  0.85 → 1); empty days transparent; month labels `meta` type.
- **Donut/ring**: 6px track, center hole carries the headline stat; segment
  hover = MUTUAL highlight with the legend row (the round-97 context-bar
  contract, generalized). **ROUND-127 (the gauge law): the DONUT-FOR-SHARE
  charts (ModelDonut-class) draw a REAL gauge — ring ≥ 160px, stroke ≥ 14px
  (a ~9% ring ratio), the center stat at display tier; the 6px hairline
  track survives ONLY for micro-meters (the composer's ContextDonut) where
  the ring sits beside a 46px control.** A share donut the owner squints at
  is a defect.
- **Chart hover hit-testing — ROUND-127 (the full-column law)**: every bar
  chart's hover resolves through ONE transparent hit column per bar that
  spans the FULL plot height (`data-bar-idx` on the column), and the PAINTED
  segments above it are `pointer-events: none` — so hovering the bar's BODY,
  its cap, or the empty air beside it all resolve the same bar. The R121-d
  single-pointer-read law (one `onPointerMove` on the chart card, hit via
  `closest("[data-bar-idx]")`) is unchanged; the DEFECT it fixes is painted
  rects without the idx eating the pointer over the bar body (the owner's
  "hover only works at the top area" complaint).
- **Chart tooltip placement — ROUND-127 (the edge law)**: a tooltip centers
  on its bar only while it fits; near the FIRST/LAST bars it clamps inside
  the chart card's content box (align the tooltip's near edge to the plot's
  edge + a small inset). NEVER a `translateX(-50%)` that overflows the card
  at the right end (the owner's "details show where there is no place to
  view them"). The clamp math rides the shared helper in
  `usage-helpers.ts` (`clampTooltipX`), one spelling for every chart.
- **Dense-series labeling — ROUND-127 (the sparse-tick + hour laws)**: when
  a series renders more bars than the label band fits (~14 at 20px bars),
  x-labels thin to SPARSE TICKS (the ModelStackChart 4-tick pattern —
  first, ⅓, ⅔, last); HOUR buckets (the 7-day hourly view, granularity=
  hour from `/usage/detailed`) label `HH:00` ticks + a `Mon DD · HH:00`
  tooltip header through a DEDICATED hour-label branch — hour dates NEVER
  reach the `\`${date}T00:00:00Z\`` day-label helpers (they template-append
  and yield Invalid Date; dashboard/helpers.ts is day-only by contract).
- **Scroll-to-latest — ROUND-127 (the newest-end law)**: any chart whose
  natural width overflows its card (`overflow-x-auto`) MOUNTS at the
  NEWEST end (scrollLeft = scrollWidth on mount + on every range/data
  swap). A 90-day token-activity that opens at the oldest week with the
  live edge off-screen is a defect (the owner's "should automatically
  scroll to the latest one").
- **Anti-jitter kit** (research §3.2): every numeric element renders
  `tabular-nums` (digits hold width while values grow); chart wrappers
  reserve their final height (`min-h` matching the fixed SVG geometry) so
  loading→ready→window switches never reflow; the loading skeleton mirrors
  the READY layout section-for-section (same heights, same order); legend
  rows truncate instead of wrapping; a window switch settles with the
  150ms opacity fade (MOTION §2 quick tier) — NEVER a layout animation of
  a chart.
- **Danger zone** (the GitHub settings pattern): destructive data actions
  live in a LAST, quiet red-OUTLINED box — `1.5px withAlpha(danger, 0.4)`
  border, NO filled background, NO shadow; a danger-tinted label-caps
  micro-header; rows are description-left / red-action-button-right (the
  button keeps its tint); the `ConfirmDialog` owns the exact enumeration
  of what dies vs. what stays. Never interleave a destructive card with
  benign content.

## 7. Chat turn anatomy (round-99 B — the research-driven chat redo)

The transcript's reading grammar (AI_IDE_UX research §1.1–1.2 + the owner's
compressed-vs-full directive):

- **User message = input**: right-aligned accent-tinted bubble, radius 16px
  with the 5px br corner (the sanctioned shape), capped at
  `min(75%, 640px)` of the reading column (92% below 420px — a bubble,
  never a full-width document); ONE unified hover action row
  (timestamp · copy · revert, `tabular-nums` on the time).
- **Assistant turn = document**: borderless full-width markdown. The turn
  HEADER is a ~20px identity row — a 6px accent dot + the turn's MODEL as
  an identity chip (§2 grammar: mono, subtle bg, truncate) + the hover
  timestamp right-aligned (`timestampsMode`-gated, R97-H). No avatars, no
  persona name headers, no Sparkles (the R37 verdict stands — the header is
  metadata, not a persona). One header per turn; intermediate streaming
  segments never get one; a turn with nothing to say renders none.
- **WorkingSection — the compressed/full matrix**: COMPRESSED (folded) =
  status glyph (✓ success / □ stopped / ● pulsing live) + step count
  ("Completed N steps", honestly pluralized) + "· N tools" when tools > 0 +
  the right-aligned duration chip (mono `tabular-nums`, the live clock's
  `m:ss` format); LIVE = "● Working" with the actions counter + elapsed
  clock right-aligned. FULL (expanded) = every ThoughtRow / NarrationRow /
  ToolLine / ApprovalRow / ScreenshotRow / QuestionCard / TodoCard in
  timeline order.
- **ToolLine (the collapsed tool pill)**: leading outcome glyph (✓ success /
  ✗ danger / ◌ in-flight, amber while approval-waiting) + verb + mono
  target + the one-line result summary (`exit 0`, `+N −M`, counts — only
  what the tool's own output carries, R96-H honesty) + expand chevron; the
  status word rides the row's `aria-label`. No per-tool duration — the data
  does not exist (noted, never invented).
- **Turn footer**: one hover row — copy (+ the debug-gated full-turn copy),
  thumbs, then the stats line right-aligned as ONE mono `tabular-nums` text
  (time · in · out · tok/s, middle-dot separated) — never per-stat chips.
- **Numbers discipline**: every duration, count, rate, and timestamp the
  chat renders is `tabular-nums` — digits hold their width while live
  values grow (the anti-jitter rule, research §3.2).
- **Empty state**: suggestions are pill-cards (1.5px `border-line`,
  12px radius, icon + label) with the hover on the CSS-var leg
  (`hover:border-accent` + `hover:bg-accent-soft`) — real buttons, click
  fills the composer.

### ROUND-120 (R120-C-PC) — the center redo amendments

The owner's items 34-39 (round-120 §1 I — "the center-section redo is now
the round's core"). Each supersedes the named clause; the rest of §7
stands:

- **The timeline is a MINIMAP (item 34 — supersedes the R101-D dot
  rail/spine, RETIRED):** a slim vertical bar strip docked at the
  transcript viewport's left edge (`MessageTimeline.tsx`) — it does NOT
  scroll with the content (a navigational minimap: every exchange stays
  reachable while reading deep history). ONE bar per USER exchange (folded
  user rows + the live turn's opener — the optimistic echo, the remote
  mirror's bubble, or a delivered queued message still live-rendering),
  each an honest `<button>`. Hover-proximity scaling: the bar nearest the
  pointer grows to 28px (`MAX_HEIGHT`) with a LINEAR falloff to its 8px
  resting height (`REST_HEIGHT`) over a 56px radius (`FALLOFF_PX` — the
  dock-magnification grammar; a 200ms CSS height transition on the shared
  ease, MOTION.md's quick tier; 0s jump under reduced motion). The CURRENT
  exchange's bar is accent-filled (`bg-accent`) and rests taller (12px,
  `CURRENT_REST_HEIGHT`; ink while previewed, muted otherwise). Hover or
  keyboard-focus shows the preview popover: the first 2 lines of the user's
  message + 2 lines of the agent's response, plain text, `line-clamp-2`
  owning the "2 lines" law so long single lines wrap honestly. Click
  scrolls the transcript to that exchange (`scrollIntoView` on the
  `chat-item-*` anchors the panel stamps on every transcript row).
- **ONE clock + the consolidated footer (item 36 — supersedes the turn
  footer's stats-line CONTENT; the one-line mono `tabular-nums` grammar
  stands):** a turn answers "how long did this run" exactly ONCE — the
  footer's **"Ran 4m 12s · 23 actions · 18.2k tokens"** block
  (`ReplyStats`, middle-dot separated, mono tabular-nums, tertiary; the
  full ↑in/↓out/tok-s breakdown rides the `title` so no data is lost to the
  consolidation). The work-section headers carry NO duration at all, and a
  LIVE turn renders ONE clock — the panel gates it with `clockVisible` on
  the turn's FIRST live work section, so one turn paints one clock, never
  the owner's "8-9 separate right-side blocks."
- **The fold's FILE-MUTATION rows (item 35):** the write/edit/create/delete
  rows (`FILE_MUTATION_TOOLS`) render OUTSIDE the collapse — the mutations
  the agent made to the project are NEVER hidden behind the expand (the
  owner: "file edits, created files… are not shown — the center never
  renders them"). Path + verdict + the streamed diff summary, the same
  tool-row vocabulary the live section always used — the fold's tool rows
  and the live section's are one spelling.
- **The heading ladder never dips under the body (item 39):** the R117-f
  0.9em spelling rendered a `####` heading SMALLER than its own body text
  (the root cause of "no proper headings"). The tiers now step down
  unmistakably — h1 ~1.5em/700, h2 ~1.3em/650, h3 ~1.15em/600, h4–h6 at
  the **1em body floor**/600 — a heading is always at least as large as
  its own body, still unmistakably a heading. Code blocks keep the language
  label + Prism highlight colors + background.
- **The sync/state law (items 37+38):** the working/stop state derives from
  the BACKEND's turn registry, never from SSE frame arrival ("no frames
  lately" → looks done; a refresh mid-turn rendered a finished transcript
  while the backend kept working). The panel polls **GET
  /sessions/:id/live** on mount + every 5s (`SESSION_LIVE_POLL_MS`) —
  skipped while the panel's own SSE reader holds the session (it is the
  freshest truth) — and the store's `rehydrateLiveTurn` makes the three
  honest moves: **live:true + no liveTurn** → REHYDRATE the remote mirror
  from the folded trailing turn (the `startedBySeq` anchor — a refresh
  mid-turn reopens the working state + the stop button); **a non-deliberate
  own stream death with the turn alive** → DETACH onto the mirror path (the
  events bus keeps rendering every frame — never a false "Generation
  finished" while the backend works); **live:false + an open mirror with no
  pending retire** → RETIRE it now and let the folded log take over (the
  missed terminal frame). The refresh-split-in-two (the folded/live seam)
  is dead by construction.

## 8. The clay/chrome surface patterns — ROUND-107 (R107-g), reworked ROUND-108 (R108-e)

The owner's round-107 direction ("Clay Studio aesthetic… a mixture of
liquid chrome") added a cross-cutting pattern family; the owner's
round-108 verdict on its execution ("you implemented clay but it was not
implemented properly… at the very top you implemented some glow fade and
other stuff like that") reworked it. The surviving family lives in
`src/index.css` as classes (so they compose with inline
`backgroundColor`/`boxShadow` — the clay classes paint box-shadow only;
the chrome metal is a background-IMAGE layer), and every color/shadow
they use comes from the `--ac-clay-*` / `--ac-chrome-*` vars (TOKENS §9
+ §8). One spelling each:

| Pattern | Class | What it paints | Where it's allowed |
|---|---|---|---|
| Clay card shadow | `.ac-clay` | the layered clay depth: a tight directional contact shadow under a large very soft ambient one, warm-tinted (TOKENS §9) — box-shadow only, composes with any inline fill | top-level card surfaces: StatCard (dashboard + usage), the TitleBar |
| Clay small shadow | `.ac-clay-sm` | the same recipe's small-surface step (`--ac-clay-shadow-sm`) | compact tiles/chips wanting clay depth |
| **The recessed well (R126)** | `.ac-well` | `surfaceWell` fill + the clay-rim hairline — ONE step DOWN from the card (TOKENS §10) | accordions/activity wells, input fills, skeletons, recent-activity rows — the workhorse recess |
| **The clay rim (R126)** | `.ac-clay-rim` | the warm hairline rim on all four sides (light's default card edge) | any card edge not already carrying `border-clay-rim` |
| **The dark top edge (R126)** | `.ac-clay-edge-dark` | the matte 14%-white top edge — auto-suppressed in light mode by the class itself | dark-mode-only card top edges (mobile AMENDMENT 1) |
| **The pressed leg (R126)** | `.ac-clay-pressed` | the press collapse shadow (contact leg alone) | the active state of clay-primary buttons/cards |
| **The upward leg (R126)** | `.ac-clay-sheet` | the upward two-leg shadow | rising surfaces: toasts, docks, popovers anchored below |
| **The mono block (R126)** | `.ac-mono-block` | the recessed mono surface (fill + border + own ink) | terminal output, command blocks, code tails |
| Platinum ramp | `.ac-chrome-metal` | the full metal surface fill (160° hi→mid→lo ramp) | signature surfaces only — the wizard's hero block |
| Liquid sheen | `.ac-chrome-sheen` | the ambient 9s highlight pass (MOTION §3 `ac-chrome-pass`), its band half as wide + half as bright since R108-e; sets `position:relative; overflow:hidden` itself | signature surfaces only — the wizard's CTAs + hero block; NEVER working-UI buttons |

Deleted in R108-e (the owner's verdict — do NOT resurrect them):
`.ac-clay-light` (the gradient top-light wash) and `.ac-chrome-edge` (the
1px top-edge glint) — painted light over a resting surface reads as a
tacked-on glow, not as a material. The composer's chrome focus glint
(`.composer-shell::before`) died with it: the R105-B accent edge + halo is
the complete focus story.

Composition rules:

1. **Clay = substrate via SHADOW + FORM; chrome = jewelry.** A card's
   clay depth is `.ac-clay` (never a gradient wash or top-light overlay);
   the ANIMATED sheen stays rationed to signature surfaces (MOTION rule 3:
   resting UI never fidgets).
2. **Host contract**: `.ac-clay`/`.ac-clay-sm` have none beyond the host's
   own border/radius (they paint box-shadow only).
   `.ac-chrome-sheen` brings its own relative + overflow:hidden — never
   apply it where children must escape (popovers, popups).
3. **Ink on `.ac-chrome-metal` is `--ac-text`** (TOKENS §8 rule 4).
4. The family is theme-independent BY DESIGN and must stay that way — on
   warm themes (Clay Studio) it reads as hand-thrown ceramics, on cool
   ones as quietly tactile studio material.
5. A new consumer documents itself here in the same round (the §1 rule,
   applied to this family).
