<!-- last-reviewed: 2026-09-20 round-114 -->
<!-- round: 114 -->
# Round 114 — the sync foundation + the phone's honest shell (the post-v0.107.0 test round)

The owner's verdict on v0.107.0: live sync held, the relay held — and his
walkthrough of the phone exposed the honesty debt. The dashboard was a
monochrome guess ("not color coded, information missing"). The top status
pill + notification bell + screen titles were chrome he never asked for.
Appearance synced the theme but not the four chat prefs he actually
adjusts. Projects navigated to a page instead of expanding. Sessions said
"queued" — machine vocabulary. Every bottom sheet menu rendered EMPTY
(title + X). The composer's model pill said "Auto" when the truth was a
specific model. Mode and model changes made on one device never reached
the other. The keyboard still covered the composer. Neither device showed
thinking/processing state for the OTHER device's sends — the PC's send
button never flipped when the phone sent. Formatting quality, the
read_skill full-view, write_file's invisible streaming, screenshots that
never showed, claymorphism + a colder white + dark mode, vision that
should ALWAYS work when the model is marked, the "off" mode in Image
Analysis, pickers listing providers he never added, and the phone's
missing model management — the list that became this round.

This file records the round that answered every item. The headline is the
**sync foundation** (R114-a/b): one systemic sheet fix that unlocked every
bottom menu on Android, plus the wire contract that made mode, model, and
the live-turn state propagate the moment they change — the meta session
frame, the server-side selected model (migration 0041), the `turn.started`
early frame, the appearance five-field domain, and vision always-on for
marked models. The seven commits: e18b37d (the systemic sheet fix),
a0ac11a (the backend sync foundation), 6966120 (the phone shell),
328ab6d (the phone transcript), 54bcaa9 (the desktop rides the
foundation), 46a08e8 (the phone's Models & Providers), 7344fdf (the
audit fixes).

## §0 The owner's report, itemized

| The ask (R114) | The answer | Where |
|---|---|---|
| **The dashboard is not color-coded, information missing** | The color-coded dashboard (§2): the daily chart is now STACKED (input terracotta below, output sage above, same peak denominator — the stack IS the day), with 3 dashed gridlines, a "peak N" scale label, an in/out dot legend, and the tap-to-select day detail (in/out/requests/cost + date); the model leaderboard assigns a fixed 6-hue rank palette (dot + mono name + share track ALL in the model's hue, cost·calls caption); the stat tiles carry tone semantics via icon chips; health cards keep danger/warning tones + the total-count badge. The palette is a documented data-viz family (`CHART_HUES`) that never touches resting surfaces | `mobile/app/(tabs)/dashboard.tsx`, `mobile/src/design/tokens.ts` |
| **The top status + notification + titles are unnecessary** | Chromeless tab roots: `ScreenScaffold` gained `chrome?: boolean` and all FIVE tab roots render `chrome={false}` — no 56 px header row, no bell, no ConnectionPill; the body gains paddingTop 24 under the safe-area inset. The bell's job moved into Home's compact Activity row (an accent unread-dot badge, rendered ONLY while unread > 0); connection honesty is a quiet banner card ONLY while offline/probing ("Offline — messages will queue" / "Connecting…") — live renders nothing | `mobile/src/components/screen-scaffold.tsx`, `mobile/app/(tabs)/` |
| **Appearance is missing density / text-size / timestamps / tool-activity** | The appearance domain grew the four chat fields (§1): `chatDensity` comfortable\|compact, `chatTextSize` small\|medium\|large, `timestampsMode` hidden\|hover, `toolActivity` detailed\|compact\|hidden — server-backed (partial PUT, broadcast on the events bus), rendered as four segmented rows on the phone's Appearance screen, live-synced into the transcript (§3) and the desktop's write-through setters | `agent-core/src/storage/settings.ts`, `mobile/app/settings/appearance.tsx`, `mobile/src/features/chat-prefs.ts`, `src/lib/theme-store.ts` |
| **Projects should expand, not navigate** | The projects accordion (§2): tapping a ProjectRowCard toggles an inline expansion under the one house spring — the project's sessions as compact rows (title, honest status badge, last-activity, pulsing running dot), capped at 8 with "+N more", a "New session" row at the end; `app/project/[id].tsx` is now a thin redirect back to the tab (kept for deep links) | `mobile/app/(tabs)/projects.tsx` |
| **Sessions showing "queued"** | Honest status labels: `sessionStatusLabel` maps queued→"open", running→"running", completed→"done", failed→"failed", cancelled→"stopped" — used by the accordion's badges AND the session screen's header (running keeps its live words). The R114-g audit extended the same vocabulary to the sub-agent badge (`subagentStatusLabel` — raw "completed"/"cancelled" never surface) | `mobile/src/features/sessions.ts` |
| **THE EMPTY BOTTOM MENUS** (every sheet rendered title + X only) | The systemic sheet fix (R114-a, §1): Android's Yoga collapses a `flex:1` ScrollView inside a content-sized (auto-height) panel to ZERO height. The scroller is now pixel-clamped against the live window height and the panel wraps content — ONE fix that unlocked every bottom menu (model pickers, mode sheets, the new folder browser, the model sheets of §5) | `mobile/src/components/sheet.tsx` |
| **The model "Auto" dishonesty** | The server-side selected model (§1): migration 0041 (`sessions.model_provider` + `model_id`), `PATCH /sessions/:id {model:{providerId,model}\|null}` validated before any write, the three-tier `prepareTurn` ladder (per-send override → `session.selectedModel` → agent row), and `selectedModel` on every session row. The phone's composer pill reads local override → `detail.selectedModel` → the context report → "Auto" (only when it truly is), with `isModelInPlay` marking the tier that actually answers; the desktop seeds its display the same way | `agent-core/src/storage/sessions.ts`, `agent-core/src/routes/sessions.ts`, `mobile/src/components/composer.tsx`, `src/components/project-chat/composer/composer-utils.ts` |
| **Mode/model changes don't propagate** | The meta session frame (§1): `{type:"session", kind:"meta", permissionMode?\|activeMode?\|selectedModel?}` published at the three storage choke points — so BOTH PATCH routes AND the `switch_mode` tool ride ONE hook. The phone applies the patch in place (`applySessionMetaPatch` — instant label flips, the debounced rehydrate as backstop); the desktop invalidates `["session"]+["sessions"]` immediately, no debounce | `agent-core/src/lib/events-bus.ts`, `agent-core/src/storage/sessions.ts`, `mobile/src/features/sessions.ts`, `src/lib/events-stream.ts` |
| **The keyboard hides the composer** | Keyboard hardening (§3): the whole composer rides ONE animated pipeline — `KeyboardAvoidingView behavior="padding"` wrapping control row + chips + input, with `useReanimatedKeyboardAnimation`'s shared values driving the wrapper's paddingBottom on the same UI-thread clock (closed → gesture-bar inset, open → 0, no dead strip) and the hook's own `adjustResize` guarantee on edge-to-edge Android | `mobile/app/session/[id].tsx`, `mobile/src/components/composer.tsx` |
| **No thinking/processing status — either direction** | `turn.started` (§1): `{type, text, model, providerId}` emitted the instant `prepareTurn` succeeds, BEFORE status/log writes — the turn's FIRST frame, once per POST/stream. The phone opens the live turn instantly (remote user bubble + resolved model) and renders the animated Thinking placeholder (three house-cadence dots + the model in micro mono); the desktop's existing Thinking… placeholder was verified to cover remote mirrors | `agent-core/src/agents/runtime.ts`, `agent-core/src/routes/sse.ts`, `mobile/src/features/sessions.ts`, `src/lib/stream-store.ts` |
| **The PC's send button doesn't flip when the phone sends** | The same `turn.started` on the desktop (§4): the mirror opens the moment the phone's turn begins — `remoteRunning` goes true → busy → the composer flips to Stop + Queue, the sidebar spinner starts, the remote user bubble renders (content-deduped against the folded log — never a double), and AssistantTurnHeader labels the turn with the frame's resolved model | `src/lib/stream-store.ts`, `src/lib/events-stream.ts`, `src/components/project-chat/AgentChatPanel.tsx` |
| **Formatting quality on both platforms** | Desktop polish (§4): ordered-list markers gained `min-w-5 + text-right` (the text start stays aligned across "9." vs "10."), the first block drops its top margin (the turn header already provides the opening gap); the code-block chrome / inline code / GFM tables were verified already landed (R95/R100-D) and left alone. Phone (§3): the four chat prefs drive the transcript's rhythm — `textSizeScale` scales paragraph body + line height ONLY (headings/mono/code stay as calibration marks), density scales the vertical padding, timestamps/hover per the mode | `src/components/project-chat/ChatMarkdown.tsx`, `src/components/project-chat/WorkingSection.tsx`, `mobile/src/components/markdown-text.tsx`, `mobile/src/features/chat-prefs.ts` |
| **The read_skill full view is ugly** | Per-tool cards (§3): `read_skill`/`search_skills`/`read_file` render SkillCard — ONE quiet line (BookOpenText icon + "Skill · <name>", the name read LIVE off the streaming raw) + status; the args dump only on manual expand. Desktop twin: read_skill/search_skills rows carry their own lucide icons + past-tense labels ("Read skill" / "Searched skills") | `mobile/src/components/transcript.tsx`, `src/components/project-chat/WorkingSection.tsx` |
| **write_file streaming is invisible on the phone** | The streaming write preview (§3): `tool-input-start` opens the RUNNING card, `tool-input-delta` accumulates the partial-JSON raw (`appendToolInputRaw`, head-kept 256 KB cap), a tolerant extractor pulls the mono path + a quiet 160-char content tail + the live char counter, `tool-call` finalizes in place, `tool-result` spends the raw. The wire's tool-call frame carries no toolCallId — the phone's name-match mirrors the desktop's accumulated-raw match exactly | `mobile/src/components/transcript.tsx`, `mobile/src/features/streaming-args.ts` |
| **Screenshots not shown** | The screenshot frame fix (§3): the wire's true shape is `{sessionId, frameId, tool, note?}` (from BOTH emitters) — the old mobile type carried a `ts` field that was never on the wire, so frames never matched; the item carries `note`, the viewer caption reads "Captured by <tool> · <note>", and the lazy `fetchRasterFile` + tap-to-view flow was verified untouched | `mobile/src/features/sessions.ts`, `mobile/src/components/image-viewer.tsx` |
| **Claymorphism + a colder white + dark mode** | The colder-white clay substrate (§2): light surfaces bg #F4EEE5→#F3F4F0, card #FDFBF7→#FDFDFB (a whisper of warmth survives — never flat gray), the light-mode clayShadow ink cooled rgba(42,32,24)→rgba(38,34,28) so the warm cast never reads orange against the colder bg; dark surfaces + all five other themes untouched | `mobile/src/design/tokens.ts` |
| **Vision must ALWAYS work when the model is marked** | Vision "off" retired (§1): `VisionMode = main \| separate`; a stored "off"/unknown reads as "main" (stable idempotent coercion — no row rewrites); `relayVision`'s ladder: separate-fully-configured → main-model-MARKED (including the fallback from a half-built separate pick — a marked model can never be blinded) → the honest refusal naming BOTH fixes; `sessionHasVisionPath` mirrors it tier-for-tier; screenshot tools refuse only when NEITHER path works | `agent-core/src/storage/vision.ts`, `agent-core/src/tools/plugins/computer-use.ts` |
| **Image Analysis: remove the off mode + a configured-only separate picker** | The ImageAnalysis rework (§4): the mode radio shows exactly TWO options — Main model (recommended default) + Separate model; "off" is gone (the client never sends or renders it — the server coerces legacy stored values). The separate picker is REBUILT: `GET /models/configured` filtered to `supportsVision === true`, hidden rows excluded, only CONFIGURED providers — one click PUTs the pair; NO provider dropdown, NO free-text model input, NO static datalist; the honest re-point note + the empty state's deep-link into Models & Providers | `src/components/settings/ImageAnalysisTab.tsx` |
| **The pickers show un-added providers** | The ModelSelector audit (§4): the composer's provider list was ALREADY filtered to `enabled && hasKey !== false` since R89-B3 (the rule extracted into `filterConfiguredProviders`, stated once, tested once); the REAL leak was ImageAnalysisTab's old separate-mode provider `<select>` (all providers unfiltered + a free-text model input + the static OpenRouter datalist) — the rebuild removed the entire surface; SubAgentsTab's picker rides `GET /models/configured` (configured by construction); AgentFormDialog deliberately lists all registry rows (binding an agent to a not-yet-keyed provider is a legitimate setup flow — audited, intentionally unfiltered, unchanged) | `src/lib/settings-store.ts`, `src/components/settings/ImageAnalysisTab.tsx` |
| **The phone's missing model management** | The phone owns its inventory (§5): providers configured-first with the custom-provider CREATE sheet (name, base URL, the api-format enum, the first key chained through `PUT /providers/:id/key`); the provider detail rebuilt around the key pool (masked slots, per-slot test, primary-replace vs pool-remove, next-free-slot adds); SAVED MODELS as the truth (`models-config` rows only — add from the live catalog with static prefill or custom); the model actions sheet (test / hide-show / edit caps incl. the vision flag / delete with a two-step confirm); a typed pure feature layer under all of it | `mobile/app/settings/providers/index.tsx`, `mobile/app/settings/providers/[id].tsx`, `mobile/src/features/config.ts` |

## §1 The sync foundation (R114-a + R114-b — the fix and the wire)

### The systemic sheet fix (R114-a, e18b37d)

Every bottom menu on the phone rendered as a title row and an X — the
model picker, the mode sheet, every one. The root was NOT per-sheet: the
house `Sheet` component sized its panel to content (auto height) and let
a `flex:1` ScrollView fill the rest — and **Android's Yoga layout engine
collapses a flex:1 child inside a content-sized panel to zero height**
(the measurement chicken-and-egg: the panel wants to wrap the content,
the content wants to fill the panel). iOS tolerates it; Android does not.

The fix is one clamp: the scroller's max height is resolved in PIXELS
against the live window height (`maxHeightFraction` of the window minus
the grip/padding chrome, floor 240), and the panel wraps its content —
no flex dependency at all. One 22-line change to `sheet.tsx` unlocked
every menu this round built on top of it (the folder browser, the model
sheets of §5) and every menu that came before.

### The wire contract (R114-b, a0ac11a) — exactly as landed

- **The meta session frame** —
  `{type:"session", sessionId, projectId, kind:"meta",
  permissionMode?|activeMode?|selectedModel?}`. Only the field(s) this
  change touched ride the frame (absent keys stay ABSENT on the JSON
  wire — never `undefined`); `selectedModel`/`activeMode` carry `null`
  for a clear. Published at the three STORAGE choke points
  (`updateSessionPermissionMode` / `updateSessionActiveMode` /
  `setSessionSelectedModel`) so BOTH PATCH routes AND the `switch_mode`
  tool ride ONE hook — the other device's composer follows the flip
  live, never on the next unrelated refetch.
- **The server-side selected model** — migration
  `0041_session_selected_model.sql` (`sessions.model_provider` +
  `model_id`, both NULL = follow the agent default; every pre-R114 row
  composes byte-identically; half-written rows fail-open to null at
  read). `PATCH /sessions/:id` AND `PATCH /sessions/:id/permissions`
  accept `model: {providerId, model} | null` — absent = untouched,
  null = clear; validation BEFORE any write (complete pair → known +
  configured provider with a baseUrl → a models row OR catalog entry
  match; 400s name `body.model` / `body.model.providerId` /
  `body.model.model`). GET list + detail + the fork path carry
  `selectedModel` (forks deliberately start modelless).
  `prepareTurn`'s three-tier ladder: **per-send override →
  session.selectedModel → agent row**, each side falling through
  independently (a half override contributes its side — the pre-R114
  chain semantics the orchestrator's `subagentModel` arm relies on; a
  complete override still wins outright).
- **`turn.started`** — `{type:"turn.started", text, model, providerId}`,
  emitted the instant `prepareTurn` succeeds, BEFORE `setSessionStatus` /
  `appendSessionEvent` and before any loop-top queue delivery: it is the
  turn's FIRST frame (the leading `: ping` still precedes it on the
  socket). It carries the USER text (a remote client renders the user
  bubble immediately, before the persisted fold refetch) and the
  RESOLVED effective model + provider (the ladder's verdict — a remote
  UI labels the live turn honestly instead of "Auto"). Not persisted;
  rides the initiator's own stream AND the events-bus mirror
  `{type:"turn", sessionId, frame}` verbatim. Once per POST/stream: the
  sse route passes `emitTurnStarted: true` for the POST's own first turn
  ONLY — queue continuations and the orchestrator's streamed children
  stay quiet (they already have live context; a re-announcement would be
  noise).
- **The appearance five-field domain** —
  `{themeId: string|null, mode, chatDensity: comfortable|compact,
  chatTextSize: small|medium|large, timestampsMode: hidden|hover,
  toolActivity: detailed|compact|hidden}`; defaults
  null/system/comfortable/medium/hover/detailed; partial PUT (an absent
  field never touches its row); 400s name `body.<field>`; every PUT
  broadcasts the FULL shape. Missing rows read as defaults — a pre-R114
  database GETs the five-field shape with the new fields at their
  defaults, so **no migration was needed** (the settings key-value table
  absorbs them).
- **Vision "off" retired** — `VisionMode = "main" | "separate"`; a
  stored "off" (or any unknown value) READS as "main" (readEnum's
  fail-open fallback — stable, idempotent forever, no row rewrites); the
  write side ACCEPTS a legacy "off" and coerces it to "main" (wire
  compat — an old client PUTting its stored value gets the new
  semantics, never a 400). `relayVision`'s ladder: separate-FULLY
  configured → describeRaster on the `<id>-vision` keyring slot; else
  main-model-MARKED (`supportsVision` on the model row — mode "main" OR
  the fallback from an incomplete separate pick); else the honest
  refusal naming BOTH fixes (mark the model in Models & Providers / pick
  the separate model in Settings → Image Analysis; the
  separate-unconfigured variant adds why no fallback existed).
  `sessionHasVisionPath` mirrors the ladder tier-for-tier (the flat OR
  would let leftover separate rows un-blind a session whose relay
  actually refuses — one failure story). `POST /vision/test`'s dead
  off-branch deleted.
- **fs browse** — `GET /api/v1/system/fs/browse?path=<abs>&hidden=<0|1>`
  → `{path, parent: string|null, entries:[{name, path, dir}], truncated}`:
  path omitted/blank → the user's HOME; dirs first then files, each
  alphabetical; dotfiles skipped unless `hidden=1`; hard cap 400 entries
  with `truncated: true`; `parent` null at a filesystem root (the picker
  hides Up); ENOENT → 404 with the OS message, not-a-dir/unreadable →
  400 with the OS message; NEVER any file contents. Deliberately NOT on
  the device-token blocklist (a paired phone is a view+input medium with
  config rights — the R109 ruling; only `/system/reset` is blocked under
  `/system/*`), pinned by a real pair→claim→TLS-device-token test with
  the `/computer-use/config` 403 contrast leg.

The 38-test suite `agent-core/tests/r114-sync-wave.test.ts` pins all of
it: meta frames on both PATCH routes + `switch_mode` + title-quiet; the
selected-model validation matrix + views + both-route acceptance; the
four-tier prepareTurn ladder + the context mirror; `turn.started`
first/mirrored/session-tier/default-off; appearance defaults/partial/
400/broadcast; vision read+write coercion + the relayVision ladder +
`sessionHasVisionPath`; fs browse ordering/hidden/home/root-parent/cap/
404; the device-token seat.

## §2 The phone shell (R114-c, 6966120) — the space-honest surface

- **Chromeless tab roots** (item: the unnecessary top chrome): all five
  tab roots render `chrome={false}` — no header row, no bell, no
  ConnectionPill; pushed screens keep the back-chevron row verbatim.
  The bell's unread job moved into Home's compact Activity row (badge
  only while unread > 0); connection honesty is the offline/probing
  banner card only — live renders NOTHING (the host hero +
  pull-to-refresh + reconnect reloads cover every other screen; DESIGN.md
  §6 rewritten to say exactly that).
- **The colder white** (item: claymorphism + colder white + dark mode):
  bg #F4EEE5→#F3F4F0, card #FDFBF7→#FDFDFB, the light-mode clayShadow
  ink cooled a half-step — dark mode and the five other themes
  untouched.
- **The color-coded dashboard** (item: the monochrome guess): the
  stacked daily chart (input below / output above, the same peak
  denominator so the stack IS the day; the totals-only 3-month series
  renders the honest 50/50 blend — one-sided days render the side that
  exists, never a fake split), 3 quiet dashed gridlines + the "peak N"
  scale label + the in/out dot legend, the molded cap on the top
  segment, the tap-to-select day detail kept. The model leaderboard in
  a fixed 6-hue rank palette (terracotta/sage/ochre/slate/plum/taupe —
  dot + mono name/count + share track all in the model's hue). Stat
  tiles carry tone semantics via icon chips ONLY (resting surfaces stay
  card-colored per DESIGN.md). `CHART_HUES` lives in tokens.ts as the
  data-viz-only second family.
- **The projects accordion** (item: expand, don't navigate): the inline
  expansion (a local Accordion — height+opacity under the ONE house
  spring, content stay-mounted and clipped so its measured height is
  always current, a rotating chevron discloses state) renders the
  project's sessions as compact rows from the SAME folded
  `fetchSessions(200)` (`groupProjectSessions`, most-recent-first),
  capped at 8 with "+N more" + a "New session" row; the "{n} running"
  meta stays live off the events-epoch refetch. `app/project/[id].tsx`
  is a thin redirect (kept for deep-link compat).
- **Honest status labels** (item: "queued"): `sessionStatusLabel` —
  queued→open, completed→done, cancelled→stopped — on the accordion
  badges AND the session screen header.
- **The sheets** (built on R114-a's fix): the New Project affordance is
  a content action row (the chromeless root has no header to host it);
  the sheet carries (a) name, (b) the ROOT FOLDER BROWSER over
  `GET /system/fs/browse` — breadcrumb row of tappable crumbs + Up off
  the reply's parent, dirs-only list, "Use this folder", the
  manual-path toggle, starts at the server home, the 400-cap caption,
  honest inline errors (`mobile/src/features/fs-browse.ts`), (c) the
  optional COLOR the route truly accepts (6 preset swatches + auto — no
  invented description field), (d) Create. The New Session sheet:
  optional name, full/ask/plan segmented chips with per-mode captions,
  Create → `createSession` + (mode≠ask) the permissions PATCH + navigate.
- **Appearance +4** (item: the missing chat prefs): the full five-field
  domain end-to-end — the Appearance screen's Chat section (four
  segmented rows, each flip optimistic + one-field partial PUT), the
  six-field control, `useChatPrefs()` resolving the four synced values
  for the transcript.

The phone's create-API truth was READ, not guessed: `POST /projects`
accepts exactly name + rootPath + color — the sheet offers exactly
those; `POST /sessions` accepts mode/agentId/title/projectId
(permissionMode is a follow-up PATCH, default "ask" server-side).

## §3 The phone transcript (R114-d, 328ab6d) — the honest live view

- **The instant live-turn open**: `turn.started` joins the
  StreamTurnFrame union + `applyLiveFrame` — the own stream sets
  `LiveTurn.model` and recognizes its own optimistic card (the bubble
  never doubles); the REMOTE path pushes the user card from the frame's
  own text IMMEDIATELY (no refetch wait — the message.user append's
  `{kind:"event"}` frame + the 800 ms debounced rehydrate + the 3 s poll
  land the truth, and `rebaseRemoteTurn` DROPS the mirrored card when
  the persisted row arrives — content-compared, never doubling).
- **The animated thinking placeholder**: a display-only synthetic
  `{kind:"thinking"}` item while `thinkingPlaceholderVisible(turn)` (a
  pure verdict: streaming, not terminal, no assistant/tool/… item after
  the live-keyed user card; dim meta lines do NOT retire it) — three
  house-StatusDot-cadence pulsing dots (600/600 ms, 0.35 floor, 180 ms
  stagger), "Thinking" caption + the model in micro mono, the house clay
  tile, replaced by the first real delta.
- **The model everywhere**: the live assistant card renders the model
  line stamped from `turn.model`; the session header subtitle is
  status · mode · model (through the pure `shortModelId` —
  provider-prefix strip + 22-char cap); persisted folds carry model per
  message.
- **The per-tool card family**: ToolCard is a dispatcher — SkillCard /
  WriteCard / TerminalCard per §0's items; `tool-input-start` opens the
  RUNNING card (the "preparing X…" meta line retired); `tool-input-delta`
  accumulates the partial-JSON raw on the matching card; `tool-call`
  finalizes in place; `tool-result` settles ok/summary and SPENDS the
  raw. `toolActivity=compact` pins every card to the collapsed row;
  `hidden` folds runs of consecutive tool items into one quiet meta
  line ("· N tool calls", "· running" while any call is in flight).
- **The screenshot fix**: the frame type matches the wire exactly
  (`{sessionId, frameId, tool, note?}`); the caption reads "Captured by
  <tool> · <note>".
- **The honest model pill + live meta**: `modelLabel` = local override →
  `detail.selectedModel` → `contextReport.model` → "Auto"; `pickModel`
  writes BOTH tiers (the local per-send override + the PATCH); the "Auto
  (session default)" row clears both; the meta frame applies
  permissionMode/activeMode/selectedModel to the detail state IN PLACE
  via the pure `applySessionMetaPatch`.
- **The four chat prefs wired**: `features/chat-prefs.ts` —
  `densityVerticalPadding` (12/6 on user bubbles + every tool shell),
  `textSizeScale` (0.92/1.0/1.08 on paragraph body + line height ONLY),
  `messageClock` + `timestampsVisible`, `toolActivityVisibility` +
  `foldToolActivity` — all reactive through `useChatPrefs`.
- **The keyboard hardened**: one animated pipeline (§0's item) — the
  reasoning was tested against the library source
  (`useReanimatedKeyboardAnimation` internally sets `adjustResize` for
  the screen's lifetime; the reanimated context's height is NEGATIVE
  while open, so the composer's inset animates as max(insets.bottom +
  height, 0)) — the old JS-thread swap (the insets flip racing the lift,
  the close bounce) is gone.

## §4 The desktop (R114-e, 54bcaa9) — riding the same foundation

- **The instant remote busy state** (items: the send button + thinking
  status): `turn.started` joins the frontend union; ONE branch in the
  shared `handleStreamEvent` serves both paths — the frame's RESOLVED
  model stamps `LiveTurn.model`, `userText` rides ONLY a remote mirror
  (the own path's pendingEcho already rendered the identical bubble).
  `remoteRunning` goes true the moment the frame lands → busy → the
  composer flips to Stop + Queue (a desktop send while the phone's turn
  runs takes the queue path) and the sidebar spinner starts. The panel
  renders the remote user bubble (content-deduped — the persisted
  message.user row REPLACES it on refetch, never a double), the
  Thinking… placeholder covers remote mirrors, and
  AssistantTurnHeader + the debug copy read `liveTurn.model ??
  effectiveModel`.
- **The model pick becomes server truth**: `patchSessionSelectedModel`
  (the exact R114-b body); `onModelChange` keeps the localStorage
  override + self-heal and ADDS the fire-and-forget PATCH (null clears
  the session tier so "Auto" means Auto everywhere; a failed PATCH is a
  quiet warn-and-keep — the pick still rides every send as the override)
  + the `["session"]+["sessions"]` invalidation. The DISPLAY seed: the
  pure `resolveSessionModelDisplay` =
  `loadModelOverride(sessionId) ?? session.selectedModel ??
  loadLastUsedModel()` (display-level only; the per-send
  override-first semantics untouched) — the seeding effect re-runs on
  the session's `selectedModel` string key, so a phone-side pick lands
  through the meta frame's immediate invalidation → refetched row →
  re-seed, while a session with a LOCAL override never re-seeds (tier 1
  wins — this device's pick keeps displaying).
- **The ImageAnalysis rework + the ModelSelector audit**: §0's two items
  — the two-option radio, the configured∩supportsVision picker
  (`visionCapableModelRows`, one GET on the SHARED
  `["models-configured"]` cache), the empty state's deep-link; the audit
  found the composer picker already clean since R89-B3 and the real leak
  in the vision tab's old provider select — removed with the rebuild.
- **The four appearance prefs go live-synced**: `pushAppearanceToServer`
  widened to the six-field domain; the four chat setters joined the
  optimistic write-through under the SERVER field spellings
  (`sidebarTint` stays local-only — not in the domain);
  `applyServerAppearance` applies every PRESENT chat field under the one
  echo guard (boot hydration AND live frames — one path), with the
  strict posture: a present-but-INVALID value rejects the WHOLE frame
  (malformed is malformed — a half-applied patch would leave the
  devices disagreeing), an ABSENT field never touches its local twin.
- **Transcript polish (restraint)**: the two real inconsistencies fixed
  (OL marker alignment, first-block margin) + the skills tool-row
  identity (own icons + past-tense labels); the code-block chrome /
  inline-code / GFM table work was verified ALREADY LANDED (R95/R100-D)
  and deliberately not re-done.

## §5 The phone's inventory (R114-f, 46a08e8) — Models & Providers in full

- **The latent bug fixed first**: `apiJson` read Fastify's EMPTY 204
  bodies as BAD_JSON — the existing `setProviderKey` (PUT /key → 204 no
  body) could never report success. `apiJsonNoBody` (empty 2xx body IS
  `{ok:true,data:null}`; non-JSON non-empty still BAD_JSON honestly),
  regression-pinned.
- **The providers index**: "Your providers" as full clay cards (name,
  the key-count chip, off badge, baseUrl mono) above the divider's
  "Add a provider" tier (unconfigured presets as add-rows + the Custom
  provider row opening the CREATE sheet: name, base URL, the
  api-format chip row — the route's exact three-value enum, the first
  key chained through PUT /key after the create; a key-save failure
  never loses the provider — the sheet flips to "Done — add its key
  from the page"). Server validation surfaces inline (the 409
  name-collision message verbatim).
- **The provider detail**: the header card (identity, the live enabled
  switch, Rename, Test connection) + THE KEY POOL — one clay card of
  slot rows (Primary key / Key N, masked mono values, empty slots
  dimmed), per-slot Test, per-slot Remove for pool slots / Replace for
  slot 0 (the server 409s primary deletes over HTTP — replace is the
  only honest phone affordance), the Add-a-key row computing
  `nextFreeKeySlot` (the desktop key-pool twin: primary empty → the
  primary path, else first free in [1,31], gaps never collide, −1 =
  full) and STATING which slot it will write before the paste.
- **SAVED MODELS as the truth** (the owner's core demand): the
  provider's `models-config` rows only — clay cards with the humanized
  name, the raw modelId in mono micro, vision/thinking icon chips,
  hidden rows dimmed + badged; tap → the actions sheet (Test with the
  60-char reply peek, Hide/Show as ONE TAP, Edit, Delete with the
  two-step inline confirm); the edit sheet (modelId read-only —
  identity on PATCH; displayName; context window + input/output price
  with blank → null = clear-to-unknown and malformed → the per-field
  inline error; the capability toggles with "Accepts image inputs"
  PROMINENT — the owner's R61 caption).
- **The add-model flow**: FROM CATALOG (the live listing with the
  STATIC catalog as fallback — the source line says which) → searchable
  (id-or-name), saved models hidden from the pick-list, capped at 60
  with the honest line, a tap PREFILLS the shared form (the desktop
  prefillFor port: live name wins → static displayName → cleanModelName;
  the static row fills context/pricing/vision on id match) for review →
  Save; CUSTOM: the blank form (modelId required, everything else
  optional incl. the vision toggle).
- **The sheet architecture** (now trusted): every sheet ALWAYS MOUNTED
  with the open prop toggling (the exit animation survives), nullable
  data props carried by an internal snapshot, the edit/rename sheets
  hydrating ONLY on the open EDGE (a mid-edit epoch refetch can never
  clobber what's typed), the actions sheet re-deriving its model off
  the parent's fresh list by row id.

## §6 Verification (every number below was actually run, per commit)

| Commit | Scope | Gates fresh at the committed tree |
|---|---|---|
| e18b37d (R114-a) | mobile/ only, 1 file +22/−3 | the systemic sheet fix — no test delta (mobile carries **332/332**, 17 suites, from the R113-e close; the fix is layout-only, pinned by every sheet-riding test added in the waves that followed) |
| a0ac11a (R114-b) | agent-core only, 21 files +2,086/−147 | agent-core **2608/2608** (136 files; baseline 2570 + 38 in `tests/r114-sync-wave.test.ts`; the 17 failures of the inherited tree — 5 real behavior-pinned suites + the leaked-turn cascade — resolved by honest re-pins, zero regressions); ROOT `tsc -p tsconfig.json --noEmit` clean; eslint clean; secret scan 0 hits |
| 6966120 (R114-c) | mobile/ only, 21 files +2,529/−773 | mobile tsc clean; mobile jest **347/347** (18 suites; baseline 332 + 15: sessions +2, fs-browse +8, appearance-sync +5, the scaffold vocabulary pin); ROOT tsc clean; eslint clean; secret scan 0 hits |
| 328ab6d (R114-d) | mobile/ only, 12 files +2,057/−107 | mobile tsc clean; mobile jest **388/388** (20 suites; baseline 347 + 41: sessions +19, events +3, chat-prefs +9, streaming-args +10); ROOT tsc clean; eslint clean; secret scan 0 hits |
| 54bcaa9 (R114-e) | src/ + root tests only, 21 files +1,662/−255 | ROOT tsc clean; root vitest **4315/4315** (242 files; baseline 4255 + 60: stream-store +2, stream-remote +4, events-stream +4, composer-utils +7, api +3, theme-store +7, settings-store +3, Composer +1, AgentChatPanel +2, ImageAnalysisTab re-pinned ~12); eslint clean (the one stale eslint-disable reworded as a prose deps note); secret scan 0 hits (the two `sk-or-v…` matches are the masked-key DISPLAY fixture — never the real shape) |
| 46a08e8 (R114-f) | mobile/ only, 5 files +3,160/−455 | mobile tsc clean; mobile jest **430/430** (20 suites; baseline 388 + 42 in config.test.ts — the wire calls one-by-one incl. the PUT /key 204-empty regression + the pure math); ROOT tsc clean; eslint clean; secret scan 0 hits |
| 7344fdf (R114-g) | mobile/ + one src doc comment, 5 files +48/−10 | mobile tsc clean; mobile jest **431/431** (20 suites; +1 the subagentStatusLabel vocabulary pin); ROOT tsc clean; secret scan 0 hits |

**The fresh matrix at 7344fdf** (re-run by this docs round): ROOT
`tsc -p tsconfig.json --noEmit` clean · root vitest **242 files
4315/4315** · agent-core standalone **2608/2608** (136 files) · mobile
tsc clean + **20 suites 431/431** · secret scans: **0 hits** for
`github_pat_`/`sk-or-v1-`/`nvapi-` on every round's diff. This docs
round adds docs:check **242 scanned / 0 failures** (the baseline was 241
— this file is the 242nd; the same 2 transient URL WARNs as the
pre-round baseline, under the 3-failure cap).

### §6.1 The defect audit (R114-g)

A 25-item defect audit walked the owner's complaint list against the
landed tree: **24/25 ✅**, three findings on the one failing item —
(1) the composer's project-files list did not scroll on Android (the
R114-a sheet fix made the list REACHABLE, but the inner ScrollView's
gesture stayed owned by the outer scroller — `nestedScrollEnabled` now
lets it scroll), (2) the sub-agent badge read raw machine vocabulary
("completed"/"cancelled" surfacing verbatim — `subagentStatusLabel`
maps them to done/stopped, unknown values pass through unchanged),
(3) the ImageAnalysisTab's header doc still described the retired "off"
mode and the old provider-select picker. All three fixed as 7344fdf
(the src change is comment-only truth-telling; the behavior changes are
the two mobile legs, pinned by the +1 test).

## §7 Deferred (with reasons, not excuses)

- **The owner's round-114 walkthrough** — the live cross-device test on
  real hardware (send from either device and watch the other flip; pick
  a model on the phone and watch the PC's pill; flip the chat prefs;
  check the dashboard hues + the accordion). The suites pin the
  machinery; only the owner's hands close the loop.
- **The v0.108.0 release round** — the 7-file version bump + tag +
  assets + DASHBOARD sync; the CHANGELOG's Unreleased section (this
  round) renames at tag time.
- **Provider deletion from the phone** — `deleteProvider` exists in the
  feature layer (complete + tested surface) but no detail-screen
  affordance: provider deletion was not among the owner's demands, and
  the route's force/reset semantics deserve their own deliberate affordance.
- **`selectedModel` in session list rows** — the rows stay
  status/last-activity only; the honest model lives on the session
  screen (header subtitle + composer pill) where the ladder's verdict
  can be shown with its tier.
- **Sub-agent vocabulary beyond badges** — the badge reads owner
  vocabulary now; the sub-agent CARD's body/label vocabulary (role,
  task wording) stays machine-shaped pending the owner's verdict on
  what he wants surfaced.
- **The off-LAN relay walkthrough** (R112's standing item) + **Firebase
  (FCM v1)** (owner-deferred) + **GitHub Actions release speed** (its
  own round) + **the StablePrefix split** (OMP #2 — a dedicated round:
  chat.ts + runtime.ts + a golden re-pin) — the standing deferred queue,
  unchanged this round.

Next: the release round (the version bump renames the CHANGELOG's
Unreleased section), then the owner's walkthrough.
