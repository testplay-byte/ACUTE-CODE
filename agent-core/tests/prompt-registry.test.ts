/**
 * ROUND-59 (R59-F): the PROMPT-SECTION REGISTRY unit tests — the owner's
 * "the system prompts… highly customizable… built in multiple parts,
 * modules, and such, and they will be used when necessary" (R59 directive
 * 12).
 *
 * Pins in this file:
 *   1. REGISTRY COMPLETENESS — the ids PROMPT_REGISTRY lists are EXACTLY the
 *      ids buildTaggedPromptLines stamps, in composition order: a section
 *      added to prompts.ts without a registry entry (or vice versa) fails
 *      here, so no section can silently miss its override hook.
 *   2. BYTE-IDENTITY — the composed prompt for the golden ctx (no override
 *      files anywhere) equals the pre-R59-F golden fixture byte-for-byte.
 *   3. loadPromptOverrides — file→override mapping, unknown-filename
 *      ignore+diagnose, the 8000-char cap + honest marker, `_order.txt`
 *      parsing with unknown/duplicate tolerance, unreadable entries.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  loadPromptOverrides,
  promptOverrideDiagnostics,
  PROMPT_OVERRIDE_CHAR_CAP,
  PROMPT_REGISTRY,
  PROMPT_SECTION_IDS,
} from "../src/agents/prompt-registry";
import { buildProjectSystemPrompt, buildTaggedPromptLines } from "../src/agents/prompts";
import { TOOL_NAMES } from "../src/storage/agents";

// ── fixtures ─────────────────────────────────────────────────────────────────

/** A fresh project root per test (the context-report.test.ts pattern). */
function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "acute-preg-"));
}

/** The maximal ctx — every tool, digest, index, mode, rules: ALL 20 sections
 * (every conditional gate open) so the composition pin sees every id. The
 * rootPath is the golden's FIXED path (never exists on disk → no overrides
 * load, and the identity/environment lines match the fixture byte-for-byte). */
const GOLDEN_ROOT = "/tmp/acute-r59f-golden-root";
const FULL_CTX = {
  projectName: "GoldenProject",
  rootPath: GOLDEN_ROOT,
  toolNames: [...TOOL_NAMES],
  customRules: "Always write tests first.",
  maxTurns: 37,
  indexSummary: {
    projectId: "proj_golden",
    totalFiles: 3,
    totalSymbols: 12,
    topFiles: [
      { path: "src/a.ts", count: 6 },
      { path: "src/b.ts", count: 4 },
    ],
    topSymbols: [{ path: "src/a.ts", line: 1, kind: "function", symbol: "alpha" }],
    indexedAt: "2026-09-01T00:00:00.000Z",
  } as Parameters<typeof buildProjectSystemPrompt>[0]["indexSummary"],
  memoryDigest: "- [fact] The build is pnpm-based.",
  permissionMode: "plan" as const,
};

afterAll(() => {
  try {
    rmSync(join(tmpdir(), "acute-preg-"), { recursive: true, force: true });
  } catch {
    // best-effort — mkdtemp dirs are per-test; nothing shared to clean
  }
});

// ── the registry itself ──────────────────────────────────────────────────────

describe("PROMPT_REGISTRY (R59-F)", () => {
  it("is a frozen, ordered list with unique ids and one-line descriptions", () => {
    expect(Object.isFrozen(PROMPT_REGISTRY)).toBe(true);
    expect(Object.isFrozen(PROMPT_SECTION_IDS)).toBe(true);
    const ids = PROMPT_REGISTRY.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const spec of PROMPT_REGISTRY) {
      expect(spec.description.length).toBeGreaterThan(0);
      expect(typeof spec.dynamic).toBe("boolean");
      expect(["identity", "tools", "memory", "meta"]).toContain(spec.bucket);
    }
    // The composition's first/last sections — cheap order anchors.
    expect(PROMPT_SECTION_IDS[0]).toBe("identity");
    expect(PROMPT_SECTION_IDS[PROMPT_SECTION_IDS.length - 1]).toBe("custom-rules");
    expect(PROMPT_SECTION_IDS).toContain("tool-use");
    expect(PROMPT_SECTION_IDS).toContain("efficiency");
    expect(PROMPT_SECTION_IDS).toContain("project-memory");
  });

  it("COMPLETENESS: the ids stamped by buildTaggedPromptLines are exactly the registry ids, in registry order", () => {
    const stamped: string[] = [];
    for (const entry of buildTaggedPromptLines(FULL_CTX)) {
      expect(entry.sectionId).toBeDefined(); // every composed line is stamped
      if (stamped[stamped.length - 1] !== entry.sectionId) stamped.push(entry.sectionId as string);
    }
    // Both directions: nothing composed but unregistered, nothing registered
    // but never composed (this ctx opens every conditional gate).
    expect(stamped).toEqual([...PROMPT_SECTION_IDS]);
  });

  it("BYTE-IDENTITY: no override files → the composition equals the pre-R59-F golden byte-for-byte", () => {
    // Golden generated from the PRE-R59-F prompts.ts (13643 bytes, all 20
    // sections, every dynamic field pinned to fixed values). If this fails
    // after a deliberate prompts.ts change, regenerate deliberately.
    const golden = readFileSync(join(import.meta.dirname, "fixtures", "prompt-golden-r59f.txt"), "utf8");
    expect(buildProjectSystemPrompt(FULL_CTX)).toBe(golden);
  });
});

// ── loadPromptOverrides ──────────────────────────────────────────────────────

describe("loadPromptOverrides (R59-F)", () => {
  it("missing or empty .acute/prompts → empty map, no diagnostics, no order", () => {
    for (const root of [tempRoot(), join(tempRoot(), "nested", "deeper")]) {
      const result = loadPromptOverrides(root);
      expect(result.overrides.size).toBe(0);
      expect(result.order).toBeUndefined();
      expect(result.diagnostics).toEqual([]);
    }
  });

  it("maps <registry-id>.md files to trimmed override text (empty file = drop marker \"\")", () => {
    const root = tempRoot();
    const dir = join(root, ".acute", "prompts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "efficiency.md"), "\n  ## EFFICIENCY (custom)\nBe terse.\n\n");
    writeFileSync(join(dir, "communication.md"), "Speak like a pirate.");

    const result = loadPromptOverrides(root);
    expect(result.overrides.get("efficiency")).toBe("## EFFICIENCY (custom)\nBe terse.");
    expect(result.overrides.get("communication")).toBe("Speak like a pirate.");
    expect(result.overrides.size).toBe(2);
    expect(result.order).toBeUndefined();
    expect(result.diagnostics).toEqual([]);
  });

  it("an empty/whitespace-only file loads as \"\" — the drop-the-section value", () => {
    const root = tempRoot();
    const dir = join(root, ".acute", "prompts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "git.md"), "   \n\t\n");
    const result = loadPromptOverrides(root);
    expect(result.overrides.get("git")).toBe("");
  });

  it("UNKNOWN filenames are ignored + diagnosed (wrong name, wrong case, missing .md)", () => {
    const root = tempRoot();
    const dir = join(root, ".acute", "prompts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Efficiency.md"), "wrong case"); // ids are case-sensitive slugs
    writeFileSync(join(dir, "not-a-section.md"), "unknown stem");
    writeFileSync(join(dir, "efficiency.txt"), "wrong extension");
    writeFileSync(join(dir, "readme.md"), "notes");

    const result = loadPromptOverrides(root);
    expect(result.overrides.size).toBe(0); // nothing honored
    const unknowns = result.diagnostics.filter((d) => d.kind === "unknown-file");
    expect(unknowns.map((d) => d.file).sort()).toEqual(["Efficiency.md", "efficiency.txt", "not-a-section.md", "readme.md"]);
  });

  it("caps override text at 8000 chars with an honest truncation marker + diagnostic", () => {
    const root = tempRoot();
    const dir = join(root, ".acute", "prompts");
    mkdirSync(dir, { recursive: true });
    const longText = "X".repeat(PROMPT_OVERRIDE_CHAR_CAP + 500);
    writeFileSync(join(dir, "environment.md"), longText);

    const result = loadPromptOverrides(root);
    const capped = result.overrides.get("environment");
    expect(capped).toBeDefined();
    expect(capped?.startsWith("X".repeat(100))).toBe(true);
    // Exactly the cap + the marker line — nothing more, nothing silently.
    expect(capped?.length).toBe(PROMPT_OVERRIDE_CHAR_CAP + "\n\n[.acute/prompts/environment.md truncated at 8000 characters — the remainder of the file is ignored]".length);
    expect(result.diagnostics).toEqual([{ kind: "capped", file: "environment.md", section: "environment" }]);
  });

  it("_order.txt: known ids in order; unknown ids ignored + diagnosed; duplicates diagnosed", () => {
    const root = tempRoot();
    const dir = join(root, ".acute", "prompts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "_order.txt"),
      "environment\n# not a comment-tolerant parser — unknown id line\nidentity\nenvironment\n",
    );

    const result = loadPromptOverrides(root);
    expect(result.order).toEqual(["environment", "identity"]);
    const kinds = result.diagnostics.map((d) => d.kind);
    expect(kinds).toContain("order-unknown-id");
    expect(kinds).toContain("order-duplicate-id");
    expect(kinds).toContain("order-active");
    expect(result.overrides.size).toBe(0); // order alone is NOT a section override
  });

  it("a DIRECTORY named like a section file fails into an unreadable diagnostic, never a throw", () => {
    const root = tempRoot();
    const dir = join(root, ".acute", "prompts");
    mkdirSync(join(dir, "efficiency.md"), { recursive: true }); // a dir, not a file
    const result = loadPromptOverrides(root);
    expect(result.overrides.size).toBe(0);
    expect(result.diagnostics.map((d) => d.kind)).toEqual(["unreadable"]);
  });
});

// ── diagnostics rendering ────────────────────────────────────────────────────

describe("promptOverrideDiagnostics (R59-F)", () => {
  it("renders every diagnostic kind as a readable line (empty result → no news)", () => {
    expect(promptOverrideDiagnostics(loadPromptOverrides(tempRoot()))).toEqual([]);

    const root = tempRoot();
    const dir = join(root, ".acute", "prompts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "nope.md"), "x");
    writeFileSync(join(dir, "efficiency.md"), "#".repeat(PROMPT_OVERRIDE_CHAR_CAP + 10));
    writeFileSync(join(dir, "_order.txt"), "efficiency\nbogus-id\n");
    const lines = promptOverrideDiagnostics(loadPromptOverrides(root));
    expect(lines.length).toBe(4); // unknown-file, capped, order-unknown-id, order-active
    for (const line of lines) expect(line.startsWith(".acute/prompts/")).toBe(true);
    expect(lines.some((l) => l.includes("ignored — filename must match a registry section id"))).toBe(true);
    expect(lines.some((l) => l.includes("capped at 8000 chars"))).toBe(true);
    expect(lines.some((l) => l.includes('unknown section id "bogus-id" ignored'))).toBe(true);
    expect(lines.some((l) => l.includes("order file active"))).toBe(true);
  });
});
