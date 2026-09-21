/**
 * fs-browse.ts — the phone's folder-picker client (R114-c): GET
 * /api/v1/system/fs/browse, the R114-b wire contract, consumed as-is:
 *
 *   GET /system/fs/browse?path=<abs>  → { path: string;
 *       parent: string | null;          (null at a filesystem root AND at
 *                                          the user's home dir — R115-h:
 *                                          navigation caps at home, the
 *                                          picker hides Up there)
 *       entries: Array<{name, path, dir}> (dirs first, then files, each
 *                                          alphabetical; dotfiles skipped);
 *       truncated: boolean }             (the honest 400-entry cap flag)
 *
 * Blank/omitted path = the SERVER's home directory — the New Project sheet's
 * browse starts there. The route never returns file CONTENTS (names + dir
 * flags only), so this client has nothing to be careful about beyond the
 * typed outcome. Injectable sender, apiJson/outcome types — the house
 * pattern (no link import, no UI).
 *
 * R116-k — the REMEMBERED DEFAULT DIR: the last successfully-created
 * project's parent dir, persisted through AsyncStorage, seeds every New
 * Project sheet open (falling back to the server home when none is
 * stored). Storage is mocked in jest.setup.js, so importing it here never
 * touches a native bridge from any test.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";

import { apiJson, type ApiOutcome, type ApiSender } from "./api";

/** One browsed entry — a NAME and a dir flag, never contents. */
export interface FsBrowseEntry {
  name: string;
  path: string;
  dir: boolean;
}

/** The browse reply (1:1 with the route's body). */
export interface FsBrowseReply {
  /** The directory this reply lists (the browse target, resolved). */
  path: string;
  /** The parent directory — the Up affordance's next hop; null at a
   * filesystem root AND at the user's home dir (R115-h: navigation caps at
   * home — never an Up past it; the manual path field stays the power-user
   * escape hatch). */
  parent: string | null;
  /** Dirs first then files, each alphabetical; dotfiles already skipped. */
  entries: FsBrowseEntry[];
  /** True when the 400-entry cap cut the list — the caption says so. */
  truncated: boolean;
}

/**
 * Browse one directory on the paired desktop. `path` omitted/blank → the
 * server's home dir (the sheet's starting point); a missing folder is the
 * route's honest 404 OUTCOME (never a throw — transport only throws when
 * the manager already went offline).
 */
export async function fetchFsBrowse(
  sender: ApiSender,
  path?: string,
): Promise<ApiOutcome<FsBrowseReply>> {
  const trimmed = path?.trim() ?? "";
  const query = trimmed === "" ? "" : `?path=${encodeURIComponent(trimmed)}`;
  return apiJson<FsBrowseReply>(sender, `/system/fs/browse${query}`);
}

/**
 * The breadcrumb segments of an absolute path — the folder picker's
 * tappable ancestry ("/home/z/repos" → [/, /home, /home/z, /home/z/repos]).
 * Pure; a trailing slash never yields an empty segment, and a bare root
 * ("/" or "C:\\") is ONE segment. Windows separators normalize to "/".
 */
export function breadcrumbSegments(path: string): Array<{ label: string; path: string }> {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalized === "" || normalized === "/") {
    return [{ label: "/", path: "/" }];
  }
  const isAbsolute = normalized.startsWith("/");
  const parts = normalized.split("/").filter((part) => part !== "");
  const segments: Array<{ label: string; path: string }> = [];
  let acc = "";
  for (const part of parts) {
    acc = acc === "" && !isAbsolute ? part : `${acc}/${part}`;
    segments.push({ label: part, path: acc });
  }
  return isAbsolute ? [{ label: "/", path: "/" }, ...segments] : segments;
}

/**
 * shortRootPath — the smart path line for project rows (R115-h): the root
 * path folded to a display budget (default 22 chars — a mono-12px string
 * the row can actually show; R116-k tightened it from 28, which overflowed
 * the row's width). The rules, in order:
 *   1. separators normalize to "/" and trailing slashes drop;
 *   2. the TRAILING segment drops when it equals the project's name
 *      (case-insensitive) — the row already says the name, the path line
 *      orients ("acute-code" + "/home/z/repos/acute-code" →
 *      "/home/z/repos");
 *   3. the TAIL that fits the budget is kept — when leading folders shed,
 *      the line prefixes "…/";
 *   4. a single segment too long for the budget middle-truncates with "…".
 * The filesystem root answers "/" (a Windows drive root answers "C:/").
 * Pure; never throws.
 */
export function shortRootPath(rootPath: string, projectName: string, budget = 22): string {
  const slashed = rootPath.replace(/\\/g, "/");
  if (slashed === "") return "";
  // A slash-only path IS the filesystem root (never an empty string).
  if (/^\/+$/.test(slashed)) return "/";
  const normalized = slashed.replace(/\/+$/, "");
  // A bare Windows drive root renders its own root form ("C:/").
  if (/^[A-Za-z]:$/.test(normalized)) return `${normalized}/`;

  const segments = normalized.split("/").filter((part) => part !== "");
  const name = projectName.trim().toLowerCase();
  // (2) the trailing drop — only when something remains below it (a lone
  // segment never drops: the path IS the project folder at a root).
  if (segments.length > 1 && name !== "" && segments[segments.length - 1]!.toLowerCase() === name) {
    segments.pop();
  }

  // (3) the full path — leading "/" for POSIX absolutes — when it fits.
  const absolute = normalized.startsWith("/");
  const full = `${absolute ? "/" : ""}${segments.join("/")}`;
  if (full.length <= budget) return full;

  // …else the tail that fits the shed allowance ("…/" costs two chars).
  const allowance = Math.max(1, budget - 2);
  const tail: string[] = [];
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const segment = segments[i]!;
    const joined = tail.length === 0 ? segment.length : segment.length + 1 + tail.join("/").length;
    if (joined > allowance) break;
    tail.unshift(segment);
  }
  if (tail.length > 0) return `…/${tail.join("/")}`;

  // (4) a single over-long segment — middle-truncate it to the budget.
  const last = segments[segments.length - 1] ?? normalized;
  const keep = Math.max(1, budget - 1);
  const left = Math.ceil(keep / 2);
  const right = keep - left;
  return `${last.slice(0, left)}…${last.slice(last.length - right)}`;
}

// ── the remembered default dir (R116-k) ─────────────────────────────────

/** The AsyncStorage key — the last successfully-created project's parent
 * dir; every New Project sheet open seeds its browse from it. */
const DEFAULT_PROJECT_DIR_KEY = "acute.default-project-dir";

/** Load the remembered default project dir (null when none is stored or
 * storage refuses — the sheet falls back to the server home; never a
 * blocked browse). */
export async function loadDefaultProjectDir(): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(DEFAULT_PROJECT_DIR_KEY);
    if (raw === null) return null;
    const trimmed = raw.trim();
    return trimmed === "" ? null : trimmed;
  } catch {
    return null;
  }
}

/** Persist the remembered default project dir (best-effort — a refused
 * write never blocks the create; the next open just starts from home). */
export async function saveDefaultProjectDir(dir: string): Promise<void> {
  try {
    await AsyncStorage.setItem(DEFAULT_PROJECT_DIR_KEY, dir);
  } catch {
    /* best-effort */
  }
}

/** Forget the remembered default (best-effort) — a stale dir the desktop
 * no longer lists. */
export async function clearDefaultProjectDir(): Promise<void> {
  try {
    await AsyncStorage.removeItem(DEFAULT_PROJECT_DIR_KEY);
  } catch {
    /* best-effort */
  }
}

/**
 * The parent directory of an absolute path — the create-success save's
 * value ("/home/z/repos/acute-code" → "/home/z/repos": the folder the
 * next project is a sibling of). Windows separators normalize to "/"; a
 * path with no parent (a bare root) answers null. Pure; never throws.
 */
export function parentDirOf(path: string): string | null {
  const slashed = path.replace(/\\/g, "/");
  const normalized = slashed.replace(/\/+$/, "");
  const isAbsolute = normalized.startsWith("/");
  const parts = normalized.split("/").filter((part) => part !== "");
  if (parts.length <= 1) return null;
  parts.pop();
  return `${isAbsolute ? "/" : ""}${parts.join("/")}`;
}
