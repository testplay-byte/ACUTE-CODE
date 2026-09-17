<!-- last-reviewed: 2026-09-17 round-102 -->
# Round 65 — The honesty patch: the surface boundary, the auto-opening browser, debug mode, and the Advanced cleanup

**Date:** 2026-09-02 · **Branch:** `main` · **Version:** 0.65.0 · **Owner directive (verbatim intent):** the live 0.63.0 computer-use report's hallucination ("it claimed it opened my Edge, searched, and read the page — NOTHING happened on my screen"; what actually ran was `browser_control` in the EMBEDDED browser), "the browser never even opened" after approving a browser action, "simple browsing operations should not ask permission", "remove the agent-core connection / bearer token from the advanced settings", and "debug mode — the agent reports the details of what it did, with a settings switch".

R64 (the capability round) rebuilt the Windows backend, the floating STOP bar, and the chat polish. R65 is the surgical follow-up for the four items that fell outside R64's scope — all prompt-boundary, visibility, and settings work; no backend rework.

| ID | Workstream | Files owned |
|---|---|---|
| R65-1 | The SURFACE BOUNDARY prompt lines (browser_control ≠ real desktop) + the golden regen | `agent-core/src/agents/prompts.ts`, `prompt-registry.ts`, golden fixture |
| R65-2 | Debug mode: storage setting + `/settings/debug` routes + the DEBUG MODE prompt section + the Advanced-tab switch | `storage/settings.ts`, `server.ts`, `runtime.ts`, `prompts.ts`, `api.ts`, `SettingsPage.tsx` |
| R65-3 | The Advanced-tab cleanup (agent-core connection card REMOVED) | `SettingsPage.tsx` |
| R65-4 | The right-sidebar Browser tab AUTO-OPEN on agent browser activity + the search-engine allowlist | `right-sidebar-store.ts`, `stream-store.ts`, `RightSidebar.tsx`, `AgentChatPanel.tsx`, `approvals.ts` |

## 1. The hallucination's real fix — a boundary the model cannot miss

The owner's 0.63.0 transcript: the agent narrated "opening Edge and reading
GeeksforGeeks" while the ONLY real action was `browser_control(navigate,
google.com)` — a page load inside the app's embedded browser panel. Both
prompt sections existed, but neither named the OTHER surface, so a weak model
freely conflated them.

Both sections now carry an explicit **SURFACE BOUNDARY (R65)** line:

- **COMPUTER USE section:** "these tools drive the user's REAL desktop… The
  EMBEDDED BROWSER PANEL (browser_control) is a DIFFERENT surface… browser_control
  cannot open or touch the user's real browsers/apps, and computer-use tools
  cannot drive the embedded panel. If the user asks about their real machine
  (open Edge, click a desktop button, read the screen), that is computer-use
  work — never browser_control."
- **EMBEDDED BROWSER PANEL section:** "this panel lives INSIDE the app —
  browser_control NEVER opens the user's real browsers (Edge, Chrome, Firefox)
  and never touches their desktop or files… NEVER narrate a browser_control
  action as something that happened on the user's computer — say 'in the
  embedded browser panel' when that is where it happened."

Together with R64's receipts-not-promises discipline (verify-after-write) and
the honest-reporting contract (R61), the three legs of the hallucination fix
are: the tools are separate (R61+), the RESULTS are verified (R64), and now
the PROMPT names the boundary (R65). The golden fixture regenerated
deliberately (additions-only diff, 6 lines).

## 2. Debug mode — the agent self-reports its execution trace

- **Storage:** `debug.enabled` in the settings table (default **false** —
  prompts stay byte-identical for the default-off world), same
  read/write guards as the memory switch.
- **Route:** `GET/PUT /api/v1/settings/debug` (the `/settings/memory` pattern
  byte-for-byte: object/array guard, boolean guard, the same VALIDATION
  envelope).
- **Runtime:** `prepareTurn` reads the setting **per turn** (the
  permission-mode live-getter pattern) and passes `debugMode` into the prompt
  ctx — a settings flip applies to the very next message, no restart.
- **Prompt section** (`## DEBUG MODE (ON)`, registry id `debug`, gated):
  the final answer must end with an `## Execution report` — every tool call
  (name, one-line args, ok-or-error), what was observed/verified after each
  write, anything retried or abandoned. "Raw facts… no hiding failed calls."
- **UI:** Settings → Advanced → **Debug mode** card (the MemoryCard switch
  pattern: `role="switch"`, optimistic-free, error surfaces on the card).

## 3. The Advanced tab cleanup

The **"Agent core connection" card (Base URL / Bearer token / Demo data /
Save connection) is REMOVED** — the owner called those irrelevant: the
desktop app manages the sidecar itself (ephemeral token injected by the Rust
shell). Advanced is now exactly: **Debug mode + agent memory** (+ the pointer
to Sub-agents). The config-store fields survive untouched (dev-mode wiring
reads them); only the UI is gone.

## 4. The browser tab AUTO-OPENS when the agent browses

The owner approved a `browser_control` navigation and **the browser never
opened** — the agent drove the embedded panel invisibly.

- **Signal (scoped):** the stream-store bumps the right-sidebar store's
  per-project activity counter on every `browser_control` tool-call frame AND
  every `browser-command` bridge frame (both before the liveTurn guard —
  background turns count). `startStream` now records the session's
  **projectId** (the panel knows it; the store only knew sessionId) so the
  bump is **project-scoped** — a background agent browsing in project A never
  pops a tab in project B's sidebar. Unattributed frames never bump.
- **Burst gate:** frames within 8s of the last bump refresh the gate without
  a new edge — one browsing burst = ONE auto-open, no fighting the user
  mid-burst; a >8s gap is a new burst.
- **Controller (RightSidebar):** an edge-triggered effect (mount reads are
  never edges) opens the Browser tab — or **surfaces the existing one**
  (whatever URL it carries; `openBrowser(null)`'s blank-tab dedupe would
  mint a duplicate on navigated tabs) — only when a browser tab isn't
  already active. The sidebar is embedded by design (never full-screen,
  never a floating window).
- **Persistence:** `partialize` now pins the store to the durable fields
  (byProject/activeProjectId/activeSessionByProject) — the transient signal
  never rides localStorage, so a reload can never leave a stale burst gate
  that swallows the first post-reload frame.

## 5. Simple browsing asks nothing

`google.com`, `www.google.com`, `bing.com`, `www.bing.com` join
`DEFAULT_WEB_HOST_ALLOWLIST` (exact-host matching — `google.com.evil.org`
still asks). The everyday search engines are the same reading tier as the
docs hosts; site-specific "always allow" stays owner-decided on the approval
card. The WEB ACCESS prompt line already names the allowlist tier.

## 6. Verification

- Root `pnpm test`: **1686/1686 in 110 files** (baseline 1664/109; +22:
  r65-honesty-patch 8, orchestrator debug round-trip 1, r45 search-engine
  pin 1, stream-store 5, RightSidebar 5, SettingsPage 3, SubAgentsTab pin
  update).
- agent-core: **894/894 in 53 files** (baseline 885/52).
- `pnpm lint` + `tsc --noEmit` CLEAN on both workspaces; version:check
  0.65.0 ×4.
- **Sub-agent review** (owner directive — review before ship): 3 REAL bugs
  found and ALL fixed pre-commit — (1) the auto-open minted duplicate blank
  browser tabs once the agent's tab carried a URL (now the existing tab is
  SURFACED); (2) the activity signal was global, popping tabs in unrelated
  projects' sidebars (now project-scoped via the startStream projectId);
  (3) the transient signal was persisted with the store (now partialize
  pins the durable fields; a stale burst gate can never survive a reload).
  Circular imports verified absent; the golden fixture verified
  additions-only; the allowlist exact-match verified no bypass.

## 7. What this round does NOT claim

- The boundary lines are prompt engineering — they make the conflation
  EXPLICIT, but a sufficiently weak model can still ignore text (the
  receipts-not-promises discipline + the honest-reporting contract are the
  behavioral backstops; the owner's next live run is the real test).
- Debug mode changes the PROMPT, not the transcript — the report is only as
  honest as the model writing it (the event log remains the ground truth).
