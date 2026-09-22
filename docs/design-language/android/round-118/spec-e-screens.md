<!-- last-reviewed: 2026-09-22 round-118 -->
# R118-E — The providers + projects spec

**STATUS: W1 foundations LANDED (de5ccc7)** — SectionHeader large, ChromeButton tone/accessibilityExpanded, Hairline strong, the R118 constants; **W2 sheet keyboard layer LANDED (41bb654)**. Remaining: this spec's screens + sheets + the mkdir route.

## §1 Diagnosis

### A. Providers list (`providers/index.tsx`, 644 lines)
1. "Your Providers" renders `SectionHeader` = 16/700 — a full ladder step under the screen's own chrome title (20/700).
2. Provider names: `TypeBodyStrong` = 15/600 — mid-weight; the owner wants 700.
3. The tier break: hairline + marginVertical 12 ≈ 25px total — indistinguishable from the 12px intra-group rhythm.
4. `AddProviderAction`: a full-width outlined list-row doing a CTA's job (32×32 icon tile + label + flex 1). **Adjacent bug**: the zero-providers branch renders EmptyState whose caption points at an affordance that is NOT on screen.

### B. Provider detail (`providers/[id].tsx`, 2490 lines)
5. The top: one undifferentiated `ClayCard elevated` — a NEUTRAL ghost identity tile (the list's name-hash hue is lost), name at 15/600, baseUrl at TypeMono 11/15 (below the mono ladder's 13), a three-data machine micro-line, the enabled switch, and TWO same-weight 48px outlined ActionRows (Rename + Test connection) — the primary action renders as a quiet peer. No zones, no hierarchy.
6. Test model on mobile is complete (tile spinner + persistent NoteLine verdict) — the PC half is track F's.
7. `SavedModelRow` line 2 = the raw `modelId` TypeMono under the clean name (the owner: "It should not show the model ID. It should only show the model name."). The ModelActionsSheet's mono block STAYS (the detail surface — machine truth belongs there).
8. The edit-model sheet's internals = track A's.

### C. Projects (`projects.tsx`, 1347 lines)
10. The collapsed ProjectRowCard — KEEP (the owner is satisfied).
11. `NewProjectActionRow`: `width: "48%"`, hairline, FolderPlus + label in textSecondary — a muted half-width outline, not the house CTA.
14. `SessionRow`: rows in a `tokens.subtle` well, flush-left, 48px, NO dividers; meta = time+subRole only; the row's `selectedModel` is never shown.
15. The new-session row: a bespoke full-width tinted-outline grammar.
12. **Folder creation DOES NOT EXIST**: `fs-browse.ts` has exactly one call (`GET /system/fs/browse`); no mkdir route exists in agent-core; `POST /projects` statSync-validates the root and 404s on a fresh folder — a new folder genuinely cannot become a project today.
13. The manual path is a raw TextInput at the BOTTOM of the sheet's ScrollView; the RN Modal dialog window doesn't resize on Android → the IME paints over it. The sheet is now keyboard-aware (W2); the input itself needs the ClayInput migration.

## §2 The design

### 2A. The providers list

- **A1**: `SectionHeader large` (LANDED) on "Your providers".
- **A2**: configured names → `fontFamily.bold` override (15/700); the revealed preset/custom rows keep 600 (the inventory is primary, the catalog is suggestion).
- **A3**: the tier break → `<Hairline strong inset={spacing.md} style={{ marginVertical: spacing.xl }} />` (the full break ≈ 65px).
- **A4**: `AddProviderAction` deleted → `<ChromeButton onPress accessibilityLabel="Add a provider" accessibilityExpanded={addOpen} style={{alignSelf:"center", minWidth: PAGE_CTA_MIN_W}}>Add a provider</ChromeButton>` (the same CTA grammar in all three states — empty / configured-only / mixed; the reveal stagger keeps; the icon dies).

### 2B. The provider detail page — hero → keys → models

**B1 The hero card** (still ClayCard elevated):
- Head row: **identity tile 48×48 r16 in `modelColor(provider.name)` + `Server 24` in the tile's contrast ink** (the list's color coding carried onto the page); name at **TypeTitle 20/700** (flexShrink 1, 1 line) + one context line TypeCaption: `apiFormatLabel` ("Chat completions API" / "Anthropic messages API" / "Responses API"; omitted when empty); the ClaySwitch trailing (unchanged).
- `enabledNote` NoteLine; **hairline zone divider**; **the BASE-URL strip**: "BASE URL" TypeMicro 11/600 uppercase 0.8 tertiary label above a one-line TypeMono **13/19** value (tail-ellipsized) — the `kind · apiFormat · keyCount` machine line DIES (kind → the scaffold subtitle; format → the context line; key truth → the keys section).
- Hairline; **the actions row**: `ChromeButton "Test connection"` `flex:1` busy={testing} (label swaps "testing…") + `QuietButton "Rename"` `flex:1 minHeight 50`. `testNote` NoteLine under the row.

**B2 The API keys section**: SectionHeader standard; ClayCard paddingVertical sm; slot rows (paddingHorizontal lg, paddingVertical md, minHeight 72): **key tile 32×32 r11** — hasKey → accentTint + KeyRound 16 accentDeep; empty → surfaceWell + tertiary glyph; title TypeBodyStrong ("Primary key" / "Key N") + Badge neutral "empty" when !hasKey; **one mono meta line** (TypeMono 12/18): hasKey → `{mask ?? "••••••••"}{lastUsedAt ? ` · used ${timeAgoShort(...)}` : ""}`; empty → "—"; trailing compact QuietButtons (minHeight 36, caption-size): "Test" (busy label-swap) always when hasKey; slot 0 → "Replace"; slots ≥ 1 → "Remove" (danger). **Inset hairlines between rows** (`poolRule` gains marginHorizontal lg) + a final rule. The add-key row: accentTint tile + Plus + "Add a key" TypeBodyStrong — **the caption line is DELETED**. `ProviderKeySlot` grows `lastUsedAt?: string | null` (optional — an older sidecar degrades to the mask-only line; the pool route extension is an optional interlock, not a shipping requirement).

**B3 The models list — NAME-only**: DELETE the modelId TypeMono line from `SavedModelRow` (line 1 = label + capability chips + hidden Badge; line 2 = the facts line mono 11 tertiary — unchanged). No status dot (no durable per-model status exists — a resting dot would lie). The add-model row migrates to the accentTint tile.

**The pure module** `mobile/src/features/provider-display.ts`: `modelRowLabel` (displayName ?? cleanModelName — never the raw id), `modelFactsLine`, `keySlotMetaLine`, `apiFormatLabel` — all pure, all tested. `timeAgoShort` hoists to `mobile/src/lib/time-ago.ts`.

### 2C. The projects screen

- **C1**: `NewProjectActionRow` deleted → `<ChromeButton style={{alignSelf:"center", minWidth: PAGE_CTA_MIN_W}}>New project</ChromeButton>` at both call sites (empty state + list bottom).
- **C2 the sessions well + rows**: the well → `surfaceWell` + hairline clayRim + RADIUS_INPUT, margins sm, paddingVertical xs, gap 0 (dividers own the rhythm). The row: paddingLeft md, paddingRight md, paddingVertical sm+2, minHeight 52; title (today's 14/600 recipe, 1 line); **the meta line**: running → StatusDot 6 pulse (unchanged); `cleanModelName(selectedModel.model)` in textSecondary + ` · {timeAgoShort(updatedAt)}{subRole ? ` · ${subRole}` : ""}` in tertiary; the status Badge logic unchanged (non-"open" only). **1dp inset dividers between rows** (borderSubtle, marginLeft md — the dashboard spec uses borderStrong in the recessed well; RECONCILE at implementation: one spelling, the strong recipe). The "+N more" row gains paddingLeft md.
- **C3**: the new-session tinted row deleted → `<ChromeButton style={{alignSelf:"center", minWidth: PAGE_CTA_MIN_W}}>New session</ChromeButton>` inside the well (marginTop sm).

### 2D. The folder browser — create-folder

**The affordance — the FIRST row of the folder list** (rendered whenever the browse loaded, including the empty state):
- Collapsed: row height 46, paddingHorizontal md, gap sm: FolderPlus 16 accentDeep + TypeBody 14 accentDeep "Create a folder here"; a hairline rule separates it from the dirs below; press fill subtle; a11y "Create a folder inside {crumb}"; testID `new-project-create-folder`.
- **The inline namer** (tap → the row expands in place; no sheet): a row (gap sm, paddingVertical sm): mono TextInput flex 1 (fontSize 13 mono, the fieldInput surface, radius 14, minHeight 44, placeholder "folder name", autoFocus, autoCapitalize none, returnKeyType done, onSubmitEditing = create) + **Check circle 36** (accentDeep fill, Check 18 accentText) + **X quiet circle 36** (subtle fill, X 16 textSecondary). Under it when createError: TypeCaption danger 1 line ("a folder with that name already exists", "the host is offline — the folder was not created", "this desktop's build lacks folder creation — update it, or type the path instead"). State: creating/createName/createBusy/createError; reset on every browse navigation + sheet open.
- **Create + select**: `folderNameValid` → `createFsFolder(sender, browse.path, name)` → on ok: successHaptic → **auto-select the new folder** (selectFolder(outcome.data.path) — the sheet flips to the SELECTED state with the new path) → background `browseTo(browse.path)`. One tap from "create" to "selected".

**The client** (`fs-browse.ts`, pure + injected sender):
```ts
export interface FsMkdirReply { path: string; name: string; dir: true }
export function folderNameValid(name): { ok: true; name } | { ok: false; message }  // trims; rejects "" · >60 · / or \ · "." ".." · leading "." · control chars
export function joinChildPath(parent, name): string  // the parent's own separator
export function createFsFolder(sender, parentPath, name): Promise<ApiOutcome<FsMkdirReply>>  // POST /system/fs/mkdir {parentPath, name} — bodyText JSON
```

**The server route — `POST /api/v1/system/fs/mkdir`** (agent-core/src/routes/system.ts, below the browse route): body `{parentPath, name}`; parentPath absolute + statSync isDirectory (404 NOT_FOUND / 400 VALIDATION — the browse route's error spelling); name validated like folderNameValid (400 VALIDATION field body.name); `mkdirSync(abs, {recursive: false})`; EEXIST → 409 CONFLICT; reply **201 `{path, name, dir: true}`** (the browse entry shape verbatim). **Trust model:** the R114-b ruling — a paired phone has config rights; the device-token blocklist blocks only reset/cloud-connector//internal///computer-use//keys/reveal//terminal — **mkdir is phone-reachable by construction**; no blocklist change.

### 2E. The keyboard-aware manual path (LANDED W2 — the sheet rides the IME)

The sheet's keyboard layer landed in W2. The manual path TextInput itself migrates to `ClayInput` `mono` (label "Folder path", placeholder = the current browse path, NO caption — track A's law). "Use this folder" → the centered ChromeButton CTA (testID `new-project-use-folder`).

## §3 Migration map

1. primitives.tsx — DONE W1 (SectionHeader large, ChromeButton accessibilityExpanded, PAGE_CTA_MIN_W).
2. providers/index.tsx — A1-A5 (+ the zero-state CTA).
3. providers/[id].tsx — the hero rebuild, keys rework, name-only model rows, the sheet migrations per spec A §3 (CustomProvider/Rename/AddKey/RemoveKey/ModelActions/EditModel/AddModel: captions die, SegmentedControl for API format + Catalog/Custom + session mode, centered CTAs, danger tone for RemoveKey).
4. projects.tsx — C1-C3 + the create-folder flow + the sheet migrations (NewProjectSheet/NewSessionSheet: ClayInput fields, SegmentedControl mode, centered CTAs, centered "Use this folder"/"Select another folder").
5. fs-browse.ts — the mkdir client.
6. NEW lib/time-ago.ts + NEW features/provider-display.ts.
7. config.ts — `ProviderKeySlot.lastUsedAt?`.
8. agent-core/src/routes/system.ts — the mkdir route.
9. Docs — §4 below.

## §4 Doc amendments (drafted — land with W11)

- components.md §Buttons: the **Self-sized page CTA** row (centered ChromeButton minWidth 200 — supersedes the half-width idiom; "New X", "Add a provider", "New session").
- components.md §Cards & rows: the **provider hero card** (three zones); **model rows are NAME-only** (the id lives on detail surfaces only); the key-pool row anatomy.
- components.md §Folder browser: the create-folder first row + inline namer + auto-select.
- screen-archetypes.md Archetype 2: the self-sized centered "New X"; the LARGE tier heading + the strong Hairline tier break; the sessions well (surfaceWell + dividers + the model NAME chip + honest badges — one shared anatomy with the dashboard).
- screen-archetypes.md Archetype 3: the three-zone hero.

## §5 Verification

1. `fs-browse.test.ts` (extend): createFsFolder's POST (path + bodyText JSON + the 201/409/400/404 outcomes); folderNameValid table; joinChildPath table (posix + Windows + trailing slashes).
2. NEW `provider-display.test.ts`: modelRowLabel (displayName wins; cleanModelName never equals the raw id — "openrouter/z-ai/glm-4.7:free" → "Glm 4.7"); modelFactsLine honesty table; keySlotMetaLine; apiFormatLabel.
3. NEW `time-ago.test.ts`: the timeAgoShort table.
4. NEW `fs-browse-create-flow.test.ts`: the created entry inserts dirs-first alphabetical; the auto-select target = the reply's path.
5. rhythm pins: PAGE_CTA_MIN_W 200; the section-break arithmetic; the key-slot mono cut 12/18.
6. Manual: the keyboard gate (the field + namer + CTA visible above the IME on tall + short sheets); the visual pass on both themes.

## §6 Do-not-touch

The sheets' internals beyond spec A's migration map; the QR/pairing flows; the model color coding; the project cards' collapsed look + the Accordion measurement system; the events-epoch machinery; splitProviders; nextFreeKeySlot; the POST body shapes; the session screen's R115-K keyboard architecture; the mobile test-status treatment. **Interlocks:** spec A (the shared sheet wave — LANDED); the mkdir route must ship in v0.112.0; the optional lastUsedAt pool extension; the PC test-model half = track F; the dashboard session-row spelling reconciles with §2C2 at implementation.
