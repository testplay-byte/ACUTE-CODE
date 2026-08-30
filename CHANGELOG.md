<!-- last-reviewed: 2026-08-30 round-50 -->
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

## [0.50.0] - 2026-08-30

Round 50 — the owner's third test round: a real embedded browser, live
sub-agent streaming, and the fully-specified chat composer.

### Added

- **A native embedded browser.** The browser tab now renders through real
  Chromium: every tab is a WebView2 child webview hosted inside the app
  window, positioned exactly over the panel's page area — no proxy, no
  tickets, no URL rewriting, so every site loads with its real CSS/JS.
  Tabs share one persistent browser profile (logins survive app restarts
  and are isolated from the system browser); the address bar, history
  buttons, and viewport presets drive the webview while the agent's
  `browser_control` tool stays in sync with what you actually see. The
  fetch-proxy iframe remains as the fallback outside the desktop shell.
- **Sub-agents stream their raw thinking and text live.** A delegated
  sub-agent's panel now shows the actual tokens — thinking and text — as
  they are generated, exactly like the main chat, plus its tool calls as
  they happen.
- **A stats bar at the bottom of the sub-agent live view:** total time,
  tokens sent, tokens received, tokens per second, and the model in use —
  live while it works, authoritative values after it finishes.
- **Five attempts on rate limits.** Provider calls previously gave up
  after three attempts (the SDK default); they now retry five times with
  exponential backoff.
- **A redesigned chat composer** (the controls live inside the message
  box): **Add Context** — attach files via the Windows file picker, pick
  project files from a searchable list, `@`-mention files, or drag and
  drop; **permission modes** — Full Access / Ask (default) / Plan
  (read-only research) / Editor (file edits without a terminal);
  **thinking level** — Default / Low / High / Max; **a model picker** that
  opens your providers and shows each one's models on hover with a
  Manage-Models shortcut to the settings; and **a context donut** — a ring
  of the current context usage that opens a detailed breakdown (messages,
  system prompt, system tools, memory, meta), the cache hit rate, and the
  session's token and cost totals. An empty chat centers the composer in
  the lower half of the screen.
- **The Models & Providers page reworked:** the provider list and the
  detail pane scroll independently; models are added from a searchable
  catalog picker with multi-select (free/paid badges, pricing
  pre-filled); every model's advanced configuration is editable — input,
  output, and cached-input prices per million tokens, context window, max
  output tokens, thinking support, and picker visibility.

### Fixed

- Clearing a model's price never persisted (an explicit empty field was
  silently treated as "keep the old value"), and re-adding an existing
  model reset its "supports thinking" flag. Both are now field-precise.
- The context meter now reads the model's real context window from its
  configuration (previously a fixed 200k assumption for unknown models).

### Changed

- Plan mode restricts the agent to read-only tools; Editor mode removes
  the terminal; Full Access auto-approves permission asks (hard-blocked
  commands like `sudo`/`rm -rf` are still refused in every mode).
- Sub-agent sessions inherit the parent's permission mode.

## [0.49.0] - 2026-08-29

Round 49 — the file-tools repair round: every entry below fixes something
found while actually using the app on Windows (the owner's second test
session).

### Fixed

- **Agents have their file tools back.** On every install created before
  the orchestration rounds, the default "Acute" agent silently lost its
  entire project tool set (list_dir, read_file, write_file, edit_file,
  create_dir, delete_file, search, git, run_command, …) — two older
  migrations appended new tools to the agent's "all tools" allowlist and,
  in doing so, turned it into an explicit allowlist of exactly those five
  appended tools. Both the main agent and every sub-agent (children run
  the same agent row) then honestly reported "I have no write_file or
  list_dir". Migration 0019 repairs the damaged allowlist back to "all
  tools" — fingerprint-scoped so deliberate restrictions are never
  touched.
- **The embedded browser renders full pages.** Pages loaded but appeared
  as blank, unstyled HTML — every rewritten stylesheet/script/image URL
  was path-relative, and the document's injected `<base href>` (pointing
  at the upstream site) made the browser request them FROM THE UPSTREAM
  SITE, which 404'd them. Rewrites are now absolute URLs pointing at the
  sidecar proxy. Failed sub-resource fetches (404/500 CSS or JS) return an
  empty body instead of an HTML error page, so the console stays clean.
- **Saving from the browser works again.** The backend's cross-origin
  allow-list was missing the PUT method — every PUT-shaped save from the
  UI (settings toggles, API-key pool slots) failed silently at the
  browser's preflight check. Found while live-verifying the new memory
  switch.
- **A model that "announces" a tool call without making one gets one
  correction.** Free models sometimes answer a work request by writing the
  tool call as a code block in plain text; the turn used to end right
  there with nothing done. The agent now receives one in-turn nudge
  ("actually call the tool") when — and only when — the reply evidences
  tool intent; conversational replies still end immediately, and the
  nudge never appears in the chat log.

### Added

- **Nested sub-agents.** A sub-agent can itself delegate to further
  sub-agents (same tools, same workings, its own context and API key —
  the only differences), up to a fixed depth of 3 levels; beyond the cap
  the delegation tool is withheld so the fan-out stays bounded.
- **The memory master switch** (Settings → Advanced). Turn the whole
  agent-memory system off: no memory digest is injected into any system
  prompt, the memory tools are not offered, and the Memory panel says so.
  Saved memories are kept and restored when re-enabled.
- **Sub-agents run on their own context alone.** The project memory digest
  is no longer injected into sub-agent turns at all (main sessions keep it
  while the switch is on) — stale memories can no longer teach a
  sub-agent wrong facts about its own tool set.

### Changed

- **The app mark is now a cat.** The logo, favicon and Windows icon are a
  white cat-face silhouette (pointed ears, almond eyes, tiny nose) on the
  orange gradient tile.
- **The standalone Sessions screen is gone** — route, component and all.
  Sessions live on inside each project's chat, where they always actually
  belonged.

## [0.48.0] - 2026-08-29

Round 48 — the owner-test round: every entry below fixes something found while
actually using the app on Windows.

### Added

- Sub-agents can now ask for permission. A sub-agent that hits a
  needs-approval action (a non-read-only command, a web fetch or browser
  navigation outside the trusted-host list) pauses and asks you, exactly like
  the main agent: the approval card appears in the parent chat labelled with
  the sub-agent's code and role, and Allow / Always allow / Deny releases it.
  Channel-less runs (background retries) still fail fast instead of hanging.
- Sub-agents now work live in the UI. The Delegated card in the chat shows
  each running sub-agent with its code, role, progress and latest activity,
  and clicking it opens that sub-agent in the right sidebar — no more
  "Running… Running…" with nothing to click.
- The right-sidebar sub-agent view is now a real chat transcript — the task,
  the assistant's replies, every tool call with its result, todo progress and
  approval events, styled like the main chat — with a per-second clock.
- Every sub-agent now carries a short code (like `K7F2`), shown in the chat
  cards, the tab picker and the sub-agent tab title, so you can tell two
  running agents apart at a glance.
- Stopping the parent turn now also stops its sub-agents (pending approvals
  deny fail-closed; children stop cleanly between tool iterations).
- The Files action in the right sidebar now opens a real file explorer:
  the project tree on the left (folders expand, files open on click) and the
  file's contents on the right, with a Search button that still opens the
  file/command search palette.
- Projects now get distinct colors. New projects draw from an 8-color palette
  (least-used first) and existing projects are re-colored on first launch
  after this update, so the sidebar no longer shows a wall of identical
  orange. The active project highlights in its own color.
- A favicon (the new logo mark) for the browser dev setup.

### Changed

- The Sessions entry is gone from the left sidebar. Sessions live where they
  are used — under their projects — and the sessions screen remains reachable
  by its direct link only.
- New, sharper app logo: a solid "A_" prompt mark replacing the two-stroke A.
- Collapsed sidebar rail: the selected project now shows a clean inset ring
  instead of an oversized clipped outline, and the rail scrolls.

### Fixed

- The embedded browser no longer flashes and reload-loop every second, and
  no longer dies with "Browser proxy ticket missing, expired or invalid"
  after navigating or changing the viewport. Root cause: every navigate and
  viewport change silently rotated the browser-proxy ticket the panel was
  still using; tickets now stay valid (a fresh one is only minted by the
  explicit session re-mint), plus a bounded recovery loop as a safety net.
- The Browse button in the new-project dialog now opens the modern Windows
  folder picker (the File-Explorer-style one), and it appears ON TOP of your
  windows instead of hiding behind them — both in the browser/launcher setup
  and in the desktop app. The old-style tree dialog remains only as a
  fallback if the modern one cannot load.
- Sub-agents actually run their tools now: the approval gate previously
  failed every ask-tier action silently, which made browser control and most
  commands impossible for them and made delegation look stuck.
- Memory entries in the right sidebar dropped the colored left-bar accent in
  favor of clean uniform cards.

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
