<!-- last-reviewed: 2026-09-22 round-119 -->
# Round 119 — the v0.112.0 device report: the session center rethink, the queue honesty, and the provider capability probe

Open: 2026-09-22. Baseline: v0.112.0 (2dc83d5). Target release: v0.113.0.

The owner's verdict on v0.112.0 was broadly positive — the PC QR flow ("handled better than before"), the homepage ("clean, exactly like how I hoped"), mark-all-read, the bottom navigation ("much, much better"), the projects section, the folder flow ("working properly… a good implementation"), mode/thinking/context selectors, the stop confirmations, and the conditional queue button all passed. The dashboard screen stays deferred ("let's leave it here for the current time being"). This round takes the four areas that did NOT pass plus the deferred §N center work.

## §1 The owner's report — itemized

### A. The session composer (his clearest ask)
1. The composer is "way too much taller in its height" — the dock reads too heavy at rest.
2. "The text would be typed on the left side of the add file option, but apparently it was being typed above it" — the R118 two-tier geometry (single-line: paperclip beside; tall: full-width text with the 40dp reserved band UNDER it) is rejected. The input sits LEFT of the add-file control in EVERY state.

### B. The kebab sub-levels
3. "I would like some animation while switching between the menus" — the in-place level swaps are instant re-renders today.
4. **The model sub-level is wrong twice**:
   - the MODE / MODEL / THINKING / CONTEXT rows render at the BOTTOM of the model list (the level-state ternary has no `"model"` branch, so the main rows trail the list — his exact report);
   - the model list itself is a flat fully-expanded provider-sectioned wall — he wants PROVIDER NAMES by default, one provider expanding at a time into its models.

### C. The queued message — three defects across two platforms
5. **PC rendering**: a queued message "does not appear as a message, but rather as a notification or error message" — the amber `QueuedMessageChip` banner.
6. **PC duplicate glitch**: while a queued message waits, the transcript shows "the exact same thought process… the exact same reply" as the previous exchange — a folded/live double-render that clears once the queued message is processed. (The 300ms trailing-debounce invalidation refetches the log mid-turn; the fold's trailing open-turn item and the liveSection render the same interim content twice. No suppression exists.)
7. **Mobile position**: the queued message renders "just below the first message" instead of AFTER the currently-processing section, and only jumps to the right position when the model starts responding. (The `user.queued` frame pushes the q-row onto the live tail — ABOVE the synthetic thinking placeholder, which the displayItems memo appends last; and `rebaseRemoteTurn`'s `[...freshBase, ...tail]` puts the folded queued row above the live tail.)

### D. The session CENTER — the §N rethink (mobile)
8. "The general improvements which I mentioned with you in high detail, they are needed to be done on the center section of the mobile device" — the §N verdict (thinking / tool call / failed tool call "each get a proper card of itself, which makes the whole interface bad… everything looks ugly"). Mobile this round.

### E. Providers
9. The Add-Provider sheet: "the overall UI of it was much better… exactly like how I hoped… besides that, the animations were not that good."
10. The provider detail's Test connection button line-breaks ("Test" / "connection") — at 360dp the two `flex:1` peers leave ~144dp and the 15px bold label measures ~125–135dp plus 40dp of padding.

### F. The TokenHarbor failure — "the model was failing while performing an action"
11. The owner added TokenHarbor (`https://tokenharbor.ai/v1`, model `qwen3.8-flash:free`) and the model failed DURING ACTIONS (tool calls) on a real agent task (the dribbble-dashboard build). Plain chat worked. Findings:
    - **The sandbox cannot live-test it**: TokenHarbor answers `region_blocked` (sanctions/export-control policy) to this machine's egress IP on BOTH `/models` and `/chat/completions`. The owner's device CAN reach it (chat worked) — so the failure is in the TOOL-CALLING path, and every fix must be code-side.
    - **The test lies by construction**: `testProviderConnection`'s model branch and `testModelResponse` send NO tools — so "Test model ✓" proves nothing about the agent's actual call shape (which always carries the toolset). This is the "test passes, actions fail" gap.
    - **Mobile drops the provider's real error**: `turn.error` carries `providerError` (the raw body, ≤4000 chars) on the wire and in the log, but BOTH mobile reducers (the live frame and the folded event) never read it — the PC shows it (`TurnErrorCard`'s `providerError ?? message`), mobile shows only the generic `provider '<id>' call failed for session <sid> (class: …)` line. A region/auth/tools rejection reads as an unexplained generic failure on the phone.

### G. Process mandates
- Update the design-language docs along the way; verify everything; release v0.113.0 (Android + PC); no rushing.
- The DASHBOARD repo (testplay-byte/DASHBOARD) is design-mock territory from earlier rounds — access verified with the rotated PAT, NOT in this round's scope (last priority per the owner).

## §2 The wave plan

Five tracks. **Wave 1** = three parallel agents in isolated git worktrees (B session chrome, C-PC the PC queue, P provider robustness+polish); **Wave 2** = one agent on the merged tree (A the mobile center + the mobile queued position — both own the transcript display layer); **Wave 3** = docs + review; then the release.

### Track B — the session chrome (mobile)
- **The composer becomes single-tier by construction**: `[input (flex:1)][attach circle 40][send|queue|stop 50]` in ONE row, always. The paperclip stops being an absolutely-positioned overlay inside the pill and becomes its own 40dp quiet circle BESIDE the input — the text is left of the add-file control in every state, tall included. The two-tier `ATTACH_BAND` reserved space and the `paddingRight` swap are DELETED (`MAX_INPUT_HEIGHT` falls 176 → 6×21+2×10 = 146 with the band gone). The pill/bar radius swap stays (single-line pill → tall bar). The dock's resting height shrinks with it (root paddingTop 8, paddingBottom 4 → 4/2; the row's `alignItems` becomes "flex-end" so the circles ride the input's last line). Reduced-motion + a11y unchanged; `numberOfLines`/`maxLength` untouched.
- **The model sub-level gets its explicit branch**: `menuItems`'s ternary gains `"model" → []` (the root rows NEVER trail the list). `ModelLevelRows` becomes an ACCORDION: one row per configured provider (name + model count + ChevronRight), tapping a provider expands THAT ONE section (one-at-a-time; the previously open section closes), its model rows render beneath with the selected Check; tapping a model applies-and-returns to the main level (the R118 grammar). The section state resets when the menu closes. The busy/empty/offline captions stay.
- **The level transitions animate**: the panel body (title row + content) becomes a keyed Reanimated view — entering a sub-level slides the new level in from the right (12dp, 180ms, the house `DISCLOSURE` timing family) + crossfade; going back reverses. The panel's own entrance/exit (spring 0.96→1 + the 120ms exit fade) is untouched. `HeaderDropdown`'s `ENTRANCE_SCALE`/`EXIT_FADE_MS` constants stay frozen.

### Track C-PC — the PC queue honesty (src/)
- **A queued message renders AS A MESSAGE**: `QueuedMessageChip`'s amber banner is replaced — the queued row renders through the SAME `UserMessage` bubble (accent-soft, right-aligned, the input-row idiom) with a small `Queued` clock glyph row (hover-revealed, like the delivery tick cluster) and the Send-now / Remove affordances move into the hover cluster (Send-now keeps its immediate one-tap path). The live chips row below the working section adopts the same component. The folded `message.queued` case does too (timeline label "Queued" on the rail dot stays for the log's honesty).
- **The duplicate dies at the fold**: `toProjectChatItems`'s trailing open-turn flush gains a suppression contract — the panel drops the trailing `turn` item (and any `queued` items already mirrored by the live overlay) while a live turn is showing the same turn. Anchor: the folded turn's opening user-seq vs the liveTurn's userSeq (the store already carries it). When the overlay clears, the folded turn renders once — no double.

### Track P — the provider robustness + polish
- **`testModelResponse` gains the TOOLS probe** (the "does the model actually work for the AGENT" leg): after the pong completion, a second bounded call WITH a minimal tool definition (`echo` — one string arg) and an inviting prompt. New checks: `toolsAccepted` (the provider took the request with tools — a 400 here is EXACTLY the TokenHarbor action-failure shape) and `toolCalled` (the reply contains a well-formed tool call). The verdict line reports each leg honestly: "tools ✓ called echo" / "tools accepted — the model answered in text instead" / "tools rejected: {raw error}". Per-format bodies: chat-completions `tools:[{type:"function",…}]`, anthropic `tools:[{input_schema}]`, responses `tools:[{type:"function"}]`. 30s timeout, 64-token cap, scrubbed, key-pool slot contract unchanged. The mobile model-actions sheet + the PC ModelCard/config-dialog test bands surface the two new legs.
- **Mobile stops dropping the provider's real error**: the live `error` frame reads `details.providerError`, the folded `turn.error` reads `providerError`; `ErrorCard`'s body prefers the RAW provider text (the honest line) with the generic message as the secondary line, and "Copy details" carries both. The 3-line clamp + expand stay.
- **The Test connection button stops wrapping**: `ChromeButton` gains a `labelFit` mode (`numberOfLines={1}` + `adjustsFontSizeToFit` + `minimumFontScale 0.85`, horizontal padding xl→md when fit is on); the hero instance opts in. The peer layout (Test flex 1 + quiet Rename) stays.
- **The sheet animation tuning** (the owner's "animations were not that good"): open = spring `{180, 24}` (the house `DISCLOSURE` settle — replacing the stiffer 210/30), scrim 160→200ms ease-out; close = timing 200ms with an ease-in quad curve (an accelerating departure — was 180 linear; the shipped spelling, per the design-language doc); the content row gains a 120ms fade-in that starts 40ms after the panel starts moving. The R118 first-frame law, the keyboard ride, and every frozen constant (`SHEET_HEADER_ROW`, `SHEET_CHROME`, `SKIRT_PX`) are untouched. All sheets inherit — the Add-Provider sheet included.

### Track A — the center rethink (mobile, Wave 2 — owns transcript.tsx + sessions.ts + the displayItems memo)
The §N implementation, as the display-layer unification: **one visual TURN per exchange**.
- A new `TurnBlock` groups the consecutive non-user items of one turn (thinking + tools + assistant text) into ONE clay container. Inside it: a single collapsible **activity head row** ("Thought for 8s · 3 actions ▾" — or live: the breathing "Thinking… / Reading file…" line) that expands the recessed activity well (the thinking text, the tool lines as compact rows with status chips — failed tools mark their row's danger chip INLINE, the detail still expands); the assistant text renders as the block's body below the rail. The separate `ThinkingPlaceholder` card, the separate `ThinkingBlock` card, and the standalone `ToolCard` surfaces are RETIRED as list items — they become the TurnBlock's internal states (the card variants' content logic — write previews, terminal tails, diff chips — moves INTO the row renderer). The `ErrorCard`, approval mini, question, todo, subagent, and image tiles stay as their own items (interactive/terminal surfaces, not narration).
- The item MODEL stays (the fold + live reducer keep emitting items) — the grouping happens in the display memo, so the delivery rungs, the queue frames, and the persisted-fold tests keep their contracts; the transcript's rendering tests move to the new anatomy.
- **The mobile queued position (item 7) rides this track** (same files): the display memo partitions each turn block's items so QUEUED user rows always render AFTER the in-progress turn (the synthetic processing state is INSIDE the TurnBlock; the q-rows follow the block, never precede it), and `rebaseRemoteTurn` moves the folded `message.queued` rows to the live tail's end.

### Track D — deferred/skipped
- Folder-creation polish: the owner said "keep it as it is" — recorded, skipped.
- The dashboard screen: deferred per the owner. The DASHBOARD repo: out of scope (verified reachable with the rotated PAT).

## §3 The wave order + verification

1. Wave 1 (parallel, isolated worktrees): B (composer/model-menu/kebab), C-PC (PC queue), P (provider probe + error surfacing + no-wrap + sheet motion).
2. Wave 2 (merged tree): A (the TurnBlock center + the queued position).
3. Wave 3: the design-language doc amendments (transcript anatomy, the composer law, the model accordion, the queue rendering law, the tools-probe vocabulary) + the flaw-finding review.
4. The release: v0.113.0 — full gate ladder (mobile tsc + jest, agent-core tsc + vitest, root vitest + eslint, docs:check), the §g runbook, both workflows, publish, end-state verification.
5. The closing report: the TokenHarbor finding (region-block on the sandbox; the tools probe as the owner-side diagnostic), the §N anatomy explanation, the deferred items.

## §3 Verification

- **The full gate ladder on the merged tree** (Wave-1's three tracks were built in isolated git worktrees — symlinks are newly
  blocked in this sandbox, so the per-track gates ran at MERGE time; Wave-2's center track gated in the main tree):
  mobile tsc clean · jest **40 suites / 870 tests** (baseline 38/811) · agent-core tsc clean · vitest **146 files / 2742**
  (was 145/2734) · root tsc clean · root vitest **253 files / 4510 passed + 15 skipped** (was 252/4491) · eslint 0 ·
  docs:check 265/0. One gate-fix landed at merge (the queued-caption test read the wrapper, not the inner mono span — 298a887).
- **The focused review pass** (a dedicated reviewer agent, leaner after a first full-scope attempt died at the context deadline):
  **verdict SHIP — no blockers**. All four cross-track seams verified by byte-diff (P's ErrorCard providerError survived A's
  transcript rewrite; B's menu wiring survived A's display rewrite; C's startedBySeq + P's tools fields coexist in api.ts; the
  delivery-rung constants + the five interactive cards byte-identical to the v0.112.0 baseline). Its one WARN — the ErrorCard's
  accessibility label could read a 4000-char raw provider body through TalkBack — was closed in 9c7baf3 (`errorCardA11yLabel`:
  code + first line + ~120-char cap + the expand cue, pinned 3 ways), together with the chat-prefs header reconciliation and
  the round-doc wording drift. Its NOTEs: the content-matched twin-drop can transiently under-count identical queued rows
  (self-healing; the PC twin matches by seq), and a `toolActivity:hidden` live rail reads "Thinking…" while tools run — both
  recorded as known spellings.
- **The design-language docs** landed in the same wave (a0cb07d): chat.md (the TurnBlock anatomy + the queued-row law + the
  single-tier composer + the accordion + the level swaps + the providerError law), components.md (labelFit + the sheet motion
  supersession + the accordion grammar), motion.md (the {180,24} supersession + the named legs + the rail breath), donts.md
  (#37 reworded + #49-52), checklist.md (the six round-119 gates), round-117-elevation.md (the supersession notes).
- **Cannot be verified in this sandbox** (the owner's device checklist): the composer's single-tier feel + the shorter dock at
  rest; the TurnBlock's live rail/well breath + the collapsed summaries on a real conversation; the accordion's one-open law +
  the level-slide feel; the PC queued bubble's hover affordances; the TokenHarbor model test's TOOLS verdict from the owner's
  region (the sandbox is region-blocked — the probe is the owner-side diagnostic by construction); the sheet motion tuning by
  feel.

## §4 The release (R119-i)

Tag `v0.113.0` at the release-prep commit. The §g 2c lock-sync proof passed before tagging (`npm ci --dry-run` clean — zero
mobile dep changes this round; the package files are byte-identical to v0.112.0).

Tag `v0.113.0` at `1052bdf` (the release-prep commit). All four workflows green: the tag `Release` run `35790039909`
(launcher-kit + the Windows installer + the two AppImages + the two debs), the tag `Mobile APK` run `35790039870` (the APK
attach), the main `CI` run `35790037220`, and the main `Mobile APK` run `35790037209`.

Draft `394157407` carried all 7 assets, then was PUBLISHED (PATCH `draft:false`, `make_latest:"true"`, body = the CHANGELOG's
0.113.0 section, no `target_commitish` — the §g 6 procedure). End-state verified per §g 6b:

- `/releases/latest` answers `v0.113.0` authenticated; the PUBLIC check answers the same via the HTML redirect
  (`/releases/latest` → `/releases/tag/v0.113.0`).
- 7/7 assets on the published page: AppImages 134,334,984 / 136,604,152 B, debs 68,428,524 / 68,384,514 B, x64-setup.exe
  39,344,439 B, launcher-kit 146,733 B, and `ACUTE-CODE_0.113.0_android-arm64.apk` 56,795,649 B.
- **APK content check** (downloaded via the API with the octet-stream Accept, full zip central-directory pass): 1240 entries;
  `assets/index.android.bundle` present with the Hermes bytecode magic `c6 1f bc 03`; 3 dex files; `lib/` contains
  **arm64-v8a only**; exact size match.

No stale drafts remain. The round is shipped.
