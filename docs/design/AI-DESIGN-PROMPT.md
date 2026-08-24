<!-- last-reviewed: 2026-08-24 round-33 -->
# ACUTE-CODE — Master AI Design Prompt (Round 31)

**Purpose:** the owner feeds this prompt into an AI-powered design tool to
generate the perfect-looking UI screens. The resulting designs are the new
visual spec for the app shell/sidebar and the agent chat window.

**How to use:** copy everything between the CUT lines below into the design
tool as ONE prompt. If the tool prefers shorter prompts, feed it one SCREEN
section at a time — each screen section is self-contained, but ALWAYS include
Part 1 (design language) with it.

---

## ──────────────────── CUT HERE ────────────────────

# Design brief: "Acute" — a local-first AI coding workbench for Windows

You are designing desktop-app UI screens (1920×1080 primary; also show a
1440×900 variant) for **Acute**, a premium local-first desktop product where
an AI agent chats with you, reads/writes files in your projects, runs
commands, and streams its responses live. Think "the polish of a beautiful
modern SaaS marketing site, but applied to a productive desktop tool" —
playful bento-style cards, bold typography, generous radii, crisp 1.5px
borders, and delightful details. It must feel ALIVE, PREMIUM, and FRIENDLY —
never corporate-boring, never developer-terminal-drab.

## PART 1 — The design language (MANDATORY for every screen)

This language already exists in the product's setup wizard and dashboard
screens, which the owner loves. Match it exactly. The screens you design must
look like they belong to the same product.

### 1.1 Typography
- Font family: **Space Grotesk** (UI) with a mono font (**JetBrains Mono** or
  similar) for anything machine-generated: file paths, model names, stats,
  tool names, code.
- Display headings: `font-weight 900` (black), `letter-spacing -0.03em`,
  `line-height 0.95–1.05`. Hero sizes 56–104px on the wizard; screen titles
  inside the app are 24–32px black-weight.
- Kickers above headings: 12–14px, `font-weight 700`, ALL-CAPS,
  `letter-spacing 0.18em`, secondary color.
- Body text: 13–15px, `font-weight 500`, comfortable 1.5–1.65 line-height.
- Micro-labels (section headers): 11px, bold, ALL-CAPS, `letter-spacing
  0.08–0.1em`, tertiary color.
- Mono meta-chips: 10–11px mono, used for stats, models, paths.

### 1.2 Color system (theme-driven — design in "Nova Cream" theme, show ONE screen in dark mode too)
The app is fully themeable; 5 themes ship (Nova Cream, Bento Blue, Midnight
Lab, Sunset Pop, Mono Stone), each with light + dark modes. **Design primarily
in Nova Cream light mode**, and include ONE variant of the main screen in
Nova Cream dark mode to prove the language works in both.

Nova Cream palette:
- Page background (light): warm cream `#FFFBF0`; (dark): `#242426`
- Card surface (light): pure white `#FFFFFF`; (dark): `#2C2C2E`
- Accent: vivid orange `#FF6B2C` (dark mode accent `#FF8F55`)
- Accent-2 (secondary tint): `#FFD9C0`
- Primary text (light): `#111111`; (dark): `#FFFBF0`
- Secondary text: ~60% opacity of primary; tertiary: ~40%
- Borders: 1.5px lines — light `rgba(0,0,0,0.10–0.18)`, dark
  `rgba(255,255,255,0.10–0.18)`
- Success `#22c55e`, danger `#ef4444` — used ONLY as status dots/semantic marks
- Accent is used GENEROUSLY but tastefully: icon tiles, active states,
  highlight boxes, CTA buttons, the streaming cursor, selected-session markers.

### 1.3 Shape, borders, shadows — the "bento" DNA
- Radii ladder: cards/panels 20–28px; inner controls 12–16px; pills/badges
  full-round; code windows 18–24px.
- **Every card has a crisp 1.5px border** (never 1px hairlines, never
  borderless-floating).
- Two shadow styles, used consistently:
  - `softShadow`: `0 8px 32px rgba(0,0,0,0.06), 0 2px 8px rgba(0,0,0,0.04)`
    — resting cards.
  - `bentoShadow`: solid offset `4px 4px 0px 0px black` (light) /
    `rgba(255,255,255,0.08)` (dark) — hero elements, accent boxes, primary
    buttons, floating emphasis cards. This chunky offset shadow is a SIGNATURE
    of the product.
- Playful tilts: key emphasis elements rotate -1° to -1.5° (highlight boxes,
  tip cards, badges). Cards lift -2px on hover. Subtle, not chaotic.

### 1.4 Texture & ambience
- Full-bleed page background gets a **dot grid**: 1px dots, 28×28px spacing,
  4% opacity (black dots in light mode, white in dark).
- 2–3 large ambient accent glows: blurred circles (70–90px blur, 6–20%
  opacity accent color) anchored to corners.
- Code/terminal windows use macOS traffic lights (12px dots: `#FF5F56`
  `#FFBD2E` `#28C840`) in the title bar.

### 1.5 Components vocabulary (reuse across screens)
- **Icon tile**: 36–48px square, radius 12–14px, solid accent (or tinted)
  background, bold icon inside. Used for stat cards, empty states, tool cards.
- **Pill badge**: full-round, 10–12px bold text; variants: neutral (subtle bg
  + border), accent (solid accent + contrast text), outline.
- **Stat chip**: mono 10px, subtle bg, e.g. `6.8s · ↑3.5k · ↓210 · 31 tok/s`.
- **Primary button**: full-round pill, solid accent, contrast text, chunky
  border, bentoShadow, hover scale 1.02 / active 0.98; often contains a small
  circular arrow chip on the right.
- **Secondary button**: card bg, 1.5px border, softShadow.
- **Mode/segmented toggle**: pill track with a sliding indicator card inside.
- **Tip card**: accent-colored bar, slight rotation, bold text + icon.
- **Kbd hint**: small bordered chip (`Enter`, `⌘K`).

### 1.6 Motion feel (design the states; note transitions)
- Ease curve: confident `cubic-bezier(0.25, 0.1, 0.25, 1)`, 0.2–0.35s.
- Elements enter with a small rise (12px) + fade; hover lifts -2px; dropdowns
  scale from 0.97. Streaming text has a blinking block caret (7×14px accent).
- NOTHING bounces or loops except: thinking dots, the pulsing agent avatar
  while streaming, and a small "live" pulse dot.

---

## PART 2 — SCREEN 1: App shell + Sidebar ("the rail")

**Format:** full 1920×1080 desktop frame. The sidebar on the left; the rest is
the content area (show a blurred/greyed dashboard inside it — this screen is
about the SIDEBAR itself). Also deliver the **collapsed rail** state (64px
wide, icon tiles only) and the **dark mode** variant.

### 2.1 Layout & container
- The sidebar is a floating rounded panel: 270px wide, radius 20px, 1.5px
  border, ~12px gap from the window edge, its own surface. It must feel like a
  distinct, crafted object — NOT a flat admin rail. Give it a subtly tinted
  background (accent mixed ~10–14% into the page background: warm sand in
  light mode, warm charcoal in dark) so it's clearly separated from the main
  content, plus a slightly stronger border than inner cards.
- Top of sidebar: NO logo, NO app name (owner directive). First element is a
  compact icon button (only on chat screens): a "hamburger" that collapses the
  sidebar.

### 2.2 Navigation section
- Section header: "NAVIGATION" — 11px bold tracked tertiary label.
- Two nav items: **Dashboard** (icon: layout-dashboard) and **Usage** (icon:
  bar-chart). Each: 40px tall, radius 12px, 13px bold label + 16px icon;
  hover = subtle tint fill; ACTIVE = solid accent fill + contrast text + soft
  accent glow (`0 2px 8px accent@30%`).

### 2.3 Projects section (the heart of the rail)
- Section header row: "PROJECTS" label + a small accent "+ Add" pill-button
  on the right.
- Each project is an expandable row (44px tall): a 32px colored avatar tile
  (radius 10px, project color, project initial), 12px bold project name, a
  small session-count chip (mono 9px, subtle pill), and a chevron that
  rotates 90° when expanded. Hover reveals a small trash icon (delete
  project). Active project row: accent-tinted fill + 1.5px accent@40% border.
- Expanded project reveals an indented session list (left guide line, 1.5px):
  - Each session row (28px): 10px message-square icon, 11px session title,
    hover tint, hover-reveal trash icon.
    - The ACTIVE session: accent-tinted fill, bold text, and a 2.5px accent
      indicator bar on the left edge. It must be unmistakable.
  - A "+ New Session" row at the bottom of each project's sessions (accent
    text + plus icon).
- Populate with realistic data: project "aurora-app" (indigo tile, 3
  sessions), project "portfolio" (amber tile, 1 session), and one empty-state
  variant with a dashed "Add your first project" card.
- The whole projects area scrolls with a thin custom scrollbar; show ~6px
  bottom fade.

### 2.4 Footer section
- Divider, then **Settings** nav item (same style as navigation items), then
  a collapse-toggle button (chevrons-left icon) that shrinks the rail to the
  64px icon-tile state.

---

## PART 3 — SCREEN 2: Agent chat window — EMPTY STATE

**Format:** the chat surface alone (the main panel of the app, ~800px wide,
centered-left within the content area with breathing room on the right; the
sidebar from Screen 1 is visible on the left edge for context).

This is the FIRST-RUN feeling of a chat with the agent. It must feel
welcoming, premium, and make you want to type.

- **Top bar** (56px, card surface, bottom border): back arrow, project name
  ("aurora-app" in bold), an agent chip (avatar dot + "Acute" + chevron —
  it's a picker), a mono model chip (`stealth/ox-alpha`), on the right: a
  search icon (⌘K), a Sun/Moon theme toggle, and a "Show panels" pill button.
- **Hero empty state** (vertically centered):
  - Large icon tile: 56–64px, radius 18px, accent-tinted background, accent
    sparkles icon, soft accent glow behind it (24px blur, 18% opacity).
  - Headline: 22–26px font-black: **"How can I help with aurora-app?"**
  - Sub-line: 12–13px secondary mono-ish: `Acute · stealth/ox-alpha ·
    streaming replies with live tool calls`.
  - **Suggestion chips row** (wrap, max ~2 rows): 4 pill buttons with small
    accent icons: "Explore this project" (folder icon), "Find a bug" (search),
    "Explain the architecture" (git-branch), "Write a plan" (list-checks).
    Each chip: 36px tall, card bg, 1.5px border, hover = accent@50% border +
    lift. These pre-fill the composer.
- **Composer** pinned at the bottom (see 4.5 for full anatomy) + a slim
  footer row beneath it: a tiny context meter (`ctx 8k / 1M` with a 64px
  progress bar), "↵ to send ·⇧↵ newline" hint, and a model picker chip.

---

## PART 4 — SCREEN 3: Agent chat window — MID-TASK with live tool activity (THE MOST IMPORTANT SCREEN)

**Format:** same chat surface, 1920×1080. This shows a REAL agentic turn in
progress: the user asked *"Add a dark-mode toggle to the settings page"*, and
the agent is executing — it has already thought, run several tools across TWO
rounds, and is currently streaming its final answer. Design EVERY element
below; this screen is the centerpiece of the whole brief.

### 4.1 Conversation column structure
The chat column is a single readable width (~720–800px) aligned LEFT-CENTER
of the panel with comfortable outer padding. Messages stack with 14–16px
gaps. Scroll fade at the top edge.

### 4.2 User message
- Right-aligned accent bubble: radius 16px with the bottom-right corner
  pinched to 6px, solid accent bg, contrast text, 13px, max-width 75%.
- Hover reveals a small copy icon outside the bubble (left of it).

### 4.3 Agent "activity block" (NEW — the tool visualization system the owner wants)
Between the user message and the final streamed answer, the agent's work
appears as **a collapsible activity timeline** — its own card, visually
DISTINCT from chat bubbles (this is machine work, not conversation):

- **Activity card**: card surface, 1.5px border, radius 16px, softShadow.
  Header row (36px): a small agent avatar tile (24px, accent-tinted, sparkles
  icon), the label **"Working…"** (12px bold) while running / **"Completed 14
  actions · 2 rounds"** when done, a tiny elapsed-time mono chip (`32s`), and
  a chevron to collapse/expand the whole block. While running, the avatar
  pulses softly.
- Inside, a **vertical timeline** (2px guide line on the left, accent-colored
  segments):
  1. **Round label row**: tiny pill "ROUND 1" (mono 9px, subtle) — the agent
     works in multiple rounds; each round is a labeled group.
  2. **Tool rows** (each 32–36px): tool icon (12px, in a tiny 22px tinted
     square), mono tool name + short arg summary (`read_file
     package.json`), right-side status (spinner dots while running → green ✓
     / red ✗ when done), and hover-reveal chevron if the tool produced
     output.
  3. **File-change rows get UPGRADED treatment** (the owner's explicit
     complaint — file writes/creates must be shown properly): when the agent
     writes/creates/edits a file, the row expands into a **file-change card**:
     - Header: file-type icon with its color, mono file path, a diff-stat
       chip (`+42 −8` — green/red numbers), and an "Open file" pill button.
     - Body (expandable): a real **unified diff view** — line numbers, red
       `-` removed lines with a 6% red row tint, green `+` added lines with a
       6% green row tint, mono 11.5px, max-height ~320px with internal
       scroll. A small header strip shows the filename + "Diff" label.
     - While the file change is IN FLIGHT: the diff lines stream in with the
       same blinking caret, and a "writing…" label.
  4. **Command runs** (run_command): a mini terminal card — dark title bar
     with traffic lights + mono command, then 2–4 lines of output in a mono
     block, exit-code chip (`exit 0` green).
  5. **Web actions** (web_search / web_fetch): a compact row with a globe
     icon, the query/URL (truncated mono), and a result-count chip.
  6. **Between rounds**: a subtle "thinking" divider row — 24px avatar chip +
     animated ellipsis + mono label `planning next round…`.
- The whole activity block is **customizable**: show a small settings-icon
  popover in its header with options (radio pills): "Detailed · Compact ·
  Hidden" — design the popover open with "Detailed" selected.

### 4.4 Streaming assistant message (final answer, in progress)
- Same anatomy as a completed assistant message (4.6) but: avatar tile pulses,
  a tiny `streaming…` mono label in accent sits next to the agent name, and
  the text ends with the 7×14px blinking accent block caret. Show ~3 lines of
  markdown answer already rendered (with one `inline code` chip visible) and
  the caret mid-word.
- While the model thinks BEFORE any text (also design this state): a lone
  row — pulsing avatar + `Thinking` + animated 3-dot ellipsis.

### 4.5 Composer (bottom, pinned)
- Container: card surface, radius 18px, 1.5px border, focus state = accent@40%
  border + soft accent glow. Comfortable padding (8–10px).
- Inside left→right: a small "+" attach button (icon tile, 36px); the growing
  textarea (13px, placeholder `Message Acute…`, show it with 2 lines of typed
  text so the multi-line affordance is visible); right side: a red square-stop
  button (when streaming) OR the send button — a 36px accent circle with an
  up-arrow, accent glow shadow when enabled.
- Beneath the container: the slim footer row — context meter (`ctx 62k / 1M`,
  64px accent progress bar), keyboard hint chips (`↵ send` `⇧↵ newline`), and
  the model-picker chip (mono, chevron).

### 4.6 Completed assistant message (earlier in the same conversation, for contrast)
- LEFT-aligned, NOT in a bubble: a 28px agent avatar tile (accent-tinted,
  sparkles icon) + name row ("Acute", 12px bold), then the answer text
  directly on the panel surface (13px, 1.65 line-height, markdown rendered:
  one bold span + one inline-code chip). Beneath: the hover-only copy icon +
  stat chips row: `4.2s · ↑6.1k · ↓402 · 96 tok/s · stealth/ox-alpha`.

### 4.7 Error state (also design)
An inline banner variant: danger@40% border, danger text, the exact message
(`no API key for provider 'openrouter' — set ACUTE_PROVIDER_OPENROUTER in the
sidecar environment`), and an accent "Retry" text-button on the right. It sits
just above the composer, never covering the conversation.

---

## PART 5 — Variant checklist (deliver each as a labeled frame)

1. Screen 1 — App shell + sidebar, expanded, Nova Cream LIGHT (primary).
2. Screen 1 — collapsed 64px rail variant.
3. Screen 1 — Nova Cream DARK variant.
4. Screen 2 — Chat empty state, LIGHT.
5. Screen 3 — Chat mid-task with activity block, LIGHT (primary; the money
   screen).
6. Screen 3 — DARK variant.
7. Component sheet: the anatomy pieces at 2× — user bubble, assistant row,
   activity card (collapsed + expanded), file-change diff card, command
   terminal card, composer (empty + multiline + streaming-with-stop), session
   row states (default/hover/active), project row (collapsed/expanded), nav
   item (default/hover/active), pills/chips, primary/secondary buttons.

## Style guardrails (do NOT do these)
- No corporate dashboard greys, no flat admin-panel look, no 1px hairline
  borders, no default blue, no purple gradients, no glassmorphism blur cards,
  no emoji as icons (use crisp stroke icons, 1.5–2px stroke), no dense
  data-table aesthetics. Keep it: warm, bento, bold, crafted, friendly.
- Everything must remain information-dense but AIRY — this is a professional
  tool. Density comes from the timeline/diff components, not from tight
  spacing.

## ──────────────────── CUT HERE ────────────────────

---

## After the designs come back (for the implementing agent)

1. Owner shares exported screens (PNG/Figma) → save to
   `design/redesigns/round-31/` in the repo.
2. Extract concrete tokens/measurements from the designs into
   `docs/design/DESIGN-SYSTEM.md` §5 anatomy updates (append, don't rewrite).
3. Implement in this order: sidebar (smaller, self-contained) → chat activity
   block + diff cards (the owner's biggest complaint) → empty state →
   composer → top bar. Each step: lint/typecheck/test/build + live browser
   battery + VLM screenshot verification vs the reference design.
4. The tool-activity redesign will need `toProjectChatItems()` (api.ts) to
   group tool events into rounds — the backend already records everything
   needed (event log with types + seqs).
5. Do not change backend behavior this round — it's a visual layer pass.
