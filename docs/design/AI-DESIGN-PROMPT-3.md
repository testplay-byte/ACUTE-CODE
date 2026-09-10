<!-- last-reviewed: 2026-09-10 round-83 -->

# ACUTE-CODE — Design Prompt 3: Settings Experience (Round 33)

**Purpose:** the owner's R33 directive — a complete restructure of Settings:
clicking Settings **transforms the sidebar into the settings sidebar** (normal
nav replaced by settings sections), and each settings page renders in the main
area. This prompt generates those demos; the owner picks what they like and the
implementing agent builds it.

**How to use:** copy everything between the CUT lines into the design tool as
one prompt. Design in Nova Cream light mode + one dark variant per screen.

---

## ──────────────────── CUT HERE ────────────────────

# Design brief: "Acute" — the Settings experience (sidebar transformation + 4 pages)

You are designing the SETTINGS experience for "Acute", a premium local-first
AI coding agent desktop app (Windows, 1920×1080). The app shell is already
built and loved: a floating warm-sand sidebar rail (270px, radius 20, subtle
warm tint, 12px gaps on all sides) + a floating pure-white main panel (radius
24, 1.5px border, soft shadow) on a cream `#FFFBF0` background with a subtle
28px dot grid and soft orange ambient glows. A custom logo (rounded-square
orange tile with a geometric white "A") sits at the sidebar's top-left.

Design language (match exactly):
- Space Grotesk UI + JetBrains Mono for machine text (paths, models, keys, stats).
- Bento DNA: 1.5px borders, radii 12–20px for cards / 24px for panels,
  `#FF6B2C` accent (dark `#FF8F55`), success `#22c55e`, danger `#ef4444`
  only as semantic marks.
- Resting cards: soft shadow `0 8px 32px rgba(0,0,0,0.06)`. Focus: accent@40%
  border + 4px accent glow. Solid accent fills for primary actions.
- Dark mode: panel `#2C2C2E` on `#242426`, sidebar `#2E2A26`, borders
  `rgba(255,255,255,0.12)`.
- Playful, crafted, professional — never corporate-grey.

## SCREEN 1 — The sidebar TRANSFORMATION (the core concept)

Two frames side-by-side or sequenced:

### 1a — Normal sidebar → click Settings
Show the normal sidebar (logo top-left + collapse button top-right,
NAVIGATION: Dashboard/Usage, PROJECTS tree, prominent Settings button at the
bottom). Then the TRANSITION: clicking Settings morphs THE SAME floating
sidebar panel into **Settings mode**:
- The logo stays at top-left; next to it appears a bold "Settings" title
  (14px) — or a compact "← Back" affordance (design what feels best: a
  left-arrow icon button beside the logo that exits settings mode and
  restores the normal sidebar).
- NAVIGATION + PROJECTS sections are GONE. The sidebar body becomes the
  settings section list:
  - **Appearance** (icon: sun/moon palette)
  - **Agents** (icon: bot/sparkles)
  - **Models & Providers** (icon: cpu/database)
  - **Advanced** (icon: sliders/wrench)
  - A subtle dashed "More settings coming soon" slot at the bottom (future
    sections will slot in — the design must show the pattern for adding).
- Each settings nav item: 44px row, icon tile (28px, tinted), 13px bold label,
  ACTIVE = accent-tinted fill + 2.5px accent indicator bar on the left edge
  (same active language as session rows).
- The main area (right panel) shows the corresponding settings page (design
  each in Screens 2–5).
- Animate it: sidebar content cross-fades/slides (0.25s, the app's ease).
  Show a mid-transition frame if your tool supports it.

### 1b — Settings sidebar, collapsed rail
The 64px icon-only rail in settings mode: logo, back arrow under it, then the
four section icons, settings-active state = accent tile.

## SCREEN 2 — Appearance page (main panel)

The main panel becomes the Appearance settings page (same floating panel,
radius 24):
- **Page header**: "Appearance" title (24–28px font-black) + one-line
  secondary description.
- **Mode card**: the Light/Dark segmented toggle from the setup wizard (sliding
  indicator pill, Sun/Moon icons) in a card with a "LIVE" badge.
- **Theme grid**: the wizard's theme cards (Nova Cream, Bento Blue, Midnight
  Lab, Sunset Pop, Mono Stone + dashed "coming soon"): each card = name +
  "Aa" accent circle + palette strip + mini app preview, ACTIVE = accent
  border + check chip. 3-across grid.
- **Density card**: Comfortable / Compact segmented toggle (affects paddings).
- **Sidebar tint card**: a small slider or 3-step toggle (Subtle / Warm /
  Bold) showing how strong the sidebar's accent tint is, with a live mini
  preview of the rail.

## SCREEN 3 — Agents page (main panel)

- **Page header**: "Agents" + "New Agent" primary button (accent pill).
- **Agent list**: rows/cards for each agent (the 5 templates — Planner,
  Researcher, Coder, Reviewer, Tester — plus custom agents): avatar tile
  (initial), name, role chip, provider+model mono line, and template/custom
  badge. Hover reveals Edit / Duplicate / Delete icon buttons.
- **Edit Agent view** (design it as the same page with an agent selected, or a
  slide-over — pick the better feel): form with
  - Name + Role (text inputs, 1.5px borders, focus accent ring)
  - System prompt (multi-line textarea, mono, char counter)
  - Provider picker (dropdown) + Model picker (searchable, shows context
    size + pricing per model)
  - Temperature slider (0–1 with value chip) + Max turns stepper
  - Allowed tools: a grid of tool toggle chips (read_file, write_file,
    edit_file, run_command, web_search, …) with on/off states
  - Memory policy segmented control (None / On-start / Every-turn)
  - Save (primary) / Reset (secondary) buttons; a "danger zone" card with
    Delete Agent (danger outline).
- **Empty state**: centered icon tile + "No custom agents yet" + create CTA.

## SCREEN 4 — Models & Providers page (main panel) — THE BIGGEST SCREEN

- **Page header**: "Models & Providers" + **"Add Custom Provider"** primary
  button (accent pill).
- **Provider cards** (stacked or 2-col): one per provider — OpenRouter
  (connected: green dot + "Key stored" mono), Anthropic / OpenAI / Google
  (each with "Add key" ghost state: dashed border, key icon, "No key set"),
  and one CUSTOM provider example ("my-openai-gateway" with base URL shown).
  Each connected card expands (or links) to its model list.
  - Card anatomy: provider logo mark (or initial tile), name, status chip
    (● Connected / ○ No key), masked key line (`sk-…f2a1`), buttons:
    "Test connection" (secondary) + "Manage key" (writes via OS secure
    store — show a small lock icon note "stored in Windows Credential
    Manager").
  - Test connection states: idle → testing (spinner) → success (green check +
    latency chip `212ms`) / failure (danger banner with the exact error).
- **Model list** (under a provider or as the page's second section): rows
  with model name (bold mono), context window chip (`1M ctx`), pricing
  (`$3.50 / $15 per 1M in/out`), toggle "visible in pickers", and per-row
  edit. Include a search field + provider filter chips.
- **Add Custom Provider flow** (design the DIALOG open over the page):
  - Title "Add Custom Provider", fields: Display name, Provider ID
    (auto-slug, mono), Base URL (mono, `https://api.example.com/v1`), API key
    (password field with show/hide eye toggle), Kind selector (OpenAI-compatible
    / Anthropic-compatible), and a "Test connection" button INSIDE the dialog
    that validates before saving.
  - Primary "Add provider" (disabled until valid), secondary "Cancel".
- **Model editor dialog**: add/edit a model row (name, context size, input/
  output cost, notes).

## SCREEN 5 — Advanced page (main panel)

- **Data & storage card**: database location (mono path + "Open folder"
  button), size stats (sessions/events/usage counts in stat chips), WAL mode
  badge.
- **Diagnostics card**: log viewer preview (last lines in a mono block with
  traffic lights), "Export diagnostics" secondary button.
- **Danger zone card** (danger@40% border, tinted bg): "Reset demo data",
  "Delete all sessions" — each with a confirm dialog designed (title, body,
  danger confirm button, cancel).
- **About card**: version, build channel, check-for-updates button, license
  note.

## Variant checklist
1. Screen 1a — normal → settings transformation (LIGHT, primary).
2. Screen 1b — collapsed settings rail.
3. Screen 2 — Appearance page LIGHT (+ one DARK variant).
4. Screen 3 — Agents list + edit view.
5. Screen 4 — Models & Providers with Add Custom Provider dialog OPEN
   (primary) + one DARK variant.
6. Screen 5 — Advanced page.
7. A component sheet ONLY for NEW patterns: settings nav item states,
   provider card (connected/empty), key field, test-connection states,
   tool-toggle chips, danger zone, confirm dialog.

## Guardrails
- No glassmorphism, no gradients on controls, no default blue/purple, no
  emoji icons (crisp 1.5–2px stroke icons), no corporate dashboard greys,
  no hairline 1px borders.
- The sidebar transformation must feel like the SAME panel changing clothes —
  same width, radius, border, position. Only its content swaps.
- Every destructive action has a confirm dialog; every key field is masked
  with a show/hide toggle; secrets NEVER display in full.
- Desktop-first 1920×1080, but show one 1440×900 frame of Screen 4.

## ──────────────────── CUT HERE ────────────────────

---

## Implementation notes (for the agent who receives these designs)

1. Sidebar transformation: a `settingsMode` flag in a store (or route param
   `/settings` + a `sidebarMode` in project-chat-store). The Sidebar renders
   its normal sections OR the settings section list based on it. Main area
   swaps `<Outlet />` for the settings pages (routes: /settings/appearance,
   /settings/agents, /settings/models, /settings/advanced).
2. Existing settings tabs (src/components/settings/*) become the four pages;
   reuse their forms/logic, restyle to the chosen design.
3. Key management already routes through the OS secure store (ADR-0012) — the
   UI only ever sees masked previews.
4. The Add Custom Provider dialog maps to the existing custom-provider
   support (providers registry, OpenAI-compatible kind).
