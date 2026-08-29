/**
 * Project repository (Agentic Coding MVP): a project pins a workspace root
 * folder on disk. The ONLY SQL for projects lives here (anti-drift rule).
 * Deletion unregisters the row — files on disk are never touched.
 */
import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "./db.js";

/** Project row as served by the API. */
export interface Project {
  id: string;
  name: string;
  /** Absolute workspace folder path; the agent's file sandbox boundary. */
  rootPath: string;
  color: string;
  createdAt: string;
}

/** ROUND-48 (R48-a): the 8-color palette new projects draw from. Eight
 * distinct hues (flame orange kept as palette[0] — it was THE default since
 * 0003, so existing tiles never look alien), all 6-digit hex because the
 * sidebar's shadeHex()/withAlpha() gradient helpers only compose hex. */
export const PROJECT_PALETTE = [
  "#FF6B2C", // flame orange (the original default — the brand accent)
  "#3B82F6", // blue
  "#14B8A6", // teal
  "#8B5CF6", // violet
  "#F43F5E", // rose
  "#F59E0B", // amber
  "#84CC16", // lime
  "#EC4899", // pink
] as const;

export interface ProjectInput {
  name: string;
  rootPath: string;
  color?: string;
}

interface ProjectRow {
  id: string;
  name: string;
  root_path: string;
  color: string;
  created_at: string;
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    color: row.color,
    createdAt: row.created_at,
  };
}

export function slugifyProjectId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${slug || "project"}-${randomUUID().slice(0, 8)}`;
}

/** ROUND-48 (R48-a): the default color for a new project = the LEAST-used
 * palette color among existing projects (ties → first in palette order), so
 * consecutive projects come out distinct instead of all-orange (owner:
 * "projects should be given different colors"). Case-insensitive because a
 * user-set color may be upper-case hex. */
function leastUsedPaletteColor(db: SqliteDatabase): string {
  const rows = db
    .prepare("SELECT color, COUNT(*) AS n FROM projects GROUP BY color")
    .all() as { color: string; n: number }[];
  const usage = new Map<string, number>();
  for (const row of rows) usage.set(row.color.toLowerCase(), row.n);
  let best: (typeof PROJECT_PALETTE)[number] = PROJECT_PALETTE[0];
  let bestCount = Number.POSITIVE_INFINITY;
  for (const color of PROJECT_PALETTE) {
    const n = usage.get(color.toLowerCase()) ?? 0;
    if (n < bestCount) {
      best = color;
      bestCount = n;
      if (n === 0) break;
    }
  }
  return best;
}

export function createProject(db: SqliteDatabase, input: ProjectInput): Project {
  const project: Project = {
    id: slugifyProjectId(input.name),
    name: input.name,
    rootPath: input.rootPath,
    color: input.color ?? leastUsedPaletteColor(db),
    createdAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO projects (id, name, root_path, color, created_at)
     VALUES (@id, @name, @rootPath, @color, @createdAt)`,
  ).run(project);
  return project;
}

export function listProjects(db: SqliteDatabase): Project[] {
  const rows = db.prepare("SELECT * FROM projects ORDER BY created_at DESC, id DESC").all() as ProjectRow[];
  return rows.map(toProject);
}

export function getProject(db: SqliteDatabase, id: string): Project | undefined {
  const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
  return row === undefined ? undefined : toProject(row);
}

/** Unregisters the project row. Files on disk are untouched. */
export function deleteProject(db: SqliteDatabase, id: string): boolean {
  const info = db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  return info.changes > 0;
}

export function projectRootPathExists(db: SqliteDatabase, rootPath: string): boolean {
  const row = db
    .prepare("SELECT id FROM projects WHERE root_path = ?")
    .get(rootPath) as { id: string } | undefined;
  return row !== undefined;
}
