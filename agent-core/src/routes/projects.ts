// ─────────────────────────────────────────────────────────────────────────────
// R84 (Wave 2-a): the projects domain (API.md §4a — the Agentic Coding MVP
// project registry + its read surfaces).
//
// Registers, in the original server.ts registration order: GET /projects,
// POST /projects, GET /projects/:id, DELETE /projects/:id,
// GET /projects/:id/tree, GET /projects/:id/file, POST /projects/:id/search
// (the Round-28 WS-H unified files+symbols+content search), and GET
// /projects/:id/demos (the Round-28 WS-I in-app demo viewer).
//
// Provenance: extracted verbatim from server.ts in R84 (Wave 2-a) —
// behavior-identical, test-guarded. The /projects/:id/index, /modes,
// /terminal*, /memory, and /jobs routes live in their own domain modules
// (index-memory, modes, terminal, memory, jobs).
// ─────────────────────────────────────────────────────────────────────────────
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.js";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { projectTree, readFile, searchCode, searchFiles } from "../tools/index.js";
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  projectRootPathExists,
} from "../storage/projects.js";
// R128-W3 (SCREENS §2 law #9): the General project's protected id — the
// DELETE guard below returns 409 general_protected for it.
import { GENERAL_PROJECT_ID } from "../storage/general-project.js";
import { searchIndexSymbols } from "../storage/index.js";
// R113-a: the events-bus publish for project creations (watchers on
// GET /events/stream refresh their project lists).
import { getEventsBus } from "../lib/events-bus.js";
import { errorBody } from "./helpers.js";

export function registerProjectRoutes(scope: FastifyInstance, ctx: RouteContext): void {
  const { db } = ctx;
  // ---- Projects (Agentic Coding MVP, API.md §4a) ----

  scope.get("/projects", async () => ({ projects: listProjects(db) }));

  scope.post("/projects", async (request, reply) => {
    const body = request.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return reply
        .code(400)
        .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
    }
    const raw = body as Record<string, unknown>;
    const issues: { field: string; message: string }[] = [];
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (name === "") {
      issues.push({ field: "body.name", message: "name is required" });
    }
    let rootPath = typeof raw.rootPath === "string" ? raw.rootPath.trim() : "";
    if (rootPath === "") {
      issues.push({ field: "body.rootPath", message: "rootPath must be an absolute folder path" });
    }
    // Normalize Windows separators; require an EXISTING directory on disk.
    rootPath = rootPath.replace(/[\\/]+$/, "");
    if (rootPath !== "") {
      try {
        if (!statSync(rootPath).isDirectory()) {
          issues.push({ field: "body.rootPath", message: "rootPath is not a directory" });
        }
      } catch {
        issues.push({ field: "body.rootPath", message: `folder does not exist: ${rootPath}` });
      }
    }
    if (rootPath !== "" && projectRootPathExists(db, rootPath)) {
      return reply.code(409).send(
        errorBody("CONFLICT", `a project already uses the folder ${rootPath}`, {
          field: "body.rootPath",
        }),
      );
    }
    if (issues.length > 0) {
      return reply.code(400).send(
        errorBody("VALIDATION", issues[0].message, { field: issues[0].field }),
      );
    }
    const color = typeof raw.color === "string" && /^#[0-9a-fA-F]{6}$/.test(raw.color) ? raw.color : undefined;
    const project = createProject(db, { name, rootPath, ...(color !== undefined ? { color } : {}) });
    // R113-a: announce the new project on the events bus — watchers
    // (desktop sidebar / phone project list) refresh. R128-W3: "created"
    // is no longer the only frame this domain publishes — DELETE announces
    // "deleted" below (with the cascade counts on the HTTP response).
    getEventsBus().publishProjectFrame(project.id, "created");
    return reply.code(201).send(project);
  });

  scope.get("/projects/:id", async (request, reply) => {
    const { id } = request.params as Record<string, string>;
    const project = getProject(db, id);
    if (project === undefined) {
      return reply.code(404).send(errorBody("NOT_FOUND", `no project with id ${id}`));
    }
    return project;
  });

  scope.delete("/projects/:id", async (request, reply) => {
    const { id } = request.params as Record<string, string>;
    // R128-W3 (SCREENS §2 law #9): the Scratchpad project is the app's
    // internal workspace — delete-PROTECTED here (and in the storage layer
    // as the belt-and-braces leg). The 409 carries a dedicated code so honest
    // clients can name exactly what happened.
    // R129-S (the rename): the message names the row by its R129 name —
    // "Scratchpad" (SCREENS §2 law #9: it "will not be called general").
    if (id === GENERAL_PROJECT_ID) {
      return reply.code(409).send(
        errorBody(
          "general_protected",
          "The Scratchpad project is the app's internal workspace — it cannot be deleted",
        ),
      );
    }
    // R128-W3 (SCREENS §2 law #8's backend half): the delete CASCADES the
    // project's sessions (session_events / usage_events / approvals /
    // file_snapshots / sessions, one transaction) and returns the counts —
    // the pre-R128 route deleted only the project row, orphaning sessions.
    const counts = deleteProject(db, id);
    if (counts === undefined) {
      return reply.code(404).send(errorBody("NOT_FOUND", `no project with id ${id}`));
    }
    // R128-W3: announce the deletion — watchers (desktop sidebar / phone
    // project list) refresh instead of waiting for the next poll/reconnect
    // hello (the R113-a gap: deletes were the only unannounced mutation).
    getEventsBus().publishProjectFrame(id, "deleted");
    return reply.code(200).send({ id, deleted: counts });
  });

  scope.get("/projects/:id/tree", async (request, reply) => {
    const { id } = request.params as Record<string, string>;
    const project = getProject(db, id);
    if (project === undefined) {
      return reply.code(404).send(errorBody("NOT_FOUND", `no project with id ${id}`));
    }
    return { tree: projectTree(project.rootPath), rootPath: project.rootPath };
  });

  scope.get("/projects/:id/file", async (request, reply) => {
    const { id } = request.params as Record<string, string>;
    const query = request.query as Record<string, string | undefined>;
    const project = getProject(db, id);
    if (project === undefined) {
      return reply.code(404).send(errorBody("NOT_FOUND", `no project with id ${id}`));
    }
    if (query.path === undefined || query.path === "") {
      return reply
        .code(400)
        .send(errorBody("VALIDATION", "path query parameter is required", { field: "query.path" }));
    }
    const result = readFile(project.rootPath, query.path);
    if (!result.ok) {
      return reply.code(404).send(errorBody("NOT_FOUND", result.output));
    }
    return { path: query.path, content: result.output };
  });
  // Round-28 WS-H: unified search (files + symbols + content) for the
  // CommandPalette. Reuses search_files + search_code + the codebase index.
  scope.post("/projects/:id/search", async (request, reply) => {
    const { id } = request.params as Record<string, string>;
    const body = request.body as Record<string, unknown> | null;
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return reply.code(400).send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
    }
    const project = getProject(db, id);
    if (project === undefined) {
      return reply.code(404).send(errorBody("NOT_FOUND", `no project with id ${id}`));
    }
    const query = typeof body.query === "string" ? body.query : "";
    const kind = body.kind === "symbols" || body.kind === "content" ? body.kind : "files";
    if (query.trim() === "") {
      return reply.code(400).send(errorBody("VALIDATION", "query is required", { field: "body.query" }));
    }
    if (kind === "symbols") {
      const symbols = searchIndexSymbols(db, id, query, 50);
      return { kind: "symbols", results: symbols };
    }
    if (kind === "content") {
      const res = searchCode(project.rootPath, query, undefined, {
        caseSensitive: body.case_sensitive === true,
        wholeWord: body.whole_word === true,
        fileGlob: typeof body.file_glob === "string" ? body.file_glob : undefined,
        maxResults: typeof body.max_results === "number" ? body.max_results : 50,
      });
      return { kind: "content", results: res.ok ? res.output : "" };
    }
    // kind === "files"
    const res = searchFiles(project.rootPath, query, undefined);
    return { kind: "files", results: res.ok ? res.output : "" };
  });
  // Round-28 WS-I: in-app demo viewer. Walks <project>/demos/ for HTML
  // files; each demo is viewable in a sandboxed iframe. The agent's
  // write_file tool can create demos as part of a task.
  scope.get("/projects/:id/demos", async (request, reply) => {
    const { id } = request.params as Record<string, string>;
    const project = getProject(db, id);
    if (project === undefined) {
      return reply.code(404).send(errorBody("NOT_FOUND", `no project with id ${id}`));
    }
    const demosDir = join(project.rootPath, "demos");
    if (!existsSync(demosDir)) {
      return { demos: [] };
    }
    const demos: Array<{ name: string; path: string; size: number; modifiedAt: string }> = [];
    try {
      for (const entry of readdirSync(demosDir)) {
        const abs = join(demosDir, entry);
        try {
          const stats = statSync(abs);
          if (stats.isDirectory()) {
            // demo is a folder with index.html (or other .html)
            const indexHtml = join(abs, "index.html");
            if (existsSync(indexHtml)) {
              demos.push({
                name: entry,
                path: `demos/${entry}/index.html`,
                size: statSync(indexHtml).size,
                modifiedAt: stats.mtime.toISOString(),
              });
            }
          } else if (entry.endsWith(".html")) {
            demos.push({
              name: entry.replace(/\.html$/, ""),
              path: `demos/${entry}`,
              size: stats.size,
              modifiedAt: stats.mtime.toISOString(),
            });
          }
        } catch {
          /* unreadable entry — skip */
        }
      }
    } catch {
      /* demos dir unreadable — return empty */
    }
    return { demos };
  });
}
