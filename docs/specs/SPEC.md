<!-- last-reviewed: 2026-08-30 round-53 -->
# ACUTE-CODE — Master Specification

| | |
|---|---|
| **Status** | DRAFT v1.0 — Phase 0, awaiting product-owner approval |
| **Date** | 2026-08-21 |
| **Product** | ACUTE-CODE — local-first multi-agent engineering workbench (Windows) |
| **Derivation** | Product-owner brief (2026-08-21) + owner decisions recorded 2026-08-21 (see ADRs 0001–0004) |
| **Changes** | Owner-approved changes only; living document maintained by the Scribe |

---

## 1. Product definition

ACUTE-CODE is a **closed-source, local-first Windows desktop application** that orchestrates teams of LLM agents to perform real software-engineering work on the user's projects.

**"Local-first" means:** all processing, storage, and orchestration happen on the user's device. Model inference is NOT local — it is obtained over the internet from cloud LLM APIs the user configures (Anthropic, OpenAI, Google, OpenRouter, and any custom OpenAI-compatible endpoint). No local-model runtime (Ollama etc.) in v1.

**Primary success criterion:** the owner can run it easily (double-click an executable in a folder, everything starts), hand it a task, and get correct, auditable work back — with the system remembering context between sessions and the human retaining full control over every consequential action.

### 1.1 Non-goals (v1)
Docker/container sandboxing (disabled "coming later" settings placeholder only) · local models · cloud sync · mobile · multi-user teams · plugin marketplace · Android tooling beyond normal shell-tool invocation of adb/gradle.

## 2. Users & context

Single local user (a developer, the product owner). Machine target: Windows 10/11 x64, 8 GB RAM, ordinary SSD. The user is the sole authority: no agent action outside declared auto-permissions executes without explicit human approval (§F6).

## 3. Fixed technology stack

Changes to this table require the owner's written approval (ADR, `STATUS: PROPOSED` until approved).

| Layer | Choice | Rationale |
|---|---|---|
| Shell | Tauri 2 (Rust) | System WebView2; fraction of Electron's RAM — decisive on 8 GB |
| Frontend | React 18 + TypeScript, Tailwind CSS, shadcn/ui, Zustand, TanStack Query | Fast, typed, themable via CSS variables |
| Agent core | TypeScript / Node.js sidecar | One language across codebase; AI SDK ecosystem; first-class Tauri sidecar support |
| LLM layer | Vercel AI SDK (or equivalent justified by ADR) | Native providers + generic OpenAI-compatible escape hatch |
| Storage | SQLite (WAL), owned exclusively by the sidecar | Single-file, light, zero-config; frontend touches data only via sidecar API |
| IPC | Sidecar serves localhost REST + WebSocket; shell manages lifecycle | Proven client/server pattern; future clients can reuse the core |
| Packaging | pnpm workspaces; Tauri bundler → portable exe first, NSIS/MSI optional | ADR-0002, ADR-0003 |

## 4. Feature requirements

Each feature F1–F11 carries acceptance criteria; phase mapping is in §6.

### F1 — Project workspace manager
Create/open projects; file-tree browser; basic git integration (status, diff, commit) via the shell tool with approvals. Agents operate on the active project. Workspace-scoped file access by default.

### F2 — Agent registry
Full CRUD + duplicate. Agent = first-class entity, editable YAML/JSON, versioned in SQLite: `{ id, name, role, system prompt, model, provider, allowed tools, memory policy, skills, max turns, temperature }`. Ships with editable templates: **Planner, Researcher, Coder, Reviewer, Tester** (templates, never hard-coded).

### F3 — Multi-agent orchestration engine (per ADR-0001)
Three run modes, selectable per session:

1. **Single-agent (DEFAULT).** One agent, one model, full toolset. The zero-configuration path.
2. **Auto-team.** The user states the task; an **orchestrator agent** (routed by default to a cheaper model) analyzes the task, composes a team from the agent templates/registry, and delegates — supplying each worker the context it needs (files, locations, constraints). The **powerful worker model** does the actual heavy lifting. The user watches and can steer, but does not assemble anything.
3. **Manual team (advanced).** The user explicitly picks agents — power-user escape hatch, minimal UI in v1.

Common to all modes: shared message bus between agents; Kanban-style task board with live per-agent task state in the UI; **hard cap of 5 concurrently running agents, queued beyond**; session = one orchestrated run with a full per-agent transcript. The topology (roles, wiring, communication rules) is data, not code — future-proofing for custom team designs.

### F4 — Model provider manager
v1 providers: **Anthropic (native, incl. vision) · OpenAI (native, incl. vision) · Google Gemini (native) · OpenRouter · Custom OpenAI-compatible** (user enters name + base URL + key; app fetches/lists available models — the "everything Cline supports" escape hatch: Groq, DeepSeek, Mistral, Together, Fireworks, …).

- Multiple API keys per provider; per-agent model routing; live usage dashboard (F7).
- **Vision routing:** a dedicated, configurable *vision model* (global default + per-agent override). Image inputs are automatically routed to it for analysis; its result returns to the requesting agent's context.
- **Dev/test note:** development and live testing run against the owner's OpenAI-compatible keys. Native Anthropic/OpenAI/Google adapters are built to spec and validated with recorded fixtures; live-tested when keys become available.
- Explicitly deferred: local models / Ollama.

### F5 — Tool layer
File read/write/edit (workspace-scoped by default) · shell command execution (host, approval-gated) · web search · code execution · **MCP client** for external tool servers. Every tool registers a permission level: `auto` / `confirm` / `blocked`.

### F6 — Human-in-the-loop approval engine (THE SAFETY LAYER)
v1 has no sandbox; this subsystem is the security boundary.

- Triggers a modal approval for: every shell command; every file write outside the active workspace; destructive git operations (reset --hard, force push, branch delete); every outbound network call other than configured LLM providers. Prompt shows: action, full target path/command, requesting agent, plain-language risk note.
- **No "always allow" for destructive categories.** Non-destructive categories may offer "always allow for this project".
- User-configurable command denylist in Settings; **denylist wins over everything**, including agent requests.
- All decisions logged to SQLite (timestamp, agent, action) with an audit-log view in Settings.
- Docker sandbox appears only as a disabled, clearly-labeled "coming later" option.

### F7 — Usage & cost dashboard
Live per-session and historical: tokens (input/output), estimated cost, request count — by agent, project, provider, model, day. Source: per-request telemetry rows written by the provider layer to SQLite.

### F8 — Sessions, history, memory & skills
- Full per-session, per-agent transcripts; session history browsable.
- Persistent per-agent memory: markdown memory notes on disk + indexed in SQLite, user-editable, injected into context per the agent's memory policy (Hermes-inspired).
- **Skills (basic, in v1 per owner decision):** a skill is a folder with a `SKILL.md` (instructions, optionally frontmatter metadata) plus optional scripts/resources. Skills live in global and per-project locations, are user-editable, and are enabled per agent; enabled skills are injected into that agent's context per its policy. No marketplace, no sync — files on disk only.

### F9 — UI screens
1. Dashboard (recent projects, recent sessions, quick-start)
2. Project workspace (file tree, editor hookup, git panel, agent console)
3. Agent registry (list, editor, templates)
4. Session view (live orchestration: task board + agent transcripts + approval prompts)
5. Usage dashboard (F7)
6. Settings (theme, providers & keys, execution/denylist, memory, skills, audit log)

Theming via CSS variables: light/dark/accent, configurable; no other theming work in v1. **The owner will share UI design direction at Phase 2 kickoff — collect it before building screens.**

### F10 — Multimodal input
Composer supports image attachment → routed to the vision model (F4) → result returns to the conversation. No separate pipeline.

### F11 — Distribution & running (per ADR-0003)
The owner must be able to run ACUTE-CODE easily: a folder containing the app executable that starts everything (shell auto-starts the sidecar; SQLite migrates on first run). A conventional installer (NSIS/MSI) is optional polish at Phase 6, not a prerequisite. No admin rights required for normal operation.

## 5. Non-functional requirements

| Requirement | Target |
|---|---|
| Memory, idle (shell + UI + agent core) | < 700 MB combined |
| Memory, 5 agents running | < 2.5 GB total |
| Cold start | < 5 s (measure & report each phase once bootable) |
| Warm start | < 2 s |
| Background behavior | No high-frequency polling; no resident processes beyond app + one sidecar |
| Data locality | All data local; network egress only to configured LLM providers (+ user-initiated web search/MCP tools via approvals) |
| Telemetry | None, and no crash reporting, unless the owner opts in later |
| Secrets | Windows Credential Manager (DPAPI) only — encrypted at rest, never logged, never in the repo, never echoed into transcripts or errors |

## 6. Security, privacy & licensing

- License allowlist for all dependencies: **MIT, Apache-2.0, BSD, ISC, MPL-2.0**. **GPL, AGPL, LGPL forbidden.** CI runs a license audit that fails the build on violations (`docs/compliance/dependency-licenses.md`).
- Closed-source: no open-source LICENSE file in this repo; nothing published to public registries; reference projects are studied for patterns only — copying code requires the owner's prior approval with license analysis attached.
- The approval engine (F6) is treated as security-critical code: complete, unbypassable, denylist-supreme.

## 7. Verification & definition of done

Every phase: unit tests for core modules (orchestration loop, provider adapters, approvals engine, storage); one integration test covering a full multi-agent run; CI green (lint, typecheck, test, build, license audit). The Tester sub-agent verifies each acceptance criterion, and the orchestrator dogfoods the application itself before any phase is reported as done. Phase reports follow the §2.6 format (deliverables, pass/fail checklist, ≤2-min demo, open questions, measured performance).

## 8. Phase plan & exit criteria

| Phase | Scope | Exit criterion |
|---|---|---|
| 0 — Discovery & spec | 9 reference analyses, this SPEC | Owner approves SPEC |
| 1 — Architecture | ARCHITECTURE.md, API contracts, repo skeleton, CI green, SETUP.md | Owner approves |
| 2 — Core skeleton | App boots, sidecar auto-starts, SQLite migrates, provider adapters (live-tested via OpenAI-compatible key), agent CRUD UI, single-agent chat round trip | Owner creates an agent in the UI and completes one conversation |
| 3 — Orchestration | Run loop, message bus, task board, approval engine, all three run modes | Live demo: 3-agent coding task (Planner→Coder→Reviewer) + 2-agent research task; owner watches in UI |
| 4 — Tool layer | File, shell, web search, code exec, MCP client — all through permissions + approvals | Live demo: agent writes & runs a script; approval fires; audit log records it |
| 5 — Dashboard & polish | Usage dashboard on real session data, settings, theming, image attachment/vision routing | Dashboard numbers match a session the owner just ran |
| 6 — Hardening & release | Error handling, logging, README, user guide, portable build (installer optional) | Clean-machine run within performance budget, verified by the orchestrator's own hands-on test |

## 9. Open items

Statuses updated 2026-08-22 by the Scribe against Phase 2 reality.

1. `[NON-BLOCKING]` **OPEN** — Which endpoint/model serves as the dev **vision model**. The original blocker ("decide at Phase 2 with the owner's key list") is half-gone: dev provider keys now exist (OpenRouter via Windows Credential Manager; single allowed model `stealth/ox-alpha`). A vision-capable model is still unchosen and untested — decide before the Phase 5 image-attachment/vision-routing work.
2. `[RESOLVED 2026-08-22]` ~~GitHub private repo + token~~ — done: `testplay-byte/ACUTE-CODE` created and set **private**, PAT lives only in Windows Credential Manager, Actions CI green (`docs/decisions/0012-github-remote-ci.md`).
3. `[RESOLVED 2026-08-22]` ~~Owner UI direction~~ — collected: the owner's three demo projects (setup wizard, dashboard, chat) are the visual spec; design language recorded in `docs/design/ui-direction.md`, implementation plan in `docs/runbooks/plan-ui-fidelity.md`.
