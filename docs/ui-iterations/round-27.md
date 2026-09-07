<!-- last-reviewed: 2026-09-07 round-75 -->
# Round 27 — Web tools + critical deps-wiring fix + demo project

**Date:** 2026-08-24
**Owner direction:** "Make the whole agent coding environment complete. Do the proper testing. Provide me a zip file with the screenshots of your testing of it. Try to build a project using this agent coding environment... If there are some features and functionalities which are missing, then do add them too, like web browser features for our agent and various other functionalities. Quality over speed over time."

## What changed

### NEW: web tools (Kilo/Cline parity — "browser features for our agent")
- **`web_fetch`** — fetch any public http(s) URL, strip HTML to readable text, 16KB cap, real browser UA. The agent's "open a URL and read it" capability: docs pages, RFCs, GitHub raw files, blog posts.
- **`web_search`** — MediaWiki full-text search (en.wikipedia.org API, no key needed), up to 6 ranked results. Honest: "knowledge search, not a generic web crawler."

### CRITICAL FIX: deps-wiring (round-25 features were silently dead in real turns)
- `runtime.ts prepareTurn` now threads `toolDeps {db, sessionId, agentId, seq}` into BOTH `buildProjectTools` calls.
- **Before this fix:** `todo_write` returned "todo tracking unavailable" AND `write_file`/`edit_file`/`delete_file` snapshot recording (checkpoints) were SILENTLY DEAD in real agent turns — while passing isolated unit tests. Exactly the class of bug AGENT-MEMORY #9/#35 warns about.
- **After:** todos persist + every mutating tool records a revertible snapshot.

### Wiring
- `tools/index.ts`: web_fetch + web_search registered (jsonSchema-wrapped)
- `storage/agents.ts`: TOOL_NAMES canonical list +2 (now 15)
- `src/lib/api.ts`: TOOL_CATALOG frontend mirror +2
- `agents/prompts.ts`: new WEB ACCESS section in the system prompt
- Tests: 14 new web-tools unit tests (mocked fetch — no live AI in tests); TOOL_NAMES/buildProjectTools/storage seeding expectations 13→15

## Verification evidence

### L4 live battery (CLI, fresh DB, real OpenRouter stealth/ox-alpha)
- 8 tool.use events: todo_write×3, web_search×3, web_fetch×1, write_file×1
- `research.md` created on disk (3094 bytes, ground truth)
- `file_snapshots` row recorded for write_file — **table was EMPTY before the fix**
- `todo_write` persists (6 items, status progression pending→in_progress→completed) — **was "unavailable" before the fix**
- usage_events row: model=stealth/ox-alpha, in=34448, out=1585

### L5 browser verification (real UI, 1920×1080, VLM-verified)
19 screenshots captured into `assets/round-27/`. VLM-verified key shots:
- **01-dashboard**: dark-themed dashboard with sidebar, stats cards, token usage chart, quick actions, recent activity
- **12-second-turn-final**: chat with assistant reply + `write_file` tool pill + usage stats
- **18-demo-chat-result**: `write_file` AND `run_command` tool pills (agent verified its own work!) + assistant summary
- **19-demo-app-running**: full YouTube-like page — video player (Big Buck Bunny), 4-item "Up next" sidebar with thumbnails/titles/view counts/durations, YouTube-style header with search

### Demo project — built BY the agent
The agent received a single prompt ("Create a YouTube-like video watching page...") and built a complete 545-line `index.html` (13KB):
- 315 lines of inline CSS (dark theme #0f0f0f, sticky header, flexbox 70/30)
- A `<video>` element with controls + autoplay
- A 4-item video list with clickable cards
- 165 lines of inline JavaScript (loadVideo(), buildList(), formatDuration(), keyboard nav, metadata handling)
- The agent then ran `run_command` to verify the file was created — the agentic loop working end-to-end

### pnpm verify
- 211 tests (197 → 211: +14 web-tools tests)
- License audit CLEAN (107 production deps)
- CI green (run 32697550327)

## Screenshots zip
**Download:** https://github.com/testplay-byte/ACUTE-CODE/releases/download/round-27-testing/round-27-testing-screenshots.zip (1.37MB, 22 files)

## Open items (queued, not blocking)
- MCP client (ecosystem unlock — browser/docs/DB tools via MCP)
- Interactive approval round-trip for run_command
- Fuzzy edit matching (fallback when exact anchor fails)
- @codebase semantic index
- stealth/ox-alpha tends to stop early on multi-step tasks (sent a planning message instead of continuing the loop) — model behavior, not a code bug; a more capable model would complete multi-file builds in one turn

## Tip
- `a92171b` → `d184d29` (round-27 commit); CI run 32697550327 SUCCESS
