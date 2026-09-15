# Frontend (`src/`)

React 18 + TypeScript UI for ACUTE-CODE, built with Vite (root package of the pnpm
workspace). Design language: `docs/design/ui-direction.md` + the living
`docs/design/DESIGN-SYSTEM.md`; the owner's frozen demos live in `design/demos/`.
Regenerated at R80.5 (the previous version described a ~round-15 app — 2 hooks and
placeholder routes; it misdirected agents for ~65 rounds).

## Layout

```
src/
├── main.tsx / App.tsx        Entry + route table (see Routes below); theme painted
│                             onto <html> before first render; the Tauri endpoint
│                             adoption (adoptEndpoint) boots the live backend
├── index.css                 Tailwind v4 entry + CSS-variable theme tokens
│                             (themeId × light/dark blocks) mapped via @theme inline
│                             → utilities like bg-card / text-muted / border-line
├── test-utils.tsx            renderWithProviders + store/fixture reset for tests
│
├── lib/                      THE data + state layer (see Data flow)
│   ├── api.ts                Typed REST+SSE client (one flat module, 3.8K lines:
│   │                         transport + domain types + view-models + the
│   │                         TOOL_CATALOG mirror — split candidate, see
│   │                         docs/architecture/MODULARITY-ASSESSMENT.md §10)
│   ├── stream-store.ts       The live-turn state machine (Zustand): parses SSE
│   │                         StreamTurnEvents, mutates liveTurn, side-effects
│   │                         into browser/computer-monitor/right-sidebar stores
│   ├── active-streams.ts     The running-session registry (background streams)
│   ├── settings/config/theme/project-chat/right-sidebar/browser/computer-monitor
│   │                         stores — domain-partitioned Zustand stores
│   ├── sidecar.ts + sidecar-connection.ts   shell handshake, health polling
│   ├── notifications-api.ts / push-setup.tsx / error-bus.ts
│   └── fixtures              demo-data backends (agent/session/project) for tests
│
├── hooks/                    12 TanStack Query hooks (agents, sessions, projects,
│                             usage, notifications, demos, project index, sidecar
│                             health) + use-stream-session-message (SSE wiring) +
│                             use-active-session / use-timeout-clear
│
├── components/
│   ├── shell/                AppShell + Sidebar (navigation) — the app frame
│   ├── project-chat/         THE everyday chat screen (/project/:id/chat):
│   │                         ProjectChatScreen → ChatFocusLayout / Experimental
│   │                         (freeform panels) → AgentChatPanel (chat orchestrator)
│   │                         + WorkingSection (shared turn renderer) + composer/
│   │                         (Composer, ModelSelector, ContextDonut) + panels/
│   │                         (Explorer, Todo) + CommandPalette ⌘K + ChatMarkdown
│   │                         + DebugReportCard / TurnErrorCard / ScreenshotRow /
│   │                         BrowserCheckpointCard / SubAgentCard
│   ├── sessions/             Legacy deep-link chat (/sessions/:id) — ChatView is a
│   │                         SECOND simpler renderer kept in sync by copy
│   │                         (retirement candidate, MODULARITY-ASSESSMENT §10)
│   ├── settings/             SettingsPage = thin tab switch; self-contained tabs:
│   │                         ModelsProviders (the big one), SubAgents, Skills,
│   │                         Mcp, ComputerUse, ImageAnalysis (+ Functionality card)
│   ├── right-sidebar/        The panel dock: Browser, Terminal, Console, Files,
│   │                         Memory, SubAgents panels (tabbed per
│   │                         `${projectId}::${sessionId}`)
│   ├── usage/                The usage dashboard (charts, leaderboards, key cards)
│   ├── agents/ projects/ onboarding/ dashboard/ demos/ notifications/ shared/ ui/
│   └── ComputerMiniWindow    the floating draggable computer-use monitor
│
├── popout/                   The pop-out chat window (custom chrome, its own entry)
├── mini/                     The mini overlay app (its own entry + client)
└── pages/                    SettingsPage + SetupWizard (mounted at /setup)
```

## Routes

| Path | Screen | Notes |
|---|---|---|
| `/setup` | Setup wizard | first-run (models/providers) |
| `/` | Dashboard | usage summary + quick actions |
| `/project/:id` | Project view | tree + code view |
| `/project/:id/chat` | **Project chat** | THE everyday agentic chat |
| `/agents` | Agent registry | list/create/edit/duplicate/delete |
| `/usage` | Usage screen | token/cost dashboards |
| `/settings` | Settings hub | the tab switch |
| `/demos` | Demo viewer | sandboxed iframe demos |
| `/sessions/:id` | Legacy session chat | deep-link only since R48 |

Popout (`popout/`) and mini (`mini/`) are separate Vite entries, not routes.

## Data flow

`hooks/*` (TanStack Query) → `lib/api.ts` (typed functions over fetch + bearer +
error envelope; SSE streams parsed in api.ts into the `StreamTurnEvent` union) →
`lib/stream-store.ts` (`handleStreamEvent` — the ~650-line dispatcher that owns the
live turn and cross-store side effects). Stream state is module-level: streams keep
running with no panel mounted (the R39 background-streaming design). Config/token
(`config-store.ts`) is memory-only (never persisted). Demo-data fixtures back every
screen in tests without the sidecar.

## Extension notes for agents

- Adding a settings tab or right-sidebar panel: self-contained component + one line
  in the parent switch — the sanctioned pattern (MODULE-BOUNDARIES §3).
- Adding a stream event type: api.ts union + stream-store dispatcher + component —
  currently a 4-file change (the Wave-3 handler-registry fix targets this).
- Restyling: use the shared `ui/` controls + theme tokens; do not introduce new
  ad-hoc color systems (DESIGN-SYSTEM.md is the reference).

## Testing

Vitest + happy-dom (opt-in per file). Component tests render through
`renderWithProviders` + `resetTestState`; explicit `afterEach(cleanup)` (globals
off). ~964 frontend tests across 61 files (suites named `*.test.ts(x)`).
