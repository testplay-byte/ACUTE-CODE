<!-- last-reviewed: 2026-09-07 round-75 -->
# Round 09 — Agentic Coding MVP: project-chat UI port (M3) + first live ACUTEST run (M4)

**Date:** 2026-08-23 · **Recorded by:** orchestrator agent (takeover session)

**Owner direction:** finish the Agentic Coding MVP per `docs/runbooks/plan-agentic-mvp.md`:
port the `design/demos/project-chat` UI (the normative spec) onto live data as
`/project/:id/chat`, wire the sidebar's Add Project to the native `pick_folder`
command (browser text-prompt fallback), move `src/lib/projects-store.ts` onto
`/api/v1/projects`, then prove the loop live: project → session → "create a
file" prompt → files on disk, recorded here.

**Environment note (deviation, flagged to owner):** this session ran in a
**Linux x64 sandbox**, not Windows. Windows-only mechanics were substituted:
OpenRouter key injected via `ACUTE_PROVIDER_OPENROUTER` env (the sidecar's
documented env path — no Credential Manager on Linux), and the M4 live folder
is `/home/z/acute-workspace/ACUTEST` instead of
`C:/Users/khurr/Desktop/ACUTEST`. Everything else (sidecar, REST, tools,
agent turn, UI) ran the real code paths. `cargo check` runs on CI only
(ADR-0012; no Rust toolchain in the sandbox).

## 1. M3 — project-chat UI ported onto live data

New components (`src/components/project-chat/`): `ProjectChatScreen` (demo
`ProjectChatView`/NormalLayout adapted to the AppShell card + slim project
header), `AgentChatPanel`, `CodeView`, `LeftSidebar`, `panels/ExplorerPanel`,
`index.ts`, `highlight.ts` (shared tokenizer + palette constants).

- **Resizable 3-panel layout** exactly per demo: Explorer 180–400 (default
  250) / Code flex-1 / Chat 320–800 (default 400), 10px `GapHandle`
  drag-handles with hover bar; **upgraded** with `role="separator"` a11y,
  Arrow/Home/End keyboard resize, accent focus ring; sizes persist
  (`acute-code.projectChat`). `onlyChat` mode centers the chat at 90%.
- **Message anatomy from real session events** (`toProjectChatItems`):
  `message.user` → user bubble (accent); `message.assistant` → ai bubble with
  the demo RichText parser (**bold** + `inline code`); consecutive
  `tool.use` events → ONE action-pill row (list_dir→Search,
  read_file→FileCode2, write/edit_file→Edit3; `✓`/`✗` from `ok` — no duration
  exists in the event); each `write_file`/`edit_file` → a **diff card**
  (filename, `+N chars`, applied/failed dot) that opens the file in the Code
  panel on click. Thinking indicator (bounceDot dots) while the synchronous
  turn request is pending.
- **Explorer + Code on live data**: tree from `/projects/:id/tree` (folders
  first, caps per M1), file content from `/projects/:id/file` (256 KB cap),
  demo-faithful tree rows/icons/chevron animations + custom tokenizer
  highlighter, selection persisted, top-level folders auto-expand on load.
- **Theme engine only**: every color via `useThemeStyles()` tokens/`withAlpha`;
  the two semantic status colors live in `src/lib/semantics.ts`, file-type +
  syntax palettes in `highlight.ts` (documented intentional constants); the
  Code panel traffic lights keep the demo's decorative hex (commented).
- **Add Project → backend**: sidebar list/create/delete now use
  `/api/v1/projects` (`path` → `rootPath`); the modal gains a **Browse…**
  button only under Tauri (`isTauri()` → `pick_folder` via the established
  invoke pattern); browser dev keeps the text input; API errors (400/409)
  surface inline. New projects navigate to `/project/:id/chat`;
  `projects-store.ts` **deleted** (DashboardScreen/ProjectView migrated too);
  ProjectView gained an "Open project chat" CTA + per-project Sessions list
  (client-filtered — the sessions API has no server-side projectId filter yet).

**[ASSUMPTION] scope decisions** (surfaced for owner review): demo TopBar,
TodoPanel, ExperimentalLayout, SuggestionBanner and the model picker were NOT
ported (app shell owns chrome; no backend event source for todos/suggestions;
model comes from the session's bound agent). Diff cards render the log-safe
summary (path + char count + status), not fabricated diff lines — real diff
bodies arrive with Phase 3 git integration (API.md §3.14). Message timestamps
are not rendered (demo parity). The chat binds the first non-template agent by
default and creates the session lazily on first send.

## 2. Latent M2 bug found and fixed by the live run (root cause)

First live M4 turn returned `502 PROVIDER_ERROR — "schema is not a function"`.
Root cause: `buildProjectTools()` passed **raw JSON Schema literals** as
`inputSchema` and cast them to `ToolSet` — AI SDK v7 requires JSON-Schema
tools wrapped in `jsonSchema()` (which supplies the validation callables the
SDK invokes). Unit tests never saw it because they drive `ChatFn` with
stubs/mocks (per repo rule: no live AI calls in tests) — exactly the class of
bug M4 exists to catch. Fix: wrap all four tool schemas in `jsonSchema()`
(`agent-core/src/tools/index.ts`); agent-core 110 tests stayed green; the
live turn then succeeded. Also fixed: React 18 `forwardRef` on the
`AnimatePresence mode="popLayout"` message child (demo targeted React 19,
which needs no forwardRef) — console is now warning-free.

## 3. M4 — live proof on ACUTEST (Linux-substituted path)

Setup via `node scripts/acute.mjs` (sidecar on 127.0.0.1:5178, dev token;
provider shows `● openrouter` with key; connection test `stealth/ox-alpha` →
`ok:true, 8679 ms` — the only model touched, per owner rule):

- `POST /projects` → `acutest-44c71892` (rootPath `/home/z/acute-workspace/ACUTEST`)
- `POST /agents` → "Live Coder" (openrouter · `stealth/ox-alpha`, maxTurns 12)
- `POST /sessions` → `sess_d411344a…` bound to project + agent
- Prompt: *"Create a file named hello.ts in the project root containing
  exactly: export function hello() { return "Hello from ACUTE-CODE M4"; }
  Then create a notes.md in src/ containing a one-line summary of what you did."*

**Result (synchronous turn, 26 s, 3,932 in / 425 out tokens, 1 request,
costUsd 0):** event log = `message.user` → `tool.use list_dir (ok)` →
`tool.use list_dir (ok)` → `tool.use write_file (ok)` → `tool.use write_file
(ok)` → `message.assistant`. The assistant confirmed both files. Session
events 1–2 in the log are the honest history of the two pre-fix 502 attempts
(user message logged, turn aborted before any model call); event 3 is the
successful turn.

**On-disk assertions (PASS):**

```
/home/z/acute-workspace/ACUTEST/hello.ts     → export function hello() { return "Hello from ACUTE-CODE M4"; }
/home/z/acute-workspace/ACUTEST/src/notes.md → Created `hello.ts` in the project root exporting a `hello()` function that returns "Hello from ACUTE-CODE M4".
```

`GET /projects/:id/tree` shows `src/`, `hello.ts`, `README.md`;
`GET /usage/summary?days=1` records the request. Path-containment sandbox
held (all writes inside the project root).

## 4. Verification

- **Code gates:** `pnpm verify` green after all changes — lint, typecheck,
  **175 unit tests** (169 baseline + 5 timeline-mapper tests + 1 new Sidebar
  409-alert test; net of the deleted store) + **6 sidecar E2E**, build
  (shared/agent-core/vite), license audit clean (107 prod deps). CI runs the
  same gate on windows-latest (incl. `cargo check`).
- **Live UI:** browser against the real sidecar at
  `http://localhost:5173/project/acutest-44c71892/chat` — console clean (no
  errors/warnings after the forwardRef fix), zero page errors; explorer tree,
  action pills, diff cards and the assistant's rich text all rendered from
  real session events.
- **Screenshots** (assets/round-09/, machine-inspected at capture size):
  `chat-1920x1080.png` (3 panels, bubbles/pills/diff cards/rich text,
  composer), `chat-file-open-1920x1080.png` (hello.ts open: gutter, syntax
  tokens, traffic lights, "Nova editing" chip, selection sync),
  `chat-1080x1600.png` (tall viewport: no clipping/overlap).

## 5. Open items for the owner

1. Review the ported screen (scope decisions in §1 are tagged `[ASSUMPTION]`
   and easy to adjust — TodoPanel/thought blocks/diff bodies all have hooks
   ready).
2. Re-run M4 on Windows/`C:/Users/khurr/Desktop/ACUTEST` at your convenience
   to confirm the same loop on the target OS (the code path is identical;
   only the path differs).
3. The stale comment in `App.tsx` about FirstRunCheck ("provider list … zero
   configured keys") predates the flag-only implementation in
   `providers-api.ts` — harmless, can be re-worded on the next touch.

**Status: delivered (M3 + M4 + M2-era live-call bug fix); awaiting owner
review of the project-chat screen.**
