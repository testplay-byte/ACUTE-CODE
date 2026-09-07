<!-- last-reviewed: 2026-09-07 round-75 -->
# Round 10 — Agentic coding system for real: folder picker, full tool set, demo-parity chat UI, live P1 proof (2026-08-23)

**Owner direction:** launcher works on his PC ✅. Next: make this a genuinely
usable agentic CODING system (Cline/Kiro/OpenCode class) — real folder
selection (not pasted paths), sessions per project, memory/context/skills/
API/model considered, full file-change capability, the project-chat UI as an
"almost exact copy" of his demo; test it live against a real folder (his
`ACUTEST\P1`; Linux stand-in `~/acute-workspace/P1`); plan the three-pillar
vision (coding + agentic system + n8n-class automation). Dashboard UI redo:
acknowledged as "way too simple" — scheduled for the NEXT round by the owner's
own prioritization ("first of all… the agentic coding system").

## 1. Real folder selection (no more path pasting)

The sidecar runs on the user's machine, so IT opens the real OS folder
dialog — works in the launcher/browser setup the owner actually tests with:

- **`POST /internal/dialog/folder`** (bearer-walled like everything else):
  Windows → PowerShell `-STA` `FolderBrowserDialog`; Linux/macOS →
  `zenity --file-selection --directory` → `kdialog` fallback. Async on
  purpose (a sync spawn would freeze the whole sidecar while the dialog
  waits for a human). `200 {path}` · `null` = cancelled · `501
  DIALOG_UNAVAILABLE` = no backend → UI falls back to manual entry.
- **Add Project → Browse…** now shows in the browser too (Tauri `pick_folder`
  first, then the sidecar endpoint; graceful hint when neither exists).
- Verified live: sandbox returns the proper 501 (no zenity here); on the
  owner's Windows the PowerShell dialog path is the standard one.

## 2. Cline-class tool set (backend)

Three new sandboxed tools (path-containment identical to the originals):
`create_dir` (nested folders), `delete_file` (ONE file; **directories
refused** — destructive ops belong behind the Phase-3 approval engine),
`search_files` (recursive path search, ignore rules + caps shared with the
explorer tree). System prompt updated; 3 new unit tests (113 agent-core
total). Live proof below.

## 3. Demo-parity chat UI (the "almost exact copy")

Everything the round-9 port had adapted away is now ported onto live data:

- **TopBar (demo-exact)**: hamburger menu with **AGENT picker** (real agents
  with provider · model; persisted choice applies to NEW sessions; an
  existing session keeps its bound agent), **live file search** (⌘K →
  centered Search-files bar with results dropdown → click opens the file),
  **THEME grid** (the app's real 5 themes), Show/Hide sidebar; right side:
  Code toggle, **Experimental toggle**, dark/light toggle. ACUTE AGENT brand.
- **To-Do panel (demo-exact visuals)**: progress ring + mission header +
  counter + toggle rows — real per-project items in the persisted store
  (backend task events are Phase 3), plus a minimal add-row.
- **ExperimentalLayout (demo-exact)**: freeform draggable/resizable/
  minimizable windows with z-order and container clamping — every window
  hosts the REAL panel (Explorer/Code/Chat/To-Do), not mock views.
- Left sidebar: EXPLORER + TO-DO collapsible sections (demo structure).
- Context: every turn replays the full session event history (verified in
  `runtime.ts`), so agents remember the whole conversation + their own prior
  tool calls' results.

## 4. Live proof on P1 (Linux stand-in for the owner's folder)

Agent: "Live Coder" (`openrouter` · `stealth/ox-alpha` — the only model
touched). Session bound to project P1. Two turns, all assertions on disk:

- **Turn 1 (38 s, 6-tool sequence)** `list_dir → search_files → read_file →
  create_dir → write_file → edit_file` — created `src/utils/math.ts`
  (exact `add(a,b)` content), found `src/greet.ts` via search, edited it to
  add `farewell(name)`. **Disk: PASS ×2 (exact content).**
- **Turn 2 (20 s)** `read_file → create_dir → delete_file(ok=false)` — read
  `math.ts` back verbatim, created `docs/`, attempted the asked-for
  directory deletion: the tool REFUSED (`'src/components' is a directory —
  deleting folders needs your approval…`) and the model quoted the refusal
  back. **Disk: docs/ exists ✓ · `src/components` SURVIVED — the
  destructive-op boundary held under live pressure.**
- Usage tracked: 8,513 in / 1,163 out tokens across 2 requests, cost 0.

## 5. Verification

- **Code gates**: `pnpm verify` green — 178 unit (175 + 3 new tool tests;
  net +1 Sidebar/dashboard parity) + 6 sidecar e2e, build, license audit.
- **Live UI**: 5 screenshots (`assets/round-10/`: topbar, file-open,
  hamburger dropdown, experimental freeform, tall 1080×1600), zero console
  errors/warnings, machine-inspected: TopBar anatomy ✓ · 3 panels + pills +
  diff cards ✓ · To-Do ring ✓ · hamburger (agent list, theme grid,
  files-search, hide-sidebar) ✓ · freeform floating windows + banner ✓.
- **Bugs found & fixed during verification** (all same-session):
  TodoPanel selector created a fresh `[]` per snapshot → React infinite
  loop (stable `NO_TODOS` constant); internal routes mount WITHOUT the
  `/api/v1` prefix — the folder-picker client initially called the prefixed
  path (fixed to call `/internal/dialog/folder` directly); CLI battery
  initially grabbed a TEMPLATE agent (no provider/model → 409) — filters on.

## 6. Three-pillar vision (planned, per owner)

`docs/research/n8n/` (README + architecture + patterns-for-acute-code): the
automation pillar adopts n8n's graph-as-data / trigger→nodes→items /
executions-as-history model ADDITIVELY — workflows table (migration 0004),
manual-run-first, agent nodes wrapping the existing turn runtime, schedule
trigger (owner's explicit ask), no raw code nodes (ours is a
security-boundary product). Coding pillar: working (this round). Agentic
system: Phase 3, owner-gated.

## 7. Open items

1. Dashboard UI redo (owner: "way too simple… rigid") — NEXT round, with
   project/token tracking done properly.
2. Sessions-per-project picker (chat currently resumes the latest session;
   a session list/switcher is a small follow-up).
3. Skills/memory beyond session context (project memory file, skills
   registry) — scoped with Phase 3.
4. `dialogs` endpoint returns 501 on this sandbox (no zenity) — Windows
   coverage is the owner's next double-click test.

**Status: delivered (folder picker, 7-tool agent, demo-parity chat UI,
live P1 proof incl. deletion refusal); awaiting owner review — dashboard
redo queued next.**
