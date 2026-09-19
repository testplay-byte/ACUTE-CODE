<!-- last-reviewed: 2026-09-19 round-108 -->
# Round 93 — the fifth-walkthrough round (v0.91.0)

The owner's fifth end-to-end walkthrough of v0.90.0 confirmed the R92 wins
(the multi-key pool with juggling, the browser staying live through composer
menus, the generation dead end closed, editable agents, the browser agent
completing real search-and-download tasks on NVIDIA Nemotron) and filed this
round's list: a family of visual/layering nits on the model selector, the
key-list rendering bug, the missing batch model-add flows, the toggle
contrast, the browser agent's hands, the queued-message and failure-handling
gaps, the sub-agent dead ends — and THE HEADLINE: the full computer-use
rework (understand apps, learn them over time, manage state, get smarter
with use — as an independent, documented module).

## 1. The verdicts this round answers

| Verdict (the owner's words, compressed) | Where it landed |
|---|---|
| "The background blur should be slight — and it should apply to the browser window itself too" / the model picker's providers list rendered outside the window | §2 |
| "When hovering over the provider, the models menu renders UNDER the browser window" | §2 |
| "The API keys say '2 keys added' but the list shows only one" | §3 |
| "There is no way to add multiple models at once" — right side of a row adds directly; left side opens the picker; click+drag selects a range | §3 |
| "Add a button to quickly test all models" + the 4th per-model button to hide/show in the chat picker | §3 |
| "The toggles' active circle is white — it should be black to be clearly visible" | §4 |
| "Agents are editable, but the UX needs improvement" | §4 |
| Browser agent: typing occasionally garbled; "the mouse is not detected as a real mouse"; after switching to Images it reverted back to All | §5 |
| "After tool calls / the flow, the queued message is not sent automatically" | §6 |
| "When generation fails, it does not try to continue the session" — no silent failures | §6 |
| "Sub-agent tasks cannot run" (even a single API key must serve them) / "the sub-agent model list shows ALL OpenRouter models — only available ones should show" | §7 |
| "Full-fledged computer use functionality… learns programs… builds its own accessibility tree and state management… independent modular build… Windows, Linux, later macOS" | §8 |

## 2. The composer's selector family over the browser (the last layering nits)

The R92 overlay work made the browser STAY while menus open; the owner's
fifth pass filed the three residual defects, all in the ModelSelector
family:

1. **The popover geometry (the cut-off providers list).** The selector
   anchored `absolute right-0 w-64` off the composer — at the owner's
   squeezed chat column (the 240px floor beside a wide sidebar) the panel
   extended LEFT past the viewport edge and the providers list rendered
   outside the window. The R93 fix: a `popGeo` effect that measures the
   trigger and places the popover in FIXED coordinates, right-aligned to
   the trigger, then CLAMPED to `[8, innerWidth − 264]` — it can never
   leave the window. A resize listener re-clamps live; an unmeasured
   trigger keeps the old absolute anchor (never a NaN).
2. **The slight blur, mirrored INTO the browser.** The scrim was
   `backdrop-filter: blur(3px)` at 25% dim — too heavy, and a DOM
   backdrop-filter can never reach the OS-level child webview, so the
   browser stayed sharp while the app frosted. The R93 contract: the scrim
   is SLIGHT (1.5px / 16%) and carries its radius in the
   `data-webview-backdrop="1.5"` marker; the guard reads every live
   marker's value into `backdropBlur` (+ a `backdropSeq` change counter);
   BrowserPanel's `evalBackdropBlur` injects/removes THE SAME CSS filter
   into the live page via `nativeTabEval` (re-asserted after
   `nativeCreate`) — the browser frosts WITH the app, at the same
   intensity, and clears when the popover closes.
3. **The flyout z-order.** The provider-hover model flyout was a
   `role="listbox"` div that never matched the webview guard's
   `OVERLAY_SELECTOR`, so it rendered UNDER the OS webview while every
   other menu rode above it. The fix: `[data-model-flyout]` joined the
   guard's overlay set — the flyout now rides the overlay window above
   the browser like the rest of the selector family.

## 3. The Models & Providers surface (keys listing, batch add, test-all)

- **The slot-1 listing bug (the "2 keys added but 1 shown" verdict):**
  `poolInfo` computed the pool slots with a `maxSlot ≥ 2` filter — the
  R92-D3 floor (a provider with exactly ONE pool key, slots `0 + 1`) was
  never taught to it, so the card listed Key 1 and nothing else while the
  provider row's chip honestly said 2. The filter is `n ≥ 1` — Key 2 (slot
  1) lists again; the count chip and the card agree.
- **The multi-add picker (the owner's three-gesture spec):** the whole
  catalog row was one button that opened the full config dialog — no way
  to add several models quickly. The R93 interactions, exactly as
  specified: the RIGHT side of a row is a one-click DIRECT ADD (POST the
  upsert with the prefill defaults; the picker stays open; the row flips
  to ADDED); the LEFT side toggles SELECTION; a pointerdown-and-drag
  PAINTS a range (swept rows join the initial toggle's target state —
  select or deselect, like a file manager's marquee); the pencil still
  opens the R87 configure flow per row. The selection strip's
  "Add N models" runs `allSettled` over the batch (the picker closes on
  full success) and renders an honest error strip naming any failures.
- **The 4th per-model button + Test all:** the model card's quick actions
  were test/edit/delete; the 4th is the Eye/EyeOff toggle — one click
  PATCHes `{hidden}` (the field existed end-to-end since migration 0004;
  hidden rows drop out of the chat picker, the sub-agent picker, and the
  agent dialog's datalists until toggled back). The page header gains
  **Test all**: per-card probes sequenced through a `testAllSeq` counter,
  live done/failed progress, and a summary line — every provider's models
  provable in one click.

## 4. The settings-wide polish (toggles, the agent form, the sub-agent picker)

- **The shared contrast-aware toggle (the white-knob verdict):** seven
  copy-pasted switches hardcoded `bg-white` knobs — on the Mono Stone
  theme's `#E0E0E0` accent that was white-on-white. The R93 fix is the
  shared `src/components/ui/toggle-switch.tsx`: checked →
  `styles.accentText` (near-black on the amber accent), unchecked →
  `styles.toggleActive`, per-variant geometry preserved. Skills, MCP,
  Computer Use migrated; the Models & Providers and SettingsPage inline
  switches got the same contrast-aware knob inline.
- **The agent form's sectioned UX (the "editable but poor UX" verdict):**
  `AgentFormDialog` reorganized into labeled sections — Identity (name +
  role), Model (provider + model + vision model), Behavior (the system
  prompt in a 160px monospace textarea, resizable, + memory policy),
  Capabilities (allowed-tools grid + skills chips), Advanced (max turns +
  temperature). Every R92-C semantic is preserved byte-for-byte (the
  null-safe round-trips, the "— none —" option, explicit-null PATCH
  semantics, validation, the footer).
- **The sub-agent picker shows ONLY configured models (the owner's
  explicit list):** the primary — and only — list is the user's
  CONFIGURED rows (`GET /models/configured`; hidden rows excluded;
  tool-less rows disabled with the reason). The static OpenRouter
  catalog is deleted from this surface. Zero configured models → the
  honest hint + the "Add models" link to Models & Providers. The inherit
  row (ride the parent's model) is unchanged. Models & Providers'
  invalidation fan-out now includes the configured query — add/hide/
  delete reflects on the next open, not after a staleTime.

## 5. The browser agent's hands (typing, clicks, section state)

- **Typing fidelity (the garbled text verdict):** `typeInto` iterated
  UTF-16 CODE UNITS — astral characters (emoji) split into lone surrogates
  and rendered as mojibake; the native-value fallback armed only when the
  FIRST char failed, so a mid-word `execCommand` failure silently DROPPED
  the rest; and contenteditable editors that react to `keydown` saw
  nothing while text appeared. The fixes: code-point iteration
  (`Array.from`), the fallback arms on ANY failed char, and a cancelable
  synthetic `keydown` fires on the focused element before every inserted
  char (canceled keydowns are counted and reported, never obeyed). The
  human pacing contracts are untouched (the word-by-word cadence, the
  per-char jitter, the Enter trio). The eval budget is pinned in BYTES
  (the worst-case 600-char all-escaped text compiles under the Rust
  20,000-byte eval limit).
- **Click trust (the "not a real mouse" verdict):** `realClick` now fires
  the FULL spec-order pointer flow — a settle micro-move to the target
  center (hover-first), `pointerover`/`pointerenter`/`mouseover`/
  `mouseenter`, a 40–120ms hover beat (menus and comboboxes arm),
  a zero-in micro-move to the exact point, `pointerdown`/`mousedown`, a
  press pulse, `focus`, a 60–140ms hold, `pointerup`/`mouseup`/`click` —
  with pointer identity (`pointerId 1, pointerType "mouse", isPrimary`),
  button/pressure state per phase, and `detail: 2` on double-clicks.
  Honest limit, stated in the code: `isTrusted` stays false without a CDP
  connection — but every other observable signal of a real mouse now
  matches.
- **Section-state tracking (the Images→All reversion verdict):**
  `read_dom`'s result carries `pageState` — the URL hash + query params,
  every `aria-selected`/`aria-current` element, and `<html lang>` — and
  the tool DESCRIPTION teaches the discipline: after clicking a section,
  `read_dom` again and CHECK `pageState`; if the section reverted, click
  it again. The click action itself reports the focus move
  (`focus moved to {tag, name}`) — a cheap effect-confirmation signal.

## 6. The turn-loop reliability (the queue, failure recovery)

- **The queue continuation (the "never sent automatically" verdict):**
  the post-turn queue flush only ran inside `if (outcome.ok)` — ANY
  failed turn stranded the queue; and the check was one-shot BEFORE the
  debug-analyst phase, so a message queued during the analyst phase was
  missed. The fixes: a post-analyst RE-CHECK (a message landing during
  the analyst phase sends, announced by `meta.queue_continue`), and the
  runTurn queue gate trusts the server's 409 (no more silent drops).
- **The ONE recovery continuation (the "does not try to continue"
  verdict):** on a network/timeout-class failure — the transient classes
  the key pool and retry ladder do NOT own — with messages still queued,
  the streamed runner makes exactly ONE automatic recovery continuation
  (`meta.queue_continue {recovery: true}`); the kept messages are
  reported honestly (`queuedKept` in the error frame details and the
  done frame — the amber "kept for the retry" strip in the chat). The
  documented discovery: a ladder retry is a fresh outer-loop iteration,
  so a message queued during an EARLIER attempt is already delivered by
  the retry's loop-top flush — only a message landing during the FINAL
  attempt (or with the ladder disabled) is still queued at terminal
  failure, and that is exactly the window the recovery serves.
  Auth/rate-limit/pool-exhausted failures do NOT auto-continue (the pool
  and ladder own those; the honest error stays).
- **The sub-agent dead ends closed at both ends:** (1) `acquireSlot`
  polled FOREVER with no timeout when the child's effective provider had
  an empty pool — the child hung queued and the parent's `delegate_task`
  never returned; it now fails FAST with the honest, actionable message.
  (2) A child with no explicit `subagentModel` did NOT inherit the
  parent's per-send provider/model override — the child 409'd with "has
  no provider ID/model configured" even with one good key configured.
  `resolveDelegation` (and the retry mirror) now falls back to
  `TurnDeps.mainModel` — the parent turn's EFFECTIVE pair — so a
  sub-agent runs on the same single key the parent uses.

## 7. THE COMPUTER-USE V2 (the headline — the learning layer)

The owner's reference project (ClickScope, recovered from git history —
the uploaded 7z was a broken 2-byte stub) owns DISCOVERY, IDENTITY and
LEARNING; ACUTE owns actuation, safety and agent ergonomics. The v2 welds
the former onto the latter as an INDEPENDENT module (design doc
`docs/architecture/COMPUTER-USE-V2.md`; only `computer/element-map.ts`
reads/writes the new tables — nothing else in the codebase touches them).

- **The element map (migration 0034 + `element-map.ts`):** every observed
  element gets a stable IDENTITY (app + window + kind + name + an 8px-floor
  quantized rect, NUL-joined — text-safe `\u0000` escapes in source);
  every registered scan runs the existence-checked DIFF (new/lost counts +
  the first new names ride the tool result as `mapDelta`); per-element
  reliability counters (click_count / verify_success_count, fed from the
  action receipts' verification status); per-app profiles (window titles,
  element counts, stable elements, reliability leaders); ClickScope-style
  RELOCATION scoring when an element went missing (name/kind/proximity).
  The whole registration folds in ONE transaction (one commit, not one
  fsync per element).
- **The hierarchy:** every element carries `key` (per-walk, aligned with
  the flat index), `windowKey`, `parentKey`, `path` (the 5-segment
  breadcrumb) and `treeDepth` — the flat walk order (the actuation index
  contract) is preserved byte-identically.
- **The layered clickability (the C5 rework):** TYPE (the probe list) →
  PATTERN (the four GetCurrentPattern probes — Invoke/Toggle/
  ExpandCollapse/Value — widened to NAMED non-type elements, catching
  interactive controls hiding in generic panes) → FOCUSABLE
  (`Current.IsKeyboardFocusable` read directly + named + non-container).
  `via` records the first layer that fired. ClickScope's ACTION/MSAA
  legacy layers are HONESTLY ABSENT: they read `LegacyIAccessible`
  properties that live on the COM `IUIAutomation` face the managed
  `System.Windows.Automation` bridge never exposes — the first draft's
  by-id reader was provably inert (caught in the C5 pre-release review;
  deleted, not shipped dead).
- **Ten new posture-gated tools:** `get_tree` / `get_children` /
  `get_parent` / `get_subtree` (dense-UI navigation), `windows_overview`
  (the desktop's windows), `element_at` (hit-test a coordinate through
  the live frame), `app_profile` (the learned per-app map + reliability
  leaders), `move_window` / `window_state` / `focus_window` (placement on
  ALL backends: SetWindowPos/ShowWindow/SetForegroundWindow, `wmctrl`,
  System Events).
- **The STALE_ELEMENT relocation payload:** acting on a moved element
  refuses with `relocatedIndex/Name/StateId` + the reason — the one-call
  recovery the skill teaches (retry with the payload's target).
- **Ghost-box verification (`verify-rects.ts`):** flat-stddev + Otsu
  minority-ink detection flags degenerate rectangles (2px-wide "elements"
  on gradients) as ghosts — they are dropped from registration,
  FAIL-OPEN when the raster is unavailable.
- **The transport fix:** the v2 walk capsule measured 33,140 base64
  chars — PAST the 32,767 CreateProcess ceiling; the spawn would have
  died on real Windows. `psCapsule` switches to a temp-`.ps1` `-File`
  transport above 30,000 b64 (no command-line ceiling at all), written
  UTF-8 **WITH BOM** — powershell.exe 5.1 decodes BOM-less scripts as
  ANSI and the path breadcrumb's `›` would mojibake (caught in the C5
  review). Both transports are size-pinned.
- **The skill rewritten** (`COMPUTER_USE_SKILL_BODY`): mapDelta reading,
  the relocation shortcut, the tree tools for dense UIs, and the
  reliability leaders (prefer a historically-verified element when
  several match).

## 8. The verification table

| Gate | Result |
|---|---|
| `pnpm lint` | clean (the C5 fix: a disable-comment for the never-registered `react-hooks/exhaustive-deps` rule was itself the error — removed) |
| `pnpm typecheck` (root) + agent-core `tsc --noEmit` | clean |
| `pnpm test` | **3,023 / 3,023** (167 files — the 12 node-pty/pipe tests are Linux-only by design: they run here, they SKIP on Windows CI, never fail) |
| `pnpm test:e2e` | 12 / 12 (the C5 catch: the built sidecar failed to boot on an extension-less `from "./types"` — invisible to every vitest suite, fatal at Node ESM runtime; fixed + pinned) |
| `pnpm build` | green |
| `pnpm license:audit` | 134 production dependencies, clean |
| `cargo check --target x86_64-pc-windows-msvc` | not run locally this round — **zero `.rs` files changed in R93** (verified per commit); CI's Windows build is the authoritative check |
| `pnpm docs:check` | 198 docs, 0 failures, 0 warnings (after the round-93 stamps) |
| Pre-release review (independent sub-agent over `v0.90.0..HEAD`) | FIX-FIRST findings all resolved: the BOM fix, the inert ACTION/MSAA layers deleted, the test-handle leaks closed, the registration transaction-wrapped, the stale docblock corrected |
| GitHub CI | (filled below after the push) |
| Release | (filled below after the publish) |

## 9. Files this round

- Composer/browser layering: `src/components/project-chat/composer/ModelSelector.tsx`,
  `src/components/right-sidebar/{BrowserPanel,popover-webview-guard}.tsx`,
  `src/lib/…` (the guard's backdrop state).
- Settings surface: `src/components/settings/{ModelsProvidersTab,SubAgentsTab,SkillsTab,McpTab,ComputerUseTab}.tsx`,
  `src/components/agents/AgentFormDialog.tsx`, `src/components/ui/toggle-switch.tsx` (new),
  `src/pages/SettingsPage.tsx`, `src/lib/{api,stream-store}.ts`,
  `src/components/project-chat/AgentChatPanel.tsx`.
- Turn-loop runtime: `agent-core/src/routes/sse.ts`, `agent-core/src/agents/{orchestrator,runtime}.ts`,
  `agent-core/src/providers/registry.ts`, `agent-core/src/tools/plugins/delegation.ts`.
- Browser hands: `agent-core/src/tools/plugins/{browser-hands,browser}.ts`.
- Computer-use v2: `agent-core/src/computer/{element-map,types,dispatch,verify-rects}.ts` (+ `backends/{interface,windows,linux,macos}.ts`),
  `agent-core/src/storage/migrations/0034_computer_element_map.sql` (new),
  `agent-core/src/tools/plugins/computer-use.ts`, `agent-core/src/storage/skills.ts`,
  `docs/architecture/COMPUTER-USE-V2.md` (new).
- Tests: `computer-element-map.test.ts` (new), `computer-verify-rects.test.ts` (new),
  `computer-dispatch.test.ts`, `computer-windows-backend.test.ts`, `skills-mcp.test.ts`,
  `storage.test.ts`, `browser-tool.test.ts`, `SubAgentsTab.test.tsx`, `AgentFormDialog.test.tsx`,
  `ModelsProvidersTab.test.tsx`, `stream-store.test.ts`, `popover-webview-guard`/`BrowserPanel` tests.

## 10. Test checklist for the owner (the sixth walkthrough, v0.91.0)

1. **The model selector over the browser**: open the browser tab, then the
   model picker — the popover stays INSIDE the app window (the providers
   list no longer renders off-screen left), the dim is SLIGHT, and the
   BROWSER ITSELF frosts at the same intensity while the picker is open,
   clearing when it closes. Hover a provider — the models flyout floats
   ABOVE the browser, never under it.
2. **The key list**: a provider with two keys shows Key 1 AND Key 2 in
   the "API keys" card (the row chip's count matches what the card lists).
3. **Batch model add**: Add models — the RIGHT side of a row adds that
   model instantly (the row flips to ADDED, the picker stays open); the
   LEFT side selects; click-and-drag paints a range; "Add N models" adds
   them all (any failure is named in the error strip); the pencil still
   opens the full configure dialog.
4. **The 4th button + Test all**: the Eye button on a model card hides it
   (the chat picker, the sub-agent picker, and the agent dialog's
   suggestions all drop it) and toggles it back; the page header's
   **Test all** probes every card with live progress and a summary.
5. **The toggles**: on light accents (Mono Stone) every switch's ON knob
   is dark and clearly visible, not white-on-white.
6. **The agent form**: Edit an agent — the sectioned dialog (Identity /
   Model / Behavior / Capabilities / Advanced) with the tall monospace
   system-prompt editor; save semantics unchanged.
7. **The sub-agent picker + the single-key run**: Settings → Sub-agents —
   the model list shows ONLY your configured models (hidden ones gone);
   with ONE key on the provider, delegate a sub-agent task from chat —
   it RUNS on that same key.
8. **The queue + recovery**: queue a message while a turn runs — it
   sends when the turn completes, even after a failed turn (the amber
   "kept" notice names what was held); a network-failed turn with queued
   messages makes exactly ONE automatic recovery continuation.
9. **The browser agent's hands**: type text with emoji into a page field
   (no garbling, no dropped letters); click a site's Images section and
   re-read — `pageState` shows the section held (the tool re-clicks if
   it reverted); hover-armed menus respond to the full pointer sequence.
10. **COMPUTER USE**: with computer use enabled, run a desktop task —
    `get_app_state` returns the tree with identity keys and paths; a
    second scan shows `mapDelta` (+new/−lost); `app_profile` builds over
    observations; acting on a moved element returns the relocation
    candidate; the tree/window tools navigate dense UIs; the skill
    teaches the whole discipline.

## 11. The public migration (the C5 close-out's epilogue)

The R93 push (93111d7 pre-rewrite) + tag v0.91.0 landed at 14:07 UTC into
a wall: every workflow run since — CI, Release, and a re-run of the
morning's SUCCESSFUL run — completed instantly with zero steps, empty
logs, and `runner_id: 0`. A four-probe bisect workflow (3a0ef6c
pre-rewrite, removed in 4baf918 pre-rewrite) settled it: the IDENTICAL
probe jobs got runners in the public DASHBOARD repo and none in the
private ACUTE-CODE repo — the account's monthly PRIVATE-repository
Actions minutes were exhausted (windows-latest bills 2×; the morning's
burst spent the last of them). The owner directed the remedy: **switch
the repository PUBLIC** (unlimited free Actions minutes on standard
runners; it can be turned private again later at will — the docs are
written so both states are safe).

Before the flip, the ENTIRE history was secret-scanned (every blob,
every credential shape in the live inventory — not just the working
tree):

- **HEAD was clean** — every test fixture is synthetic (verified by
  length + equality against the live values, never by eyeball).
- **Three real OpenRouter keys lived in history**: the R44 launcher's
  "baked-in defaults" (added 8156bde pre-rewrite, scrubbed from the
  TREES in R47's 862af5d pre-rewrite) — `launcher/acute_launcher.py` +
  `launcher/credentials.example.txt` historical blobs only.
- **The R45 scrubber fixture reused the live PAT's opening segment**
  (a 45-char synthetic tail — harmless to authenticate with, but GitHub
  secret-scanning would flag the shape and mail the owner once public).
- **Commit author metadata carried the owner's personal Gmail**, and
  **the docs quoted the ntfy topic** (a shared secret for the
  notification channel).

Remediation (two filter-repo passes, then the flip):

- The R45 fixture now uses a labeled TESTFIXTURE shape at HEAD and the
  historical fixture string was purged (suite 50/50 re-verified).
- `git filter-repo --replace-text` purged the three OpenRouter keys,
  the ntfy topic string, and the historical fixture from EVERY blob;
  `--email-callback` rewrote the two personal-email identities to the
  GitHub noreply form (`299906586+testplay-byte@users.noreply.github.com`).
- Post-rewrite verification: **0 real-key bytes, 0 topic occurrences,
  0 personal emails, 0 PAT-prefix traces across all rewritten objects**
  (the full-blob scan re-run twice — once per pass).
- Commit hashes from R44 onward are REWRITTEN (main → 5f643a9,
  v0.91.0 → 90521fd); pre-R44 history is byte-identical
  (round-27-testing unchanged). Older hashes quoted in the round docs
  are the pre-rewrite values — narrative references, not broken links.
- The 29 published releases re-pointed to the rewritten tags (assets
  and notes live on the release objects, not the tags).
- GitHub suppresses push events when more than three tags are pushed at
  once — the bulk `--tags` force-push fired no workflows; the v0.91.0
  tag was deleted and re-pushed ALONE to fire the Release workflow.

**Owner recommendation (defense-in-depth):** the three keys sat in a
private remote for ~50 rounds, and GitHub retains unreachable objects
until garbage collection — rotating the three OpenRouter keys closes
even that residual path (new rounds never carry keys in git; keys live
only in Windows Credential Manager + the local credentials file). If
the topic's exposure ever matters, pick a new ntfy topic going
forward (the docs no longer quote it).
