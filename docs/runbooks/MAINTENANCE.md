<!-- last-reviewed: 2026-08-30 round-50 -->
# MAINTENANCE — how to find things and change things safely

**Status:** normative · **Established:** round-44 (owner directive: "complete the
whole agentic coding environment completely now… documentation +
maintainability") · **Audience:** any future agent (or the owner) touching this
repo for the first time

One page, kept current: where the moving parts live, and the shortest safe path
for the six most common changes. Every recipe names a REAL example file to copy
from — trust those over memory. If this file and the code disagree, the code
wins; fix this file in the same round.

## Architecture map (one screenful)

```
launcher/            owner's one-click entry (ACUTE.bat → acute_launcher.py:
                     reads credentials.txt, clones/updates this private repo,
                     corepack-pins pnpm, installs, builds shared+agent-core,
                     injects provider keys as env, runs `pnpm dev:full`,
                     auto-opens the browser; self-updates itself from the repo)
  └─ src/            React 18 + Vite UI (dev :5173) — all screens, panels,
     |               stores; talks to the sidecar over HTTP + SSE, never SQL.
     |               src/lib/api.ts is THE canonical HTTP layer — since R47
     |               it owns the whole provider surface (CRUD + key + slot/
     |               model-scoped testProviderConnection + fetchModels
     |               Catalog + models-config CRUD); no component keeps its
     |               own fetch plumbing. src/lib/key-pool.ts (R47): pure
     |               nextFreeSlot(heldSlots, 2, 31) for the key-pool UI
     |               (the slots.length+2 collision fix). src/lib/stream-
     |               store.ts (R48): the live-turn SSE consumer — incl. the
     |               sub-agent live map (childId → code/role/task/status/
     |               lastActivity from subagent-status frames) + routing of
     |               subagent-event inner approval.* frames into the
     |               parent's approvals queue (with subAgentId); R50 ALSO
     |               accumulates each child's LIVE RAW stream (liveText/
     |               liveThinking/liveSteps + token accumulators from inner
     |               finish frames) for the SubAgentPanel live view + stats
     |               footer. src/lib/native-browser.ts (R50): the typed
     |               Tauri bridge for the NATIVE embedded browser
     |               (browser_tab_* invokes + the browser-navigated event
     |               listener) — no-ops outside the desktop shell.
     |               src/components/project-chat/composer/ (R50): the chat
     |               composer family (12 files) — Add Context (file picker/
     |               project files/@-mentions/drag-drop attachments), mode
     |               switcher, thinking level, provider-flyout model picker,
     |               context donut; per-session localStorage persistence for
     |               the model + thinking choices.
  └─ agent-core/     Node/TS Fastify sidecar (dev 127.0.0.1:5178) — the ONLY
     |               process that touches SQLite; routes in src/server.ts
     |               (incl. the terminal routes: one-shot stream + the
     |               persistent terminal-session family backed by
     |               src/terminal-sessions.ts), tools in src/tools/, SQL in
     |               src/storage/ (incl. the browser cookie jar,
     |               storage/browser-cookies.ts, since R46), turn runtime +
     |               prompts + CONTEXT COMPACTION (agents/compaction.ts,
     |               R46 — over-budget history is model-summarized into a
     |               `context.compact` session event instead of hard-dropped)
     |               in src/agents/, browser proxy in src/browser-proxy.ts
     |               (R48: SessionStore.getOrCreate — tickets rotate ONLY at
     |               POST /browser/session; navigate/viewport/adopt are
     |               non-rotating), sub-agent orchestration in src/agents/
     |               orchestrator.ts (R48: children with an emit channel are
     |               interactive — approvals ride the parent's SSE as
     |               subagent-event envelopes; subAgentCode() in src/storage/
     |               sessions.ts = deterministic 4-char [A-Z0-9] child code,
     |               same value on SSE frames + /subagents rows), native
     |               dialogs in src/dialogs.ts (R48: modern IFileOpenDialog
     |               COM primary via C# interop → classic FolderBrowserDialog
     |               fallback → legacy; EVERY dialog owned by a topmost form;
     |               `ERROR:` result line when all pickers fail; R50 adds the
     |               multi-FILE picker — OpenFileDialog Multiselect under the
     |               same topmost-owner pattern). R50 in src/agents/: runtime
     |               sessionToolAllowList (permission-mode enforcement —
     |               shared by prepareTurn + the context route), chat.ts
     |               maxRetries:4 + buildThinkingFetch (reasoning.effort
     |               injection) + cachedInputTokens capture (inputTokenDetails
     |               .cacheReadTokens → usage_events.cached_input_tokens,
     |               migration 0020), prompts.ts buildSystemPromptSections
     |               (identity/tools/memory/meta split for the context donut),
     |               orchestrator children run the STREAMED path when a
     |               channel exists (chatStream rides toolDeps).
  └─ src-tauri/      Rust Tauri 2 shell — sidecar lifecycle (token mint, spawn,
     |               health poll, shutdown), Credential-Manager key injection.
     |               No cargo in the sandbox; CI is the only Rust oracle (ADR-0012).
     |               R48: pick_folder parents rfd to the main webview window
     |               (compile-verified by CI's cargo check; runtime = owner's
     |               re-test). R50: browser.rs hosts the NATIVE embedded
     |               browser — one child webview per browser tab via
     |               Window::add_child (tauri features=["unstable"]; async
     |               browser_tab_create dodges the WebView2 sync-command
     |               deadlock; shared browser-profile dir); pick_files is the
     |               composer's multi-file picker.
  └─ shared/         canonical domain types both TS packages import
```

- **Transport:** REST + SSE on the sidecar port; every route except
  `GET /health` requires `Authorization: Bearer <token>` (dev token
  `acute-dev-local`). Errors use the `errorBody(code, message, details)`
  envelope — see `agent-core/src/server.ts`.
- **State:** SQLite (WAL) at `.dev/acute.db` in dev (`ACUTE_DB_PATH`).
  Numbered SQL migrations in `agent-core/src/storage/migrations/` run
  automatically on boot, one transaction per file, tracked in
  `schema_migrations`. There is no other durable state.
- **Launcher flow (owner's PC):** `ACUTE.bat` → python launcher → repo update →
  `pnpm dev:full` (sidecar + vite). The launcher SELF-UPDATES from the repo, so
  a changed `acute_launcher.py` reaches the owner without a re-download — but
  `ACUTE.bat`/`acute.sh`/`credentials.txt` are owner-owned (golden rule 1).

## How to add… (recipes — copy the named example)

### a) A new agent tool

Freshest full example: the R44 memory tools.

1. Implement in `agent-core/src/tools/memory.ts` style: export a tool object
   with `description` + `jsonSchema` input schema + `execute` returning
   `{ok, output}`; degrade gracefully (ok:false with a readable reason) when
   deps/project are absent — see `todo_write` for the no-deps pattern.
2. Register inside `buildProjectTools` (`agent-core/src/tools/index.ts`) in the
   base tools record — the per-agent allowlist filter applies automatically.
3. **Append the tool name to `TOOL_NAMES`** in `agent-core/src/storage/agents.ts`
   (fresh seeds + server-side allowlist validation both read it) — and to
   `TOOL_CATALOG` in `src/lib/api.ts` (the agent-dialog checkboxes). This
   backend↔frontend lockstep was manual (and lapsed 15-vs-21 at R44) until
   R45: `src/lib/tool-catalog-drift.test.ts` now reads `TOOL_NAMES` as text
   and FAILS the build with both lists + the files to edit on any drift —
   the manual note is now an automated guard.
4. **NNNN migration appending the tool to EXISTING databases' template-agent
   `allowed_tools`** — copy the `json_insert … WHERE (is_template = 1 OR
   id = 'agt_default_nova')` + `NOT EXISTS json_each` idempotence shape from
   `agent-core/src/storage/migrations/0015_memory.sql` (0014 is the two-tool
   variant).
5. Tests in `agent-core/tests/memory-tools.test.ts` style (execute through the
   REAL `buildProjectTools`, not a stub).

**The delegate_task lesson (R43, golden rule 7):** a tool that exists but is
missing from `TOOL_NAMES`/the migration is UNREACHABLE from every seeded agent —
the owner's DB never learns it, silently. Steps 3 and 4 are not optional.

### b) A new SQLite migration

Example: `agent-core/src/storage/migrations/0015_memory.sql`; R49's
`0019_repair_default_agent_tools.sql` is the newest (data-only REPAIR +
audit row — no schema change; it resets the default agent's allowlist to
`[]` when it exactly matches the fingerprint migrations 0014+0015 could
produce from an empty array — see AGENT-MEMORY lesson #68 for why
append-onto-a-sentinel migrations need exactly this repair pattern and a
test that builds the database the OLD way).

1. Next 4-digit number, `NNNN_kebab.sql`; `agent-core/src/storage/db.ts`
   discovers files matching `^(\d{4})_.+\.sql$` on boot and applies unseen ones
   in order (one transaction each, recorded in `schema_migrations`).
2. Idempotent by construction: `CREATE TABLE`/`IF NOT EXISTS`-style guards; for
   allowlist appends use `NOT EXISTS (SELECT 1 FROM json_each(...))`.
3. End with an `audit_log` INSERT (actor `"migration-NNNN"`) — the 0013/0014/
   0015 pattern — so schema changes are auditable after the fact.
4. Add a migration test: hand-apply prior migrations to a fresh DB, reopen,
   assert the new behavior + the audit row + idempotent re-open
   (`agent-core/tests/memory-tools.test.ts` bottom, `storage.test.ts`).

### c) A new settings section

Example: Sub-agents (`src/pages/SettingsPage.tsx` + SubAgentsTab). A
settings CARD (no new tab) has a fresher example: R49's MemoryCard in the
Advanced tab — `getMemorySettings`/`setMemorySettings` in
`agent-core/src/storage/settings.ts`, `GET`/`PUT /api/v1/settings/memory`
in `server.ts`, `fetch/updateMemorySettings` in `src/lib/api.ts`, the
`role="switch"` toggle + query invalidation in SettingsPage.tsx, and the
consumer-side notice in MemoryPanel.tsx — the full vertical slice in one
commit.

1. Add the tab to `TABS` in `src/pages/SettingsPage.tsx` (id → `?tab=` deep link).
2. **Also add it to `SETTINGS_SECTIONS` in `src/components/shell/Sidebar.tsx`**
   — the sidebar IS the settings nav (R34 design).
3. The R44 VLM-pass bug: the R43 Sub-agents tab existed in TABS but not in the
   sidebar list, so it was unreachable except by hand-typing `?tab=subagents`.
   Both lists, always.

### d) A new right-sidebar tab

Freshest examples: Files explorer (R48, `src/components/right-sidebar/
FilesExplorerPanel.tsx` — the singleton-tab + quick-menu + panel-switch
wiring end-to-end) and Memory (R44).

1. Add the type to `RightSidebarTabType` + an `openX(projectId)` action in
   `src/lib/right-sidebar-store.ts` (singleton-tab dedupe like `openMemory`/
   `openFiles`; note R48: addTab returns the ACTIVATED tab's id on the dedupe
   path — rely on it).
2. QuickMenu entry + icon in `src/components/right-sidebar/RightSidebar.tsx`
   (the `items` array in the QuickMenu component) + the
   `<Panel projectId…/>` render branch.
3. Panel component in `src/components/right-sidebar/MemoryPanel.tsx` style
   (TanStack Query polling, grouped cards, hover-revealed actions, sibling
   visual language: radius 12, hairline borders, small-caps chips). The R48
   FilesExplorerPanel is the two-pane-with-own-scroll reference.
4. Component test next to it (`MemoryPanel.test.tsx`, or the R48 trio
   `RightSidebar.test.tsx` + `FilesExplorerPanel.test.tsx` +
   `right-sidebar-store.test.ts` — the full stack: menu → tab → panel).

**Sub-agent tabs are NOT this pattern** — they are multi-instance (one tab
   per child, id-addressed, code-prefixed title); see SubAgentPanel +
   `openSubAgent` in RightSidebar (R48) for that variant.

### e) A new API route

Example: `agent-core/src/server.ts` ROUND-44 blocks (memory, fork/revert,
terminal stream).

1. Add inside the single `/api/v1` scope plugin in `server.ts`, in the matching
   resource section (projects / sessions / providers / agents), with a
   `── ROUND-NN (why): ──` comment header — the file is organized by scope
   sections; keep neighbors together.
2. Validate inputs → `errorBody("CODE", message, {field})` with the right
   status (400 VALIDATION / 404 NOT_FOUND / 409 CONFLICT); the bearer wall at
   app level covers auth automatically (nested scopes need their own
   onRequest guard — see the browser-proxy encapsulation lesson, R43).
3. Client function in `src/lib/api.ts` near its siblings.
4. **Update `docs/architecture/api/IMPLEMENTED-API.md` in the same round** —
   that file is the shipped-surface truth and `docs:check` will not remind you.

### f) A new UI screen/route

Example: SessionsScreen / DemoViewerScreen.

1. Route in `src/App.tsx` (`<Route path=…>` under the shell layout).
2. Entry point in `src/components/shell/Sidebar.tsx` (nav section or project
   row); if the screen should not be a route at all, prefer a right-sidebar
   tab (recipe d).
3. Query hooks in `src/hooks/use-sessions.ts` style; tests colocated
   (`src/**/*.test.tsx`).

## Testing conventions

- **Where:** `agent-core/tests/` (backend, AI SDK always mocked — never live
  calls), `src/**/*.test.ts(x)` (frontend), `tests/e2e/` (black-box sidecar
  e2e vs the BUILT dist — rebuild `agent-core/dist` first).
- **Commands:** `pnpm test` (all unit/integration), `pnpm test:e2e`,
  `pnpm verify` (= lint + typecheck + test + build + e2e + license audit = CI).
- **Green before commit, seen with your own eyes** — and after every push,
  watch the GitHub Actions run to actual success (golden rule 3).
- Live battery + browser/VLM verification rules live in
  [`TESTING.md`](TESTING.md); the round process in [`WORKFLOW.md`](WORKFLOW.md).

## Golden rules (violating these has burned us before)

1. **NEVER edit** `acute.bat` / `acute.sh` / `credentials.txt`. If
   `acute_launcher.py` absolutely must change, flag it in the round report —
   the launcher self-updates, `ACUTE.bat` does not.
2. Append to `/home/z/my-project/worklog.md` (sandbox); the canonical snapshot
   is `docs/agent/ORCHESTRATION-WORKLOG.md` in-repo.
3. After every push: **WATCH the GitHub Actions run to actual SUCCESS** (query
   the API, poll to conclusion). R39–R42 shipped red because nobody watched.
4. The `branches: ain]` "YAML rot" seen in Bash output was a **display
   artifact, not real rot** — do NOT "fix" workflow YAML for it. If CI stops
   triggering on push, use the `workflow_dispatch` trigger and verify via API.
5. Quality bar: `pnpm lint && pnpm typecheck && pnpm test` green + live
   battery with a real key before calling a round done.
6. The public DASHBOARD must NEVER hand-claim CI green — sync it from the API.
7. `TOOL_NAMES` must include every tool the seeded agents are supposed to
   reach (`delegate_task` was missing until R43 migration 0014 — delegation
   was silently unreachable for EVERY existing DB).

## See also

- [`WORKFLOW.md`](WORKFLOW.md) — the session/round spine this file complements.
- [`TESTING.md`](TESTING.md) — the five-layer verification ladder.
- [`../architecture/api/IMPLEMENTED-API.md`](../architecture/api/IMPLEMENTED-API.md) — shipped API truth.
- [`SANDBOX-RESTORE.md`](SANDBOX-RESTORE.md) — environment + secrets layout.
- [`AGENT-MEMORY.md`](AGENT-MEMORY.md) — the mistakes these rules came from.
