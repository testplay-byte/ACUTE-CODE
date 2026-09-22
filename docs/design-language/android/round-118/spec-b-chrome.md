<!-- last-reviewed: 2026-09-22 round-118 -->
# R118-B — The chrome spec (tab bar + home + more + appearance + multi-host)

Round 118, track B. Binding law: the design-language folder + `round-117-elevation.md`'s quality bar; every supersession is flagged AMENDMENT.

**STATUS: W1 foundations LANDED (de5ccc7)** — tokens (chromeEdgeDark 0.22/0.08, surfaceHeader, the R118 constants), motion, primitives (ChromeEdge vertical + overflow, Hairline strong, QuietButton busy, QuietIconButton, SegmentedControl, LiveCaret, SectionHeader large, ChromeButton tone/accessibilityExpanded). **W2 sheet LANDED (41bb654).** The remaining work is this spec's screen-level implementation.

## §1 Diagnosis

**1. Corner artifact ("sticker pasted, sharp corners showing").**
The bar stacks: `tab-bar.tsx:197` `<View style={{ boxShadow: tokens.clayShadow2 }}>` — a **bare square View** with no borderRadius/background casting a **rectangular** shadow halo around the rounded 28 slab (iOS square shadowPath; Android square outline). Secondary: `ChromeEdge` drew its ramp **diagonally** (top-left light 0.85-white invisible on the white bar, bottom-right dark) — asymmetric smudgy corners. The proven pattern already ships: `ClayCard` puts backgroundColor + borderRadius + boxShadow + overflow on ONE view.

**2. Pill edge inset.** `edge = Math.min(center, barWidth - center) * 2 - 2` — for the FIRST/LAST tab the pill runs to within ~1px of the bar's edge and its effective padding collapses. No real inset exists.

**3. Pill fit ("Projects proper, Home isn't").** Same edge clamp: Projects (middle) gets honest 8px padding; Home's pill is clamped to ~65px for a ~80px chip → ~0.5px padding per side. Measurement recipes verified byte-identical — the clip is geometric, not typographic.

**4. "Approvals" cut off.** `styles.tab = { flex: 1 }` gives every slot `barWidth/5 ≈ 67px`; the active chip needs ~91px → `numberOfLines={1}` truncates regardless of the morph. Plus Android pixel-grid rounding can clip the last glyph at an exactly-measured maxWidth.

**5. The bar's border.** The square-shadow corners + the diagonal ramp's one-visible-corner smear. `tokens.md` §2 sanctions ChromeEdge for exactly this bar — the fix is re-cutting the ramp (LANDED: vertical, base 0.22/0.08).

**6. Live preview static.** Home's "Happening now" rows are static PressableCards; the sanctioned live idioms (motion.md §3 Live caret 8×15/0.25↔1/550ms; §4.5 breathe) exist but none appear on home.

**7. Bottom content flush.** `ScreenScaffold` pads `max(bottomPad, spacing.xl) + spacing.lg`; home passes no `bottomInset` though the prop exists.

**8. Dividers invisible.** More's stats rows: `borderSubtle` (0.06 ink) at hairlineWidth (0.33dp on 3×) = arithmetically invisible. Home's recent rows: no dividers at all.

**9. Mark-all-read fails instantly.** The exact chain:
- `app/activity.tsx:142-165` — `feedRef.current.markAllRead()`; the button only gets `disabled={marking}` — no spinner idiom on QuietButton (LANDED: busy).
- `src/features/activity.ts:365-377` — `apiJson(manager, "/notifications/read-all", { method: "POST" })` — **no `bodyText`**. Same at 351-362 (`markRead`). The app's only two bodyless POSTs.
- `AcuteNetModule.kt:244-252` — `requestBodyFor()`: POST without bodyText → `throw IllegalArgumentException` → rejected **before any socket opens** — "as soon as I clicked," the LIVE status never flinches, and the "Couldn't reach the desktop" note is a LIE for this failure class.
- House pattern for bodyless server routes: `{ method: "POST", bodyText: "{}" }` (sessions.ts:2001,2022). The server route is fine.

**10. More's top section.** App-identity only (name + version badge + build line + role line) — no live status, no connection identity. The status row lives on home; the connection row duplicates in settings. Three surfaces, one truth, scattered.

**11. Multi-host.** `host-store.ts` is single-host by design (one flat record, one device token, `savePairing` overwrites). `settings/host.tsx` documents the deferred seam: "`hosts: StoredHost[]` + an ACTIVE-host switcher". The connect hub carries manage + scan rows but no switcher.

## §2 The design

### 2.1 The tab bar

**Constants:** `TAB_INSET_X = 12` (NEW — the row's inset from the bar's inner edges), `PILL_PAD_X = 12` (was 8), `LABEL_EPSILON = 2` (NEW — measured label + 2px). TAB_SPRING/TAB_LABEL_MS/ICON_SIZEs/CHIP_GAP unchanged.

**The adaptive slot algorithm** — export a pure function `computeTabSlots({barWidth, tabCount, activeIndex, labelWidths})`:
```
avail  = barWidth - 2*TAB_INSET_X
equal  = barWidth / tabCount                    // the CAP
label  = labelWidth > 0 ? labelWidth + 2 : 0
chip   = ICON_SIZE_ACTIVE + CHIP_GAP + label    // the selected chip's natural width
selSlot = clamp(chip + 2*PILL_PAD_X, ICON_SIZE_ACTIVE + 2*PILL_PAD_X, avail - ICON_SIZE*(tabCount-1))
unselSlot = min(equal, (avail - selSlot) / (tabCount - 1))
slots = per-tab (selected ? selSlot : unselSlot); centers = prefix-sum + TAB_INSET_X + slotWidth/2
pillWidth = min(chip + 2*PILL_PAD_X, selSlot)
```
Worked numbers (360dp → barWidth 336): Home selSlot 91 / unsel 55.25; Approvals selSlot 119 → label budget 90 ≥ 64 — "Approvals" fits with 26px spare; More's pill sits 12px from the edge (was 1px). At 320dp every unselected slot still ≥ 38 ≥ ICON_SIZE.

**What animates:** the pill CENTER on TAB_SPRING (unchanged call, new center source); the pill WIDTH on TAB_LABEL_MS (the `edge` clamp DELETED — the slot math makes it unreachable); **NEW — per-slot widths**: the newly-selected slot animates `unselSlot → selSlot` on TAB_LABEL_MS; every other slot animates to the new unselSlot on the SAME timing (the row rebalances fluidly, icons glide). Mount pose (unmeasured): selected slot = `ICON_SIZE_ACTIVE + 2*PILL_PAD_X` = 47, others = equal split; the row blooms when `allMeasured` flips (the existing gate). Reduced motion snaps.

**Label:** `maxWidth` target = `labelWidth + LABEL_EPSILON`; add `ellipsizeMode="tail"` beside `numberOfLines={1}`.

**Row geometry:** `styles.bar` gains `paddingHorizontal: TAB_INSET_X`; the absolute pill + measurement row position in the bar's FULL-WIDTH coordinate space (absolute children ignore padding — keep the existing `indicatorStyle` derivation).

**The corner + border fix:**
1. Kill the square shadow wrapper — the wrapper gains the bar's geometry:
```tsx
<View style={{ borderRadius: 28, backgroundColor: tokens.card, boxShadow: tokens.clayShadow2 }}>
  <ChromeEdge radius={28}>   {/* the primitive now clips overflow itself (LANDED W1) */}
    <View style={[styles.bar, { width: barWidth }]}>…</View>
  </ChromeEdge>
</View>
```
2. ChromeEdge vertical ramp — LANDED in W1 (primitives + tokens).
3. Kept byte-frozen: the 2px accentDeep pill border + accentTint fill, borderRadius 18, top/bottom spacing.sm, badge grammar, alert breathe, keyboard slide-away, a11y contract, measurement row system.

### 2.2 Home

1. **LiveCaret on every running row** — append the shared primitive (LANDED W1) to the row's caption line (`{project} · {status}` TypeCaption) — `row + gap 4 + LiveCaret`.
2. **The section live dot** — "Happening now" SectionHeader gains a leading 6px dot, `tokens.running`, opacity breathe 0.55↔1 at 800ms legs (a local 3-line breathe or a `breathe` prop added to StatusDot with the calm rhythm); reduced-motion steady. The "Live" badge stays static.
3. **Bottom breathing:** `home.tsx:219` → `<ScreenScaffold … bottomInset={spacing.xxxl}>` (+32 — the scaffold's existing prop, zero scaffold changes).
4. **Dividers:** between the preview rows insert `<Hairline strong inset={spacing.md} />` inside the recent card; More's stats card gets the same between the three StatRows (delete `statsRowDivider`'s borderSubtle borderBottom). One recipe, both places, MORE visible: `borderStrong` at a full 1dp.

### 2.3 The mark-all-read fix

1. `src/features/activity.ts:353-355` and `:367-369` → `{ method: "POST", bodyText: "{}" }` (the Kotlin module's strictness stays — it caught a real bug).
2. The trying state: `activity.tsx` → `<QuietButton onPress={onMarkAllRead} disabled={marking} busy={marking}>` (QuietButton busy LANDED W1).

### 2.4 The More hero

`more.tsx`'s about card becomes ONE hero `PressableCard elevated` → `/connect`:
- Row 1 (the WHO): `ClayIconChip icon={Monitor} iconSize={22} size={48}` + TypeTitle `host.hostLabel` ("No desktop linked" when null) + ChevronRight 18 textTertiary.
- Row 2 (the status): StatusDot 10 (home's statusHue recipe) + TypeBodyStrong in statusHue + TypeCaption `· desktop v{version}` (or `· ACUTE companion`).
- Row 3: TypeMicro tertiary `ACUTE companion · v{APP_VERSION} · expo {EXPO_TAG}` — replaces the badge + build line. The role line dies.
- The unpaired hero: "No desktop linked" + danger dot + "Offline · tap to pair".

**Home's change:** the status row leaves; home renders a quiet strip ONLY while offline/probing (PressableCard → /connect: StatusDot + statusWord + "· messages will queue" — no host name). **Settings' change:** the connection row (`settings/index.tsx:51-91`) is DELETED — the hub starts at Appearance; `/settings/host` stays (the manage page).

### 2.5 The connections screen + multi-host

**Store — `host-store.ts`:**
- New keys: `acute.host.list` (JSON StoredHost[]), `acute.host.activeId`, per-host tokens `acute.device.token.<machineId>` (SecureStore). Migration on first read: legacy flat record → `list = [legacy]`, activeId = its machineId, token copied. Legacy keys dead.
- API: `listHosts()`, `readActiveHost()` (replaces readHost internally), `readDeviceToken(machineId?)`, `setActiveHost(machineId)` (pointer write), `savePairing(pairing)` (UPSERT + set active), `removeHost(machineId)` (splice; active falls to next or unpaired), `clear()`.

**`connection.ts`:** `start()` reads readActiveHost + its token; NEW `switchHost(machineId)` = teardown current link, swap host/token, probe fresh (subscribers see probing → connected/offline). One live link at a time. 401 removes only the ACTIVE host.

**UX — connect hub (`connect/index.tsx`), above "This connection":** a "Desktops" SectionHeader + one row per host (ClayIconChip Monitor 40 + TypeBodyStrong hostLabel + TypeCaption `paired {timeAgo}` + trailing: active → Badge success "Active"; inactive → ArrowLeftRight 18 + tap → switchHost with a 20dp ActivityIndicator while probing). Scan row copy: "Replaces this phone's link." → "Adds a desktop to this phone." `settings/host.tsx` disconnect → `removeHost(active)`.

### 2.6 Appearance (items 18-20)

- **18:** `appearance.tsx:309` `withSpring(activeIndex, SPRING)` → `withSpring(activeIndex, TAB_SPRING)` — the control's own comment claims the tab-pill grammar; it finally rides it.
- **19:** `ChatPrefRow` reworked: **captions die**; each row = label heading (TypeBodyStrong) on top, options BELOW as a chips row `flexWrap: "wrap", justifyContent: "center", gap: spacing.sm`, nearly full width. Dividers between rows sync to the strong recipe.
- **20:** delete the "synced across devices — applied live" TypeMicro footer.
- The local `ModeSegmentedControl` is DELETED — appearance adopts the shared `SegmentedControl` (LANDED W1) with options System/Dark/Light.

### 2.7 The scaffold-wide back button

`screen-scaffold.tsx` + `connect-header.tsx`: `ChevronLeft size={26}` → the shared `QuietIconButton icon={ArrowLeft} iconSize={22} size={40}` (gap after it via marginRight 4 + the row's gap = 8dp to the title). The session screen's own back button is track D's.

## §3 Migration map

1. `tab-bar.tsx` — computeTabSlots export; constants; row paddingHorizontal; animated per-slot widths; delete the edge clamp; label +2 & ellipsizeMode; rounded card-filled shadow wrapper.
2. `primitives.tsx` — DONE in W1.
3. `tokens.ts` — DONE in W1.
4. `transcript.tsx` — the private Caret → shared LiveCaret import (track D owns the file; D does the swap).
5. `home.tsx` — bottomInset; strong dividers; LiveCaret + section dot; status row → offline/probing-only strip.
6. `more.tsx` — the hero card; strong stats dividers.
7. `settings/index.tsx` — delete the connection row.
8. `connect/index.tsx` — the "Desktops" switcher; scan copy.
9. `settings/host.tsx` — removeHost semantics.
10. `host-store.ts` — multi-host + migration + API.
11. `connection.ts` — readActiveHost/per-host token; switchHost; 401 → active only.
12. `features/activity.ts` — bodyText "{}" on both POSTs.
13. `app/activity.tsx` — QuietButton busy.
14. `appearance.tsx` — TAB_SPRING via SegmentedControl adoption; chat-row rework; footer deletion.
15. `screen-scaffold.tsx` + `connect-header.tsx` — the ArrowLeft back.

## §4 Doc amendments (drafted — land with W11)

- components.md §Tab bar: the adaptive-slot anatomy (inset 12; selected slot = 23+6+label(+2)+2×12; unselected = equal-split capped at barWidth/N; pill centers in the selected slot — the edge clamp is gone; slots ride TAB_LABEL_MS; the bar's shadow/radius/fill on ONE rounded wrapper; ChromeEdge vertical).
- motion.md §4.7 AMENDMENT: the neighbors' slots rebalance on the label's own timing; the label's expanded maxWidth is measured+2px.
- tokens.md §2 AMENDMENT: the ramp runs vertically; the dark stop is 0.22/0.08.
- components.md §Cards & rows: the `Hairline strong` divider recipe.
- screen-archetypes.md §2: the list root's live strip is state-conditional; the WHO+status lives in the More hero.

## §5 Verification

1. NEW `tab-slots.test.ts` (pure computeTabSlots): selected slot arithmetic; unselected ≤ barWidth/N; sum + insets === barWidth; pill edges ≥ 12 from both bar edges for tabs 0 and N−1; min slot ≥ 22 at 320/360/411dp; the Approvals 62px label leaves ≥ 26px slack; unmeasured pose.
2. `activity.test.ts` (extend): markRead + markAllRead both send `bodyText: "{}"` with POST (the regression pin).
3. Hairline strong pin (1dp borderStrong) — the rhythm.test pattern.
4. `host-store.test.ts` (extend): upsert ×2 → list 2, active = second; setActiveHost flips; removeHost falls/empties; the legacy migration; key-set extended.
5. `connection.test.ts` (extend): switchHost closes/swap/probe; 401 removes only active.
6. Manual: corners at 200% zoom (no halo); Home/More/Approvals/Dashboard pills on 360dp; reduced motion; dark-mode corner parity; mark-all-read on a live host.

## §6 Do-not-touch

TAB_SPRING/TAB_LABEL_MS; the R116-b morph mechanics + measurement system; the a11y contract; the alert breathe; the keyboard slide-away; the pill's material; the scanner viewfinder; the sheet system (track A); the connect hub's broken-link hero; the CLAY material values except the flagged amendment; contrast pins; the link layer's transport/hysteresis/probe ladder (only the two bodyText legs + the store's shape change); AcuteNetModule.kt's strict body rule; home's data hooks.
