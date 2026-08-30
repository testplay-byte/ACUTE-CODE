<!-- last-reviewed: 2026-08-30 round-54 -->

# ACUTE-CODE — Design Prompt 4: The Settings Pages (Round 35)

**Purpose:** the owner's R35 directive — a highly detailed prompt covering
EVERY settings page so the owner can generate complete UI demos and hand them
back for implementation. This supersedes Design Prompt 3's page sections with
deeper, element-complete specs.

**How to use:** copy everything between the CUT lines into the design tool as
one prompt. Design in Nova Cream light mode + one dark variant per screen.

---

## ──────────────────── CUT HERE ────────────────────

# Design brief: "Acute" — the Settings pages (Appearance · Agents · Models & Providers · Advanced)

You are designing the SETTINGS experience for "Acute", a premium local-first
AI coding agent desktop app for Windows (1920×1080 primary, 1440×900
secondary). The app shell already exists and is loved:

- A floating warm-sand sidebar rail (270px, radius 20, subtle warm tint,
  12px gaps on all sides) with the app logo (rounded orange tile, white "A")
  top-left and a collapse button beside it.
- A floating pure-white main panel (radius 24, 1.5px border, soft shadow
  `0 8px 32px rgba(0,0,0,0.06)`) on a cream `#FFFBF0` background with a
  subtle 28px dot grid + soft orange ambient glows.
- When Settings opens, THE SIDEBAR TRANSFORMS into the settings nav: back
  arrow + "Settings" title beside the logo, then four section rows
  (Appearance / Agents / Models & Providers / Advanced) with icon tiles,
  active = accent tint + 2.5px left indicator bar, and a dashed
  "More settings coming soon" slot at the bottom.

Design language (match exactly — established across the app):
- **Space Grotesk** UI font + **JetBrains Mono** for machine text (paths,
  models, keys, stats, code).
- Bento DNA: crisp **1.5px borders**, radii 12–16px for cards / 24px for
  panels, solid `#FF6B2C` accent (dark-mode `#FF8F55`), success `#22c55e`,
  danger `#ef4444` only as semantic marks. Resting cards: soft shadow;
  focus: accent@40% border + 4px accent glow; primary buttons: solid accent.
- Dark mode: panel `#2C2C2E` on `#242426`, sidebar `#2E2A26`, borders
  `rgba(255,255,255,0.12)`.
- Micro-labels: 10–11px bold uppercase tracked tertiary; page titles:
  24–28px font-black; body 13px/500.

## SHARED PAGE STRUCTURE (every settings page)

Each page renders in the main panel with this exact skeleton:
1. **Page header block** (no top navigation bar — the sidebar is the nav):
   kicker "SETTINGS" (11px tracked tertiary) · page title (26px font-black) ·
   one-line description (13px secondary).
2. **Back-to-dashboard row** (owner-specified placement): a ghost pill button
   "← Back to dashboard" directly BELOW the header block and ABOVE the page
   content — left-aligned, subtle border, hover tint. This is the only
   navigation affordance in the content area.
3. **Content zone**: cards stacked with 16px gaps, max-width ~860px,
   left-aligned within the panel padding (24–32px).

## SCREEN A — Appearance

Cards in order:
1. **Interface Mode**: segmented Light/Dark toggle (sliding indicator,
   Sun/Moon icons, 320px) + "Changes apply live" hint.
2. **Theme**: 3-across grid of theme cards (Nova Cream, Bento Blue, Midnight
   Lab, Sunset Pop, Mono Stone + dashed "coming soon"): each = "Aa" accent
   circle + name + palette strip + mini app preview; ACTIVE = accent border +
   check chip.
3. **Density**: Comfortable/Compact segmented (drives chat padding) + hint.
4. **Sidebar Tint**: Subtle/Warm/Bold segmented + LIVE mini-rail preview
   (a 104×112px preview box showing the resulting sidebar surface).
5. **Tool Calls (NEW)**: how agent tool activity renders in the chat —
   three selectable option cards side by side:
   - **Detailed** — "Full timeline with diffs and command output"
   - **Compact** — "One-line summary per turn"
   - **Hidden** — "Never show tool activity"
   Selected card = accent border + tinted bg + radio dot. Include a tiny
   inline mock of each mode inside its card (3-row sketch).

## SCREEN B — Agents

1. **Header row**: "New Agent" primary button (accent pill) + a search field
   ("filter agents…").
2. **Agent list**: rows (56px) — avatar tile (initial, colored), name (bold),
   role chip, provider·model mono line, template/custom badge; hover reveals
   Edit / Duplicate / Delete icon buttons. Template rows show a lock icon
   instead of delete.
3. **Agent editor** (slide-over from the right or inline selection — design
   the better-feeling one):
   - Name + Role (text inputs)
   - System prompt (mono textarea, char counter, 8 rows)
   - Provider picker (dropdown) + Model picker (searchable list with context
     window + price per model)
   - Temperature slider (0–1, value chip) + Max turns stepper
   - Allowed tools: a WRAP GRID of toggle chips (read_file, write_file,
   edit_file, create_dir, delete_file, list_dir, search_files, search_code,
   run_command, git_status, git_diff, git_log, todo_write, web_search,
   web_fetch, index_project) — on = accent fill, off = outline
   - Memory policy segmented (None / On-start / Every-turn)
   - Save (primary) / Reset (secondary) + a danger-zone Delete card
4. **Empty state**: icon tile + "No custom agents yet" + create CTA.

## SCREEN C — Models & Providers (master-detail, the owner-approved layout)

- LEFT (~300px) rounded card: the provider list — "PROVIDERS" group
  (OpenRouter, Anthropic, OpenAI, Google — globe icon rows, green/grey
  status dots for key stored) + "CUSTOM PROVIDERS" group + "+ Add provider"
  accent button pinned at the bottom.
- RIGHT (~70%): the selected provider's detail:
  - Header card: name (click-to-rename with pencil) + Enabled badge +
    Disable/Enable + trash (custom only; built-ins show a lock note).
  - Connection card: Base URL (mono input + Save), API format select
    (OpenAI-compatible), API key (password + eye toggle + "Save key", status
    line, "Stored in the OS secure store — never in the database or logs"),
    Test connection button with states: idle → testing (spinner) →
    "✓ Connected · 212ms" / danger error message.
  - Models card: "MODELS (N)" + "+ Add model"; rows = model name (mono),
    context chip ("1M ctx"), price ("$3.50/$15 per 1M"), per-row
    edit/delete; inline add form (model id + display name).
- **Add provider flow**: selecting "+ Add provider" shows a DRAFT row in the
  list + a new-provider form pane on the right (name, Base URL, optional API
  key with eye toggle, "Add provider" primary) — no modal.

## SCREEN D — Advanced

Cards in order:
1. **Data & Storage**: database location (mono path + "Open folder"
   button), stat chips (sessions / events / usage rows / DB size), WAL badge.
2. **Diagnostics**: log preview (mono block with traffic lights, last ~8
   lines) + "Export diagnostics" secondary button.
3. **Danger Zone** (danger@40% border, tinted bg): "Reset demo data" and
   "Delete all sessions" — each opens a confirm dialog (title, body, danger
   confirm, cancel).
4. **About**: version + build channel + "Check for updates" + license note.

## Variant checklist
1. A Appearance LIGHT (primary) · 2. A DARK · 3. B Agents list LIGHT ·
4. B agent editor open · 5. C master-detail LIGHT (primary) · 6. C DARK ·
7. C add-provider draft · 8. D Advanced LIGHT · 9. One 1440×900 frame (C).

## Guardrails
- No glassmorphism, no gradients on controls, no default blue/purple, no
  emoji icons (crisp 1.5–2px stroke icons), no corporate dashboard greys, no
  1px hairlines.
- Every destructive action has a confirm dialog; every key field is masked
  with a show/hide eye; secrets never display in full.
- The back-to-dashboard pill sits BELOW the header, ABOVE the content on
  every page.

## ──────────────────── CUT HERE ────────────────────

---

## Implementation notes (for the agent receiving these designs)

1. The current pages already implement much of this (R34/R35) — treat the
   owner's chosen demos as the target anatomy and adjust spacing/elements
   to match exactly.
2. Tool Calls card (Screen A.5) is implemented in R35 wired to
   theme-store `activityMode`.
3. The back button placement (below header, above content) shipped in R35.
