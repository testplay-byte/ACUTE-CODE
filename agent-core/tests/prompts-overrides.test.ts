/**
 * ROUND-59 (R59-F): PROMPT-SECTION OVERRIDE composition tests — the owner's
 * "the system prompts… highly customizable… built in multiple parts, modules,
 * and such, and they will be used when necessary" (R59 directive 12).
 *
 * These pins guard the surgical prompts.ts hook (applySectionOverrides over
 * the id-stamped tagged lines):
 *   - overriding a STATIC section replaces its built-in text wholesale;
 *   - overriding a DYNAMIC section replaces it INCLUDING the dynamic parts
 *     (the owner taking responsibility — "used when necessary");
 *   - an EMPTY override file DROPS the section (documented remove lever);
 *   - no recognized overrides → byte-identical composition (also pinned
 *     against the pre-R59-F golden in prompt-registry.test.ts);
 *   - `_order.txt` reorders ONLY together with ≥1 section override;
 *   - the context-meter buckets stay attributable after overrides.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  applySectionOverrides,
  buildProjectSystemPrompt,
  buildSectionText,
  buildSystemPromptSections,
  describePromptSections,
  type PromptContext,
  type TaggedLine,
} from "../src/agents/prompts";
import { TOOL_NAMES } from "../src/storage/agents";

afterAll(() => {
  try {
    rmSync(join(tmpdir(), "acute-povr-"), { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

/** Fresh project root + optional override file writer. */
function projectDir(): { root: string; promptsDir: string } {
  const root = mkdtempSync(join(tmpdir(), "acute-povr-"));
  const promptsDir = join(root, ".acute", "prompts");
  return { root, promptsDir };
}

function override(root: string, id: string, text: string): void {
  mkdirSync(join(root, ".acute", "prompts"), { recursive: true });
  writeFileSync(join(root, ".acute", "prompts", `${id}.md`), text, "utf8");
}

function orderFile(root: string, ids: string): void {
  mkdirSync(join(root, ".acute", "prompts"), { recursive: true });
  writeFileSync(join(root, ".acute", "prompts", "_order.txt"), ids, "utf8");
}

/** A realistic full-featured ctx bound to a REAL temp root (so overrides load). */
function ctxFor(root: string): PromptContext {
  return {
    projectName: "OverrideProject",
    rootPath: root,
    toolNames: [...TOOL_NAMES],
    customRules: "Always write tests first.",
    maxTurns: 40,
    indexSummary: {
      projectId: "proj_ovr",
      totalFiles: 2,
      totalSymbols: 5,
      topFiles: [{ path: "src/a.ts", count: 3 }],
      topSymbols: [],
      indexedAt: "2026-09-01T00:00:00.000Z",
    },
    memoryDigest: "- [fact] The build is pnpm-based.",
  };
}

// ── byte-identity when nothing is overridden ────────────────────────────────

describe("no-override byte-identity (R59-F)", () => {
  it("an empty .acute/prompts, an unknown file, and a lone _order.txt change NOTHING", () => {
    const { root, promptsDir } = projectDir();
    const ctx = ctxFor(root);
    const before = buildProjectSystemPrompt(ctx);

    mkdirSync(promptsDir, { recursive: true });
    expect(buildProjectSystemPrompt(ctx)).toBe(before); // empty dir

    writeFileSync(join(promptsDir, "readme.md"), "notes");
    writeFileSync(join(promptsDir, "Communication.md"), "wrong case");
    orderFile(root, "environment\nidentity\nbogus-id\n");
    expect(buildProjectSystemPrompt(ctx)).toBe(before); // unknown + order-only

    // The meter view is equally untouched (same composition, per-bucket).
    const sections = buildSystemPromptSections(ctx);
    // R70-c: the EFFICIENCY section was consolidated into AGENTIC LOOP —
    // the byte-identity anchor is the (static) COMMUNICATION section now.
    expect(sections.identity).toContain("## COMMUNICATION");
    expect(sections.tools).toContain("## TOOL USE");
  });
});

// ── static + dynamic replacement ────────────────────────────────────────────

describe("section replacement (R59-F)", () => {
  it("overriding a STATIC section (communication) replaces heading + body with the file text", () => {
    const { root } = projectDir();
    // R70-c: the sample static section moved from the retired "efficiency"
    // id to "communication" (still static, still identity-bucket).
    override(root, "communication", "## COMMUNICATION (project override)\nR59F-MARKER-STATIC\nOne rule: be brief.");
    const prompt = buildProjectSystemPrompt(ctxFor(root));

    expect(prompt).toContain("R59F-MARKER-STATIC");
    expect(prompt).toContain("## COMMUNICATION (project override)");
    expect(prompt).not.toContain("- CONCISE BY DEFAULT"); // the old body is GONE
    // Neighbors survive untouched, with clean single-blank separation.
    expect(prompt).toContain("## EMBEDDED BROWSER PANEL (browser_control)");
    expect(prompt).toContain("## CODEBASE AWARENESS");
    expect(prompt).toContain("One rule: be brief.\n\n## CODEBASE AWARENESS");
    expect(prompt).not.toMatch(/\n\n\n/); // no blank-line pileup anywhere
  });

  it("overriding a DYNAMIC section (project-memory) replaces it INCLUDING its dynamic parts", () => {
    const { root } = projectDir();
    override(root, "project-memory", "## Project memory (project override)\nR59F-MARKER-MEMORY\nNo memories — trust the files.");
    const prompt = buildProjectSystemPrompt(ctxFor(root));

    expect(prompt).toContain("R59F-MARKER-MEMORY");
    // The dynamic digest + the built-in narration are replaced wholesale.
    expect(prompt).not.toContain("The build is pnpm-based.");
    expect(prompt).not.toContain("## Project memory (persisted across sessions)");
    expect(prompt).not.toContain("memory_recall to search beyond this summary");
    expect(prompt).toContain("## ENVIRONMENT"); // the next section is intact
  });

  it("overriding the tool-gated TERMINAL section drops the built-in background-job contract", () => {
    const { root } = projectDir();
    override(root, "terminal", "## TERMINAL (project override)\nR59F-MARKER-TERMINAL\nRun only pnpm.");
    const prompt = buildProjectSystemPrompt(ctxFor(root));
    expect(prompt).toContain("R59F-MARKER-TERMINAL");
    expect(prompt).not.toContain("SERVERS / LONG-RUNNING PROCESSES");
    expect(prompt).not.toContain("## TERMINAL\n- Use run_command for builds");
  });

  it("an EMPTY override file drops the section entirely (the remove lever)", () => {
    const { root } = projectDir();
    const ctx = ctxFor(root);
    const withMemory = buildProjectSystemPrompt(ctx);
    expect(withMemory).toContain("## Project memory");

    override(root, "project-memory", "   \n\n"); // trims to "" = drop
    const dropped = buildProjectSystemPrompt(ctx);
    expect(dropped).not.toContain("## Project memory");
    expect(dropped).not.toContain("The build is pnpm-based.");
    // The digest also disappears from the METER's memory slice.
    expect(buildSystemPromptSections(ctx).memory).toBe("");
    // No blank-line pileup where the section used to sit.
    expect(dropped).not.toMatch(/\n\n\n/);
  });
});

// ── reordering ──────────────────────────────────────────────────────────────

describe("_order.txt reordering (R59-F)", () => {
  it("reorders sections ONLY together with an override; unknown order ids are tolerated", () => {
    const { root } = projectDir();
    const ctx = ctxFor(root);
    const before = buildProjectSystemPrompt(ctx);
    const idx = (p: string, needle: string) => p.indexOf(needle);

    // Order file alone: byte-identical (pinned above too, asserted again).
    orderFile(root, "environment\nidentity\nbogus-section\n");
    expect(buildProjectSystemPrompt(ctx)).toBe(before);

    // Now WITH an override: environment moves to the FRONT (before identity).
    override(root, "communication", "## COMMUNICATION (project override)\nR59F-MARKER-REORDER");
    const reordered = buildProjectSystemPrompt(ctx);
    expect(idx(reordered, "## ENVIRONMENT")).toBeGreaterThanOrEqual(0);
    expect(idx(reordered, "## ENVIRONMENT")).toBeLessThan(idx(reordered, "You are an expert software engineer"));
    expect(idx(reordered, "## COMMUNICATION (project override)")).toBeLessThan(idx(reordered, "## CODEBASE AWARENESS"));
    // Unlisted sections keep their built-in relative order behind the listed ones.
    expect(idx(reordered, "## TOOL USE")).toBeLessThan(idx(reordered, "## AGENTIC LOOP"));
    expect(reordered).toContain("R59F-MARKER-REORDER");
  });

  it("a listed-but-absent section id is skipped, not injected (honest composition)", () => {
    const { root } = projectDir();
    const ctx = ctxFor(root); // permissionMode undefined → no operating-mode section
    orderFile(root, "permission-mode\nenvironment\n");
    override(root, "communication", "R59F-MARKER-ORDER-ABSENT");
    const prompt = buildProjectSystemPrompt(ctx);
    // ROUND-81: the section's heading is "## OPERATING MODE" (renamed from
    // "## PERMISSION MODE" by the unified-mode picker) — still never injected.
    expect(prompt).not.toContain("## OPERATING MODE"); // never injected
    expect(prompt).toContain("R59F-MARKER-ORDER-ABSENT");
    expect(prompt.indexOf("## ENVIRONMENT")).toBeLessThan(prompt.indexOf("You are an expert software engineer"));
  });
});

// ── the meter stays attributable ─────────────────────────────────────────────

describe("context-meter buckets with overrides (R59-F)", () => {
  it("an override keeps its section's ORIGINAL meter bucket (communication → identity slice)", () => {
    const { root } = projectDir();
    override(root, "communication", "## COMMUNICATION (project override)\nR59F-MARKER-BUCKET");
    const sections = buildSystemPromptSections(ctxFor(root));
    expect(sections.identity).toContain("R59F-MARKER-BUCKET");
    expect(sections.tools).not.toContain("R59F-MARKER-BUCKET");
    expect(sections.meta).not.toContain("R59F-MARKER-BUCKET");
  });

  it("the four slices remain an exact PARTITION of the overridden prompt's lines", () => {
    const { root } = projectDir();
    override(root, "communication", "## COMMUNICATION (project override)\nR59F-MARKER-PARTITION\nline");
    override(root, "project-memory", "## Project memory (project override)\nR59F-MARKER-PARTITION-MEM");
    const ctx = ctxFor(root);
    const full = buildProjectSystemPrompt(ctx);
    const sections = buildSystemPromptSections(ctx);
    const fullLines = full.split("\n");
    const sectionLines = [
      ...sections.identity.split("\n"),
      ...sections.tools.split("\n"),
      ...sections.memory.split("\n"),
      ...sections.meta.split("\n"),
    ];
    expect([...sectionLines].sort()).toEqual([...fullLines].sort());
  });
});

// ── applySectionOverrides as a pure unit ────────────────────────────────────

describe("applySectionOverrides unit (R59-F)", () => {
  const lines: TaggedLine[] = [
    { section: "identity", line: "persona", sectionId: "identity" },
    { section: "identity", line: "", sectionId: "identity" },
    { section: "tools", line: "## TOOL USE", sectionId: "tool-use" },
    { section: "tools", line: "tools body", sectionId: "tool-use" },
    { section: "tools", line: "", sectionId: "tool-use" },
    { section: "identity", line: "## COMMUNICATION", sectionId: "communication" },
    { section: "identity", line: "comm body", sectionId: "communication" },
    { section: "identity", line: "", sectionId: "communication" },
  ];

  it("returns the SAME array content untouched when no overrides (fast path)", () => {
    const out = applySectionOverrides(lines, new Map());
    expect(out).toEqual(lines);
  });

  it("replaces a section, appends one trailing separator blank, keeps bucket + id", () => {
    const out = applySectionOverrides(lines, new Map([["communication", "REPLACED\nBODY"]]));
    expect(out.map((l) => l.line)).toEqual([
      "persona",
      "",
      "## TOOL USE",
      "tools body",
      "",
      "REPLACED",
      "BODY",
      "",
    ]);
    const replaced = out.filter((l) => l.sectionId === "communication");
    expect(replaced.every((l) => l.section === "identity")).toBe(true); // original bucket
  });

  it("drops the section for an empty-string override (heading + body + separator)", () => {
    const out = applySectionOverrides(lines, new Map([["communication", ""]]));
    expect(out.map((l) => l.line)).toEqual(["persona", "", "## TOOL USE", "tools body", ""]);
  });

  it("reorders only with overrides: listed first (in order), the rest keep composition order", () => {
    const out = applySectionOverrides(
      lines,
      new Map([["communication", "X"]]),
      ["tool-use", "communication"],
    );
    expect(out.map((l) => l.sectionId)).toEqual([
      "tool-use",
      "tool-use",
      "tool-use",
      "communication",
      "communication",
      "identity",
      "identity",
    ]);
    // Order with NO overrides would be a no-op — pinned by the equality above.
    const noop = applySectionOverrides(lines, new Map(), ["tool-use", "communication"]);
    expect(noop).toEqual(lines);
  });

  it("hand-built lines without sectionId pass through untouched (defensive shape)", () => {
    const untagged: TaggedLine[] = [
      { section: "identity", line: "a" },
      { section: "identity", line: "b" },
    ];
    const out = applySectionOverrides(untagged, new Map([["communication", "X"]]));
    expect(out).toEqual(untagged);
  });
});

// ── inspection surface (CLI + future UI) ────────────────────────────────────

describe("describePromptSections + buildSectionText (R59-F)", () => {
  it("reports the registry with overridden/present flags, effective order, and diagnostics", () => {
    const { root } = projectDir();
    override(root, "communication", "## COMMUNICATION (project override)\nR59F-MARKER-DESCRIBE");
    orderFile(root, "communication\nenvironment\nnope\n");
    const report = describePromptSections(ctxFor(root));

    expect(report.rootPath).toBe(root);
    expect(report.overridden).toEqual(["communication"]);
    const comm = report.sections.find((s) => s.id === "communication");
    expect(comm?.overridden).toBe(true);
    expect(comm?.present).toBe(true);
    expect(comm?.dynamic).toBe(false);
    // Conditional sections report absent honestly for this ctx.
    expect(report.sections.find((s) => s.id === "permission-mode")?.present).toBe(false);
    expect(report.sections.find((s) => s.id === "project-memory")?.present).toBe(true);
    // Effective order honors _order.txt (now that an override exists).
    expect(report.effectiveOrder.indexOf("communication")).toBeLessThan(report.effectiveOrder.indexOf("identity"));
    expect(report.diagnostics.some((d) => d.includes('unknown section id "nope" ignored'))).toBe(true);
    expect(report.diagnostics.some((d) => d.includes("order file active"))).toBe(true);
  });

  it("an empty override makes a previously-present section report absent", () => {
    const { root } = projectDir();
    override(root, "communication", "");
    const report = describePromptSections(ctxFor(root));
    expect(report.sections.find((s) => s.id === "communication")?.present).toBe(false);
    expect(report.overridden).toEqual(["communication"]);
  });

  it("buildSectionText: override text when overridden, built-in text otherwise, undefined when absent", () => {
    const { root } = projectDir();
    override(root, "communication", "## COMMUNICATION (project override)\nR59F-MARKER-SHOW");
    const ctx = ctxFor(root);

    const commText = buildSectionText(ctx, "communication");
    expect(commText).toBe("## COMMUNICATION (project override)\nR59F-MARKER-SHOW"); // no trailing blank
    expect(commText).not.toContain("CONCISE BY DEFAULT");

    const gitText = buildSectionText(ctx, "git");
    expect(gitText).toBeDefined();
    expect(gitText?.startsWith("## GIT")).toBe(true); // built-in composition
    expect(gitText?.endsWith("Only commit when the user explicitly asks.")).toBe(true);

    // permissionMode is undefined in this ctx → the section is absent.
    expect(buildSectionText(ctx, "permission-mode")).toBeUndefined();
  });
});
