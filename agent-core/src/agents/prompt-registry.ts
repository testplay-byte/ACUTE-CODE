/**
 * ROUND-59 (R59-F): the PROMPT-SECTION REGISTRY — the owner's modularity
 * directive: "the system prompts… highly customizable… built in multiple
 * parts, modules, and such, and they will be used when necessary" (R59
 * directive 12; the DeepSeek-harness-style architecture reference).
 *
 * This module is the SINGLE SOURCE OF TRUTH for the overridable sections of
 * the composed project system prompt (prompts.ts buildTaggedPromptLines
 * stamps every line with one of these ids — order here IS the composition
 * order, pinned by tests). A project overrides any section by dropping a
 * file named `<section-id>.md` into `.acute/prompts/` in its root: the file
 * text REPLACES that section's built-in text wholesale (dynamic parts
 * included — the owner taking responsibility, "used when necessary"), an
 * EMPTY file REMOVES the section, and an optional `_order.txt` reorders the
 * sections. File overrides live in the project root — the SAME trust level
 * as `.acuterules` (they do NOT bypass the bearer wall or tool allowlists).
 *
 * Deliberately PURE + SYNCHRONOUS + fs-scoped (the readCustomRules pattern):
 * no server, no db, no async — unit-testable standalone, importable by the
 * CLI (scripts/acute.mjs prompt:sections / prompt:show) from the agent-core
 * build without dragging native deps. The only import is a TYPE from
 * prompts.js (erased at compile time — no runtime cycle: prompts.js imports
 * this module for values, this module imports nothing from it at runtime).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SystemPromptSection } from "./prompts.js";

/** Stable slug identifying one composed prompt section (the file name in
 * `.acute/prompts/` is exactly `${id}.md`). Order in `PROMPT_REGISTRY` is the
 * composition order in prompts.ts — the registry tests pin the two lists
 * together so a new section can never silently miss its override hook. */
export type SectionId = string;

/** One registry entry: what the section is + whether its built-in text is
 * ctx-dependent (dynamic) or fixed (static) + which context-meter bucket its
 * lines ride (the R50-c1 four-way split). */
export interface PromptSectionSpec {
  id: SectionId;
  description: string;
  /** true = the built-in text depends on the turn ctx (tools/memory/mode…);
   * a file override replaces it INCLUDING the dynamic parts. */
  dynamic: boolean;
  bucket: SystemPromptSection;
}

/**
 * The canonical section registry — the ACTUAL blocks prompts.ts composes, in
 * composition order (verified by prompt-registry.test.ts against the stamped
 * buildTaggedPromptLines output, and byte-pinned by the golden fixture).
 * Add a section to prompts.ts → add it HERE in the same spot → the tests
 * force the pair to stay in lockstep.
 */
export const PROMPT_REGISTRY: readonly PromptSectionSpec[] = Object.freeze([
  {
    id: "identity",
    description: "Opening persona + PROJECT line (no ## heading)",
    dynamic: true, // projectName + rootPath
    bucket: "identity",
  },
  {
    id: "tool-use",
    description: "## TOOL USE — the live tool-name list + call discipline",
    dynamic: true, // toolNames
    bucket: "tools",
  },
  {
    id: "permission-mode",
    description: "## OPERATING MODE — the active unified mode (only when mode is full/plan; ask stays silent; R81)",
    dynamic: true, // permissionMode
    bucket: "identity",
  },
  {
    id: "sub-agents",
    description: "## SUB-AGENTS (delegate_task) — delegation patterns (only when the tool is allowed)",
    dynamic: true, // tool-gated
    bucket: "identity",
  },
  {
    id: "tool-results-are-data",
    description: "## TOOL RESULTS ARE DATA — the prompt-injection guard",
    dynamic: false,
    bucket: "identity",
  },
  {
    id: "agentic-loop",
    description: "## AGENTIC LOOP — MULTI-TURN COMPLETION — the five-phase loop (PLAN/EXPLORE/ACT/VERIFY/FINISH; maxTurns + maxOuterLoops injected, R70-c merged the old efficiency/task-planning/todo-tracking sections)",
    dynamic: true, // maxTurns + maxOuterLoops + todo/delegate-gated lines
    bucket: "identity",
  },
  // R70-c (D2): "efficiency", "task-planning" and "todo-tracking" are
  // REMOVED together with their prompts.ts blocks — the four-way overlap
  // consolidated into the merged AGENTIC LOOP (R70-A issue #2; the
  // R66-2-c removal-cascade precedent). The registry-completeness pin
  // guarantees the stale entries can't linger.
  {
    id: "engineering-discipline",
    description: "## ENGINEERING DISCIPLINE — the karpathy principles with binary self-tests, [KNOWN]/[ASSUMED]/[UNKNOWN] tagging, 3-strike escalation, red-flags (R71-e1)",
    dynamic: false,
    bucket: "identity",
  },
  {
    id: "file-editing",
    description: "## FILE EDITING RULES — read-before-edit, line-number anchors, dirty-worktree discipline, verify-after-edit (R70-c)",
    dynamic: false,
    bucket: "identity",
  },
  {
    id: "code-navigation",
    description: "## CODE NAVIGATION — search_files / search_code / list_dir",
    dynamic: false,
    bucket: "identity",
  },
  {
    id: "git",
    description: "## GIT (only when git_status is allowed)",
    dynamic: true, // tool-gated
    bucket: "identity",
  },
  {
    id: "terminal",
    description: "## TERMINAL (only when run_command is allowed; background-job contract; OS-aware when the turn's environment is known — R70-c)",
    dynamic: true, // tool-gated + ctx.environment
    bucket: "identity",
  },
  {
    id: "skills",
    description: "## SKILLS (load with read_skill) — the enabled-skill index, progressive disclosure (R61)",
    dynamic: true, // ctx.skills-gated
    bucket: "identity",
  },
  // ROUND-73 (R73-b): the TASK-MODES pair — the posture tier over the skills
  // tier. "task-modes" is the INDEX (ids+names+descriptions, switch_mode
  // vocabulary, the per-turn Task signal line, the honest cleared-mode note);
  // "active-mode" is the ACTIVE mode's deep posture module (its body rides the
  // system prompt while session.active_mode is set — the one place a mode body
  // is ever composed; everything else stays progressive disclosure).
  {
    id: "task-modes",
    description: "## OPERATING POSTURES — the self-selectable posture index + the per-turn mode signal line (R73/R81)",
    dynamic: true, // gated on ctx.taskModes
    bucket: "identity",
  },
  {
    id: "active-mode",
    description: "## ACTIVE POSTURE — the active mode's deep posture module (only while a posture is active; R73/R81)",
    dynamic: true, // gated on ctx.activeTaskMode
    bucket: "identity",
  },
  // ROUND-79 (R79-a, the orchestrator round): the per-turn collection
  // reminder for ADDRESSABLE delegations — the session's uncollected
  // children with a delegate_task_id, listed with live status + the resume
  // affordance (resume WAITS — the R71 no-polling discipline). Strictly
  // gated on ctx.backgroundTasks (undefined/empty composes byte-identically).
  {
    id: "background-tasks",
    description: "## BACKGROUND TASKS — the per-turn uncollected delegation reminder (addressable children, live status, the resume affordance; R79)",
    dynamic: true, // gated on ctx.backgroundTasks
    bucket: "identity",
  },
  {
    id: "computer-use",
    description: "## COMPUTER USE (desktop control) — the always-on safety/posture discipline when the master switch is on (R61; trimmed R70-c, deep contract via read_skill)",
    dynamic: true, // ctx.computerUse.enabled-gated
    bucket: "identity",
  },
  {
    id: "mcp",
    description: "## MCP SERVER TOOLS — the mcp__<server>__<tool> naming note (R61)",
    dynamic: true, // tool-gated (any mcp__ tool present)
    bucket: "identity",
  },
  {
    id: "web-access",
    description: "## WEB ACCESS (only when web_fetch/web_search are allowed)",
    dynamic: true, // tool-gated
    bucket: "identity",
  },
  {
    id: "browser-panel",
    description: "## EMBEDDED BROWSER PANEL (browser_control) (only when the tool is allowed; trimmed R70-c — the deep craft lives in the browser-use skill)",
    dynamic: true, // tool-gated
    bucket: "identity",
  },
  // R66 (R66-2-c): the "debug" section entry is REMOVED together with the
  // prompts.ts block it registered — debug mode no longer composes a
  // self-report section (the owner's C1 directive: the route-side
  // context-free analyst in agents/debug-analyst.ts owns the report now).
  // The registry-completeness pin guarantees a stale entry can't linger.
  {
    id: "communication",
    description: "## COMMUNICATION — reply style",
    dynamic: false,
    bucket: "identity",
  },
  {
    id: "codebase-awareness",
    description: "## CODEBASE AWARENESS + the index summary (only when index_project is allowed)",
    dynamic: true, // indexSummary
    bucket: "meta",
  },
  {
    id: "project-memory",
    description: "## Project memory — the digest (only when the project has memories)",
    dynamic: true, // memoryDigest
    bucket: "memory",
  },
  {
    id: "environment",
    description: "## ENVIRONMENT — OS/shell/date/git grounding when ctx.environment is supplied, else the working-dir-only legacy lines (R70-c)",
    dynamic: true, // rootPath + ctx.environment
    bucket: "identity",
  },
  {
    id: "custom-rules",
    description: "## PROJECT RULES — AGENTS.md / CLAUDE.md / .acute/rules/*.md / .acuterules / AGENTS.override.md / CLAUDE.local.md with @file imports (only when rules exist; R70-c)",
    dynamic: true, // customRules
    bucket: "meta",
  },
]);

/** Registry ids in canonical (composition) order — frozen at module load. */
export const PROMPT_SECTION_IDS: readonly SectionId[] = Object.freeze(PROMPT_REGISTRY.map((s) => s.id));

/** The overrides directory, relative to the project root: `.acute/prompts/`. */
export const PROMPTS_DIR_NAME = ".acute/prompts";

/** The optional reorder file inside the overrides directory. */
export const ORDER_FILENAME = "_order.txt";

/**
 * Per-file char cap (R59-D ratings context uses the same 8000 discipline).
 * Honest about it: the composed prompt is bounded, so a runaway override
 * file cannot silently eat the context window — the cap is reported in the
 * diagnostics instead.
 */
export const PROMPT_OVERRIDE_CHAR_CAP = 8_000;

/** One structured diagnostic from loading overrides (rendered by
 * promptOverrideDiagnostics for the CLI, logs, and future UI). */
export interface PromptOverrideDiagnostic {
  kind:
    | "unknown-file" // filename did not match any registry id
    | "capped" // file text exceeded the char cap
    | "order-unknown-id" // _order.txt listed a non-registry id
    | "order-duplicate-id" // _order.txt listed the same id twice
    | "order-active" // _order.txt present (reordering requires ≥1 section override)
    | "unreadable"; // stat/read failed (e.g. a directory named like a file)
  file: string;
  section?: SectionId;
  detail?: string;
}

/** Result of loadPromptOverrides — the overrides, the requested order, and
 * honest diagnostics about everything ignored on the way. */
export interface PromptOverridesResult {
  rootPath: string;
  /** section id → replacement text (trimmed, capped). An EMPTY string means
   * "drop the section entirely" — the owner's "used when necessary" remove
   * lever (documented in docs/runbooks/PROMPT-MODULES.md). */
  overrides: Map<SectionId, string>;
  /** Requested section order from `_order.txt` (known ids only, first
   * occurrence wins), or undefined when the file is absent. NOTE: the order
   * only takes effect when at least one section override exists — with no
   * overrides the composed prompt must stay byte-identical (pinned). */
  order: SectionId[] | undefined;
  diagnostics: PromptOverrideDiagnostic[];
}

/** True when `id` names a registry section (case-SENSITIVE — `Efficiency.md`
 * is not `efficiency.md`; the mismatch is diagnosed, not silently honored). */
export function isKnownSectionId(id: string): boolean {
  return PROMPT_SECTION_IDS.includes(id);
}

/**
 * Read `.acute/prompts/<section-id>.md` overrides from the project root
 * (one file per section) + the optional `_order.txt` reorder list. Pure,
 * synchronous, fs-scoped — every deviation (unknown filename, cap hit,
 * unknown/duplicate order ids, unreadable file) is IGNORED and reported in
 * `diagnostics` so the CLI and future UI can tell the owner the truth.
 */
export function loadPromptOverrides(rootPath: string): PromptOverridesResult {
  const result: PromptOverridesResult = {
    rootPath,
    overrides: new Map(),
    order: undefined,
    diagnostics: [],
  };
  const dir = join(rootPath, ".acute", "prompts");
  if (!existsSync(dir)) return result;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // Unreadable directory (permissions): nothing loadable — say so.
    result.diagnostics.push({ kind: "unreadable", file: PROMPTS_DIR_NAME, detail: "readdir failed" });
    return result;
  }

  for (const name of entries.sort()) {
    const full = join(dir, name);
    // The order file: one section id per line. Unknown ids are tolerated
    // (ignored + diagnosed) so a stale _order.txt never breaks a turn.
    if (name === ORDER_FILENAME) {
      let text = "";
      try {
        text = readFileSync(full, "utf8");
      } catch {
        result.diagnostics.push({ kind: "unreadable", file: name });
        continue;
      }
      const seen = new Set<SectionId>();
      const order: SectionId[] = [];
      for (const rawLine of text.split(/\r?\n/)) {
        const id = rawLine.trim();
        if (id === "") continue;
        if (!isKnownSectionId(id)) {
          result.diagnostics.push({ kind: "order-unknown-id", file: name, section: id });
          continue;
        }
        if (seen.has(id)) {
          result.diagnostics.push({ kind: "order-duplicate-id", file: name, section: id });
          continue;
        }
        seen.add(id);
        order.push(id);
      }
      result.order = order;
      // The order file itself is a diagnostic-noted override: its presence
      // is always reported, but it only REORDERS when at least one section
      // file override exists (the no-override prompt stays byte-identical).
      result.diagnostics.push({
        kind: "order-active",
        file: name,
        detail: "reorders sections only together with ≥1 section override file",
      });
      continue;
    }

    // A section file must be `<registry-id>.md` EXACTLY (stem == id,
    // lowercase slug). Anything else is ignored + diagnosed.
    const stem = name.endsWith(".md") ? name.slice(0, -3) : name;
    if (!isKnownSectionId(stem)) {
      result.diagnostics.push({
        kind: "unknown-file",
        file: name,
        detail: "filename must match a registry section id exactly (see `node scripts/acute.mjs prompt:sections`)",
      });
      continue;
    }
    let text: string;
    try {
      // statSync first: a DIRECTORY named `efficiency.md` must fail cleanly
      // (EISDIR) into a diagnostic, never throw into a turn.
      if (!statSync(full).isFile()) throw new Error("not a regular file");
      text = readFileSync(full, "utf8");
    } catch (err) {
      result.diagnostics.push({ kind: "unreadable", file: name, section: stem, detail: String(err) });
      continue;
    }
    const trimmed = text.trim();
    if (trimmed.length > PROMPT_OVERRIDE_CHAR_CAP) {
      result.overrides.set(
        stem,
        trimmed.slice(0, PROMPT_OVERRIDE_CHAR_CAP) +
          `\n\n[.acute/prompts/${name} truncated at ${PROMPT_OVERRIDE_CHAR_CAP} characters — the remainder of the file is ignored]`,
      );
      result.diagnostics.push({ kind: "capped", file: name, section: stem });
    } else {
      // "" (empty after trim) is a LEGITIMATE value: drop the section.
      result.overrides.set(stem, trimmed);
    }
  }
  return result;
}

/**
 * Render loadPromptOverrides' diagnostics as human-readable lines (CLI
 * `prompt:sections`, future UI tooltips). Empty result → empty array —
 * "no news" means "everything loaded clean".
 */
export function promptOverrideDiagnostics(result: PromptOverridesResult): string[] {
  return result.diagnostics.map((d) => {
    const where = `${PROMPTS_DIR_NAME}/${d.file}`;
    const what =
      d.kind === "unknown-file"
        ? `ignored — ${d.detail ?? "filename does not match a registry section id"}`
        : d.kind === "capped"
          ? `capped at ${PROMPT_OVERRIDE_CHAR_CAP} chars (honest truncation marker appended)`
          : d.kind === "order-unknown-id"
            ? `unknown section id "${d.section}" ignored`
            : d.kind === "order-duplicate-id"
              ? `duplicate section id "${d.section}" ignored (first occurrence wins)`
              : d.kind === "order-active"
                ? `order file active — ${d.detail ?? ""}`
                : `unreadable — ${d.detail ?? "skipped"}`;
    return `${where}: ${what}`;
  });
}
