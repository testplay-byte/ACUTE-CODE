<!-- last-reviewed: 2026-09-26 round-130 -->
# Round 130 — the composer fit + the mobile tool groups + the live meter

**Owner directive:** his device pass on v0.122.0. What he confirmed GOOD
(no work): the sidebar rework and its animations ("the left sidebar you
handled it properly… there are also smooth beautiful animations, which I
am quite happy that you implemented"). What he wants fixed, in his words:

1. **PC composer — the three dropdown ARROWS must go.** The operation-mode
   selection, the provider selection, and the thinking-level selection
   each "shows the arrow on the right side… which is not a good thing to
   have. I don't want you to show those."
2. **PC composer — the SHRINK CLIFF.** Shrinking the conversation area
   shrinks smoothly "with animations, like everything starts to become
   smaller, which is good. But after a point, instead of doing anything,
   the whole section moves up, like the whole upload file and the
   operation mode moves to the above line, which is not what should
   happen."
3. **PC composer — the LEFT GAP.** "The whole message input area was not
   expanding to the left side… it was leaving quite a lot of empty area on
   the left side… most probably because of the message quick navigation
   system… which is a good system, we need to keep it, but we need to make
   sure that it utilizes a bit less space, and also it should not affect
   the bottom text input fields."
4. **Mobile — the tool cards.** "The tool cards were always being shown
   expanded… the tool cards were not grouped together like how they are in
   the PC version… the text was not shown in the appropriate place… at the
   top, the tools will be shown, and at the bottom, without formatting,
   the text will be shown. But what should have happened… when the text
   was received, then the text should be shown; when the tool cards were
   made, there the tool cards should be made." Plus "it needs to be
   properly color coded", and the tap target: "I tapped on it, it
   apparently did nothing… I had to click the arrow."
5. **The live context meter.** "I did not saw the token context window
   increasing or decreasing along the way while the model was working…
   I should be showing the context window being used in live view… the
   actual context window should update while the agent is working" — and
   the stop glitch: "if I stop a conversation midway, then it would say…
   that the context window has been failed up and it is not proper."
6. **Mobile — the update flow.** The Update option sits directly below
   Settings in More (not inside Settings); the update screen shows ONLY
   the version at top + ONE Check Updates button (no description, no
   shield icon, no details even when an update exists); the check opens a
   BOTTOM-UP sheet with the details + the download button at its bottom;
   after starting + closing the sheet the PROGRESS renders below the
   check button with cancel (and delete once downloaded; install when
   ready); the GitHub token section is removed outright.
7. **Local testing without building.** "Do local testing on your
   environment without even building it… local prototyping… seeing how
   things function" — with the provided OpenRouter keys, FREE models
   only, choosing whichever is reliable and fast.

**Method:** the playbook arc verbatim — this plan first, the backup
branch `backup/pre-r130-improvements` pushed at the clean tip, then the
waves in dependency order, every gate green before the next, honest
records in the worklog, the constitution amended BEFORE the code that
breaks its letters.

---

## §0 The research (three parallel explore agents, file:line evidence)

- **The composer map** — the three "arrows" are the trailing
  `ChevronDown` glyphs on the custom pill buttons (ModeSwitcher.tsx:99,
  ModelSelector.tsx:648, ThinkingLevelButton.tsx:155 — no native
  `<select>` anywhere in the composer). The wrap cliff lives in the
  toolbar: the right selector cluster is one UNSHRINKABLE item
  (`ml-auto … shrink-0`, Composer.tsx:672) inside the R51-c flex-wrap
  fallback area (:658), so when the tiers exhaust, the WHOLE cluster
  drops to a second line and the box grows upward. The left gap is the
  reading-column inset the dock inherits (CONTENT_H_PAD_CLASS
  pl-12/14/16, AgentChatPanel.tsx:180-189 → the dock at :4815) — the
  MessageTimeline (w-9 corridor at left-1, MessageTimeline.tsx:400) never
  reaches the dock (it is clamped to the transcript wrapper :4102), the
  padding is purely the R124 "composer aligns with the reading column"
  law.
- **The mobile transcript map** — `turnElementsPlan`
  (transcript.tsx:1104-1150) pushes ALL tool cards, then ONE reply at the
  bottom: exactly the "tools at top, text at bottom" the owner rejects.
  Tool cards are OPEN by default (`useState(true)` :1718); each card is
  independent (no grouping); the tap target is the HEAD ROW Pressable
  (:1970-1976) — the card's own padding is NOT tappable, which is why
  "sometimes it does not" respond. The PC's own grammar (WorkingSection
  ToolLine, WorkingSection.tsx:2029) groups every call in ONE fold with
  the auto-lifecycle law: expand when live, hold ~2s, auto-collapse,
  failures stay open, the user's tap wins.
- **The context meter map** — the PC donut already polls 2.5 s while
  streaming (ContextDonut.tsx:1071-1083) and its query key carries the
  transcript length, so it DOES move live on desktop; the PHONE has the
  full typed client (features/context-meter.ts) and the live poll
  (composer.tsx:549-570) but surfaces the number only inside the kebab
  menu's Context level (session/[id].tsx ContextLevelReadout :1973) —
  invisible while the model works. The stop glitch has a real honesty
  bug under it: the abort partial persists `usage {0,0}`
  (runtime.ts:4559 → flushSegment :4286-4296 writes the counters that
  were never filled), and the meter's `actual` scan ACCEPTS it
  (sessions.ts:918-923 checks only `typeof number`) — after a midway
  stop the meter reports a fabricated "0 measured at last request" (the
  R127 anchor skips ≤0 rows at compaction.ts:605; `actual` does not).
  The PC error string the owner can read as "the context window failed"
  is the report's isError title "Context window usage unavailable"
  (ContextDonut.tsx:1126-1127) — `retry:false` means ONE transient
  failure (the stop boundary's invalidation refetch) strands the meter
  on that string forever once streaming flips false.
- **The update map** — More has no update row (more.tsx:244-259 is the
  settings entry, the LAST row); the "App updates" row lives inside the
  settings hub (settings/index.tsx:110-124). The screen
  (settings/update.tsx, 514 lines) shows the description caption
  (:270-273), the ShieldCheck icon (:293-295), inline release details +
  download (:303-334), a download card (:358-384), an install card
  (:386-424), and the token section (:426-467). The reusable BOTTOM
  SHEET exists (components/sheet.tsx — the R118-A clay sheet with the
  over-damped spring + the honest close affordances).
- **The free-model probe** (the keys' own battery, 2026-09-26):
  `nvidia/nemotron-3.5-lightning:free` — tools ✓, streaming ✓, 1 000 000
  context, ~3 s first token — the primary test model (the 1 M window
  makes the meter's live math observable at scale);
  `cohere/north-mini-code:free` — tools ✓, ~0.8 s, 256 k — the fast
  fallback; `qwen/qwen3.8-27b:free` — upstream 429 on the shared pool,
  rejected.

## §1 The waves

### Wave A — the PC composer's fit (files: Composer.tsx, ModeSwitcher.tsx, ModelSelector.tsx, ThinkingLevelButton.tsx, AgentChatPanel.tsx, MessageTimeline.tsx)

- **A1 — the arrows die.** Delete the trailing `ChevronDown` from the
  three trigger buttons (ModeSwitcher:99, ModelSelector:648,
  ThinkingLevelButton:155 — the menu ROWS keep their Check glyphs; the
  pills keep their leading family icons, so they still read as pickers).
  The `-mr-1.5` collapsed-tier margins stay (they close the label's own
  gap slot, not the chevron's).
- **A2 — the smooth shrink replaces the cliff.** The right selector
  cluster becomes SHRINKABLE (`min-w-0`, `shrink-0` dropped) and the
  model pill becomes the row's flex sponge: its wrapper takes `min-w-0`
  and the button `min-w-0 w-full` so the label (already `truncate`)
  ellipsizes CONTINUOUSLY past the tier ladder instead of handing the
  whole cluster to the wrap line. The R51-c `flex-wrap` stays as the
  never-overlap emergency fallback (absurd freeform widths) — the pinned
  R78-B test is AMENDED to pin the new cluster contract, not deleted.
- **A3 — the dock owns its left inset.** The docked composer's wrapper
  stops composing CONTENT_H_PAD_CLASS; a new `COMPOSER_DOCK_H_PAD_CLASS`
  (pl-5 → md:pl-6 → xl:pl-7, right leg unchanged) rides the dock and the
  empty-state slot, so the input EXPANDS LEFT over the dead air the owner
  named. The reading column (messages) keeps its graduated padding.
- **A4 — the timeline slims.** Corridor w-9→w-7 (36→28 px), chips
  10→8 px rest / 28→20 px magnified, pl-1.5→pl-1 — the quick nav
  "utilizes a bit less space" and its reading-column floor is re-derived
  (pl-11 still clears the 32 px corridor + daylight at the narrowest).
- **Constitution:** SCREENS.md §3 amended — the composer dock no longer
  aligns exactly with the reading column (it owns a wider inset, the
  owner's ask), the timeline corridor law re-stated at 28 px, and the
  picker-pill law gains "no trailing chevron glyph".

### Wave B — the mobile transcript's tool groups + interleaving (files: transcript.tsx, features/turn-block.ts, the two pinned suites)

- **B1 — emission-order interleaving.** `turnElementsPlan` v2: after the
  rail + thinking row, the plan walks `group.items` IN ORDER, folding
  runs of consecutive tool items into `tool-group` elements and runs of
  consecutive assistant segments into `text` elements — text renders
  WHERE IT WAS RECEIVED, tool groups where the calls were made. The reply
  meta line rides the FIRST text element with content.
- **B2 — the tool GROUP (the PC Working-fold grammar).** One clay card
  per RUN of consecutive calls: a group header (the count + the running/
  failed glance + chevron) and the calls inside as ONE-LINE rows. The
  auto-lifecycle law ports from the PC's ToolLine: OPEN while the turn is
  live, COLLAPSED when settled (hold ~2 s first), groups containing a
  FAILED call never auto-collapse, the user's tap wins for the group's
  lifetime. Collapsed-by-default is the owner's explicit ask — the
  R123-W-m "open by default" law is RETIRED in chat.md with the record.
- **B3 — the tool ROW + color coding.** Each call inside the group is a
  one-line row: family icon in the family color + a 2.5 px family-colored
  left stripe + the verb·target title + diff chips + the quiet status
  chip; tap ANYWHERE on the row expands its details inline (the old card
  body: tails, args, outputs). Family colors: write = accent (terracotta),
  terminal = warning (amber), read = accent2 (taupe), web/browser = the
  chart sage teal, generic = textSecondary; FAILED keeps the danger wash.
- **B4 — the tap-anywhere fix.** The press target IS the row's whole
  card (the row is a Pressable at the row level, hitSlop generous), and
  the group header likewise — no more dead zones in the card padding.
- **Tests:** transcript-turn.test.ts re-pinned to the v2 plan (order,
  grouping, collapsed-default, live-open, failed-stays-open, colors),
  turn-block.test.ts gains the pure group-label helpers.

### Wave C — the live meter + the stop honesty (files: agent-core runtime.ts + routes/sessions.ts, src/lib/api.ts, ContextDonut.tsx, mobile composer.tsx + session/[id].tsx)

- **C1 — the abort partial stops fabricating 0.** `flushSegment(true)`
  omits the `usage` block entirely when both counters are 0 (the finish
  frame never arrived — absence is the honest encoding), keeping `ms` +
  `model`. Pinned end-to-end in r43-turn-error.
- **C2 — the meter's `actual` skips garbage rows.** The scan requires
  `inputTokens > 0` (mirroring the R127 anchor's own guard at
  compaction.ts:605), so a pre-stop stats-carrier can never displace the
  last REAL measurement. Same guard in the folded-turn usage merge
  (src/lib/api.ts). Pinned in context-report.test.ts (the
  newest-row-is-0 midway-stop shape).
- **C3 — the PC meter never strands on "unavailable".** `retry: 1` +
  one delayed refetch (2 s) when the report errors while idle — a
  transient failure at the stop boundary heals itself instead of parking
  the error title forever.
- **C4 — the phone's LIVE pill.** The session screen renders a compact
  always-visible context readout above the composer dock (the live-polled
  report the composer already fetches): `5% · 13k of 256k` in the micro
  mono voice, a 3 px pressure-colored meter line, breathing dot while the
  turn streams, honest "—" while unknown. The pill reads the SAME report
  the kebab's Context level reads (one truth); the poll refreshes once
  more when a turn ENDS (the stop boundary's number is the honest one).

### Wave D — the mobile update flow (files: more.tsx, settings/index.tsx, settings/update.tsx, sheet.tsx consumer)

- **D1 — the Update row moves to More.** A PressableCard directly below
  the Settings entry (same row grammar, the RefreshCw chip), pushing
  `/settings/update`; the settings hub's "App updates" row is REMOVED
  (the hub keeps its config rows only).
- **D2 — the minimal screen.** Top: the version — ONE card, `v{APP_VERSION}`
  and nothing else (the description caption dies). Below: ONE
  "Check updates" ChromeButton. Answers are one quiet line each (no
  icons, no details): "Up to date", the rate-limit retry line, the
  error line. An available update opens the SHEET, never an inline card.
- **D3 — the bottom-up sheet.** The reusable Sheet carries the release
  details (title, the v→v transition, the size, the notes digest) with
  the DOWNLOAD ChromeButton at the sheet's bottom. Tapping download
  starts the transfer AND closes the sheet.
- **D4 — the progress under the button.** While downloading: the
  determinate bar + the received/total mono line + a quiet danger Cancel
  under the Check updates button. When downloaded: "Ready to install" +
  the Install ChromeButton (+ the install-permission gate when Android
  demands it) + a quiet Delete (discards the APK) — all in the same
  slot, never a separate card.
- **D5 — the token section is removed outright** (the owner: "you can
  just outright directly remove it"). The updater's anonymous-first
  policy + its pinned tests stay untouched (a token saved by an older
  install still works; there is simply no UI to manage one).

### Wave E — the local battery (no build, the owner's explicit ask)

- The dev stack (`pnpm dev:full` — vite + the agent-core sidecar) on a
  scratch DB; an OpenRouter provider (baseUrl
  `https://openrouter.ai/api/v1`, OpenAI-compatible format) with
  `nvidia/nemotron-3.5-lightning:free` (1 M window — the meter's live
  math observable at scale; tools + streaming verified by the probe);
  the fast fallback `cohere/north-mini-code:free`.
- The agent-browser battery on the REAL stack: a live turn with tool
  calls (the meter climbing while it streams), a midway STOP (the honest
  post-stop number, no "unavailable", no fabricated 0), the composer
  width battery (arrows absent, the smooth shrink at 3 widths, the dock's
  left inset measured), screenshots into shots/r130/.

## §2 The gates (unchanged, the house law)

Root tsc + the FULL vitest sweep + agent-core tsc/vitest + mobile tsc +
CI=1 jest + eslint 0 + design-audit at baseline + docs:check +
version:check at the bumped 0.123.0 + license audit. The browser battery
replaces nothing — it is the round's OWN gate per the owner's directive.

## §3 Rollback

`backup/pre-r130-improvements` at the v0.122.0 tip (1d66c58's tree).

## §4 Honest caveats (pre-declared)

- The Android update flow's native legs (the OkHttp download, the OS
  installer hand-off, the permission gate) ride the owner's device pass
  — the jest pins cover the pure + orchestration layers, as they did in
  R124-R125.
- The tool GROUP's collapse timing (2 s hold) ports the PC's own
  constant; the on-device feel rides the device pass.
- The context pill's cadence is the desktop's exact 2.5 s — chosen for
  parity, not re-tuned.

---

## §5 The waves as they landed

- **Wave A** (commit `09df8c8`) — the arrows die, the cluster shrinks, the
  dock owns its left inset, the rail slims. Pins: the R130 pill-set test
  (the label is the LAST trigger child + exactly one leading svg), the
  shrinkable-cluster contract in the R78-B pin, the dock-inset test, the
  timeline geometry re-pins. Gates: Composer 93 + MessageTimeline 14 +
  AgentChatPanel 85 GREEN.
- **Wave B** (commit `c29ced4`) — `turnElementsPlan` v2 (the
  emission-order interleave + the run folding), the ToolGroup/ToolRow/
  ToolGroupHeader grammar with the ported PC lifecycle, the family colors,
  the whole-row press target, the pure `toolFamily`/`toolGroupLabel`
  helpers in turn-block.ts. Pins: transcript-turn re-pinned to the v2 plan
  (+ the interleave + the lifecycle + the label grammar), turn-block gains
  the classifier + glance pins. Gates: mobile tsc + jest 48/1,106.
- **Wave C** (commits `2f1c19b` + `5cd34dd`) — the abort partial omits
  fabricated usage, the meter's `actual` skips garbage rows, the api.ts
  folded merge guarded, the PC meter's delayed heal, the phone's live pill
  + the settle-boundary refresh. Pins: the midway-stop shape in
  context-report, the no-usage partial in r43-turn-error. Gates: agent-core
  30/30 on the touched suites, PC tsc + Composer + src/lib green.
- **Wave D** (commit `928e050`) — the More-screen Update row below
  Settings, the minimal screen, the Sheet-based download flow, the progress
  under the button, the real native Delete (path-validated), the token
  section removed. Pins: the two delete-affordance updater tests. Gates:
  mobile tsc + jest 48/1,108.
- **Wave E** (commit `2c191cd`) — the live battery ON THE REAL STACK: the
  sidecar on a scratch DB + vite + agent-browser, real
  `nvidia/nemotron-3.5-lightning:free` turns through the app's own SSE
  pipeline (tools, approvals, a live mode switch through the arrow-free
  picker). THE FINDING: the 1300px sweep caught the old ladder's
  comfortable-width wrap (a ~470px box overflowing by ~18px — flex
  line-breaking fires at base sizes before any shrink) → the denser
  ladder (240→170@520→100@480→80@420→logo@350), probe-verified single-line
  at 469 AND 337, wrap only at the 214px floor.

## §6 The close-out

**The full gate stack (all fresh, all green):** root tsc CLEAN; agent-core
tsc CLEAN; mobile tsc CLEAN; FULL root vitest **297 files / 5,208 tests**
(baseline 296/5,205); agent-core vitest **168 files / 3,091 tests** (the
midway-stop + no-usage pins); mobile CI=1 jest **48 suites / 1,108 tests**
(+10 vs the R129 baseline); eslint 0; design-audit CLEAN at baseline
(R1 100/101, R2 1538/1635, R3 0/0, R4 15/16, R5 13/21); docs:check green;
version:check 7/7 at 0.123.0.

**The live battery (the round's own gate — the owner's explicit ask,
"do local testing on your environment without even building it"):**
the dev stack (the real agent-core sidecar on a scratch DB at .dev-r130 +
vite with the VITE_ACUTE_* wiring + agent-browser at 1600px), seeded via
REST (agent → openrouter → the free nemotron model; project; session),
the wizard walked (the provider test answering "Connected • 2783ms •
nvidia/nemotron-3.5-lightning:free • server key"), then FOUR real turns.
THE EVIDENCE (shots/r130/):
- `01-boot` → `03-session-composer`: the live composer with **zero
  chevron glyphs** (probe-verified: 0 chevron svgs in the composer; each
  picker pill carries exactly ONE leading family svg and its label as the
  last child); the right cluster `min-w-0` without `shrink-0`.
- `04-turn-running` → `06-after-midway-stop`: the first tool-using turn
  (list_dir + read_file) completing with the REAL provider anchor
  ("6% · provider-anchored · 59k measured at last request (of 1m
  window)"); then a LONG turn STOPPED midway — "Stopped" rendered, NO
  "usage unavailable", NO fabricated zero (the event log's abort partial
  carries no usage; the meter fell back to the last REAL measurement, the
  20k iteration), the Continue affordance back.
- `07-narrow-760` / `07b-narrow-1300-single-line`: the shrink sweep —
  single line at box 469px (the ladder fix's whole point), at 337px; wrap
  only at the 214px layout floor (the legit R51-c emergency).
- `08-final-wide` → `10-context-details`: the dock's measured left inset
  (the composer's left edge 28px from the panel — the old 64px dead air
  reclaimed); the timeline corridor w-7 in the DOM; the meter's live
  polling confirmed (the 2.5s /context cadence in the network log), the
  headline stepping 59k → 20k → 81k → 62k across turns (BOTH directions —
  the R129 superseded-read stubbing visibly shrinking the re-sent
  context); the details popover carrying the live composition (Messages
  59.7k/71%, System prompt 8.2k, tools 4.7k) + the cache line (32% hit ·
  65k/202k cached); zero console/page errors across the whole session.

**The honest caveats:**
- The MOBILE surfaces (the tool groups on a real screen, the live pill's
  on-device cadence, the update sheet's native legs — the OkHttp download,
  the delete, the OS installer hand-off) ride the owner's device pass;
  the jest pins cover the pure + orchestration layers, as they did in
  R124-R129.
- The free-model battery used ONE model family (nemotron-3.5-lightning);
  the cohere/north-mini-code fallback was probed at the API level but not
  driven through a full app turn.
- The PC meter's mid-iteration number steps per COMPLETED provider
  request (the anchor's honest granularity — a finer live estimate rides
  the standing queue in round.next).

## §7 The release end-state

v0.123.0 tagged at `682b4b7` → **all five workflows SUCCESS** (CI + Mobile
CI + Rust Checks on the push; Release + Mobile APK on the tag). The
release **published** in one PATCH (draft:false, make_latest:true, body =
the [0.123.0] CHANGELOG section, the house-style name) carrying EXACTLY 3
assets — the arm64 APK + the Windows setup + the launcher kit (Linux
trimmed per the committed targets.json, no Rust changes this round).
`/releases/latest` answers v0.123.0; the APK's ranged read answers the PK
magic. Zero drafts remaining. The rollback door:
`backup/pre-r130-improvements`.
