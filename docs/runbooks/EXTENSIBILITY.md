<!-- last-reviewed: 2026-09-07 round-71 -->
# EXTENSIBILITY — plugins, skills, MCP servers (owner's guide)

**Status:** normative · **Established:** round-61 (owner directive: "the
ability to add multiple skills… the ability to add MCP servers too" —
multi-plug-in tooling was the R52 directive) · **Audience:** the owner
adding capabilities, and any agent extending the toolset

ACUTE-CODE has **four extension surfaces**. This runbook tells you which to
use, how to write each, and where the honesty gates live. The prompt-module
system (per-project system-prompt section overrides) is a FIFTH surface
with its own runbook: [PROMPT-MODULES](PROMPT-MODULES.md) (R59).

## Which surface when

| Surface | Use it when | Where it lives | Gating |
|---|---|---|---|
| **External plugin (.mjs)** | You want NEW TOOLS (new model-callable capabilities) in code | `~/.acute/plugins/` (user) or `<project>/.acute/plugins/` (project, opt-in) | Tool-name grammar + agent allowlist; in-process, full trust |
| **Skill** | You want new BEHAVIOR/CONVENTIONS without code (prompt modules the agent loads on demand) | Settings → Skills (the `skills` table) **+ files on disk since R70**: `<project>/.acute/skills/<name>/SKILL.md` and `~/.agents/skills/` | Enabled flag (DB rows) / existence (files); body loaded via `read_skill` (progressive disclosure; sticky since R70) |
| **MCP server** | You want to attach an EXTERNAL tool server (the wide ecosystem — filesystems, browsers, APIs) | Settings → MCP (the `mcp_servers` table) | Owner-configured only; tools bridge as `mcp__<server>__<tool>` |
| **Built-in plugin catalog** | You want to SEE what's shipped + what each plugin contributes | `GET /plugins` (the Extensions surface) | Read-only; the catalog is computed from real declarations |

Rule of thumb: **behavior → skill; tools → plugin; external server → MCP**.

## 1. External plugins (.mjs files)

The tool layer is a plugin registry (`agent-core/src/tools/registry.ts`,
ADR-0025). The 13 built-in plugins are in-repo
(`agent-core/src/tools/plugins/*.ts`); external ones are plain ES modules
you drop on disk:

- `~/.acute/plugins/*.mjs` — user scope, loaded by default (your machine,
  your files — trusted like `~/.vscode/extensions`).
- `<project>/.acute/plugins/*.mjs` — project scope, **opt-in** (settings
  `tools.externalPlugins="all"`; default `"user"`, `"off"` disables). A
  cloned repo planting a plugin file must never earn code execution on
  open.

External plugins run **in-process with full trust**; the agent-allowlist is
the only gate (agents must be granted the tool names; an empty allowlist =
ALL tools includes externals). Caps: ≤32 plugins / ≤64 tools per load.
Load failures are fail-soft and honest — a broken plugin is skipped with a
logged diagnostic (`plugin.invalid` / `plugin.load_failed` / name-collision
warnings in the sidecar log) and NEVER blocks the rest; `GET /plugins`
reports each file with a `loaded:true|false` bit and the honest note that
load errors live in the engine log.

### A working external plugin

A `.mjs` module that **default-exports** plugin metadata plus a plain
`tools` array (this is the external shape — the registry wraps the plain
JSON Schemas itself; `inputSchema` is accepted as an alias for `schema`):

```js
// ~/.acute/plugins/hello-plugin.mjs
export default {
  id: "hello-tools",            // slug: letters/digits/-/_ (no spaces)
  name: "Hello Tools",
  version: "1.0.0",
  description: "Greets the project (a minimal example plugin).",
  category: "external",         // any lowercase word
  tools: [
    {
      name: "say_hello",        // MUST match ^[a-z][a-z0-9_]{1,31}$
      description: "Say hello to someone. Returns a greeting.",
      schema: {                 // plain JSON Schema object
        type: "object",
        properties: { who: { type: "string", description: "who to greet" } },
        required: ["who"],
      },
      execute: async (input) => ({
        ok: true,
        output: `hello, ${String(input.who ?? "world")}`,
      }),
    },
  ],
};
```

Save it, restart the engine (plugin files are read at first use per root),
and the agent's toolset gains `say_hello`. Every tool MUST have a
non-empty description, an object schema, and a function `execute` —
anything else is rejected with a logged reason (fail-soft). The full
contract (name grammar, collision rules, the load-scope matrix) is
`agent-core/src/tools/registry.ts`; the executable fixture this example
mirrors is `agent-core/tests/r52-plugin-registry.test.ts`.

Built-in plugins (in-repo) use the richer `PluginDefinition` shape —
`createTools(ctx)` returning `ToolDefinition[]` with per-turn context
(`root`, `toolDeps`) and settings gating (that is how computer-use stays
dark until its master switch flips). External modules cannot use `ctx`
(design: externals are static tool lists; built-ins are code).

## 2. Skills (Settings → Skills + files on disk since R70)

A skill is a SKILL.md-style prompt module with **progressive disclosure**:
every enabled skill's **name + one-line description** ride each turn's
system prompt (the `SKILLS (load with read_skill)` section); the **body**
loads only when the model calls `read_skill("name")`. Long procedures stay
out of context until needed. Since R70 a loaded body is **STICKY** — it
persists with a 60K budget and skips the replay stub, so a loaded
instruction set survives the whole task (the prompt teaches the reload
affordance for the last-resort 8K truncation case).

Skills come from THREE places (one merged view — `GET /skills`, with
provenance since R70):

- **Built-ins (12 since R71)**: `computer-use` (the behavioral contract
  from the spec's doc-09, condensed — gated on the computer-use master
  switch) plus the R70 seeds `code-review`, `debugging`, `testing`,
  `git-workflow`, `web-research`, `project-init` (writes the project's
  AGENTS.md from codebase analysis), and `browser-use` (the
  embedded-browser craft) — and the R71 discipline seeds
  `focused-fix`, `zero-hallucination`, `self-eval`, `ship-gate`. All
  descriptions follow the R71 trigger-rich convention (see the R71
  addendum below). Built-ins can be **edited** (your text overrides the
  seed) or **disabled**, but never deleted — deletion is refused with a
  note (the seed would recreate them; a deleted row even revives on
  reopen).
- **User skills (DB)**: full CRUD. Name is a lowercase slug (letters/
  digits/dashes, 2–64 chars, unique); description ≤500 chars (the
  prompt line); body ≤60 000 chars (the `read_skill` payload).
- **File skills (R70, the Agent-Skills standard)**: `<projectRoot>/.acute/
  skills/<name>/SKILL.md` (or a flat `<name>.md` directly in that dir)
  and `~/.agents/skills/<name>/SKILL.md` (user-global — the CROSS-AGENT
  directory, so the same folder works in other agents too). Tolerant
  frontmatter (`name`/`description`; a valid frontmatter name wins over
  the dir name; no frontmatter → the slug + a generic description);
  caps description ≤500, body ≤60K, ≤32 per source. Discovered fresh
  each turn; bodies are read from disk at CALL time, so a deleted file
  de-lists honestly. File skills are READ-ONLY — edit/delete in the UI
  gets the honest 409 "file-defined skill: edit the SKILL.md".

**Precedence**: a DB row with the same name shadows the file in ANY
state (enabled or disabled — "hidden, not fall-through"; creating a DB
skill with the file's name is the documented override path). Project
file beats global file. **The agent form's skill allowlist**
(`agent.skills`, live since R70 — the field was stored and patched
since R61 but never read): a non-empty list filters the whole merged
set for that agent; empty or absent = all skills.

Enabled skills ride EVERY turn's system prompt — keep descriptions
one-line; put the detail in the body.

### A working skill (Settings → Skills → New skill)

- Name: `testing-conventions`
- Description: `How this repo's tests are written and verified.`
- Body:

```markdown
# Skill: testing-conventions

- Tests are vitest; frontend suites opt into happy-dom per-file with a
  `// @vitest-environment happy-dom` docblock.
- Never assert on timeouts — poll for the outcome (disk state, DOM string).
- Every bug fix lands WITH the test that pins it.
- Run `pnpm lint && pnpm typecheck` before claiming done; run the touched
  suite with `npx vitest run <file>`.
```

Then ask the agent something test-related; the prompt lists
`testing-conventions` and the model calls `read_skill` when it matches.
`read_skill` is a global capability (always in the toolset when deps
exist; template agents' allowlists gained it via migration 0023; explicit
user-curated allowlists can add it in the agent form; since R70 it is
ALSO a plan-mode tool — the loader is not dark in read-only posture).

Or skip the UI entirely — drop a file (R70, the Agent-Skills standard;
the same shape other agents read):

```
<project>/.acute/skills/testing-conventions/SKILL.md
---
name: testing-conventions
description: How this repo's tests are written and verified.
---
# Skill: testing-conventions

(the same body as above)
```

No database row at all: the file is discovered per turn, appears in the
SKILLS prompt section and in Settings → Skills (marked as a project
file, `source: "project-file"`, with its `filePath`), and its body
loads from disk when `read_skill` is called.

## 3. MCP servers (Settings → MCP)

Attaches external stdio MCP servers (the Model Context Protocol ecosystem).
You configure the command; the engine spawns the child and speaks JSON-RPC
(initialize → tools/list → tools/call), and the server's tools join the
per-turn toolset as **`mcp__<server>__<tool>`** (the server name is a
≤32-char slug so the combined id fits the 32-char tool-name grammar —
longer names are skipped with a logged diagnostic, never truncated).

Safety properties:

- **Owner-configured only** — server rows are written through the settings
  UI / authenticated REST; the model can never add or edit a server.
- **Sanitized env** — the child inherits only PATH/HOME/TMPDIR/LANG/LC_ALL/
  TERM/SYSTEMROOT/USERPROFILE/APPDATA plus YOUR configured env keys; every
  `ACUTE_PROVIDER*` name is stripped even from configured entries — no
  ACUTE credential can ever reach a third-party server.
- **Fail-soft** — a server that fails to spawn/initialize contributes no
  tools (logged, one-strike per config: the next call respawns once after
  a config change or probe). Disabled servers contribute nothing; deleting
  a server kills its child process.
- **Probe + tools list** — Settings → MCP has a Probe button
  (`reachable · N tools · X ms` or the honest error) and an expandable
  tools panel (the live `tools/list`).

### Adding a server (Settings → MCP → Add server)

- Name: `everything` (slug, 2–32 chars)
- Command: `npx`
- Args: `-y @modelcontextprotocol/server-everything`
- Env: `KEY=VALUE` lines (optional; only what the server needs)

The child is spawned by the engine with the sanitized env; probe it, list
its tools, and its `mcp__everything__*` tools appear in the next turn's
toolset (when the server is enabled). `tools/call` output is capped at
16 000 chars per call.

## 4. The built-in plugin catalog (`GET /plugins`)

One authenticated call returns the whole extension picture:
`plugins` (the 13 built-ins' id/name/version/category/description — the
computer-use plugin is listed even while its master switch is OFF: the gate
is settings, not existence), `tools` (the live computed catalog — gated
plugins contribute nothing), and `external` (the .mjs file report: user +
project files with loaded bits + the honest load-error note). The
`?projectId=` query scopes the external-file report to that project's root.

## Writing vs wiring — where each lands

| Change | File(s) |
|---|---|
| External plugin | drop a `.mjs` in `~/.acute/plugins/` (no repo change) |
| Skill | Settings UI → `skills` table → prompt section + `read_skill` |
| MCP server | Settings UI → `mcp_servers` table → `mcp/manager.ts` child |
| Built-in plugin (new tool group) | `agent-core/src/tools/plugins/<name>.ts` + registry import + tests |
| Settings-gated surface (like computer-use) | storage accessors + `createTools` gate + migration |

## The R66 addendum (what grew this round)

- **`browser_control`'s action surface grew to 15 actions.** The
  embedded-browser tool (the `core-browser` plugin, always-on like
  `web_fetch` since R43) gained the HIGH-LEVEL page actions —
  `click` / `type` (with `submit:true` → native `form.requestSubmit`) /
  `press_key` (Enter in a form submits it) / `read_dom` (a structured page
  outline) / `source` (html | css | scripts) / `wait_for_verification`
  (the owner-solvable bot-wall checkpoint) — all riding the SAME
  eval bridge the R62 `eval` action built (one script per action; user
  input embedded via `JSON.stringify` only). Desktop-only actions refuse
  honestly in web dev mode. See [EMBEDDED-BROWSER](EMBEDDED-BROWSER.md).
- **`analyze_image` — the general vision tool.** A NEW built-in plugin
  (`core-vision`, category `vision`) registers `analyze_image {path?|url?,
  instruction?}` for EVERY turn with a database — unlike the
  settings-gated computer-use tools it is ALWAYS-REGISTERED vocabulary:
  **`TOOL_NAMES` is 25 tools now**, `analyze_image` among them, and
  migration `0026_analyze_image_tool.sql` appends it to existing
  EXPLICIT allowlists (template rows + the default agent only, and only
  rows that already carry `web_fetch` — `[]` rows mean ALL tools and user
  curation is never widened). The tool describes a local image file
  (png/jpg/webp/gif/bmp, ≤8 MB) or an http(s) URL through the GLOBAL vision
  configuration — Settings → Image Analysis (migration 0025 moved it out
  of Computer Use); vision OFF is the honest refusal that points there.
- The plugin count 12 → 13 (`core-vision`), and the computer-use plugin
  grew `find_elements` (its 31st tool — still settings-gated, deliberately
  NOT `TOOL_NAMES` vocabulary; see [COMPUTER-USE](COMPUTER-USE.md)).

## The R70 addendum (the skills system round)

- **File-based skills (the Agent-Skills standard).** Skills now also come
  from disk — `<projectRoot>/.acute/skills/<name>/SKILL.md` (or a flat
  `<name>.md`) and user-global `~/.agents/skills/<name>/SKILL.md` — with
  tolerant frontmatter, caps (description ≤500, body ≤60K, ≤32 per
  source), and read-only semantics (`PATCH`/`DELETE` on a file-skill's
  synthetic id → 409 "file-defined skill: edit the SKILL.md"). DB rows
  take precedence over files in any state; the listing (`GET /skills`)
  merges everything with provenance (`source` gains `project-file` /
  `global-file`, plus `filePath` and `projectName`; bodies read from disk
  at call time). §2 above carries the full contract.
- **EIGHT built-in skills now (was 1).** The same `INSERT OR IGNORE`
  seeding grew `code-review` (1,362 chars), `debugging` (1,398),
  `testing` (1,138), `git-workflow` (1,298), `web-research` (1,185),
  `project-init` (1,468 — the /init skill that WRITES the project's
  AGENTS.md from codebase analysis; the file auto-loads since R70), and
  `browser-use` (1,822 — the embedded-browser craft the prompt's
  browser-panel section used to carry in full). Existing databases get
  them on next open; user edits persist; a deleted row revives on
  reopen.
- **Sticky bodies.** `read_skill` + `memory_recall` results persist with
  a 60K budget (was the 4K head+tail mangle) and skip the 200-char
  replay stub — a loaded instruction set survives the whole task; the
  last-resort context cap truncates to 8K with an honest reload marker
  (the prompt teaches "call read_skill again").
- **The computer-use skill is gated on the master switch** — while
  computer use is OFF the skill is absent from the prompt index and
  `read_skill` refuses it ("computer use is disabled in settings … its
  tools are dark"); dark tools are no longer advertised. `read_skill`
  also joined `PLAN_MODE_TOOLS` (the SKILLS section is advertised in
  plan mode, so the loader must not be dark there).
- **`agent.skills` is wired** — the per-agent allowlist in the agent form
  (stored and patched since R61, never read before): non-empty = a name
  allowlist over the whole merged set (builtin + user + file skills);
  empty/absent = all. One shared resolver (`storage/skills-files.ts`
  `resolveEffectiveSkills`) feeds BOTH the prompt's SKILLS section and
  `read_skill`, so they can never disagree.

## The R71 addendum (the trigger surface + the discipline skills)

- **TWELVE built-in skills now (was 8).** Four new discipline seeds
  (same `INSERT OR IGNORE` contract, sortOrder 8-11 — existing DBs get
  the rows on next open, user edits persist): `focused-fix` (the Iron
  Law — NO FIXES WITHOUT COMPLETING SCOPE → TRACE → DIAGNOSE FIRST,
  with 3-strike escalation), `zero-hallucination`
  ([KNOWN]/[ASSUMED]/[UNKNOWN] evidence tagging + the YAGNI ladder),
  `self-eval` (ambition×execution scoring, mandatory devil's advocate),
  and `ship-gate` (intercepts deploy-intent with a DO NOT SHIP / SHIP
  WITH NOTES / CLEAR verdict).
- **The trigger-rich description convention.** Every builtin
  description now reads "Use when [quoted user phrasings]. [what it
  delivers]. NOT for [adjacent case]." — because the description is the
  ONLY thing the model sees at trigger time (the body loads later via
  `read_skill`). Write YOUR skills' descriptions the same way: quote
  the phrasings a user would actually type, say what it delivers, and
  name the nearest adjacent skill in the negative scope so the model
  can choose between siblings. Keep it ≤500 chars (the storage cap).
- **Description updates do not overwrite user-edited rows** — the
  seeding is INSERT OR IGNORE, so a DB that already has a builtin row
  keeps its text (fresh installs and revived deleted rows get the new
  text). If you want the newest seed text on an old install: delete the
  row and reopen, or edit it by hand.

## Troubleshooting

- **A plugin file exists but `loaded:false`** — read the sidecar log
  (offline screen → engine log): invalid shape, name grammar, collision, or
  a spawn/import error; the note in `GET /plugins` says the same.
- **Skill not in the prompt** — it must be `enabled` (the toggle) and its
  description is the line you'll see; check the SKILLS section exists
  (no enabled skills = no section). A FILE skill needs its SKILL.md on
  disk at the project root (`.acute/skills/`) or `~/.agents/skills/` —
  it disappears when the file does. The computer-use builtin is absent
  while the master switch is off (by design — dark tools are not
  advertised).
- **Skill edit refused with 409 "file-defined skill"** — that skill comes
  from a SKILL.md file, not the database; edit the file (the listing's
  `filePath` names it) or create a DB skill with the same name to
  override it.
- **MCP probe fails** — the honest error names the stage (initialize
  failed / tools/list failed / spawn failed). Check the command resolves
  (`npx -y <pkg>` on PATH), then re-probe (a probe resets the one-strike
  failure). Tools panel shows the in-band `error` field too.
- **`mcp__…` tool name too long** — rename the server (≤32-char slug).

## See also

- [COMPUTER-USE](COMPUTER-USE.md) — the biggest extension surface of R61
- [PROMPT-MODULES](PROMPT-MODULES.md) — per-project system-prompt
  section overrides (R59)
- [TESTING](TESTING.md) — the r52-plugin-registry + skills-mcp suites
- [MAINTENANCE](MAINTENANCE.md) — the how-to-add-a-tool recipe
- Code map: `agent-core/src/tools/registry.ts` (loader, grammar, caps,
  catalog), `agent-core/src/tools/plugins/` (13 built-ins — incl.
  `vision.ts`, the R66 core-vision plugin), skills storage
  `agent-core/src/storage/skills.ts` (the 12 builtins) +
  `agent-core/src/storage/skills-files.ts` (file discovery, the shared
  resolver, the merged listing), MCP storage
  `agent-core/src/storage/mcp.ts` + client `agent-core/src/mcp/manager.ts`,
  routes in `agent-core/src/server.ts` (ROUND-61 section), settings UI in
  `src/components/settings/{SkillsTab,McpTab}.tsx`.
