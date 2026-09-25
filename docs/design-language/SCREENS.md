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
2. **The project row navigates, the chevron expands.** (R126 decision —
   the pre-R126 project row only toggled expansion, forcing users through
   session rows to enter a project.) The row body click opens the
   project's chat; a dedicated chevron hit area toggles the session tree.
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
  anti-jitter kit (COMPONENTS §6) is binding.
- Empty/loading: skeletons in `bg-well`; empty states are the mobile
  minimal-center shape (one icon tile + one line + one action).

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
