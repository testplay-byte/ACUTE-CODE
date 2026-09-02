/**
 * ROUND-61 (R61): the SKILLS plugin — read_skill, the progressive-
 * disclosure loader (doc-09's pattern: the system prompt lists skill names
 * + descriptions ONLY; the body loads on demand). The tools are always
 * available (any db context) — reading a skill is an observation, no gate
 * beyond enabled.
 */
import { jsonSchema } from "ai";
import { listEnabledSkills, getSkill } from "../../storage/skills.js";
import type { PluginDefinition, ToolDefinition } from "../registry.js";
import type { ToolResult } from "../registry.js";

export const skillsPlugin: PluginDefinition = {
  id: "core-skills",
  name: "Skills",
  version: "1.0.0",
  description:
    "The read_skill progressive-disclosure loader for user-configurable SKILL.md-style prompt modules.",
  category: "planning",
  createTools: (ctx): ToolDefinition[] => {
    const toolDeps = ctx.toolDeps;
    // Declaration contexts (the catalog's db:null stub) still declare the
    // tool — the skill LIST is db-dependent, the TOOL is a global
    // capability. The db is guarded at EXECUTE time.
    if (toolDeps === undefined) return [];
    return [
      {
        name: "read_skill",
        description:
          "Load the full body of a skill (a detailed capability module). The system prompt lists each enabled skill's name + one-line description; when a task matches, call read_skill with that name and follow its instructions for the rest of the task. Skills may define procedures, conventions, or tool-use disciplines.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            name: { type: "string", description: "the skill name from the SKILLS list in the system prompt" },
          },
          required: ["name"],
        }),
        execute: (input): ToolResult => {
          const name = typeof input.name === "string" ? (input.name as string).trim() : "";
          if (name === "") {
            return { ok: false, output: "read_skill: name is required (a skill name from the system prompt's SKILLS list)" };
          }
          // Declaration contexts never execute; a null db degrades
          // gracefully (an honest error, never a crash).
          if (toolDeps.db === null || toolDeps.db === undefined) {
            return { ok: false, output: "read_skill: no database in this context" };
          }
          const skills = listEnabledSkills(toolDeps.db);
          const skill = skills.find((s) => s.name === name) ?? getSkill(toolDeps.db, name);
          if (skill === undefined || !skill.enabled) {
            const available = skills.map((s) => s.name).join(", ");
            return {
              ok: false,
              output: `read_skill: no enabled skill named '${name}'. Enabled skills: ${available || "(none)"}`,
            };
          }
          return {
            ok: true,
            output: `# Skill: ${skill.name}\n\n${skill.body}`.slice(0, 60000),
          };
        },
      },
    ];
  },
};
