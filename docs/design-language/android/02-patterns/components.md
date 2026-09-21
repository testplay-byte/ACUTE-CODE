<!-- last-reviewed: 2026-09-21 round-116 -->

# Patterns — Components

Implementation lives in `mobile/src/design/primitives.tsx` + feature components. This
file pins the idioms round-115 established.

## Buttons

| Idiom | Look | Use |
|---|---|---|
| **Primary** | Flat accent clay, radius 14, minHeight 50, `clayShadow2`, press 0.98, optional busy spinner | The ONE main action per screen. **No sheen on wizard CTAs** (round-115). |
| **Quiet** | Outlined, minHeight 46, neutral or danger tone | Escapes: "Do it later", "Not this one", "Deny" |
| **Half-width action** | Primary/quiet at `width: "50%"` minus gutter, icon + 2-word label | "New project" at list bottoms |
| **Icon-circle** | 50px circle (send) / 44px quiet circle (stop) | Composer + row actions |

Labels: 1–3 words. No sentence buttons. No glow, no gradient washes, no Apple-y shine.

## Cards & rows

- `ClayCard` (r20, clayShadow1, matte top edge) — containers.
- `PressableCard` — every tappable row (press grammar + optional stagger entrance).
- **Row anatomy:** [identity 36–44px] [label + ONE meta line] [trailing: status badge
  or chevron — never both a chevron AND an action button].
- **Letter avatar** (project identity): first letter, white `TypeBodyStrong`, on the
  project's theme color, **rounded-square radius (r≈40% of size, `RADIUS_CHIP`-class),
  clay treatment** (matte top edge + hairline border + `clayShadowSm`) — round-116
  replaced the circle. Used in: project rows, chat header, session context rows. The
  colored dot is retired. Identity avatars are never plain circles.
- **Provider identity** (providers list): a colored icon tile — the provider's stable
  name-hash hue (the same palette as model colors), never a neutral key glyph.
- **Info rows in detail screens**: label (micro, tertiary, all-caps via style) above
  value (mono for machine truth). One datum per block when it matters (address, PIN,
  fingerprint each get their own block).
- **The single-line law (round-116, absolute):** every description, caption, and
  option body renders `numberOfLines={1}` — cards, rows, sheets, footers, settings
  captions. If it can't say it in one line, the copy is wrong (see `copy.md`).

## Chips & badges

- `Chip` — selectable filters (windows, modes): selected = accent border + tint.
- `Badge` — status vocabulary only (open/done/stopped/failed/live/expired) with the
  semantic tones. Never decorative.
- **Countdown chip** — "Valid for 24s": mono numerals, tinted `warning` under 30s,
  `danger` at 0 where it becomes the "Rescan" state itself.

## Sheets (bottom)

- The `Sheet` primitive (Modal + spring rise + scrim + grip + title + X). Round-115
  animation contract: **panel enters fully opaque, sliding its full height from below
  the fold** (never a translucent ghost rising 96px); scrim fades on a faster timing.
- **Round-116 mechanics:** the entrance rides the SHEET spring (over-damped — no
  overshoot, no settle-wobble), the progress value is clamped so the panel can never
  dip below its rest, and the panel carries a below-the-fold skirt so the page
  background is never visible under it, even mid-animation. The inner ScrollView sets
  `overScrollMode="never"` (no Android stretch).
- Sheet contents = Archetype 3 forms: label + control stacks, `spacing.xl` horizontal.
- **A sheet asks ONE question.** "Which folder?" — not "name + folder + color".
  Derived data (project name from folder) is derived, never asked.
- Sheet scroll area owns the full remaining height; content bottom padding ensures the
  page background is never visible through/below the panel.
- **Action menus with ≤4 actions render as a GRID** (2×2), not a vertical stack —
  round-116: the model menu (Test / Edit / Hide / Delete).

## Folder browser (in-sheet)

- Breadcrumb strip (current crumb highlighted) + directory list (folders only, letter
  or folder icons, chevrons), nested scroll.
- **Navigation caps at the user's home directory** — no "up" affordance past it.
- Selection state: chosen path renders as a mono chip with the full path; the confirm
  button's label flips **"Use this folder" → "Select another folder"** (resets to
  browse); "Create" is a separate primary once a folder is chosen.
- Loading rows inline, honest truncation note only when the 400-entry cap trips.

## Tab bar

- The floating clay slab (r28, ChromeEdge hairline, clayShadow2, 60px) — kept, polished.
- 5 items: Home · Projects · Approvals · Dashboard · **More**.
- **Round-116 anatomy:** each item is a HORIZONTAL chip — icon LEFT, label RIGHT — and
  **the label renders ONLY on the selected item**, animating in (width + opacity) as
  the previous item's label collapses out. The selection indicator is a rounded pill
  with a **2px accent border** (never hairline) sliding on a calm, over-damped spring.
- **Approvals pending**: icon (and the selected label) breathe in accent (1.6s opacity
  0.75↔1) + the count badge.
- Hides under the keyboard on the house spring.

## Dropdown menus (anchored, round-116)

- A kebab/overflow control on a HEADER opens a menu **anchored directly below the
  control** (top-right corner), springing in with a scrim-less tap-outside dismiss —
  NOT a bottom sheet. Rows are label + live value ("Mode — Full Access"); each row
  routes to its detail surface. Reserved for header chrome; body rows keep sheets.

## Banners, strips, empty states

- Offline/probing = one quiet strip (dot + one line) at the content top — never a
  modal banner.
- Empty state = centered icon + one-line title + one-line caption (Archetype-1 DNA).
- Success/error feedback = the `NoteLine` idiom (one line + dot) or a haptic — toasts
  only for cross-screen consequences.

## Chat components (summary — full spec in `chat.md`)

Header identity bar (avatar + two-line identity + kebab menu) · message bubbles with
inline meta · docked composer (attach + input + send only) · kebab sheet routing to
mode/model/thinking/context sheets.
