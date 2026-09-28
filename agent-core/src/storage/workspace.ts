/**
 * ROUND-131 (R131-F, Wave F — the workspace scaffold): the owner's
 * directive — "whenever the user selects a folder… all the necessary files
 * and folders for it should be created… it will create a hidden folder or
 * our own folder where it will store its own things which it needs to, or
 * temporary things… so that the actual folder does not get affected by it
 * and the user's actual projects are handled properly."
 *
 * THE LAW (PROJECT-MEMORY.md, amended this round): every project root gets
 * a `.acute/` workspace — the app's OWN drawer inside the user's folder,
 * invisible in the Files tree (fs-ops.ts hides dot-dirs) and never
 * touching any other file in the root:
 *
 *   <root>/.acute/downloads/  — files fetched/downloaded for the project
 *   <root>/.acute/tools/      — the agent's self-built tools (the
 *                                create-tool skill's convention)
 *   <root>/.acute/memory/     — the project's file-carried memory artifacts
 *   <root>/.acute/tmp/        — scratch space for one task's intermediates
 *   <root>/.acute/workspace.json — the MARKER: {version, createdAt,
 *                                appVersion} — the "previously used"
 *                                signal and the resume anchor.
 *
 * The `.acute/` convention already existed in PART (skills/, prompts/,
 * agents/, plugins/, computer-use/audit.jsonl — each consumer made its own
 * folder on demand); this module makes the SCAFFOLD itself a first-class,
 * idempotent, versioned operation with ONE marker, called from
 * POST /projects (fresh folders) and the boot seed (the Scratchpad root —
 * the previously-used-folder heal).
 *
 * Contract (both call sites, pinned in tests/r131-workspace.test.ts):
 *   · marker ABSENT  → create `.acute/` + the four subfolders + write the
 *     marker → {created: true}. The FRESH-folder path.
 *   · marker PRESENT → previously used: re-create any MISSING subfolder
 *     (a resume/heal — an older version's tree, a user deletion, a partial
 *     write) → {healed: true} iff anything was missing. The marker itself
 *     is NEVER rewritten on this path — createdAt is the workspace's
 *     history and survives every boot (the R129 idempotence posture).
 *   · NEVER touches any other file in the root — only `.acute/` and only
 *     the four named subfolders + the marker. No enumeration, no cleanup,
 *     no deletion: the user's actual project files are the user's.
 *   · Failures THROW the honest error (naming the path + the underlying
 *     code) — the module never swallows; the CALLERS degrade (the route
 *     answers a `workspaceWarning`, the boot logs and continues; the
 *     project itself works fine without the scaffold).
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// The storage layer's logging idiom (general-project.ts is the precedent):
// structured JSON-lines via lib/log.ts — never a bare console call.
import { log } from "../lib/log.js";
import { readAppVersion } from "../lib/version.js";

/** The app's own drawer inside a project root (dot-dir: hidden from the
 * Files tree by fs-ops.ts's walkDir, tool-accessible like any path). */
export const WORKSPACE_DIR_NAME = ".acute";

/** The scaffold's marker file (inside `.acute/`). */
export const WORKSPACE_MARKER_NAME = "workspace.json";

/** The marker's schema version — bumped only on a breaking marker change
 * (the resume path re-reads it tolerantly; v1 is the initial shape). */
export const WORKSPACE_MARKER_VERSION = 1;

/** The four scaffolded subfolders, in creation (and documentation) order.
 * Deliberately FIXED: consumers below `.acute/` (downloads, the create-tool
 * skill, memory artifacts, tmp scratch) pin these exact names; the scaffold
 * never invents new ones at runtime. */
export const WORKSPACE_SUBFOLDERS: readonly string[] = ["downloads", "tools", "memory", "tmp"];

/** What ensureProjectWorkspace did (the honest, assertable answer). */
export interface ProjectWorkspaceResult {
  /** True when the marker was written THIS call — the fresh-folder path. */
  created: boolean;
  /** True when the marker already existed and at least one subfolder was
   * missing and re-created — the resume/heal path (previously-used folder). */
  healed: boolean;
  /** The four subfolder paths (absolute) — present regardless of path
   * taken, so callers/tests can assert the full scaffold in one field. */
  subfolders: string[];
}

/** The marker's shape (v1). `createdAt` is written ONCE (fresh path) and
 * never rewritten — the workspace's own history. */
export interface WorkspaceMarker {
  version: number;
  createdAt: string;
  appVersion: string;
}

/** The marker file's absolute path inside a project root. */
export function workspaceMarkerPath(root: string): string {
  return join(root, WORKSPACE_DIR_NAME, WORKSPACE_MARKER_NAME);
}

/** Absolute path of one scaffolded subfolder (`name` must be one of
 * WORKSPACE_SUBFOLDERS — the typed convenience callers use). */
export function workspaceSubfolderPath(root: string, name: string): string {
  return join(root, WORKSPACE_DIR_NAME, name);
}

/**
 * Read a project root's workspace marker — null when absent (fresh folder)
 * or unreadable/unparseable (a corrupt marker is STILL a marker: the
 * resume path keys on the FILE's existence, never its parse, so a corrupt
 * marker never triggers a re-scaffold that would overwrite it; the honest
 * note is logged instead).
 */
export function readWorkspaceMarker(root: string): WorkspaceMarker | null {
  const path = workspaceMarkerPath(root);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<WorkspaceMarker>;
    if (
      typeof parsed.version !== "number" ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.appVersion !== "string"
    ) {
      log("warn", "workspace.marker_corrupt", { path, note: "keeping the file; healing subfolders only" });
      return null;
    }
    return { version: parsed.version, createdAt: parsed.createdAt, appVersion: parsed.appVersion };
  } catch (err) {
    log("warn", "workspace.marker_corrupt", {
      path,
      message: err instanceof Error ? err.message : String(err),
      note: "keeping the file; healing subfolders only",
    });
    return null;
  }
}

/**
 * Ensure a project root's `.acute/` workspace exists and is whole.
 *
 * FRESH (no marker file): mkdir `.acute/` + the four subfolders (recursive
 * — `.acute/` itself is materialized by the first subfolder's mkdir), then
 * write the marker {version: 1, createdAt: now, appVersion}. Returns
 * {created: true, healed: false, subfolders}.
 *
 * RESUME (marker file present — parseable or not): re-create any MISSING
 * subfolder of the four, leave everything else byte-untouched (the marker
 * is NEVER rewritten — createdAt preserved). Returns {created: false,
 * healed: <any missing>, subfolders}. This is the "previously used folder"
 * path the owner asked for: opening an old project heals its workspace
 * instead of pretending it was never set up.
 *
 * THROWS (honest, never swallowed here):
 *   · the root itself does not exist / is not a directory — the exact
 *     precondition the ledger's `spawn cmd.exe ENOENT` hid (a missing cwd
 *     named the EXECUTABLE); this error names the DIRECTORY;
 *   · a subfolder mkdir failed (permissions / `.acute` exists as a FILE) —
 *     the message carries the path + the underlying errno code;
 *   · the marker write failed (fresh path only).
 * The CALLERS degrade: POST /projects answers a 201 + `workspaceWarning`
 * (the project still works without the scaffold); the boot heal logs and
 * continues. Never touches any file outside `.acute/`.
 */
export function ensureProjectWorkspace(root: string): ProjectWorkspaceResult {
  // The precondition, checked honestly FIRST: a vanished root (the
  // legacy-install ENOENT shape) must fail HERE with the directory named,
  // never inside spawn as a lie about the executable. A root that exists
  // but is NOT a directory gets its own honest spelling (existsSync is the
  // tiebreaker — statSync alone cannot tell "missing" from "is a file"
  // once it threw).
  let rootIsDirectory = false;
  try {
    rootIsDirectory = statSync(root).isDirectory();
  } catch {
    rootIsDirectory = false;
  }
  if (!rootIsDirectory) {
    const rootExists = existsSync(root);
    throw new Error(
      `cannot scaffold the workspace — the project folder ${root} ${rootExists ? "is not a directory" : "does not exist"}`,
    );
  }

  const markerExists = existsSync(workspaceMarkerPath(root));
  const subfolders = WORKSPACE_SUBFOLDERS.map((name) => workspaceSubfolderPath(root, name));
  let healed = false;
  for (const dir of subfolders) {
    if (existsSync(dir)) continue;
    try {
      mkdirSync(dir, { recursive: true });
      healed = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      throw new Error(
        `cannot scaffold the workspace — failed to create ${dir}${code !== undefined ? ` (${code})` : ""}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (!markerExists) {
    const marker: WorkspaceMarker = {
      version: WORKSPACE_MARKER_VERSION,
      createdAt: new Date().toISOString(),
      appVersion: readAppVersion(),
    };
    try {
      writeFileSync(workspaceMarkerPath(root), `${JSON.stringify(marker, null, 2)}\n`, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      throw new Error(
        `cannot scaffold the workspace — failed to write ${workspaceMarkerPath(root)}${code !== undefined ? ` (${code})` : ""}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { created: true, healed: false, subfolders };
  }
  return { created: false, healed, subfolders };
}
