<!-- last-reviewed: 2026-09-21 round-116 -->

# Round 116 — the owner's v0.109.0 walkthrough: the polish round

The owner installed v0.109.0 on Windows, Android, and an off-LAN Linux VM. The Android
app + communication logic are this round's focus. His report, itemized, with the root
causes proven by analysis and the wave that owns each fix.

## §0 The owner's report, itemized

### The updater (NOTED, DEFERRED — see §4)

| # | Verdict | Disposition |
|---|---|---|
| U1 | Linux: "Restart and Update Now" → "Connecting to Agent Core" → restarted into the SAME 0.108 | Deferred to the updater round (§4) |
| U2 | Windows: manual experience, no auto-restart | Deferred (§4) |
| U3 | Future: incremental updates, not whole-app downloads | Deferred (§4) — the design note is written |

### Onboarding + connect (owner: "improvements which need to be handled better")

| # | Verdict | Root cause (verified) | Wave |
|---|---|---|---|
| 1 | Welcome tagline + all three card descriptions wrap to 2 lines — force ONE line | No `numberOfLines={1}` on any of them (welcome.tsx) | C |
| 2 | Get Started too minimal; show it higher, not bottommost | CTA pinned by `justifyContent: space-between`; `flat` ChromeButton is deliberately bare | C |
| 3 | Camera screen: Skip + Allow buttons must sit near the MIDDLE, not the bottom | `spacerBottom flex:1` after the footer pushes buttons down | C |
| 4 | Link-your-desktop description wraps | PairOptionCard descriptions have no single-line clamp | C |
| 5 | Unpaired home: TWO option cards at the bottom is bad — ONE "Connect to PC" button; title becomes "Currently not connected" with a BROKEN-connection animation; the button opens the scanner directly | connect/index.tsx unpaired branch (PairOptionsPair) | C |
| 6 | Scanner is ugly: PORTRAIT aspect viewfinder (not square); title not truly centered; back button not proper; add a top animation | scan.tsx square geometry + ScreenScaffold header title is centered-in-remaining-space (shifts right of true center) | D |
| 7 | "Choose a photo instead" + "Type the address + pin instead" need better handling (they are now the primary fallbacks) | QuietButton stubs below the frame | D |
| 8 | Photo-pick: pause scanning, show processing beautifully; results flash too briefly | No pause/processing state; notice is a caption that auto-clears in 2.5s | D |
| 9 | Camera preview: apply a BLACK & WHITE visual filter (decode untouched) + one more treatment | CameraView has NO filter props — the treatment is an overlay stack (scrim + vignette) | D |
| 10 | Manual entry: heading not centered, back not proper, page UI needs redo | same header + layout issues | D |
| 11 | Paste-failure note should auto-dismiss, animated, better UI | pasteNote renders inside the card, never auto-dismisses | D |
| 12 | PIN "1234 5678" — the grouping needs PROPER visual separation (4+4 boxes) | single TextInput + display-space | D |
| 13 | **Manual-entry pairing FAILS: "Could not reach the host or any of its addresses" while QR works** | **THE ROUND'S #1 BUG — see §1.1** | D+E |
| 14 | Confirm-host should show the PC's name (RapidMoov) | machineLabel is dropped by parsePairingPayload (§1.2) | D |

### PC pairing dialog

| # | Verdict | Root cause | Wave |
|---|---|---|---|
| 15 | Too much description at top | 2-line header description + label line + relay hint | E |
| 16 | Remove "Reachable over the internet via…" | pair-relay-hint line | E |
| 17 | "Type it in by hand" expanded area can't scroll | no max-height/overflow on the manual panel | E |
| 18 | Bottom buttons need better centering/alignment | left-aligned flex row (also: "Extend" doesn't exist — no change needed) | E |
| 19 | PC name at top should be BIG and BOLD | 11px tertiary line | E |
| 20 | Fullscreen QR: the dialog renders ABOVE it (wrong); tap-anywhere is the only close; caption+X stacking is improper; tapping the big QR should return to the popup | **§1.3 — the z-order trap (AppShell relative z-10 wrapper vs portaled z-50 dialog)** | E |

### Android home + shell

| # | Verdict | Root cause | Wave |
|---|---|---|---|
| 21 | Recent activity too minimal, not clickable, lacks color | rows are plain Views: dot + title + time only | F |
| 22 | "Mark All as Read" doesn't clear the highlight | **§1.4 — count/flag desync + silent failure** | F |
| 23 | Connection details page: top/heading/back/layout improper, multi-line descriptions | /settings/host.tsx + connect hub host branch | F |
| 24 | Wants multi-PC management (switch between PCs) | architecture is single-StoredHost — design sketched in §4, deferred | F (doc) |
| 25 | Bottom nav: text to the RIGHT of each icon (horizontal); text ONLY on the selected item with smooth collapse/expand; bounce too much; selected border too thin | tab-bar.tsx is vertical icon-over-label, always-visible labels, hairline border, underdamped indicator spring | B |
| 26 | More hub: remove activity / replay wizard / live status; show general info, versions, simple clean stats | more.tsx | H |

### Dashboard

| # | Verdict | Root cause | Wave |
|---|---|---|---|
| 27 | Missing: total projects, sessions, tokens, requests, tool calls, in/out token activity | the totals hero shows only 4 tiles; **`/usage/detailed` serves ALL of it and mobile never calls it (§1.5)** | G |
| 28 | Daily tokens: keep, better UI | chart exists | G |
| 29 | Tool leaderboard (commands), failures COMBINED with success counts per tool | `detailed.tools` = `{tool, count, failures}` — unused | G |
| 30 | GitHub-style activity section | `days` series supports an intensity grid | G |
| 31 | Model usage with the EXACT PC colors; which models were used when; per-model stats | **§1.6 — mobile uses rank hues, PC uses a 12-hue name-hash palette** | G |
| 32 | Total cost, API key stats, project-wise + session-wise stats | `detailed.keys` + `detailed.projects[].sessions` — unused | G |
| 33 | REMOVE: the Activity table, Health, separate tool failures | dashboard.tsx §5/§6 | G |
| 34 | DYNAMIC layout — horizontal scroll sections, tappable elements, not one vertical scroll | single ScrollView | G |

### Settings + providers

| # | Verdict | Root cause | Wave |
|---|---|---|---|
| 35 | Every settings page's top heading not good | ScreenScaffold header: title centered-in-remaining-space (not true center), bare chevron back | B |
| 36 | Appearance: selected mode border too thin | hairline indicator border (theme cards use 2) | I |
| 37 | Chat prefs rows: empty space on the right | full-width wrap-row of content-sized chips | I |
| 38 | Connection danger zone cluttered | one dense card after Diagnostics | F |
| 39 | Providers list: no base URLs, no key counts — show MODELS count; better COLORED icon; clearer add | row shows baseUrl + key badge + neutral KeyRound icon | J |
| 40 | Provider detail: broken layout, wrapping lines, models not detailed | flexWrap title line, cramped identity, no model facts | J |
| 41 | Model menu: WAY less sheet bounce; more bottom area (background shows); GRID layout | **§1.7 — the Sheet spring is underdamped and the panel is flush to the fold** | B (sheet) + J (grid) |
| 42 | Test model fails "the host dropped during the test"; nothing shows on PC | **§1.8 — 15s phone callTimeout vs 30s server probe** | J |
| 43 | Edit model: sometimes not preloaded; missing input/output caps + cache read/write editing; "Thinking" toggle is weird | **§1.9 — the [open]-only effect race; the draft omits 9 wire fields; PC has no thinking toggle** | J |

### Projects

| # | Verdict | Root cause | Wave |
|---|---|---|---|
| 44 | Remove the right-side arrow completely | trailing ChevronDown | K |
| 45 | Letter avatars → ROUNDED SQUARES with clay effect | `borderRadius: size/2` circle; design doc pinned the circle | K |
| 46 | Path truncation must prioritize the LAST segments | **§1.10 — `numberOfLines={1}` with no `ellipsizeMode` defaults to TAIL (cuts the end)** | K |
| 47 | New Project button: centered, better UI | `alignSelf: flex-start` half-width | K |
| 48 | Expanded area: separation from the project row, spacing between sessions, different color | hairline top border only, no row spacing, same card bg | K |
| 49 | Hide the "open" status tag (don't render; other statuses fine) | Badge renders sessionStatusLabel always | K |
| 50 | Sessions flush LEFT (remove the indent) | `FOLD_INDENT` 68px paddingLeft | K |
| 51 | New Session: button feel + proper separation | bare transparent text row | K |
| 52 | New Project sheet: start from a DEFAULT folder every time | browse state persists across opens; blank path = os.homedir() | K |

### Session screen + chat

| # | Verdict | Root cause | Wave |
|---|---|---|---|
| 53 | "Couldn't open the session / host offline / Retrying" — must AUTO-retry | no poll while `detail===null && error!==null` | L |
| 54 | Back arrow not proper | bare chevron, no chip | B (scaffold grammar) + L |
| 55 | Kebab: NO bottom sheet — a dropdown menu BELOW the kebab, smooth animation; heading + Mode/Model/Thinking/Context rows with live values; Context opens a clean full view | kebab opens the Sheet; a dropdown component doesn't exist | L |
| 56 | Model picker: NO "Agent default" row — only provider models; show which model the PC selected | model-row-agent-default + fallback ladder | L |
| 57 | Composer: minimal compressed pill-shaped input; attach = paperclip INSIDE the bar, RIGHT side | r14 rectangle input; attach is a Plus circle on the LEFT | L |
| 58 | Double-tick delivery states (single → highlighted double when the PC starts processing; failed state) | TranscriptItem has no status field; **turn.started is the natural ack (§1.11)** | M |
| 59 | Tool cards: failures ugly (right-side FAIL text, big section feel); file edits need +N/−N; terminal clean; thinking expandable; keep the task list EXACTLY as-is | ToolStatusBadge + full-width bordered cards; WriteCard shows chars only (the +N/−N data rides outputSummary); thinking capped at 14 lines | M |

## §1 Root causes (proven, with file:line)

1. **Manual pairing dies on TLS.** The QR carries `certFP` → the /health probe pins
   Sha256 → the desktop's SELF-SIGNED cert is accepted. Manual LAN without the
   fingerprint (the default: the field is optional+collapsed, and the desktop's
   "Copy pairing text" emits `addr:port · PIN …` with NO fingerprint) probes with
   `pinSha256: null` → OkHttp standard-CA verification → CertificateException →
   classified `"tls"` → pair-flow breaks the ladder → the misleading "certificate no
   longer matches" failure. (`pair-flow.ts:210/276/224-243`, AcuteNetModule.kt:420-432,
   DevicesTab.tsx:840-843.) **Fix both sides:** the desktop's pairing text gains the
   fingerprint (the phone's `parsePairingText` ALREADY parses a trailing certFP —
   pairing.ts:329-355), AND the phone maps a manual-LAN tls failure to honest guidance.
2. **machineLabel is dropped on the floor.** `parsePairingPayload` copies only the 9
   contract fields (pairing.ts:182-197, pinned by the forward-compat test), and
   scan.tsx re-stringifies the PARSED value — the desktop's `machineLabel` never
   reaches confirm.tsx, so the merge animation types "the desktop" and the confirm card
   has no name to show. Fix: carry `machineLabel` additively through the parser + show
   it in the confirm card's identity tier.
3. **The fullscreen-QR z-order trap.** `FullscreenPairQr` is `z-[60]` but lives INSIDE
   AppShell's `relative z-10` wrapper; the Radix dialog portals to body at `z-50` —
   the portaled dialog paints ABOVE the overlay (empirically confirmed). Fix: portal
   the overlay to `document.body`; make the big QR itself tappable (return to popup);
   restructure the caption/X (hint above the QR, X as a top-right corner affordance).
4. **Mark-all-read desync.** The SSE `hello` sets the COUNT only
   (activity.ts:125-129/249-251) — rows can stay `read: 0` while `unread === 0`, which
   also hides the button (`state.unread > 0` gate) and early-returns the store mutation
   (`if (this.state.unread === 0) return`). Plus `onMarkAllRead` has no `.catch` — a
   transport failure is silent. Fix: reconcile row flags with the count, drop the early
   return, catch + surface failures.
5. **The dashboard's data was already on the wire.** `/usage/detailed?days=` serves
   totals {projects, sessions, subagentSessions, toolCalls, requests, tokens
   in/out/cached, costUsd}, a tools leaderboard `{tool, count, failures}`, per-model
   stats, API-key stats, and project→session drilldowns (agent-core storage/usage.ts:
   123-259). Mobile never calls it. Caveat: totals/leaderboards are WHOLE-HISTORY (only
   `days` is windowed) — sections must label that honestly; windowed totals stay on
   `/usage/summary`.
6. **Model colors don't match the PC.** PC: 12 fixed hue pairs assigned by a STABLE
   NAME HASH (usage-helpers.ts:47-76). Mobile: 6 clay hues assigned BY RANK
   (tokens.ts:392-419) — the same model changes color with ranking. Fix: port the
   palette + `modelPaletteIndex` hash into mobile; swap every `modelHue(rank)` call.
7. **The Sheet bounces and flashes background.** Entrance rides the global
   `SPRING {180/22}` (ζ≈0.82, ~8-10dp overshoot on a ~700px travel); the panel sits
   flush with the fold so any dip pushes its bottom edge off-screen (background peeks);
   the inner ScrollView has no `overScrollMode` (Android stretch). Fix: the sheet gets
   its own over-damped spring (damping ≥ 30), a clamped/overshoot-proof progress, a
   below-the-fold skirt, `overScrollMode="never"`.
8. **Model tests die at 15s.** The server probes models for up to 30s
   (registry.ts:633-635 — "reasoning models are slow to first token"); the phone's
   acute-net default `callTimeout` is 15s (acute-net index.ts:139) and `testModel`/
   `testProvider` pass no `timeoutMs` → the exchange aborts → generic "the host dropped
   during the test". Fix: pass `timeoutMs: 35_000` + surface the real error class.
9. **The edit-model preload race.** Opening the sheet sets `open` and `model` in the
   same commit; the hydrate effect deps are `[open]` only and runs with the stale
   `shown === null` → blank draft ([id].tsx:1300-1316). Fix: key the effect on
   `[open, shown?.id]` (or hydrate from the `model` prop directly).
10. **Path truncation cuts the wrong end.** `shortRootPath` itself prefers the tail,
    but the row renders `numberOfLines={1}` with NO `ellipsizeMode` — RN's default
    "tail" clamps the END whenever the string is wider than the row. Fix:
    `ellipsizeMode="head"` + a budget the row can actually fit + test updates.
11. **Delivery ticks have a natural ladder already.** `turn.started` is the PC's FIRST
    frame after accepting a message (once per POST) and the live machine already finds
    the optimistic `live-user-` card by key prefix (sessions.ts:856-884); `queued.
    delivered` + rehydration's `message.user` fold are the other rungs. Additive
    `status?: "sending" | "sent" | "delivered" | "failed"` on the user TranscriptItem;
    render ticks in the bubble's clock row.
12. **The tab bar is round-115-shaped, not the owner's shape.** Vertical icon-over-
    label with all labels always visible; hairline indicator border; the indicator
    spring is the underdamped house spring. The owner's shape: HORIZONTAL icon+label,
    label only on the selected item (smooth width/opacity collapse between items),
    thicker border, calm slide.

## §2 The wave plan (sequential; each wave owns its files exactly)

- **R116-a** (this doc + design-language amendments): the constitution updates —
  single-line law, avatar shape, tab bar anatomy, sheet mechanics, scanner treatment,
  dropdown idiom, ticks, tool-card compaction, dashboard dynamism.
- **R116-b — shared chrome:** sheet.tsx (over-damped, skirt, no overscroll), tab-bar.tsx
  (the owner's anatomy), screen-scaffold.tsx (true-centered title + chip back), motion.ts
  (new constants). Screen-scaffold.test.ts must keep compiling.
- **R116-c — onboarding + unpaired home:** welcome.tsx (single-line law, CTA redesign +
  raised position), permissions.tsx (buttons to middle), onboarding/connect.tsx
  (single-line), connect/index.tsx unpaired branch ("Currently not connected" + broken
  link animation + ONE Connect to PC button → /connect/scan).
- **R116-d — scanner + manual + confirm + the pairing fixes:** scan.tsx (portrait
  viewfinder, monochrome treatment, custom centered header + chip back + top animation,
  photo-flow pause/processing/results), manual.tsx (PIN 4+4 boxes, paste note
  auto-dismiss, page redo), confirm.tsx (the PC's name in the identity tier), pairing.ts
  (carry machineLabel), pair-flow.ts (manual-LAN tls → honest guidance). Tests:
  pairing.test.ts, pair-flow.test.ts.
- **R116-e — PC pairing dialog:** DevicesTab.tsx (portal the fullscreen QR + tappable
  return + caption/X restructure, big bold PC name header, trim description, delete the
  relay hint, scrollable manual panel, centered action row, pairing text + certFP).
  Tests: DevicesTab.test.tsx.
- **R116-f — home + activity + connection pages:** home.tsx (pressable, colored,
  detailed activity rows), activity.ts/tsx (mark-all-read fix + feedback), connect/
  index.tsx host branch + settings/host.tsx (the connection-details redo, single-line,
  danger-zone separation). Multi-PC stays documented (§4).
- **R116-g — dashboard:** config.ts (+fetchDetailedUsage + types), tokens.ts (+ the
  12-hue name-hash palette port), a usage-helpers port, dashboard.tsx (the dynamic
  redo: stat carousel, tool leaderboard, GitHub-style grid, model donut + per-model
  cards, key stats, project/session drilldown; Activity + Health deleted).
- **R116-h — More hub:** more.tsx (drop activity/wizard/live-status; About + version +
  simple stats + Settings).
- **R116-i — appearance:** appearance.tsx (2px selected borders, chat-pref rows with
  right-aligned segmented values, no empty right space).
- **R116-j — providers:** index.tsx (models-count badge, no baseUrl, colored provider
  identity, clear add), [id].tsx (layout fixes, model facts, GRID action menu, full
  edit-model fields incl. caps + cache-read price, no Thinking toggle, preload fix,
  test timeouts), config.ts (draft/body fields + timeoutMs). Tests: config.test.ts.
- **R116-k — projects:** projects.tsx (no arrow, avatar swap, head-truncation, centered
  New Project, the sessions well, no open tag, flush-left rows, New Session button,
  default folder), letter-avatar.tsx (rounded-square clay), fs-browse.ts (budget).
  Tests: fs-browse.test.ts.
- **R116-l — session header + composer + model sheet:** session/[id].tsx (chip back,
  kebab → dropdown menu with live values + auto-retry), NEW dropdown component,
  composer.tsx (pill input + paperclip inside-right + compressed), model sheet (no
  Agent default row; PC-selected highlight; clear-by-tap). Tests: composer.test.ts.
- **R116-m — transcript + ticks:** sessions.ts (the delivery status ladder),
  transcript.tsx (compact tool cards, +N/−N chips, terminal polish, thinking expand,
  failure presentation). Tests: sessions.test.ts. TodoCard untouched.
- **R116-n — final review + docs:** the design audit subagent + round-116 evidence +
  status.json/CHANGELOG truth-sync.
- **R116-o — release v0.110.0:** the full guard chain (MAINTENANCE §g 2c lock proof,
  both-workflow watch, publish, 7/7 + APK verification).

## §3 Verification

Per wave: mobile `npx tsc --noEmit` clean · `CI=1 npx jest --silent` green (baseline
24 suites / 500 + additions) · `npx eslint --no-ignore` on touched files · secret scan.
Final: the R115-r release discipline end-to-end.

## §4 Deferred with reasons (the honest queue)

- **The updater round (U1–U3).** The Linux in-app update restarts into the same
  version — the update handshake ("Connecting to Agent Core") evidently completes but
  the new binary never replaces the running one on Linux (needs the packaged-app
  restart path debugged on a real install; the Windows flow works but is manual). The
  owner's incremental-updates direction (delta updates) is an architecture round of its
  own: Tauri/NSIS + AppImage/deb both ship whole-artifact updates today; the honest
  path is (1) fix Linux replace-on-restart, (2) automate the Windows restart,
  (3) THEN evaluate bsdiff/zip-patch layering against artifact size. Not this round —
  the owner pinned the round to Android + communication.
- **Multi-PC (item 24).** The phone stores exactly ONE StoredHost (host-store.ts) and
  the ConnectionManager owns one link; pairing a second desktop REPLACES the link. The
  sketch: `hosts: StoredHost[]` + one ACTIVE link + a switcher sheet on the connection
  page (device tokens already work multi-desktop server-side — the desktop's device
  list already holds N devices). A deliberate round of its own; the connection page's
  redesign keeps the seam ready.
- Device smoke pass (accordion/keyboard/photo-QR), attachment image bytes, the browser
  save-download affordance, PC transcript polish — the standing queue from round 115.

## §5 The wave log (what shipped, per commit)

| Wave | Commit | The work |
|---|---|---|
| R116-a | d6f6cc3 | this plan + the design-language amendments (donts #31-41, checklist +9, the scanner/dashboard/chat/tabs/sheet laws) |
| R116-b | c7f11cf | the shared chrome: SHEET_SPRING 210/30 + clamped + skirted + no-overscroll Sheet; the horizontal selected-only-label tab bar with the 2px-border indicator on TAB_SPRING; true-centered scaffold titles + chip backs + tabBarAware |
| R116-c | 4741129 | the single-line law in the wizard; the raised 56px CTAs; buttons-to-middle on the camera screen; the unpaired home's broken-link hero + ONE Connect to PC |
| R116-d | e520a63 | THE manual-pairing TLS fix (phone half) + machineLabel carried + the confirm host tier + the portrait monochrome scanner with the paused photo-flow + the 4+4 PIN boxes + the auto-dismissing paste note (+9 tests) |
| R116-e | ba87d7e | THE TLS fix (PC half — the pairing text carries the fingerprint, verified parsed) + the portaled fullscreen QR + tap-to-return + the big bold name + the trimmed description + the scrollable manual panel + centered actions |
| R116-f | b2912cb | pressable colored detailed home activity rows + mark-all-read's three desync legs fixed (+7 tests) + both connection surfaces' heroes + the separated danger zone + the multi-PC seam |
| R116-g | ed2c278 | the dynamic dashboard: the overview carousel, the GitHub-style grid, the combined tool leaderboard, the PC-exact model colors (name-hash port, +17 tests), per-model cards, key stats, project drilldowns — fetchDetailedUsage wired |
| R116-h+i | ad4e8d5 | the More hub's honest general block + stats card; appearance's 2px selected borders + the chat-pref rows' right-aligned controls |
| R116-j | 93e7503 | providers as colored identities over models counts + the full-width add + the 2×2 action grid + the complete edit-model form (caps, cache read, size label; Thinking retired) + the preload-race fix + 35s test patience with honest errors (+11 tests) |
| R116-k | 727e320 | clay rounded-square avatars + ellipsizeMode head + budget 22 + the separated sessions well + no open badge + flush-left + the New Session button + the remembered default folder |
| R116-l | 5c57b7c | the anchored kebab dropdown + auto-retry + the back chip + the pill composer with the in-bar paperclip + the picker's real-models-only ladder (+1 test) |
| R116-m | b8a6277 | the delivery ladder (sending → sent → delivered/failed, +5 tests) + the ticks + the compact tool cards with +N/−N chips + thinking show-all; TodoCard frozen |
| R116-n-audit | 14c8237 | the 53-file sweep: five single-line misses fixed, the chevron drift, the tombstones, home's running rows joining the avatar law |

## §3-addendum The verification matrix (fresh at the R116 close)

- Mobile: `npx tsc --noEmit` clean (noUnusedLocals on) · `CI=1 npx jest --silent` →
  **25 suites / 550 tests** all passing (was 24/500 at the R115 close) ·
  `npx eslint --no-ignore` on every touched file → 0 findings (two pre-existing
  unknown-rule disables retired by waves J/L).
- Root (the PC tree — wave E): `tsc -p tsconfig.json --noEmit` clean · root vitest
  re-verified **4337/4337** (244 files, 15 pre-existing e2e/sidecar skips) with
  DevicesTab 26/26.
- agent-core: 2618/2618 carried from the R115 close (no agent-core source file
  touched this round — routes/storage were only READ).
- docs:check 255 scanned / 0 stamp failures (3 external URLs flake on the checker's
  HEAD probes — all answer 200 to GET; environmental, zero URLs added).
- The final design audit (R116-n-audit): 10 pattern families swept across the whole
  round diff — the banned words, machine truth, agent-default remnants, FAIL badges,
  stale testIDs, spinners, hardcoded colors, the single-line law, the copy voice,
  dead code — 7 surgical fixes, baseline held exactly.
