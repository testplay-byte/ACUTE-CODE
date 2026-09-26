import { ApiError, type Project, type ProjectsBackend, type TreeNode } from "./api";

/**
 * In-memory ProjectsBackend used by tests and the "demo data" toggle (sibling
 * of agent-fixtures.ts / session-fixtures.ts). Mirrors the sidecar semantics
 * verified against the live §4a routes (agent-core server.ts + tools/index.ts):
 * unique root paths, 404 NOT_FOUND envelopes, root-relative tree paths with
 * "/" separators, and short file bodies for the code panel — no network.
 */

const now = () => new Date().toISOString();
const uid = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 8)}`;

/** Round-robin palette reusing the sidebar's PROJECT_COLORS starters. */
const PALETTE = ["#FF6B2C", "#6366F1", "#D6FF57", "#FF7A3D", "#5A8CFF", "#7A5CFA"];

/** R129-S (SCREENS.md §2 law #9 — REWRITTEN): the Scratchpad project's
 * protected id — mirrors the sidecar's storage/general-project.ts + the
 * DELETE route's 409 general_protected guard, so demo mode behaves like
 * the live app (the id spelling is stable; the NAME follows the R129
 * rename below). */
const GENERAL_PROJECT_ID = "general";

const SEED: Project[] = [
  {
    id: "prj_seed_acute",
    name: "ACUTE-CODE",
    rootPath: "/home/dev/ACUTE-CODE",
    color: "#FF6B2C",
    createdAt: "2026-08-20T08:00:00Z",
  },
  {
    id: "prj_seed_site",
    name: "marketing-site",
    rootPath: "/home/dev/marketing-site",
    color: "#6366F1",
    createdAt: "2026-08-21T12:00:00Z",
  },
  // R129-S (SCREENS.md §2 law #9 — the Scratchpad, REWRITTEN from R128's
  // General conversation): the internal workspace project the sidecar
  // seeds at boot (agent-core storage/general-project.ts), mirrored here
  // for fixture parity — same id, same neutral slate color, NAME
  // "Scratchpad" (the R129 rename; the backend migrates the row at boot),
  // rootPath under the fixture "data dir"'s scratchpad root.
  // Seeded LAST deliberately: the fixture list() keeps insertion order, and
  // every existing `projects[0]` call site (AgentChatPanel tests, the
  // dashboard's newest-project quick action) must keep resolving to
  // ACUTE-CODE — the SIDEBAR renders it in its own separated bottom
  // section (R129-S), never mixed into the normal rows.
  {
    id: "general",
    name: "Scratchpad",
    rootPath: "/home/dev/.acute/scratchpad",
    color: "#64748B",
    createdAt: "2026-08-19T00:00:00Z",
  },
];

/**
 * Demo workspace for project #1: ~10 entries nested 3 levels, same shape
 * walkDir() produces (folders last-name paths, files root-relative).
 */
const ACUTE_TREE: TreeNode[] = [
  { name: "README.md", type: "file", path: "README.md", size: 1204 },
  { name: "package.json", type: "file", path: "package.json", size: 612 },
  {
    name: "src",
    type: "folder",
    path: "src",
    children: [
      { name: "index.ts", type: "file", path: "src/index.ts", size: 318 },
      {
        name: "lib",
        type: "folder",
        path: "src/lib",
        children: [{ name: "util.ts", type: "file", path: "src/lib/util.ts", size: 204 }],
      },
      {
        name: "components",
        type: "folder",
        path: "src/components",
        children: [
          { name: "Button.tsx", type: "file", path: "src/components/Button.tsx", size: 388 },
        ],
      },
      {
        name: "nested",
        type: "folder",
        path: "src/nested",
        children: [{ name: "deep.ts", type: "file", path: "src/nested/deep.ts", size: 156 }],
      },
    ],
  },
];

/** Everything except the seeded workspace serves a minimal single-file tree. */
const MINIMAL_TREE: TreeNode[] = [{ name: "README.md", type: "file", path: "README.md", size: 256 }];

/** Short realistic bodies for the code panel; keyed by root-relative path. */
const FILES: Record<string, string> = {
  "README.md":
    "# ACUTE-CODE\n\nAgent-native coding workspace: Vite + React frontend, agent-core\nsidecar, Tauri shell.\n\n## Dev\n\n```sh\npnpm install\npnpm dev:full\n```\n\n## Verify\n\n`pnpm verify` runs lint, typecheck, tests, build, e2e and the license audit.\n",
  "package.json":
    '{\n  "name": "acute-code",\n  "private": true,\n  "type": "module",\n  "scripts": {\n    "dev": "vite",\n    "verify": "pnpm lint && pnpm typecheck && pnpm test && pnpm build"\n  }\n}\n',
  "src/index.ts":
    'import { createRoot } from "react-dom/client";\nimport { App } from "./components/App";\n\nconst root = document.getElementById("root");\nif (!root) throw new Error("#root missing in index.html");\n\ncreateRoot(root).render(<App />);\n',
  "src/lib/util.ts":
    '/** Small shared helpers kept dependency-free. */\nexport function clamp(value: number, min: number, max: number): number {\n  return Math.max(min, Math.min(max, value));\n}\n\nexport function truncate(text: string, max = 80): string {\n  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;\n}\n',
  "src/components/Button.tsx":
    'import type { ButtonHTMLAttributes } from "react";\n\ninterface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {\n  variant?: "primary" | "ghost";\n}\n\nexport function Button({ variant = "primary", ...rest }: ButtonProps) {\n  return <button data-variant={variant} {...rest} />;\n}\n',
  "src/nested/deep.ts":
    "// Fixture for depth-3 nesting in the explorer tree.\nexport const DEPTH = 3;\n",
};

/** Build an isolated fixture backend; the UI shares a single memoized one. */
export function createFixtureProjects(seed: Project[] = SEED): ProjectsBackend {
  const projects = new Map(seed.map((p) => [p.id, { ...p }]));
  // The first seed gets the rich demo workspace; every other project serves a
  // minimal single-file tree (mirrors "new project before anything is written").
  const richTreeId = seed[0]?.id;
  const cloneTree = (projectId: string): TreeNode[] =>
    JSON.parse(JSON.stringify(projectId === richTreeId ? ACUTE_TREE : MINIMAL_TREE));

  const ok = <T>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 10));

  const find = (id: string): Project => {
    const project = projects.get(id);
    if (!project) throw new ApiError(404, "NOT_FOUND", `no project with id ${id}`);
    return project;
  };

  return {
    list: () => ok([...projects.values()].map((p) => ({ ...p }))),
    create: (name, rootPath, color) => {
      if ([...projects.values()].some((p) => p.rootPath === rootPath)) {
        throw new ApiError(
          409,
          "CONFLICT",
          `a project already uses the folder ${rootPath}`,
          { field: "body.rootPath" },
        );
      }
      const project: Project = {
        id: uid("prj"),
        name,
        rootPath,
        color: color ?? PALETTE[projects.size % PALETTE.length],
        createdAt: now(),
      };
      projects.set(project.id, project);
      return ok({ ...project });
    },
    get: (id) => ok({ ...find(id) }),
    remove: (id) => {
      // R128-W3 → R129-S: the Scratchpad project (stable id "general") is
      // delete-protected (mirrors the live DELETE /projects/:id → 409
      // general_protected; the message stays in lockstep with the live
      // route's spelling — the R129 "Scratchpad" name).
      if (id === GENERAL_PROJECT_ID) {
        throw new ApiError(
          409,
          "general_protected",
          "The Scratchpad project is the app's internal workspace — it cannot be deleted",
        );
      }
      find(id);
      projects.delete(id);
      return ok(undefined);
    },
    tree: (id) => {
      const project = find(id);
      return ok({
        tree: cloneTree(project.id),
        rootPath: project.rootPath,
      });
    },
    file: (id, path) => {
      const project = find(id);
      const content = FILES[path] ?? `// ${path}\n// Demo fixture: no seeded contents for this path (project ${project.name}).\n`;
      return ok({ path, content });
    },
  };
}

let shared: ProjectsBackend | null = null;

/** Memoized instance so toggling demoData off/on keeps demo edits. */
export function getFixtureProjects(): ProjectsBackend {
  shared ??= createFixtureProjects();
  return shared;
}

/** Re-seed the shared demo backend (test isolation / "reset demo data"). */
export function resetFixtureProjects() {
  shared = null;
}
