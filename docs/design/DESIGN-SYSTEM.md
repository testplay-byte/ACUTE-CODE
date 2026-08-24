<!-- last-reviewed: 2026-08-24 round-34 -->
# ACUTE-CODE Design System

**Why this document exists (owner direction, round-16/2026-08-23):** "the UI
needs to be thought of properly from the start … proper design logic and a
system which we can follow" — one reference every screen follows, so the app
stays consistent by construction and new features plug in without visual
drift. Owner verdicts supersede anything here; record changes to this file
in the same round that changes the UI.

## 1. Source of truth

- **Colors**: NEVER hard-coded in components. Everything flows from
  `src/lib/themes.ts` (`THEMES` table) through `useThemeStyles()` /
  `deriveThemeStyles()` and the `--ac-*` CSS variables it bridges. Five
  themes (Nova Cream, Bento Blue, Midnight Lab, Sunset Pop, Mono Stone) ×
  light/dark; optional per-theme `accentDark`.
- **Documented exceptions only**: `SEMANTIC_COLORS` (success `#22c55e`,
  danger `#ef4444`) in `src/lib/semantics.ts`; file-type + syntax palettes
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

- **Chat message**: user = accent bubble, right, rounded-2xl rounded-br-md,
  max-w-[85%], hover copy; assistant = card surface + RichText + hover copy
  + **stat chips** (`s · ↑in · ↓out · tok/s · model`); tools = h-7 mono pills
  (icon + 48-char label + ✓/✗ or spinner dots); diff cards = path + size +
  applied/failed dot, click opens the file.
- **Streaming states**: in-flight pill = 3 bounceDot dots; live bubble =
  card + RichText + accent cursor block; "thinking…" mono line before first
  delta.
- **Composer**: pill container (bg token) + attach + input + send (accent
  when non-empty) + footer (`ctx meter · ⌘K hint · model picker`).
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
skeleton rows (Explorer), spinners, NEVER blank flashes. Errors: inline
role=alert with the exact cause + retry; red only via SEMANTIC_COLORS.danger.

## 7. Adding a screen (checklist)

1. Theme tokens only (no hex) · 2. Spacing from §2 · 3. Borderless if it's a
chat surface, carded otherwise · 4. Motion from §4 · 5. Reuse §5 anatomy
before inventing · 6. A11y: roles, labels, keyboard · 7. Screenshots at
1920×1080 + tall 1080×1600, zero console errors, recorded in
`docs/ui-iterations/round-NN.md` · 8. Update this file if anything new was
introduced.
