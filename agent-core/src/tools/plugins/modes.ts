/**
 * ROUND-73 (R73-b): the MODES plugin — switch_mode, the agent-side access
 * path to the TASK-MODE posture tier (R73-a's modes.ts core):
 * "proper detailed system prompts which the agent accesses when required
 * and on the basis of the task". The model itself changes posture when the
 * task changes shape (spec approved → build; defect found mid-build →
 * debug) — the user-side path (composer picker + /mode slash, R73-c) and
 * the advisory path (computeModeHints → the TASK MODES section's Task
 * signal line) are its siblings.
 *
 * SEMANTICS (the three calls):
 *   · switch_mode { mode: "<id>" } — ACTIVATE. The session row's
 *     active_mode is set (storage-level updateSessionActiveMode — the same
 *     writer PATCH /sessions/:id uses), and the FULL posture guide returns
 *     ONCE, immediately, followed by the fenced task-mode reminder
 *     (R73-d's renderReminder) so the model knows the guide now rides the
 *     system prompt's ACTIVE TASK MODE section on every following turn.
 *     From then on the prompt carries it — the tool does not need calling
 *     again.
 *   · switch_mode { mode: "none" } (also "off"/"auto"/""/JSON null) —
 *     DEACTIVATE (idempotent: clearing a modeless session says so
 *     honestly). The ACTIVE TASK MODE section leaves the prompt from the
 *     next turn.
 *   · switch_mode {} (no arguments) — LIST: the index resolved from the
 *     turn's project root (resolveEffectiveModes: the six builtins + the
 *     project's .acute/agents/*.md customs, shadowing included) + which
 *     mode is currently active + the usage line.
 *
 * ALWAYS REGISTERED (like read_skill): a global session capability,
 * settings-independent — the plugin gates only on toolDeps (db +
 * sessionId), mirroring the skills plugin's declaration-context pattern so
 * the catalog can declare the tool with an inert db and the real gate
 * lives at execute time.
 */
import { jsonSchema } from "ai";
import { isReadOnlyTaskMode } from "../../agents/mode-policy.js";
import { findMode, resolveEffectiveModes } from "../../agents/modes.js";
import { renderReminder } from "../../agents/system-reminders.js";
import { getSession, updateSessionActiveMode } from "../../storage/sessions.js";
import type { PluginDefinition, ToolDefinition } from "../registry.js";
import type { ToolResult } from "../registry.js";

/** The string sentinels that mean "clear the active mode" (a JSON null is
 * accepted too when the schema layer passes it through; the sentinels are
 * the documented, schema-clean path — a nullable union in the input schema
 * does not validate cleanly on every provider). */
const CLEAR_SENTINELS: ReadonlySet<string> = new Set(["none", "off", "auto", ""]);

/** The deactivate notice's honest contract text (one string, reused for
 * both the clear and the idempotent no-op clear). */
const DEACTIVATED_OUTPUT =
  "Task mode deactivated. The ACTIVE TASK MODE section leaves the system prompt from the next turn; default posture applies.";

/** The reminder that rides every activation — R73-d's ONE renderer, the
 * "task-mode" kind (the switch_mode activation notice was its named
 * consumer from the start). */
function activationReminder(id: string, name: string): string {
  return renderReminder({
    kind: "task-mode",
    label: `task mode switched: ${id} (${name})`,
    text: 'This guide now rides the ACTIVE TASK MODE section of the system prompt every following turn. Deactivate with switch_mode { mode: "none" }.',
  });
}

export const modesPlugin: PluginDefinition = {
  id: "core-modes",
  name: "Task Modes",
  version: "1.0.0",
  description:
    "switch_mode — activate, clear, or list the session's TASK MODE (operating posture: plan/debug/build/review/explore/refactor, or project .acute/agents/*.md customs).",
  category: "planning",
  createTools: (ctx): ToolDefinition[] => {
    const toolDeps = ctx.toolDeps;
    const projectRoot = ctx.root;
    // Declaration contexts (the catalog's db:null stub) still declare the
    // tool — the mode LIST is db-dependent, the TOOL is a global session
    // capability (the skills plugin's pattern). db/sessionId are guarded at
    // EXECUTE time.
    if (toolDeps === undefined) return [];
    return [
      {
        name: "switch_mode",
        description:
          "Switch the session's active TASK MODE (operating posture for a class of work — plan/debug/build/review/explore/refactor, or a project .acute/agents/*.md custom mode). While a mode is active, its detailed posture guide rides the system prompt's ACTIVE TASK MODE section. Call with { mode: \"<id>\" } to activate (the tool returns the full guide ONCE, immediately), { mode: \"none\" } to deactivate (also accepts \"off\"/\"auto\"), or no arguments to list available modes. The task-modes index in the system prompt lists what each mode is for; the Task signal line names the mode that matches the current request.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            mode: {
              type: "string",
              description:
                "the mode id to activate, or \"none\"/\"off\"/\"auto\" to deactivate (omit to list modes)",
            },
          },
          required: [],
        }),
        execute: (input): ToolResult => {
          // Declaration contexts never execute; a null/undefined db or a
          // missing sessionId degrades gracefully (an honest error, never a
          // crash) — the skills plugin's guard, verbatim in spirit.
          if (toolDeps.db === null || toolDeps.db === undefined) {
            return { ok: false, output: "switch_mode: no database in this context" };
          }
          if (typeof toolDeps.sessionId !== "string" || toolDeps.sessionId === "") {
            return { ok: false, output: "switch_mode: no session in this context" };
          }
          const db = toolDeps.db;
          const session = getSession(db, toolDeps.sessionId);
          if (session === undefined) {
            return { ok: false, output: `switch_mode: session ${toolDeps.sessionId} no longer exists` };
          }

          // ROUND-75 (R75): READ-ONLY MODES ARE OWNER-PINNED. While plan/
          // review/explore is active, the MODEL may not leave or clear the
          // posture unilaterally — the owner set it (the picker / PATCH),
          // and the enforcement tier (write tools removed) is exactly what
          // they asked for ("plan mode tried to make edits — this was not
          // supposed to happen"). The honest refusal tells the model what
          // to do instead: present the plan/spec/findings and ASK the owner
          // to switch. Entering a read-only mode (or any switch while a
          // NON-read-only mode is active) is unchanged — the model keeps
          // its posture management everywhere else.
          if (session.activeMode !== null && isReadOnlyTaskMode(session.activeMode)) {
            const currentId = session.activeMode;
            const { modes } = resolveEffectiveModes(projectRoot);
            const current = findMode(modes, currentId);
            const requestedId = typeof input.mode === "string" ? input.mode.trim() : input.mode;
            const isClear =
              input.mode === null ||
              (typeof requestedId === "string" && CLEAR_SENTINELS.has(requestedId));
            const isSame = typeof requestedId === "string" && requestedId === currentId;
            if (!isSame && (isClear || requestedId !== undefined)) {
              const currentName = current?.name ?? currentId;
              return {
                ok: false,
                output:
                  `switch_mode: the session is in ${currentName} mode — a read-only posture the OWNER set. ` +
                  "It stays active until the owner switches it (the composer's mode picker). " +
                  "Present your plan/spec/findings and ask the owner to switch modes when they want implementation to start.",
              };
            }
          }

          // The mode param: absent → the index; null or a clear-sentinel
          // string → deactivate; anything else must be a string naming an id.
          const rawMode = input.mode;
          if (rawMode !== undefined && rawMode !== null && typeof rawMode !== "string") {
            return {
              ok: false,
              output: 'switch_mode: mode must be a mode id string, "none" to deactivate, or omitted to list modes',
            };
          }

          // ONE resolution, the same one prepareTurn and the prompt's TASK
          // MODES section use (customs shadow builtins; the project root is
          // the turn's own ctx.root).
          const { modes } = resolveEffectiveModes(projectRoot);

          if (rawMode === undefined) {
            // ── LIST ─────────────────────────────────────────────────────
            const lines = [
              "# Task modes available",
              "",
              ...modes.map((mode) => `- ${mode.id}: ${mode.name} — ${mode.description}`),
            ];
            lines.push(
              session.activeMode === null
                ? "\nNo task mode is currently active (default posture)."
                : `\nCurrently active: ${session.activeMode} (${
                    findMode(modes, session.activeMode)?.name ?? "unknown mode id"
                  }).`,
            );
            lines.push(
              'Activate with switch_mode { mode: "<id>" }; deactivate with switch_mode { mode: "none" }.',
            );
            return { ok: true, output: lines.join("\n") };
          }

          const requested = typeof rawMode === "string" ? rawMode.trim() : "";
          if (rawMode === null || CLEAR_SENTINELS.has(requested)) {
            // ── DEACTIVATE (idempotent, honest when nothing is active) ───
            if (session.activeMode === null) {
              return {
                ok: true,
                output: `No task mode was active — nothing to deactivate. ${DEACTIVATED_OUTPUT}`,
              };
            }
            const updated = updateSessionActiveMode(db, session.id, null);
            if (updated === undefined) {
              return { ok: false, output: `switch_mode: session ${session.id} disappeared mid-call` };
            }
            return { ok: true, output: DEACTIVATED_OUTPUT };
          }

          // ── ACTIVATE ───────────────────────────────────────────────────
          const mode = findMode(modes, requested);
          if (mode === undefined) {
            const available = modes.map((m) => m.id).join(", ");
            return {
              ok: false,
              output:
                `switch_mode: no task mode named '${requested}' in this session. Available modes: ${available || "(none)"}. ` +
                "Custom modes come from .acute/agents/*.md files in the project root (name/description/tools frontmatter + the posture body).",
            };
          }
          const updated = updateSessionActiveMode(db, session.id, mode.id);
          if (updated === undefined) {
            return { ok: false, output: `switch_mode: session ${session.id} disappeared mid-call` };
          }
          // The full guide ONCE (from the next turn the prompt carries it):
          // header + verbatim body + the fenced task-mode reminder.
          return {
            ok: true,
            output: `# Task mode ACTIVE: ${mode.name} (${mode.id})\n\n${mode.body}${activationReminder(mode.id, mode.name)}`,
          };
        },
      },
    ];
  },
};
