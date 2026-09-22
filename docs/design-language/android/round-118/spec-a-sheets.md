<!-- last-reviewed: 2026-09-22 round-118 -->
# R118-A — The sheet system spec

**Scope:** the universal bottom-sheet system for round 118 (owner's report §1 items 27–32, §H 23–26, §J 33). Binding law: the three laws + `01-foundations` + `02-patterns` + `03-rules`; every amendment this spec makes is flagged **AMENDMENT** and lands with the implementation wave per README's amendment rule. Environment facts verified: `react-native-reanimated 4.5.1`, `react-native 0.86.3`, Expo 57 (Fabric/new arch).

**STATUS: W1+W2 LANDED (commits de5ccc7, 41bb654)** — the static initial pose, the header row + QuietIconButton close, the grip deletion, and the keyboard layer are implemented in sheet.tsx. This spec's REMAINING scope is §3's call-site migrations (the field patterns, the segmented controls, the centered CTAs) — split across the track-D agent (composer attach/files) and the track-E agent (provider/project sheets).

## §1 — Diagnosis

### 1.1 The animation race, at the frame level

The owner's words: *"when it opens up, it does not open up with an animation. It just directly opens up from the bottom. Then after a small while, then it plays the animation and then stops."* That is a **first-commit initial-style race**:

- `sheet.tsx:102` — `const panelProgress = useSharedValue(0);` — rest for the animated transform is `translateY = 0` (the panel's **open** pose), because the interpolation maps `[0,1] → [panelTravel, 0]`.
- When `open` flips true, the effect calls `setRendered(true)`, which mounts the `<Modal visible …>` content **one commit later**; the same effect then starts `panelProgress.value = withSpring(1, SHEET_SPRING)`.
- The Modal (`animationType="none"`) surfaces a **new native Android window** (a Dialog). Its first frame can composite **before Reanimated's UI thread has attached the animated props** — and `useAnimatedStyle`'s JS-side return for that first commit is an **empty style object**. A view with no `transform` renders at its layout position; a scrim view with no `opacity` renders at opacity 1.

So the visible sequence on device is: (1) frame 0–2: panel painted at layout position — anchored to the bottom, i.e. **fully open at rest** — and the scrim painted at opacity 1; (2) a few frames later: the worklet attaches, panel snaps below the fold, scrim snaps to 0; (3) the spring carries 0 → 1. "Opens, then replays." The exit path never flashes (values already attached) — matching the owner's report exactly.

**The fix (implemented in W2):** static last-wins fallback styles on the same style props — a plain `transform: [{ translateY: panelTravel }]` before the animated style (and `{ opacity: 0 }` before the scrim's). Deterministic, inert after frame one, survives remounts, costs two lines.

### 1.2 The header anatomy problems

Current row: `[grip 32×4] [TypeCaption title, flex 1] [X in a bare 44×44 transparent target]`.

- **The grip reads as a stray line** — the owner: *"on the left of that heading there was a simple line, which was not good."* Worse: it is a **lying affordance** — this sheet has no drag-to-dismiss gesture. A grab handle on a non-draggable Modal sheet is a redundant affordance (donts #3) and a state that lies (donts #20). **DELETED.**
- **The title is mistyped** — `TypeCaption` (12.5/500) for the sheet's headline; the app's header grammar is `TypeTitle` 20/700.
- **The X is naked chrome** — a bare 16px `X` in a transparent 44×44 target. The app's header chrome idiom is the **chip** (subtle fill + hairline borderSubtle) — *"just like how the back button is in our application."*

**The fix (implemented in W2):** header row 48px (SHEET_HEADER_ROW): TypeTitle 20/700 `tokens.text`, left, 1 line, tail-clip, flex 1 + `QuietIconButton` (the new shared primitive) `icon={X} size={18} circle={36} hitSlop={8}`.

### 1.3 The content-pattern audit — every call site, sins itemized

**15 `<Sheet>` instances total** (importers: `providers/index.tsx`, `providers/[id].tsx`, `projects.tsx`, `composer.tsx`):

| # | Site (file) | Title | Sins |
|---|---|---|---|
| 1 | `app/settings/providers/index.tsx:496` — CustomProviderSheet | "Custom provider" | **3 field captions**; **API format = 3 wrapping `Chip`s** (`flexWrap:"wrap"` — wraps to two rows on ≤390dp); CTA **full-width**; created-state CTA label **8 words** |
| 2 | `app/settings/providers/[id].tsx:829` — RenameProviderSheet | "Edit provider" | 2 captions; full-width CTA |
| 3 | `app/settings/providers/[id].tsx:947` — AddKeySheet | "Add an API key" | **Pre-field explainer block**; caption; full-width CTA |
| 4 | `app/settings/providers/[id].tsx:1050` — RemoveKeySheet | "Remove a key" | Consequence caption; destructive action in the **accent** CTA; full-width CTA + full-width QuietButton |
| 5 | `app/settings/providers/[id].tsx:1224` — ModelActionsSheet | model name | Title at TypeCaption; mono id block leads; confirm-box consequence line |
| 6 | `app/settings/providers/[id].tsx:1479` — EditModelSheet | "Edit model" | **8 field captions** + **2 footnote essays**; toggle caption; full-width CTA + full-width Cancel |
| 7 | `app/settings/providers/[id].tsx:1922` — AddModelSheet | "Add a model" | **Local `ModeChip` drift** (accent fill + accent border, not the house Chip); explainer captions ×3; full-width CTA |
| 8 | `app/(tabs)/projects.tsx:799` — NewProjectSheet | "New project" | Manual-path input is a **raw `TextInput` with NO focus state**; full-width CTA + full-width QuietButton |
| 9 | `app/(tabs)/projects.tsx:1113` — NewSessionSheet | "New session" | Name input raw `TextInput`; double-label grammar; mode **description caption**; full-width CTA |
| 10–15 | `src/components/composer.tsx` — attach/files/mode/model/thinking/context | various | attach carries a footnote essay; the mode/model/thinking/context sheets are **deleted by track D** (kebab in-place migration) — only attach/files remain as sheets |

Systemic: every form sheet stretches its CTA full-width; the two raw-TextInput sites lack the house focus ring.

## §2 — The design

### 2.1 The new Sheet anatomy (IMPLEMENTED)

```
┌──────────────────────────────────────────────┐  crown: RADIUS_TILE 24,
│  HEADER ROW (48, gap sm)                     │  borderTop hairline clayTopEdge,
│  Title — TypeTitle 20/700, −0.2   [ ( ✕ )36 ]│  bg tokens.card,
├──────────────────────────────────────────────┤  boxShadow clayShadowSheet,
│  CONTENT (ScrollView, maxHeight clamp)       │  skirt hangs below the fold
│    SheetField: label (11/600 caps) above     │  (R116-b, frozen);
│    ClayInput; SegmentedControl; CTA zone     │  keyboard rides the panel
│    (ChromeButton centered, minWidth 200;     │  (R118-E, landed W2)
│    QuietButton centered beneath)             │
└──────────────────────────────────────────────┘
```

### 2.2 The house field recipe — `SheetField` = `ClayInput`, captions banned

**No new input primitive.** `ClayInput` already IS the house field (label above: TYPE_MICRO 11/600 uppercase, letterSpacing 0.8, textSecondary; input: inputBg, hairline inputBorder → accent on focus, RADIUS_INPUT 14, TYPE_BODY 15, minHeight 50; placeholder textTertiary).

**The R118-A law: inside sheets, `ClayInput` is used with `label` and NEVER `caption`, and no explanatory `TypeCaption`/`TypeMicro` block surrounds any field.** The raw `TextInput`s at `projects.tsx:991` (manual path) and `:1131` (session name) migrate to `ClayInput` (`mono` for the path), which also fixes their missing focus ring.

### 2.3 The segmented control (the primitive LANDED in W1)

`SegmentedControl<T>` in primitives.tsx: track 52 tall / radius 26 / 4 inset, `surfaceWell` fill + hairline `clayRim`; the sliding indicator = `accentDeep` fill, NO border (AA-clean as text: 4.98:1 light / 6.30:1 dark), gliding in index space on TAB_SPRING; selected label 15/700 `accentText`, unselected 15/600 `textSecondary`; segments carry minHeight 44; a11y full names; API = `{options, selectedId, onSelect, testID}` — **nothing else** (the vocabulary pin keeps descriptions out).

**The API-format selector (add-provider sheet):** `options` = `Chat` / `Anthropic` / `Responses` with a11y labels `Chat completions` / `Anthropic messages` / `Responses`; testIDs `api-format-{id}` (preserving the current contract). Width check at 360dp: ~106dp per segment — all three labels fit on one line.

**Same primitive serves:** the New Session sheet's operating mode (`Full`/`Ask`/`Plan`, a11y labels carrying "runs without asking" / "asks before acting" / "writes a plan first") and the add-model sheet's catalog/custom pair (`Catalog`/`Custom`).

### 2.4 The CTA zone — centered, self-sized, house recipe

- **Primary CTA = `ChromeButton`** with `style={{ alignSelf: "center", minWidth: SHEET_CTA_MIN_W (200) }}`.
- **Destructive confirms** (`RemoveKeySheet`): `ChromeButton tone="danger"` (LANDED in W1) — fill `dangerDeep` (#DC2626/#F87171), label white/ink (4.83:1/6.15:1).
- **Quiet escapes** ("Keep it", "Cancel", "Select another folder"): `QuietButton` with `style={{ alignSelf: "center" }}` — natural width, centered beneath the primary, gap sm.
- Labels stay ≤ 3 words ("Create provider", "Save key", "Remove key", "Save model", "Done").

### 2.5 Material values (unchanged — R117-g3 is good)

Scrim 0.45/0.62; crown RADIUS_TILE; panel card + clayTopEdge + clayShadowSheet; SHEET_SPRING 210/30; scrim 160ms / exit 180ms. The only material change is the grip's deletion.

## §3 — The migration map (REMAINING WORK)

| Site | Changes beyond the landed W2 |
|---|---|
| **CustomProviderSheet** (`providers/index.tsx`) | Delete all 3 `caption`s; API format: replace the wrapping `Chip` row + `fieldWrap`/`fieldLabel`/`formatRow` styles with `SegmentedControl`; CTA → centered minWidth 200; created-state CTA label → **"Done"** |
| **RenameProviderSheet** (`providers/[id].tsx`) | Delete both captions; CTA centered |
| **AddKeySheet** | Delete the slot-explainer block and the caption; CTA centered |
| **RemoveKeySheet** | Delete the consequence caption; "Remove key" → `ChromeButton tone="danger"` centered; "Keep it" → QuietButton centered |
| **ModelActionsSheet** | Title renders at TypeTitle with tail-clip (the Sheet header does this automatically — pass the model display name as `title`); keep the mono id + provider micro block and the 2×2 ActionTile grid; delete the confirm-box consequence line; no CTA zone |
| **EditModelSheet** | Delete all 8 captions + both footnote essays + the toggle caption; keep section kickers and the live preview strip; CTA centered; Cancel → centered QuietButton |
| **AddModelSheet** | Delete the local `ModeChip` → `SegmentedControl` ("Catalog"/"Custom"); delete the three explainer captions; keep the honest truncation note; CTA centered |
| **NewProjectSheet** (`projects.tsx`) | Manual-path raw `TextInput` → `ClayInput` `mono`; CTA centered; "Select another folder" → centered QuietButton; folder-browser mechanics frozen; keyboard-awareness landed in W2 |
| **NewSessionSheet** | Name raw `TextInput` → `ClayInput` (label "Name", placeholder "auto-titled from the first message", no caption); "Operating mode" → `SegmentedControl`; delete the mode caption; CTA centered; project context row keeps |
| **Composer sheets** (track D) | attach: delete the "typing '@'…" footnote; mode/model/thinking/context sheets DIE at D's hand |

## §4 — Doc amendments (drafted — land with W11)

**`02-patterns/components.md` §Sheets — replace with:** header row 48 (TypeTitle + 36px QuietIconButton close, NO grip); content ClayInput fields (label above, **captions banned in sheets**), SegmentedControl for one-line N-way choices, centered self-sized CTA (minWidth 200; destructive = danger tone; quiet escapes centered beneath); the **first-frame law** (every Modal-hosted animated surface carries a static initial pose); round-115/116 mechanics unchanged; a sheet asks ONE question.

**§Buttons — add rows:** Icon-circle (quiet) `QuietIconButton` 36/40/44; Sheet CTA (centered minWidth 200; tone="danger").

**`01-foundations/tokens.md` §3/§5**: sheet padding 16; the four new geometry constants.

**`01-foundations/motion.md`**: §2 gains the static-initial-pose law; §5 "Sheet chrome (header row)".

**`01-foundations/typography.md`**: TypeTitle gains "sheet headers"; field-hint row gains "never inside sheets".

**`03-rules/donts.md` — Round-118 additions:**
42. Field captions/description blocks inside sheets — label + input only.
43. Segmented options that wrap or hide — 2–4 choices on ONE line, all visible.
44. Full-width CTAs in sheets — centered, minWidth 200, self-sized.
45. Grab handles on non-draggable sheets.

**`03-rules/checklist.md`**: sheets carry the static initial pose; no sheet field captions; selectors one-line/all-visible; CTA centered; close = the circle chip.

**`round-117-elevation.md` §2.2 Sheet line** — append: "*R118-A supersedes the grip clause (deleted); all other values stand.*"

## §5 — Verification

1. `src/components/__tests__/sheet.test.ts` — type-only SheetProps pins: `{open, onClose, title, children, maxHeightFraction, testID}`.
2. `src/components/__tests__/segmented-control.test.ts` — prop vocabulary exactly `{options, selectedId, onSelect, testID}` (no caption can creep in); option items `{id, label, accessibilityLabel?}`.
3. `src/components/__tests__/quiet-icon-button.test.ts` — size union exactly `36 | 40 | 44`; vocabulary `{icon, iconSize, size, onPress, accessibilityLabel, hitSlop, testID}`.
4. `src/design/__tests__/sheet-anatomy.test.ts` — `SHEET_HEADER_ROW + spacing.sm + spacing.xs + 4 === 64`; `SEGMENT_TRACK_H − SEGMENT_INSET×2 === TOUCH_TARGET`; `SHEET_CTA_MIN_W === 200`; three-segment fit ≥ 90dp at 360.
5. `contrast.test.ts` — the danger-CTA pair pins (white on #DC2626 ≥ 4.5:1; #211B16 on #F87171 ≥ 4.5:1).
6. On-device: step frames of the add-provider open — no frame shows the panel at rest before the rise; dark + light; the three-segment row on a 360dp profile.

## §6 — Do-not-touch (frozen)

The R116-b skirt/clamp/spring/timings, the Modal host + onRequestClose, the a11y contract, the R117-g3 material values, the business logic at every call site (slot math, validation, haptics, busy/created states, hydrate edges, the folder browser, the catalog flow, the 2×2 action grid, NoteLines, preview strips).
