<!-- last-reviewed: 2026-09-17 round-102 -->
<!-- round: 98 -->
# Round 98 — the design-language + de-slop + data round (v0.95.0 → v0.96.0)

The owner's ninth walkthrough report (v0.95.0): the R97 features work, but the
overall experience still reads as "AI-generated slop". This round's contract
is below, itemized from his message; every item is answered by a workstream
with a root cause verified in the tree by four recon agents (UI/frontend,
browser, prompts/skills/context, usage/notifications/terminal/wizard).

NOTE (recovery): this round was executed once through workstream G1 + the
docs/C1/C3/D/H/I2/J commits; a sandbox reset on 2026-09-15 lost the unpushed
commits (G1 survived and was re-pushed as 0d9cea2). The lost workstreams are
being re-implemented — the binding lesson recorded here: PUSH AFTER EVERY
VERIFIED WORKSTREAM COMMIT.

## §0 The owner's report, itemized (the round's contract)

1. **Sandbox check/restore**: "check out the sandbox environment and restore
   it properly if needed" — verified; on the 2026-09-15 reset: acute-code
   re-cloned (PAT remote), DASHBOARD re-cloned, helpers rebuilt. — closed.
2. **The UI is a complete redo candidate**: "the overall experience of the UI
   is not satisfactory… it feels like an AI-generated slop… a complete
   redo… the layouts, the user interface, the workings, the design."
   Root causes (survey): colors live in JS not CSS (inline `style={{}}` +
   ~90 hand-rolled hover handlers); the chat surface is a 3,497-line
   monolith with 10+ hardcoded hex literals and drifted one-off micro-type
   (9/9.5/10/10.5/11/11.5/12/12.5/13px per call site); repeated idioms
   (frosted pills, error cards ×3 spellings, hover clusters) re-implemented
   per file. — workstreams B (design language), C1 (window controls),
   C2 (chat de-slop).
3. **The context-window popup is still cramped**: "not well formatted…
   clustered… cramped… the whole layout of it needs to be adjusted properly…
   proper separation between the elements… you can use a wider aspect
   ratio." Root cause: a single 288px column on BOTH legs (DOM popover +
   menu-overlay window), sections separated only by hairlines. — workstream
   C3 (wider card, sectioned panes, both legs stay twins).
4. **Context does not remember**: "it definitely does not know or remember
   the things properly… implement our proper memory functionality."
   Root cause: memory is voluntary (the model must choose memory_save);
   the digest is a 1,500-char slice; the MemoryPanel is read/delete only.
   — workstream F1 (memory editing UI + prompt discipline + docs).
5. **Prompt customizability**: "add prompt customizability functionality…
   handle and improve the system prompts better, customizing them better in
   the settings, getting a proper visual experience." Root cause: the
   override ENGINE exists (`.acute/prompts/<id>.md` + diagnostics +
   `describePromptSections()` — the runbook names it "for a future Settings
   UI") but NO route and NO UI exist. — workstream E1.
6. **Skills are not utilized**: "the skills are not that easy to manage and
   edit… the agent is not utilizing the skills as it should… there are some
   skills which it must follow every single time." Root cause: NO
   always-load tier exists (grep-verified: the design comment says "never an
   auto-load"); the webpage-design failure = `ui-design`/`frontend-craft`
   were one-line entries + advisory hints the model skipped. The
   always-on precedent exists for MODES (`activeTaskMode` rides its full
   body every turn) — skills get the same mechanism. — workstreams
   E2 (always-load tier + golden re-pin) + E3 (SkillsTab upgrades).
7. **Chat formatting + Mermaid**: "improving the formatting… much cleaner…
   adding options to see Mermaid flow diagrams and other key things in the
   chat properly." Root cause: NO mermaid anywhere in src (grep-verified);
   the hook point is the fence branch in `ChatMarkdown` (962-line custom
   renderer). — workstreams D (Mermaid) + C2 (formatting pass).
8. **The browser is "the device's default browser"**: "integrate our own web
   browser… based on Chromium… highly customizable." VERIFIED FACTS: the
   embedded panel is ALREADY WebView2 = the Chromium engine on Windows with
   its own persistent profile dir, explicitly NOT the system browser
   (browser.rs:89-93); the only default-browser usage is the explicit
   "Open externally" handoff. The perceived non-integration = real bugs:
   screenshots hard-depend on Computer Use (OFF by default), a 1×1
   degenerate-region bug on hidden tabs, and hidden-webview captures of
   the wrong content. — workstream G1 (DELIVERED: the screenshot chain
   decoupled + honest refusals) + the honest engine story surfaced in
   Settings (G2, folded into I1's Browser tab work).
9. **Settings functionality section + categories**: "add a dedicated section
   for functionality… separate the different side options into different
   categories, like basic agent capabilities, data and statistics."
   Root cause: the settings nav is a FLAT 11-entry list; the "General" tab
   (id `advanced`) is an uncategorized 4-card column. — workstream I1.
10. **Data & Statistics**: usage stats in Settings AND the usage section —
    total tokens, peak tokens, a 12-month token-activity heatmap, time-range
    graphs color-coded BY MODEL NAME (same name across providers = one
    model), a model-usage donut, total cost, and a clear-all-data option.
    Root cause: `/usage/summary`+`/detailed` cap at 90 days; the day series
    does not carry per-model breakdown; no heatmap/donut exists; no
    usage-only clear route (only the nuclear `/system/reset`). — workstream
    I2 (+L's health aggregations).
11. **The design-language folder**: "create a design language folder and
    make sure that in that folder we properly handle our design language…
    the border around the whole UI and the top section (minimize, restore,
    close)… give them a background, each one a distinct background… when I
    hover the colors will shift a little bit and maybe some animations…
    animations are going to be part of our design language too… whenever we
    try to make edits in our UI, the design language is properly referred
    to… the setup page is quite good… document the things which are there
    as part of our design language." Root cause: `docs/design/` is prose +
    rules with zero visual specimens; the wizard's owner-approved bento DNA
    (rotations, glows, gradient primaries, keycaps, traffic lights) is
    documented NOWHERE as reusable patterns; window controls are ghost-only
    with a `Copy` glyph standing in for "restore". — workstreams B + C1.
12. **Setup wizard: OpenAI-compatible providers**: "I am unable to select
    OpenAI-compatible providers there… only Anthropic, Google, NVIDIA,
    OpenAI, and OpenRouter." Root cause: the backend FULLY supports
    `openai-compatible` custom providers (POST /providers, keyring, model
    fetch, tests) — the wizard's ProviderSelector simply never exposes a
    create path. — workstream H.
13. **Terminal usability**: "usable using the terminal tool… highly
    flexible." The 930-line `scripts/acute.mjs` harness already drives the
    full headless chat/turn/approval API; the gap is product-grade
    auto-discovery (port+token) + user-facing docs + the new stats
    surfaces. — workstream K.
14. **Desktop notifications**: "when the tasks have been completed… some
    error has occurred, or a permission is needed… it should send a
    notification to the user on his PC." Root cause: NO native Tauri
    notification plugin (Cargo/package/capabilities all grep-verified
    absent); today's Web Notification API path is permission-dependent in
    the webview. — workstream J (tauri-plugin-notification).
15. **Token/context optimization**: "it just created a file and then I tell
    it to change something in that file. It should not be the one to read
    the whole file again… context-optimized and token-optimized." Root
    cause: no server-side file-freshness tracking — nothing records what
    the model has already read, so nothing can permit direct edits or warn
    on staleness. — workstream F2.
16. **Grep + indexing**: "implement grep functionality… look into indexing…
    essential for larger projects." Root cause: `search_code` is ripgrep-
    semantics JS; the codebase INDEX exists (migration 0007) but its symbol
    search is a dead surface (not exposed as any tool/route) and indexing
    is manual-only. — workstream F3.
17. **Model/agent reliability**: "it sometimes creates the to-do list
    [sometimes not]… does not read the other skills… does not do proper
    research when needed." Root cause: todo/research discipline is
    prompt-only + advisory skill hints. — E2's always-load tier + the
    strengthened hint language + F2/F3's tools that make the discipline
    cheap to follow.
18. **Self-improving tracking**: "a self-improving, self-management system…
    a tracking system which can allow us to track the functionality of it,
    usability… what issues it runs into." Root cause: the raw signals exist
    (append-only event log, debug analyst, ratings, diagnostics ring) but
    nothing aggregates them. — workstream L (the R98 slice: agent-health
    aggregations in the data tab; the full feedback loop is documented as
    the R99 roadmap, honestly).
19. **Browser screenshots broken**: "it was currently unable to take
    screenshots of the web browser." Root causes: the Computer-Use gate
    (OFF by default), the 1×1 region clamp on hidden tabs, the
    hidden-webview capture of the wrong content. — workstream G1
    (DELIVERED).
20. **Discipline**: subagent planning + flaw-finding, per-stage ntfy
    notifications, documentation, quality over speed. — workstreams M
    (review) + N (docs/release), continuous.

## §1 Workstream map

| ID | Scope | Owner | Root cause / plan |
|---|---|---|---|
| A2 | Recon: 4 parallel survey agents | DONE | findings folded into §0. |
| B | The design-language folder | main | `docs/design-language/`: README, TOKENS, MOTION, COMPONENTS, WIZARD-DNA, WINDOW-CONTROLS, USAGE — the enforceable language layer. |
| C1 | Window controls | main | TitleBar buttons: distinct resting chips, hover identities + motion, the true restore glyph; the semantic hues join the `--ac-*` CSS-var leg. |
| C2 | Chat de-slop | main | The chat surfaces' visual overhaul: type/spacing rhythm, token-only colors, shared primitives, message/tool-call/composer polish. Surgical to the monolith (tests stay green). |
| C3 | Context popup redo | main | Wider (~420px) sectioned layout — proper separation between the header / bar / breakdown / cache / session-table panes — on BOTH legs (DOM popover + menu-overlay window), twins by shared payload. |
| D | Mermaid in chat | subagent | `mermaid@^11` (ADR-0030: v12's elkjs EPL-2.0 excluded; the two v11 spelling gaps via narrow audit overrides); lazy `import("mermaid")`, securityLevel strict, theme-aware, CodeBlock fallback, streaming-safe (complete fences only). |
| E1 | Prompt customization UI | main | REST: GET/PUT/DELETE per-section override routes (the existing `.acute/prompts/` engine + file writer). UI: a Settings "Prompts" tab — section list, editor with live preview + diagnostics + reset. PROMPT-MODULES.md table refreshed. |
| E2 | Always-load skills | main | Migration 0037 `skills.always_load`; file frontmatter `always-load: true`; the prompt composes an ALWAYS-ON SKILLS section with FULL bodies (budgeted, counted); SkillsTab toggle + count guard; the golden fixture re-pinned. |
| E3 | SkillsTab upgrades | main | enable/disable + always-load toggles per row, the composed SKILLS-section preview, usage counts. |
| F1 | Memory improvements | main | MemoryPanel create/edit; the project-memory prompt discipline line; runbook refreshed. |
| F2 | Edit efficiency | main | Per-session file-freshness tracking (path → mtime/size on read/edit); `edit_file` warns on disk-changed-since-read + the FILE EDITING prompt section permits direct edits on files already read this session. |
| F3 | Symbol search + auto-index | main | `search_symbols` tool (exposing searchIndexSymbols); auto-index on session start; incremental reindex after successful writes. |
| G1 | Browser screenshot chain | subagent | DELIVERED (0d9cea2): decoupled from the Computer Use master switch; the vision gate split to the describe leg only; honest refusals (never 1×1). |
| H | Wizard custom providers | subagent | ProviderSelector's "+ Custom OpenAI-compatible…" — the inline create form → POST /providers → the existing flow continues unchanged. |
| I1 | Settings categories | main | Grouped settings nav + the `advanced` tab relabels to "Functionality" with internal categories; deep-link ids stay stable. |
| I2 | Data & Statistics | subagent | Backend: `GET /usage/stats` (12-month per-model day series, totals incl. peak-day, model rollups by NAME, agent-health aggregations) + `DELETE /usage/data`. Frontend: the heatmap / stacked per-model chart / donut / stats grid / clear-data — shared by the Settings tab and the Usage screen. |
| J | Desktop notifications | subagent | `tauri-plugin-notification` (Rust + capability, raw invoke — no npm package); the SSE stream fans task_complete/task_failed/permission_request into OS notifications; the visibility rule; the settings toggle. |
| K | Terminal usability | main | CLI harness verification + discovery-file auto-connection + `usage:stats` + user-facing docs. |
| L | Agent health (the R98 slice) | folded into I2 | The aggregations; the full self-improving loop is the honest R99 roadmap in §7. |
| M | Review pass | subagent | A review agent audits the round's diffs; every finding fixed + pinned before release. |
| N | Docs + release | main | round-98.md completed, CHANGELOG 0.96.0, status.json, HANDOFF, stamps, version ×4, push (EARLY — the reset lesson), CI watch, release verify, DASHBOARD, the ntfy close-out. |

## §2 Verification plan (the round's gates)

- `pnpm lint` + `pnpm typecheck` + the full vitest suites (frontend +
  agent-core + e2e) green before every push; per-workstream focused suites
  as each lands. PUSH AFTER EVERY VERIFIED WORKSTREAM COMMIT.
- The prompt golden fixture re-pinned ONCE after the E2/F2 prompt-section
  changes (byte-diffed, not blindly regenerated).
- docs:check green (stamps refreshed at close per the 3-round rule).
- Browser verification for every UI change (agent-browser screenshots; the
  VLM pass for the surfaces that changed).
- The owner's TEST CHECKLIST (§9) mirrors §0 item for item.

## §3 The delivery log (per workstream)

| WS | Commit | State |
|---|---|---|
| G1 browser screenshots | 0d9cea2 | DELIVERED — decoupled from the Computer Use master switch (the OFF-by-default silent gate); the vision gate split to the describe leg; honest refusals (never the 1×1 capture). +8 pins. |
| B design-language | 3c84dcf | DELIVERED — the 7-file language layer + the DESIGN-SYSTEM §1 link. |
| C1 window controls | f31f559 | DELIVERED — the visible chips + hover identities + the true restore glyph; the semantic hues on the CSS-var leg. |
| C3 context popup | 6451643 | DELIVERED — the 420px sectioned panes on both legs; the session table everywhere. |
| D Mermaid | 9201f1d | DELIVERED — ADR-0030 + the narrow audit pins + the lazy strict theme-aware renderer. |
| H wizard providers | 9201f1d | DELIVERED — the "+ Custom OpenAI-compatible…" inline create flow + the focus-timer fix. |
| I2 Data & Statistics | e2ee4f2 | DELIVERED — the backend aggregate + the five components + the settings tab + the UsageScreen integration. |
| J desktop notifications | e2ee4f2 | DELIVERED — the plugin + the bridge + the SSE fan-out + the settings toggle. |
| E prompts + always-load | 77e81c9 + b1c348b | DELIVERED — the routes/storage + the PromptsTab + the always-load tier (migration 0037) + the SkillsTab pin switches. |
| F2+F3 ledger + indexing | 1010b30 | DELIVERED — the file ledger + the tiered rule (golden re-pinned, the 23K budget held) + search_symbols + the auto-index keeper. |
| I1 settings categories | e2a8396 | DELIVERED — the grouped nav + the Functionality relabel (ids stable). |
| F1 memory | e2a8396 | DELIVERED — add/edit routes + the MemoryPanel flows + the discipline line. |
| K terminal | e2a8396 | DELIVERED — the discovery file + the CLI auto-connect + usage:stats/prompts:sections + the runbook. |
| C2 chat de-slop | 06cda62 | DELIVERED (the surgical pass under the owner's rush directive) — the color slop signals retired to the documented tokens. |
| M review | this commit | The orchestrator's systematic self-review under the rush directive: the hex audit (only the registered exceptions + test fixtures), zero new keyframes, zero console.error additions, all 13 tab ids stable, both full suites green. A full subagent review is queued for R99 (honest — the rush directive traded it). |

## §4 The recovery chapter (the round's defining event)

A sandbox reset mid-round lost EIGHT unpushed commits (the repo re-cloned at
the R97 baseline; the DASHBOARD repo deleted; the helpers reset). The G1
agent's uncommitted work survived (it ran post-reset on the fresh baseline).
Everything else was re-implemented from the orchestrator's retained
knowledge + re-dispatched agents, and pushed per-workstream — the
push-after-every-commit discipline is now binding (recorded in the worklog
as R98-recovery-1/2/3). Three further server shutdowns were absorbed by the
protocol: worktree state is the truth; killed agents leave no worklog but
their diffs land; verify-then-complete-then-commit; connection death ≠
agent death.

## §5 Verification (the final numbers)

- Frontend: 3,651 passed / 12 env-skipped / 0 failed (199 files).
- agent-core: 2,370 / 2,370 (119 files) — the golden prompt re-pinned twice
  (E2 + F2), byte-diffed via the sanctioned UPDATE_GOLDEN procedure.
- Both typechecks, eslint on every touched file, docs:check 213/0/0, the
  license audit clean (247 deps — ADR-0030's two narrow pins).
- cargo check could not run in the sandbox (no Rust toolchain) — the Rust
  side (the notification plugin wiring) verified by config-consistency;
  CI's Rust build is the gate.

## §6 The owner's TEST CHECKLIST (mirrors §0)

1. Hover the three window buttons — each a visible chip; the colors shift +
   motion on hover; maximize→ the true two-squares restore glyph.
2. Click the context donut — the 420px sectioned panes (Overview / Window
   composition / Breakdown / Cache / Session totals table); nothing hidden.
3. Settings → Data & Statistics (and the usage screen): the heatmap, the
   per-model stacked chart, the donut, the health cards, Clear data (with
   the exact enumeration).
4. Settings → Prompts: pick a project, override a section, the live
   preview; save an empty override → the drop warning.
5. Skills → pin "ui-design" (Always load) → the budget readout; the next
   turn's prompt carries its full body.
6. Ask the agent to edit a file it just wrote — no forced re-read; the
   search_symbols tool answers "where is X defined".
7. A mermaid fence in chat renders the diagram (fallback: the note + code).
8. The wizard's "+ Custom OpenAI-compatible…" creates + selects a gateway.
9. Task complete/failed/permission-needed while the window is unfocused →
   the OS notification (toggle in Functionality).
10. The browser screenshot works with Computer Use OFF; a hidden tab
    refuses honestly.
11. Settings → Functionality: the grouped nav + the internal categories.
12. `node scripts/acute.mjs usage:stats` against the running app (the
    discovery file connects automatically).

## §7 The close-out (post-plan additions)

- CI run 34993547873 SUCCESS + Release run 34993551131 SUCCESS on 50a4b24 —
  first try, both.
- v0.96.0 PUBLISHED (release 389300285, draft→false, make_latest: true;
  /releases/latest verified pointing at v0.96.0):
  ACUTE-CODE_0.96.0_x64-setup.exe 38,712,285 B
  (sha256 d5b13f3ce1da4c8bdde6199d6bb4eadf8a2d04d422d3711fb4b594f3a6bc3e00)
  + acute-launcher-kit-v0.96.0.zip 118,952 B
  (sha256 14e05082ac6c527718d41a77dd72a238b77057d672a7f8a75e623d71c5a8bbe1)
  — both digests verified against GitHub's server-side values on freshly
  downloaded bytes; the kit scanned clean (zero real-key values).
- status.json's ci field synced GREEN; DASHBOARD truth-synced (68d7af0 —
  documentation-only per the owner's directive: version 0.96.0, plan.current
  → R98, the milestone, suites 3651/2370, the ciNote).
