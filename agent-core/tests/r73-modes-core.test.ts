/**
 * ROUND-73 (R73-a) — the TASK MODES CORE round (the posture tier of the
 * owner's "proper detailed system prompts which the agent accesses when
 * required and on the basis of the task"):
 *
 *   D1 — the six builtin postures: fixed order plan/debug/build/review/
 *        explore/refactor (sortOrder 10-60, frozen array AND entries —
 *        callers share the objects), deep bodies (1,200-3,000 chars, the
 *        one-line posture statement, a PAIRS WITH skill pairing), and
 *        trigger-rich descriptions in the R71 convention ('Use when …
 *        quoted phrasings … NOT for …') that the R72-a DETERMINISTIC
 *        matcher can already score — the cross-validation pin (R73-b's
 *        computeModeHints will reuse the same scorer over these same
 *        descriptions, so the convention must hold NOW).
 *   D2 — custom-mode discovery `.acute/agents/*.md`: the happy path
 *        (frontmatter parsed, body stripped, absolute filePath, customs
 *        sorted after the builtins in file-name order), absent-is-clean,
 *        no-root, the silent skips (hidden/underscore/non-.md), and the
 *        purity contract (two calls structurally equal, zero fs writes).
 *   D3 — name → id rules: frontmatter name wins over the stem, the
 *        slugify shape ('Release Notes!' → 'release-notes'), the 64-char
 *        name cap, first-file-wins on a same-id collision (the
 *        skills-files dedup pattern).
 *   D4 — SHADOWING: a custom file whose id equals a builtin id replaces
 *        it (ONE entry, custom wins — the user's override lever) while
 *        the other five builtins stay intact.
 *   D5 — honest caps: body >16K (exact house marker line + diagnostic),
 *        description >500 (marker + diagnostic), the 8-custom-mode cap
 *        (9th file diagnosed 'too-many-modes'), tools slug-shape drops
 *        (stored RAW — semantic validation is the integration wave's).
 *   D6 — the failure family: missing description (honest fallback line),
 *        empty body (skip), a subdirectory in the modes dir
 *        ('not-a-file'), an unreadable file (chmod 000, with the
 *        root-runner fallback) — diagnostics, NEVER a throw.
 *   D7 — findMode (exact case-sensitive id) + renderModeDiagnostics
 *        (one '.acute/agents/<file>: …' line per kind; empty = clean).
 */
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { computeTaskHints } from "../src/agents/task-hints";
import {
  BUILTIN_MODES,
  BUILTIN_MODE_COUNT,
  CUSTOM_MODES_CAP,
  CUSTOM_MODE_BODY_CAP,
  CUSTOM_MODE_DESC_CAP,
  findMode,
  renderModeDiagnostics,
  resolveEffectiveModes,
} from "../src/agents/modes";

/* ── fixtures ───────────────────────────────────────────────────────────────── */

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "acute-r73a-"));
});

afterEach(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

afterAll(() => {
  // tempDir is already removed per-test; nothing global to clean.
});

const DEFAULT_BODY = "# Custom mode\n\nThe custom posture body.";

/** Write one custom mode file into <tempDir>/.acute/agents/<fileName>. */
function writeModeFile(
  fileName: string,
  fields: { name?: string; description?: string; tools?: string; body?: string },
): string {
  const agentsDir = join(tempDir, ".acute", "agents");
  mkdirSync(agentsDir, { recursive: true });
  const filePath = join(agentsDir, fileName);
  const lines: string[] = ["---"];
  if (fields.name !== undefined) lines.push(`name: ${fields.name}`);
  if (fields.description !== undefined) lines.push(`description: ${fields.description}`);
  if (fields.tools !== undefined) lines.push(`tools: ${fields.tools}`);
  lines.push("---");
  // '' (empty string) is a deliberate input — only undefined falls back.
  lines.push(fields.body ?? DEFAULT_BODY);
  writeFileSync(filePath, lines.join("\n"), "utf8");
  return filePath;
}

/** Recursive read-only snapshot (name/size/mtime) — the no-writes proof. */
function snapshotTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, prefix: string) => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const stats = statSync(full);
      out.push(`${prefix}${name}${stats.isDirectory() ? "/" : `:${stats.size}:${stats.mtimeMs}`}`);
      if (stats.isDirectory()) walk(full, `${prefix}${name}/`);
    }
  };
  walk(dir, "");
  return out;
}

const EXPECTED_IDS = ["plan", "debug", "build", "review", "explore", "refactor"] as const;

/** The posture statement each builtin body opens with (one per mode). */
const EXPECTED_POSTURES: Record<string, string> = {
  plan: "SPEC-FIRST POSTURE",
  debug: "DIAGNOSIS-FIRST POSTURE",
  build: "IMPLEMENTATION POSTURE",
  review: "READ-ONLY CRITICAL POSTURE",
  explore: "RECONNAISSANCE POSTURE",
  refactor: "BEHAVIOR-PRESERVING POSTURE",
};

/** The skill pairings each body must name via read_skill (posture picks
 * the stance, skills carry the craft — the R72/R73 division of labor). */
const EXPECTED_PAIRINGS: Record<string, string[]> = {
  plan: ["spec-planning", "zero-hallucination"],
  debug: ["debugging", "focused-fix"],
  build: ["tdd", "project-init"],
  review: ["code-review", "security-review"],
  explore: ["web-research"],
  refactor: ["refactoring"],
};

// ─────────────────────────────────────────────────────────────────────────────
// D1 — the six builtin postures
// ─────────────────────────────────────────────────────────────────────────────

describe("ROUND-73 (R73-a) D1: the six builtin postures", () => {
  it("SIX builtins in the fixed order, sortOrder 10-60, source 'builtin', count export agrees, array AND entries frozen, no file-only fields", () => {
    expect(BUILTIN_MODES.map((mode) => mode.id)).toEqual([...EXPECTED_IDS]);
    expect(BUILTIN_MODES.map((mode) => mode.sortOrder)).toEqual([10, 20, 30, 40, 50, 60]);
    expect(BUILTIN_MODES.every((mode) => mode.source === "builtin")).toBe(true);
    expect(BUILTIN_MODE_COUNT).toBe(6);
    // Builtins never carry the file-only fields.
    expect(BUILTIN_MODES.every((mode) => mode.filePath === undefined && mode.tools === undefined)).toBe(true);
    // Frozen array AND frozen entries: resolveEffectiveModes hands callers
    // SHARED references, so immutability must hold by construction.
    expect(Object.isFrozen(BUILTIN_MODES)).toBe(true);
    expect(BUILTIN_MODES.every((mode) => Object.isFrozen(mode))).toBe(true);
  });

  it("every body is a real deep module: 1,200-3,000 chars, six DISTINCT bodies, each opening '# Mode: <id> —' with its posture statement", () => {
    expect(new Set(BUILTIN_MODES.map((mode) => mode.body)).size).toBe(6);
    for (const mode of BUILTIN_MODES) {
      expect(mode.body.length).toBeGreaterThanOrEqual(1_200);
      expect(mode.body.length).toBeLessThanOrEqual(3_000);
      expect(mode.body.startsWith(`# Mode: ${mode.id} — `)).toBe(true);
      expect(mode.body).toContain(EXPECTED_POSTURES[mode.id]);
    }
  });

  it("every description is trigger-rich per the R71/R72 convention: 280-500 chars, 'Use when', a quoted phrase, a NOT-for negative scope", () => {
    for (const mode of BUILTIN_MODES) {
      expect(mode.description.length).toBeGreaterThanOrEqual(280);
      expect(mode.description.length).toBeLessThanOrEqual(500);
      expect(mode.description).toContain("Use when");
      expect(mode.description).toMatch(/'[^']{2,}'/);
      expect(mode.description).toContain("NOT for");
    }
  });

  it("every body ends with a PAIRS WITH line naming its real skills via read_skill", () => {
    for (const mode of BUILTIN_MODES) {
      const lastLine = mode.body.trimEnd().split("\n").at(-1) ?? "";
      expect(lastLine.startsWith("PAIRS WITH:")).toBe(true);
      expect(lastLine).toContain("read_skill");
      for (const skill of EXPECTED_PAIRINGS[mode.id]) {
        expect(lastLine).toContain(skill);
      }
    }
  });

  it("the descriptions already feed the R72-a deterministic matcher (the convention cross-validation R73-b will build on)", () => {
    // Quoted verbatim phrasings are the matcher's strongest signal — the
    // whole reason these descriptions carry them.
    expect(computeTaskHints("fix this bug", BUILTIN_MODES)[0]?.skillName).toBe("Debug");
    expect(computeTaskHints("clean this up", BUILTIN_MODES)[0]?.skillName).toBe("Refactor");
    expect(computeTaskHints("plan this for me", BUILTIN_MODES)[0]?.skillName).toBe("Plan");
    // The negative scopes keep the matcher honest: a review ask must not
    // surface the build posture.
    expect(computeTaskHints("review this", BUILTIN_MODES).map((h) => h.skillName)).not.toContain("Build");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D2 — custom-mode discovery (.acute/agents/*.md)
// ─────────────────────────────────────────────────────────────────────────────

describe("ROUND-73 (R73-a) D2: custom-mode discovery", () => {
  it("happy path: two valid files load — frontmatter parsed, body stripped verbatim, absolute filePath, source 'file', tools parsed, customs sorted after the builtins in file-name order, zero diagnostics", () => {
    writeModeFile("release-notes.md", {
      name: "Release Notes",
      description: "Use when the user says 'write release notes' or 'summarize this release'. NOT for changelog automation.",
      tools: "read_file, git_log",
      body: "# Release Notes\n\nWrite them.",
    });
    writeModeFile("audit.md", {
      name: "Audit",
      description: "Use when the user says 'audit this'. NOT for reviews.",
      body: "# Audit\n\nAudit it.",
    });
    const { modes, diagnostics } = resolveEffectiveModes(tempDir);
    expect(diagnostics).toEqual([]);
    expect(modes.length).toBe(8); // 6 builtins + 2 customs
    const release = findMode(modes, "release-notes");
    const audit = findMode(modes, "audit");
    expect(release?.name).toBe("Release Notes");
    expect(release?.source).toBe("file");
    expect(release?.filePath).toBe(join(tempDir, ".acute", "agents", "release-notes.md"));
    // Body = everything after the frontmatter, trimmed, byte-exact.
    expect(release?.body).toBe("# Release Notes\n\nWrite them.");
    expect(release?.tools).toEqual(["read_file", "git_log"]);
    expect(audit?.tools).toBeUndefined(); // tools absent → not declared
    // Customs ride AFTER the builtins; file-name order fixes sortOrder.
    expect(modes.slice(0, 6).map((mode) => mode.id)).toEqual([...EXPECTED_IDS]);
    expect(modes.slice(6).map((mode) => mode.id)).toEqual(["audit", "release-notes"]);
    expect(audit?.sortOrder).toBe(100);
    expect(release?.sortOrder).toBe(101);
  });

  it("no .acute/agents directory → builtins only, zero diagnostics (absent is clean)", () => {
    const { modes, diagnostics } = resolveEffectiveModes(tempDir);
    expect(modes.map((mode) => mode.id)).toEqual([...EXPECTED_IDS]);
    expect(diagnostics).toEqual([]);
  });

  it("projectRoot undefined → builtins only (no discovery attempted); the degenerate empty-string root behaves the same", () => {
    expect(resolveEffectiveModes(undefined)).toEqual({ modes: [...BUILTIN_MODES], diagnostics: [] });
    writeModeFile("sneaky.md", { name: "Sneaky", description: "Use when 'sneaky'." });
    const { modes } = resolveEffectiveModes("");
    expect(modes.map((mode) => mode.id)).toEqual([...EXPECTED_IDS]);
  });

  it("silent skips: hidden (.), underscore (_), and non-.md regular entries never become modes and never diagnose", () => {
    writeModeFile("real.md", { name: "Real", description: "Use when 'real'." });
    const agentsDir = join(tempDir, ".acute", "agents");
    writeFileSync(join(agentsDir, ".gitkeep"), "", "utf8");
    writeFileSync(join(agentsDir, "_draft.md"), "---\nname: Draft\n---\nbody", "utf8");
    writeFileSync(join(agentsDir, "notes.txt"), "not a mode", "utf8");
    const { modes, diagnostics } = resolveEffectiveModes(tempDir);
    expect(diagnostics).toEqual([]);
    expect(modes.filter((mode) => mode.source === "file").map((mode) => mode.id)).toEqual(["real"]);
  });

  it("purity contract: two calls return structurally equal results (fresh arrays), and the tree is byte-for-byte untouched", () => {
    writeModeFile("one.md", { name: "One", description: "Use when 'one'." });
    writeModeFile("two.md", { name: "Two", description: "Use when 'two'." });
    const before = snapshotTree(tempDir);
    const first = resolveEffectiveModes(tempDir);
    const second = resolveEffectiveModes(tempDir);
    expect(second).toEqual(first);
    expect(second.modes).not.toBe(first.modes); // new array per call
    expect(snapshotTree(tempDir)).toEqual(before); // zero writes
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D3 — name → id rules
// ─────────────────────────────────────────────────────────────────────────────

describe("ROUND-73 (R73-a) D3: name → id rules", () => {
  it("frontmatter name wins over the file stem", () => {
    writeModeFile("rel.md", { name: "Release Notes", description: "Use when 'release'." });
    const mode = findMode(resolveEffectiveModes(tempDir).modes, "release-notes");
    expect(mode?.name).toBe("Release Notes");
    expect(mode?.id).toBe("release-notes");
  });

  it("no frontmatter name → the file stem carries it", () => {
    writeModeFile("release-notes.md", { description: "Use when 'release'." });
    const mode = findMode(resolveEffectiveModes(tempDir).modes, "release-notes");
    expect(mode?.name).toBe("release-notes");
    expect(mode?.id).toBe("release-notes");
  });

  it("slugification: 'Release Notes!' → 'release-notes' (lowercase, non-alphanumerics collapse to dashes)", () => {
    writeModeFile("x.md", { name: "Release Notes!", description: "Use when 'release'." });
    expect(findMode(resolveEffectiveModes(tempDir).modes, "release-notes")).toBeDefined();
  });

  it("a frontmatter name longer than 64 chars is truncated (bounded display field)", () => {
    writeModeFile("long.md", { name: "A".repeat(80), description: "Use when 'long'." });
    const mode = findMode(resolveEffectiveModes(tempDir).modes, "a".repeat(64));
    expect(mode?.name.length).toBe(64);
  });

  it("same-id collision between two custom files: the first in file-name order wins, the later is silently dropped (the skills-files dedup pattern)", () => {
    writeModeFile("a-first.md", { name: "Twin", description: "Use when 'twin'.", body: "# First twin" });
    writeModeFile("b-second.md", { name: "Twin", description: "Use when 'twin'.", body: "# Second twin" });
    const { modes, diagnostics } = resolveEffectiveModes(tempDir);
    const twins = modes.filter((mode) => mode.id === "twin");
    expect(twins.length).toBe(1);
    expect(twins[0]?.body).toContain("# First twin");
    expect(diagnostics).toEqual([]); // documented silent dedup — first wins
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D4 — shadowing (the user's override lever)
// ─────────────────────────────────────────────────────────────────────────────

describe("ROUND-73 (R73-a) D4: custom shadows builtin", () => {
  it("a custom file whose id equals a builtin id replaces it: ONE 'debug' entry, custom body, source 'file'", () => {
    writeModeFile("debug.md", {
      name: "Debug",
      description: "Use when 'debug' — the project's own take.",
      body: "# Custom debug\n\nWe reproduce first, always.",
    });
    const { modes, diagnostics } = resolveEffectiveModes(tempDir);
    expect(diagnostics).toEqual([]);
    const debugs = modes.filter((mode) => mode.id === "debug");
    expect(debugs.length).toBe(1);
    expect(debugs[0]?.source).toBe("file");
    expect(debugs[0]?.body).toContain("# Custom debug");
    expect(modes.length).toBe(6); // 5 surviving builtins + the custom
  });

  it("shadowing one builtin leaves the other five intact and addressable as builtins", () => {
    writeModeFile("debug.md", { name: "Debug", description: "Use when 'debug'." });
    const { modes } = resolveEffectiveModes(tempDir);
    const survivors = EXPECTED_IDS.filter((id) => id !== "debug");
    for (const id of survivors) {
      expect(findMode(modes, id)?.source).toBe("builtin");
    }
    // The shadowed custom sorts with the customs (sortOrder 100+), never
    // jumps into the builtin block.
    expect(findMode(modes, "debug")?.sortOrder).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D5 — honest caps
// ─────────────────────────────────────────────────────────────────────────────

describe("ROUND-73 (R73-a) D5: honest caps", () => {
  it(`body > ${CUSTOM_MODE_BODY_CAP} → truncated at the cap with the exact house marker line + 'capped' diagnostic`, () => {
    const bigBody = `# Big\n\n${"x".repeat(CUSTOM_MODE_BODY_CAP + 500)}`;
    writeModeFile("big.md", { name: "Big", description: "Use when 'big'.", body: bigBody });
    const { modes, diagnostics } = resolveEffectiveModes(tempDir);
    const mode = findMode(modes, "big");
    expect(mode?.body.startsWith(bigBody.slice(0, CUSTOM_MODE_BODY_CAP))).toBe(true);
    expect(mode?.body.endsWith(
      `[.acute/agents/big.md truncated at ${CUSTOM_MODE_BODY_CAP} characters — the remainder is ignored]`,
    )).toBe(true);
    expect(diagnostics).toEqual([{ kind: "capped", file: "big.md" }]);
  });

  it(`description > ${CUSTOM_MODE_DESC_CAP} → truncated with an honest marker + 'description-capped' diagnostic`, () => {
    const longDescription = "y".repeat(CUSTOM_MODE_DESC_CAP + 120);
    writeModeFile("desc.md", { name: "Desc", description: longDescription, body: "# Desc" });
    const { modes, diagnostics } = resolveEffectiveModes(tempDir);
    const mode = findMode(modes, "desc");
    expect(mode?.description.startsWith(longDescription.slice(0, CUSTOM_MODE_DESC_CAP))).toBe(true);
    expect(mode?.description).toContain(`description truncated at ${CUSTOM_MODE_DESC_CAP} characters`);
    expect(diagnostics).toEqual([{ kind: "description-capped", file: "desc.md" }]);
  });

  it(`more than ${CUSTOM_MODES_CAP} custom modes: the first 8 by file name load, the 9th is skipped + diagnosed 'too-many-modes'`, () => {
    for (let i = 1; i <= 9; i++) {
      writeModeFile(`mode-${String(i).padStart(2, "0")}.md`, { name: `Mode ${i}`, description: "Use when 'mode'." });
    }
    const { modes, diagnostics } = resolveEffectiveModes(tempDir);
    const customs = modes.filter((mode) => mode.source === "file");
    expect(customs.length).toBe(CUSTOM_MODES_CAP);
    expect(modes.length).toBe(6 + CUSTOM_MODES_CAP);
    expect(customs.map((mode) => mode.id)).toEqual(["mode-1", "mode-2", "mode-3", "mode-4", "mode-5", "mode-6", "mode-7", "mode-8"]);
    expect(diagnostics).toEqual([
      {
        kind: "too-many-modes",
        file: "mode-09.md",
        detail: `more than ${CUSTOM_MODES_CAP} custom modes — the first ${CUSTOM_MODES_CAP} by file name load; remove or consolidate`,
      },
    ]);
  });

  it("tools: comma/space-separated, trimmed, deduped; slug-shape violations dropped + diagnosed (stored RAW — semantic checks are the integration wave's)", () => {
    writeModeFile("tools.md", {
      name: "Tools",
      description: "Use when 'tools'.",
      tools: "read_file, git_log, not a slug!!",
      body: "# Tools",
    });
    const { modes, diagnostics } = resolveEffectiveModes(tempDir);
    const mode = findMode(modes, "tools");
    // The list is comma/SPACE separated, so "not a slug!!" splits into
    // not/a/slug!!: "not" and "a" are syntactically plausible slugs
    // (^[a-z_][a-z0-9_]*$), "slug!!" is not. Only the shape-offender is
    // dropped HERE; whether "not"/"a" are real tools is the integration
    // wave's registry validation, not this layer's.
    expect(mode?.tools).toEqual(["read_file", "git_log", "not", "a"]);
    expect(diagnostics).toEqual([{ kind: "invalid-tools", file: "tools.md", detail: "dropped invalid tool entries: slug!!" }]);
  });

  it("tools dedup collapses repeats; a whitespace-only tools value means 'not declared' (undefined)", () => {
    writeModeFile("dup.md", { name: "Dup", description: "Use when 'dup'.", tools: "read_file read_file, git_log", body: "# Dup" });
    writeModeFile("empty-tools.md", { name: "Empty Tools", description: "Use when 'empty'.", tools: "   ", body: "# Empty" });
    const { modes, diagnostics } = resolveEffectiveModes(tempDir);
    expect(findMode(modes, "dup")?.tools).toEqual(["read_file", "git_log"]);
    expect(findMode(modes, "empty-tools")?.tools).toBeUndefined();
    expect(diagnostics).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D6 — the failure family (diagnostics, never throws)
// ─────────────────────────────────────────────────────────────────────────────

describe("ROUND-73 (R73-a) D6: the failure family", () => {
  it("missing description → the mode still loads with the honest fallback line + 'missing-description' diagnostic", () => {
    writeModeFile("nodesc.md", { name: "NoDesc", body: "# NoDesc" });
    const { modes, diagnostics } = resolveEffectiveModes(tempDir);
    const mode = findMode(modes, "nodesc");
    expect(mode).toBeDefined();
    expect(mode?.description).toBe(
      "(no description — .acute/agents/nodesc.md declares no description; add one so task hints can match it)",
    );
    expect(diagnostics).toEqual([{ kind: "missing-description", file: "nodesc.md" }]);
  });

  it("empty body (frontmatter only) → skipped with 'empty-body' diagnostic — a mode with no instructions is noise, not a mode", () => {
    writeModeFile("empty.md", { name: "Empty", description: "Use when 'empty'.", body: "" });
    const { modes, diagnostics } = resolveEffectiveModes(tempDir);
    expect(findMode(modes, "empty")).toBeUndefined();
    expect(modes.length).toBe(6);
    expect(diagnostics).toEqual([
      {
        kind: "empty-body",
        file: "empty.md",
        detail: "no body after the frontmatter — a mode with no instructions is noise, not a mode",
      },
    ]);
  });

  it("a subdirectory in .acute/agents/ is skipped + diagnosed 'not-a-file' (modes are flat .md files only)", () => {
    writeModeFile("real.md", { name: "Real", description: "Use when 'real'." });
    mkdirSync(join(tempDir, ".acute", "agents", "debug"));
    const { modes, diagnostics } = resolveEffectiveModes(tempDir);
    expect(modes.filter((mode) => mode.source === "file").map((mode) => mode.id)).toEqual(["real"]);
    expect(diagnostics).toEqual([
      {
        kind: "not-a-file",
        file: "debug",
        detail: "directory — modes are flat .md files directly in .acute/agents/ only",
      },
    ]);
  });

  it("an unreadable file is skipped with an 'unreadable' diagnostic — never a throw (chmod 000; root runners fall back to the directory form)", () => {
    const filePath = writeModeFile("locked.md", { name: "Locked", description: "Use when 'locked'." });
    chmodSync(filePath, 0o000);
    const call = () => resolveEffectiveModes(tempDir);
    expect(call).not.toThrow();
    const canStillRead = (() => {
      try {
        readFileSync(filePath, "utf8");
        return true;
      } catch {
        return false;
      }
    })();
    if (canStillRead) {
      // A root/Windows runner reads straight through mode-000 files — the
      // spec's fallback: simulate unreadability with a directory entry and
      // pin the no-throw + honest-diagnostic contract anyway.
      rmSync(filePath);
      mkdirSync(filePath);
      const fallback = call();
      expect(fallback.modes.some((mode) => mode.id === "locked")).toBe(false);
      expect(fallback.diagnostics.some((d) => d.kind === "not-a-file" && d.file === "locked.md")).toBe(true);
    } else {
      const result = call();
      expect(result.modes.some((mode) => mode.id === "locked")).toBe(false);
      expect(result.diagnostics).toEqual([{ kind: "unreadable", file: "locked.md", detail: "EACCES" }]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D7 — findMode + renderModeDiagnostics
// ─────────────────────────────────────────────────────────────────────────────

describe("ROUND-73 (R73-a) D7: findMode + renderModeDiagnostics", () => {
  it("findMode: exact case-sensitive id hit and miss (ids are slugs — no fuzzy matching)", () => {
    const modes = resolveEffectiveModes(tempDir).modes;
    expect(findMode(modes, "debug")?.id).toBe("debug");
    expect(findMode(modes, "debug")?.name).toBe("Debug");
    expect(findMode(modes, "Debug")).toBeUndefined();
    expect(findMode(modes, "nope")).toBeUndefined();
    expect(findMode([], "debug")).toBeUndefined();
  });

  it("renderModeDiagnostics: every kind renders as one '.acute/agents/<file>: …' line; empty input is empty (no news = clean)", () => {
    expect(renderModeDiagnostics([])).toEqual([]);
    const diagnostics = [
      { kind: "unreadable", file: "gone.md" },
      { kind: "not-a-file", file: "sub" },
      { kind: "capped", file: "big.md" },
      { kind: "description-capped", file: "desc.md" },
      { kind: "missing-description", file: "nodesc.md" },
      { kind: "invalid-tools", file: "tools.md" },
      { kind: "empty-body", file: "empty.md" },
      { kind: "too-many-modes", file: "extra.md" },
    ] as const;
    const lines = renderModeDiagnostics(diagnostics);
    expect(lines.length).toBe(8);
    for (const line of lines) {
      expect(line.startsWith(".acute/agents/")).toBe(true);
      expect(line).toContain(": ");
    }
    // Spot pins (the prompt-registry rendering pattern, mode-flavored).
    expect(lines).toContain(".acute/agents/big.md: body capped at 16000 chars (honest truncation marker appended)");
    expect(lines).toContain(".acute/agents/desc.md: description capped at 500 chars (honest truncation marker appended)");
    expect(lines).toContain(".acute/agents/extra.md: skipped — more than 8 custom modes");
    expect(lines).toContain(".acute/agents/gone.md: skipped — unreadable (read failed)");
  });
});
