<!-- last-reviewed: 2026-09-19 round-108 -->
<!-- round: 99 -->
# Round 99 — the research-driven UI redo + the self-contained app (v0.96.0 → v0.97.0)

The owner's tenth walkthrough report (v0.96.0): the features work, but the
UI surfaces "have definitely not made any improvements whatsoever", the
browser still "relies on the device's browser itself", the updater needs
"everything else happen automatically afterwards by itself", and the
system prompt carries a named flaw list ("length dilutes attention… heavy
duplication, no precedence rules… hard numbers become targets… no risk
threshold for autonomy…"). This round's method is new: **research first**
— a dedicated UX-research pass (Cursor/VS Code/Claude Code `​/context`/
GitHub heatmap + danger zone/Geist/Tauri updater patterns; the report is
quoted throughout) drove every design decision, then seven surgical
workstreams landed, then **the full subagent review pass the owner was
owed since R98** (a real independent reviewer — not the orchestrator's
self-review) audited the whole round before the release.

## §0 The owner's report, itemized (the round's contract)

1. **Native browser support**: "install the browser packages and ship them
   alongside the application so it does not have to rely on the device's
   browser itself" — R99-A: the WebView2 **Fixed Version Runtime** now
   rides inside the installer (tauri.conf.json `fixedRuntime` + the
   resources map + the CI fetch of the pinned 153.0.4234.32 x64 cab); every
   in-app link (chat markdown, file previews, About) routes through the
   central **open-link router** into the embedded browser panel by default
   (the chat links were DEAD before — `target="_blank"` is silently
   swallowed inside WebView2); the "Link opening" preference (in-app /
   system) in Settings → Browser. — closed.
2. **The chat window redo**: "I also told you to improve the UI of the chat
   window… not redesigned properly" + "analyze which info is necessary in
   compressed view and in full view" — R99-B: the turn header (model
   identity + hover timestamp, the R37 avatar ban held), the folded work
   summaries (✓ Completed N steps · N tools · mm:ss), the tool-row anatomy
   (leading outcome glyph ✓/✗/◌ + verb + target + one-line summary), the
   one-line stats footer, the soft streaming caret, the empty-state
   pill-cards, tabular-nums everywhere. The compressed-vs-full matrix is
   written into the docblock + COMPONENTS.md. — closed.
3. **The updater**: "I click the update button and everything else happens
   automatically afterwards by itself" — R99-C: the ONE-CLICK SILENT
   UPDATE — `/S /R` via ShellExecuteW (the tauri NSIS template's own
   `.onInstSuccess` relaunch leg — verified against the template source),
   byte-true download progress, inline release notes, the 24h startup
   auto-check + the Sidebar dot + one clickable toast, the wizard fallback
   for pathological machines. — closed.
4. **The context popup**: "the context window composition does not look
   proper… the overview is not proper" — R99-D: rebuilt after the Claude
   Code `/context` reference: the overview HERO (big token line + one %
   line + ≤3 honesty pairs), the composition bar as the star (inline %
   labels + the legend with tokens/%-of-used + jump-to-management links),
   one-row cache, both render legs painting from ONE payload. — closed.
5. **Data & Statistics**: "some jitters… the clear usage data completely
   looks out of place… the turn errors and tool failures… out of order" —
   R99-E: the reorder (charts → ONE quiet Agent health section → the
   danger zone ALWAYS LAST, GitHub-style), the anti-jitter kit
   (tabular-nums + fixed-height reserves + skeleton geometry mirror). —
   closed.
6. **The prompts section**: "it should be the whole project system-wide
   default prompt not just the one… learn from the best of the best" —
   R99-F: the tab is now the project-wide **System prompt manager**
   (master-detail-lite after Cursor Rules: bucket-grouped searchable list,
   status chips, per-section token estimates, the registry's own
   descriptions, Revert all, the promoted composed-prompt preview). —
   closed.
7. **The system prompt's flaw list** (8 items + the planning-first
   meta-directive) — R99-G: precedence ladder, autonomy risk tiers, INTAKE
   phase 0, tool descriptions, the subagent report contract, confidence
   tags, memory save/recall discipline, the numbers audit, and the dedup
   that paid for it all (~2.3K chars retired; 23,975/24,000). — closed.
8. **"You are not doing proper research"** — the round's method answer: the
   research pass ran FIRST and every workstream cites it; the review pass
   ran LAST and its four findings were fixed + pinned before the release.

## §1 The research chapter

The research report (saved during planning; ~20 searches, 20+ primary
sources deep-read) established the patterns each workstream copied: the
Zed theme-token user/assistant separation lesson, VS Code's "Completed N
steps" collapse grammar + the 3-option send dropdown, the queued/thinking/
streaming/stopped state machine, Claude Code `/context`'s colored grid +
legend + jump-to-management + action-paired diagnoses, GitHub's exact
heatmap palette + the danger-zone-always-last placement + type-to-confirm,
Geist's empty-state variants, VS Code's integrated browser toolbar, and
the Tauri v2 updater's Started/Progress/Finished event contract + the
`relaunch-after-graceful-exit` MSI lesson. Each workstream's docblock
cites the pattern it implements.

## §2 The workstreams

| id | delivered | commit |
|---|---|---|
| A | the browser engine ships with the app + the central link router + the preference | 954e11d (+ the serde-tag fix 34fe1e5 + the README-stub fix ca7bf9d) |
| B | the chat visual redo (turn headers, compressed summaries, tool anatomy, caret) | be5a476 |
| C | the one-click silent auto-update + the startup auto-check | 1518a85 |
| D | the context popup's hero/bar/legend redesign (both legs) | 329126c |
| E | the stats reorder + Agent health + the danger zone + anti-jitter | b4af39d |
| F | the project-wide System prompt manager | feacdc3 |
| G | the system-prompt overhaul (the 8 flaws + INTAKE + the dedup) | ac1e87c |
| H | the full subagent review + its four fixes + this close-out | de5ed1a + this commit |

## §3 The verification numbers

- Frontend + agent-core root suite: **3,754 passed / 12 env-skipped / 0
  failed** (the R98 baseline was 3,651 — the round added ~103 net pins).
- agent-core alone: 2,384/2,384 (the R98 baseline was 2,370).
- eslint clean; root tsc clean; docs:check 213/0/0; version ×4 at 0.97.0.
- cargo check cannot run in this sandbox — CI gates the Rust side (the
  FFI block, the config parse, the NSIS YAML); **the CI run on 329126c
  was fully GREEN including cargo check**, and the Release dispatch on
  34fe1e5 SUCCEEDED end-to-end — the fixedRuntime installer chain
  (download → expand → hoist → bundle) is proven in CI.

## §4 The round's lessons (also AGENT-MEMORY #100)

- The serde tag field for `webviewInstallMode` is **`type`**, not `mode` —
  CI's tauri-build taught us via `missing field 'type'` (run 35008218656).
- tauri-build validates **every `bundle.resources` path at COMPILE time** —
  a gitignored CI-staged dir needs the `staging/sidecar/README.md`
  committed-placeholder pattern (run 35012375316).
- The audit tooling's output pipeline eats literal `[m` sequences (ANSI
  reset) — `[math]::Round` and `max-w-[min(75%,640px)]` "corruption" was a
  display artifact; byte-dump before believing a "corrupted" file.
- Disk exhaustion (18k test-temp dirs, 6.9 GB) produces mass ENOSPC test
  failures that look like code breakage — `df -h` before diagnosing.
- The subagent context-deadline pattern held all round: killed agents'
  diffs land; verify + complete + re-pin from the worktree (7 of 8
  workstreams completed this way, 2 survived to their own reports).

## §5 The owner's TEST CHECKLIST (v0.97.0)

1. **Links in chat**: click any link an assistant message produces — it
   opens in ACUTE-CODE's own browser panel (a new tab in the right
   sidebar), not your device's browser. Middle-click too. The escape
   hatch: Settings → Browser → Link opening → System browser; the
   BrowserPanel's own "Open externally" still goes to the device browser.
2. **The installer**: ~200 MB now (it ships the browser engine — the
   honest price of "no reliance on the device's runtime"). Install with
   the webview-less-machine peace of mind: the app always runs its own
   engine.
3. **The update**: Settings → About → when an update is available, the
   card shows the release notes; click **Update now** ONCE — download →
   verify → silent install → **the app comes back by itself** in the new
   version. No wizard, no clicks. (If a pathological machine rejects the
   silent path, "Run the setup wizard manually" appears as the fallback.)
   The Sidebar's Settings dot + the toast announce updates automatically
   (24h cadence; the toggle is in About).
4. **The chat**: turns open with the model-identity header + hover
   timestamp; completed work compresses to "✓ Completed N steps · N tools
   · mm:ss"; tool rows lead with ✓/✗/◌; the live answer breathes with a
   soft caret; the footer's stats are one quiet line.
5. **The context popup** (the ring in the composer): the big token line,
   one % line, the honesty pairs, the full-width composition bar with
   inline % labels, the legend (hover a row ↔ its segment lights up) —
   "System prompt" and "MCP tools" rows link to their settings tabs.
6. **Data & Statistics** (Settings + the Usage screen): the health section
   is one quiet block; Clear usage data is the red-outlined DANGER ZONE at
   the very bottom; the numbers don't jitter.
7. **The Prompts tab**: "System prompt — the project-wide default
   instructions" — search the sections, pick one, read what it does, edit
   the override, watch the composed prompt preview, Revert all if needed.
8. **The agent's brain** (any session): the first reply to a new request
   restates the goal + what's unknown + checks skills + names what's out
   of scope BEFORE planning; risky actions sit on the autonomy ladder;
   uncertain answers end with a Confidence line; delegated work reports
   under the contract.

## §6 The review chapter (the R98 debt paid)

A dedicated review agent (not the orchestrator) audited the round's nine
commits (66 files, +7,660/−1,923) against the repo's own gates. Verdict:
**ship-shape after 4 MINORs** — the scary suspicions dissolved under
evidence (the `[math]::Round` "corruption" = display artifact, byte-proven;
the fixedRuntime double-bundle = impossible, bundler-source-proven; the
`/S /R` relaunch = template-source-proven). The four findings, all fixed +
pinned in de5ed1a: the SE_ERR 32 boundary (> 32, not > 31 — DLLNOTFOUND
would have misread as success), the planning skill's dangling
"PRECISION DISCIPLINE" pointer, the pre-release self-heal (rc ≥ release
bug in isNewerVersion), and the forgotten stamp. The honesty audit passed:
every claimed deliverable landed.
