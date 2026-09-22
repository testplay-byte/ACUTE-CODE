<!-- last-reviewed: 2026-09-22 round-118 -->
# R118-D — The session chrome + delivery spec

**STATUS: W1 foundations LANDED (de5ccc7)** — surfaceHeader token, QuietIconButton, LiveCaret; **W2 sheet LANDED (41bb654)**. Remaining: this spec's screen implementation.

Platform facts: RN 0.86.3, Expo ~57, reanimated 4.5.1, keyboard-controller ^1.22.5. **No `expo-blur`** — the "slight blur" is the token-level equivalent (the veil). **No centered-dialog primitive exists** — §2.6 creates the first.

## §1 Diagnosis

**Top bar** — `session/[id].tsx:968-1018`: a 56px headerRow inside the scaffold body — **no fill of its own, no bottom separator** (the page bg continues through it). Back chip = 44×44 + `ChevronLeft 26` (the "bracket"); gap after = spacing.xs 4. Below: LiveHeaderLine (2px accent bar breathing 550ms while a turn runs). The kebab menu anchor: absolute, top 56.

**Kebab menu** — `header-dropdown.tsx` (234 lines): anchored panel 220 wide, RADIUS_INPUT 14, clayShadow2, entrance scale 0.96→1 on SPRING, exit 120ms fade, presentation-only. The session screen feeds 4 rows + conditional Stop; **every row's onPress closes the dropdown and opens a bottom Sheet** (composer.tsx's mode/model/thinking/context sheets) — exactly what the owner rejected. The Stop row calls `onStop()` directly — one shot, no confirmation.

**Composer** — root hairline; `inputWrap` (flex:1, relative) → TextInput multiline minHeight 44, **paddingRight 52 on EVERY line** while the paperclip occupies only the bottom-right 36×36 band; **growth = controlled height** (`onContentSizeChange` → setInputHeight → explicit height style + flex:1 — the classic Android desync fragility); cap 125dp. Focus border = hairlineWidth (~0.33dp on 3×) — a tint whisper, not a ring. Running row: queueButton always mounted while running (dims to 0.45 when empty); stopButton = icon + "Stop" TEXT.

**Delivery machine** — `UserDeliveryStatus = "sending" | "sent" | "delivered | "failed"`: sending = optimistic/outbox/queued fold; **sent = the `turn.started` ack** (the PC's first word after accepting — the owner's "received by the PC"); delivered = the persisted fold; failed = the error frame. **No `processing` rung** — after the ack the bubble sits at sent until rehydrate. The marks: `DeliveryTick` (clock/single/double check/alert) in the bubble's clock row — takes inline space, four glyphs for states the body can carry. Item 46: nobody calls `blur()` when the IME hides (the R115-K listeners only write kbHeight).

## §2 The design

### §2.1 The top bar

**The chrome column wrapper** (in `[id].tsx`, zero scaffold changes):
```tsx
<View style={[styles.headerColumn, { backgroundColor: tokens.surfaceHeader, borderBottomColor: tokens.borderSubtle }]}>
  <View style={styles.headerRow}> … </View>
  <LiveHeaderLine live={turnLive} />
</View>
headerColumn: { marginTop: -insetsTop, paddingTop: insetsTop, borderBottomWidth: StyleSheet.hairlineWidth }
```
`surfaceHeader` = bg +6% warm ink light / +30% black dark (#E0E2DC / #17130F on Clay — LANDED in tokens). The negative margin pulls the fill through the status-bar inset. The separator = hairline borderSubtle; **LiveHeaderLine moves INSIDE the wrapper, absolutely positioned over the bottom edge** (`position absolute, left/right/bottom 0, height 2`) so the breathing bar replaces the hairline while a turn runs. Its rhythm byte-frozen.

**The back button:** `ChevronLeft 26` → the shared **QuietIconButton** (LANDED) `icon={ArrowLeft} iconSize={22} size={40}` + `marginRight: spacing.xs` (8dp total to the avatar). The kebab stays 44×44 Ellipsis 24.

### §2.2 The kebab's in-place sub-levels + the two-step stop

**State machine** (replaces `menuOpen`): `type SessionMenu = null | "main" | "mode" | "model" | "thinking" | "context"` + `stopArmed`. The `sheet` state stays for attach/files only.

**HeaderDropdown grammar extension** (still presentation-only):
- `onBack?: () => void` — when present, the title row renders a leading back chevron (ChevronLeft 18, 40×32 Pressable, hitSlop 8) + the title.
- `HeaderDropdownItem` gains `selected?: boolean` — a selected row swaps ChevronRight for **Check 16 accent**.
- `children?: React.ReactNode` — rendered under the title row (the Context readout).
- `contentMaxHeight?: number` — wraps the rows in a ScrollView when set.

**The levels:**
1. **Mode**: three rows Full Access / Ask / Plan (no descriptions — single-line law); selected = detail.permissionMode; onPress → `onPermissionModeChange(id)` → **`setMenu("main")`** (apply + return: the main rows display the live values — the feedback loop closes where the owner will look; the 90% flow is one adjustment; the back chevron remains for deliberate browsing).
2. **Model**: `contentMaxHeight: 360`; provider sections (TypeMicro header `{label} · {n} models` + rows via shortModelLabel, selected + Check); onPress → the snapshot's `pickModel(row)` → `setMenu("main")`. Busy: the existing sheetBusy row migrates in.
3. **Thinking**: rows = thinkingSpec.options; selected = displayedThinkingLevel; unsupported → one non-pressable caption row. onPress → `pickThinking(level)` → `setMenu("main")`.
4. **Context**: read-only — STAYS at its level (nothing to apply). children = the compact readout: `{pct}%` TypeBodyStrong + "of {formatTokens(window)} window"; the meter (height 4, track subtle, fill pct% colored by contextPressure); "used {used} · {available} available" caption; `{model} · {providerId}` TypeMono 10.5. `contentMaxHeight: 320`. The full ContextBreakdown sheet is deleted.

**The two-step stop:** the main level's Stop row while turnLive: not armed → "Stop this turn" (danger grammar unchanged) → onPress `setStopArmed(true)` — nothing stops. Armed → label flips IN PLACE to **"Do you want to stop?"** (the owner's copy) → onPress → close + reset + `stopTurn()`. stopArmed resets on menu close and when turnLive flips false.

**The data seam — `ComposerControlsSnapshot` v2**: the composer's report gains `modelSections: MenuModelSection[] | null` (derived off groupModelsByProvider + the in-play ladder), `thinkingOptions`, `thinkingUnsupported`, `thinkingSelected`, `contextReport`, and the stable pick callbacks `pickModel(row)` / `pickThinking(level)` (pickModel's trailing `onSheetChange(null)` DELETED — the menu owns these picks now). The screen's referential guard extends (scalar-compare the labels; reference-compare the memos).

### §2.3 The centered stop-confirm primitive

NEW `mobile/src/components/confirm-dialog.tsx`:
- Host: RN Modal transparent animationType="none" statusBar/navigationBarTranslucent onRequestClose={onCancel}; scrim 0.45/0.62 (the sheet tokens) 160ms in/out; scrim tap = cancel.
- Card: `width: min(320, windowWidth − 40)`, RADIUS_CARD 20, tokens.card, borderTop hairline clayTopEdge, clayShadow2, padding lg, gap sm, centered.
- Title TypeTitle (2 lines max); body TypeCaption (1 line); buttons one row flex 1 minHeight 46 radius 14: cancel = quiet outlined; confirm = filled **dangerDeep** (white ink light / #211B16 dark) label 15/700, `destructive` prop.
- Entrance scale 0.96→1 on SPRING origin center; exit 120ms fade; reduced motion snaps; `warningHaptic` on confirm only.
- Props: `{open, title, body?, confirmLabel, cancelLabel, destructive?, onConfirm, onCancel, testID}`.

**Wiring:** `[id].tsx` renames today's onStop body to `stopTurn`; the composer's `onStop` → `setStopConfirmOpen(true)`; the kebab's armed row calls `stopTurn()` directly (its two-step IS the confirmation).

### §2.4 The composer

- **Auto-grow — replace the controlled height with native growth**: DELETE the height style + flex:1 + the inputHeight state; `styles.input` gains `maxHeight: MAX_INPUT_HEIGHT` (6 lines: `6×21 + 10 + ATTACH_BAND 40 = 176`) keeping minHeight 44 — a multiline TextInput with only min/max grows natively and scrolls past the cap. `onContentSizeChange` survives ONLY to flip the boolean `inputTall` (threshold 24 — same arithmetic). `textAlignVertical: inputTall ? "top" : "center"`.
- **Bolder focus**: `borderWidth: focused ? 1.5 : StyleSheet.hairlineWidth`, color unchanged.
- **The two-tier attach geometry** (the same inputTall boundary the radius swaps at):
  | | resting | tall |
  |---|---|---|
  | paddingRight | 52 (button beside the line) | 16 — text full width |
  | paddingBottom | 10 | 40 (ATTACH_BAND — reserved band under the text) |
  | paperclip | absolute right 8 bottom 4 | same pin — lands inside the band |
- **Icon-only stop**: 50×50 circle, borderWidth 1 danger, Square 15 fill+color danger; the "Stop" Text and style DELETED. a11y label stays "Stop the running turn".
- **Conditional queue**: renders ONLY when `canSend` (draft.trim() !== "" || attachments.length > 0); the disabled arm + opacity 0.45 die.
- **Selection clear**: `KeyboardEvents.keyboardDidHide` → `inputRef.current?.blur()` (the draft persists; handles + selection clear). The R115-K dock architecture untouched.

### §2.5 The composer's sheet deletions

`mode`/`model`/`thinking`/`context` sheets + ModeOptionRow + ModelGroupedList + ProviderSection + Accordion + ContextBreakdown are DELETED from composer.tsx (the grouping memo feeds modelSections; the picks ride the snapshot; the context readout lives in the dropdown). attach/files sheets + the @-picker stay. `ComposerSheet` narrows to `"attach" | "files"`.

### §2.6 The delivery states — data model

`UserDeliveryStatus` becomes `"sending" | "sent" | "processing" | "delivered" | "failed"`:

| rung | the owner's stage | set where |
|---|---|---|
| sending | "dull UI" | beginLiveTurn / outbox / queued fold / user.queued — unchanged |
| sent | "received by the PC… normal" | the turn.started ack — unchanged |
| **processing** | "the PC has started processing… animated" | **NEW — the first content/progress frame after the ack** |
| delivered | settled | the persisted fold — unchanged |
| failed | the turn died | the error frame — the finder widens to `sending | sent | processing` |

**The promotion rule** (in `applyLiveFrame`, before the switch): any frame that is NOT turn.started / user.queued / queued.delivered flips the LAST item if it is a user card at `sent` → `processing` (exactly once — the guard reads `=== "sent"`). The remote mirror inherits free. No wire change, no server change.

### §2.7 The delivery states — the visuals

All in `UserBubble`. **DELETE the DeliveryTick + the clock row's tick arm + TICK_DOUBLE_OFFSET + the tick styles** — the clock row renders only `clock`. The state rides the body:

- **(a) sending — dull + veil**: fill tokens.card, edge tokens.border, top clayTopEdge (the queued arm's colors, keyed on status); text textSecondary (the desaturation); the "slight blur" = **the veil**: `{absoluteFill, backgroundColor: tokens.bg, opacity: 0.12, borderRadius: the bubble's, pointerEvents none}` (RN has no View blur filter and expo-blur is not installed — the veil + desaturated palette reads as the same soft haze). The queued Badge survives ONLY for genuinely offline rows.
- **(b) sent + delivered — normal**: byte-identical to today's settled bubble (tintedFill 0.16 / tintedEdge 0.34 / tokens.text).
- **(c) processing — the breathing accent edge**: normal fill; the bubble's borderColor breathes — `interpolateColor(pulse, [0,1], [mixHex(card,accent,0.34), mixHex(card,accent,0.62)])` at **550ms legs** (the caret/LiveHeaderLine rhythm). Reduced motion: static 0.55 mix. The bubble's View becomes an Animated.View for this row only.
- **(d) failed — normal colors + the tell**: fill tintedFill, edge `mixHex(card, danger, 0.22)`, NO glyph — the error card below carries the alert + the existing Retry (untouched).

a11y: the bubble's label appends the rung word. Export `deliveryVisualRung(status)` for the tests.

## §3 Migration map

| File | Change |
|---|---|
| tokens.ts | DONE (surfaceHeader) |
| primitives.tsx | DONE (QuietIconButton, LiveCaret) |
| confirm-dialog.tsx | NEW |
| header-dropdown.tsx | onBack, selected, children, contentMaxHeight |
| session/[id].tsx | headerColumn wrapper; ArrowLeft back; the menu state machine + stopArmed; stopTurn rename + ConfirmDialog; snapshot guard extension |
| composer.tsx | native auto-grow; 1.5dp focus; two-tier geometry; icon-only stop; conditional queue; didHide blur; snapshot v2; sheet deletions |
| transcript.tsx | DELETE DeliveryTick; the four treatments; deliveryVisualRung; the private Caret → shared LiveCaret import (track B's extraction); a11y rung words |
| sessions.ts | the processing rung + promotion rule + widened finder (~15 lines) |

Order: confirm-dialog + header-dropdown → sessions.ts → transcript → composer → session screen → tests → docs.

## §4 Doc amendments (drafted — land with W11)

- chat.md §Header: the back arrow (QuietIconButton 40, ArrowLeft 22); the surfaceHeader fill + hairline separator + the live line overlay.
- chat.md §Composer: native growth (44→176), 1.5dp ring, the two-tier attach band, icon-only stop, conditional queue, the centered confirm.
- chat.md (supersede the Delivery ticks bullet): **Delivery rides the message body** — dull+veil / normal / breathing edge / failed+danger-edge; the tick ladder is RETIRED.
- chat.md §Kebab: the in-place sub-levels + apply-and-return + the two-step stop.
- components.md: Quiet icon button row; Dialogs (centered) section; §Dropdown menus gains sub-levels.
- motion.md: the delivery edge rhythm; the centered dialog entrance.
- donts.md: #6 reworded (ArrowLeft, never the chevron bracket); #43-45 additions (state glyphs duplicate the body; one-shot destructive rows; controls without content).

## §5 Verification

1. sessions.test.ts (extend): turn.started → "sent"; **NEW** text-delta after the ack → "processing" (exactly once); turn.started itself never promotes; user.queued/queued.delivered never promote; the error frame flips a "processing" item to "failed".
2. composer.test.ts (extend): the snapshot v2 surface (10 fields); `ComposerSheet === "attach" | "files"`; ComposerProps unchanged; the constants pin (INPUT_MAX_LINES 6, MAX_INPUT_HEIGHT 176, ATTACH_BAND 40, INPUT_TALL_THRESHOLD 24).
3. NEW header-dropdown.test.ts: the prop surface; PANEL_WIDTH 220 / EXIT_FADE_MS 120 / ENTRANCE_SCALE 0.96.
4. NEW confirm-dialog.test.ts: the prop surface; the geometry arithmetic.
5. transcript: deliveryVisualRung pins; the veil opacity 0.12; the edge mixes (0.34/0.62/0.55).
6. The surfaceHeader + danger-pair contrast pins (extend contrast.test.ts).
7. Gates: tsc, full jest, root eslint on touched files, docs:check; on-device screenshots (bar at rest / content touching the separator / sub-level open / armed stop / tall composer / the sending→processing sequence).

## §6 Do-not-touch

The user bubble's resting tint 0.16/0.34 (the pulse animates the EDGE only); the composer well + send circle; the transcript pipeline memoization (R117-f); the streaming machinery (the rung is one status flip); the R115-K keyboard architecture (the dock + ADJUST_NOTHING — the didHide listener adds only); the Sheet primitive's mechanics; the attach/files sheets + the @-picker + the upload pipeline + the outbox semantics + composer-prefs keys; the scaffold (zero shared-file changes — the header column lands in [id].tsx); the kebab control itself + the LiveHeaderLine grammar; the events wiring.
