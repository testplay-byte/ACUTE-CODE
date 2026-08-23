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

export function createProject(db: SqliteDatabase, input: ProjectInput): Project {
  const project: Project = {
    id: slugifyProjectId(input.name),
    name: input.name,
    rootPath: input.rootPath,
    color: input.color ?? "#FF6B2C",
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
