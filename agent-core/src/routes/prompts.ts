// ─────────────────────────────────────────────────────────────────────────────
// ROUND-98 (R98-E1): the PROMPT-CUSTOMIZATION domain — the Settings "Prompts"
// tab's backend. The override ENGINE has existed since R59-F (fs + compose
// time, no HTTP surface — the CLI read it offline); this module finally
// exposes it: GET /prompts/sections (the registry picture + each section's
// current override), PUT /prompts/sections/:id (write), DELETE
// /prompts/sections/:id (revert), GET /prompts/preview (the composed
// effective section texts). Same bearer wall as every route (the app-level
// preHandler hook — routes/settings.ts pattern).
//
// SECURITY (the reason projectRoot is validated against the projects
// table): these routes WRITE into the project tree. Restricting them to
// REGISTERED roots keeps the wall honest — a bearer-authenticated caller
// cannot turn PUT /prompts/sections/:id into an arbitrary-path write
// primitive. Override FILES stay exactly as trusted as before (project
// root = the .acuterules trust level; they are prompt text, never
// permissions — see docs/runbooks/PROMPT-MODULES.md's security note).
// ─────────────────────────────────────────────────────────────────────────────
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.js";
import { errorBody } from "./helpers.js";
import { basename } from "node:path";
import { listProjects, type Project } from "../storage/projects.js";
import { TOOL_NAMES } from "../storage/agents.js";
import type { SqliteDatabase } from "../storage/db.js";
import {
  buildDefaultSectionText,
  buildSectionText,
  describePromptSections,
  readCustomRules,
  type PromptContext,
} from "../agents/prompts.js";
import { PROMPT_SECTION_IDS, type SectionId } from "../agents/prompt-registry.js";
import {
  deletePromptOverride,
  readPromptOverride,
  writePromptOverride,
} from "../storage/prompt-overrides.js";
import { resolveEffectiveSkills } from "../storage/skills-files.js";

/** Resolve a registered project by its root path — the write-side guard. */
function projectByRoot(db: SqliteDatabase, rootPath: string): Project | undefined {
  return listProjects(db).find((project) => project.rootPath === rootPath);
}

/**
 * The REPRESENTATIVE composition ctx for inspection routes — the CLI's
 * `prompt:sections` shape (scripts/acute.mjs representativeCtx): the FULL
 * default tool set (every tool-gated section present), the project's real
 * custom rules, no permission-mode/memory digest (those report absent, as
 * they would in an unconfigured session) — PLUS the project's EFFECTIVE
 * skills, so the SKILLS and ALWAYS-ON SKILLS sections preview truthfully
 * (the pinned bodies included — that is the preview's whole point). A real
 * session with a narrower allowlist composes fewer sections; the UI says so.
 */
function representativePromptCtx(db: SqliteDatabase, project: Project): PromptContext {
  return {
    projectName: project.name || basename(project.rootPath),
    rootPath: project.rootPath,
    toolNames: [...TOOL_NAMES],
    customRules: readCustomRules(project.rootPath),
    skills: resolveEffectiveSkills(db, {
      projectRoot: project.rootPath,
      projectScope: project.id,
    }).map((skill) => ({
      name: skill.name,
      description: skill.description,
      ...(skill.alwaysLoad === true
        ? { alwaysLoad: true, ...(skill.body !== undefined ? { body: skill.body } : {}) }
        : {}),
    })),
  };
}

/** Fastify's narrowed reply chain (kept structural so the helpers compose). */
type RejectableReply = { code: (status: number) => { send: (body: unknown) => unknown } };

/** The shared query-param resolver: a REGISTERED project root or the honest
 * 400/404 (sent on `reply`; undefined return = caller must stop). */
function requireProject(
  reply: RejectableReply,
  db: SqliteDatabase,
  projectRoot: string | undefined,
): Project | undefined {
  if (typeof projectRoot !== "string" || projectRoot.trim() === "") {
    reply.code(400).send(errorBody("VALIDATION", "projectRoot query parameter is required", { field: "projectRoot" }));
    return undefined;
  }
  const project = projectByRoot(db, projectRoot);
  if (project === undefined) {
    reply
      .code(404)
      .send(errorBody("NOT_FOUND", `no registered project with root ${projectRoot}`, { field: "projectRoot" }));
    return undefined;
  }
  return project;
}

export function registerPromptRoutes(scope: FastifyInstance, ctx: RouteContext): void {
  const { db } = ctx;

  // ── GET /prompts/sections?projectRoot= — the registry picture ──────────
  // describePromptSections (the R59-F report built "for a future Settings
  // UI" — this is that UI) + each section's CURRENT override content (the
  // raw file text, for the editor) + its DEFAULT text (the built-in
  // composition, the read-only reference / what reverting restores).
  scope.get("/prompts/sections", async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const project = requireProject(reply, db, query.projectRoot);
    if (project === undefined) return reply;
    const promptCtx = representativePromptCtx(db, project);
    const report = describePromptSections(promptCtx);
    return {
      rootPath: project.rootPath,
      sections: report.sections.map((section) => ({
        ...section,
        overrideContent: readPromptOverride(project.rootPath, section.id),
        defaultText: buildDefaultSectionText(promptCtx, section.id) ?? null,
      })),
      overridden: report.overridden,
      effectiveOrder: report.effectiveOrder,
      diagnostics: report.diagnostics,
    };
  });

  // ── PUT /prompts/sections/:id — write the override ─────────────────────
  // {projectRoot, content}. Non-empty content replaces the section
  // wholesale (the engine's rule, dynamic parts included); content that
  // TRIMS to empty writes the empty file = DROP the section (the remove
  // lever — the UI warns before saving that). Reverting to the built-in
  // text is DELETE, not an empty save: the two levers are deliberately
  // distinct and both are named in the response.
  scope.put("/prompts/sections/:id", async (request, reply) => {
    const { id } = request.params as Record<string, string>;
    const body: unknown = request.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return reply
        .code(400)
        .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
    }
    const raw = body as Record<string, unknown>;
    if (typeof raw.projectRoot !== "string" || raw.projectRoot.trim() === "") {
      return reply
        .code(400)
        .send(errorBody("VALIDATION", "body.projectRoot must be a non-empty string", { field: "body.projectRoot" }));
    }
    const project = projectByRoot(db, raw.projectRoot);
    if (project === undefined) {
      return reply
        .code(404)
        .send(errorBody("NOT_FOUND", `no registered project with root ${raw.projectRoot}`, { field: "body.projectRoot" }));
    }
    if (typeof raw.content !== "string") {
      return reply
        .code(400)
        .send(errorBody("VALIDATION", "body.content must be a string (an empty string drops the section)", { field: "body.content" }));
    }
    try {
      const result = writePromptOverride(project.rootPath, id, raw.content);
      return {
        ok: true,
        id: result.id,
        file: result.file,
        dropped: result.dropped,
        content: result.content,
      };
    } catch (err) {
      return reply
        .code(400)
        .send(errorBody("VALIDATION", err instanceof Error ? err.message : String(err), { field: "content" }));
    }
  });

  // ── DELETE /prompts/sections/:id?projectRoot= — revert to default ──────
  // Removes the override file (idempotent: an absent file is a successful
  // revert). The section returns to its built-in composition on the next
  // turn — byte-identical to a project that never overrode it.
  scope.delete("/prompts/sections/:id", async (request, reply) => {
    const { id } = request.params as Record<string, string>;
    const query = request.query as Record<string, string | undefined>;
    const project = requireProject(reply, db, query.projectRoot);
    if (project === undefined) return reply;
    const result = deletePromptOverride(project.rootPath, id);
    if (!result.ok) {
      return reply
        .code(409)
        .send(errorBody("CONFLICT", result.note ?? `could not remove ${result.file}`, { field: "file" }));
    }
    return { ok: true, id, reverted: true, existed: result.existed };
  });

  // ── GET /prompts/preview?projectRoot= — the effective composition ───────
  // Each PRESENT section's effective text (override applied), in effective
  // order, with the overridden flag — the live-preview data. The minimal
  // honest thing buildSystemPromptSections exposes is four bucket strings;
  // the SECTION texts (buildSectionText) are the useful unit for a
  // per-section preview, so those are what this serves (same shared compose
  // — the same truth the model receives).
  scope.get("/prompts/preview", async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const project = requireProject(reply, db, query.projectRoot);
    if (project === undefined) return reply;
    const promptCtx = representativePromptCtx(db, project);
    const report = describePromptSections(promptCtx);
    const overridden = new Set<SectionId>(report.overridden);
    let totalChars = 0;
    const sections = report.effectiveOrder.map((id) => {
      const text = buildSectionText(promptCtx, id) ?? "";
      totalChars += text.length;
      return { id, overridden: overridden.has(id), text };
    });
    return {
      rootPath: project.rootPath,
      // The registry ids in DEFAULT order too — the UI's list anchor.
      registryOrder: [...PROMPT_SECTION_IDS],
      effectiveOrder: report.effectiveOrder,
      totalChars,
      sections,
      diagnostics: report.diagnostics,
    };
  });
}
