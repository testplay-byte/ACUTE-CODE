/**
 * ROUND-70 (R70-b, D1): FILE-BASED SKILLS — the Agent-Skills standard
 * (agentskills.io; R70-B recommendation #5) merged with the R61 SQLite
 * skills table.
 *
 * Sources discovered from the FILESYSTEM (no DB rows — read-only skills):
 *   · project:  <projectRoot>/.acute/skills/<name>/SKILL.md   (the ACUTE
 *               convention — same tree as .acute/rules/.acute/prompts)
 *               plus flat `<name>.md` files directly in .acute/skills/
 *               for simplicity (dir form wins on a same-name collision).
 *   · global:   ~/.agents/skills/<name>/SKILL.md (the CROSS-AGENT standard
 *               location — shared with goose/OpenHands/Claude-style agents)
 *               plus the same flat `<name>.md` tolerance.
 *
 * Frontmatter: `---` delimited `name:` + `description:` (the Claude Agent
 * Skills format). Tolerance decisions (deliberate, fail-soft like the rest
 * of the repo):
 *   · No frontmatter at all     → name derived from the slug (dir name /
 *     file stem), generic description. A bare markdown file is still a
 *     usable skill; the dir name is the standard's own name carrier.
 *   · Frontmatter `name` present + a valid slug → the frontmatter name WINS
 *     over the slug (goose behavior; the directory is a container).
 *   · Neither frontmatter name nor slug is a valid slug → the file is
 *     SKIPPED honestly (logged) — a skill the model could never name is
 *     noise, not a skill.
 *   · Unreadable / >512KB / binary-ish → skipped honestly (logged).
 *
 * MERGE SEMANTICS with the DB (the precedence contract):
 *   1. DB row (user-edited builtin or user-created) SHADOWS any file with
 *      the same name — enabled OR disabled. A disabled DB row means
 *      "hidden", never "fall through to a file". Creating a DB skill with
 *      a file skill's name is therefore the documented override path.
 *   2. project file > global file (nearest wins — the CLAUDE.md/AGENTS.md
 *      convention).
 *   3. File skills are READ-ONLY: no edit/delete through the skills CRUD
 *      (the routes refuse with "file-defined skill: edit the SKILL.md").
 *      Their visibility follows the file's existence — enabled is always
 *      true, and read_skill fails honestly if the file vanished.
 *
 * Caps (the R61 DB caps mirrored for files): description ≤ 500 chars,
 * body ≤ 60,000 chars, ≤ 32 file skills PER SOURCE (honest skip beyond —
 * logged, not surfaced as an error; one broken source never breaks a turn).
 *
 * ROUND-98 (R98-E2, the always-load tier): frontmatter `always-load: true`
 * (the exact lowercase spelling; anything else is false) pins a file skill
 * into the same tier as a pinned DB row — its FULL BODY rides the system
 * prompt every turn ("## ALWAYS-ON SKILLS", prompts.ts). Precedence is
 * unchanged: a DB row (pinned or not) SHADOWS a same-name file, so the
 * documented override path for a file skill's pin is a DB row with that
 * name. The body loads from the SAME source read_skill uses (the file on
 * disk at resolve time); a vanished file degrades to the honest failure
 * NOTE in the body slot — the ALWAYS-ON section shows the model the truth,
 * never silence.
 *
 * ROUND-72 (R72-c): REFERENCES DEPTH — dir-form skills may carry a
 * `references/` subdirectory of deeper .md files (one level, the Agent
 * Skills standard). Discovery lists them as METADATA ONLY (name = stem,
 * fileName, bytes — sorted by fileName, ≤ 8, .md only, hidden/underscore
 * skipped, > 64KB skipped + logged); bodies load at CALL time through
 * readSkillReference (sanitized name, frontmatter stripped, 64KB cap with
 * an honest marker) — the progressive-disclosure contract is unchanged.
 * Flat-file skills never have references. DB skills have none either: the
 * references ride FileSkillRecord → EffectiveSkill → MergedSkillRecord as
 * an additive optional field everywhere.
 */
import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { log } from "../lib/log.js";
import type { SqliteDatabase } from "./db.js";
import {
  COMPUTER_USE_SKILL_ID,
  listEnabledSkills,
  listSkills,
  NAME_RE,
} from "./skills.js";
import { getComputerUseSettings } from "./computer-use.js";
import { listProjects } from "./projects.js";

export type FileSkillSource = "project-file" | "global-file";

/** Provenance for the merged skill surface (additive over R61's
 * "builtin" | "user" — the listing endpoints mark files with these). */
export type SkillProvenance = "builtin" | "user" | FileSkillSource;

export const FILE_SKILL_BODY_CAP = 60_000;
export const FILE_SKILL_DESC_CAP = 500;
export const FILE_SKILLS_PER_SOURCE_CAP = 32;

/** ROUND-72 (R72-c): max reference files listed per skill (excess skipped
 * honestly + logged — the listing stays a digest, not a dump). */
export const FILE_SKILL_REFERENCES_CAP = 8;

/** ROUND-72 (R72-c): max size of ONE reference file. Discovery skips larger
 * files (logged); readSkillReference independently caps the returned body
 * at the same bound with an honest marker (a file that GREW between
 * discovery and load is bounded, never silently exploded). */
export const FILE_SKILL_REFERENCE_SIZE_CAP = 64 * 1024;

/** ROUND-72 (R72-c): one reference file of a dir-form skill —
 * <skillDir>/references/<fileName>. `name` is the fileName stem: exactly
 * what read_skill's `reference` parameter addresses. */
export interface FileSkillReference {
  name: string;
  fileName: string;
  bytes: number;
}

/** Reference names are model-addressable single tokens: letters, digits,
 * '.', '_', '-' — no separators, no traversal. The boundary guard for
 * readSkillReference (and the discovery skip rule: everything listed is
 * loadable). */
const REFERENCE_NAME_RE = /^[A-Za-z0-9._-]+$/;

export function isValidReferenceName(name: string): boolean {
  return REFERENCE_NAME_RE.test(name);
}

/** The shared rejection note (single source — the storage-level guard and
 * the read_skill tool prefix the same text, so they can never drift). */
export function referenceNameRejection(name: string): string {
  return `reference name rejected: '${name}' is not a safe reference name (letters, digits, '.', '_', '-' only — no path separators, no traversal)`;
}

/** A sane skill file is markdown, never megabytes — beyond this the file is
 * skipped honestly (the body cap is 60K anyway; this guard bounds reads). */
const FILE_SIZE_HARD_CAP = 512 * 1024;

export interface FileSkillRecord {
  name: string;
  description: string;
  source: FileSkillSource;
  /** R98-E2: frontmatter `always-load: true` — the file-skill reach of the
   * always-load tier (same composition as a pinned DB row). */
  alwaysLoad: boolean;
  /** Absolute path of the SKILL.md / <name>.md file (bodies are read from
   * disk at CALL time — see readFileSkillBody). */
  filePath: string;
  /** Scope key for the synthetic id: the owning project's id for
   * project-file skills, "global" for user-global ones. */
  scope: string;
  /** Project display name (project-file skills only — additive, for the
   * settings listing to disambiguate same-name skills across projects). */
  projectName?: string;
  /** ROUND-72 (R72-c): the references/ metadata (dir-form skills only —
   * flat files and DB rows always have none). METADATA ONLY: no content is
   * read at discovery; bodies load at CALL time via readSkillReference. */
  references: ReadonlyArray<FileSkillReference>;
}

/* ── synthetic ids for file skills (DB rows keep their real ids) ─────────── */

function idSafe(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

export function fileSkillId(source: FileSkillSource, name: string, scope: string): string {
  const prefix = source === "project-file" ? "skill_file_p" : "skill_file_g";
  return `${prefix}_${idSafe(scope) || "scope"}_${name.replace(/-/g, "_")}`;
}

/** True for the synthetic ids file skills carry — the CRUD routes use this
 * to refuse edit/delete with the honest "edit the SKILL.md" note. */
export function isFileSkillId(id: string): boolean {
  return id.startsWith("skill_file_p_") || id.startsWith("skill_file_g_");
}

/* ── frontmatter (the Claude Agent Skills format, tolerant subset) ───────── */

/**
 * Parse a `---` delimited frontmatter block. Only flat `key: value` lines
 * are understood (optionally quoted values); unknown keys are kept, YAML
 * block scalars are not supported. Returns undefined when the text has no
 * frontmatter OR the opening block is never closed (unparseable → the
 * caller treats the file as frontmatter-less).
 */
export function parseSkillFrontmatter(text: string): Map<string, string> | undefined {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return undefined;
  const lines = text.split("\n").slice(1);
  const fields = new Map<string, string>();
  let closed = false;
  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "---") {
      closed = true;
      break;
    }
    const idx = line.indexOf(":");
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      let value = line.slice(idx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
      ) {
        value = value.slice(1, -1);
      }
      if (key !== "" && !fields.has(key)) fields.set(key, value);
    }
  }
  return closed ? fields : undefined;
}

/** The body after a closed frontmatter block (whole text when absent). */
export function stripSkillFrontmatter(text: string): string {
  if (parseSkillFrontmatter(text) === undefined) return text;
  const lines = text.split("\n");
  // lines[0] is the opening fence; find the closing fence.
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].endsWith("\r") ? lines[i].slice(0, -1) : lines[i];
    if (line === "---") return lines.slice(i + 1).join("\n");
  }
  return text; // unreachable (parseSkillFrontmatter verified the fence)
}

const GENERIC_PROJECT_DESCRIPTION =
  "Project skill defined by a SKILL.md under .acute/skills/ — load it with read_skill for its instructions.";
const GENERIC_GLOBAL_DESCRIPTION =
  "User-global skill from ~/.agents/skills/ — load it with read_skill for its instructions.";

/* ── discovery ─────────────────────────────────────────────────────────────── */

interface Candidate {
  slug: string;
  filePath: string;
  dirForm: boolean;
  /** Dir-form only — the skill's own directory (references/ lives there). */
  skillDir?: string;
}

/** One source directory → resolved file skills (name-sorted, capped). */
function discoverFromDir(
  dir: string,
  source: FileSkillSource,
  scope: string,
  projectName: string | undefined,
): FileSkillRecord[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // missing dir (the common case), perms, … — no skills, no throw
  }
  const candidates: Candidate[] = [];
  for (const entry of entries) {
    // Hidden and underscore-prefixed entries are never skills (the
    // .gitkeep/_notes convention); node_modules-style junk stays out too.
    if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
    if (entry.isDirectory()) {
      const skillMd = join(dir, entry.name, "SKILL.md");
      try {
        if (!statSync(skillMd).isFile()) continue;
      } catch {
        continue;
      }
      candidates.push({ slug: entry.name, filePath: skillMd, dirForm: true, skillDir: join(dir, entry.name) });
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      candidates.push({ slug: entry.name.slice(0, -3), filePath: join(dir, entry.name), dirForm: false });
    }
  }
  // Deterministic order: slug, then dir-form first on a same-slug collision
  // (the standard form beats the flat convenience file).
  candidates.sort((a, b) =>
    a.slug === b.slug ? (a.dirForm === b.dirForm ? 0 : a.dirForm ? -1 : 1) : a.slug < b.slug ? -1 : 1,
  );

  const out: FileSkillRecord[] = [];
  const taken = new Set<string>();
  for (const candidate of candidates) {
    if (out.length >= FILE_SKILLS_PER_SOURCE_CAP) {
      log("warn", "skills_files.source_cap", {
        dir,
        skipped: candidates.length - out.length,
        cap: FILE_SKILLS_PER_SOURCE_CAP,
      });
      break;
    }
    let text: string;
    try {
      const stats = statSync(candidate.filePath);
      if (!stats.isFile() || stats.size > FILE_SIZE_HARD_CAP) {
        log("warn", "skills_files.skipped", { file: candidate.filePath, reason: "not a file or too large" });
        continue;
      }
      text = readFileSync(candidate.filePath, "utf8");
    } catch (err) {
      log("warn", "skills_files.skipped", {
        file: candidate.filePath,
        reason: (err as NodeJS.ErrnoException).code ?? String(err),
      });
      continue;
    }
    const frontmatter = parseSkillFrontmatter(text);
    const frontmatterName = frontmatter?.get("name")?.trim();
    // Frontmatter name (when a valid slug) wins over the slug; else the
    // slug; else the file is honestly skipped — the model could never
    // address it by name anyway.
    const name =
      frontmatterName !== undefined && NAME_RE.test(frontmatterName)
        ? frontmatterName
        : NAME_RE.test(candidate.slug)
          ? candidate.slug
          : undefined;
    if (name === undefined) {
      log("warn", "skills_files.skipped", {
        file: candidate.filePath,
        reason: `unusable skill name (slug '${candidate.slug}' is not a lowercase slug)`,
      });
      continue;
    }
    if (taken.has(name)) continue; // dir-form already took this name
    taken.add(name);
    const description =
      frontmatter?.get("description")?.trim().slice(0, FILE_SKILL_DESC_CAP) ||
      (source === "project-file" ? GENERIC_PROJECT_DESCRIPTION : GENERIC_GLOBAL_DESCRIPTION);
    // R98-E2: the always-load tier's file-side reach — `always-load: true`
    // (the exact lowercase spelling "true"; anything else reads as false —
    // fail-soft like every frontmatter tolerance here).
    const alwaysLoad = frontmatter?.get("always-load")?.trim().toLowerCase() === "true";
    out.push({
      name,
      description,
      source,
      alwaysLoad,
      filePath: candidate.filePath,
      scope,
      references:
        candidate.dirForm && candidate.skillDir !== undefined ? discoverSkillReferences(candidate.skillDir) : [],
      ...(projectName !== undefined ? { projectName } : {}),
    });
  }
  return out;
}

/**
 * ROUND-72 (R72-c): list a dir-form skill's references/ — one level of
 * deeper .md files (the Agent Skills standard). METADATA ONLY (name/fileName/
 * bytes; no content reads — bodies load at CALL time, keeping discovery
 * cheap and the progressive-disclosure contract intact). House rules,
 * mirroring the skills-dir conventions one level up:
 *   · .md files ONLY, extension case-sensitive (".MD" is not markdown here);
 *   · hidden (dot-prefixed) and underscore-prefixed files skipped;
 *   · sorted by fileName, capped at FILE_SKILL_REFERENCES_CAP (the first 8
 *     in sort order win — excess skipped with an honest log);
 *   · each ≤ FILE_SKILL_REFERENCE_SIZE_CAP on disk (larger skipped + logged);
 *   · a stem that is not a safe reference name (spaces, …) is skipped +
 *     logged — the sanitized loader could never address it, so everything
 *     listed is loadable.
 * A missing/unreadable references/ dir (the common case) → [] — never a
 * throw: one broken skill never breaks a turn.
 */
function discoverSkillReferences(skillDir: string): FileSkillReference[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(join(skillDir, "references"), { withFileTypes: true });
  } catch {
    return []; // no references/ dir (the common case), perms — no references, no throw
  }
  const found: FileSkillReference[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
    if (!entry.name.endsWith(".md")) continue;
    const filePath = join(skillDir, "references", entry.name);
    const name = entry.name.slice(0, -3);
    let bytes: number;
    try {
      const stats = statSync(filePath);
      if (!stats.isFile()) continue;
      bytes = stats.size;
    } catch {
      continue; // vanished between readdir and stat — skip honestly
    }
    if (bytes > FILE_SKILL_REFERENCE_SIZE_CAP) {
      log("warn", "skills_files.reference_skipped", {
        file: filePath,
        reason: "too large",
        bytes,
        cap: FILE_SKILL_REFERENCE_SIZE_CAP,
      });
      continue;
    }
    if (!isValidReferenceName(name)) {
      log("warn", "skills_files.reference_skipped", {
        file: filePath,
        reason: `unusable reference name ('${name}' — must be letters/digits/._-; the sanitized loader could never address it)`,
      });
      continue;
    }
    found.push({ name, fileName: entry.name, bytes });
  }
  // Deterministic order: fileName byte-order sort (stable across OSes).
  found.sort((a, b) => (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0));
  if (found.length > FILE_SKILL_REFERENCES_CAP) {
    const skipped = found.length - FILE_SKILL_REFERENCES_CAP;
    log("warn", "skills_files.reference_cap", {
      skillDir,
      skipped,
      kept: FILE_SKILL_REFERENCES_CAP,
      cap: FILE_SKILL_REFERENCES_CAP,
    });
    return found.slice(0, FILE_SKILL_REFERENCES_CAP);
  }
  return found;
}

/** The user-global standard directory (~/.agents/skills — cross-agent). */
export function globalSkillsDir(): string {
  return join(homedir(), ".agents", "skills");
}

/** Project-level skills: <root>/.acute/skills/<name>/SKILL.md + flat .md. */
export function discoverProjectFileSkills(projectRoot: string, scope = "project"): FileSkillRecord[] {
  return discoverFromDir(join(projectRoot, ".acute", "skills"), "project-file", scope, undefined);
}

/** User-global skills: ~/.agents/skills/<name>/SKILL.md + flat .md. */
export function discoverGlobalFileSkills(globalRoot?: string): FileSkillRecord[] {
  return discoverFromDir(globalRoot ?? globalSkillsDir(), "global-file", "global", undefined);
}

/** Both sources, project-first (nearest wins is applied by the callers'
 * name-dedup, not by ordering here — discovery order only fixes determinism). */
export function discoverFileSkills(projectRoot?: string, globalRoot?: string, projectScope = "project"): FileSkillRecord[] {
  const project = projectRoot !== undefined ? discoverProjectFileSkills(projectRoot, projectScope) : [];
  const global = discoverGlobalFileSkills(globalRoot);
  return [...project, ...global];
}

/* ── body loading (read from disk at CALL time) ───────────────────────────── */

export type FileSkillBodyResult =
  | { ok: true; body: string }
  | { ok: false; note: string };

export type FileSkillReferenceResult =
  | { ok: true; body: string }
  | { ok: false; note: string };

/**
 * Read a file skill's body NOW (frontmatter stripped, capped at
 * FILE_SKILL_BODY_CAP). Honest failure when the file vanished between
 * listing and load — the model must learn the file is gone, not get a
 * stale cached body.
 */
export function readFileSkillBody(filePath: string): FileSkillBodyResult {
  try {
    const text = readFileSync(filePath, "utf8");
    return { ok: true, body: stripSkillFrontmatter(text).trim().slice(0, FILE_SKILL_BODY_CAP) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        ok: false,
        note: `skill file no longer exists: ${filePath} (it was removed or renamed after the session listed it)`,
      };
    }
    return { ok: false, note: `skill file unreadable: ${filePath} (${code ?? String(err)})` };
  }
}

/**
 * ROUND-72 (R72-c): load ONE reference file of a dir-form skill NOW —
 * read_skill's `reference` parameter ends up here. Signature decision
 * (documented per the task): the first argument accepts EITHER the skill
 * DIRECTORY or the SKILL.md path — a ".md" suffix is treated as the skill
 * FILE and its parent directory becomes the skill dir (the plugin passes
 * the EffectiveSkill.filePath it already holds; tests and future callers
 * may pass the dir).
 *   · The reference name is sanitized FIRST (isValidReferenceName):
 *     traversal/separators are rejected with the reason, never resolved.
 *   · The reference's own frontmatter (references may carry one) is
 *     stripped — at READ time, exactly like SKILL.md bodies.
 *   · The returned body is capped at FILE_SKILL_REFERENCE_SIZE_CAP with an
 *     honest marker (fires when the file GREW past the cap after discovery
 *     — discovery already skips larger files).
 *   · ENOENT is honest: the file vanished after the session listed it.
 */
export function readSkillReference(skillDirOrPath: string, referenceName: string): FileSkillReferenceResult {
  if (!isValidReferenceName(referenceName)) {
    return { ok: false, note: referenceNameRejection(referenceName) };
  }
  const skillDir = skillDirOrPath.endsWith(".md") ? dirname(skillDirOrPath) : skillDirOrPath;
  const filePath = join(skillDir, "references", `${referenceName}.md`);
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        ok: false,
        note: `reference file no longer exists: ${filePath} (it was removed or renamed after the session listed it)`,
      };
    }
    return { ok: false, note: `reference file unreadable: ${filePath} (${code ?? String(err)})` };
  }
  const body = stripSkillFrontmatter(text).trim();
  if (body.length > FILE_SKILL_REFERENCE_SIZE_CAP) {
    const shown = body.slice(0, FILE_SKILL_REFERENCE_SIZE_CAP);
    return {
      ok: true,
      body: `${shown}\n\n…[reference truncated: ${shown.length} of ${body.length} chars shown — the file on disk is larger than the 64KB reference cap]`,
    };
  }
  return { ok: true, body };
}

/* ── the effective index (prompt SKILLS section + read_skill) ─────────────── */

/** One entry of the per-turn skill surface: name + description (the
 * progressive-disclosure index), provenance, and the id read_skill will
 * resolve the body through (DB id or synthetic file id). */
export interface EffectiveSkill {
  name: string;
  description: string;
  source: SkillProvenance;
  id: string;
  /** File skills only — the SKILL.md path (bodies load from disk). */
  filePath?: string;
  /** ROUND-72 (R72-c): file skills only — the references/ METADATA
   * (name/fileName/bytes; DB skills have none). Bodies load at CALL time
   * via readSkillReference. Additive: the prompt SKILLS section still maps
   * to name + description only. */
  references?: ReadonlyArray<FileSkillReference>;
  /** R98-E2: the ALWAYS-LOAD tier — set ONLY on pinned skills (DB row with
   * always_load=1 or file skill with `always-load: true` frontmatter, after
   * the DB-shadows-file precedence). Unpinned entries omit the field so
   * every pre-R98 consumer shape is unchanged. */
  alwaysLoad?: boolean;
  /** R98-E2: pinned skills ONLY — the full body that rides the system
   * prompt's "## ALWAYS-ON SKILLS" section, loaded HERE from the same
   * source read_skill uses (the DB row / readFileSkillBody). A failed file
   * read degrades to the honest failure NOTE (the model learns the file is
   * gone — never silence, never a stale cache). Unpinned entries omit it. */
  body?: string;
}

export interface ResolveSkillOptions {
  /** The session's project root — enables project-file discovery. */
  projectRoot?: string;
  /** Test seam for the user-global source (default ~/.agents/skills). */
  globalRoot?: string;
  /** Scope key for project-file synthetic ids (the project's id). */
  projectScope?: string;
  /**
   * ROUND-70 (R70-b, D5): the agent's skill allowlist — a NON-EMPTY array
   * filters the set by name (user-created, file, and builtin skills are all
   * filterable). Empty/undefined = all enabled skills (back-compat: the
   * field was stored since R61 but never read).
   */
  agentSkills?: readonly string[];
}

/**
 * The per-turn effective skill set — the ONE resolution both the prompt
 * SKILLS section (runtime.ts prepareTurn) and read_skill (the skills
 * plugin) use, so the advertised list and the loadable set can never
 * disagree. Semantics: enabled DB skills (the computer-use builtin is
 * GATED OUT while the master switch is off — R70-b D4, its tools are dark
 * so the discipline must not be advertised), then file skills where no DB
 * row shadows the name, then the agent allowlist filter (D5).
 *
 * R98-E2: a pinned skill (DB always_load=1, or `always-load: true` in a
 * file skill's frontmatter where no DB row shadows it) carries
 * `alwaysLoad: true` + its FULL `body` — the payload prompts.ts composes
 * into "## ALWAYS-ON SKILLS". The shadow rule covers the flag exactly as
 * it covers the body: a DB row of the same name (pinned or not) wins.
 */
export function resolveEffectiveSkills(db: SqliteDatabase, opts: ResolveSkillOptions = {}): EffectiveSkill[] {
  const computerUseEnabled = getComputerUseSettings(db).enabled;
  const out: EffectiveSkill[] = [];
  // The shadow set covers EVERY DB name (enabled or not): a DISABLED DB
  // row means "hidden", never "fall through to a same-name file" — the
  // documented precedence (disabling an override must not resurrect the
  // file skill it was overriding).
  const seen = new Set<string>();
  for (const skill of listSkills(db)) seen.add(skill.name);
  for (const skill of listEnabledSkills(db)) {
    // D4: the computer-use builtin rides the SKILLS index only when its
    // tool surface is on. The gate is hard — it wins over the agent
    // allowlist (advertising discipline for dark tools is dishonest
    // even when the owner explicitly lists the name).
    if (!computerUseEnabled && skill.id === COMPUTER_USE_SKILL_ID) continue;
    out.push({
      name: skill.name,
      description: skill.description,
      source: skill.source,
      id: skill.id,
      // R98-E2: pinned DB rows carry the body straight from the row —
      // the exact text read_skill would return for them.
      ...(skill.alwaysLoad ? { alwaysLoad: true, body: skill.body } : {}),
    });
  }
  for (const fileSkill of discoverFileSkills(opts.projectRoot, opts.globalRoot, opts.projectScope ?? "project")) {
    if (seen.has(fileSkill.name)) continue; // DB > file, project > global
    seen.add(fileSkill.name);
    // R98-E2: a pinned FILE skill's body rides the same tier, read from
    // disk HERE (the same readFileSkillBody read_skill loads through at
    // call time). A vanished/unreadable file degrades to the honest note
    // — the ALWAYS-ON section then tells the model the truth instead of
    // silently skipping the pin.
    let pinnedBody: string | undefined;
    if (fileSkill.alwaysLoad) {
      const loaded = readFileSkillBody(fileSkill.filePath);
      pinnedBody = loaded.ok ? loaded.body : loaded.note;
    }
    out.push({
      name: fileSkill.name,
      description: fileSkill.description,
      source: fileSkill.source,
      id: fileSkillId(fileSkill.source, fileSkill.name, fileSkill.scope),
      filePath: fileSkill.filePath,
      // R72-c: the references metadata rides the effective index so
      // read_skill can advertise + load them; DB entries never set it.
      references: fileSkill.references,
      ...(fileSkill.alwaysLoad ? { alwaysLoad: true, ...(pinnedBody !== undefined ? { body: pinnedBody } : {}) } : {}),
    });
  }
  const allow = opts.agentSkills !== undefined && opts.agentSkills.length > 0 ? new Set(opts.agentSkills) : null;
  return allow === null ? out : out.filter((skill) => allow.has(skill.name));
}

/* ── the merged LISTING (GET /skills — the settings surface) ──────────────── */

/** SkillRecord shape as served by GET /skills: the R61 DB fields plus the
 * file skills (provenance-marked, read-only). Additive over the previous
 * response — `filePath`/`projectName` are new, `source` gained two values,
 * and R72-c added `references` (file skills only, metadata: name/fileName/
 * bytes — reference CONTENT is never served here; read_skill loads it).
 * R98-E2 adds `alwaysLoad` (boolean, every row: DB rows read the column,
 * file rows read the `always-load:` frontmatter — the Settings switch and
 * the pinned-budget readout ride it). */
export interface MergedSkillRecord {
  id: string;
  name: string;
  description: string;
  body: string;
  source: SkillProvenance;
  enabled: boolean;
  /** R98-E2: the always-load tier (DB column / file frontmatter). */
  alwaysLoad: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  /** File skills only — the SKILL.md path (edit it there, not here). */
  filePath?: string;
  /** Project-file skills only — disambiguates same names across projects. */
  projectName?: string;
  /** ROUND-72 (R72-c): file skills only — the references/ metadata
   * (possibly an empty array; DB rows omit the field entirely). */
  references?: ReadonlyArray<FileSkillReference>;
}

function fileTimestamp(filePath: string): string {
  try {
    return statSync(filePath).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

/**
 * The FULL skills listing for the settings surface: every DB row (enabled
 * or disabled) plus every file skill (global + one entry per registered
 * project root — the listing is the management view, so it sees all
 * projects, while a session's effective set only sees its own root).
 * DB rows shadow same-name files (enabled or not — the documented
 * precedence). File bodies are read best-effort at request time.
 */
export function listAllSkillsMerged(db: SqliteDatabase, opts: { globalRoot?: string } = {}): MergedSkillRecord[] {
  const out: MergedSkillRecord[] = listSkills(db).map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    body: skill.body,
    source: skill.source,
    enabled: skill.enabled,
    // R98-E2: the DB column (the Settings switch PATCHes it back).
    alwaysLoad: skill.alwaysLoad,
    sortOrder: skill.sortOrder,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
  }));
  const names = new Set(out.map((skill) => skill.name));

  const fileRecords: FileSkillRecord[] = [];
  for (const project of listProjects(db)) {
    for (const skill of discoverProjectFileSkills(project.rootPath, project.id)) {
      fileRecords.push({ ...skill, projectName: project.name });
    }
  }
  fileRecords.push(...discoverGlobalFileSkills(opts.globalRoot));

  for (const fileSkill of fileRecords) {
    if (names.has(fileSkill.name)) continue;
    names.add(fileSkill.name);
    const ts = fileTimestamp(fileSkill.filePath);
    const body = readFileSkillBody(fileSkill.filePath);
    out.push({
      id: fileSkillId(fileSkill.source, fileSkill.name, fileSkill.scope),
      name: fileSkill.name,
      description: fileSkill.description,
      body: body.ok ? body.body : "",
      source: fileSkill.source,
      enabled: true, // visibility follows the file's existence
      // R98-E2: the file-side pin (frontmatter `always-load: true` — the
      // switch on a file row is read-only: edit the SKILL.md).
      alwaysLoad: fileSkill.alwaysLoad,
      sortOrder: 1000,
      createdAt: ts,
      updatedAt: ts,
      filePath: fileSkill.filePath,
      references: fileSkill.references,
      ...(fileSkill.projectName !== undefined ? { projectName: fileSkill.projectName } : {}),
    });
  }
  return out;
}
