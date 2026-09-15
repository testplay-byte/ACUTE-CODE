<!-- last-reviewed: 2026-09-12 round-98 -->
# ACUTE-CODE — Design Prompt 2: Chat Window Refinements (Round 32)

**Purpose:** the owner's R32 directive — the chat window's bottom area (how the
user sends messages), model selection, and context display "need to be handled
better". This prompt generates those demos; the owner picks the one they like
and the implementing agent builds it.

**How to use:** copy everything between the CUT lines into the design tool as
one prompt. Design in Nova Cream light mode + one dark variant.

---

## ──────────────────── CUT HERE ────────────────────

# Design brief: "Acute" — chat window refinements (composer, model picker, context meter)

You are refining the BOTTOM ZONE of a chat window in "Acute", a premium
local-first AI coding agent desktop app (Windows, 1920×1080). The app's shell
is already designed and loved: a floating warm-sand sidebar rail on the left
(separated by gaps), a floating pure-white chat panel (radius 24, 1.5px border,
soft shadow) on a cream `#FFFBF0` background with a subtle dot grid and soft
orange ambient glows. Your job: design the BEST-IN-CLASS message-composing
experience for the agent chat — the area where the user types, picks a model,
sees context usage, and sends.

Design language (match exactly — from the approved screens):
- Space Grotesk UI font + JetBrains Mono for machine text (paths, models, stats).
- Bento DNA: 1.5px borders, radii 12–18px for controls, generous but airy
  spacing, `#FF6B2C` accent (dark-mode `#FF8F55`), success `#22c55e`,
  danger `#ef4444` only as semantic marks.
- Resting cards: soft shadow `0 8px 32px rgba(0,0,0,0.06)`. Focus states: accent
  border @40% + a 4px accent glow ring.
- Dark mode: chat panel `#2C2C2E` on `#242426` background, warm sidebar
  `#2E2A26`, borders `rgba(255,255,255,0.12)`.
- Playful but professional — a desktop tool that feels alive, never corporate.

## SCREEN A — The composer zone (THE main deliverable)

Show the full bottom ~360px of the chat panel, with the tail of a conversation
above it for context. Design these states as separate frames:

### A1 — Resting (empty composer)
A floating composer card (radius 18, 1.5px border, sits ~12px above the panel's
bottom edge with side padding):
- LEFT: a "+" attach button (36px icon tile, subtle bg).
- CENTER: one-line placeholder `Message Acute…` (13px, tertiary color).
- RIGHT: NOTHING when empty (no send button — it appears when there's text).
- BELOW the card, a slim footer row (~24px): context meter (label `ctx`, 72px
  progress bar, mono `8k / 1M`), keyboard hint chips (`↵ send` `⇧↵ newline`),
  and the model chip (see Screen B).

### A2 — Active (text typed, two lines)
- The card has grown (auto-height, ~2 rows of typed text visible — show
  realistic multi-line text like "Refactor the auth module and add
  a test for the login flow").
- Focus state: accent@40% border + 4px accent glow ring around the card.
- Send button appeared: 36px accent circle with an up-arrow, white icon,
  accent glow shadow, slight scale on hover. Make it feel inviting.

### A3 — Streaming (agent is replying)
- The composer is still visible but visually receded (60% opacity or a subtle
  overlay — user CAN still type a follow-up).
- In place of Send: a red square Stop button (36px, danger bg, white square
  icon) — "stop generation".
- A tiny mono status chip pinned to the card's top-right corner OUTSIDE it:
  `streaming…` in accent.

### A4 — Error state
An inline banner ABOVE the composer card: danger@40% border, danger text with
the exact message, an accent "Retry" pill on the right. Never covers the
conversation.

## SCREEN B — The model picker (replacing the plain text chip)

The current model selector is a bare mono text chip — it needs to become a
proper popover menu. Design it OPEN:

- TRIGGER: a pill in the footer row — small provider dot + mono model name
  (`stealth/ox-alpha`) + chevron. Hover: subtle tint.
- POPOVER (anchored above the pill, radius 16, 1.5px border, soft shadow,
  ~320px wide, max-height ~380px scroll):
  - Header row: "MODEL" micro-label + a mono search field (`filter models…`)
    with a search icon.
  - Model rows (40px): provider dot (colored per provider), model name (bold,
    13px), right-aligned mono meta (`1M ctx`), and a check mark on the active
    one. Group models by provider with tiny section labels (OPENROUTER,
    CUSTOM).
  - Footer row: "Manage models →" text link (accent) that opens settings.
- Also show the POPOVER CLOSED state (just the trigger pill).

## SCREEN C — Context & usage display (the "how full is my brain" zone)

Design the footer row expanded into a proper STATUS STRIP when the user hovers
or clicks the context meter:
- The strip (~32px) shows: a segmented context meter (used vs free, accent
  fill on subtle track), mono `62k / 1M tokens`, a cost-today chip
  (`$0.42 today`), and the model chip.
- WARNING state at >80% full: the meter turns amber with a tiny warning icon
  and the label `context low — older messages will be trimmed`.
- Keep it subtle: this is ambient information, never a dashboard.

## SCREEN D — Everything together (the money shot)

The full chat panel bottom zone in ONE frame: conversation tail (user bubble +
activity card edge + assistant reply edge), the ACTIVE composer (A2 state,
focused), the footer status strip (C), model picker popover OPEN (B) floating
above its trigger. Both LIGHT and DARK variants.

## Variant checklist
1. A1 resting · 2. A2 active-focused · 3. A3 streaming · 4. A4 error
5. B popover open + closed trigger · 6. C status strip normal + warning
7. D everything-together LIGHT (primary) · 8. D DARK variant

## Guardrails
- No glassmorphism, no gradients on controls, no default blue/purple, no emoji
  icons (crisp 1.5–2px stroke icons), no corporate dashboard greys.
- The composer is the hero of this brief — make it feel like a pleasure to
  type into: clear affordances, confident focus states, zero clutter.
- Everything must work at 1440×900 too — show one frame at that size.

## ──────────────────── CUT HERE ────────────────────

---

## Implementation notes (for the agent who receives these designs)

1. The composer already auto-grows (textarea, max 132px) and has the focus
   ring — match the chosen design's exact states (A1–A4). The streaming state
   (A3) needs the composer receded + Stop button (Stop exists; add the
   recede treatment + status chip).
2. Model picker (B): replace ComposerFooter's plain button+list with the
   designed popover (keep fetchProviderModels + the per-send override
   semantics; add the search filter + provider grouping + manage link).
3. Context strip (C): extend ComposerFooter's ctx meter with the warning
   threshold (>80% amber) — usage data already arrives via reply stats.
4. Keep ActivityBlock/panel header from R32 untouched unless the design
   contradicts them.
