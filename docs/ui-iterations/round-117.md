<!-- last-reviewed: 2026-09-21 round-117 -->

# Round 117 — the system round (memory that remembers, prompts re-engineered, robust orchestration, an honest transcript)

The owner tested v0.110.0, is satisfied at first sight, and directed the next round at the
SYSTEM: prompts ("proper prompt engineering"), communication logics, multi-agent workflows,
memory ("the memory functionality apparently does not work"), error handling/prevention/
management, the PC chat window's rendering quality — plus a proper-design-skill pass on the
Android UI. He will test the Android app himself in parallel; our changes ride main toward
v0.111.0.

Four parallel deep analyses (prompts, memory, multi-agent+errors, PC transcript) produced
the root causes below. This round is BUILT ON THEM.

## §1 The proven root causes

### Memory (the owner's #1 complaint — "apparently does not work")

1. **Memory formation is voluntary.** The ONLY writers are the model's own `memory_save`
   call and the owner's REST edits. No turn-end auto-capture, no session-end summary
   persistence. If the model doesn't save, every new session starts from zero (round-98
   diagnosed this exact complaint and the root cause still stands).
2. **`agents.memory_policy` is a DEAD FLAG** — stored/validated/editable in the Agents UI,
   never read by the runtime (grep: zero consumers in agents/**). An agent set to `none`
   still gets memories injected.
3. **Workspace memory and system memory were never built** — SPEC §F8/ARCHITECTURE/API.md
   document a Hermes-style per-agent markdown memory (incl. phantom REST endpoints) that
   has zero code. Only project-scoped memory exists.
4. **CLI sessions are projectless** → memory tools hard-fail ("memory is project-scoped")
   and no digest. The CLI surface has zero memory.
5. **The digest is a 1,500-char slice**; older memories are dark unless the model
   volunteers a recall. No episodic memory exists at all (past sessions are searchable in
   the UI only — no model-facing tool).
6. **A prompt override silently kills live memory injection** (empty override drops the
   section) and the Settings→Prompts preview reports "Project memory — absent" even for
   memory-rich projects.

### Prompts (the audit's verdict: "top-quartile system, calibration + hygiene issues")

7. **~15 round-tags leak into model-facing text** ("(round-33)", "(R67)"…) — token waste +
   noise; **FILE EDITING RULES numbering skips 7** (a retired rule kept its number);
   **~100 caps-emphasis tokens flatten salience**; numbers that read as targets ("up to 80
   round-trips"); audience-mixed lines written for the human inspector, not the model.
8. **The sub-agent brief forces ceremony on trivial tasks** (todo_write-first even for a
   single lookup) and pays the full 24K prompt for every role; the browser_control tool
   description is ~7.7K chars in one paragraph.
9. **Volatile injections sit bare in the system message** (memory digest, todos,
   background tasks) — no data-vs-instruction fence like the `<tool_results>` guard.

### Multi-agent + error handling

10. **No orchestration-level retry** — a stalled/failed child is terminal unless the model
    chooses `resume` or the owner clicks Retry; no parent→child guidance channel; results
    return as a report STRING only.
11. **Mobile is a second-class multi-agent citizen** — no `subagent-event` handling, no
    Stop/Retry on the mobile SubAgentCard; the mobile ErrorCard has no Retry/Copy (the
    PC's TurnErrorCard is far richer).
12. **Silent-failure vectors**: no process-level `uncaughtException`/`unhandledRejection`
    handler (a stray throw kills the sidecar); an external-plugin tool that throws fails
    the WHOLE turn as a provider error (`tools/index.ts:205` doesn't wrap execute); a tool
    result missing `ok` defaults to SUCCESS; `res.write` on the events route is unguarded;
    message content has NO length cap; notification-bus failures never reach the
    diagnostics ring.

### The PC transcript

13. **Failed tool calls are nearly invisible**: a 12px red glyph on an identical row — and
    the folded section header shows a GREEN ✓ "Completed N steps" even when tools failed
    inside it. No danger tint, no inline error excerpt.
14. **No delivery status on user messages** (mobile's R116-m ticks absent); **no image
    thumbnails** (mono chips); **headings render at body size** (13px — answers lose
    hierarchy); **the thinking placeholder is plain text**; **no memoization** — the whole
    transcript re-renders + re-parses markdown on every SSE delta; tool args render as
    raw server strings; terminal output shows 3 lines with no exit-code emphasis.

### Android UI (the owner's emphatic close: "the ui is very bad")

15. The round-116 work was STRUCTURAL (laws, mechanics, layouts). The visual design
    quality itself — color richness, depth, typography rhythm, component polish — has
    never had a professional design pass. This round gets one (the frontend-styling-expert
    reviews the whole design system + every screen class and produces an elevation of the
    clay language, then implementation waves).

## §2 The wave plan

- **R117-a** (this doc): the constitution for the round.
- **R117-b — MEMORY THAT REMEMBERS** (the round's heart): automatic memory formation
  (turn-end durable-fact capture + compaction summaries persisted as memory), the
  memory_policy flag WIRED (none/on-start/every-turn semantics real), WORKSPACE memory
  (a global scope — cross-project facts — via nullable project_id + the scope ladder in
  the digest), a `session_recall` tool (episodic memory over searchSessions), CLI
  `--project` binding, digest budget scaling + the honest empty state, the Prompts
  preview + override-warning fixes, and doc honesty (the never-built Hermes memory marked
  as roadmap, not reality). Tests for every leg.
- **R117-c — THE PROMPT-ENGINEERING PASS**: strip round-tags + audience-mixed lines from
  all model-facing text; renumber FILE EDITING RULES; the caps-calibration (soft-shout →
  prose, hard rules keep NEVER/ALWAYS); budget numbers → one BUDGETS line; the sub-agent
  triviality carve-out + role-conditioned section trimming; browser_control restructured
  (policy head + schema-resident detail); `<project_memory>`/`<todo_list>`/
  `<background_tasks>` fences; a fresh current-tools golden. Golden re-pins documented.
- **R117-d — ROBUST ORCHESTRATION**: the orchestration retry policy (bounded auto
  re-delegation for stall/transient classes — configurable, off by default? ON with sane
  defaults), a parent→child `guidance` tool, a structured result envelope (files touched/
  usage machine-readable alongside the report), mobile parity (subagent-event frames +
  Stop/Retry on the SubAgentCard, Retry/Copy on the ErrorCard).
- **R117-e — ERROR HARDENING**: process-level handlers (ring + sidecar.log + clean exit),
  the tool-execute wrapper (one broken tool can never kill a turn), missing-`ok` →
  explicit failure classification, the events res.write guard, message content caps
  (honest limits + errors), notification-bus → diagnostics ring.
- **R117-f — THE PC TRANSCRIPT**: failure visibility (danger-tinted failed rows + the
  folded header's failure-aware amber state — the green-✓ bug), delivery ticks on user
  messages, image thumbnails, heading hierarchy restored (h1/h2/h3 a real ladder), the
  breathing thinking placeholder + settled clamp/Show-all, per-tool humanized args,
  terminal exit-code emphasis + copy, memoization (MessageRenderer memo + ChatMarkdown
  parse memo) to kill the per-delta re-render, wire-or-delete the dead entry-renderers
  registry.
- **R117-g — THE ANDROID DESIGN PASS**: the frontend-styling-expert reviews the design
  system (tokens/theme/primitives) + every screen archetype against professional
  standards and produces the elevation spec (color harmony/depth/typography rhythm/
  component richness within the clay language); then implementation waves apply it. The
  owner is testing v0.110.0 separately — our changes land on main for v0.111.0.
- **R117-h — SANDBOX E2E VERIFICATION** (the owner's explicit ask — "test it out by
  yourself in your own virtual sandbox environment by installing the one iterating in
  it"): run the REAL sidecar in this sandbox with a live OpenRouter key, drive real
  sessions end-to-end (create agent/project/session, send tasks, watch tools/memory/
  delegation behave, verify the new memory formation + prompts against a real model),
  iterate until the experience is right. Evidence goes in the round doc.
- **R117-i — docs truth-sync + release v0.111.0** (the full guard chain).

## §3 Verification

Per wave: the touched workspace's gates (agent-core: tsc + vitest 2618+additions; root:
tsc + vitest; PC: vitest suites; mobile where touched) + secret scans. R117-h adds REAL
end-to-end runs. The release rides MAINTENANCE §g 2c/4-5/6-6b verbatim.

## §4 Deferred (unchanged unless the owner re-raises)

The updater round (Linux same-version restart + Windows automation + incremental
updates — the §4 note in round-116.md), multi-PC from the phone, device smoke pass,
attachment image bytes, the browser save-download affordance.

## §5 The sandbox E2E (R117-h — the owner's explicit ask, verified live)

The sidecar was built (dist), started with a LIVE OpenRouter key, and driven
end-to-end (the runs live in /tmp/acute-e2e/):

1. **The workspace tier is LIVE on the real server** — POST /memory/workspace
   returned `scope:"workspace", projectId:null`; the panel's list reads it back.
2. **THE MEMORY ROUND-TRIP (the money proof)**: seeded 1 workspace memory ("the
   owner prefers concise replies and vitest") + 1 project memory ("uses pnpm and
   TypeScript strict"), then ran a REAL turn (z-ai/glm-5.2:free via OpenRouter,
   646 thinking-deltas streamed). The model's reply:
   *"Workspace memory: you prefer concise replies and vitest. Project memory:
   this project uses pnpm and TypeScript strict. I've saved that round-117 E2E
   passed."* — it RECITED both scopes' digests verbatim (the composed injection
   works against the live provider) AND called memory_save with exactly the
   requested fact (the row landed, `src=agent`, kind fact, the tool's result
   frame honest: "saved fact memory (id mem_…); it persists across sessions and
   is auto-loaded into future turns").
3. The default agent's `memoryPolicy` reads `every-turn` on the live wire (the
   dead flag is alive); turn.started carried model+provider; the SSE stream
   carried the full frame vocabulary (thinking-delta/text-delta/tool-call/
   tool-input-delta/tool-result/finish/done).

Environment notes for future E2E rounds: the sandbox reaps background processes
between tool invocations — run the sidecar + the whole driver INSIDE one bash
invocation (start → READY-parse → curl sequence → kill); session POST requires
agentId (no default configured on a fresh DB); project/session responses are
top-level shapes (not wrapped).

## §6 The v0.111.0 release (R117-i — shipped and end-state verified)

Tag `v0.111.0` at `46abe94` (the release commit `0e53dac` + the CI fix for the events
route's `prefer-const` finding — semantics byte-identical, the write-guard tests green).
Both tag workflows ran green: `Release` run `35681866610` (launcher-kit + the Windows
installer + the two AppImages + the two debs) and `Mobile APK` run `35681866598`
(the APK attach) — plus the post-fix main CI (`35680496217` / `35680496204`, both
success). The §g 2c lock-sync proof passed before tagging (`npm ci --dry-run` clean —
no mobile deps changed this round, a two-field version diff only).

Draft `393431111` carried all 7 assets, then was PUBLISHED (PATCH `draft:false`,
`make_latest:"true"`, body = the CHANGELOG's 0.111.0 section, no
`target_commitish` — the §g 6 procedure). End-state verified per §g 6b:

- `/releases/latest` answers `v0.111.0` — **both authenticated and unauthenticated**
  (the public check is the honest one).
- 7/7 assets on the published page: the 6 desktop ones (AppImages 134,322,696 /
  136,595,960 B, debs 68,428,972 / 68,373,060 B, x64-setup.exe 39,342,490 B,
  launcher-kit 143,876 B) plus `ACUTE-CODE_0.111.0_android-arm64.apk` 56,768,425 B.
- **APK content check (downloaded via the API, full zip central-directory pass)**:
  1240 entries; `assets/index.android.bundle` present with the Hermes bytecode magic
  `c6 1f bc 03` at its head; 3 dex files; `lib/` contains **arm64-v8a only**; gradle
  app-metadata present. Exact size match against the API-reported asset size.

No stale drafts remain (the sweep: every prior release is published). The round is
shipped.
