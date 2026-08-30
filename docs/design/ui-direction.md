<!-- last-reviewed: 2026-08-30 round-53 -->
# UI Direction — from owner-provided design demos (2026-08-22)

Source: three demo projects provided by the owner, extracted to `C:\Users\khurr\Desktop\ZCODE\ACUTE_CODE\design-demos\` (outside the product repo; owner-owned designs, "just demos… there might be some adjusting"). These are the baseline design language for Phase 2+ UI work.

## What the demos are

| Demo | Purpose | Key screens/components |
|---|---|---|
| `acute-agent-ui` | First-run onboarding | Welcome → NeedBrain → **PlugBrain** (provider selector, base URL, API key, model dropdown, context window, max output, temperature, input/output cost, reasoning level) → PickFlavor (theme pick) → AllSet |
| `acute-agent-dashboard` | Main dashboard | Sidebar + TopBar, WelcomeView, SessionsView + SessionCard, StatCard, TokenBarChart, RecentActivity, QuickActions, ThemeToggles |
| `project-chat` | Full chat experience | Next.js + shadcn chat app (dnd-kit, mdxeditor, extensive Radix set, prisma — patterns only, we don't use prisma) |

## What we adopt

- **Stack match is exact**: Radix/shadcn components, Tailwind, Zustand stores (`onboarding-store`, `dashboard-store` patterns), client components — aligns with the fixed frontend stack. Demos are Next.js; our Vite+React port changes wiring only (no app router, no next/*).
- **Multi-theme system**: theme ids (e.g. `nova`) + light/dark toggle driven from a theme table in the store (see `use-theme-styles.ts`, `DASHBOARD_THEMES`) — implements SPEC F9's light/dark/accent theming via CSS variables.
- **Motion language**: `fadeInUp`, `staggerContainer/Item`, `scaleIn` variants with a shared easing curve (dashboard-helpers) — consistent, subtle (0.2–0.4s) animations.
- **Onboarding flow becomes our provider setup UX** (SPEC F4): the PlugBrain screens map 1:1 to provider selection → custom base URL+key (OpenAI-compatible path) → model listing → tuning (temperature/costs). First-run wizard reuses this flow with keys going through the shell → Credential Manager, never the sidecar REST.
- **Dashboard layout**: sidebar navigation + top bar + stat cards + token bar chart is the F7 usage dashboard layout.

## Adjustments for our context

- Chat/demo data comes from the sidecar REST+WS API (`docs/architecture/api/API.md`), not local stores/prisma.
- API keys entered in onboarding MUST route through the Tauri shell command (ADR-0012 secrets scheme) — never sent to the sidecar via REST bodies.
- Approvals modals (F6) and the Kanban task board (F3) have no demo counterpart — design them in the same visual language.
- `project-chat`'s dependency list is broader than our v1 scope; take composition patterns, not dependencies.

## Owner directive (2026-08-22)

The owner restated the demos' role when kicking off the UI fidelity pass:

- **Nova and Bento are starting themes only** — not defaults, not constraints. The theme table must not hard-code assumptions from those two; they merely prove the pattern.
- **The theme system must make adding themes trivial** — adding one is appending an object literal to the themes table (id, name, accent(s), light/dark surfaces, text, dot color, palette); no component changes.
- **The three demo screen families — setup wizard, dashboard, chat — are the visual spec.** Current screens that diverge are wrong, not the demos ("the demos ARE the design spec").
- Execution plan, normative token extractions, and per-wave ownership live in `docs/runbooks/plan-ui-fidelity.md`; verify each wave visually before moving on.
