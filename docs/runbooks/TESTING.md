<!-- last-reviewed: 2026-09-17 round-102 -->
# TESTING — the verification ladder

Five layers; each has a defined "when mandatory". Rules here are binding
(`WORKFLOW.md` §4 references them). Promoted from AGENT-MEMORY lessons
(#8–#35) into one place (round-17).

| Layer | What | Runs where | Mandatory when |
|---|---|---|---|
| L1 unit | `agent-core/tests` (AI SDK **mocked**) + frontend suites | `pnpm test` / vitest | every change, with the code |
| L2 verify | lint + typecheck + test + build + license audit | `pnpm verify` | before every commit/push (== CI) |
| L3 sidecar E2E | black-box vs built `agent-core/dist` (boots, auth, seeds, CRUD) | `pnpm test:e2e` (in verify) | automatic (rebuild dist first!) |
| L4 live battery | real provider turn(s), real disk, fresh DB | sandbox, single invocation | anything touching agents, projects, tools, streaming |
| L5 browser verification | real UI against the live stack; screenshots machine-verified | sandbox, single invocation | any UI-affecting round |

**Current counts (R84, per CI run 34484344162 + status.json; R85 re-verified the
file-level counts):**
the root `pnpm test` = **2,825 tests in 155 files, all green** (agent-core
**1,867/1,867 in 92 files** + frontend **946/946 in 60 files** + shared 4 in 1
+ e2e 12 — the sidecar-e2e run when a fresh `agent-core/dist` is present).
The arithmetic reconciles: 1,867 + 946 + 12 = 2,825 (92 + 60 + 1 + 2 = 155
files).
**Plus a NEW fourth suite surface (R74): the launcher's Python unittest
— `launcher/tests/test_pick_latest_release.py`, 10/10, stdlib-only,
run via `python launcher/tests/test_pick_latest_release.py` (or
`python -m unittest discover -s launcher/tests`) — wired into ci.yml's
verify job and release.yml's launcher-kit gate, so the release picker's
contract is gated on every push AND every tag.**
Trajectory: 262 (R42) → 397 (R43) → 471 (R44) → 565 (R45) →
622 (R46) → 683 (R47) → 752 (R48) → 815ish (R49) → 930 (R50) → 978 (R51) →
1035 (R52) → 1058 (R53) → 1071 (R54–R56, launcher rounds) → 1169 (R58) →
1302 (R59) → 1348 (R60) → 1491 (R61) → 1542 (R62) → 1632 (R63) → 1664
(R64) → 1686 (R65) → 1807 (R66) → 1961 (R67) → 2003 (R68) → 2082 (R69) →
2177 (R70) → 2287 (R71) → 2423 (R72) → 2558 (R73) → 2558 (R74 — the root
suite unchanged by design: the round's code is Python; its +10 live on
the new launcher surface above) → 2613 (R75 — +55: +48 agent-core across
two NEW suites, +19 frontend minus the 12 e2e overlap accounting).

**R75 (the reliability & enforcement round):** TWO NEW agent-core
suites + one extended chat suite: `r75-retry-ladder` **19** (NEW: the
owner's ladder schedule verbatim in constants, the transient split,
waitForRetry's deadline/abort/tick semantics under fake timers, the
active-wait registry, the formatter; streamed integration — the
immediate-rung recovery with the meta.retry frame shape, the FULL
ladder exhaustion through fake-timer advance of all four timed rungs
→ attempts=6 on the envelope + the persisted turn.error + queued, the
non-transient second failure stopping at attempts=2, the user-stop-
during-a-wait → ABORTED; sync integration — the immediate rung + THE
SWALLOW FIX: a failure after partial replies returns 502 + a usage row,
never ok:true) and `r75-mode-policy` **27** (NEW: the policy sets with
registry-vocabulary validation, the intersection semantics incl. the
NO_TOOLS sentinel and custom-shadow pinning, TURN integration for all
six modes + modeless byte-identity (toolset + prompt toolNames + the
ENFORCED body line), the debug command tier (4 approval cases incl.
debug × Full-Access denial), delegation inheritance, and the switch_mode
owner-pinning refusals). Plus chat-format's error-PART re-throw pair
(the live-429 find: an {type:'error'} fullStream part THROWS the
original error, and the RetryError message classifies rate_limit).

**R74 (the updater-freeze round):** root 2558 re-run green, unchanged —
the round changed ONE Python file (`launcher/acute_launcher.py`, the
first launcher change since R63, flagged per golden rule 1, ACUTE.bat
byte-identical) and adds ONE new test surface: the **launcher Python
suite (10 tests, NEW `launcher/tests/test_pick_latest_release.py`)** —
the repo's first non-vitest suite, stdlib `unittest` only, loading the
REAL launcher module via importlib (its module level is constants-only
by construction — import-safe). The 10 pin `_pick_latest_release`'s
contract: the exact round-74 owner-freeze list shape (the real
2026-09-07 API order — five never-published drafts ABOVE the published
releases — must pick 0.73.0, with the chosen asset's id + digest
passthrough, the sha256 install verification depending on it), order
immunity in both directions, the lexicographic trap ('0.9.0' vs
'0.10.0' — numeric, not string compare), major-beats-minor, the
all-drafts era (drafts first-class by design — updates still flow),
the same-version tie preferring the PUBLISHED entry in both list
orders, no-installer-assets → None, empty list → None, malformed
entries (non-dict releases / assets:null / id-less / non-dict assets)
never crashing, and non-matching asset names (arm64, two-component,
suffixed) ignored while the x64 name matches. Plus the round's
double-run LIVE smoke: the REAL `/releases?per_page=100` JSON through
the picker → 0.73.0 — executed by the orchestrator and independently
re-executed by the R74-b hostile verifier (9/9 PASS, verdict SHIP).

**R73 (the task modes round):** +135 root over R72's 2423 — +116
agent-core (four NEW suites + honest re-pins) + 19 frontend (the picker
+ the strengthened panel suite): `r73-modes-core` **28** (NEW: the six
builtin postures' shape pins — fixed order + sortOrder + frozen
array/entries, bodies 1,200-3,000 distinct with posture statements,
descriptions 280-500 in the trigger-rich convention, PAIRS WITH names
real skills, a computeTaskHints cross-validation — 'fix this bug' →
Debug, 'clean this up' → Refactor; the `.acute/agents/*.md` discovery
— happy path with byte-exact stripped body + absolute filePath,
absent-is-clean, undefined/"" roots, silent skips, determinism + a
zero-writes snapshot proof; name→id + slugify + the 64 cap +
first-file-wins; custom-shadows-builtin with the 5 builtins intact; the
caps — 16K marker + 500 desc + 9 files → 8 + too-many-modes +
invalid-tools + dedup; the failure family — missing-description exact
fallback, empty-body, subdirectory not-a-file, chmod-000 unreadable,
never throws; findMode + all 8 diagnostic kinds rendered) ·
`r73-system-reminders` **16** (NEW: byte-identity for 3 realistic
convention inputs + the delegation pin — renderReminder ===
conventionReminder over 3 real DirConventions + render purity; the
task-mode/note shape pins; ReminderBudget allows/mark/idempotence/
default-3/custom-max/no-op-at-max/snapshot/instance purity) ·
`r73-skills-round` **17** (NEW: the TWENTY-builtin count pin with
names/ids/sortOrders 0-19; per-skill trigger-rich + house-format it.each
over the two new seeds; distinctness; INSERT OR IGNORE idempotence +
the deleted-row-revives convergence → 20; user-edit persistence;
disable-hides; the flow-through — all 20 render in the prompt SKILLS
section) · `r73-modes-backend` **45** (NEW: the 23-section registry pin
+ after-skills positions + strict-gating byte-identity incl. tail
checks; computeModeHints scoring/threshold/top-2/id-asc ties + the
builtin cross-validation 'fix this bug' → debug; storage + the 0027
migration matrix incl. the ALTER's one-shot semantics; the route family
— PATCH set/clear/null/untouched/unknown-400-with-available-ids/
no-side-effect-rename/404/title+mode-together + GET /modes
metadata-only + customs + shadowing + resolver parity; switch_mode's
three calls + sentinels + idempotence + the custom-id path; the runtime
e2e — index/signal/ACTIVE-body on BOTH turn paths, the vanished-mode
sweep + one-turn note, the live tools-narrowing + the
narrowAllowListByTaskMode unit matrix incl. NO_TOOLS cases) · re-pins:
the skills trio `r71-skills-round` 75 → **83**, `r70-skills-system`
51 → **53** (the 18-count pins mechanically moved by the 18→20 growth,
strengthened-only — the R72-b house pattern), the vocabulary re-pins
(prompt-registry/storage/projects-tools/r52-plugin-registry/memory-
tools/models-catalog — switch_mode joins TOOL_NAMES, BUILT_IN_PLUGINS
13→14) with prompt-registry's count unchanged at 22 but its golden
toolNames FROZEN to the fixture's exact vocabulary (the md5 is the
pin) + MODES_CTX + order pins added · frontend: `TaskModePicker` **10**
(NEW — pill labels + aria + the raw-id fallback that never renders
Auto; menu rows + the line-clamp pin + the full description on the row
title; the custom chip on file-source rows only; selection reports the
id; Auto reports null; the current-mode no-op; disabled; Escape) +
`AgentChatPanel` 23 → **32** (the activeMode sync from the session row,
the optimistic GUI path, the failed-PATCH rollback + toast, the /mode
intercept — set/clear/bogus/bare-list/capitalized-NAME — and the
not-intercepted full turn). The golden fixture BYTE-IDENTICAL (md5
3a5d2c7d…, untouched — both new prompt sections are strictly ctx-gated;
no regen performed or needed) and r72-task-hints 27/27 +
r72-dir-conventions 20/20 GREEN UNMODIFIED (the two hard gates — the
matcher and the conventions bytes ride unchanged). Zero Rust/`src-tauri`
files touched. Plus the first LIVE HTTP e2e smoke of the mode routes
against a real sidecar spin (GET /modes incl. a custom, PATCH set /
bogus-400-with-availableModes-unchanged / null-clear — all green). The
live gates (the TASK MODES section + Task signal line on real messages,
switch_mode activation riding the following turns, the picker + /mode
slash, the two skills' triggers, custom-mode tool narrowings) await the
owner's Windows field run.

**R72 (the adaptive capability round):** +136 root over R71's 2287 —
all of it in agent-core, four NEW suites + honest re-pins:
`r72-task-hints` **27** (NEW: the deterministic matcher — phrase ×5
dominance with exact scores, case-insensitivity, token accumulation,
the stopword filter, the score-1 threshold, phrase-alone qualification,
the top-2 cap, name-asc tie-break, empty/whitespace, both quote types,
contraction flattening positive + no-fragment-leak negative, the 8K
cap, the real `debugging` description ≥10 on the canonical message;
the rendering — exact one/two-name advisory lines, placement, the
renderer's 2-name cap, absent/[]/undefined → byte-identity,
hints-without-skills → no line; the e2e on BOTH turn paths — the
system-capturing chatStream + chat patterns, the exact debugging line
for "my test keeps failing, fix this bug", unrelated messages → no
line, the dark-skill pin, per-turn ephemerality) · `r72-skills-
expansion` **32** (NEW: the 18-in-fixed-order pin; per-skill
trigger-rich contracts over all six + distinctness + house-format
it.each; six deep discipline-contract tests; key-rules-verbatim pins;
idempotent double re-seed; the deleted-row-revives convergence across
a real close/reopen; user-edit persistence; disable-hides; the D4
flow-through — all 18 descriptions render in the prompt SKILLS
section) · `r72-references` **27** (NEW: discovery metadata + caps +
skip logs; the loader's sanitized-name/ENOENT/64KB-marker contract;
the read_skill listing block + the {name, reference} path + the honest
error family + computer-use/allowlist gate parity; the GET /skills
additive metadata + no-content-leak; the buildProjectTools end-to-end)
· `r72-dir-conventions` **20** (NEW: the walk pins — deepest wins,
CLAUDE.md fallback, root-only → null, wrong-shaped falls through, the
2,000-char cap + marker; the exact reminder format; the dedup pins
incl. sessionless always-true; the toolset pins incl. RAW readFile
back-compat + the failure-path no-reminder) · re-pins:
`r71-skills-round` 51 → **75** (the expected-builtin/trigger-phrase/
negative-scope tables extended to 18, "TWELVE"→"EIGHTEEN", the
house-format + emoji discipline extended to the six),
`r70-skills-system` 45 → **51** (18-seed pin + sortOrder 0-17, the
NEW_BUILTINS it.each 11→17, the end-to-end loop includes the six). The
golden fixture BYTE-IDENTICAL (md5 3a5d2c7d…, untouched — ctx.taskHints
is purely additive; no regen performed or needed). Zero Rust/`src-tauri`
files touched. The live gates (the task-signal line on real messages,
the six crafts' triggers, references loading, nested-dir conventions
reminders) await the owner's Windows field run.

**R71 (the discipline & reliability round):** +110 root over R70's
2177 — all of it in agent-core, three NEW suites + honest re-pins:
`r71-prompt-discipline` **24** (NEW: the engineering-discipline registry
position + stamped-run position + composed-text order + unconditional
composition; the four karpathy mantras + ≥4 binary self-tests; the
asymmetric orphan rule; [KNOWN]/[ASSUMED]/[UNKNOWN] + the
never-code-on-an-UNKNOWN rule; the 3-strike rule; all five red flags
with rebuttals; the three task→verifiable-goal mappings in both PLAN
variants; verification receipts + 🟢🟡🔴 + devil's advocate +
anti-question-padding; the sub-agent scope/no-polling lines + honest
no-delegate gating; the override-hook replace/empty-drop cascade; the
D6 size budget incl. the re-anchored 22K bound on the default
composition) · `r71-tool-reliability` **31** (NEW: the truncation
markers teaching the exact next call; the degenerate single-line
honesty; the edit-streak pure tiers at every boundary + reset-on-
success + non-anchor failures not counting + the real-toolset
escalation path; the denial/timeout/abort texts across command/web/
computer-use; the classifyProviderError classifier table incl. the
rate-limit veto + status-only auth + the bounded status walk; the
compaction force-mode primitive; the overflow recovery on BOTH turn
paths — streamed + sync — incl. the second-overflow terminal, the
last-iteration guard, partial-content no-recovery, non-overflow bypass)
· `r71-skills-round` **51** (NEW: the 12-in-fixed-order pin; per-skill
trigger-rich contracts + verbatim trigger-phrase pins ×12 +
negative-scope pins ×12; the 4 new-body house-format pins + iron-law/
output-block content pins; emoji discipline; idempotent double re-seed;
deleted-row-revives-on-reopen via a real close/reopen; user-edit
persistence; the D4 flow-through pin proving all 12 descriptions render
in the prompt SKILLS section) · re-pins: `r70-tool-feedback` **18**
(the changed markers — meaning preserved, the pins stricter),
`approval-flow` **11** (the denial-note text), `r70-skills-system`
41 → **45** (8→12 count/order pins, the body contract extended to the
four new skills), `prompt-registry` **22** (order pin strengthened +
the golden regen trail), `r70-prompt-round` **34** (the receipts pin
stricter than the old evidence pin). The golden fixture regenerated by
the sanctioned procedure (20,156 → 23,665 bytes). Zero Rust/`src-tauri`
files touched. The live gates (receipts in real replies, skill triggers
on real phrasings, edit-escalation ending flail loops, overflow
recovery saving long sessions) await the owner's Windows field run.

**R70 (the agent brain round):** +95 root over R69's 2082 — all of it
in agent-core, three NEW suites + two pin updates: `r70-tool-feedback`
**18** (NEW: run_command head/tail exact-prefix/suffix/marker/cap pins
on a 70,008-char fixture; the zero-stdout success/failure split; the
job_status empty-log case; read_file's cat -n format exact incl.
no-trailing-newline + lone-newline files, the empty-file message,
offset/limit windows + all four validation errors + the EOF-clamp note,
the >256KB head+tail with offset/limit retrieving the middle, the
single-giant-line byte-slice, the RAW readFile back-compat pin,
tool-level execute + description pins; todo_write's six guidance
clauses) · `r70-skills-system` **41** (NEW: file discovery both
sources + caps + frontmatter tolerance; DB-shadows-file precedence
enabled OR disabled; read_skill file bodies from disk + de-listing +
the agent filter + the CU refusal; the merged listing with provenance
+ the 409 file-skill refusals; the 8 builtins' order/lengths/content
pins + edit-persist + revive-on-reopen; the sticky budgets + the
12-call history keeping a call-#2 read_skill FULL; the end-to-end
runStreamedAgentTurn wiring of agent.skills and the CU gate) ·
`r70-prompt-round` **34** (NEW: the env fields + git fallbacks +
Windows/POSIX-only TERMINAL lines + env-less byte-compat; the merged
five-phase section + the three retired ids; the six-file convention
ladder + source markers + @file imports/cycles/caps) · +2 pin updates
(prompt-registry's FULL_CTX / permission-modes' plan-mode tool list).
The golden fixture regenerated by the sanctioned procedure (22,625 →
20,156 bytes). Zero Rust/`src-tauri` files touched — CI's cargo check
rides the same code as the green v0.69.0 build. The seven new skill
bodies are construction-pinned — the owner's real tasks are the live
gate (exactly as the computer-use skill body was re-taught in R69
after the field run).

**R69 (the computer-use enforcement layer):** +79 root over R68's 2003 —
all of it in agent-core (the full verifier's CI-mirror run, re-confirmed
by the docs pass): `computer-framehash` **13** (NEW: the 8×8 aHash
itself — identical PNGs → 0, structural/shifted-gradient changes > 8,
region crops stable when the change is out-of-region and > 6 when
inside, OOB rects clamped/fully-outside-null, the decode LRU pinned
via a `PNG.sync.read` spy — same-key shares one decode, 4-entry
eviction, re-touch recency) · `computer-dispatch` 72 → **109** (the
auto-refresh ladder: static → proceeds with the full receipt +
`auto_refresh` provenance, stable-region → proceeds
`targetRegionStable`, changed → `frame_changed` with the payload +
recovery text + the fresh frame registered/zoomable, capture-fail →
the `frame_stale` fallback, `set_value` keeps the hard fail, fresh
frames never refresh; the spam guard: 2 identical OK then the 3rd
refused with NOTHING registered, saturation, the three resets, the
never-counted engine captures; the observations: the 600 ms settle
pin, the full shape, `titleChanged`, `captureFailed`, the
returnState full/compact/none split, the wait() observation, the
audit-journal ordering, middle/right element routing,
hitElementName hit/miss, the changed/unchanged verification
upgrades) · `computer-windows-backend` 68 → **80** (the single wheel
event + ticks×120 + clamps, HWHEEL 0x1000 + SetCursorPos-first, the
psStdinCapsule composition + LONG_TYPE_THRESHOLD 300 pin + honest
empty/corrupt payload refusals, the dual-object poke
(OBJID_CLIENT + UiaRootObjectId) + the 400/800/1400/2000 sparse-poll,
the --force-renderer-accessibility launch flag) ·
`computer-use-plugin` 22 → **28** (the returnState schema pins for
all 11 mutating tools + wait + left_mouse_down, the middle/right
element-target descriptions, four SSE tests: the observation frame
carries the ACTION tool name + route-side registration, the
refresh→observation chronological pair, captureFailed emits nothing,
an evicted raster emits nothing) · `computer-session` 13 → **15**
(the provenance values model/auto_refresh/observation, aHash from a
real PNG — twin frames hash equal) · `computer-errors-audit` 20 →
**24** (frame_changed + screen_unchanged in the doc-11 catalog shape
cases + payload/recovery pins) · `prompt-registry` 17 → **21** (the
R69 discipline pins — observation-read loop, element-first on
unchanged, wait-after-navigation + screen_unchanged semantics; the
retired zoom-crop teaching asserted GONE) · `skills-mcp` 13 → **14**
(the skill's receipt-observation loop pin + the old zoom-crop pin
flipped to `.not.toContain`). The golden fixture was regenerated by
the sanctioned procedure (+4/−2 lines, byte-identity re-pinned).
**The Windows behavior (the stdin paste channel, the HWHEEL math,
the dual poke, the NOACTIVATE FFI) remains construction-pinned only**
(headless Linux sandbox — PowerShell never runs here); `cargo check`
was cross-checked on x86_64-pc-windows-msvc (CI's own target) with
zero mini.rs warnings; the owner's live Windows run is the L4 proof.

**R68 (the computer-use overhaul):** +42 root over R67's 1961 — the
round's features again carried their own suites (all counts as MEASURED
this round by the docs pass, not remembered; one worklog phrasing
resolved in the runner's favor — see the round file's drift note):
agent-core NEW/EXTENDED `computer-windows-backend` 48 → **68** (the
SendInput machinery: the INPUT struct layout, exactly ONE Add-Type per
capsule, every input-path script pinned clean of
SendKeys/LoadWithPartialName, the composeVkChord matrix incl. the
win-key chord + the honest unknown-name refusals, the ARGV ceiling
guard's four pins — a 7,000-char payload refuses with NO capsule spawned
per path, a 2,000-char type still sends) · `computer-dispatch` 65 →
**72** (the 7-test withForegroundRetry describe: the gate heals BEFORE
the first attempt, a script-level FRONTMOST_MISMATCH heals + retries
ONCE, a failed activation keeps the honest refusal, non-mismatch errors
never retry, the per-tool wrappers) · `computer-vision` 10 → **15** (the
retry describe's 6 tests, one REPLACING the old HTTP-failure pin:
all-attempts-429 exhausts, 429-once-then-success RECOVERS — the owner's
live failure shape, 503 overload, 4xx terminal fast-fail, the
anthropic format rides the same attempt loop, the [1500,3000] delays
pin + the test hook restore) · `computer-use-plugin` 21 → **22** (the
middle_click new-tab description pin) · `computer-session` **13**
(unchanged count — the frame-age pin updated in place:
`expect(MAX_FRAME_AGE_MS).toBe(30_000)`) · `prompt-registry` 14 → **17**
(the ROUND-68 prompt pins: BROWSER CONTENT IS SEARCHABLE, CHAIN
DISCIPLINE, the auto-activation rewrite) · `skills-mcp` 12 → **13**
(the skill's browser-tree + chain-discipline + auto-activation lines).
Frontend NEW/EXTENDED `ScreenshotRow` **5** (NEW: the lazy fetch +
object-URL img + caption, the expired placeholder on rejection, the
dialog on click, revoke-on-unmount, one row per capture) ·
`stream-store` 45 → **46** (the R67/D describe rewritten to R68/A: the
screenshot frame appends a working entry in order after the in-flight
tool row, the `screenshots` field GONE, no cap — 10 captures → 10
entries, the no-liveTurn guard, the fresh-turn reset) · `turn-copy` 9 →
**10** (the `[screenshot captured by <tool>]` marker + ordering + the
tool-count honesty) · `WorkingSection` 36 → **39** (a screenshot entry
renders INLINE BETWEEN two tool rows — compareDocumentPosition pins the
order, the section counts TOOLS only, BareWorkingEntries renders no
row) · `AgentChatPanel` 22 → **23** (a live turn carrying [in-flight
screenshot tool, capture entry] renders the inline row inside the live
section and NO `screenshot-strip` testid) · `ScreenshotStrip` **6**
(DELETED with the strip) · `api.test` **93** (unchanged and green — it
does not pin the union shape). Scoped scopes re-measured: the chat scope
**282** (project-chat 211 in 10 files + composer 71 — the dir filter
does not descend) · `src/lib/` **262 in 16 files**. The golden fixture
was regenerated by the sanctioned procedure (byte-identity re-pinned).
**The Windows SendInput/WM_GETOBJECT/minimize-restore/FFI claims remain
construction-pinned only** (headless Linux sandbox — PowerShell and
cargo never run here; the mini.rs constant is pinned by a cross-platform
cargo test the sandbox cannot run — CI's windows-latest run is the gate);
the owner's live Windows run is the L4 proof, and the 7-step Edge flow
is the acceptance test.

**R67 (the bridge round):** +154 root over R66's 1807 — the round's
features again carried their own suites (all counts as MEASURED this
round by the docs pass, not remembered; two sub-agent worklog counts
drifted and the runner wins — see the round file): agent-core NEW/EXTENDED
`composer-attachments` 33 → **58** (the upload route's both modes with
bytes-on-disk verified, the identical-reuse/-2…-3 dedupe, the 8 MB cap,
invalid base64, unsafe names, both/neither sources, absolutePath honest
400s, the 401 wall; renderAttachments' image analyze_image contract incl.
the exact string) · `raster-cache` **7** (NEW: round-trip, honest-null, LRU
eviction at 13, recency on re-registration, the exact TTL boundary via
fake timers, the reset) · `computer-windows-backend` 30 → **48** (the
-EncodedCommand argv + a decodeCapsuleScript helper asserting the decoded
script; the U32 guard pins; the REACHABLE Get-Process fallback + its
source field; the full composeSendKeysChord table/chords/escapes/
meta-refusal/unknown-name matrix; rawKey's composed chord + refusal without
a capsule; the three-probe probePermissions incl. addTypeOk false) ·
`computer-dispatch` 52 → **65** (retry-once recovery, probeNote,
benign-empty no-retry, the pid zero-calls pin, the WebView2-helper refusal
across get_app_state/type/key, the splitKeyChord matrix, the focused
readback incl. null/empty/throwing) · `computer-use-plugin` 15 → **21**
(the screenshot frame + registry, zoom/get_app_state notes, no frame
without a raster, refusal → no frame, evicted raster → no frame + the
tool still ok) · `server.test` → **25** (the raster route: 200 image/png
+ no-store + exact bytes, the honest 404 envelope, 400 malformed id, 401
without the token) · `browser-tool` 43 → **49** (the binding-scoped
default-target pins, the bind route validation + null-clear, the
mint/isolation test, the navigate/open frame emissions, the R67-E
description contracts) · `vision-plugin` 13 → **14** (the attachment-path
description contract) · `prompt-registry` 11 → **14** (the ROUND-67
prompt pins: browser discipline, Tab-walk, image attachments, + the
NOT-contain pins proving the retired R66 claims are gone) · `skills-mcp`
11 → **12** (the skill's Tab-walk + embedded-browser-is-not-a-desktop-app
paragraphs). Frontend NEW/EXTENDED `turn-copy` **9** (NEW: the full-turn
export format, ordering, FAILED shapes, unknown-model fallback, approvals,
skipping, in-flight pending, the 100 KB tail-kept truncation) ·
`computer-monitor-store` **9** (NEW: the turn-hold latch — no bump, no
decay; multi-hold release; decay-fires-while-held; noteStopSignal
scoped/unscoped; clear hygiene) · `ScreenshotStrip` **6** (NEW: hidden
when empty, the lazy fetch + img, the expired tile, the click-to-enlarge
dialog, revoke-on-unmount, one tile per capture) · `DebugReportCard` 8 →
**17** (collapsed-by-default-when-done, expanded-while-streaming, the
auto-collapse flip, manual-tap-wins, the Copy report payload + Copied
flash, no-copy-while-streaming/error/empty) · `AgentChatPanel` 20 → **22**
(the full-copy hidden when debug is off; visible + payload with the model
header/TOOL block/FINAL ANSWER when on; the bind POST before the stream) ·
`Composer` 65 → **71** (dropped binary → upload + path on the wire; failed
upload → old behavior + toast, send never blocked; pasted image; picker
binary → ingest) · `ComputerMiniWindow` 10 → **13** (hold-alone shows the
pill, NO-FLAP across a simulated decay fire, noteStopSignal hides) ·
`stream-store` → **45** (the navigate frame intercept, the open frame
active+background, the turn-hold latch+release, the stop signal, the
screenshot append/cap-8/no-liveTurn guard/fresh-turn reset) ·
`BrowserPanel` 36 → **38** (the agentNavSeq navigate-or-CREATE effect +
the poll create-on-adopt backstop + the mint projectId pin) ·
`right-sidebar-store` 8 → **11** (openBrowserForChatSession
active/background/idempotent) · `native-browser` 12 → **21** (the
double-encoding matrix + the eval/scroll probes on both transports) ·
`api.test` 90 → **93** (the upload/ingest POST bodies + ApiError mapping).
The golden fixture was regenerated by the sanctioned procedure (byte-
identity re-pinned). **The Windows capsule/SendKeys/bridge-decode claims
remain construction-pinned only** (headless Linux sandbox — PowerShell
never runs here); the owner's live Windows run is the L4 proof. One
observed mid-round flake (raster-cache's two TTL tests under load, per
the R67-E worklog) did NOT reproduce in this round's runs (full ×1,
scoped ×2, agent-core ×1) — fake-timer tests are load-sensitive, worth a
deterministic re-pin if it recurs.

**R66 (the live-fire patch):** +121 root over R65's 1686 — the round's
features again carried their own suites (all counts as MEASURED this round,
not remembered): agent-core NEW/EXTENDED `browser-checkpoint` **16**
(detector: cloudflare/captcha/age word-boundary + priority + evidence
trimming; the registry: open→resolve/stop/timeout settles, both frames,
resolve-after-timeout, the 60 s hard-cap rejection, the reset hook, the
emit-throws path; the REST resolve route over a real buildServer — 401
wall, 400 validation, the unknown-id `{ok:false,resolution:"timeout"}`
contract, the live-id resolve) · `browser-tool` 17 → **43** (the six new
actions: click/type/press_key happy paths assert the ONE eval frame + the
JSON.stringify-escaped payloads + the native value setter + input/change
events + requestSubmit + the key trio; no-target/page-miss honest errors;
read_dom outline + source html/css/scripts + in-script caps;
wait_for_verification's full contract incl. the exact
browser-checkpoint frame + fake-clock timeout; the navigate/read ⚠ notes;
the set_viewport `browser-viewport` frame; screenshot now pins that
`relay.session.record` is NOT called — A1) · `vision-plugin` **13**
(fail-closed gates, always-registered with CU+vision OFF, every honest
refusal, the end-to-end separate-mode path + URL download) ·
`migration-0025` **5** (no-seed, seed-from-legacy, OR-IGNORE idempotency,
the lazy read + switch-over, validation) · `migration-0026` **1** (the
allowlist append: web_fetch companions only, curation respected) ·
`debug-analyst` **10** (the transcript renderer's five line kinds, the
60 k head+tail cap, the degenerate slice, the skip rules, the streamed
path — NO tools, ONE user message, deltas accumulate — the sync fallback,
the scrubbed provider failure) · `r58-stop-and-replay` 6 → **10** (the
stream-route SSE frame ORDER debug-start → 2×delta → debug-done → done,
the persisted `debug.report` payload, the analyst's provider dying →
debug-error with the turn's done still terminal, the 502-turn gate) ·
`computer-dispatch` 44 → **52** (find_elements: happy path with the
registered stateId + bounds/total, kind AND-rule, limit clamp, empty-match
refusal, find→click end-to-end, observe-posture runs it, kill-switch
refuses, resolution parity) · `computer-windows-backend` 24 → **30** (the
$maxEl 800→2400 pin + construction pins: the exact $probe list,
non-interactive kinds unprobed, EXACTLY 4 GetCurrentPattern calls inside
the interactive branch, cached-handle reuse) · `computer-use-plugin` 14 →
**15** (the 31-tool list × both postures + find_elements registration) ·
`skills-mcp` **11** (the big-apps/find_elements skill body pin). Frontend
NEW/EXTENDED `ImageAnalysisTab` **11** (mode radios, provider/model save,
the masked key row with the Tauri-first durable store, readiness) ·
`ComputerUseTab` 12 → **8** (vision tests removed; the pointer-card test
added) · `DebugReportCard` **8** (streaming/done/error states, the amber
error line) · `BrowserCheckpointCard` **8** (the waiting card: kind
title, live countdown, BOTH controls, the resolve POSTs, the resolved
states) · `ComputerMiniWindow` 7 → **10** (the 6 s decay: arms on real
control events, hides on silence, session_stop rests, browser frames
never trip it) · `MiniApp` **10** (the single-row layout + honest web
mode) · `Sidebar` **15** (the minimized SETTINGS rail — section icons +
`?tab=` navigation; the normal rail unchanged) · `BrowserPanel` **36**
(the agentViewportSeq natural-mode exit + the poll adoption) · `api.test`
**90** (the debug.report folding cases). The prompt-removal cascade
(prompt-registry, r65-honesty-patch, the golden fixture) was re-pinned to
the R66 reality. **The Windows walk + the native-bridge browser actions
remain construction/test-pinned only** (headless Linux sandbox — web mode
refuses the bridge actions honestly); the owner's live Windows run is the
L4 proof.

**R62 (the owner-feedback round):** +50 root — the sidebar rail pair
(Sidebar.test), the aspect-fit geometry 6 + the fit/zoom/readout 4
(native-browser + BrowserPanel), the footnote-removal 2, the overlay
guard 5 (popover-webview-guard.test — including the boot-crash selector
regression pin), the bridge dispatch 5 (agent-browser-bridge.test), the
panel handler 5 (BrowserPanel native suite), the appearance 7
(SettingsPage.test), the models/providers + picker 13 (2-a/2-b files).
agent-core +14: the browser-tool D8 block 12 (read/eval/screenshot/tabs
+ the result-route + timeout pair), computeCost per-side 1
(models-catalog), the sticky-mock reset. The L4/L5 batteries ran LIVE
this round: a real model turn drove browser_control get_state/read/eval
against the dev stack (the honest web-mode eval refusal verified), and
the readiness probe honestly reported the headless sandbox.

**R64 (the capability round):** +122 root — ChatMarkdown 23 (the block
scanner + every block/inline kind + path pills + mid-stream partials),
the mini window suite + the controller + the sidebar-removal absence
assertions (~35), the delegated-row claim matching + subagent paths, the
context-donut portal/live tests, the config-only picker reworks,
approval-deps 5 + safe-list 8 (agent-core). agent-core +84: the windows
backend 24+11+5+1 (scripts pinned by construction — EnumWindows/OutJson
shapes/diagnostics), the resolver tiers + runningApps payload, the keys
aggregate + slot threading + migration list, the estimator calibration
table. The L5 battery ran LIVE: the app boots with zero console/page
errors through onboarding → dashboard → usage → a fresh session chat,
and mini.html renders its honest web-mode notice.

**R54–R56 (launcher rounds, historical):** the JS suite sat at 1071/76 —
R56's logic tests run in-sandbox against the real `acute_launcher.py`
(not vitest — the launcher ships outside the pnpm workspace): mode
resolution + `ask_launch_mode` persistence + recourse branches +
`main()` dispatch + the self-update re-exec verified as a REAL process
replacement (exec'd stub printed its marker, exit code 42 propagated);
`python3 -m py_compile` clean; ACUTE.bat CRLF-verified. The R56 live
battery (L4): /health 200 · real-key streamed turn answered exactly
`R56-LAUNCH-CHOICE-VERIFIED`.

**R57 (the engine-bundling round):** the JS suite is unchanged at
1071/1071 in 76 files (no product code changed — the fix is in the
PACKAGING: the staged node_modules is now a hoisted npm-style tree of
real directories instead of pnpm's 189-link farm). New verification
surface, all green in-sandbox: (a) staging re-run with
`--config.node-linker=hoisted` verified with BOTH pnpm 11.24 (local)
and the exact CI pnpm 11.22.0 — zero symlinks, `.pnpm` metadata-only,
staged tree 301.5 MB → 124.6 MB; (b) the ZERO-LINKS gate inside
stage-sidecar.mjs (walks the whole staged tree, fails on any
symlink/junction — junctions report as symlinks via lstatSync; it
already caught the yaml-only-setting regression during development);
(c) staged-boot battery from the staged tree alone: `ACUTE_READY
{"port":…}` handshake, `/health` → 200 `{"status":"ok"}`,
`/api/v1/agents` → 200 (auth + SQLite + 20 migrations against a fresh
DB); (d) the release workflow's NEW Windows pre-pack boot gate runs the
real staged node.exe + the same env the Rust shell passes on
windows-latest and fails the release before packing if `ACUTE_READY`
does not arrive (90 s budget) — the gate the R51 round believed it had.
docs:check 147/0 (the sandbox's 3 unreachable-URL WARNs are
raw.githubusercontent 429 rate-limits from THIS sandbox's network, not
dead links; CI's clean network is the authority).

**R57 follow-up (the CI flake, fixed same-round):** the docs-only worklog
commit's CI run (33411797885) exposed a LATENT flake — all 1035 tests
passed, but `ModelsProvidersTab`'s "Slot added." reset
(`setTimeout(() => setMsg(null), 1500)`) fired AFTER happy-dom teardown →
React-DOM's dispatchSetState hit `window is not defined` → vitest failed
the whole suite on the uncaught exception. The bare-timer idiom existed
at 11 call sites (ModelsProvidersTab 3, SubAgentsTab 4, AgentChatPanel 3,
ConnectionGate 1). NEW `src/hooks/use-timeout-clear.ts`
(`useTimeoutClear`) schedules state resets that cancel on unmount and
replace-on-reschedule; all 11 sites now ride it (+3 tests:
fires-after-delay, unmount-cancels — the exact CI failure mode —
reschedule-replaces). **1074/1074 in 77 files.** Production was never
affected (an unmounted setState is a silent no-op in React 18; the
crash only exists in torn-down test environments) — the shipped 0.57.0
installer stands; the fix is CI-reliability.

**R58 (the desktop-polish round):** the JS suites grew to
**1169/1169 in 80 files** (root) + **631/631 in 38 files** (agent-core) —
the round's features carried their own tests (TitleBar 8, stop/continue/
live-preview 40+, settings restructure + reveal 30+, streaming-args 12,
CLI-harness live battery). NEW LAYER: `scripts/battery-r58.mjs` — the
R51 battery pattern (the script supervises its own dedicated sidecar on
:5199 because the sandbox reaps background processes between commands)
runs FIVE live checks against the real engine + a real OpenRouter model:
the owner's exact 3-file task with tool-input frame ORDER assertions,
the stop path (stopped frame + `queued` status + persisted partial),
continue-after-stop, and the key-reveal route. Run it with
`node scripts/battery-r58.mjs` from the repo root (needs
`/home/z/.secrets/openrouter-main.key`). Two battery gotchas it now
documents: projectless sessions have NO tools (create a project first),
and Fastify 400s a JSON content-type with an empty body. For
terminal-driven session testing generally, see
`docs/runbooks/CLI-HARNESS.md` (`scripts/acute.mjs chat:stream`).
`r52-supervision` NEW 14 (exec helpers: background-launch grammar + log-
redirect parsing; the hang fix: pipe-holding grandchild resolves FAST with
a job id — the owner's exact trap, cross-platform via node-spawns-node;
the job flips exited when the grandchild dies; the hard watchdog kills a
silent never-exiting command as [timeout]; live onOutput frames; normal
commands keep the old contract; the Unix `&` detached round-trip incl.
process-group kill — POSIX-only skipIf; a failed launch reports failure,
no phantom job; the job_status/job_stop tools through the REAL toolset;
the /jobs REST routes + 404s; the child turn-registry owner-stop with the
honest parent report; sampleChildWatch stall math) · NEW `r52-plugin-
registry` 8 (plugin grammar/catalog-computed-from-declarations incl. the
TOOL_NAMES seed, allowlist semantics through the registry, external .mjs
loading + EXECUTION, built-in-wins collisions, fail-soft invalid shapes,
the REAL scope matrix via HOME/USERPROFILE override, the settings scope
reader) · `usage` 10→16 (getDetailedUsage aggregation: totals, tools
leaderboard with failures, models, children nested under parents with
isSubagent/parentId/role, subagentCount, dominant model, days zero-fill,
orphans→synthetic group, the HTTP route shape + 400 walls) · NEW
`migration-0021` (settings rows for the supervision knobs) · `stream-
store` 9→14 (watch samples land/carry/restart-clear, failed detail
persists/attempt-clears, MAIN tool-output appends + result strips, orphan
chunks ignored, INNER child tool-output appends + strips) ·
`SubAgentPanel` →+5 (Stop renders + calls stopSessionTurn + stopping
chip + disabled, settled shows none, the WatchLine, the stalled amber
line, the failed detail strip) · `TerminalPanel` →+5 (running job row +
age + Stop → stopBackgroundJob, exited row shows exit code + expandable
outputTail, logTail fallback, zero jobs hides the section, demo mode
never polls) · `WorkingSection` →+4 (LiveOutputTail renders + live
indicator, settled strips it, no output no tail, last-10-lines) ·
`SubAgentsTab` →+3 (the supervision card: ms↔s/min round-trip, dirty-only
PUT, range validation disables Save) · `Composer` 46→48 (the model-flyout
HOVER BRIDGE: row-leave keeps the flyout open through the 220ms grace;
flyout-enter cancels + flyout-leave re-schedules) · NEW `UsageScreen` 4
(hero + stats + leaderboard + model card, drill-down with the nested
"sub-agent · role" badge + deep-link, the range selector refetches, the
empty state).

**R61 (the computer-use + extensibility round): 1491/1491 in 102 files
(was 1348/91; agent-core alone 786/786 in 48 files).** Eleven new suites,
all green: backend `computer-dispatch` **33** (the universal gates —
kill-switch/observe-posture/unknown-tool refusals; the a11y-first matrix
— element press/type/set_value/right_click, staleness, fail-closed
non-editable + double_click/scroll; coordinate actions — frame binding,
the 10s freshness, raster bounds, the Win/Linux frontmost rule; keyboard
targetless refusals; open_application launch/activation postconditions;
stop + held-button release; receipts + the audit journal + monitor
stats; app_ref resolution) against an INJECTED FAKE backend ·
`computer-session` **12** (lifecycle, the enforced kill switch, snapshot
supersession + keep-8 eviction, frame registry + imageToGlobal, the
200-entry ring, the process singleton) · `computer-errors-audit` **15**
(every refusal code's what/why/nothing-sent/recovery shape + the journal
redaction: credential scrub, text/clipboard/value length markers, caps) ·
`computer-use-plugin` **13** (settings gates: default-OFF, no-deps,
declaration-context, exactly the 30 doc-02 names, observe = the 11
read-only subset; output shapes + monitor emission; vision wiring incl.
the OFF/separate cases; the ask-mode consent gate incl. auto-skip +
element-press-never-prompts; the audit trail lands under
`<root>/.acute/computer-use`) — this suite runs the REAL Linux backend on
the headless sandbox (GUI probes fail closed; the SHAPE contracts are
pinned, not live GUI behavior) · `computer-vision` **10** (the
`<id>-vision` slot resolution + primary fallback, chat-completions +
anthropic wire formats, no-key/no-provider/request-failure honest codes,
the main-mode supports_vision gate + catalog prefill) · `skills-mcp`
**10** (skill seed/CRUD/builtin-delete-refused, MCP storage round-trips +
corrupt-JSON fail-soft, the manager: sanitized env, initialize/tools/call
against a LIVE child, missing-executable fail-soft, probe, banner-noise
survival) · frontend `SkillsTab` **11**, `McpTab` **12**,
`ComputerUseTab` **12** (the settings tabs: master switch optimistic
update + posture + readiness result cards + vision modes + the masked
vision-key row + the per-row eye toggle; create/toggle/delete/edit flows,
inline ApiError surfaces), `ComputerPanel` **8** + `ComputerMiniWindow`
**7** (the monitor: status chips, stat cells, the event feed with refusal
codes, STOP semantics, the pop-out, the drag). **LIVE verification of the
platform backends is NOT done** (headless sandbox; Windows/macOS never
run on hardware) — the owner's LIVE-VERIFICATION CHECKLIST in
[`COMPUTER-USE.md`](COMPUTER-USE.md) is the mandatory follow-up.

**R52 live battery (L4+L5, all against the real model):** the owner's
Unix-shaped trap reproduced broken THEN verified fixed (`node … >
server.log 2>&1 &` resolved instantly with a job id pre-fix: silent
"(no output)" + "no background jobs tracked"); the agent called
job_status unprompted right after the launch; the job group-stop via
POST /jobs/:id/stop; a real delegation streaming 15s watch heartbeats
(lastActivity evolving, todos, elapsed); a mid-flight child stop via POST
/sessions/:id/stop → detail "stopped by the owner" → the parent's honest
delegate_task report; agent-browser: the Usage screen on real data (283K
tokens, leaderboard, drill-down with nested sub-agent rows, deep-links),
the Terminal panel's Background-jobs section (live row + UI Stop click →
exited), and the SubAgentPanel (Stop button → "FAILED / stopped by the
owner").

## Hard rules

1. **No live AI calls in tests** (L1/L3 mock the SDK; the only live model is
   exercised in L4/L5 batteries).
2. **Fresh-DB journey gate** (lessons #31/#32): L4 runs on a throwaway
   `ACUTE_DB_PATH` and must cover the *first-user journey* — open → send →
   reply works with zero setup (default agent seeded), not just API CRUD.
3. **Disk is ground truth** for file-mutating turns: assert the file exists
   with the expected content, not just a 200 response (#35).
4. **Outcome-based completion polls, never sleeps**: poll the on-disk file or
   a specific new DOM string (#35). Verify you drove the RIGHT element
   (snapshot refs before acting).
5. **Single-invocation batteries** (#4): boot sidecar (+vite for L5), run
   everything, assert, teardown — background processes die between shell
   invocations; check for orphans after.
6. **CLI template-agent filter** (#27): `GET /agents?includeTemplates=false`
   in batteries; a template has no provider/model and 409s confusingly.
7. Rebuild `agent-core/dist` before L3/e2e after backend changes (e2e runs
   against the built dist).
8. Model on the owner's keys (R43+): free-first — default
   `z-ai/glm-5.2:free` with the OpenRouter fallback chain
   (`models:[model, openrouter/free]`); the dead `stealth/ox-alpha` is
   retired (R43). Free-tier 429 storms are REAL — expect the fallback to
   engage mid-battery and say so in the round report.

## L4 live-battery recipe

```bash
export PATH=/home/z/.local/bin:$PATH
mkdir -p .dev && rm -f .dev/<name>.db
setsid env ACUTE_TOKEN=acute-dev-local ACUTE_PORT=5178 \
  ACUTE_DB_PATH="$PWD/.dev/<name>.db" \
  ACUTE_PROVIDER_OPENROUTER="$(cat /home/z/.secrets/openrouter.key)" \
  node agent-core/dist/main.js > .dev/<name>.log 2>&1 < /dev/null &
# wait for /health; export ACUTE_BASE_URL/ACUTE_TOKEN for scripts/acute.mjs
# ...create project/agent(non-template)/session → POST message →
# ...assert files on disk + event log ordering + usage rows →
pkill -f 'agent-core/dist/main.js'   # teardown, then check for orphans
```

## L5 browser-verification recipe

- Boot sidecar + `pnpm dev` with `.env.development`
  (`VITE_ACUTE_BASE_URL` + `VITE_ACUTE_TOKEN`; **delete the file before any
  verify/commit** — lesson #12). Bypass the first-run gate with
  `localStorage.acute.setupDone=1` (lesson #11).
- Drive the real UI (snapshot refs → fill/click), screenshots at
  1920×1080 **and** a tall viewport into `docs/ui-iterations/assets/round-NN/`.
- Machine-verify each screenshot (VLM) against a checklist; numeric checks
  for centering/overflow; `agent-browser errors` + console must be clean
  (`[role=alert]` empty).
- Streaming turns: completion signal = the on-disk file or the stats row for
  THIS turn (a "tok/s" text poll can match the previous turn's stats — #35).

## CI

`ci.yml` on `main` pushes + PRs: windows-latest, `pnpm verify` +
`cargo check`. ~4–6 min; a client timeout while polling is not a failure —
re-query the run (#8). Heavy Rust builds belong on Actions, never the
owner's machine (ADR-0012).
