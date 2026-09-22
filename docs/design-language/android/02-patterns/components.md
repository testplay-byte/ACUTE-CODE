<!-- last-reviewed: 2026-09-22 round-118 -->

# Patterns — Components

Implementation lives in `mobile/src/design/primitives.tsx` + feature components. This
file pins the idioms round-115 established.

## Buttons

| Idiom | Look | Use |
|---|---|---|
| **Primary** | Flat accent clay, radius 14, minHeight 50, `clayShadow2`, press 0.98, optional busy spinner | The ONE main action per screen. **No sheen on wizard CTAs** (round-115). |
| **Quiet** | Outlined, minHeight 46, neutral or danger tone | Escapes: "Do it later", "Not this one", "Deny" |
| **Half-width action** | Primary/quiet at `width: "50%"` minus gutter, icon + 2-word label | "New project" at list bottoms — **retired (R118-E)**: superseded by the self-sized page CTA |
| **Icon-circle** | 50px circle (send) / 44px quiet circle (stop) | Composer + row actions |
| **Icon-circle (quiet)** (R118-A) | `QuietIconButton` — 36/40/44 circle, subtle fill + hairline rim, `hitSlop` | Header/close/back chrome (the chip grammar the owner ruled): 36 = sheet close, 40 = back, 44 = row actions |
| **Sheet CTA** (R118-A) | `ChromeButton` centered, self-sized, `minWidth: SHEET_CTA_MIN_W (200)`; `tone="danger"` for destructive confirms | The sheet's ONE primary; quiet escapes centered beneath at natural width — never a second full-width bar |

Labels: 1–3 words. No sentence buttons. No glow, no gradient washes, no Apple-y shine.

**Round-118 addition (R118-E) — the self-sized page CTA:** list/registry pages carry
their "New X" as a CENTERED `ChromeButton` with `minWidth: PAGE_CTA_MIN_W (200)` —
same grammar in the empty state, the configured list, and the well ("New project",
"Add a provider", "New session"). A muted half-width or full-width outline row is
not a CTA; the half-width idiom is retired.

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
- **The strong row divider (R118-B):** `<Hairline strong inset={spacing.md} />` — a
  full **1dp `borderStrong`** line (18% ink light / 18% white dark), inset by the
  gutter, between rows inside a card and as the visible break between tiers.
  `borderSubtle` at hairline width is arithmetically invisible (0.33dp on a 3×
  screen) — a divider that cannot be seen is not a divider. Never after the last row.
- **The provider hero card (R118-E, Archetype 3):** three zones — identity (the
  name-hash color tile 48 r16 + `TypeTitle` 20/700 name + ONE context line), the
  machine strip (the one honest mono line: BASE URL, 13/19), the actions pair
  (primary `flex:1` + quiet peer `flex:1`, both 50 tall) — hairlines between zones.
  Never one undifferentiated card carrying identity + machine meta + two
  same-weight outlined rows.
- **Model rows are NAME-only (R118-E):** the display name (or the cleaned name) +
  the facts line — the raw model id renders on DETAIL surfaces only (the actions
  sheet's mono block, the edit form's read-only field), never in the list row.
- **Key-pool rows (R118-E):** key tile 32 r11 (`accentTint` + glyph when set,
  `surfaceWell` + tertiary glyph when empty) + title + "empty" Badge when bare +
  ONE mono meta line (`•••••••• · used 3d ago`, mono 12/18 — the optional "used" leg
  degrades honestly on an older sidecar) + compact quiet actions (36, busy
  label-swaps). Inset hairlines between rows + a final rule.

## Chips & badges

- `Chip` — selectable filters (windows, modes): selected = accent border + tint.
- **`ClayIconChip` (round-117 — the elevation spec §2.2):** the tinted identity
  chip for list rows — sizes 40/44/48 (r 14/15/16), fill `accentTint` + the
  `clayRim` hairline + `clayShadowSm`, glyph `accentDeep` strokeWidth 2.2. This
  replaces every `subtleHover` ghost icon chip (welcome's feature rows, home's
  bell, more's about/settings, connect's option rows, the composer's mode
  rows) — hue in every list row without breaking the one-accent law.
- `Badge` — status vocabulary only (open/done/stopped/failed/live/expired) with the
  semantic tones. Never decorative.
- **Countdown chip** — "Valid for 24s": mono numerals, tinted `warning` under 30s,
  `danger` at 0 where it becomes the "Rescan" state itself.

## Segmented control (R118)

- The shared primitive (R118-A): track `SEGMENT_TRACK_H 52` / radius 26 /
  `SEGMENT_INSET 4`, `surfaceWell` fill + hairline `clayRim`; the sliding
  indicator is a solid **`accentDeep` fill, NO border** (4.98:1 light / 6.30:1 dark
  as text), gliding in index space on TAB_SPRING. Selected label 15/700 `accentText`,
  unselected 15/600 `textSecondary`; segments carry minHeight 44; the a11y labels
  carry the full names ("Chat completions" / "Anthropic messages" / "Responses").
  API = `{options, selectedId, onSelect, testID}` — nothing else; the vocabulary pin
  keeps captions out.
- **2–4 choices, ONE line, all visible** (donts #43) — a wrapping chip row is three
  buttons, not one control. Use it for API format (Chat/Anthropic/Responses),
  operating mode (Full/Ask/Plan), catalog/custom pairs, appearance
  (System/Dark/Light).
- **The window/scope selector variant (R118-C, the dashboard's period picker):**
  deliberately LOCAL, not the shared primitive — the tab-pill recipe at the
  chrome-tier labels: `accentTint` fill + 2px `accentDeep` border r22, TAB_SPRING
  slide, labels 12.5/700 `accentDeep` / 12.5/600 `textSecondary`, self-sized and
  leading (never sticky — the R114-c law). The shared primitive's 15/700
  accentDeep-fill class is a different tier; don't force one onto the other.

## Sheets (bottom)

- The `Sheet` primitive (Modal + spring rise + scrim + header row). Round-115
  animation contract: **panel enters fully opaque, sliding its full height from below
  the fold** (never a translucent ghost rising 96px); scrim fades on a faster timing.
- **Round-118-A anatomy:** the header row is 48 tall (`SHEET_HEADER_ROW`) — `TypeTitle`
  20/700 left, one line, tail-clip + a **36px `QuietIconButton` close** (X 18 — the
  back-button circle the owner ruled). **The grip is DELETED** — a non-draggable
  sheet wears no drag handle (donts #45).
- **The first-frame law (R118-A):** every Modal-hosted animated surface carries a
  STATIC initial pose (panel pinned below the fold, scrim at 0) ahead of the animated
  styles — the Modal's new Android window can composite before Reanimated attaches,
  and an empty first animated style paints the panel open at rest ("opens, then
  replays"). See `motion.md` §2.
- **Round-116 mechanics (unchanged):** the entrance rides the SHEET spring
  (over-damped — no overshoot, no settle-wobble), the progress value is clamped so
  the panel can never dip below its rest, and the panel carries a below-the-fold
  skirt so the page background is never visible under it, even mid-animation. The
  inner ScrollView sets `overScrollMode="never"` (no Android stretch).
- Sheet contents = Archetype 3 forms: label + control stacks, `spacing.lg` (16)
  horizontal. **Fields are `ClayInput` (label above) with captions banned** — no
  description blocks, no explainer footnotes, nothing between or under fields
  (R118-A; donts #42; `typography.md`'s field-hint row). One-line N-way choices are
  a `SegmentedControl`, never a wrapping chip row.
- **The CTA zone (R118-A):** the primary renders CENTERED and self-sized
  (`minWidth: SHEET_CTA_MIN_W 200`); destructive confirms take `tone="danger"`;
  quiet escapes sit centered beneath at natural width. Never a full-width bar pair
  (donts #44).
- **Keyboard-aware (R118-E):** the panel rides the IME — RN-core Keyboard events
  (guaranteed to fire from the Modal's own window) drive
  `translateY −= min(kbHeight, headroom)` on the sheet spring while the content's
  bottom padding eats the unrisen remainder, so bottom fields and the CTA scroll
  clear of the keyboard. `KeyboardAvoidingView` stays banned (R115-K).
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
- **Create-folder (R118-E):** the FIRST row of the folder list is the affordance —
  "Create a folder here" (FolderPlus 16 `accentDeep`, press fill subtle) with a
  hairline rule separating it from the dirs below. Tapping expands an INLINE namer
  in place (no sheet): mono field (44, radius 14) + a Check circle 36 (accentDeep
  fill) + an X quiet circle 36. Create → `POST /system/fs/mkdir` → success haptic →
  **auto-select the new folder** (the sheet flips to the selected state with the new
  path) while the list re-browses in the background — one tap from "create" to
  "selected". Errors are the three honest one-liners (exists / the host is offline /
  this build lacks folder creation).

## Tab bar

- The floating clay slab (r28, ChromeEdge hairline, clayShadow2, 60px) — kept, polished.
- 5 items: Home · Projects · Approvals · Dashboard · **More**.
- **Round-116 anatomy:** each item is a HORIZONTAL chip — icon LEFT, label RIGHT — and
  **the label renders ONLY on the selected item**, animating in (width + opacity) as
  the previous item's label collapses out. The selection indicator is a rounded pill
  sliding on a calm, over-damped spring.
- **Round-117 presence (the elevation spec §2.3):** the selection pill wears the warm
  **`accentTint` FILL under its 2px `accentDeep` border** (One UI's tinted-pill move,
  in clay — the border discipline of donts #34 stays). The active icon is 23px /
  strokeWidth 2.5 in `accentDeep`; inactive icons read `textSecondary` (never the old
  tertiary ghosts). Labels sit at the 11.5px floor (`TYPE_TAB_LABEL`, label +
  measurement row byte-identical). The pending badge fills `accentDeep` + `accentText`.
- **Approvals pending**: icon (and the selected label) breathe in accent (1.6s opacity
  0.75↔1) + the count badge.
- Hides under the keyboard on the house spring.
- **Round-118 adaptive slots (R118-B):** the row insets `TAB_INSET_X 12` from the
  slab's inner edges; the SELECTED tab's slot grows to its chip's natural width —
  `23 (active icon) + 6 (gap) + label(+2 epsilon) + 2×12 (PILL_PAD_X)` — while the
  unselected slots rebalance to the equal split **capped at `barWidth/N`**; the pill
  centers in the selected slot and can never touch the edges (**the edge clamp is
  gone** — it starved the first/last pills' padding and clipped "Approvals"). Slot
  WIDTHS animate on `TAB_LABEL_MS` so the row rebalances fluidly (icons glide) while
  the pill still glides on TAB_SPRING. The bar's radius, card fill, and `clayShadow2`
  now cast from **ONE rounded wrapper** (a square shadow View around a rounded slab
  is the "sticker pasted" halo), and ChromeEdge runs vertical (`tokens.md` §2).

## Dropdown menus (anchored, round-116)

- A kebab/overflow control on a HEADER opens a menu **anchored directly below the
  control** (top-right corner), springing in with a scrim-less tap-outside dismiss —
  NOT a bottom sheet. Rows are label + live value ("Mode — Full Access"); each row
  routes to its detail surface. Reserved for header chrome; body rows keep sheets.
- **In-place sub-levels (R118-D):** a row's detail renders INSIDE the anchored panel —
  the title row gains a back chevron (`onBack`), rows gain `selected` (the accent
  Check 16 replaces the trailing chevron), `children` renders read-only content
  under the title, and `contentMaxHeight` wraps long lists in a scroll (the model
  list at 360). Picks **apply and return to main** — the main rows display the live
  values, so the feedback loop closes where the user is looking; the back chevron
  remains for deliberate browsing. Read-only levels (Context) stay at their level.
  The two-step stop lives on the main level (see `chat.md`).

## Dialogs (centered, R118-D)

- `ConfirmDialog` — the app's first centered Modal primitive: clay card
  `min(320, windowWidth − 40)`, `RADIUS_CARD` 20, `tokens.card`, hairline
  `clayTopEdge`, `clayShadow2`, padding lg, centered. Title `TypeTitle` (2 lines
  max), body `TypeCaption` (1 line), one button row (flex 1 each, minHeight 46,
  radius 14): cancel = quiet outlined, confirm = filled — `dangerDeep` when
  `destructive`.
- Entrance: scale 0.96→1 on the house spring, origin center, over the 160ms sheet
  scrim; exit a 120ms fade; scrim tap cancels; the confirm haptic fires only on
  confirm. Carries the R118-A static initial pose (it is a Modal-hosted surface —
  `motion.md` §2).
- Reserved for small confirmations the sheet grammar would overweight (the stop
  confirm). A dialog never hosts a form — forms are sheets.

## The stat grid (R118-C)

- ONE `ClayCard` (r20, `clayShadow1`, `clayRim`, padding md) carrying a composed
  **2×2 grid** (4-across ≥768dp). Cells split by **1px inset `borderStrong`
  dividers** (the strong recipe). Cell = `TypeMicro` kicker → `TypeStat` value →
  optional one-line `TypeMicro` caption; minHeight 88; **no icon chips** — the number
  is the content.
- All four numbers come from the SELECTED window — never mixed scopes beside each
  other; the all-time counters live in their own honestly-labeled "all time"
  sections.

## The disclosure motion (R118-C)

- Expand: `withSpring(target, DISCLOSURE_SPRING {180, 24})` — ζ ≈ 0.89, one soft
  settle, no jelly. Collapse: height `withTiming(0, 200ms ease-out)` + opacity
  `withTiming(0, 150ms)` — **a timing curve cannot overshoot, so closing NEVER
  bounces** (the both-ways 180/22 spring was the accordion jelly the owner called
  out). The chevron follows its level's direction; the onLayout re-measure rides the
  spring; reduced motion snaps. See `motion.md` §4.11.

## Session rows inside expansions (R118-C)

- **The honest status law:** a Badge renders ONLY when the status says something —
  running → warning "running", completed → success "done", failed/cancelled →
  danger "failed"/"stopped", unknown raw → neutral. **`queued` shows NOTHING — the
  absence of the badge is the information** (a badge on every row is noise).
- Anatomy: 2-line tail title (`TypeBodyStrong`) + the badge; the model chip
  (name-hash dot 10 + `TypeMono` 11 — the owner's keep) + time-ago meta; the
  right-aligned `TypeMono` 13 pair `tokens · cost`; minHeight 56.
- Rows render inside **the recessed well** — `surfaceWell` + hairline `clayRim` +
  `RADIUS_INPUT`, inset margins, overflow hidden — with **1dp inset `borderStrong`
  dividers between rows** (never after the last). ONE spelling everywhere: the
  dashboard's session wells and the projects screen's well are the same recipe.

## Banners, strips, empty states

- Offline/probing = one quiet strip (dot + one line) at the content top — never a
  modal banner.
- Empty state = centered icon + one-line title + one-line caption (Archetype-1 DNA).
- Success/error feedback = the `NoteLine` idiom (one line + dot) or a haptic — toasts
  only for cross-screen consequences.

## Chat components (summary — full spec in `chat.md`)

Header identity bar (avatar + two-line identity + kebab menu with in-place
sub-levels) · message bubbles with inline meta · docked composer (attach + input +
send only) · the two-step stop + the centered confirm (R118-D).
