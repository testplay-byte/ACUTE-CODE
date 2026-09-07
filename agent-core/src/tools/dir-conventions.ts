/**
 * ROUND-72 (R72-d): PER-DIRECTORY CONVENTIONS — the kilocode AGENTS.md
 * pattern, adapted for our read_file.
 *
 * The insight (from the R71-b kilocode research): conventions apply WHERE
 * YOU ARE ABOUT TO EDIT. A repo often carries a root AGENTS.md (repo-wide
 * policy) plus DEEPER AGENTS.md/CLAUDE.md files that scope extra rules to a
 * subtree — "everything under src/embedded/ follows MISRA-C", "tests in
 * this directory use vitest, never jest", "run pnpm --filter before
 * touching anything here". readCustomRules (agents/prompts.ts) loads ONLY
 * the ROOT convention files at prompt-assembly time; a model reading a file
 * six levels deep has no idea the subtree carries its own rules — until it
 * edits the wrong way. read_file of <path> now appends a clearly-fenced
 * reminder quoting the deepest convention file governing that path, so the
 * rules ride along with the exact content the model is about to change.
 *
 * Design decisions, all deliberate:
 *
 *   - ROOT AGENTS.md/CLAUDE.md is SKIPPED. readCustomRules already injects
 *     it (with @-import expansion + its own caps) into the system prompt of
 *     every turn — appending it again to read results would double-bill the
 *     context window for zero new information. Only directories STRICTLY
 *     BELOW the root are considered; a file directly in the root therefore
 *     gets no reminder (it has no ancestor below the root).
 *   - DEEPEST WINS: the walk starts at the read file's own directory and
 *     climbs toward (but never reaches) the project root, nearest level
 *     first. At each level AGENTS.md is checked before CLAUDE.md. A wrong-
 *     shaped candidate (a DIRECTORY named AGENTS.md) or an unreadable one
 *     is skipped, and the walk continues to the next candidate/level.
 *   - EXACT CASE ONLY — no agents.md/claude.md fallbacks. The exact-case
 *     filenames are the cross-tool convention (agents.md spec, Claude Code,
 *     kilocode, our own readCustomRules), and a case-insensitive probe
 *     would silently pick up an unrelated file on case-insensitive
 *     filesystems (macOS/Windows) while behaving differently on Linux —
 *     the R70 CI lesson, generalized: never let behavior differ by OS.
 *   - Content is read FRESH on every call — no cache, not even an
 *     mtime-keyed one: convention files change while a session is live
 *     (the owner edits rules mid-task), the read is one small file, and a
 *     stale reminder is worse than a re-read.
 *   - ONCE per (session, dir): the same reminder on every read_file under a
 *     directory would be pure repetition — the first read carries it into
 *     the context, later reads stay clean. With NO session (bare builds:
 *     REST exploratory contexts, tool-level tests) it injects EVERY time —
 *     deterministic, and the only choice that keeps sessionless tests
 *     honest without a session fixture.
 *   - Honest failures: unreadable, non-regular, or absent convention file
 *     → null → NO reminder. This is a reminder, not a gate — a broken
 *     convention file must never break the read that would carry it.
 *   - The excerpt is capped at 2,000 chars with an honest truncation
 *     marker — same policy as every other cap in this codebase (the
 *     reminder is a hint, not a second system prompt).
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, posix } from "node:path";

/** Convention file names, in priority order at each directory level. */
const CONVENTION_FILE_NAMES: readonly string[] = ["AGENTS.md", "CLAUDE.md"];

/** Excerpt cap — see the module header. */
const EXCERPT_CAP = 2_000;

/** One located per-directory convention file. */
export interface DirConvention {
  /** Directory holding the file, relative to the project root, POSIX separators ("a/b"). */
  dir: string;
  /** The convention file itself, relative to the project root ("a/b/AGENTS.md"). */
  file: string;
  /** Verbatim head of the file (≤ EXCERPT_CAP chars) + the honest truncation marker when clipped. */
  excerpt: string;
}

/** Read one convention candidate — null when missing, unreadable, or not a
 * regular file (a directory named AGENTS.md is not a convention). */
function readConventionFile(abs: string): string | null {
  try {
    if (!statSync(abs).isFile()) return null;
    return readFileSync(abs, "utf8");
  } catch {
    return null; // unreadable — this is a reminder, not a gate
  }
}

/** The excerpt: verbatim head, honest marker when there is more. */
function excerptOf(text: string): string {
  if (text.length <= EXCERPT_CAP) return text;
  return `${text.slice(0, EXCERPT_CAP)}\n…[truncated, ${EXCERPT_CAP} of ${text.length} chars]…`;
}

/**
 * Find the DEEPEST convention file (AGENTS.md, else CLAUDE.md) governing
 * `relativeFilePath`: walk the file's directory chain UP toward (but
 * EXCLUDING) the project root, nearest level first. Root-level files are
 * skipped by design — readCustomRules already injects them into every
 * turn's system prompt (no double-billing; see the module header).
 * Returns null when nothing governs the path. Never throws.
 */
export function findDeepestConvention(root: string, relativeFilePath: string): DirConvention | null {
  // The same normalization posture as fs-ops.resolveInsideRoot: backslashes
  // are separators, the path must be relative and contained. readFileWindow
  // has already rejected bad paths before the plugin calls us, but direct
  // callers (tests) get the same defense — a bad path can never win.
  const cleaned = relativeFilePath.trim().replaceAll("\\", "/");
  if (cleaned === "" || cleaned === ".") return null;
  if (isAbsolute(cleaned) || /^[a-zA-Z]:/.test(cleaned)) return null;
  const normalized = posix.normalize(cleaned);
  if (normalized.startsWith("..") || normalized === ".." || normalized.includes("../")) return null;

  const dir = posix.dirname(normalized); // "." for a file directly in the root
  if (dir === "." || dir === "/" || dir === "") return null; // no ancestor strictly below root
  const parts = dir.split("/");
  // Nearest-first: "a/b" checks "a/b", then "a" — the root itself is never
  // a level. The first readable candidate at the deepest level wins.
  for (let depth = parts.length; depth >= 1; depth--) {
    const levelDir = parts.slice(0, depth).join("/");
    for (const name of CONVENTION_FILE_NAMES) {
      const text = readConventionFile(join(root, levelDir, name));
      if (text === null) continue;
      return { dir: levelDir, file: `${levelDir}/${name}`, excerpt: excerptOf(text) };
    }
  }
  return null;
}

/**
 * The reminder suffix appended AFTER read_file's numbered content. The
 * leading blank line + `---` fences + the "[conventions from …]" header
 * make it visibly SEPARATE from the file content, and the closing line
 * states explicitly that the file content above is unaffected — so the
 * model can always tell content from reminder (and a convention excerpt
 * that itself contains `---` cannot be mistaken for the closing fence).
 */
export function conventionReminder(convention: DirConvention): string {
  return (
    `\n\n--- [conventions from ${convention.file} apply to this file]\n` +
    `${convention.excerpt}\n` +
    `--- (end conventions — the file content above is unaffected)`
  );
}

/* ── Session-once dedup (module state, mirroring tools/edit-streak.ts) ────── */

const injected = new Map<string, true>();

/**
 * Should the reminder for (sessionId, dir) be injected? CHECK-AND-MARK: the
 * first call for a pair returns true and records it; later calls in this
 * process return false — once per session + directory, because the
 * reminder would otherwise repeat on every read_file under that dir. With
 * NO session (bare builds / tests) it returns true EVERY time and records
 * nothing: deterministic for sessionless callers, no map growth from them.
 * In-process and in-memory only, never persisted — like the edit-streak
 * counter, this is machine state about the conversation, not a fact about
 * it; entries are bounded by distinct (session, dir) pairs and wiped by the
 * test seam.
 */
export function shouldInject(sessionId: string | undefined, dir: string): boolean {
  if (sessionId === undefined) return true;
  const key = `${sessionId}::${dir}`;
  if (injected.has(key)) return false;
  injected.set(key, true);
  return true;
}

/** Test seam: wipe the dedup map (keeps suites independent of call order). */
export function resetDirConventionInjections(): void {
  injected.clear();
}
