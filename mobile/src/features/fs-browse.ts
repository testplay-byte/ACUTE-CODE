/**
 * fs-browse.ts — the phone's folder-picker client (R114-c): GET
 * /api/v1/system/fs/browse, the R114-b wire contract, consumed as-is:
 *
 *   GET /system/fs/browse?path=<abs>  → { path: string;
 *       parent: string | null;          (null at a filesystem root)
 *       entries: Array<{name, path, dir}> (dirs first, then files, each
 *                                          alphabetical; dotfiles skipped);
 *       truncated: boolean }             (the honest 400-entry cap flag)
 *
 * Blank/omitted path = the SERVER's home directory — the New Project sheet's
 * browse starts there. The route never returns file CONTENTS (names + dir
 * flags only), so this client has nothing to be careful about beyond the
 * typed outcome. Injectable sender, apiJson/outcome types — the house
 * pattern (no React Native, no link import).
 */

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
  /** The parent directory — the Up affordance's next hop; null at a root. */
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
