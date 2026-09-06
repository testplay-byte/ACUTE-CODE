<!-- last-reviewed: 2026-09-06 round-70 -->
- [ui-iterations/round-70.md](ui-iterations/round-70.md) — the R70 agent brain round (research-driven — the round's own prompt audit + the OSS agent study: the model now knows its world, follows conventions, and verifies before claiming done: env grounding — the real OS/shell/date/git branch+dirty in every turn's prompt, TERMINAL teaches only the real platform's syntax; the AGENTS.md/CLAUDE.md/AGENTS.override/CLAUDE.local convention ladder auto-loads with source markers + @file imports (16K/32K caps); the four overlapping planning sections merged into ONE five-phase loop (registry 23→20 ids); the Codex dirty-worktree rule + verify-after-edit contract + path:line communication; the ACI round — run_command keeps head 32KB AND tail 32KB (errors live at the end), read_file is cat -n + offset/limit, honest no-output messages; file-based skills (.acute/skills + ~/.agents/skills, the Agent-Skills standard, DB-row precedence, 409 refusals) + SEVEN new builtins (incl. project-init — writes the project's AGENTS.md — and browser-use) + STICKY skill bodies (60K budget, no replay stub — loaded instructions survive the task) + agent.skills wired; prompt 22,460→20,156 chars while ADDING all of it)
- [ui-iterations/round-69.md](ui-iterations/round-69.md) — the R69 enforcement layer (the residuals R68's own close-out named: every mutating action returns an OBSERVATION receipt — fresh frame + screenChanged + focusedElementName + activeApp title after a 600 ms settle, returnState compact/none/full; coordinate clicks verify changed/unchanged + hitElementName; the pngjs aHash frame memory + provenance; stale-frame AUTO-refresh (frame_changed carries the already-registered fresh frame — the frame_stale dead-end dies for pointer tools); the screenshot-spam guard (screen_unchanged refuses the 3rd near-identical capture); wait() observable; middle/right element clicks; observation frames inline in the chat; the Windows scroll-math fix (the quadratic over-scroll) + HWHEEL + the stdin clipboard paste for long typing + the dual-object Chromium poke; the NOACTIVATE monitor that never steals focus; the prompt/skill re-teach — pngjs@7 MIT, 134 deps CLEAN)
- [ui-iterations/round-68.md](ui-iterations/round-68.md) — the R68 computer-use overhaul (the 0.67.0 field report: the inline screenshot rows at the capture moment — the strip deleted; the WDA_EXCLUDEFROMCAPTURE monitor invisible to the agent's own captures; the SendInput input-path rewrite + the ARGV ceiling guard; the self-healing foreground + the activate ladder; the Chromium poke making Edge's web tree searchable; the 30 s frames; the vision 429/5xx retry; the prompt/skill/description teaching — web browse confirmed working, untouched)
- [ui-iterations/round-67.md](ui-iterations/round-67.md) — the R67 bridge round (the 0.66.0 field report fixed end-to-end: the instant navigate frame + create-on-adopt, the WebView2 eval double-parse, the chat-session tab binding + per-project cookies, the attachment upload pipeline, the debug card's copy + the full-turn export, the -EncodedCommand capsules + the SendKeys key tool + the monitor turn-holds, the live screenshot thumbnails)
- [ui-iterations/round-66.md](ui-iterations/round-66.md) — the R66 live-fire patch (the 15-action browser page actions + form submission; the owner-solvable bot-wall checkpoint; the instant viewport apply; the vision split + analyze_image; the post-turn context-free debug analyst; the Windows find_elements + 2400 walk; the top-center 460×56 monitor + the decayed live signal; the settings rail)
- [ui-iterations/round-65.md](ui-iterations/round-65.md) — the R65 honesty patch (the SURFACE BOUNDARY prompt lines — embedded browser ≠ real desktop; the browser tab auto-open on agent browsing; debug mode with the execution-report switch; the Advanced cleanup + the search-engine allowlist)
- [ui-iterations/round-64.md](ui-iterations/round-64.md) — the R64 capability round (the Windows computer-use fixes: JSON array collapse + EnumWindows + tiered app resolution; the always-on-top floating monitor; the chat polish backlog; per-key usage + the BPE-style estimator)
- [ui-iterations/round-63.md](ui-iterations/round-63.md) — the R63 desktop-update round (release-tag gap closed + the launcher's version-truth chain: registry · exe · engine, uninstall/reinstall, sha256-verified downloads)
- [ui-iterations/round-62.md](ui-iterations/round-62.md) — the R62 owner-feedback round (sidebar rail, layout, browser truth + agent-browser)
# ACUTE-CODE — Documentation Index

One line per document. **Reading order for a new session:** `HANDOFF.md` →
`docs/runbooks/WORKFLOW.md` → `docs/runbooks/AGENT-MEMORY.md` → the runbook
for the task at hand. Generated files are marked; everything else is
hand-maintained. If a doc contradicts the code, the code wins for facts —
file the discrepancy and fix the doc in the same round.

## Process & memory
- [`runbooks/WORKFLOW.md`](runbooks/WORKFLOW.md) — **the session spine**: start ritual, branch policy, verification gates, per-round documentation duties, push/CI/ntfy checklist
- [`runbooks/MAINTENANCE.md`](runbooks/MAINTENANCE.md) — **how to find things and change things safely**: architecture map + how-to-add-tool/migration/settings-tab/sidebar-tab/route/screen recipes + the golden rules (R44)
- [`runbooks/ROADMAP.md`](runbooks/ROADMAP.md) — milestones per pillar with status (`done / in-flight / queued / owner-gated`); the single place HANDOFF §9 points to
- [`runbooks/TESTING.md`](runbooks/TESTING.md) — the five verification layers, the fresh-DB rule, live-battery and browser-verification recipes
- [`runbooks/SECURITY.md`](runbooks/SECURITY.md) — security posture: bearer/loopback, tool path containment, secrets custody per surface, launcher redaction, the R45 child-env/auto-tier/web-gate controls, known gaps
- [`runbooks/AGENT-MEMORY.md`](runbooks/AGENT-MEMORY.md) — numbered lessons (mistake → root cause → rule); read before any session; append-only
- [`runbooks/PROJECT-MEMORY.md`](runbooks/PROJECT-MEMORY.md) — the R44 agent memory SYSTEM reference (table, tools, digest injection, Memory tab, verification pattern; relevance-ranked recall/digest + dedup-on-save since R46) — distinct from the lessons file above
- [`agent/ORCHESTRATION-WORKLOG.md`](agent/ORCHESTRATION-WORKLOG.md) — session-by-session history (snapshot of the live worklog, refreshed each session)
- [`runbooks/SANDBOX-RESTORE.md`](runbooks/SANDBOX-RESTORE.md) — zero-to-resumed procedure after a sandbox wipe + the session-end backup rule
- [`runbooks/AGENT-BOOTSTRAP-PROMPT.md`](runbooks/AGENT-BOOTSTRAP-PROMPT.md) — the paste-once prompt to bootstrap a fresh agent
- [`runbooks/LOCAL-PC-RUNNER.md`](runbooks/LOCAL-PC-RUNNER.md) — the owner's one-double-click launcher (credentials template is a clean paste zone since R47 — no key material ships with it)
- [`runbooks/PUBLIC-DASHBOARD.md`](runbooks/PUBLIC-DASHBOARD.md) — the public status dashboard (separate repo), its allow/deny lists and publish flow
- [`runbooks/COMPUTER-USE.md`](runbooks/COMPUTER-USE.md) — **the desktop-control system (R61, R66/R67/R68/R69-patched, R70-adjacent)**: setup per platform, the settings gates (master switch / postures / readiness — the vision model moved to its own section), the big-apps find_elements workflow + the R66 Windows walk + the R68 Chromium poke (Edge's web tree searchable), the R67 key-tool table (R68: SendInput, the win key works) + the Tab-walk readback + the monitor turn-holds, the R68 foreground self-heal + activate ladder + 30 s frames + ARGV ceiling + vision retry, the R69 enforcement layer (observation receipts + returnState + click verification + frame_changed/screen_unchanged + the aHash frame memory + element middle/right clicks), the top-center 460×56 monitor (R68: invisible to captures; R69: never steals focus) + STOP + the decayed live signal, the safety contract, the refusal catalog, the 31-tool reference, the R70 note (the engine untouched — the prompt section points at the sticky skill body; env grounding + verify-before-done discipline), and the LIVE-VERIFICATION CHECKLIST (the backends are not yet live-verified)
- [`runbooks/EMBEDDED-BROWSER.md`](runbooks/EMBEDDED-BROWSER.md) — **the in-app browser panel (R66/R67)**: the 15-action `browser_control` surface (which actions need the native bridge), the R67 binding model (one chat session, one tab + per-project cookies), the instant navigate frame + the WebView2 eval decoder, the form-submission discipline, the bot-wall checkpoint protocol (detect → the countdown card → REST resolve → the honest re-probe), the instant viewport apply, and read_dom/source — the page without screenshots
- [`runbooks/DEBUG-MODE.md`](runbooks/DEBUG-MODE.md) — **the post-turn context-free debug analyst (R66/R67/R68)**: the C1 contract (no self-report), the flow (turn → debug-start → live deltas → persisted `debug.report` → done), what the analyst receives, the isolation guarantees (follow-ups never see it), the R67 card copy + auto-collapse + the debug-gated full-turn copy, the R68 inline screenshot capture rows + their export marker, the switch, and the honest limitations
- [`runbooks/ATTACHMENTS.md`](runbooks/ATTACHMENTS.md) — **the chat attachment pipeline (R67)**: the four composer sources (drop / paste / OS picker / @ mention), the `POST /attachments/upload` contract (modes, caps, dedupe-never-overwrite), the model-facing analyze_image path contract, the picker's 512 KB caveat, and the ephemeral live-screenshot rasters (the separate registry + route + TTL — consumed by the chat's R68 INLINE capture rows)
- [`runbooks/EXTENSIBILITY.md`](runbooks/EXTENSIBILITY.md) — **the four extension surfaces (R61, + the R66 + R70 addenda)**: external .mjs plugins, skills (SKILL.md-style, progressive disclosure — DB rows AND files on disk since R70: .acute/skills + ~/.agents/skills, 8 builtins, sticky bodies, the agent.skills allowlist), MCP servers (stdio JSON-RPC, sanitized env), and the built-in plugin catalog — with working examples of each

## Requirements & architecture
- [`specs/SPEC.md`](specs/SPEC.md) — master requirements (F1–F11), owner-approved
- [`architecture/ARCHITECTURE.md`](architecture/ARCHITECTURE.md) — system design truth (topology, lifecycles, key hand-off) — *partially historical; see IMPLEMENTED-API for the shipped surface*
- [`architecture/api/IMPLEMENTED-API.md`](architecture/api/IMPLEMENTED-API.md) — **the REST + SSE surface as actually shipped** (verified against code; each round's additions are sections — R61 computer-use/skills/MCP/plugins routes + the `computer-use` SSE frame, R62 the browser-command bridge, R65 the debug switch + browser auto-open, R66 the checkpoint resolve + `/vision` routes + the new SSE frames + `debug.report` + `analyze_image`, R67 the attachments upload + browser bind + frames raster routes, the navigate/open/screenshot frames, and the binding-scoped browser_control semantics, R68 the screenshot frame's inline consumer contract + the computer-use receipt/refusal payload updates, R69 the observation-receipt payloads + the new emitters/refusal codes, R70 the skills merged listing + file-skill 409s + read_skill gating + read_file's offset/limit params)
- [`architecture/api/API.md`](architecture/api/API.md) — the full 52-operation *planned* contract (aspirational since Phase 1; WS/planned routes live here, NOT in IMPLEMENTED-API)
- [`architecture/PROJECT-MAP.md`](architecture/PROJECT-MAP.md) — the product map & naming rules
- [`architecture/PILLARS.md`](architecture/PILLARS.md) — the three-pillar blueprint (coding / agentic system / automation) and how they interconnect additively
- [`decisions/`](decisions/) — ADRs 0001–0021 + `TEMPLATE.md`; sequential, never renumbered; next = 0022

## Design
- [`design/ui-direction.md`](design/ui-direction.md) — the owner's design language, derived from his demos
- [`design/DESIGN-SYSTEM.md`](design/DESIGN-SYSTEM.md) — living UI reference: tokens, spacing, borderless chat language, motion, anatomy, new-screen checklist
- `design/demos/` — the owner's original demos (frozen reference; never imported by product code)

## UI iteration rounds
- [`ui-iterations/README.md`](ui-iterations/README.md) — the round method + per-screen status board (owner directive 2026-08-22)
- `ui-iterations/round-NN.md` + `assets/round-NN/` — one file per owner review round with screenshots and verification evidence

## Plans & reviews (historical once the phase closes)
- `runbooks/plan-phase-0/1/2/3.md`, `plan-ui-fidelity.md`, `plan-agentic-mvp.md` — intent documents
- `runbooks/review-phase-1.md`, `review-phase-2.md` — phase close-out reports
- `runbooks/SETUP.md` — Phase-0 environment snapshot (current environment facts live in HANDOFF §8 + SANDBOX-RESTORE)
- `runbooks/DEMO.md` — demo script

## Research
- [`research/README.md`](research/README.md) — index + synthesis of the 10 reference analyses (incl. n8n for the automation pillar)
- `research/<project>/` — per project: `README.md` + `architecture.md` + `patterns-for-acute-code.md`

## Status & compliance
- [`status.json`](status.json) — hand-maintained input for the public dashboard (schema `acute-status/1`)
- [`compliance/dependency-licenses.md`](compliance/dependency-licenses.md) — **generated** by `pnpm license:audit`; never hand-edit

## Folder-structure rules (binding)
1. SQL lives only in `agent-core/src/storage/`; migrations in `src/storage/migrations/` are numbered and append-only (never edit an applied migration).
2. Unit tests: `agent-core/tests/*.test.ts` (AI SDK mocked — never live calls) and frontend suites in `src/`. Black-box E2E: `tests/e2e/` (runs against built dist).
3. `shared/` holds canonical domain types; product code conforms, never duplicates.
4. ADRs: `docs/decisions/NNN-kebab-slug.md`, zero-padded, strictly sequential, via `TEMPLATE.md`.
5. Rounds: `docs/ui-iterations/round-NN.md` (next free number; session number ≠ file number — record the mapping inside the file); screenshots in `assets/round-NN/`.
6. Research: one folder per project, always the README/architecture/patterns trio; indexed in `research/README.md`.
7. `design/demos/` is frozen owner reference — lint-excluded, never imported.
8. Scripts: repo tooling in `scripts/` (stdout = data, stderr = diagnostics). `launcher/` is owner-facing; `.bat` files must be CRLF-verified and tiny coordinators only.
9. Generated files are marked and never hand-edited.
10. Nothing secret in the repo, ever; `.dev/` DBs and `.env*` are gitignored; `.env.development` is deleted before any verify/commit.
