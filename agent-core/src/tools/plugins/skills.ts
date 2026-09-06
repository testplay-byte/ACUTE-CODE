/**
 * ROUND-61 (R61): the SKILLS plugin — read_skill, the progressive-
 * disclosure loader (doc-09's pattern: the system prompt lists skill names
 * + descriptions ONLY; the body loads on demand). The tools are always
 * available (any db context) — reading a skill is an observation, no gate
 * beyond enabled.
 *
 * ROUND-70 (R70-b): the loader now resolves through the ONE shared index
 * (storage/skills-files.ts resolveEffectiveSkills) so what read_skill can
 * load is EXACTLY what the prompt's SKILLS section advertised:
 *   · D1 — FILE-BASED SKILLS: bodies load from disk at CALL time (honest
 *     failure if the SKILL.md vanished), DB rows shadow same-name files.
 *   · D4 — COMPUTER-USE GATING: while the computerUse master switch is
 *     off, the builtin computer-use skill is hidden from the index AND
 *     read_skill refuses it honestly ("computer use is disabled in
 *     settings") — the model must not burn a call loading instructions
 *     for a tool surface that is dark.
 *   · D5 — agent.skills FILTER: a non-empty agent allowlist filters the
 *     loadable set by name (per-agent skill curation; empty = all).
 */
import { jsonSchema } from "ai";
import { getAgent } from "../../storage/agents.js";
import { getComputerUseSettings } from "../../storage/computer-use.js";
import { getSkill } from "../../storage/skills.js";
import { readFileSkillBody, resolveEffectiveSkills } from "../../storage/skills-files.js";
import type { PluginDefinition, ToolDefinition } from "../registry.js";
import type { ToolResult } from "../registry.js";

export const skillsPlugin: PluginDefinition = {
  id: "core-skills",
  name: "Skills",
  version: "1.1.0",
  description:
    "The read_skill progressive-disclosure loader for SKILL.md-style capability modules (database + file-based).",
  category: "planning",
  createTools: (ctx): ToolDefinition[] => {
    const toolDeps = ctx.toolDeps;
    const projectRoot = ctx.root;
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
          const db = toolDeps.db;
          // D4 — the honest gate BEFORE the index lookup: a specific,
          // actionable refusal instead of a bare "no such skill" when the
          // model reaches for the one gated builtin by prior knowledge.
          if (name === "computer-use" && !getComputerUseSettings(db).enabled) {
            return {
              ok: false,
              output:
                "read_skill: the computer-use skill is hidden — computer use is disabled in settings (Settings → Computer Use). " +
                "Its tools are dark in this session; there is nothing to load.",
            };
          }
          // D5 — the AGENT's own skill allowlist (agents.skills; stored
          // since R61, read since R70-b). undefined agent row = no filter.
          const agent = toolDeps.agentId !== undefined ? getAgent(db, toolDeps.agentId) : undefined;
          const skills = resolveEffectiveSkills(db, {
            projectRoot,
            ...(agent?.skills !== undefined && agent.skills.length > 0 ? { agentSkills: agent.skills } : {}),
          });
          const skill = skills.find((s) => s.name === name);
          if (skill === undefined) {
            const available = skills.map((s) => s.name).join(", ");
            return {
              ok: false,
              output: `read_skill: no enabled skill named '${name}' available to this session. Available skills: ${available || "(none)"}`,
            };
          }
          // D1 — file skills: read the body from disk NOW (honest failure
          // if the file vanished since the session listed it).
          if (skill.filePath !== undefined) {
            const body = readFileSkillBody(skill.filePath);
            if (!body.ok) {
              return { ok: false, output: `read_skill: ${body.note}` };
            }
            return {
              ok: true,
              output: `# Skill: ${skill.name}\n\n${body.body}`.slice(0, 60000),
            };
          }
          // DB skill (builtin or user): the body rides the row.
          const row = getSkill(db, skill.id);
          if (row === undefined) {
            return { ok: false, output: `read_skill: skill '${name}' disappeared from the database (id ${skill.id})` };
          }
          return {
            ok: true,
            output: `# Skill: ${skill.name}\n\n${row.body}`.slice(0, 60000),
          };
        },
      },
    ];
  },
};
