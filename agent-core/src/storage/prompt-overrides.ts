/**
 * ROUND-98 (R98-E1, the prompt-customization UI — the owner: "add prompt
 * customizability… customizing them better in the settings, getting a
 * proper visual experience"): the WRITE side of the `.acute/prompts/`
 * override files.
 *
 * The override ENGINE has existed since R59-F (agent-core/src/agents/
 * prompt-registry.ts loadPromptOverrides → prompts.ts applySectionOverrides:
 * replace wholesale, empty = drop, `_order.txt` reorder, 8K cap,
 * diagnostics) — but the only authoring paths were a text editor and the
 * offline CLI. This module is the storage layer the new /prompts routes
 * (routes/prompts.ts) drive: read/write/delete ONE section's override file
 * for a project root.
 *
 * WHY a separate module (documented per the workstream's design call): the
 * registry's loader is deliberately PURE + fail-soft — an unknown filename
 * or an oversized file is a DIAGNOSTIC, never an exception, because a turn
 * must never die on a bad override file. Authoring is the opposite shape:
 * the route-facing writer VALIDATES and THROWS honest errors (unknown id,
 * over-cap content) so the UI can refuse a bad save before anything lands
 * on disk. Keeping the writer out of prompt-registry.ts preserves the
 * loader's purity contract (the CLI imports it with zero route surface).
 *
 * Semantics (the engine's, restated — the writer never invents new ones):
 *   · content replaces the section wholesale when non-empty;
 *   · content that TRIMS to empty writes an empty file = DROP the section
 *     (the remove lever) — the routes and UI warn before this lands;
 *   · deleting the file = REVERT to the built-in section.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  isKnownSectionId,
  PROMPT_OVERRIDE_CHAR_CAP,
  type SectionId,
} from "../agents/prompt-registry.js";

/** The override file for one section: `<root>/.acute/prompts/<id>.md`. */
export function promptOverrideFilePath(rootPath: string, id: SectionId): string {
  return join(rootPath, ".acute", "prompts", `${id}.md`);
}

/**
 * The RAW text of one section's override file (exactly what was saved —
 * the engine trims at LOAD time; the editor edits the file as written).
 * null when no file exists. A read failure (permissions, a directory named
 * like the file) also returns null — the loader's diagnostics own that
 * honesty on the next compose; the editor simply shows no stored override.
 */
export function readPromptOverride(rootPath: string, id: SectionId): string | null {
  const file = promptOverrideFilePath(rootPath, id);
  try {
    if (!existsSync(file) || !statSync(file).isFile()) return null;
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** writePromptOverride's result — what landed, and whether it is a drop. */
export interface PromptOverrideWriteResult {
  rootPath: string;
  id: SectionId;
  /** The absolute file that was written. */
  file: string;
  /** The content as written (verbatim — trimming is the engine's job). */
  content: string;
  /** true when the content trims to empty = DROP-the-section semantics. */
  dropped: boolean;
}

/**
 * Write one section's override file (creating `.acute/prompts/` if needed).
 * THROWS (honest, route-mappable messages — never a silent misbehavior):
 *   · unknown section id (not in PROMPT_REGISTRY);
 *   · content over PROMPT_OVERRIDE_CHAR_CAP (8,000) — refuse up front so
 *     the owner fixes the text instead of shipping a file the loader would
 *     truncate + diagnose every turn.
 */
export function writePromptOverride(rootPath: string, id: SectionId, content: string): PromptOverrideWriteResult {
  if (!isKnownSectionId(id)) {
    throw new Error(
      `unknown section id "${id}" — the override file must be named after a registry section id exactly (see GET /prompts/sections)`,
    );
  }
  if (content.length > PROMPT_OVERRIDE_CHAR_CAP) {
    throw new Error(
      `override content is ${content.length.toLocaleString("en-US")} chars — the cap is ${PROMPT_OVERRIDE_CHAR_CAP.toLocaleString("en-US")} (trim the text; a longer file would be truncated and diagnosed on every load)`,
    );
  }
  const file = promptOverrideFilePath(rootPath, id);
  mkdirSync(join(rootPath, ".acute", "prompts"), { recursive: true });
  writeFileSync(file, content, "utf8");
  return { rootPath, id, file, content, dropped: content.trim() === "" };
}

/** deletePromptOverride's result — the revert-to-default outcome. */
export interface PromptOverrideDeleteResult {
  /** true when the removal succeeded (or nothing was there to remove). */
  ok: boolean;
  /** true when a file actually existed and was removed. */
  existed: boolean;
  file: string;
  /** Set only when ok=false — the honest cause (e.g. a directory sitting at the path). */
  note?: string;
}

/**
 * Remove one section's override file = REVERT that section to its built-in
 * composition. Idempotent: removing an absent file is a successful revert
 * (existed:false). A non-file sitting at the path (a directory named
 * `<id>.md`) refuses honestly instead of recursively deleting anything.
 */
export function deletePromptOverride(rootPath: string, id: SectionId): PromptOverrideDeleteResult {
  const file = promptOverrideFilePath(rootPath, id);
  try {
    if (!existsSync(file)) return { ok: true, existed: false, file };
    if (!statSync(file).isFile()) {
      return { ok: false, existed: true, file, note: `${file} is not a regular file — remove it manually` };
    }
    rmSync(file);
    return { ok: true, existed: true, file };
  } catch (err) {
    return { ok: false, existed: true, file, note: String(err) };
  }
}
