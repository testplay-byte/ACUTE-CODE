<!-- last-reviewed: 2026-09-19 round-108 -->
# Round 94 — the field-report round (v0.91.0 → v0.92.0)

<!-- round: 94 -->
<!-- version: 0.92.0 -->

The owner's v0.91.0 field report, answered end to end: the update paths
(in-app + launcher + installer), the models-list UX, the chat scroll, the
queued-message position, the provider dead-ends, the computer-use Windows
failure chain, the browser-use reliability, and the prompt discipline.
Every item below traces to the owner's own words in the report.

## §1 The update paths (three fixes, one root each)

### §1.1 The in-app update ("body.url must be a GitHub release asset of this repository")

`findInstallerAsset` returned `browser_download_url` (host `github.com`) but
`POST /system/updates/download`'s allowlist accepted only
`api.github.com` / `objects.githubusercontent.com` / `release-assets.githubusercontent.com`
— **every real download was rejected with the owner's exact error**. The
asset now prefers the API `url` (with the permalink fallback) and the
allowlist accepts both forms of THIS repo's release assets. The PAT is now
OPTIONAL everywhere (the repo is public — anonymous check + download work;
the token only raises rate limits; the old no-token 409 dead end is gone).

### §1.2 The launcher (public-repo warning + "Not possible to fast-forward")

- `validate_github_access` no longer warns "GitHub reports this repository
  as PUBLIC" — public is the owner's chosen state (a positive note now).
- The update is divergence-aware: pure-behind keeps `git pull --ff-only`;
  **diverged (the public-migration history rewrite) realigns via
  `git reset --hard FETCH_HEAD`** after the fetch + clean-tree guard, with
  the why-note printed first. The owner's exact dead-end panel is gone.
- An update failure with an existing local build now **warns and continues
  booting** — only a fresh-clone failure still fails hard.

### §1.3 The installer ("Error opening file for writing" on node.exe)

The NSIS kill prompt ends the app's own exe, not the node sidecar child —
the orphan held `$INSTDIR\sidecar\*` open. Two belt-and-suspenders fixes:
- **The kernel-side leash**: every spawned sidecar child is assigned to an
  app-lifetime Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
  (src-tauri/src/sidecar.rs `sidecar_job`) — whatever kills the app
  (taskkill /F, the installer, a crash), the kernel kills node.exe with it.
  No Rust code needs to run; that is the point.
- **The installer-side hook** (`installer-hooks.nsh`, wired via
  `bundle.windows.nsis.installerHooks`): NSIS_HOOK_PREINSTALL kills
  ACUTE-CODE.exe + node.exe processes whose executable lives under
  $INSTDIR (never global node.exe) — the safety net for pre-leash orphans.
- The setup wizard's look remains NSIS-stock (honestly noted as standing
  polish; a custom UI is a separate work item).

## §2 The Models & Providers tab

- **The row actions are real buttons now**: the four actions (test /
  configure / hide-from-picker / delete) read as one segmented cluster —
  visible border, subtle fill, hover/press/focus states (delete red), the
  R87 spin/pass/fail contract preserved.
- **The hide/show toggle no longer scrolls the list to the top**: the
  toggleHidden mutation is fully optimistic (cache patched, no refetch
  flash, rollback on error) — the scroll position survives.
- **Test scopes**: the Test button is a split button — *Test all* /
  *Test only failed* / *Test only working* (last results tracked at tab
  level; the failed/working options disable with honest hints when empty).

## §3 The chat

- **Stick-to-bottom scrolling**: auto-scroll only while the user is at the
  bottom (96px threshold); scrolling up during a running turn detaches —
  new content no longer yanks the view; a "Jump to latest" pill re-pins.
- **Queued messages land MID-TURN** (the position fix): a message queued
  while the agent works is claimed at the next tool-call boundary
  (AI SDK 7 `prepareStep`'s messages override) — the model sees it during
  the run and the transcript shows it AFTER the tool result, not after the
  original message. Leftovers still drain through the post-turn
  continuation; both consumers share the same atomic claim.

## §4 The provider dead-ends ("Generation failed: unknown object")

- **`malformed_response` joins the transient classes**: "unknown object" /
  unexpected token/chunk/part/object / invalid response shape / malformed —
  the owner's literal dead end — now rides the existing R75 retry ladder.
- **The unknown-with-PROGRESS retry**: `unknown` stays fail-fast EXCEPT
  when the dying turn already did real work (persisted tool results /
  streamed text) — ONE bounded 5s retry with a visible meta.retry card
  (attempt 2 of 2), then the honest terminal path.
- Proven live: the Linux live-fire harness (scripts/r94-live-fire.mjs)
  reproduces the exact 500-"unknown object" class end to end and shows the
  automatic recovery.

## §5 Computer use — the Windows failure chain (one root cause)

The owner's diagnostics (empty `windows_overview`, `foregroundPid:0`,
`active:false` everywhere, "owns no accessible top-level window" for every
app) all traced to ONE root: **the U32 Add-Type (csc) compile fails on the
owner's machine**. The fixes:

- **Honest diagnostics**: the compile failure's error text now rides every
  −1 diagnostics (`addTypeError`) — the next field report says WHY.
- **The csc-free UIAutomation fallback**: `LoadWithPartialName
  ('UIAutomationClient')` needs no compiler — RootElement children ARE the
  top-level windows (title/pid/bounds/NativeWindowHandle), FocusedElement
  IS the foreground. list_apps / list_windows / frontmostPid all fall back
  to it, entries tagged `source:'uia-fallback'`, diagnostics
  `uiaFallback:true`.
- **The window actor — `window_action`**: minimize | maximize | restore |
  focus | close on windowId | `target:'foreground'` | appRef
  (ShowWindowAsync/PostMessage; WindowPattern via the UIA fallback). The
  owner's "minimize the current window" task finally HAS an actor.
- **The vision gate**: a session with no image understanding (non-vision
  main model, no separate vision model) can no longer waste turns on
  screenshot tools — the refusal is instructive ("perceive via
  get_app_state / read_dom…") and fires BEFORE any capture. The browser
  screenshot action shares the same gate.

## §6 Browser use — the reliability round

- **The evalJob self-heal** (the "unexpected start payload (no job
  started)" class): the 17–19KB monolithic scripts are split — a TINY
  per-action start + a one-time runtime installer (`needInstall` flow);
  an unexpected start payload first polls `window.__acuteJob` once (a
  mangled-but-started job is recovered), then retries once, then fails WITH
  the received payload snippet in the error. Size was the discriminating
  variable of the owner's failures (all plain evals worked; all hands
  actions died) — the per-action script is now ~1–2KB.
- **`wait`**: readyState/selector/urlContains polling with honest timeout
  reporting (the agent literally tried action 'wait' before it existed).
- **`sequence`**: multi-stage steps in ONE call (type → wait → click …),
  first failure stops with the step index, built-in settle waits +
  post-navigate readyState waits, nesting refused, max 8 steps.
- Forms: type with `submit:true` remains the Enter path (the prompt now
  teaches it alongside the discipline).

## §7 The prompt overhaul

- **CAPABILITIES section** (vision-gated): no-vision sessions get the
  one-line "you have NO image understanding — never call screenshot tools;
  perceive via read_dom/get_app_state" instruction; vision sessions get
  the converse MAY line.
- **RECOVERY PROTOCOL**: re-observe before retrying; at most 2 identical
  retries then CHANGE STRATEGY; recovery hints followed exactly once;
  refusals are real; let the world settle (wait / sequence / CAPTCHA →
  wait_for_verification); never abandon the task.
- Browser discipline (navigate → wait → read_dom → verify before
  interacting; sequence for known chains) + computer-use discipline (exact
  title/pid; window_action target:'foreground'; the tree over pixels).
  Net prompt growth: +302 words, paid for by same-section trims.

## §8 The Linux live-fire (the owner's "test it in your environment" ask)

`scripts/r94-live-fire.mjs` — a real end-to-end harness against a real
local OpenAI-compatible SSE provider driving the BUILT sidecar:

| Scenario | Result |
|---|---|
| Queued message injected mid-turn (request #2 carries it; persisted after `tool.use`; the delivered frame rides the stream) | PASS |
| "unknown object" 500s → SDK retry exhaustion → the runtime ladder (meta.retry visible) → recovery | PASS |
| /system/updates honest anonymous reporting (the sandbox IP is GitHub-rate-limited; both paths pinned in tests) | PASS |
| browser wait + sequence live headless (wait pauses; sequence fails honestly at the dead bridge; the turn survives) | PASS |
| window_action dispatched + honest Linux refusal | PASS |

Plus the whole pipeline: lint clean, both typechecks clean, root
3,091/3,091, agent-core 2,041/2,041, e2e 12/12, build green, license 134
clean, docs:check 199/0/0, version:check ×4 = 0.92.0.

## §9 The owner's TEST CHECKLIST (v0.92.0)

1. **In-app update** (About → Check for updates → Update now) on the OLD
   version — should download, verify, and run the installer cleanly.
2. **The installer over a running app** — no "Error opening file for
   writing" on node.exe (the job leash + the preinstall hook).
3. **ACUTE.bat on the diverged clone** — the public note, then the
   realignment ("local history diverged… realigning"), then a normal boot.
4. **Models tab** — the row buttons look like buttons; hide/show keeps the
   scroll; the Test dropdown scopes (all / failed / working).
5. **Chat** — scroll up during a running turn (it stays put; the pill
   appears); queue a message while sub-agents work (it lands after the
   tool result, mid-run).
6. **The dead-end class** — a flaky provider error mid-task now shows a
   retry card and continues (watch for meta.retry in the stream).
7. **Computer use** (Windows) — even if the Add-Type compile is dead on
   the machine, list_apps/windows_overview now answer (the UIA fallback;
   diagnostics name the addTypeError), and "minimize the current window"
   works via window_action target:'foreground'.
8. **Browser** — type→submit flows; wait after navigate; a multi-step
   sequence in one call; a no-vision model never burns turns on
   screenshots (the instructive refusal).

## §10 Known/standing

- The NSIS wizard UI remains stock (standing polish item).
- The browser agent's CDP-level trusted-input tier (isTrusted) and the
  COM IUIAutomation ACTION/MSAA layers remain future work (as R93 noted).
- `cargo check` cannot run on this Linux sandbox (no GTK system libs, no
  sudo; the Windows CI build compiles the Rust side for real — the
  cross-check was blocked only by tauri-winres/llvm-rc, not our code).
