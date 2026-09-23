<!-- last-reviewed: 2026-09-23 round-120 -->

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
| **Fitted label** (R119-P) | `ChromeButton labelFit` — `numberOfLines 1` + `adjustsFontSizeToFit`, `minimumFontScale 0.85`, horizontal padding xl→md while on | Two `flex:1` peers at 360dp where a 15px bold label line-breaks (the provider hero's "Test connection" — the owner's report). Opt-in: every other call site wraps as before |

Labels: 1–3 words. No sentence buttons. No glow, no gradient washes, no Apple-y shine.

**Round-120 amendment (R120-S) — the sheen is deleted everywhere:** the
owner's report — a "glowing effect around the text" on the Add-a-Provider
CTA, "ugly and bad" — killed the R117-g1 whisper-sheen for good:
ChromeButton's `sheen` prop NO LONGER EXISTS (the quiet-solid fill —
`accentDeep` fill + `accentText` label — is the whole button; tsc proves no
caller passes sheen). `LinearGradient` survives ONLY inside ChromeEdge. Both
the Add-a-Provider CTA and Create Provider inherit the flat family — the
round-115 "no sheen" law is now enforced by deletion, not discipline.

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
  same-weight outlined rows. **R119-P:** the primary opts into `labelFit` so the
  pair's ~144dp share at 360dp never wraps the label (see §Buttons).
  **R120-M amendment (round-120 §1 items 10-13):** the hero's ONE context line
  under the name IS THE BASE URL itself (the "Chat Completion API" label is
  dead — the owner: "replace with the **base URL directly**, no heading"; it
  rides `TypeMono` `identityBaseUrl`), the on/off `ClaySwitch` sits in the
  TITLE ROW's RIGHT (never beside the base URL), and "Rename" reads **"Edit"**
  (the sheet it opens edits the name AND the base URL); the actions pair rides
  the quiet-solid flat CTAs (labelFit on the primary).
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
- **Round-116 mechanics (amended R119-P — the timed legs, the content ride,
  and the start-arm are SUPERSEDED by R120-S's final spelling below; the
  spring, the clamp, the skirt, and the overscroll law stand):** the entrance rides the SHEET spring —
  **now the house disclosure settle `{180, 24}`** (R119-P supersedes the stiffer
  `{210, 30}` snap-cut; the owner's verdict on the Add-Provider sheet: "the
  animations were not that good") — one soft settle, never a jelly bounce; the
  progress value stays clamped so the panel can never dip below its rest, the
  below-the-fold skirt stays so the page background is never visible under it even
  mid-animation, and the inner ScrollView keeps `overScrollMode="never"` (no
  Android stretch). The timed legs are named constants: the scrim fades in **200ms
  ease-out**, the close departs **200ms ease-in** on both legs, and the content row
  below the header fades in **120ms starting 40ms after the panel begins to move**
  (reduced motion snaps it; the first-frame static pose applies — `motion.md` §1).
  The keyboard ride inherits the settle (mechanics untouched — R118-E's law).
- **THE FINAL SHEET-MOTION SPELLING (R120-S — the round's sheet-motion
  authority; every sheet inherits):** the owner's verdict — the sheets are
  "stuttering, and they do not play in the proper time when needed" — was a
  START RACE and a TRAVEL defect, not a spring defect. The diagnosis: the
  entrance was armed in the same effect that mounts the Modal, so the spring
  burned its fastest frames while Android was still creating the dialog window
  (the sheet surfaced part-way up and finished its settle — "opens, then
  replays"); and the travel was computed off maxHeightFraction (~0.78 × window
  + 48 ≈ 670dp on a tall phone) instead of the panel's real height, so a
  settle tuned for a 300–400dp disclosure ran at ~2× velocity. The final
  spelling, all values frozen and pinned by `sheet-anatomy.test.ts`:
  - **Driver:** Reanimated shared values on the UI thread throughout (no RN
    Animated anywhere in the file — `useNativeDriver` is moot; translateY +
    opacity are native worklet-driven).
  - **Entrance:** armed from the Modal's own `onShow` (Android wires the
    Dialog's OnShowListener — the window exists, so the first VISIBLE frame
    is the first ANIMATED frame) with the `SHEET_SHOW_ARM_FALLBACK_MS` 150 JS
    guard so a platform that never fires onShow can never leave the sheet
    hanging below the fold; static poses before the arm (panel below fold at
    its travel, scrim 0).
  - **Panel leg:** `withSpring(1, SHEET_SPRING {180, 24})` — the house
    disclosure settle (ζ ≈ 0.894, ~0.6s) — traveling its MEASURED height:
    `sheetPanelTravelPx(measured, fallback)` = `measured > 0 ?
    round(measured) : round(fallback)`, the fallback
    `maxHeightFraction × window + 48` only for the pre-layout frames; the
    measured height is accepted only at progress rest 0|1.
  - **Scrim open:** `withTiming(1, 240ms, Easing.out(cubic))` — on the SAME
    frame as the panel (never a separate pipeline), completing as the settle
    lands (~300ms) so the dim and the rise read as one motion.
  - **Close:** BOTH legs `withTiming(0, 220ms, Easing.out(cubic))`, departing
    FRAME ONE (the R119 ease-in covered only 2.7% of the travel in two frames
    — the sheet lingered visibly before leaving); the panel's exact callback
    unmounts (runOnJS, reopen-race guarded — the Modal can never zombie past
    its own exit eating taps); 220 < 240 pinned so closing never outlasts the
    open's dim.
  - **Content ride — RETIRED:** `SHEET_CONTENT_FADE_MS`/`DELAY_MS` are
    DELETED from motion.ts (the absence is pinned); the R119 120ms/40ms fade
    was a patch on the start race — with the panel rising its own measured
    height the fold itself reveals the content top-first, and a late fade
    read as a pop. The panel's opacity is 1 throughout.
  - **Reduced motion:** the panel snaps (never travels), the scrim fade is
    the only animated leg; close snaps the panel, the scrim fades 220ms,
    unmount on its callback.
  - **Keyboard ride:** the R118-E mechanics byte-untouched, same
    `SHEET_SPRING`.
  - **FROZEN:** `SHEET_HEADER_ROW` 48, `SHEET_CHROME` 64, `SKIRT_PX` 28,
    the clamp + skirt + `overScrollMode="never"`, and the `maxHeightFraction`
    default (0.78) — none of these may move without a superseding amendment.
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
- **The add-provider flow routes through the sheet (R120-S, items 6+7):** the
  owner's rulings — the options "show at the bottom **without a dedicated
  background**" and tapping a provider option "must **NOT navigate directly**
  to the provider page." The options render INSIDE the Sheet's own clay panel
  (the dedicated background — key-pool-row grammar with inset hairlines,
  visually separated from the page; the old page-floating reveal wall is
  deleted), and the five PRESETS take the same bottom-up path as custom
  providers: pick in the sheet → the PresetConfig level (title = provider
  name, base URL prefilled/editable, key required) → `presetAddPlan` (pure:
  key check first, PATCH only on URL drift, cleared URL refused) → finish
  (close + reload). No `router.push` from an add flow.
- Sheet scroll area owns the full remaining height; content bottom padding ensures the
  page background is never visible through/below the panel.
- **Action menus with ≤4 actions render as a GRID** (2×2), not a vertical stack —
  round-116: the model menu (Test / Edit / Hide / Delete).
- **The model test's verdict reports the TOOLS leg (R119-P):** "Test model ✓"
  used to prove nothing about the agent's real call shape — the probe never sent
  tools, and the owner's TokenHarbor report showed exactly that gap (chat worked
  while every action failed). The probe's second leg carries ONE minimal tool
  (`echo`); the sheet renders the verdict as its own note line with the three
  honest spellings — **"tools ✓ (called echo)"** (saved) / **"tools accepted —
  answered in text, not called — usable for chat, not for agent actions"**
  (caution) / **"tools rejected — {the raw reason}"** (bad) — and a hard
  tools-rejection fails the whole test with the suffix "chat works, but every
  agent action will fail". A leg that never ran renders NO line, never a guess.

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
- **The level swaps animate (R119-B):** the owner asked for "some animation while
  switching between the menus" — the panel's BODY (title row + content) is keyed
  by level; a drill-in enters from the RIGHT (12dp slide + crossfade, 180ms
  ease-out) while the root mirrors out LEFT (120ms); going back reverses it (the
  sub-level exits RIGHT the way it came in). The direction derives from level
  DEPTH (root 0 / named sub-levels 1), never a per-menu flag; equal-depth swaps
  dissolve; reduced motion = the plain 120ms fade; the panel's own entrance
  spring + exit fade are untouched and frozen (`motion.md` §4.12).
- **The model level's provider accordion (R119-B):** the owner's ask — the model
  list "will show me only the provider names by default." ONE row per configured
  provider (display name + the right-aligned "{n} model(s)" caption + ChevronRight
  16, `accessibilityState expanded`), ONE section open at a time — tapping the
  open provider toggles it shut; the expanded rows are one-line model names with
  the accent Check on the selected one; a model tap applies-and-returns to main.
  The open section dies with the keyed level body's unmount (close/back reset it);
  the expansion is a 150ms content fade (the disclosure fade), reduced motion
  snaps. The level renders NO root rows of its own — the root rows can never
  trail beneath the provider list (the owner's exact defect report).

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

**Round-120 amendments (R120-P — the projects screen's sessions well, the
owner's items 24-27, round-120 §1 G):**

- **The identity chip:** every session row carries the `ClayIconChip` identity
  glyph on the left (MessageSquare 17 — the round-117 tinted chip) — a session
  row reads as a conversation, never a bare text line.
- **The alternating subtle wash:** ODD rows carry the resting `subtle` wash
  (4% ink — a step BELOW the `subtleHover` press tier, so pressing a tinted
  row still reads) — consecutive sessions are distinguishable at a glance
  (`index % 2 === 1`, the `folderBasename` inline precedent).
- **The CTA tier break:** the New Session button owns its own tier — the
  R118-B strong inset `Hairline` ABOVE it + the well-CTA margins (md over /
  sm under) — visibly separated from the list it creates.
- **"Type a path instead" is a real option row (item 24):** the sheet's
  OPTION-ROW family — Keyboard 16 `accentDeep` + TypeBody label + the subtle
  press fill + hairline border + `RADIUS_INPUT`, a real 46dp bordered target
  ("Create a folder here"'s own grammar; the Keyboard glyph the connect
  flow's manual pairing already owns) — never plain dead TypeMicro text.

## Banners, strips, empty states

- Offline/probing = one quiet strip (dot + one line) at the content top — never a
  modal banner.
- Empty state = centered icon + one-line title + one-line caption (Archetype-1 DNA).
- Success/error feedback = the `NoteLine` idiom (one line + dot) or a haptic — toasts
  only for cross-screen consequences. **(R120-M supersedes the toast clause — see
  §Toast: the sheet-verdict case IS the toast's job now; the NoteLine still owns
  persistent in-form verdicts.)**

## Toast (R120-M — the transient verdict strip)

The owner's ruling (round-120 §1 item 16): a failed model test and a
Hide-model action "show their details at the bottom of the sheet — they must
be a **toast that auto-dismisses in ~2s**." THE TOAST LAW
(`mobile/src/components/toast.tsx`, every constant pinned):

- **ONE transient verdict** — auto-dismisses in 2s (`TOAST_MS`); the newest
  toast REPLACES the one before it (never a stack, never a queue — these are
  one-line verdicts, not a log).
- **Placement is TOP** (below the status-bar inset): the bottom band belongs
  to the sheets these verdicts fire over and to the composer elsewhere — a
  bottom toast would collide with exactly the surfaces that trigger it.
- **Anatomy = the NoteLine grammar on a floating clay strip:** the semantic
  `StatusDot` + ONE caption (2 lines max, 140-char clamp —
  `TOAST_MAX_LINES`/`TOAST_TEXT_CAP`), card fill + `clayRim` hairline +
  `clayShadow2`, radius 14 — no icon walls, no action buttons (a toast never
  asks a question — sheets ask).
- **Motion = the quick crossfade family:** 180ms ease-out fade + an 8dp settle
  from above (`TOAST_ENTER_MS`); the exit a 120ms fade (`TOAST_EXIT_MS`);
  reduced motion snaps.
- **A Modal-hosted surface (a Sheet) renders its OWN `<ToastHost />` as the
  first child of its content:** RN Modals are separate native windows, so a
  toast fired while a sheet is open must render INSIDE the sheet's own tree to
  be visible; both hosts read the SAME provider state, so one `show()` serves
  whichever surface is showing.

## The model CONFIGURE SCREEN (R120-M)

The owner's items 15-22 (round-120 §1 F). "Edit Model" is a SCREEN
(`app/settings/providers/[id]/model.tsx` — the settings stack's own route),
never a sheet — the model editor's field count outgrew the sheet grammar
(a sheet asks ONE question; this is a form):

- **Save-before-add (item 22):** the model picker only ROUTES to the
  configure screen; the screen's explicit **Save** is the SINGLE commit —
  the list never grows before it (the owner: the "Add" button "commits the
  model to the list before 'Save Configuration'"). Tapping an
  add-custom-model SEARCH result opens the edit screen for that model too
  (item 19 — never a dead tap).
- **The smart fetch (item 20):** opening a model's configure page runs a
  bounded provider call (the /models or /models/{id} surface per format)
  that populates size / capabilities / context window / max output /
  input/output/cache-read prices behind a small loading strip (the
  smart-fetch strip — never a spinner); in **EDIT mode the apply is
  ONLY-BLANK** — the owner's saved configuration outranks the catalog, a
  blank field takes the provider's first served value, and a user typing
  while the fetch lands is never clobbered (any edit flips the apply to
  blank-only). A provider that serves nothing is a graceful no-op (a leg
  that never ran renders NO line, never a guess).
- **Numbers simplify on blur (item 17 — cosmetic only):** the
  context-window / max-output fields show **1M / 26K on blur**
  (`formatCompactCount`) and the full digits **on focus** — the draft keeps
  the EXACT string; the blurred form is the at-a-glance read, never the
  saved value.
- **The capability pills are SVG glyphs, ONE line (item 18):** eight
  hand-drawn 24×24 stroke glyphs (strokeWidth 1.8, round joins —
  text/vision/audio/video/pdf/image/tools/reasoning, `CAPABILITY_KINDS`),
  13px icon + 11px label per pill, the row NEVER wraps
  (`flexWrap: "nowrap"` + overflow hidden); each capability's hue resolves
  off the theme's OWN token hues (`capabilityHue` — no hardcoded colors,
  donts #12).
- **The reasoning ladder editor (item 21):** the levels ordered
  lowest→highest with the **+ button on the RIGHT of the highest rung**
  (add offers the shared vocabulary's remaining rungs through the
  Add-a-level sheet; delete per rung). The write gate:
  untouched-empty-unknown never written, touched-empty = an explicit
  supported:false, the default effort survives only on a standing rung.
- **The KeyActionsSheet menu grammar (item 14):** tapping an API-key row
  opens the bottom-up menu — Test / Replace / Copy key id / Remove /
  Add-key-here, all on existing routes — the inline right-side Test /
  Replace options are DEAD (donts #54). The model-actions sheet rides the
  same menu family + the toast law above (test failures and hide
  confirmations are toasts, never sheet-bottom detail blocks).

## Chat components (summary — full spec in `chat.md`)

Header identity bar (avatar + two-line identity + kebab menu with ANIMATED in-place
sub-levels + the model level's provider accordion — R119-B) · user bubbles with
inline meta (a queued row rides the same bubble idiom AFTER the in-progress turn,
never a banner — R119-A/C) · the **TurnBlock** — ONE clay container per assistant
turn: activity rail / recessed well / tool rows / reply (R119-A; the standalone
thinking/tool/assistant cards are retired as list items) · the single-tier docked
composer — input LEFT of the attach circle, always (R119-B) · the two-step stop +
the centered confirm (R118-D).
