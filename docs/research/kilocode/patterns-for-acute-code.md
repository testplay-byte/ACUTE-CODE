# Kilo Code — Patterns for ACUTE-CODE

Study-only document. Kilo Code is MIT licensed (LICENSE file verified; the package README's stale "Apache 2.0" sentence notwithstanding) — compatible with our allowed dependency set (MIT, Apache-2.0, BSD, ISC, MPL-2.0), but per project constraints we adopt **patterns, never code**.

Mapping context: Kilo = VS Code/JetBrains/CLI clients -> `kilo serve` core (HTTP + SSE, SQLite). ACUTE-CODE = Tauri 2 shell -> React 18/TS UI + Node/TS sidecar (localhost REST + WS) owning SQLite. The structural analogy is nearly 1:1.

---

## Pattern 1 — Thin clients over one core process ("all products are clients of the CLI")

**WHAT (Kilo Code).** The agent loop, tools, permissions, skills, MCP, storage, and LLM providers live exclusively in `packages/opencode` (`@kilocode/cli`). Every front end — VS Code extension (which bundles the CLI binary), JetBrains plugin, TUI, Zed via ACP — is a UI client that spawns/connects to `kilo serve` over HTTP + SSE. One backend is shared per extension host via `KiloConnectionService`. The client SDK (`@kilocode/sdk`) is generated from the server API.

**WHY (fits ACUTE-CODE).** This is exactly our Tauri-shell/sidecar split, proven across four shipping clients. It keeps the React UI free of agent logic, makes the sidecar independently testable headless (like `kilo serve`), and gives one authority for state, permissions, and SQLite.

**HOW (map to our stack).**
- Node/TS sidecar is the sole owner of: agent loop, tool registry, permission engine, SQLite (sessions, messages, agents, skills index), LLM provider clients.
- Sidecar exposes REST for commands and WS for streamed events — the direct analog of Kilo's HTTP + SSE (WS covers what SSE does for them and adds client->server streaming if we ever need it).
- Keep exactly one sidecar instance for the app (our `KiloConnectionService` equivalent: a small connection manager in the Tauri shell that spawns the sidecar, retries, and re-attaches to live sessions on UI reload).
- Maintain one typed API contract shared by sidecar and React UI; if we generate it (OpenAPI/JSON schema -> TS types), mirror Kilo's rule that generated code is never hand-edited.

## Pattern 2 — Agents as declarative files with ordered allow/ask/deny permission rules

**WHAT (Kilo Code).** Agents are Markdown files with YAML frontmatter (`.kilo/agents/<name>.md`): `description`, `model`, `mode` (`primary`/`subagent`/`all`), `permission`, `steps`, `temperature`, etc.; body = system prompt. Permissions are an **ordered rule list** of `allow`/`ask`/`deny` with glob patterns, **last-match-wins**, per tool (`read`, `edit`, `bash`, `glob`, `grep`, `task`, `webfetch`, `websearch`, `todowrite`, `todoread`) and per path (deny `"*"`, allow `"docs/**"`). `permission.task` scopes which subagents an agent may spawn. MCP tools join the same system under namespaced keys `{server}_{tool}`. The settings UI's per-tool dropdowns write the same config the headless CLI reads.

**WHY (fits ACUTE-CODE).** Our human-approval safety layer needs exactly this: one permission pipeline for every tool call — built-in tools and MCP tools alike — evaluated in the sidecar (not the UI), with three outcomes and file/bash scoping. Declarative agents (role prompt + permission set + model) give users shareable, reviewable agent definitions without a plugin runtime.

**HOW (map to our stack).**
- SQLite tables: `agents (slug, name, description, system_prompt, model, mode, steps_max, source)` and `agent_permission_rules (agent_id, ordinal, effect, tool, pattern)`; evaluate in ordinal order, last match wins.
- Optional workspace-portable layer: import/export agents as `.acute/agents/<slug>.md` (Markdown + frontmatter, same field semantics) so teams can commit them; on conflict, workspace beats global (Kilo's precedence: built-ins < global < project).
- The React settings UI edits the same SQLite rows the sidecar enforces — single source of truth, Kilo's key trick of "UI and CLI write the same config."
- Namespacing rule for MCP tools: `{server}_{tool}` permission keys so third-party tools can never shadow built-ins.

## Pattern 3 — Least-privilege built-in agent matrix

**WHAT (Kilo Code).** Built-ins with sharply differentiated tool sets: **Ask** = read-only tools + a read-only bash allowlist (cat, grep, git log/diff, jq) with all writes blocked and MCP per-call approval; **Plan** = read-only plus edits restricted to plan files under `.kilo/plans/`; **Code**/**Debug** = full access; subagents `general` (full minus todo) and `explore` (fast, read-only). `steps` frontmatter caps loop iterations per agent.

**WHY (fits ACUTE-CODE).** Default-deny posture with per-agent escape hatches is the cheapest safety design we can ship; it also demonstrates to users what custom agents look like. Path-restricted write scopes (Plan writes only plan/docs files) map neatly onto our approval layer.

**HOW (map to our stack).**
- Ship 3-4 built-ins stored as seed rows in SQLite: an Ask-equivalent (read tools + `bash` restricted to an allowlist regex/glob; every write attempt -> hard deny), a Plan-equivalent (`edit` allowed only under `docs/` and plan paths), and a full Code-equivalent (still `ask` by default for writes/exec — our approval layer stays on).
- Enforce a `steps_max` per agent (loop bound) in the sidecar's agent loop to cap runaway sessions and cost.
- Keep a read-only `explore`-style subagent as a first-class built-in for cheap parallel research.

## Pattern 4 — Subagents via a `task` tool: context isolation + summary-only return

**WHAT (Kilo Code).** No special orchestration runtime: a full-access agent simply calls the `task` tool to launch another agent (chosen by `description` match or `@name`). The subagent runs in its own session with a separate conversation history; when done, **only a summary returns** to the parent. Multiple subagent sessions run in parallel; `permission.task` bounds what can be spawned. Notably, Kilo **deprecated** its dedicated Orchestrator mode because "agents with full tool access now support subagents natively" — delegation as a capability beat delegation as a persona.

**WHY (fits ACUTE-CODE).** This is the minimal mechanism that satisfies our max-5-concurrent-agents product: one tool, isolated context windows (token control), summary hand-back (parent context stays small), and no orchestrator UI mode to design or deprecate later.

**HOW (map to our stack).**
- `task` is a built-in tool in the sidecar registry: input = target agent slug + prompt; creates a new `sessions` row with `parent_session_id`, own message history, inherits model unless the agent overrides.
- On completion the sidecar injects a single summary message into the parent session (never the full transcript).
- Global concurrency cap = 5 enforced at spawn time: a queue (or simple rejection with retry guidance) in the sidecar; the parent's `task` call blocks/streams until a slot frees.
- UI: a tree view of parent/subagent sessions so users can inspect subagent transcripts even though parents only see summaries (Kilo exposes subagent activity in its UI; the exact viewer component name is [UNVERIFIED]).

## Pattern 5 — Parallel-agent workspace isolation: semaphore + git-worktree-per-agent

**WHAT (Kilo Code).** The VS Code **Agent Manager** runs agents in parallel safely: `semaphore.ts` bounds concurrent operations; `WorktreeManager`/`branch-naming` give each agent its own git worktree + branch; `SetupScriptRunner` bootstraps install/build in fresh worktrees; per-agent terminals are created and routed; `fork-session`/`fork-handoff`/`promotion-handoff` fork a session into a new agent and promote completed work back (via `GitOps`/`git-transfer`, optionally PRs with `gh.ts` + `PRStatusPoller`); `state-recovery` survives window reloads; `prune-subagents` reaps stale agents. (Module roles inferred from verified file names.)

**WHY (fits ACUTE-CODE).** With up to 5 concurrent agents mutating one codebase, collision is the core risk. Worktree isolation converts merge conflicts into an explicit promotion step, and the semaphore + reap + recovery trio is the operational checklist we would otherwise rediscover the hard way.

**HOW (map to our stack).**
- Sidecar owns a `WorktreeManager` equivalent: `.acute/worktrees/<session-id>` per agent session, branch named from session id; setup hook (optional per-project script) runs after creation.
- Semaphore in the sidecar sized to our cap (5); agent spawn requests queue with visible position.
- Promotion flow = explicit user-approved action in our approval layer: diff review in the React UI, then apply to the main worktree (or open a PR) — this is where "human approval" and parallelism meet.
- State recovery falls out of SQLite: sessions/worktrees/queue state persisted; on sidecar restart, re-attach UI to live sessions (Kilo's `state-recovery.ts` validates the need).
- Optional early feature: fork session (duplicate a session + its transcript into a new agent) — cheap in SQLite and Kilo's file names suggest real usage.

## Pattern 6 — Skills with progressive disclosure (open Agent Skills standard)

**WHAT (Kilo Code).** Skills are folders with `SKILL.md` (frontmatter `name` <= 64 chars matching the dir name, `description` <= 1024 chars; optional `scripts/`, `references/`, `assets/`) — docs describe this as implementing "Agent Skills, a lightweight, open format for extending AI agent capabilities". At session start **only name + description are scanned** and injected into the system prompt; the full SKILL.md (and bundled resources) load only when the model decides one applies, surfacing as a `skill` tool call — no keyword/semantic matcher, the LLM judges from descriptions. Sources: `~/.kilo/skills/`, `.kilo/skills/` (project wins), compat dirs (`.agents/skills/` by default, `.claude/skills/` if enabled), `skills.paths`, and remote `skills.urls` whose servers must host an `index.json` manifest; `/reload` rescans mid-session.

**WHY (fits ACUTE-CODE).** Near-zero-context-cost extensibility that interoperates with a growing ecosystem (Kilo, Claude-compatible layouts) while staying local-first. Progressive disclosure keeps our system prompts small — the difference between a toy and a scalable skill library.

**HOW (map to our stack).**
- Sidecar scans `.acute/skills/` (workspace) and a global skills dir at session start; parses frontmatter only; stores the index in SQLite (`skills (name, description, version, origin_path)`); injects the compact index into the system prompt.
- Reading a full SKILL.md is itself a permission-gated tool call (`skill_read`) so the approval layer stays in control; bundled `scripts/` execute only via the normal `bash` tool + permission rules (never auto-run).
- Remote skill sources: fetch `index.json`, cache in SQLite, and refresh safely on change (Kilo requires remote servers to serve `index.json`; its exact cache-swap semantics are [UNVERIFIED]).
- Ship our internal ACUTE skills (ADR, phase-report, dispatch-research) in this format so the product dogfoods its own mechanism.

## Pattern 7 — Marketplace as files, not plugins

**WHAT (Kilo Code).** The Marketplace installs three item types — Agent (`.kilo/agents/<name>.md`), Skill (`.kilo/skills/<name>/`), MCP server (an entry under `mcp` in `kilo/kilo.json`) — described as "configuration and instruction files, not VS Code extensions." Two scopes (project vs global, project wins); registry is a GitHub repo (`Kilo-Org/kilo-marketplace`); installed items are picked up by the ordinary config loaders, and installing an MCP server "does not automatically approve every tool call" — permissions still apply.

**WHY (fits ACUTE-CODE).** A file-based marketplace avoids a plugin runtime, sandboxing story, and supply-chain surface — everything installed is data our existing loaders and permission system already govern. Perfect fit for local-first closed-source: the registry can be a git repo or a bundled index.

**HOW (map to our stack).**
- Registry = a static index (git repo or JSON shipped with the app) listing agents/skills/MCP-server configs; the sidecar downloads and writes files to workspace (`.acute/...`) or global scope; an `origin` column in SQLite tracks provenance for uninstall/updates.
- MCP server install = adding a row to our MCP config (SQLite or `config.json`), never auto-allowing its tools: new MCP tools start at `ask`.
- Improve on Kilo: apply installs via hot-reload of the affected loader only, without interrupting running sessions (Kilo docs admit full config reload can interrupt sessions).

## Pattern 8 — Checkpoints (snapshots) for undoable agent steps

**WHAT (Kilo Code).** The core has a `snapshot/` module: git-backed file baselines captured before/after agent edits, stored in a **separate git directory per worktree** under `${data}/snapshot/<project-id>/<worktree-hash>`, powering diffs and revert flows. Agent Manager turns request `snapshotInitialization: "wait"` so baseline capture never blocks parallel sessions; a process-wide slow-snapshot guard caps runaway captures, and slow interactive tracking prompts after ~10 seconds. (Verified from CLI Runtime docs + what's-new page; module internals not read.)

**WHY (fits ACUTE-CODE).** Human approval is much easier to grant when every step is reversible; checkpoints also implement "undo last agent action" cheaply.

**HOW (map to our stack).** Sidecar snapshots affected files before each edit-batch (content-addressed blob table in SQLite or `git stash`-style commits in the worktree); UI exposes per-step revert. With Pattern 5 worktrees, per-agent revert = drop the worktree.

---

## What to avoid (with reasons)

1. **Blanket "auto" modes (`kilo run --auto` disables ALL permission prompts).** Directly violates ACUTE-CODE's human-approval safety layer; even Kilo restricts it to "trusted environments." If we add a CI mode, scope it per-tool/per-path via the normal permission rules rather than a global off switch.
2. **Delegation-as-a-mode (the deprecated Orchestrator pattern).** Kilo itself retired it: a dedicated orchestrator persona adds mode-switching UX and still needs the same `task` tool underneath. Build delegation as a capability of full-access agents from day one.
3. **Effect 4 beta + 15 patched dependencies as the sidecar's foundation.** Powerful but operationally heavy (they maintain local patches of effect, solid-js, even the MCP SDK). Our sidecar is small; plain TypeScript with zod and a thin HTTP+WS layer is the right size.
4. **Full config reload on marketplace installs.** Kilo's docs note "sessions may reload after changes." Design per-loader hot-reload from the start (our SQLite-backed loaders make this easy).
5. **Migrating UI frameworks mid-flight (React -> SolidJS).** Kilo's webview is now SolidJS 1.9 with Storybook/xterm/dnd rebuilt for it — evidence of a costly rewrite, not a reason to avoid React. ACUTE-CODE stays React 18/TS.
6. **Fork-merge machinery (`kilocode_change` markers, upstream-sync ratchets).** Only sensible when tracking a live upstream (their OpenCode fork). We build original code; adopting marker discipline would be pure overhead.
7. **Doc/license drift.** Their repo literally ships a README claiming Apache-2.0 over MIT LICENSE files. Process lesson: ACUTE-CODE should generate license metadata from the LICENSE file / package manifest, not hand-written prose.
8. **Copying code instead of patterns.** License (MIT) would even permit it, but our constraint is pattern adoption only; Kilo's internals are also entangled with their OpenCode fork and Kilo cloud service, making lifted code a liability, not a shortcut.

## Sources

- https://github.com/Kilo-Org/kilocode
- https://raw.githubusercontent.com/Kilo-Org/kilocode/main/AGENTS.md
- https://raw.githubusercontent.com/Kilo-Org/kilocode/main/README.md
- https://github.com/Kilo-Org/kilocode/blob/main/package.json
- https://raw.githubusercontent.com/Kilo-Org/kilocode/main/packages/opencode/package.json
- https://github.com/Kilo-Org/kilocode/tree/main/packages
- https://github.com/Kilo-Org/kilocode/tree/main/packages/opencode/src
- https://github.com/Kilo-Org/kilocode/tree/main/packages/kilo-vscode
- https://github.com/Kilo-Org/kilocode/tree/main/packages/kilo-vscode/src
- https://github.com/Kilo-Org/kilocode/tree/main/packages/kilo-vscode/src/agent-manager
- https://raw.githubusercontent.com/Kilo-Org/kilocode/main/packages/kilo-vscode/package.json
- https://raw.githubusercontent.com/Kilo-Org/kilocode/main/packages/kilo-vscode/README.md
- https://raw.githubusercontent.com/Kilo-Org/kilocode/main/packages/kilo-gateway/README.md
- https://kilo.ai/docs
- https://kilo.ai/docs/code-with-ai/platforms/vscode/whats-new
- https://kilo.ai/docs/contributing/architecture
- https://kilo.ai/docs/contributing/architecture/cli-runtime
- https://kilo.ai/docs/contributing/architecture/vscode-extension
- https://kilo.ai/docs/code-with-ai/agents/using-agents
- https://kilo.ai/docs/code-with-ai/agents/orchestrator-mode
- https://kilo.ai/docs/customize/custom-modes
- https://kilo.ai/docs/customize/custom-subagents
- https://kilo.ai/docs/customize/skills
- https://kilo.ai/docs/customize/marketplace
- https://kilo.ai/docs/automate/mcp/using-in-kilo-code
