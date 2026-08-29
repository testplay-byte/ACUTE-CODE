<!-- last-reviewed: 2026-08-29 round-47 -->
# Changelog

All notable changes to ACUTE-CODE are documented here. Entries are written for
the user of the workbench (features, fixes, behavior changes), not for the
agents that build it. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versioning
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html); the
version number is single-sourced from the root `package.json`
(`pnpm version:get` / `version:check` / `version:set`).

## [Unreleased]

Planned next: the bundled installer (a single executable with the packaged
sidecar — ADR-0003); today the launcher kit remains the distribution path.

## [0.47.0] - 2026-08-29

### Added

- Provider management, cleaned up: the "Models & Providers" settings tab now
  runs on one shared API layer, its connection test can target the primary
  key or any key-pool slot and optionally a concrete model (a real one-token
  probe with measured latency instead of a bare reachability ping), and
  pasting a key in the browser-dev setup honestly warns that it lives in
  server memory only until restart.
- Model catalog from the server: the sub-agent model picker and the agent
  form now read the live model catalog (pricing, context window, tool and
  vision support) from the backend instead of each carrying their own
  hand-maintained copy, so newly shipped models appear everywhere at once.
  The agent form's provider dropdown also lists custom providers you added
  in Settings, and model fields suggest known ids while still accepting
  free text.
- Disabling a provider now actually stops it: turns against a disabled
  provider fail fast with a clear "enable it in Settings" message instead
  of quietly proceeding.

### Fixed

- Security: the launcher template and launcher no longer ship any real API
  keys (the round-44 baked-in sub-agent defaults were removed) — every
  credential value now comes from you and only you, and the launcher never
  writes key values into your credentials file.
- Security: an API route that returned a provider key in plain text (unused
  by the app) was removed.
- The launcher could never actually read the optional sub-agent pool keys
  from credentials.txt (names containing digits were skipped by the
  credentials parser), so your own pool-key values were silently ignored.
- Adding a key-pool slot in Settings could silently overwrite an existing
  slot's key when earlier slots had gaps (e.g. slots 2 and 4 occupied → the
  next add targeted 4 again); the next free slot is now computed correctly.

## [0.46.0] - 2026-08-28

### Added

- Context compaction: when a long session would overflow the model's context
  window, the over-budget history is now summarized by the model itself into a
  dense briefing (task, decisions, files touched, errors fixed, open steps)
  instead of being silently dropped. The summary persists as part of the
  session (fork and revert keep working), it is reused until the window
  overflows again, and a summarizer failure safely falls back to the old
  trim behavior.
- Relevance-ranked agent memory: `memory_recall` now scores results by
  multi-token relevance (content match strength, kind, importance and
  recency) instead of plain substring matching, the auto-injected memory
  digest ranks durable decisions above casual notes, and saving the same
  fact twice refreshes the existing memory instead of duplicating it.
- File restore from checkpoints: the diff view for agent file edits gained a
  "Restore" action (with confirmation) that reverts the file on disk to its
  pre-edit content — the round-25 checkpoint backend is finally reachable
  from the UI. The diff view also no longer misses the recorded snapshot
  while session events are still loading.
- Browser cookie persistence: the embedded in-app browser now keeps cookies
  in the project database, so logged-in sessions survive a restart. Cookies
  never appear in logs or agent-visible output.

### Fixed

- The first file-diff card in a session could permanently show "no snapshot
  recorded" because it rendered before the checkpoint list finished loading.

### Changed

- Terminal session behavior is now covered by black-box end-to-end tests
  (create → input → streamed output → exit → cleanup), in addition to the
  existing unit suite.

## [0.45.0] - 2026-08-28

### Added

- Persistent interactive terminal sessions per project: a real PTY shell when
  `node-pty` is available, a pure-Node fallback otherwise, exposed as a
  "Shell" mode in the Terminal panel that keeps its state between commands
  (idle shells are reaped, and each project gets a session cap).
- Packaging v1: version numbers are now single-sourced across the root
  package, agent-core, shared and the Tauri config (`pnpm version:set`
  writes all four, `pnpm version:check` gates CI), this changelog exists, and
  a release workflow assembles a downloadable launcher kit (CRLF-safe
  `ACUTE.bat` + launcher scripts + credentials template + changelog) with a
  draft GitHub release for every `v*` tag.
- A drift-guard test keeps the agent-form tool catalog in lockstep with the
  backend tool list — the silent "15 checkboxes vs 21 tools" gap found in
  round 44 cannot happen again.

### Security

- Provider API keys are no longer passed to child processes spawned by agent
  tools; children get an allowlisted environment only.
- The automatic read-only command tier is now contained to the project
  folder: absolute paths outside the project, `~`-relative paths and `..`
  escapes demote the command to interactive approval.
- Web tools now go through the approval engine: `web_fetch` and browser
  navigation are host-gated against an editable allowlist (with
  "always allow" per host), and web-search queries are scrubbed of secrets
  before leaving the machine.

### Fixed

- The Sessions screen search is usable on phones: a full-width search row
  under the header and a vertical results list while searching (was a cramped
  170px input plus horizontal scrolling through filtered results).

## [0.44.0] - 2026-08-27

### Added

- Persistent agent memory: agents save facts, decisions and preferences per
  project and get them injected into every later turn; a Memory panel in the
  right sidebar shows and prunes what was learned.
- Real web search: `web_search` queries the general web (DuckDuckGo) with an
  honest fallback chain, instead of returning encyclopedia-only results.
- Session intelligence: search across titles and message text, fork (copy a
  whole conversation under a new session) and revert-to-message (rewind the
  chat to any earlier user message).
- Streaming terminal: live command output with exit codes and a Stop button.
- Sub-agent API keys are auto-provisioned from `credentials.txt` — the
  sub-agent key pool fills itself, no manual entry in Settings.

### Fixed

- Sessions no longer stay "running" forever after a finished turn; revert and
  stop behave correctly on finished conversations.
- Recent-activity cards open the actual conversation instead of an
  unreachable screen; the Sub-agents settings tab is reachable from the
  sidebar navigation.
- The agent form's tool checkboxes were missing delegation, browser control
  and the memory tools (a stale frontend catalog).

## [0.43.0] - 2026-08-26

### Added

- Embedded browser panel plus a `browser_control` agent tool (navigate,
  history, viewport presets) so the agent can drive the user's browser panel.
- Free-model catalog: curated free OpenRouter models with an automatic
  fallback chain when a model is unavailable.
- Turn error cards in the chat with one-click retry.
- Sub-agent provider settings (per-sub-agent model overrides).

### Changed

- Chat geometry: messages use the intended reading width and center correctly
  at every window size.

### Fixed

- `delegate_task` was missing from every existing database's tool allowlist —
  delegation was silently unreachable for all seeded agents; a migration
  repairs old databases.
- CI repaired and green again.

## [0.42.0] - 2026-08-26

### Added

- Desktop notifications that fire even with the window closed (Web Push +
  service worker); turns complete in the background after you disconnect, and
  an explicit Stop button ends them.
- The launcher opens the browser automatically once the app is up; the
  embedded browser panel works in launcher/web mode, not just the desktop
  shell.

### Fixed

- The notification menu no longer cuts off at the screen edge; the chat keeps
  a minimum width while the right sidebar shrinks smoothly; sessions
  auto-name after the first reply and survive sidecar restarts.

## [0.41.0] - 2026-08-26

### Added

- Per-session sidebar state: expanded folders and the selected file/agent
  snap back per session instead of leaking across sessions.
- Desktop notifications while the app window is open, and automatic session
  naming from the first message.
- Embedded browser panel in the Tauri desktop app.

### Fixed

- Command-palette auto-open glitch on session/project switch; the
  notification menu is positioned fully on-screen at every window size.

## [0.40.0] - 2026-08-26

### Fixed

- Sub-agents had every tool silently stripped by an empty-allowlist sentinel —
  delegated children could not actually work; the system prompt no longer
  misreports the tools a child can reach.

### Added

- Notification center (bell menu) surfacing task events; click-to-open for
  files referenced in chat; chat width and sidebar dropdown bounds tuned.

## [0.39.0] - 2026-08-25

### Added

- Browser-style tabs in the right sidebar (Files, Browser, Terminal,
  Sub-agents) — each tab keeps its own state and new ones open from a menu.
- Background sessions: streams keep running while you navigate elsewhere, with
  a live running animation in the sidebar.
- Sub-agent multi-turn conversations.

### Fixed

- Short conversations sit against the composer instead of floating in the
  middle of a large empty pane.

## [0.38.0] - 2026-08-25

### Added

- Right sidebar with Files, Terminal, Browser and Sub-agents panels — the
  previously empty right side of the chat is now usable.

### Changed

- User messages restyled (soft accent-tinted bubble) and smooth
  collapse/expand animations for the working section and thoughts.

### Fixed

- Sessions no longer mix state across projects; sessions auto-title after the
  first reply; a newline-encoding bug garbled sub-agent prompts.

## [0.37.0] and earlier - 2026-08-25

Rounds 1–37 built the foundation: the spec and architecture skeleton, the
first live agent conversation, the setup wizard, the one-double-click Windows
launcher, the agentic MVP (projects, sandboxed tools, live-proven file
writes), the demo-parity chat UI with streaming replies and per-reply
telemetry, project indexing and code search, multi-turn agentic continuation,
sub-agent orchestration, the approval engine and structured logging. The full
history lives in `docs/agent/ORCHESTRATION-WORKLOG.md`; round reports in
`docs/ui-iterations/`.
