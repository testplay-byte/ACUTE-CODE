<!-- last-reviewed: 2026-09-24 round-126 -->
# Screens — the PC archetypes + the navigation grammar

**ROUND-126 (the Clay Companion redesign):** the PC's screen vocabulary,
named once. The mobile constitution has four screen shapes
(`docs/design-language/android/02-patterns/screen-archetypes.md`); the PC
adapts them to a two-pane desktop shell and adds the workspace archetype
the phone doesn't have. Every screen in the app IS one of these five —
a screen that fits none is a design error, not an opportunity.

This file also owns the **navigation model** (how the user moves between
screens) — the redesign's most consequential UX surface. When a wave
touches navigation chrome, this file is the contract.

## 1. The five archetypes

| # | Archetype | PC instances | The shape |
|---|---|---|---|
| 1 | **Shell** | `AppShell` + `Sidebar` + `TitleBar` (always present) | the two-pane frame: left nav (240px / 56px rail), the content pane, the right workspace sidebar. |
| 2 | **Instrument** (mobile "list") | Dashboard, Usage, ProjectView | a vertical instrument: stat row → chart → list sections, ONE scroll, header-free (the R113-d owner directive). |
| 3 | **Workspace** (PC-only) | ProjectChatScreen + RightSidebar | the chat card + the flanking panel column; the resize seam owns the width negotiation; the right sidebar is browser-tabs. |
| 4 | **Hub** (mobile "detail") | SettingsPage (15 sections, 5 groups), the SetupWizard | a nav column (the sidebar becomes the settings nav) + a detail pane; master-detail-lite inside tabs. |
| 5 | **Overlay** | dialogs, popovers, toasts, the ⌘K palette, the OS overlay windows | centered clay cards (scale 0.96→1 on SHEET_SPRING over a 160ms scrim) or anchored dropdowns (origin-top spring); sheets NEVER host forms on PC — a dialog does. |

## 2. The navigation model (R126 — the binding contract)

```
TitleBar (identity = sidebar toggle · window controls)
Sidebar ── Dashboard · Usage · Projects(→ sessions) · bell · Settings
   └─ settings mode: back-pill · search · grouped section nav
Workspace ── chat card ⇄ right sidebar (files/browser/terminal/…)
   └─ ⌘K palette (files/symbols/content) · jump-to-latest · MessageTimeline
```

**The laws:**

1. **The sidebar is THE nav.** Three states (expanded 240px / rail 56px /
   hidden) + the settings mode + the mobile drawer. Every nav destination
   is reachable from it in ONE click; nothing is URL-only (`/demos`'s
   URL-only status is a defect the redesign fixes).
2. **The project row expands/collapses its sessions — nothing else.**
   (R128 decision, reversing the R126 split — the owner's directive:
   "clicking on any of the projects should not automatically switch the
   view to that specific project — it should only expand or collapse the
   sessions of it.") The whole project row is the toggle. Entering a
   conversation is a SESSION row's job. **ROUND-129 (the owner's second
   directive — REWRITTEN): NO ARROWS ON PROJECT ROWS** — the left chevron
   glyph is RETIRED entirely, not merely demoted to a presentation mark
   ("I was shown the arrows on the left sides of each one of the projects,
   which was not good. I told you to remove the arrows"); the expand state
   reads from the session well beneath the row + the row's active/open
   treatment. **Projects are SEPARATED** — a hairline divider + spacing
   between project rows ("so that the projects are separate and they look
   much more cleaner"). **Hover actions SHRINK the text** (R129, reversing
   R128's overlay law): the action cluster occupies RESERVED FLEX WIDTH
   that grows in on hover while the name's truncation TIGHTENS to make
   room — the buttons never OVERLAY the text (the owner: "the text should
   shrink… so that there is enough space for the edit button… and the new
   session button and the delete button"); at rest the name renders FULLY.
   Project rows sit a notch taller than session rows (the project is the
   heavier object). The new-session and delete buttons share ONE quiet
   ghost-button grammar (same size, same hover, same corner — no filled
   accent square beside a bare icon).
3. **Session switching lives in the sidebar's session tree** (per-project)
   — the owner's R49 directive: NO global sessions screen, ever.
4. **The right sidebar is the workspace's tool belt** — browser-style tabs
   (file/files/browser/terminal/subagent/memory/console), keep-alive, the
   "+" quick menu, collapse to the 36px rail. It auto-opens when the agent
   acts on a tool surface (R65 law — the agent shows its work).
5. **The TitleBar identity button toggles the sidebar** (Tauri mode). The
   web-mode floating logo does the same. One spelling, both modes.
6. **Breadcrumbs are forbidden** (mobile donts, adopted): back is the
   ArrowLeft quiet-circle, hierarchy is the sidebar's tree, position is
   the ⌘K palette + the MessageTimeline.
7. **Keyboard parity**: every nav row is a real `<button>`/`<a>` with
   `:focus-visible` (the global ring); ⌘K opens the palette; the sidebar
   rail's hover labels also carry `aria-label`.
8. **Deletes confirm — ROUND-128; ROUND-129 semantics**: deleting a
   session or a project ALWAYS asks first — the danger `ConfirmDialog`
   (cancel takes focus, ESC + outside-click dismiss; the dialog
   enumerates exactly what dies). No sidebar delete is immediate. **The
   R129 delete-materiality law**: deleting a NORMAL project or session
   removes APP RECORDS ONLY — the workspace folder and files on disk are
   NEVER touched, and the dialog SAYS so; only SCRATCHPAD sessions delete
   their own workspace folders with their records (law #9). The
   Scratchpad project itself stays delete-protected.
9. **The Scratchpad — ROUND-129 (rewritten from R128's General
   conversation)**: the no-folder conversation section sits at the very
   BOTTOM of the projects list, SEPARATED from the normal projects by
   space + a hairline + its own "SCRATCHPAD" kicker row (never mixed
   into the project list, never pinned first). It is named **Scratchpad**
   (not "General" — the owner: "it will also not be called general, but
   it will be something else so that it looks proper"). **Every
   Scratchpad session is INDEPENDENT**: each gets its own dedicated
   workspace folder under the sidecar state dir (`<dataDir>/scratchpad/
   <sessionId>/`) — conversations never share or pollute one folder —
   and deleting a Scratchpad session removes its folder with its
   records. The section is seeded by the backend (stable row id),
   delete-protected as a whole, never a folder picker, and carries its
   own "New chat" affordance on the kicker row.

## 3. Archetype recipes (the materials)

### Instrument (Dashboard/Usage/ProjectView)
- Container ladder `max-w-[1280/1480/1640px]` + the graduated gutters; NO
  page header (owner R113-d).
- **The stat row** (R126, mobile stat-grid adapted): ONE clay card,
  2×2-or-4-across cells separated by 1px inset `border-strong` dividers
  (never 4 separate cards), `TypeStat`-tier values (28px mono-medium
  tabular on mobile → PC 22px/600 tabular, TOKENS §2's value tier),
  `label`-tier kickers, `h-[92px]` pinned, no icon chips.
- Sections: `SectionCard` clay cards, `Kicker` headers, 12px row gaps /
  32px section breaks (the mobile rhythm law).
- Charts: hand-rolled SVG, `accentDeep` primary series, `CHART_HUES`
  stable per-entity hues, bars grow on entry (350ms/12ms stagger), the
  anti-jitter kit (COMPONENTS §6) is binding — **and the ROUND-127
  chart-interaction laws (COMPONENTS §6: full-column hit-testing, tooltip
  edge clamping, sparse/hour labeling, scroll-to-latest) are binding on
  every chart, every screen.**
- Empty/loading: skeletons in `bg-well`; empty states are the mobile
  minimal-center shape (one icon tile + one line + one action).
- **THE USAGE PAGE ORDER — ROUND-127 (the owner's walkthrough, binding):**
  (1) the range toolbar; (2) the overview stat row; (3) the activity grid —
  Token Activity at 2-cols + an INSIGHTS RAIL at 1-col (the rail carries
  KEY DETAILS: the window's headline facts — top model + share, peak day,
  cache hit rate, busiest tool — as quiet stat rows, NEVER the tools
  leaderboard); (4) the tools leaderboard as its own full-width hairline
  section BELOW the grid; (5) the Data & Statistics panel (heatmap, model
  mix, model usage donut with the model list BELOW it — the share donut's
  legend IS the individual-usage list, one card); (6) key cards; (7) the
  projects drill-down; (8) THE DANGER ZONE LAST — the page's final
  section, never interleaved mid-page (COMPONENTS §6's danger-zone law
  applies at PAGE scope, not panel scope).
- **THE DASHBOARD BOLDNESS LAW — ROUND-127**: the dashboard leads with
  BOLD display-tier structure — a big display heading row (28–34px/800,
  the workspace's greeting tier returning as a CONTENT heading, not a
  chrome header), the stat row's numbers at display weight, and the
  recent-activity section reads as a TIMELINE (a vertical spine with
  day-glyph nodes and card rows hanging off it — the "bubbles + timeline"
  ask) instead of a flat card list. Minimal surfaces, maximum typographic
  hierarchy; NO new hues, NO new materials — the boldness is scale +
  spacing + rhythm.

### Workspace (chat)
- The chat card (`rounded-2xl` + rim + `.ac-clay`) + the 4px seam + the
  right sidebar column.
- The reading column (max-w-[1080px], graduated padding) + the composer
  dock + the live overlay grammar — §7 of COMPONENTS.md is the binding
  anatomy (R119/R120 owner-approved); R126 re-skins MATERIALS only:
  user bubbles = `mix(card, accent, 0.16)` fill + 0.34 edge (mobile
  recipe), the activity well = `bg-well`, tool rows = the mono grammar on
  `monoText`, live rhythm = the 550ms caret/delivery-edge.
- The composer: one rounded-12 box, the focus-within accent edge + halo,
  the toolbar's non-wrapping action anchor — R125's law stands.

### Hub (Settings/Wizard)
- The sidebar becomes the grouped nav (back-pill → search → sections);
  the content pane is `max-w-4xl` (except the api master-detail tab).
- Rows: `SettingsRow` 36px; cards: `SectionCard`; toggles: the existing
  contrast-aware switch on `accentDeep` track fill.
- The wizard keeps WIZARD-DNA (the theatrical set is its own constitution)
  on clay materials + Manrope.

### Overlay
- Centered dialogs: Radix, `rounded-xl`, the clay card material, scale
  0.96→1 on SHEET_SPRING, 160ms scrim, base transform = end-state.
- Anchored menus: 12px radius, `border-strong`, `.ac-clay-sheet` (the
  upward shadow), origin-top spring, outside-click + Escape, listbox
  semantics.
- Toasts: bottom-right, `--ac-clay-shadow-sheet`, one-liners, 2s +
  newest-replaces (mobile toast law, adopted).

## 4. The R126 screen inventory + wave order

| Screen | Archetype | Wave | Notes |
|---|---|---|---|
| Shell (Sidebar/TitleBar/AppShell) | Shell | 2 (orchestrator) | the frame everything lives in |
| DashboardScreen | Instrument | 3a | stat row → the ONE-card grammar |
| UsageScreen | Instrument | 3b | + leaderboard/details nesting (usage.html reference) |
| ProjectView | Instrument | 3c | thin landing — mostly re-skin |
| ProjectChatScreen | Workspace | 3d | the money screen; §7 anatomy stands |
| RightSidebar + panels | Workspace | 3e | panel chrome + SubAgentPanel de-blue |
| SettingsPage + tabs | Hub | 3f | 15 sections; ModelsProvidersTab is the giant |
| SetupWizard | Hub | 3g | clay materials, theatrical DNA kept |
| Notifications/Toaster/Demos/secondary windows | Overlay | 3h | coherence pass |
