<!-- last-reviewed: 2026-09-15 round-98 -->
# Components — the primitive catalog and composition rules

Serves DESIGN-SYSTEM §5 (anatomy inventory). The inventory there names the
behavioral contracts; this file names the **shared visual primitives** —
the "one spelling" rule that kills the AI-slop repetition smell (round-98
C2's mandate: no idiom re-implemented per file).

## 1. The primitives (one spelling each)

| Primitive | Source | Contract |
|---|---|---|
| `SkeletonBlock` / `SkeletonRows` | `src/components/shared/Skeletons.tsx` | ALL loading states. Decorative `aria-hidden` pulse in `subtle` surface; the call site owns the single `role="status"` announcement. |
| `ChoiceCard` | `src/pages/SettingsPage.tsx` | radio-circle + label + one-line description; the pattern for every pick-one setting (text size, timestamps, tool activity, search engine). |
| `SettingsLoadErrorCard` | `src/pages/SettingsPage.tsx` | the honest error card for a failed settings GET: `role="alert"`, danger tint, exact cause, one Retry. |
| `CommitNumberInput` | `src/pages/SettingsPage.tsx` | numeric stepper that PUTs only on blur/Enter (never mid-typing). |
| `ConfirmDialog` | `src/components/settings/ConfirmDialog.tsx` | every destructive action's guard — exact enumeration of what will be destroyed. |
| `withAlpha()` / `bdr()` | `src/components/dashboard/helpers.ts` | the only sanctioned alpha-tint + border helpers. |
| `ClampedText` | `src/components/shared/ClampedText.tsx` | N-line clamp + expand affordance. |
| `CodeBlock` | `src/components/project-chat/` (ChatMarkdown) | fenced-code rendering: Prism tokens, gutter, wrap contract. |
| `ChatMarkdown` | `src/components/project-chat/ChatMarkdown.tsx` | the message-body renderer (headings/lists/tables/fences/PathPills). |

**The rule**: before writing a new pill/chip/card/error/loading idiom,
check this table. If it exists, import it; if it doesn't and two surfaces
need it, make it a primitive and add the row here in the same round.

## 2. The chip grammar

Chips are the app's densest idiom. One grammar:

- **Stat chip**: `stat` type (9.5px mono), `subtle` bg, hairline border,
  tertiary text — usage: `s · ↑in · ↓out · tok/s · model`.
- **Status chip**: semantic-tinted (`withAlpha(semantic, 0.1)` bg +
  semantic text): success/done, warning/waiting (queued, retry wait,
  thinking stop), danger/failure. `role="status"` unless it IS an alert.
- **Identity chip**: mono, `subtle` bg, truncate — models, task ids, paths.
- **Action chip**: quiet until hover (the hover-actions cluster pattern:
  Copy/Revert/Timestamp reveal on group-hover-within — keyboard parity via
  group-focus-within).

Never more than one tinted status chip per row; never a chip inside a chip.

## 3. The card grammar

Two card species only:

1. **Bento card** (default outside the chat route): `card` surface,
   1.5px `border-line`, 16px radius, `softShadow`; hover = border-strong +
   shadow bloom (120ms). Sections inside step 12/16px.
2. **Chat surface** (the borderless route): no border, no shadow —
   surface-on-background separation via 2–3px gaps. Depth is expressed by
   the working/folded state, not by shadow.

Section headers inside cards: `label` type (11px uppercase tracked) or
`section` type (13px semibold) — pick per density, then be consistent
within the card.

## 4. The button grammar

| Species | Anatomy | Motion |
|---|---|---|
| Primary | 135° accent→accent2 gradient, `bentoShadow`, white ink (WIZARD-DNA §4) | hover scale 1.03 + bloom; press 0.98 |
| Secondary | `card` pill + 1.5px border | press 0.95 |
| Ghost | text/icon only, `subtle-hover` wash | press 0.95 |
| Icon | 28–32px square hit target, radius 9–10px | same as ghost |

Press feedback (`active:scale-95`) is universal — a button without it is a
bug.

## 5. The layout grammar

- Chat route: borderless surfaces + gaps; the transcript is a centered
  column (max-w-[1080px]) with graduated padding; panels flank.
- App routes: bento cards on the app background; 12–16px gutters.
- Popovers/flyouts: 12px radius, `border-strong`, `bentoShadow`, 1.5–2px
  border, outside-click close, `aria` semantics (DESIGN-SYSTEM §6).
- Dialogs: Radix center, 12px radius, header/body/footer zones, base
  transform = end-state.

## 6. The data-display grammar (round-98 I2 adds)

- **Stat cards**: big number (24px semibold) + label + one supporting
  line; icon quiet-tinted; never a rainbow.
- **Charts**: theme accent for the primary series; per-model/per-category
  series get STABLE palette hues keyed by name (same name = same color,
  everywhere in the app — the model palette in
  `src/components/usage/usage-helpers.ts`, the usage segment palette
  precedent in `src/lib/menu-overlay.ts`).
- **Heatmap**: intensity = accent alpha ladder (0 → 0.15 → 0.35 → 0.6 →
  0.85 → 1); empty days transparent; month labels `meta` type.
- **Donut/ring**: 6px track, center hole carries the headline stat; segment
  hover = MUTUAL highlight with the legend row (the round-97 context-bar
  contract, generalized).
