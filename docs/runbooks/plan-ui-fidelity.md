<!-- last-reviewed: 2026-09-19 round-108 -->
# UI Implementation Plan — Demo Fidelity Pass

2026-08-22 · Owner directive: the three shared demos ARE the design spec; current screens don't match. Nova/Bento are STARTING themes only — the system must be trivially extensible (append to a table). No rushing; verify each wave visually.

## Source material (read these files — they are normative)

In-repo at `design/demos/` (also mirrored outside repo at `ACUTE_CODE\design-demos\`):

| Screen family | Demo | Normative files |
|---|---|---|
| Setup wizard | `acute-agent-ui` | `app/page.tsx` (step machine, dot-grid bg, Space Grotesk), `components/*.tsx` (Welcome/PickFlavor/NeedBrain/PlugBrain/AllSet + plug-brain/* cards), `lib/onboarding-store.ts`, `lib/onboarding-types.ts` (THEMES table), `lib/use-theme-styles.ts`, `lib/color-utils.ts` |
| Dashboard | `acute-agent-dashboard` | `src/components/dashboard/*` (DashboardPage, StatCard, TokenBarChart, SessionsView, SessionCard, RecentActivity, QuickActions, Sidebar, TopBar, ThemeToggles), `src/lib/dashboard-store.ts` (DASHBOARD_THEMES), `src/lib/dashboard-helpers.ts` (motion variants, easing `[0.25,0.1,0.25,1]`) |
| Agent chat | `project-chat` | `src/components/project-chat/*` (ProjectChatView, AgentChatPanel — bubble anatomy, avatar chips, thinking dots, composer), `src/lib/project-chat-store.ts` |

## Design tokens extracted (normative)

- Typography: `'Space Grotesk', 'General Sans', ui-sans-serif`; headings `font-black tracking-[-0.04em] leading-[0.95]`, sizes 32–44px; letterSpacing -0.01em body.
- Backgrounds: dot-grid overlay `radial-gradient(circle at 1px 1px, <dot> 1px, transparent 0)` at 4% opacity, 28px grid.
- Cards: `rounded-[24px] border-[1.5px]` (wizard), `rounded-2xl` (chat); **bento shadows**: `3–4px 3–4px 0 0 black` (light) / `rgba(255,255,255,.06–.08)` (dark).
- Motion: fadeUp/scale/stagger variants, duration .2–.4s, ease `[0.25,0.1,0.25,1]`.
- Themes: table-driven `{id,name,accent,accent2,bgLight,bgDark,cardLight,cardDark,textLight,textDark,dot,palette…}`; derived style hook (`useThemeStyles`) computes bg/card/text/borders(alpha)/inputs/shadows from theme+isDark. Seed table with **nova + bento**; adding a theme = one object literal.

## Waves (sequenced to avoid file conflicts)

### Wave 1 — Theme engine + Setup wizard + key storage (Developer E)
Owns: `src/lib/theme*`, `src/index.css`, `src/components/onboarding/**`, `src/App.tsx` (routes), `src-tauri/src/**`, `shared/src/index.ts` (if a type is needed).
1. Port the theme system verbatim-in-spirit: `THEMES` table (nova, bento), `useThemeStyles()` hook, contrast-text util, CSS variables bridged onto `:root` so legacy components keep working.
2. Build `/setup` wizard: all five steps with Header/Footer chrome, step transitions (AnimatePresence-style motion), wired to the LIVE backend: providers from `GET /api/v1/providers`, models from `GET /providers/:id/models`, connection test, and key entry via the NEW shell command below (never REST). "Skip for now" must exist; first-run auto-routes to `/setup` when no provider has a key (localStorage flag after completion/dismissal).
3. Rust: `store_provider_key(providerId, key)` Tauri command using the `keyring` crate (writes `ACUTE-CODE/provider/<id>`); also `provider_key_status(providerId)` → bool. cargo check green.
4. Fonts: bundle/load Space Grotesk locally (no Google Fonts CDN dependency offline).

### Wave 2 — Dashboard + chat restyle (Developer F)
Owns: `src/components/dashboard/**`, `src/components/shell/**`, `src/components/sessions/**`, `src/hooks/use-sessions.ts`.
1. Dashboard replaces the placeholder: greeting header, StatCards (sessions, tokens, requests, agents), TokenBarChart fed by a small new sidecar endpoint `GET /api/v1/usage/summary?days=14` (SQL over usage_events; implement in same wave), RecentActivity + QuickActions adapted to our features, theme toggles.
2. Sidebar/TopBar restyled to dashboard-demo fidelity (iconography, collapse, active states).
3. Chat restyle to project-chat fidelity: bubble anatomy (user right rounded-br-md, assistant left bordered card), avatar chips, mono chips for model/token info, thinking-dots indicator, composer with model chip + send affordance; keep existing hooks/API untouched.

### Verification per wave
`pnpm verify` green → relaunch app (`taskkill //IM acute-code.exe //F`, rebuild dist, relaunch detached) → orchestrator smoke-checks routes → owner visual pass at the end of both waves.

## Non-goals this pass
No new themable content beyond listed screens; no marketplace/sync; wizard writes keys ONLY via Credential Manager (shell command) — never localStorage, never REST bodies.
