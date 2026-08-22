# Frontend (`src/`)

React 18 + TypeScript UI for ACUTE-CODE, built with Vite. The design language
(visual + motion) is ported from the owner's demos in
`C:\Users\khurr\Desktop\ZCODE\ACUTE_CODE\design-demos\` — see
`docs/design/ui-direction.md`.

## Layout

```
src/
├── main.tsx                  Entry: providers (QueryClient, BrowserRouter), theme
│                             painted onto <html> before first render
├── App.tsx                   Route table — the six SPEC F9 screens
├── index.css                 Tailwind v4 entry + CSS-variable theme tokens
│                             (4 blocks: {nova,bento} × {light,dark}) mapped into
│                             Tailwind via @theme inline → utilities like
│                             bg-card / text-muted / border-line / bg-accent
├── vite-env.d.ts             Vite client types + VITE_ACUTE_* env declarations
├── test-utils.tsx            renderWithProviders + store/fixture reset for tests
│
├── lib/
│   ├── version.ts            APP_NAME + delivery-phase marker
│   ├── theme-store.ts        Zustand theme store (themeId nova|bento, light|dark),
│   │                         persisted to localStorage; applies data-theme/-mode
│   ├── config-store.ts       Sidecar connection config (baseUrl, bearer token,
│   │                         demoData toggle). Token is memory-only — never
│   │                         persisted (AGENTS.md secrets rule)
│   ├── api.ts                Typed REST client for the sidecar (API.md contract):
│   │                         ApiError (error-envelope aware), AgentsBackend +
│   │                         SessionsBackend interfaces, http impls, backend
│   │                         selectors, toChatEntries() event→bubble narrowing
│   ├── agent-fixtures.ts     In-memory AgentsBackend (demo data + tests)
│   ├── session-fixtures.ts   In-memory SessionsBackend (demo data + tests):
│   │                         seeded chats, delayed synchronous turns, 502
│   │                         PROVIDER_ERROR simulation ("/error" prefix)
│   ├── motion.ts             Shared motion variants (fadeInUp, stagger*,
│   │                         scaleIn, shared ease) from the dashboard demo
│   ├── format.ts             Subtle time formatting for chat/rows
│   └── utils.ts              cn() class composer (clsx + tailwind-merge)
│
├── hooks/
│   ├── use-agents.ts         TanStack Query hooks for the agent registry;
│   │                         query keys embed the data source (demo|live)
│   └── use-sessions.ts       Session list/detail + create-session and
│                             send-message mutations (invalidate on settle)
│
├── components/
│   ├── shell/                AppShell (bento layout: dot grid, accent glows,
│   │                         sidebar card, main card), Sidebar (six F9 nav
│   │                         items), TopBar (app name, accent-theme switch,
│   │                         light/dark toggle)
│   ├── agents/               Agent Registry screen: AgentsScreen (filter +
│   │                         list + states), AgentCard (registry row),
│   │                         AgentFormDialog (create/edit, all AgentRecord
│   │                         fields), ConfirmDialog (delete confirm)
│   ├── sessions/             Sessions screen (SPEC F3, single-agent Phase 2):
│   │                         SessionsScreen (two-pane list+chat, stacks below
│   │                         md), ChatView (event-log bubbles, autoscroll,
│   │                         composer with Enter/Shift+Enter, thinking dots,
│   │                         409/502 error banner + retry, per-turn usage
│   │                         line), NewSessionDialog (agent picker)
│   └── ui/                   dialog.tsx (Radix Dialog skin), controls.tsx
│                             (Button, Field, Badge, inputClass)
│
└── pages/
    ├── PlaceholderPage.tsx   Titled stub for the not-yet-built F9 screens
    └── SettingsPage.tsx      Data-source panel (demo ⇄ live sidecar, base URL,
                              dev token) — rest arrives in later waves
```

## Routes

| Path | Screen | Status |
|---|---|---|
| `/` | Dashboard (F7) | placeholder |
| `/project` | Project (F1) | placeholder |
| `/agents` | **Agent Registry (F2)** | **real** — list/create/edit/duplicate/delete, template filter |
| `/sessions` | **Sessions (F3)** | **real** — session list + single-agent chat (Phase 2 scope: no WS, no task board yet) |
| `/usage` | Usage (F7) | placeholder |
| `/settings` | Settings (F9) | data-source panel only |

## Theming

`useThemeStore` (zustand, persisted) holds `themeId` (`nova` | `bento`) and
`mode` (`light` | `dark`). `applyTheme` mirrors them onto
`<html data-theme data-mode>`; the CSS token blocks in `index.css` do the rest —
no rebuild, no re-render churn. Accent-derived alphas use `color-mix`, so a new
accent theme only needs one CSS block + one catalog entry in `theme-store.ts`.

## Data flow

`use-agents.ts` / `use-sessions.ts` → `getAgentsBackend()` / `getSessionsBackend()` →
fixture (`demoData: true`, the default until the sidecar lands) or the HTTP client
(`httpAgents()` / `httpSessions()` — fetch + bearer token + error envelope →
`ApiError`). Flip the source in Settings → "Data source"; query keys include the
source so the switch refetches. The token later arrives from the Tauri shell
(`adoptEndpoint({port, token})`); dev fallback is `VITE_ACUTE_TOKEN` /
`VITE_ACUTE_BASE_URL`.

Sessions talk to the verified Wave 2 routes: `POST /sessions` (single mode) →
session; `GET /sessions/{id}` → session + append-only event log + `lastSeq`;
`POST /sessions/{id}/messages` → synchronous `{assistantMessage, usage}` (409
CONFLICT when the agent is unconfigured, 502 PROVIDER_ERROR on upstream failure
— both render as an inline banner with Retry). Chat bubbles come from
`toChatEntries(events)` which narrows `message.user` / `message.assistant`
events; other event types render in later waves. The session fixture simulates
provider latency (~0.7 s) and a 502 for messages starting with `/error`, so the
whole flow is demonstrable without the sidecar.

## Testing

Vitest with happy-dom (opt-in per file via `// @vitest-environment happy-dom`).
Component tests render through `renderWithProviders` (fresh QueryClient +
MemoryRouter) and `resetTestState` (re-seed fixtures, reset stores). Vitest
globals are off, so RTL auto-cleanup doesn't hook in — component test files call
`afterEach(cleanup)` explicitly.
