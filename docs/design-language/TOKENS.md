<!-- last-reviewed: 2026-09-15 round-98 -->
# Tokens — the color, type, and spacing language

Serves DESIGN-SYSTEM §1 (source of truth), §2 (spacing), §3 (typography).

## 1. The color pipeline (how a color reaches a pixel)

```
src/lib/themes.ts            THEMES (5 themes × light/dark)
      │  ThemeColors (~20 raw fields)
      ▼
deriveThemeStyles()           ThemeStyles (~35 derived keys:
      │                       bg/card/text/accent/borders/subtles/…)
      ├──►  useThemeStyles()  src/lib/use-theme-styles.ts — the JS hook
      │                       (inline styles for surfaces Tailwind can't reach)
      └──►  syncThemeCssVars()  ~30 `--ac-*` CSS vars on :root
              │
              ▼
     src/index.css  `@theme inline` maps vars → Tailwind utilities
              (bg-card, text-ink, border-line, bg-accent, …)
```

**Rules**

1. NEVER hard-code a hex/rgb in a component. If the pipeline can't express
   it, extend the pipeline (themes.ts) — do not bypass it.
2. Documented exceptions live in exactly four places:
   `src/lib/semantics.ts` (`SEMANTIC_COLORS`: success `#22c55e`, danger
   `#ef4444`, warning `#f59e0b`), the syntax palette
   (`src/components/project-chat/highlight.ts`), the usage-segment
   palette (`src/lib/menu-overlay.ts`), and the MODEL palette
   (`src/components/usage/usage-helpers.ts` — exception #4, round-98 I2:
   12 fixed light/dark hue pairs + the deterministic `modelColor(name,
   isDark)` hash, so the same model name paints the same color on every
   surface; hue identity is the data encoding, so it cannot flow from the
   theme pipeline). Anything else hard-coded is a bug (round-98 C2 hunts
   them).
3. Alpha tints ALWAYS via `withAlpha(color, 0.08–0.13)` from
   `src/components/dashboard/helpers.ts` — never string-suffix hex hacks
   (`#ef44441a` is a violation; round-97 already executed these).
4. **Prefer the CSS-var leg for anything with hover states.** A color that
   must respond to `:hover`, `group-hover`, or transitions belongs on a
   `--ac-*` var / Tailwind utility class — the JS-inline leg cannot express
   pseudo-states (the root cause of the ~90 hand-rolled hover handlers; new
   UI must not add to that count, and touched UI should retire them).

### The `--ac-*` var families (summary)

| Family | Vars | Used for |
|---|---|---|
| Surfaces | `--ac-bg`, `--ac-card`, `--ac-sidebar-bg` | app background, cards, chrome |
| Text | `--ac-text`, `--ac-text-secondary`, `--ac-text-tertiary` | ink hierarchy |
| Accent | `--ac-accent`, `--ac-accent-text`, `--ac-accent-faded`, `--ac-accent-soft` | brand moments, user bubbles, primary buttons |
| Lines | `--ac-border`, `--ac-border-strong`, `--ac-border-subtle` | bento borders, hairlines |
| Subtle | `--ac-subtle`, `--ac-subtle-hover` | quiet fills, hover washes |
| Inputs | `--ac-input-bg`, `--ac-input-border`, `--ac-input-focus-border` | fields, steppers |
| Shadows | `--ac-soft-shadow`, `--ac-bento-shadow` | depth (see MOTION.md for entry motion) |

## 2. The type scale (the canonical ladder)

The app is compact and dense by design (owner round-16 direction). The
scale below is the language; anything else is drift to be retired when
touched:

| Step | Size | Tracking/Case | Role |
|---|---|---|---|
| display | 56–104px | font-black | wizard + greeting moments only (WIZARD-DNA) |
| title | 24px | semibold | page titles (Settings) |
| section | 13px | semibold | card/section headers |
| body | 13px | — | chat prose, default reading size |
| list-mono | 12–12.5px | mono | file lists, models, machine strings |
| label | 11px | uppercase, `tracking-[0.1em]` | section labels, kickers |
| meta | 10px | mono | chips, timestamps, stat suffixes |
| stat | 9.5px | mono | dense stat chips (footers) |

**Rules**: one reading size per surface; hierarchy comes from weight/color
(`text-ink` → `text-secondary` → `text-tertiary`), not from inventing a
9.75px. The chat's text-size ladder (S/M/L, ±12%, `--ac-chat-scale`)
scales the three reading surfaces (.chat-prose/.chat-thinking/
.chat-narration) — never the chrome.

## 3. The spacing scale

| Token | Value | Route |
|---|---|---|
| pad-2 / gap-3 | 2px / 3px | the borderless chat route (panels as surfaces) |
| pad-3, pad-4 | 12px, 16px | normal app routes |
| gap-4 | 16px | dashboard card grids |
| radius-panel | 16px (`rounded-2xl`) | panels/cards; 12px (`rounded-xl`) inner controls |
| handle | 5px | drag strips between chat panels |

**Rules**: paddings step 12→16→24→32→48; never 13/18/22. The transcript's
graduated padding (24→48→64px) is the sanctioned exception for reading
comfort. The chat route stays borderless (surfaces + gaps, no outlines);
every other route keeps the bento card + 1.5px line borders.

## 4. Semantic colors (the only fixed hues)

| Name | Hex | Means |
|---|---|---|
| success | `#22c55e` | completed, healthy, verified |
| warning | `#f59e0b` | wait/attention: retry waits, queued, thinking-loop stops |
| danger | `#ef4444` | failure, destructive, error — `role="alert"` surfaces |

Warning and danger are NEVER interchangeable (round-97 D: a thinking-loop
stop is amber `role="status"`, never red "Generation failed"). Danger tints
via `withAlpha(danger, 0.08–0.1)` for washes; success tints 0.08 for
confirmation glows.
