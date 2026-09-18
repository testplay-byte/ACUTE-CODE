<!-- last-reviewed: 2026-09-18 round-107 -->
# Tokens — the color, type, and spacing language

Serves DESIGN-SYSTEM §1 (source of truth), §2 (spacing), §3 (typography).
ROUND-100 (R100-C): revised per research §C1
(`docs/research/ui-design-language-round-100.md`) — the token system was
sound-but-unapplied with two token-level defects (a crowded type ladder
with no weight law, and no radius/border enforcement). Every revision
below is marked **ROUND-100 (R100-C)** and is enforced by
`scripts/design-audit.mjs` (`pnpm design:audit` — see USAGE §2).

## 1. The color pipeline (how a color reaches a pixel)

```
src/lib/themes.ts            THEMES (6 themes × light/dark)
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
   them; R100-C's audit rule R1 counts them).
3. Alpha tints ALWAYS via `withAlpha(color, 0.08–0.13)` from
   `src/components/dashboard/helpers.ts` — never string-suffix hex hacks
   (`#ef44441a` is a violation; round-97 already executed these).
4. **Prefer the CSS-var leg for anything with hover states.** A color that
   must respond to `:hover`, `group-hover`, or transitions belongs on a
   `--ac-*` var / Tailwind utility class — the JS-inline leg cannot express
   pseudo-states (the root cause of the ~90 hand-rolled hover handlers; new
   UI must not add to that count, and touched UI should retire them —
   enforced by audit rule R5).

### 1a. The neutral ramp — ROUND-100 (R100-C, research §C1.3)

"Pick a neutral" is a LOOKUP into the existing per-mode steps, never a hex
hunt. bg/card/text come from the active theme's table; the rest are the
mode-level overlays `deriveThemeStyles()` paints over them (identical in
every theme — only the mode flips them):

| Step | Light mode | Dark mode | Use |
|---|---|---|---|
| `bg` | `theme.bgLight` (per-theme) | `theme.bgDark` | app background |
| `frame` | `color-mix(bg 93%, text)` | same recipe | the ambient strip behind cards (`--ac-frame-bg`) |
| `card` | `theme.cardLight` (per-theme) | `theme.cardDark` | cards, panels, chrome surfaces |
| `subtle` | `rgba(0,0,0,0.04)` | `rgba(255,255,255,0.04)` | quiet fills, chips, identity-chip bg |
| `border` | `rgba(0,0,0,0.10)` | `rgba(255,255,255,0.10)` | 1px hairlines (dividers, inside-panel) |
| `border-strong` | `rgba(0,0,0,0.18)` | `rgba(255,255,255,0.18)` | hover border swap, top-level card lines |
| `text-tertiary` | `rgba(0,0,0,0.40)` | `rgba(255,255,255,0.40)` | meta, kickers, timestamps |
| `text-secondary` | `rgba(0,0,0,0.60)` | `rgba(255,255,255,0.60)` | descriptions, secondary labels |
| `text` | `theme.textLight` (per-theme) | `theme.textDark` | primary ink |

Accent discipline (ROUND-100, research §C1.3): the accent marks
**selection + the one primary action**; nothing else in working UI is
accent-colored at rest.

### 1b. The theme catalog — ROUND-107 (R107-g) adds Clay Studio

Six themes: Nova Cream (the default), Bento Blue, Midnight Lab, Sunset
Pop, Mono Stone, and **Clay Studio** (round-107 — the owner's "go with the
Clay Studio aesthetic" direction). Clay Studio is the clay SUBSTRATE: warm
sand neutrals (`#F4EEE5` bg / `#FDFBF7` card light; brown-tinted charcoal
`#26211C` / `#2F2924` dark — never a blue-black), warm ink
(`#2A2018` / `#F2EBE1`), and a muted terracotta accent
(`#C4653F` light / `#D98A63` dark) — the warm family the owner asked for
(indigo/blue accents remain banned as defaults house-wide). Measured
contrast sits inside the envelope the other five themes already tolerate:
accent-on-bg 3.45:1 light (nova: 2.75), accentDark-on-bgDark 5.90:1 (over
the ~4.5:1 accent-dark bar), ink 13–15:1 both modes.

### 1c. The `--ac-*` var families (summary)

| Family | Vars | Used for |
|---|---|---|
| Surfaces | `--ac-bg`, `--ac-card`, `--ac-sidebar-bg` | app background, cards, chrome |
| Text | `--ac-text`, `--ac-text-secondary`, `--ac-text-tertiary` | ink hierarchy (the ramp above) |
| Accent | `--ac-accent`, `--ac-accent-text`, `--ac-accent-faded`, `--ac-accent-soft` | brand moments, user bubbles, primary buttons |
| Lines | `--ac-border`, `--ac-border-strong`, `--ac-border-subtle` | bento borders, hairlines |
| Subtle | `--ac-subtle`, `--ac-subtle-hover` | quiet fills, hover washes |
| Inputs | `--ac-input-bg`, `--ac-input-border`, `--ac-input-focus-border` | fields, steppers |
| Shadows | `--ac-soft-shadow`, `--ac-bento-shadow` | depth (see MOTION.md for entry motion) |
| Chrome (R107-g) | `--ac-chrome-hi/mid/lo`, `--ac-chrome-sheen` | the liquid-chrome ramp — §8 below |

## 2. The type scale (the canonical ladder) — ROUND-100 (R100-C, research §C1.1)

**ROUND-100 (R100-C) revision**: the old 8-step ladder sanctioned 8
sub-14px sizes with no weight law — the measured "AI-generated" tell (34
distinct `text-[Npx]` sizes in the tree, 101 sub-10px occurrences outside
onboarding). The ladder is now cliff-shaped and weight-governed:

| Token | Size / weight / line-height | Use |
|---|---|---|
| `display` | 56–104px / **600** / 0.95–1.05 | wizard + empty-state greetings only |
| `title` | 24px / **600** / 1.2 | page titles (Settings, Usage, Dashboard) |
| `section` | 13px / 600 / 1.4 | card + section headers |
| `body` | 13px / **400** / 1.55–1.65 | chat prose, settings descriptions |
| `body-strong` | 13px / 500 | active nav label, emphasized row |
| `ui` | 12px / 400 / 1.4 | secondary chrome, tab labels, toolbar labels |
| `label` | 11px / **500** uppercase / `tracking-[0.08em]` | THE ONE kicker idiom (`ui/Kicker`) |
| `meta-mono` | 10px / 400 mono / tabular | timestamps, chips, stat lines, model ids |
| `value` | 22px / 600 / 1.0 tabular | StatCard values |

**Enforced rules (ROUND-100 R100-C — audit rules R2/R3/R4 guard these):**

- **Hard floor 10px.** Kill 8 / 8.5 / 9 / 9.5px type (the 101 occurrences
  outside onboarding snap to 10 or 11).
- **No half-pixel steps.** 10.5→11, 11.5→12, 12.5→12 or 13, 13.5→13.
- **≤7 sizes visible on any one screen** — the ladder is a cliff
  (13→24→56), not a staircase; a screen quoting more than 7 steps is drift.
- **Markdown headings snap to 13px/600 (h3) and 12px/600 (h4–h6)** — kill
  the 15/13.5/12.5px heading sizes (`ChatMarkdown.tsx:839-841`).
- **THE WEIGHT LAW: 400 is the default everywhere in chrome; 500 =
  active/selected; 600 = section headers, titles, buttons; 700/900 =
  wizard display + StatCard value ONLY.** `font-bold`/`font-black`/
  `font-extrabold` outside `src/components/onboarding/` + the StatCard
  value is a bug (audit rule R4 counts them; ~26+ files today).

Fonts: keep Space Grotesk app-wide (the owner-approved identity — the
wizard proves it), mono stack unchanged. One reading size per surface;
hierarchy comes from weight/color (`text` → `text-secondary` →
`text-tertiary`), never from inventing a 9.75px. The chat's text-size
ladder (S/M/L, ±12%, `--ac-chat-scale`) scales the three reading surfaces
(.chat-prose/.chat-thinking/.chat-narration) — never the chrome.

## 3. Spacing + density — ROUND-100 (R100-C, research §C1.2)

**ROUND-100 (R100-C) revision**: 4px base grid, 8px rhythm — the scale is
**4 / 8 / 12 / 16 / 24 / 32 / 48 / 64**. The old "pad-2/pad-3 (2px/3px)"
chat-route exception is reduced to: seam gaps 4px (`SEAM_GAP` 3→4). Paddings
step on the rhythm; never 13/18/22. The transcript's graduated padding
(24→48→64px) stays the sanctioned exception for reading comfort.

### The row-height table (ROUND-100 R100-C — IDE density)

| Surface | Height |
|---|---|
| Sidebar nav row (top-level) | **32px** (was 40/44) |
| Sidebar project row | 30px |
| Sidebar session row | 26px |
| Settings nav row | 30px |
| Settings control row (label + control) | **36px** (`ui/SettingsRow`) |
| Chat tool row | 28px |
| WorkingSection header | 28px |
| Composer toolbar | 36px |
| Right-sidebar toolbar | 36px |
| Chat turn gap (between turns) | 24px |
| In-turn segment gap | 8px |

Chrome widths (ROUND-100 R100-C): sidebar **240px** (was 270 — VS Code's
300 is for trees; ours is nav), rail **48px** (the activity-bar standard,
was 64). Icon sizes: **16px** nav/chrome, **14px** toolbar, **12px**
rows/chips, **11px** only inside 20px chips. Every icon button keeps a
**≥28×28px** hit target. The chat route stays borderless (surfaces + gaps);
every other route keeps the bento card + 1.5px line borders. Drag handles
stay 5px.

## 4. The radius scale — ROUND-100 (R100-C, research §C1.4)

**ROUND-100 (R100-C) revision**: 5 steps, expressed through Tailwind's
default scale (same pixels, no arbitrary values — audit rule R2 counts
`rounded-[Npx]` spellings):

| Step | Radius | Tailwind | Use |
|---|---|---|---|
| 1 | **4px** | `rounded-sm` | inline code, checkboxes |
| 2 | **8px** | `rounded-lg` | buttons, chips, inputs, toolbar pills |
| 3 | **12px** | `rounded-xl` | code blocks, popovers, dialogs, composer, user message |
| 4 | **16px** | `rounded-2xl` | cards, panels, the chat window card (was 24) |
| 5 | **999px** | `rounded-full` | pills |

The wizard keeps its **18–24px signature radii as the documented
exception** (WIZARD-DNA §4). Kill every other arbitrary radius
(`rounded-[7px]`, `[9px]`, `[10px]`, `[14px]`, `[18px]`, `[20px]` — the
40× in ModelsProvidersTab etc. all snap to the scale).

## 5. Borders + elevation — ROUND-100 (R100-C, research §C1.4)

- **1px hairlines** for dividers, inside-panel lines, table rows.
- **1.5px** only on top-level bento cards (the owner-approved
  border-forward look).
- **2–2.5px** borders are wizard-only.
- Elevation: `softShadow` for floating surfaces (popovers, menus, the chat
  window card); `bentoShadow` (hard offset) + gradient fills are
  **wizard + primary CTA only** (WIZARD-DNA §7) — remove from
  UsageScreen/DashboardScreen heroes (`UsageScreen.tsx:126-138`,
  `DashboardScreen.tsx:85-90`).

## 6. Interaction states — ROUND-100 (R100-C, research §C1.5)

- **Hover (ROUND-100 R100-C):** every interactive row = the `hover:bg-hover`
  bg wash (the CSS-var leg), **80–120ms, no translate/scale**. Hover is a
  CSS class — NEVER a JS `onMouseEnter`/`onMouseLeave` handler (TitleBar
  shows the pattern; audit rule R5 counts the violations). Retire all
  `onMouseEnter` handlers outside onboarding.
- **Focus (ROUND-100 R100-C):** ONE global rule — an accent ring, 2px,
  2px offset:
  `:where(button, a, input, textarea, select, [tabindex]):focus-visible { outline: 2px solid var(--ac-accent); outline-offset: 2px; }`
  — then the `outline-none` uses each get audited to confirm a visible
  replacement. Normative for every wave; lands in `src/index.css` with the
  first applying wave (D — chat) so all later screens inherit it.
- **Press:** keep the universal `active:scale-[0.98]` contract; DELETE
  `hover:scale-105` from working chrome (composer Send/Stop/Queue) —
  resting UI never fidgets.
- **Selection:** accent text + `bg-accent-soft` + a 2px accent bar on the
  leading edge (the provider-list grammar, COMPONENTS §5 — apply it to
  Sidebar nav + settings nav).

## 7. Semantic colors (the only fixed hues)

| Name | Hex | Means |
|---|---|---|
| success | `#22c55e` | completed, healthy, verified |
| warning | `#f59e0b` | wait/attention: retry waits, queued, thinking-loop stops |
| danger | `#ef4444` | failure, destructive, error — `role="alert"` surfaces |
| running | `#3b82f6` | in-flight tool rows (informative "happening now" — R98-C2's `RUNNING_BLUE` in semantics.ts, the fourth exception) |

Warning and danger are NEVER interchangeable (round-97 D: a thinking-loop
stop is amber `role="status"`, never red "Generation failed"). Danger tints
via `withAlpha(danger, 0.08–0.1)` for washes; success tints 0.08 for
confirmation glows.

## 8. The liquid-chrome ramp — ROUND-107 (R107-g)

Owner direction (round-107): "go with the Clay Studio aesthetic and also a
mixture of liquid chrome… the overall UI looks much better, much more
proper, and much more well-handled." The mixture's division of labor:
**clay is the substrate** (backgrounds, cards, chrome surfaces — delivered
by the Clay Studio theme, §1b), **liquid chrome is the jewelry** (the one
primary action's sheen, focus glints, hero moments — delivered by this var
family + the `.ac-chrome-*` / `.ac-clay-light` pattern classes in
`src/index.css`, composition rules in COMPONENTS §8).

| Var | Light mode | Dark mode | Role |
|---|---|---|---|
| `--ac-chrome-hi` | `#FFFFFF` | `rgba(255,255,255,0.55)` | the glint: hairlines, top-lights, sheen edges |
| `--ac-chrome-mid` | `#EDE8E0` | `rgba(255,255,255,0.08)` | the platinum body of the metal ramp |
| `--ac-chrome-lo` | `#D8D1C6` | `rgba(255,255,255,0.03)` | the metal's shaded edge |
| `--ac-chrome-sheen` | `rgba(255,255,255,0.55)` | `rgba(255,255,255,0.16)` | the moving highlight band |

Rules:

1. **Theme-independent, mode-aware.** The ramp is set by
   `syncThemeCssVars()` from `isDark` alone — liquid chrome reads as the
   same platinum on every palette (jewelry, not cloth). It is NOT a
   ThemeColors field and must never become one.
2. **Warm platinum on purpose.** The light-mode stops are a hair warm
   (`#EDE8E0`, not `#E8E8E8`) so chrome harmonizes with the clay substrate
   instead of reading cold against it.
3. **Values live in the pipeline only** — `themes.ts` (the bridge) +
   the `:root` pre-paint fallbacks in `src/index.css` (the same sanctioned
   pattern as the nova literals). A component writing a metal hex itself
   is an audit R1 violation like any other.
4. **Ink on full-metal surfaces is `--ac-text`** (dark-on-platinum in
   light mode, light-on-dark-metal in dark mode — contrast holds by
   construction). Never `--ac-accent-text`.
5. The sheen MOTION contract (ambient 9s pass, transform-only,
   reduced-motion collapse) is documented in MOTION §3 — the animation
   grammar owns the movement, this file owns the color.
