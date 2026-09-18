<!-- last-reviewed: 2026-09-18 round-104 -->
# UI design language — the round-100 research memo (why it still reads "AI-generated", and the spec that fixes it)

Task R100-2. Scope: research only — no code changed by this memo. This file is
the input the implementation agents execute from. Companion docs:
`docs/design-language/` (TOKENS / COMPONENTS / MOTION / USAGE / WIZARD-DNA),
`docs/design/DESIGN-SYSTEM.md`.

Owner verdict this round answers: *"The UI currently looks way too bad. It
looks AI-generated. The whole overall UI of the application needs to be
redone. The only UI that is good is the startup page and the setup wizard."*
plus the standing demand: *"do a complete UI overhaul for the chat window for
the agent."*

---

## §A — External research: what "native/quality" means, and what "AI-generated" means

18 web searches + deep reads (sources in §D). The findings below are the
distilled, checkable rules; every claim maps to a URL.

### A1. The anti-slop checklist (what makes UI read "AI-generated")

From the two best sources on the subject — smoothui.dev's "AI Design Slop"
essay and the UI Craft "Anti-slop, demonstrated" gallery (38 detector rules,
8 shown live). The demonstrated slop patterns, each with the detector rule
name:

| # | Slop pattern | Detector rule | ACUTE-CODE today |
|---|---|---|---|
| 1 | Purple/gradient primary buttons | `purple-cyan-gradient` | ActionButton 135° gradient (wizard-only by spec — leaked?) |
| 2 | Bounce/scale on every hover | `animate-bounce` | `hover:scale-105` on Send/Stop/Queue buttons in the composer (A1 #2) |
| 3 | Six identical cards, icon + heading + two lines | `uniform-border-radius`, `emoji-feature-icon` | Dashboard QuickActions / usage StatCard grid |
| 4 | ALL-CAPS section headings | `uppercase-heading` | 100+ uppercase tracked kickers app-wide (see A4 nuance) |
| 5 | Gradient text on metric values | `gradient-text-metric`, `pure-black-text` | Not present (good) |
| 6 | Glassmorphism + neon glow | `glassmorphism-stack`, `no-focus-visible` | Send button `0 2px 10px accent@0.35` glow; TitleBar `backdrop-blur` |
| 7 | Decorative gradient blobs | `left-top-animation` | Wizard ambient (sanctioned); dashboard/usage heroes lean decorative |
| 8 | Colored trend pills where typography would do | `gradient-text-metric` | Status chips are semantic (good) but numerous |
| 9 | Generic "Loading…" text instead of layout skeletons | `setTimeout-animation` | Skeletons exist and mirror layout (good) |
| 10 | `transition-all` everywhere | `transition-all` | Common in Sidebar/composer (`transition-all duration-200`) |
| 11 | `outline-none` without a replacement focus state | `outline-none-no-replacement` | 89 `outline`/`focus` utilities, no global `:focus-visible` rule (A6) |
| 12 | Pixel-radius inconsistency | `pixel-radius-inconsistency` | **7 distinct arbitrary radii in production code** (B1) |
| 13 | Inline `style={{}}` bypassing tokens | `inline-any-style` | **2,227 inline style objects** (B1) |

The meta-finding of the essay: slop is not "bad taste" per se, it is
**polish without judgment** — the statistically-average pattern emitted with
no design-system constraint and no closed critique loop. The fix is exactly
what this repo already attempts (docs/design-language/) — the loop's missing
half is **enforcement** (§C1.6).

### A2. The type ladder is the tell (measured on Linear / Vercel / ElevenLabs / Medusa)

The UI Craft measurement (2120×1143 viewport, rendered DOM walk):

| | Linear | Vercel | ElevenLabs | Medusa | "ours, before" |
|---|---|---|---|---|---|
| distinct font sizes in fold | 9 | 4 | 5 | 4 | 14 |
| sizes below 14px | 4 | 0 | 2 | 2 | 7 |
| display size | 64px | 64px | 48px | 64px | 56px |
| next size used below it | 20px | 24px | 16px | 16px | 44px |
| **the jump** | **3.2×** | **2.7×** | **3.0×** | **4.0×** | **1.27×** |
| display weight | 510 | 450–500 | 400 | 500 | 700 |

Three rules they extracted (all now detector rules, all directly applicable):

1. **The ladder needs a cliff, not a gradient.** 4–9 sizes total; the display
   step is 2.7–4× the next size; nothing in between. A page with twelve
   evenly-spaced sizes has no display type — "slightly bigger text, over and
   over."
2. **Display type is not bold.** None of the four goes above weight 510 on
   its largest type. Big + bold reads like a hurried poster; big + medium
   reads like the size was already enough. Reserve 600–700 for 13–16px labels
   and buttons where weight is the only emphasis available.
3. **Small type is where a page leaks.** Two of the four have ZERO sizes below
   14px; none has more than four.

**ACUTE-CODE's measured ladder (B1):** 34 distinct `text-[Npx]` sizes,
**8 steps below 14px in common use** (9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5 —
plus 8, 8.5, 13.5 stragglers), display steps fine in the wizard but
`font-black`/`font-bold` used **432+ times at 11px or below** in working
screens. This is the single strongest "AI-generated" signal in the codebase:
a crowded ladder + loud weights.

### A3. What the best IDE/dev-tool UIs actually do

**VS Code** (docs + source): Activity bar 48px wide, icon-only, 24px icons;
status bar 22px tall; list rows 22px; UI chrome font 13px **regular weight**
(system UI font — Segoe UI / -apple-system / Ubuntu); side bar default 300px;
settings = search-first (the search box IS the page), rows = label +
description + control at ~compact density, modified rows get a blue dot +
yellow tint. Navigation chrome is regular-weight text — emphasis comes from
the accent **selected-state bar**, never from bold.
Source: code.visualstudio.com API docs (Activity Bar), github.com/microsoft/vscode
issue #52 thread (48px activity bar measurements), stackoverflow font threads.

**JetBrains New UI** (official help page, read in full): goals = "reduce
visual complexity, provide easy access to essential features, progressively
disclose complex functionality." Concrete moves: **Inter font for UI on all
OSs**; a new icon set with "more distinguishable shapes and colors designed
for legibility and visual balance"; **bigger icons with names on hover**
(tooltip-disclosed labels, not visible labels); window-header *widgets*
(project / VCS / run) replacing three separate toolbars; editor tabs get
*more space and a bigger font*; **Compact Mode** = "reduced heights for
toolbars and tool-window headers, scaled-down spacings and paddings, smaller
icons and buttons." The lesson: one system font, one icon family, disclosed
labels, fewer visible containers.

**Zed** (zed.dev + HN threads): three independent font-size knobs (buffer /
UI font / agent panel) — validates ACUTE's `--ac-chat-scale` approach of
scaling reading surfaces independently of chrome. Zed's open issue
(github.com/zed-industries/zeed #53162) is instructive: their chat panel's
weakness is *user and AI messages visually identical* — theme tokens for
message roles were the accepted fix direction. Message-role differentiation
is a known hard surface, not a solved one.

**Linear** (linear.app blog "How we redesigned the Linear UI"): famously
flat, ~9 sizes, display 64px at weight ~510, one accent, neutral ramp with
low chroma, 8px rhythm, hairline borders, no shadows in working surfaces.
The measured table in A2 is Linear's ladder.

**Raycast / Spotlight pattern** (manual + multi.app article): the overlay is
keyboard-first, rows are ~36–40px with 15–16px labels, kbd keycaps for
shortcuts, accent used ONLY for the selected row. ACUTE's CommandPalette
already follows this; the lesson for the rest of the app is "accent marks
selection, not decoration."

**Chat surfaces (Claude desktop / ChatGPT desktop / Cursor / Linear inbox):**
consensus anatomy from the AI-UX pattern guides: a chat interface is six
stacked components — message area, input bar, suggested prompts, status
indicators, header, disclosure surface; user messages read as *input*
(compact, differentiated, often right-aligned or tinted), assistant messages
read as *documents* (full-width, borderless markdown); tool/status rows are
single-line, monospace-annotated, outcome-leading; timestamps are
hover-revealed or day-divided; skeletons must mirror the final layout;
streaming shows a caret, not a spinner. Cursor's context indicator is a
**quiet hover-reveal over the chat header** (forum thread) — context usage is
telemetry, not a billboard.

**GitHub insights patterns:** contribution heatmap = 10–12px cells, 2–3px
gaps, 2px corner radius, 5-step intensity ramp on ONE hue, month labels in
small mono; every number in tables renders tabular. ACUTE's UsageHeatmap
already matches (10px cell, 2px gap, rx 2 — keep).

### A4. Refactoring UI (Wathan & Schoger) — the canonical working rules

Still the best short list of "why this looks designed":
hierarchy is everything (weight + color, not size); **don't use grey text on
colored backgrounds** (reduce the text's contrast toward the bg hue instead);
establish fixed spacing/type scales and don't invent in-between values;
emphasize with font-weight, not color or size; line-height inversely
proportional to font size (13px body → 1.5–1.65; 22px value → 1.0–1.1);
density is a deliberate decision per surface; labels: uppercase + tracking is
ONE idiom, use it consistently or not at all.

### A5. Focus, hover, numbers

- **Focus:** WCAG 2.2 + Red Hat DS: 2px outline with 2px offset (inset rings
  must be > 2px); `:focus-visible` only (not :focus) so mouse users don't get
  rings. Radix maps focus state to the standard pseudo-class — a single
  global CSS rule covers the app.
- **Hover:** every interactive row needs a hover state; the IDE convention is
  a **background wash** (VS Code list hover = 4–6% ink), no movement, no
  scale, 80–120ms.
- **Numbers:** `font-variant-numeric: tabular-nums` on every number that
  updates live or aligns in a column (tables, stats, timers). Already
  partially applied (82 uses) — make it a rule, not a habit.

### A6. Scrollbars, dark mode

ACUTE's floating-pill viewport-adaptive scrollbar (index.css R59/R87) is
genuinely good and matches the "native feel" research (thin, transparent
track, rounded thumb, appears on scroll). Dark-mode rules (atmos.style,
jamesrobinson.io): never pure black; desaturate accents slightly in dark;
prefer borders/lightness over shadows for separation in dark. The theme
pipeline already handles this; keep.

### A7. The "native/quality" checklist (the positive definition)

A desktop dev-tool reads "made by people" when ALL of these hold:

1. One UI font family + one mono family, ≤7 sizes, cliff-shaped ladder.
2. Chrome text at **regular weight**; emphasis = selection state, not bold.
3. One accent color; selection marks it; semantic colors only for meaning.
4. Every radius from a ≤5-step scale; every border from a 2-step scale
   (hairline 1px inside, 1.5px on top-level cards).
5. Every interactive element: hover wash + `:focus-visible` ring + press
   feedback; zero hand-rolled JS hover handlers.
6. Density is IDE-density: 22–32px rows in navigation, 36–44px only in
   forms/wizard.
7. Numbers tabular; mono for machine strings (paths, ids, models, code).
8. Motion = meaning; 80–350ms; resting UI never fidgets.
9. Empty/loading/error states designed per-surface (skeleton mirrors layout).
10. Decoration (glows, gradients, rotations, emoji) appears only where the
    surface's job is delight (first-run, completion) — never in working UI.

---

## §B — Audit of the current app (evidence: file:line)

### B1. The global numbers (the token-application verdict)

Measured with ripgrep over `src/components` + `src/pages` (test files excluded):

| Metric | Count | Meaning |
|---|---|---|
| Hex literals `#rrggbb` | **284** | TOKENS §1 rule 1 ("NEVER hard-code a hex") violated ~280× |
| Arbitrary Tailwind values `[..px]` | **2,567** | sizes bypassing both scales |
| Inline `style={{}}` objects | **2,227** | the JS leg TOKENS §1 rule 4 warns about |
| Hand-rolled `onMouseEnter` hovers | **130** | exactly the anti-pattern TOKENS §1 rule 4 names |
| Distinct `text-[Npx]` sizes | **34** | vs. 8 steps in TOKENS §2 |
| Distinct arbitrary radii | **7** (7,8,9,10,12,14,16 + TW scale + 18,20,22,24 stragglers) | vs. TOKENS §3's 2-step scale |
| `outline`/`focus` utilities | 89 (no global `:focus-visible` rule exists in index.css) | focus is ad hoc |
| `tabular-nums` uses | 82 | partially applied (good habit, make it law) |

**Font-size usage histogram** (the de-facto ladder): `11px`×432, `12px`×217,
`10px`×208, `10.5px`×137, `11.5px`×104, `13px`×90, `9px`×49, `9.5px`×49,
`12.5px`×36, `14px`×25, `16px`×23, `15px`×16, `8px`/`8.5px`/`13.5px`×8,
display sizes in wizard only. Below-10px type outside onboarding: 101
occurrences.

**Arbitrary-value heat, top offenders** (hex + arbitrary TW + inline styles):

| File | hex | arb-TW | inline `style` | Notes |
|---|---|---|---|---|
| settings/ModelsProvidersTab.tsx | 60 | 309 | 211 | worst file in the app |
| pages/SettingsPage.tsx | 4 | 128 | 141 | |
| project-chat/AgentChatPanel.tsx | 10 | 108 | 89 | |
| settings/PromptsTab.tsx | 0 | 116 | 97 | |
| project-chat/WorkingSection.tsx | 3 | 101 | 97 | |
| settings/SubAgentsTab.tsx | 15 | 89 | 71 | |
| shell/Sidebar.tsx | 8 | 79 | 62 | |
| usage/DataStatsPanel.tsx | 0 | 54 | 32 | |

For calibration: onboarding (the PRAISED code) also uses arbitrary values
(WelcomeScreen 81) — so arbitrary values alone are not the crime. The crime
is that **each screen invents its own values**: the same "chip" is 8px radius
in SkillsTab, 10px in ModelsProvidersTab, 16px in SubAgentsTab; the same
"row" is 26/28/40/44px depending on the file.

**Verdict on docs/design-language/: SOUND IN SHAPE, UNAPPLIED IN PRACTICE,
with two token-level defects needing revision** — (1) the type scale itself
sanctions 8 sub-14px steps (9.5/10/11/12/12.5/13 + drift) which guarantees a
crowded ladder even when "followed"; (2) it has no weight discipline (says
nothing about `font-bold`), no radius enforcement beyond panels, no focus
rule, and NO lint gate — USAGE.md §1 step 1 says "grep your diff" but nobody
greps 2,567 values. The system needs §C1's revisions + §C1.6's enforcement,
not a teardown.

### B2. Per-screen audit

#### B2.1 App chrome — `shell/AppShell.tsx`, `shell/TitleBar.tsx`, `shell/Sidebar.tsx`

**AppShell** — FINE. Flat theme bg (R62), `gap-2 p-2` frame, sidebar
visibility logic clean (`AppShell.tsx:96-141`). Keep as-is. Minor:
`FloatingSidebarToggle` pins at magic `top-[18px] left-[18px]` (line 156) —
snap to the frame inset token.

**TitleBar** — the MODEL CITIZEN of the codebase. `WINDOW_CONTROL_BASE`
constants put all hover work on the CSS-var/Tailwind leg
(`TitleBar.tsx:114-138`), 1.5px border, `rounded-[9px]` chips inside a
`rounded-[14px]` bar, per-button hover identity, real aria-labels, press
feedback. Use this file as the reference implementation for the whole app.
Notes: h-10 (40px) bar is on the tall side (VS Code 30–36px); the identity
label `text-[11px] font-semibold tracking-[0.18em]` (`:263`) is loud — drop
to `tracking-[0.08em] font-medium 11px`.

**Sidebar** — the loudest chrome in the app; biggest density offender:
- Rows are `h-11`/`h-10` (40–44px) with `text-[13px] font-bold` labels
  (`Sidebar.tsx:494, 848`) and `rounded-[12px]` — 2× VS Code/JetBrains nav
  density (22–28px rows, 13px regular weight, 4–6px radius). Reads as a
  marketing sidebar, not an IDE one.
- TWO different kicker idioms in one file: `text-[11px] font-bold uppercase
  tracking-widest` (`:485`) vs `text-[10.5px] font-black uppercase
  tracking-[0.14em]` (`:563, 1010`).
- `ProjectTile` = decorative gradient + inner highlight + text-shadow
  (`:99-116`) — the "gradient tile" slop pattern; JetBrains new UI
  deliberately flattened project icons.
- `hover:-translate-y-px` on nav rows (`:899`) — MOTION.md §4 says list-row
  hover = subtle wash, no movement.
- Mixed radii `rounded-[12px]`/`[9px]`/`[6px]` (`:687, 718, 1335`);
  rename field `h-[26px]` row (`:1406`).
- Fine: expanded/collapsed rail logic (270px/64px), session trees, skeleton
  loading, NotificationBell integration, honest empty/error states.

#### B2.2 Chat experience (the owner's #1 target)

Files: `project-chat/AgentChatPanel.tsx` (3,569), `WorkingSection.tsx`
(2,363), `ChatMarkdown.tsx` (1,014), `composer/Composer.tsx` (787),
`ChatFocusLayout.tsx`, `LeftSidebar.tsx`, `ProjectChatScreen.tsx`.

**What is genuinely good (keep — don't re-litigate):**
- Reading column: `max-w-[1080px]` + graduated padding 24→48→64px with
  squish tiers (`AgentChatPanel.tsx:167-168`) — a correct, documented answer.
- Turn anatomy: `AssistantTurnHeader` = 6px dot + mono model chip + hover
  timestamp (`:645-677`); WorkingSection folded header = glyph + "Completed
  N steps · N tools" + duration chip (`WorkingSection.tsx:2115-2212`); tool
  rows h-7 with status→verb→mono-target→summary order (`:1842-1892`).
- The R96-H honesty contract (only real data in status chips), tabular-nums
  on clocks/counts, `ReplyStats` as ONE mono line (`:254-306`).
- State-awareness: `TranscriptSkeleton` mirrors the bubble rhythm (`:684`),
  `ChatLoadErrorCard` (`:712`), auto-collapse of finished work, pinned-scroll
  + jump pill.
- CodeBlock: 12px radius card, lang badge, gutter line numbers, Prism token
  palette (`ChatMarkdown.tsx:89-166`).
- Composer action-anchor layout (Send/Stop/Continue never move,
  `Composer.tsx:597-669`) and the staggered container-query collapse.

**Problems (with evidence):**
1. **Crowded ladder inside one surface:** the reading column renders 9.5px
   (ReplyStats `:301`, attachment chips `AgentChatPanel.tsx:844`), 10px
   (timestamps `:620`, model chip `:666`, code badge), 10.5px (tool counts
   `WorkingSection.tsx:2183, 2196`), 11px (tool verb/args `:1867-1870`),
   11.5px (section header `:2179`, buttons `Composer.tsx:694, 741`), 12px,
   13px prose, 15/13.5/12.5px markdown headings (`ChatMarkdown.tsx:838`).
   Eight sizes under 16px — the measured definition of the slop ladder (A2).
2. **Weight noise:** `font-medium` on user-bubble body (`:826`),
   `font-semibold`/`font-bold` on half the chrome; CodeBlock badge is
   `font-bold uppercase` (`ChatMarkdown.tsx:111`).
3. **Two spellings for the same glyph:** ToolLine renders status as TEXT
   characters `✓ ✗ ◌` (`WorkingSection.tsx:1740, 1856-1860`) while the
   section header 60 lines earlier uses lucide `Check`/`Square` icons
   (`:2174-2177`) — COMPONENTS.md §1's "one spelling" rule broken in-file.
4. **Hand-rolled JS hovers in the hot path:** CopyButton
   (`AgentChatPanel.tsx:237-242`), Revert (`:814-819`), Composer Continue
   (`Composer.tsx:696-697`), ToolLine (`WorkingSection.tsx:1847-1850`).
5. **Decorative glow in working UI:** Send/Queue buttons carry
   `boxShadow: 0 2px 10px accent@0.35` (`Composer.tsx:748, 775`) — the
   "neon glow" slop tell (A1 #6); also `hover:scale-105` on Send/Stop
   (`:714, 741, 769`) — A1 #2.
6. **Radius spray on one surface:** chat window card `rounded-[24px]`
   (`ChatFocusLayout.tsx:192`) + composer `rounded-[18px]` (`Composer.tsx:519`)
   + bubble `rounded-[16px] rounded-br-[5px]` (`AgentChatPanel.tsx:826`) +
   code block 12px + toolbar pills `rounded-xl` — five radii visible at once.
7. **Bubble question:** the accent-tinted user bubble with a 5px tail corner
   is a consumer-messenger idiom; Claude desktop/Cursor treat user input as
   compact input rows. Given the owner's "complete overhaul" mandate this is
   the one structural move worth making (spec §C4).
8. **Focus:** textarea is `outline-none` (`Composer.tsx:587`) with a custom
   box-shadow ring on the CONTAINER (`:528`) — fine — but nothing standardizes
   this; tool rows and nav rows have no focus ring at all.
9. `SEAM_GAP = 3` + `CHAT_MIN_WIDTH = 240` etc. (`ChatFocusLayout.tsx:58-77`)
   are fine physics; keep.

**LeftSidebar (chat-local):** dense and close to right; two kicker idioms
again (`text-[11px]` vs `text-[10px]` `uppercase tracking-[0.1em]`,
`LeftSidebar.tsx:45, 98, 140`); rows fine.

#### B2.3 Settings — `pages/SettingsPage.tsx` + 11 tabs

- **No search.** 13 tabs (`SettingsPage.tsx:85-132`) navigable only via the
  app sidebar's settings group; VS Code/Linear/Raycast settings are
  search-first. For a settings surface with ~100 controls this is the
  biggest UX gap.
- Header: kicker `text-[11px] font-bold uppercase tracking-[0.18em]` +
  `text-[24px] font-black` title (`:158-167`) — working screen wearing the
  wizard's display weight (A2 rule 2: 24px at weight 900).
- **ModelsProvidersTab is the worst file in the app** (B1 table): 77×
  `font-bold`, radii 6/7/8/10/12/14/16/20 in one file, 12 hand-rolled
  hovers, inline `style={{ color: "#ef4444" }}` (`:526`), `h-[19px]`/`h-[18px]`
  magic rows (`:417+`).
- Every tab re-invents rows/cards/chips (PromptsTab 116, SubAgentsTab 104,
  SkillsTab 76, McpTab 75, ImageAnalysisTab 85, ComputerUseTab 47 arbitrary
  values each) — the primitives catalog (COMPONENTS §1) exists but tabs
  don't use it; `ChoiceCard`, `ConfirmDialog`, `SettingsLoadErrorCard`,
  `CommitNumberInput` live only in SettingsPage.tsx and are not exported.
- Good and keepable: the tab model (deep-linkable ids), AppearanceTab's
  ChoiceCard group pattern, danger-zone grammar in the data tab
  (COMPONENTS §6), state-aware load/error cards.

#### B2.4 Usage / dashboard surfaces

- **Wizard costume on working screens:** `UsageScreen.tsx:109-150` renders
  the hero as `clamp(2.75rem, 5.5vw, 4.5rem) font-black` with a `-rotate-1`
  accent box, 2.5px border + `bentoShadow`; `DashboardScreen.tsx:85-90`
  repeats the same recipe. WIZARD-DNA §8's own table says working surfaces
  borrow **"none — quiet focus"** — the docs are right and the code
  disobeys them. This is the exact surface where "AI-generated" is most
  visibly earned: display type + rotation + hard shadow over a data table.
- StatCard: correct anti-jitter kit (pinned `h-[92px]`, tabular value) but
  the hover is a hand-rolled `useState` + `onMouseEnter/Leave` translate
  (`dashboard/StatCard.tsx:33-46`) and the value is `text-[22px] font-black
  tracking-tighter` + `text-[11px] font-bold uppercase tracking-widest`
  label — two louder variants of the sanctioned `stat`/`label` types.
- UsageHeatmap already matches GitHub's geometry (10px cell, 2px gap, rx 2,
  `UsageHeatmap.tsx:11, 29-31, 193-195`) — KEEP, no changes.
- Charts have the stable-palette + reserved-height rules applied (COMPONENTS
  §6) — KEEP.

#### B2.5 Right sidebar (Browser panel & friends)

- `RightSidebar.tsx` is the closest to IDE-correct (tab strip, per-tab
  panels, 11px labels). Type spray present: 9/9.5/10/10.5/11/12/12.5px in
  one file.
- `BrowserPanel.tsx`: toolbar is compact (good) but the address input is
  `w-[118px]` fixed (`BrowserPanel.tsx` grep) instead of flex; no uniform
  toolbar height token (VS Code Simple Browser / JetBrains use a single
  32–36px toolbar grammar with icon buttons + flex address field).
- `SubAgentPanel.tsx` is the noisiest of the family (72 arbitrary values).

#### B2.6 Projects / start screens

- `ProjectView.tsx:106` — `${project.color}CC` hex-suffix alpha hack (TOKENS
  §1 rule 3 names this exact violation); `rounded-[8px]` CTA (`:140`)
  deviates from the pill grammar; otherwise calm and fine.
- `DashboardScreen` — see B2.4; the recent-activity/session list anatomy is
  reasonable; the hero is the problem.
- `onboarding/` — the PRAISED reference. Why it works (extract, don't
  copy): **one column, one job per screen**; inputs `h-12 rounded-[14px]
  border-[1.5px] text-[13px]` with `11px bold uppercase tracking-widest`
  labels (`ConnectionCard.tsx:141-186`); big generous hit targets (h-9
  Paste/Show buttons); STEP badges as accent pills; a single accent;
  deliberate, sparing rotation/glow. It earns its decoration by doing it
  once per screen. The working screens fail because they borrow the
  decoration without the discipline.

#### B2.7 Context meter (composer/ContextDonut.tsx)

The SVG donut with a danger tick at budget (`:400-470`) matches the research
pattern (quiet telemetry, hover-disclosable detail). Keep the geometry;
ensure the numeric label snaps to the 10px mono floor (currently 9.5px
family) and the popup follows the popovers rule (12px radius,
`border-strong`, `bentoShadow`).

---

## §C — The redesign specification

### C1. Token layer (revised — divergences from TOKENS.md marked ⚠)

#### C1.1 Type scale (the cliff) ⚠ revision

| Token | Size / weight / line-height | Use |
|---|---|---|
| `display` | 56–104px / **600** (not 900) / 0.95–1.05 | wizard + empty-state greetings only |
| `title` | 24px / **600** / 1.2 | page titles (Settings, Usage, Dashboard) |
| `section` | 13px / 600 / 1.4 | card + section headers |
| `body` | 13px / **400** / 1.55–1.65 | chat prose, settings descriptions |
| `body-strong` | 13px / 500 | active nav label, emphasized row |
| `ui` | 12px / 400 / 1.4 | secondary chrome, tab labels, toolbar labels |
| `label` | 11px / **500** uppercase / `tracking-[0.08em]` | THE ONE kicker idiom (was 0.1–0.18em, semibold/black) |
| `meta-mono` | 10px / 400 mono / tabular | timestamps, chips, stat lines, model ids |
| `value` | 22px / 600 / 1.0 tabular | StatCard values (was font-black) |

Rules (enforced): **hard floor 10px** (kill 8/8.5/9/9.5px — 101 occurrences
outside onboarding); **no half-pixel steps** (10.5→11, 11.5→12, 12.5→12 or
13, 13.5→13); **≤7 steps visible on any one screen**; markdown headings snap
to 13px/600 (h3) and 12px/600 (h4–h6) — kill 15/13.5/12.5
(`ChatMarkdown.tsx:839-841`). **Weight law: 400 is the default everywhere in
chrome; 500 = active/selected; 600 = section headers, titles, buttons;
700/900 = wizard display only.** `font-bold`/`font-black` outside
`src/components/onboarding/` + StatCard value is a bug (currently 26+
files). Fonts: keep Space Grotesk app-wide (it is the owner-approved
identity, and the wizard proves it), mono stack unchanged. Optional later
experiment (NOT this round): a neutral UI sans for chrome-only at 12–13px if
Space Grotesk's display character still reads quirky at density — decide
after the weight/size cleanup, not before.

#### C1.2 Spacing + density ⚠ revision

4px base grid, 8px rhythm: **4 / 8 / 12 / 16 / 24 / 32 / 48 / 64**. The
TOKENS §3 "pad-2/pad-3 (2px/3px)" chat-route exception is reduced to: seam
gaps 4px (`SEAM_GAP` 3→4, `ChatFocusLayout.tsx:62`). Row heights:

| Surface | Height |
|---|---|
| Sidebar nav row (top-level) | **32px** (was 40/44) |
| Sidebar project row | 30px |
| Sidebar session row | 26px |
| Settings nav row | 30px |
| Settings control row (label+control) | 36px |
| Chat tool row | 26px (was h-7 28 — keep 28 if re-basing costs more than it buys) |
| WorkingSection header | 28px |
| Composer toolbar | 36px |
| Right-sidebar toolbar | 36px |
| Chat turn gap (between turns) | 24px |
| In-turn segment gap | 8px |

Sidebar width 270→**240px** (VS Code 300 is for trees; ours is nav), rail
64→48px (VS Code activity bar standard). Icon sizes: 16px nav/chrome, 14px
toolbar, 12px rows/chips, 11px only inside 20px chips. Every icon button
≥28×28px hit target.

#### C1.3 Color — keep, plus one ramp doc

The pipeline (themes.ts → `--ac-*` → Tailwind) is correct and stays. ONE
accent per theme; semantic 4 (success `#22c55e`, warning `#f59e0b`, danger
`#ef4444`, running `#3b82f6`) stay the only fixed hues. Add to TOKENS.md a
**neutral ramp table** naming the 7 existing steps per mode
(bg / frame / card / subtle / border / border-strong / text-tertiary /
text-secondary / text) so "pick a neutral" is a lookup, not a hex hunt.
Accent discipline: accent marks **selection + the one primary action**;
nothing else in working UI is accent-colored at rest.

#### C1.4 Radius + border + elevation ⚠ revision

Radius scale (5 steps): **4px** inline-code/checkboxes · **8px**
buttons/chips/inputs/toolbar pills · **12px** code blocks, popovers, dialogs,
composer, user message · **16px** cards/panels/the chat window card (was 24)
· **999px** pills. Wizard keeps its 18–24px signature radii as the
documented exception (WIZARD-DNA §4). Kill every arbitrary radius
(`rounded-[7px]`, `[9px]`, `[10px]`, `[14px]`, `[18px]`, `[20px]` — the 40×
in ModelsProvidersTab etc. all snap to the scale).

Borders: **1px hairlines** for dividers/inside-panel/table rows;
**1.5px** only on top-level bento cards (the owner-approved border-forward
look); 2–2.5px wizard-only. Elevation: `softShadow` for floating surfaces;
`bentoShadow` (hard offset) + gradient fills **wizard + primary CTA only**
(WIZARD-DNA §7); remove from UsageScreen/DashboardScreen heroes
(`UsageScreen.tsx:126-138`, `DashboardScreen.tsx:85-90`).

#### C1.5 Interaction states

- **Hover:** every interactive row = `hover:bg-hover` wash (the CSS-var leg),
  80–120ms, no translate/scale. Retire all 130 `onMouseEnter` handlers
  outside onboarding (TitleBar shows the pattern; Sidebar/Composer/
  ModelsProvidersTab hold the violations).
- **Focus:** ONE global rule in index.css:
  `:where(button, a, input, textarea, select, [tabindex]):focus-visible {
  outline: 2px solid var(--ac-accent); outline-offset: 2px; }` — then audit
  the 89 `outline-none` uses to confirm each has a visible replacement.
- **Press:** keep the universal `active:scale-[0.98]` contract; DELETE
  `hover:scale-105` from composer Send/Stop/Queue (`Composer.tsx:714, 741,
  769`) — A1 #2.
- **Selection:** accent text + `bg-accent-soft` + 2px accent bar on the
  leading edge (the provider-list grammar already in COMPONENTS §5 — apply
  it to Sidebar nav + settings nav).

#### C1.6 Enforcement (the loop's missing half) — NEW

1. ESLint `no-restricted-syntax` (or a script like
   `scripts/design-audit.mjs`, same shape as license-audit): fail CI on
   `#[0-9a-fA-F]{6}` in `src/components`/`src/pages` outside the sanctioned
   palettes; on `text-[..px]`/`rounded-[..px]`/`w-[..px]`/`h-[..px]` outside
   a whitelist; on `onMouseEnter` outside onboarding; on `font-black`/
   `font-bold` outside onboarding (value/`section` tiers included by class
   name allowlist). Target after cleanup: **0**.
2. Extract the primitives to `src/components/ui/` and import them
   everywhere: `Kicker`, `StatChip`, `StatusChip`, `IdentityChip`,
   `SectionCard`, `SettingsRow`, `GhostIconButton` (TitleBar's hover
  grammar), `PrimaryButton` (ActionButton's grammar, working-UI variant).
   COMPONENTS §1 already mandates the table — give the rows a home.
3. Update USAGE.md §2 review gates to run the audit script, not "grep your
   diff."

### C2. Per-screen redesign plan (priority order)

**Native-feel checklist every screen must pass** (from A7): 8px rhythm ·
tabular-nums on all numbers · one accent · regular-weight chrome · every
interactive row has hover + focus-visible · radii from the 5-step scale · no
decorative gradients/glows/rotations outside wizard+empty-states · mono for
machine strings · skeleton mirrors layout · ≤7 type sizes visible.

**P0 — Chat window (owner's explicit demand; full spec §C4).**
Moves: type-snap all 9.5/10.5/11.5px chat values to the ladder; lucide
status glyphs; kill Send glow + hover-scale; composer 18→12px radius; chat
card 24→16px; user-bubble redesign (C4.3); retire 4 hand-rolled hovers;
global focus rule covers tool rows.
Stays: content column + graduated padding, turn anatomy, WorkingSection
matrix, CodeBlock, action-anchor composer, scroll behavior, all state cards.

**P1 — Settings.**
Moves: (a) add a settings-local nav column (200px, 30px rows, 12px labels,
regular weight, active = accent bar + soft bg) with a **search box**
filtering tabs and setting labels — VS Code's settings search is the
pattern; the app sidebar keeps only a "Settings" entry pointing here;
(b) `SectionCard` + `SettingsRow` primitives replace per-tab card idioms;
(c) ModelsProvidersTab sweep: radii→8/12/16, 77× font-bold→500/600,
inline `#ef4444`→SEMANTIC_COLORS, 12 hovers→CSS classes, `h-[19px]` rows→28;
(d) page header: kicker → `label` tier (11px/500/0.08em), title stays 24px
but **600 not font-black** (`SettingsPage.tsx:165`).
Stays: tab ids + deep links, ChoiceCard, ConfirmDialog, danger-zone grammar,
state cards.

**P2 — Sidebar.**
Moves: rows 40/44→32px, labels 13px font-bold→**400/500-active**; ONE kicker
idiom (11px/500/0.08em) replacing the 10.5px-black and 11px-bold variants
(`Sidebar.tsx:485, 563, 1010`); ProjectTile → flat project color + 1px
border, no gradient/inner shadow/text-shadow (`:99-116`); kill
`hover:-translate-y-px` (`:899`); active nav = accent bar + soft bg;
sidebar 270→240px, rail 64→48px.
Stays: expanded-projects tree, pixel-stream running animation, bell, honest
empty/error states.

**P3 — Dashboard + Usage heroes.**
Moves: delete the rotated accent-box display hero from both
(`DashboardScreen.tsx:85-90`, `UsageScreen.tsx:124-138`); replace with
`title` 24px/600 + `label` kicker + one-line 13px secondary description;
StatCard: value 22px/**600** (drop font-black + tracking-tighter), label →
`label` tier, hover → CSS class border-strong swap (delete the useState
hover, `StatCard.tsx:38-56`).
Stays: heatmap (already GitHub-spec), chart anti-jitter kit, model palette,
range selector.

**P4 — Right sidebar / browser.**
Moves: one 36px toolbar grammar (icon buttons 28px, flex address input mono
12px — replace `w-[118px]`), tab strip labels 12px/400, type-snap the
9/9.5px stragglers; SubAgentPanel de-noise (72 arbitrary values → scale).
Stays: tab store, popover guard, per-panel anatomy.

**P5 — Projects + misc.**
`ProjectView.tsx:106` `${color}CC` → `withAlpha(color, 0.8)`; CTA
`rounded-[8px]` → pill; TitleBar identity label → 11px/500/0.08em;
AppShell floating toggle → frame-inset token.

### C3. The wizard-DNA boundary (what crosses into working screens)

| Carries over (with the working-UI translation) | Wizard-only (stays in onboarding/empty-states) |
|---|---|
| 1.5px border-forward cards | font-black display type + clamp() heroes |
| Confident `section`/`title` typography (600, not 900) | rotations (`-rotate-1`) + hover counter-rotations |
| `label` kicker idiom (one spelling) | `bentoShadow` hard offsets (except primary CTA) |
| ActionButton grammar = the ONE primary CTA per screen (Settings retry, chat Send) | ambient glows, floats, shine, terminal card |
| Keycaps for shortcuts | 135° gradient fills (CTA may keep solid accent, not gradient) |
| Dot-grid ambient on EMPTY states only (1 glow max) | 22–24px radii; STEP badges; traffic-light dots |
| Stats trio on completion moments | `font-black` anything |

The rule of thumb from the audit: the wizard earns decoration through
scarcity (once per screen, at moments of delight). Working screens must
earn trust through restraint. Every B2.4 violation is this table's right
column appearing on the left's territory.

### C4. Chat window deep spec (workstream-critical — exact measurements)

**C4.1 Layout skeleton (stays, restated as law).**
Chat column = `min-w` 240px floor; window card `rounded-[16px]`
(was 24) + `border-[1.5px]` + `softShadow` (`ChatFocusLayout.tsx:192`);
reading column `max-w-[1080px]`, padding 24px (<768) / 48px (md) / 64px
(xl), squish tiers 16px@≤560 / 10px@≤420 (`AgentChatPanel.tsx:167-168`);
seam gap 4px; drag handle 5px wide with hover reveal (existing).

**C4.2 Turn rhythm.**
24px between turns; 8px between segments (header → work → answer);
`AssistantTurnHeader` 20px tall: 6px accent dot, model chip = mono 10px in
`subtle` bg `rounded-md` px-1.5 py-0.5, truncate 240px; hover timestamp
10px mono tabular right-aligned (all existing — freeze these values; only
snap the 9.5px family to 10px).

**C4.3 User message (the structural move).**
Replace the messenger bubble (`AgentChatPanel.tsx:781-868`) with the
**input-row idiom**: right-aligned block, `max-w min(65%, 640px)`
(was 75%), `rounded-[12px]` uniform (delete the `rounded-br-[5px]` tail),
bg `accent-soft` (9–11% alpha), **1px** border accent@0.18 (not 1.5px),
padding 10px 14px, text 13px/**400** (delete `font-medium`),
`leading-[1.55]`. Attachments strip: chips mono **10px** (was 9.5),
`rounded-[8px]`, gap-1, hairline divider above (existing divider stays).
Hover action row unchanged (timestamp · copy · revert, 24px icons, 28px
targets) — but on the CSS hover leg.

**C4.4 Assistant answer.**
13px/400/1.65 prose; markdown headings snap to 13px/600 (h3) + 12px/600
(h4–h6) — replaces 15/13.5/12.5 (`ChatMarkdown.tsx:839-841`); lists 4px
item gap; inline code `rounded-[4px]` px-1 mono 12px; CodeBlock stays
12px-radius card with 11.5→**12px** mono body, gutter 10px tertiary.

**C4.5 Tool rows + working section.**
Row 28px (keep h-7): [status icon 12px lucide — `CircleCheck` success /
`CircleX` danger / `Loader` amber-in-flight — replacing the text glyphs at
`WorkingSection.tsx:1740, 1856-1860`] + tool icon 11px + verb 11px/500 +
mono target 11px/400 truncate + status chip `meta-mono` + chevron 10px.
Expanded body: `pl-4`, diff/terminal cards `rounded-[8px]` + 1px border.
Section header 28px: lucide glyph + label 11.5→**12px/500** + counts
10px→`meta-mono` + duration chip (mono 10px, subtle bg, `rounded-full`
— existing, freeze). ApprovalRow/QuestionCard keep semantic anatomy.

**C4.6 Composer.**
Container `rounded-[12px]` (was 18) + 1px border (1.5px + `accent@0.4` +
2px ring when focused — one focus idiom shared with the global rule);
textarea 13px/1.5 `px-4 pt-3 pb-1`; toolbar 36px `px-2 pb-2`, pills 28px
`rounded-[8px]`; Send = 28px **circle** (rounded-full), solid accent,
NO box-shadow glow, NO hover-scale — hover = border-strengthen only;
Stop keeps danger fill; Continue keeps secondary pill at 500 weight.

**C4.7 Streaming + scroll + empty states.**
All stay as built: caret-pulse bar, ellipsis pre-delta, line-reveal with
reduced-motion collapse, pinned-scroll + jump pill + keyboard scroll
ownership, chat-shaped skeleton, honest error card, suggestion pill-cards
(12px radius, hover on CSS leg). Empty-state greeting may borrow ONE
wizard element (the dot-grid + single glow — per WIZARD-DNA §8's
empty-state row) — nothing else.

**C4.8 Chat acceptance bar (the "redesign is done when" list).**
1. Zero `onMouseEnter` in project-chat/ 2. zero sub-10px type 3. ≤7 sizes
visible 4. every glyph an icon component 5. radii only 4/8/12/16 6.
Send/Stop have no glow/scale 7. all numbers tabular 8. screenshots at
1920×1080 + tall recorded in docs/ui-iterations/round-100.md.

---

## §D — Sources

**Anti-slop / AI-design quality**
- https://smoothui.dev/blog/ai-design-slop — "AI Design Slop: Why AI-Generated UI Looks Generic — and the Fix" (deep-read)
- https://skills.smoothui.dev/anti-slop — "Anti-slop, demonstrated" — 8 live demos, 38 detector rules (deep-read)
- https://skills.smoothui.dev/blog/type-ladder-is-the-tell — measured type ladders of Linear/Vercel/ElevenLabs/Medusa (deep-read)
- https://prg.sh / https://alexlavaee.me / https://dev.to — corroborating anti-slop lists (search snippets)

**IDE design languages**
- https://www.jetbrains.com/help/idea/new-ui.html — JetBrains New UI rationale, Inter, compact mode, widget header (deep-read)
- https://code.visualstudio.com/api/ux/design-guidelines/activity-bar + https://code.visualstudio.com/docs/debugtest/integrated-browser + https://code.visualstudio.com/docs/editing/getting-started/userinterface — VS Code surfaces
- https://github.com/microsoft/vscode/issues + stackoverflow threads — activity bar 48px / 13px UI font measurements
- https://zed.dev + https://news.ycombinator.com (Zed font-size threads) + https://github.com/zed-industries/zed issue #53162 (agent panel message tokens)
- https://linear.app/blog/how-we-redesigned-the-linear-ui-part-2 (search) + linear.app/method (dark/light pairs)

**Foundations**
- https://refactoringui.com + notes (joelsleppy.com, iamaatoh.com, sglavoie.com, mohitkhare.com) — hierarchy/weight/spacing rules
- https://www.designsystems.com/space/ + 8pt-grid articles (prototypr, uxplanet, breakdance) — spacing scales
- https://ux.redhat.com/focus-indicators + https://www.deque.com/blog/…focus-indicators + MDN :focus-visible — 2px/2px focus law
- https://developer.mozilla.org :font-variant-numeric + https://tailwindcss.com/docs/font-variant-numeric + theosoti.com — tabular-nums
- https://atmos.style/blog/dark-mode-ui-design + jamesrobinson.io dark-mode guide — dark-mode rules
- https://www.aiuxdesign.guide (chat anatomy: six stacked components) + setproduct.com AI chat anatomy + uxcel.com/ethora.com chat best practices (search snippets)
- https://forum.cursor.com (context indicator hover-reveal) + daily.dev (context % misuse) — context meter patterns
- https://www.patternfly.org / pencilandpaper.io / kompassify.com — empty-state anatomy
- https://praveenpuglia.com/make-your-web-apps-look-a-little-more-native + gfor.rest native-feel guide

**Internal (the audited code)** — every file:line in §B; heat metrics from
ripgrep over `src/components` + `src/pages`, test files excluded, at repo
state of round-100 (post-98 commit 418d352 lineage).
