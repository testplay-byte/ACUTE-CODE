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
 *
 * ROUND-72 (R72-c): REFERENCES DEPTH — read_skill gains an optional
 * `reference` parameter. A name-only call appends a listing block when the
 * (file-based) skill carries references/ ("references available: a, b —
 * load with read_skill { name: \"…\", reference: \"a\" }"); a name+reference
 * call loads THAT file from disk through readSkillReference (sanitized
 * name, frontmatter stripped, capped). Reference loads resolve through the
 * SAME effective-skills index first — the computer-use gate (D4) and the
 * agent allowlist (D5) keep working unchanged. DB skills carry no
 * references and say so honestly.
 *
 * ROUND-96 (R96-D): search_skills — the discovery half of the owner's
 * directive ("It can search for the skills too if it needs to"). The
 * prompt's SKILLS listing is BUDGETED (prompts.ts SKILLS_LISTED_MAX /
 * SKILLS_SECTION_CHAR_BUDGET — over budget the tail drops to the honest
 * "…and M more — search_skills to discover them" note), so the model needs
 * a tool that reaches the FULL index on demand. search_skills takes a
 * {query}, resolves the SAME effective-skills index read_skill uses
 * (disabled DB rows, the computer-use gate, and the agent allowlist are
 * excluded by construction), scores keyword matches over names +
 * descriptions + reference titles, and returns the ranked matches capped
 * at SEARCH_SKILLS_RESULT_CAP with the exact read_skill call to load each
 * — mirroring read_skill's own "load with read_skill { name: … }" error
 * convention. An honest no-match result names the alternatives.
 */
import { jsonSchema } from "ai";
import { getAgent } from "../../storage/agents.js";
import { getComputerUseSettings } from "../../storage/computer-use.js";
import { getSkill } from "../../storage/skills.js";
import {
  isValidReferenceName,
  readFileSkillBody,
  readSkillReference,
  referenceNameRejection,
  resolveEffectiveSkills,
  type EffectiveSkill,
} from "../../storage/skills-files.js";
import type { PluginDefinition, ToolDefinition } from "../registry.js";
import type { ToolResult } from "../registry.js";

/** read_skill's output budget — the sticky budget chat.ts grants read_skill
 * results (60K). The main-body path slices at this bound (R70-b); the R72-c
 * reference path trims with an HONEST marker instead (r71-e2's truncation
 * discipline: no silent cuts in new code). */
const READ_SKILL_OUTPUT_BUDGET = 60_000;

/** ROUND-96 (R96-D): max results search_skills returns (best-first) — the
 * discovery listing stays a digest, not a dump; the cap matches the
 * reference-listing conventions of the rest of the skills surface. */
const SEARCH_SKILLS_RESULT_CAP = 8;

/** ROUND-96 (R96-D): one search term's best contribution to a skill's
 * score — exact name > name word > name prefix > name substring >
 * description keyword > reference title. Deterministic and additive over
 * the query's terms. A name-WORD hit (60) deliberately outranks an exact
 * name hit on a DIFFERENT term plus a description hit (100+15): a
 * multi-word query like "error testing" should rank the skill NAMED
 * error-testing (two word hits, 120) above testing (exact + prose, 115). */
function scoreTerm(skill: EffectiveSkill, term: string): number {
  const name = skill.name.toLowerCase();
  if (name === term) return 100;
  if (name.split("-").includes(term)) return 60;
  if (name.startsWith(term)) return 50;
  if (name.includes(term)) return 30;
  if (skill.description.toLowerCase().includes(term)) return 15;
  if ((skill.references ?? []).some((r) => r.name.toLowerCase().includes(term))) return 10;
  return 0;
}

/** Assemble a reference load's output: the skill + reference header, the
 * body, and — when the body would blow the output budget — an honest
 * truncation marker (references up to 64KB are listed by discovery; only
 * the 60K..64K window and growth-race files can land here). */
function referenceOutput(skillName: string, referenceName: string, body: string): string {
  const header = `# Skill: ${skillName} — reference: ${referenceName}\n\n`;
  if (header.length + body.length <= READ_SKILL_OUTPUT_BUDGET) {
    return `${header}${body}`;
  }
  const shown = Math.max(0, READ_SKILL_OUTPUT_BUDGET - header.length - 140); // marker slack
  const marker = `\n\n…[reference truncated: ${shown} of ${body.length} chars shown — the reference file is larger]`;
  return `${header}${body.slice(0, shown)}${marker}`.slice(0, READ_SKILL_OUTPUT_BUDGET);
}

/** ROUND-96 (R96-D): resolve the session's effective skills ONCE per
 * search_skills call — the exact index read_skill resolves through (same
 * gates: disabled rows out, the computer-use master switch out, the
 * agent's non-empty allowlist out), so search can never advertise a skill
 * read_skill would refuse. */
function effectiveSkillsForSession(
  db: NonNullable<ToolDepsDb>,
  agentId: string | undefined,
  projectRoot: string,
): EffectiveSkill[] {
  const agent = agentId !== undefined ? getAgent(db, agentId) : undefined;
  return resolveEffectiveSkills(db, {
    projectRoot,
    ...(agent?.skills !== undefined && agent.skills.length > 0 ? { agentSkills: agent.skills } : {}),
  });
}

/** The minimal db shape effectiveSkillsForSession needs (the plugin's
 * toolDeps.db is the better-sqlite3 Database — a structural alias keeps
 * the helper honest without importing the type twice). */
type ToolDepsDb = Parameters<typeof getSkill>[0];

export const skillsPlugin: PluginDefinition = {
  id: "core-skills",
  name: "Skills",
  version: "1.3.0",
  description:
    "The skills plugin: read_skill (the progressive-disclosure loader for SKILL.md-style capability modules — database + file-based, with references/ depth) and search_skills (the keyword discovery tool over the same effective index; R96-D).",
  category: "planning",
  createTools: (ctx): ToolDefinition[] => {
    const toolDeps = ctx.toolDeps;
    const projectRoot = ctx.root;
    // Declaration contexts (the catalog's db:null stub) still declare the
    // tools — the skill LIST is db-dependent, the TOOLS are a global
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
            reference: {
              type: "string",
              description:
                "optional: load a deeper reference file instead of the main body (the body output lists available references)",
            },
          },
          required: ["name"],
        }),
        execute: (input): ToolResult => {
          const name = typeof input.name === "string" ? (input.name as string).trim() : "";
          // R72-c: an empty/whitespace/absent reference means the main body;
          // anything else names a references/ file to load instead.
          const reference =
            typeof input.reference === "string" && (input.reference as string).trim() !== ""
              ? (input.reference as string).trim()
              : undefined;
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
          // (R72-c: the gate fires identically with or without a
          // `reference` param — resolve first, then load.)
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
          // R72-c — REFERENCE LOADS: the skill resolved through the same
          // index (gates + allowlist applied), now load the named file.
          if (reference !== undefined) {
            // Sanitize FIRST: traversal-y names get the reason, not a
            // "no reference named" listing that would echo them back.
            if (!isValidReferenceName(reference)) {
              return { ok: false, output: `read_skill: ${referenceNameRejection(reference)}` };
            }
            if (skill.filePath === undefined) {
              return {
                ok: false,
                output: `read_skill: skill '${name}' has no references — database skills carry no reference files (only file-based skills do)`,
              };
            }
            const refs = skill.references ?? [];
            if (refs.length === 0) {
              return {
                ok: false,
                output: `read_skill: skill '${name}' has no references to load (no .md files in its references/ directory)`,
              };
            }
            if (!refs.some((r) => r.name === reference)) {
              const names = refs.map((r) => r.name).join(", ");
              return {
                ok: false,
                output: `read_skill: skill '${name}' has no reference named '${reference}'. Available references: ${names} — load with read_skill { name: "${name}", reference: "${refs[0]!.name}" }`,
              };
            }
            const loaded = readSkillReference(skill.filePath, reference);
            if (!loaded.ok) {
              return { ok: false, output: `read_skill: ${loaded.note}` };
            }
            return { ok: true, output: referenceOutput(skill.name, reference, loaded.body) };
          }
          // D1 — file skills: read the body from disk NOW (honest failure
          // if the file vanished since the session listed it).
          if (skill.filePath !== undefined) {
            const body = readFileSkillBody(skill.filePath);
            if (!body.ok) {
              return { ok: false, output: `read_skill: ${body.note}` };
            }
            let output = `# Skill: ${skill.name}\n\n${body.body}`;
            // R72-c — the references listing block: only for FILE skills
            // that carry references (DB skills unchanged). The first listed
            // name rides the example so the syntax is copy-pasteable.
            const refs = skill.references ?? [];
            if (refs.length > 0) {
              const listing = `\n\nreferences available: ${refs.map((r) => r.name).join(", ")} — load with read_skill { name: "${skill.name}", reference: "${refs[0]!.name}" }`;
              if (output.length + listing.length > READ_SKILL_OUTPUT_BUDGET) {
                output = output.slice(0, READ_SKILL_OUTPUT_BUDGET - listing.length);
              }
              output = `${output}${listing}`;
            }
            return { ok: true, output: output.slice(0, READ_SKILL_OUTPUT_BUDGET) };
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
      // ROUND-96 (R96-D): search_skills — the discovery tool over the SAME
      // effective index read_skill resolves (disabled rows, the
      // computer-use master switch, and the agent allowlist are excluded by
      // construction — search can never advertise what read_skill refuses).
      // Keyword scoring: exact name > name prefix > name word > name
      // substring > description > reference title; ranked best-first,
      // capped, with the honest no-match result.
      {
        name: "search_skills",
        description:
          "Search the available skills by keyword — the system prompt's SKILLS list is budgeted and may be truncated, this tool searches the FULL set. Matches skill names, one-line descriptions, and reference titles; returns the ranked matches with the exact read_skill call to load each. Use it whenever the SKILLS list does not obviously cover what the task needs (a tool, a phase, a craft).",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "keywords to search for (space-separated; every word widens the match — 'ui design', 'error', 'planning')",
            },
          },
          required: ["query"],
        }),
        execute: (input): ToolResult => {
          const query = typeof input.query === "string" ? (input.query as string).trim() : "";
          if (query === "") {
            return {
              ok: false,
              output: "search_skills: query is required (one or more keywords to search skill names, descriptions, and reference titles)",
            };
          }
          if (toolDeps.db === null || toolDeps.db === undefined) {
            return { ok: false, output: "search_skills: no database in this context" };
          }
          const skills = effectiveSkillsForSession(toolDeps.db, toolDeps.agentId, projectRoot);
          // Terms are lowercase keywords; a skill matches when ANY term
          // hits, and ranks by the SUM of the terms' best contributions —
          // multi-word queries reward skills that match more of the query.
          const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
          const scored = skills
            .map((skill) => {
              const score = terms.reduce((sum, term) => sum + scoreTerm(skill, term), 0);
              return { skill, score };
            })
            .filter((entry) => entry.score > 0)
            // Deterministic order: score DESC, then name ASC.
            .sort((a, b) => (a.score === b.score ? (a.skill.name < b.skill.name ? -1 : 1) : b.score - a.score));
          if (scored.length === 0) {
            return {
              ok: true,
              output:
                `search_skills '${query}': no matches among the ${skills.length} skills available to this session. ` +
                "Try a different keyword — a tool name ('test', 'plan', 'ui', 'error'), a phase, or a craft — or re-read the SKILLS list in the system prompt.",
            };
          }
          const shown = scored.slice(0, SEARCH_SKILLS_RESULT_CAP);
          const lines = shown.map(({ skill }) => {
            const refs = skill.references ?? [];
            const refNote = refs.length > 0 ? ` (references: ${refs.map((r) => r.name).join(", ")})` : "";
            return `- **${skill.name}** — ${skill.description}${refNote} — load with read_skill { name: "${skill.name}" }`;
          });
          const overflow =
            scored.length > SEARCH_SKILLS_RESULT_CAP
              ? `\n…and ${scored.length - SEARCH_SKILLS_RESULT_CAP} more matches — narrow the query`
              : "";
          return {
            ok: true,
            output:
              `search_skills '${query}': ${scored.length} match${scored.length === 1 ? "" : "es"} of ${skills.length} skills (best first):\n` +
              `${lines.join("\n")}${overflow}`,
          };
        },
      },
    ];
  },
};
