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
const GOLDEN_ROOT = "/tmp/acute-r61-golden-root";
const FULL_CTX = {
  projectName: "GoldenProject",
  rootPath: GOLDEN_ROOT,
  // read_skill is IN TOOL_NAMES since R61 (the skills loader is a global
  // capability) — appending it here would duplicate it; only the dynamic
  // MCP bridge name is appended (it is never static vocabulary).
  toolNames: [...TOOL_NAMES, "mcp__demo__echo"],
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
  // ROUND-61 (R61): the new gates — the skills index (progressive
  // disclosure) + the computer-use master switch, both open so the
  // COMPLETENESS pin sees every id.
  skills: [
    { name: "computer-use", description: "Observe and actuate the desktop GUI: accessibility-first element actions with screenshot-coordinate fallback." },
    { name: "demo-skill", description: "A demonstration user skill." },
  ],
  computerUse: { enabled: true, posture: "act" as const },
  // ROUND-65 (R65) → R66: debugMode stays in the ctx (the field is retained
  // for the route-side analyst gate) but composes NOTHING since R66 removed
  // the self-report section — kept here to pin that the golden ctx passes
  // it with zero effect on the composition.
  debugMode: true,
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
    // Golden regenerated in R61 (deliberately — the prompts.ts core
    // strengthening + the skills/computer-use/mcp sections changed the
    // composition; every dynamic field pinned to fixed values; the
    // REGENERATION script lives in this test file's header comment below).
    // Regenerated AGAIN in R67 (R67-E, deliberately — the ROUND-67 browser
    // discipline lines, the TAB-WALK DISCOVERY line, the IMAGE ATTACHMENTS
    // rule, and the R66 truth updates: "every open tab" → "this session's
    // tab", "the tab the user is viewing" → "this chat session's own tab",
    // "APPEAR LIVE" → "APPEAR … IMMEDIATELY"; additions-only except those
    // three honest corrections).
    // Regenerated AGAIN in R68 (R68-C, deliberately — the computer-use
    // section gained the BROWSER CONTENT IS SEARCHABLE + CHAIN DISCIPLINE
    // lines and the auto-activation teaching; additions-only except the
    // frontmost_pid_mismatch refusal parenthetical and the raw-input line,
    // both updated to the auto-activation truth).
    // If this fails after a deliberate prompts.ts change, regenerate
    // deliberately and say so in the round log.
    // R59 CI fix: normalize \r\n → \n on BOTH sides before comparing — the
    // fixture is committed with LF, but a Windows checkout with autocrlf
    // rewrites it to CRLF (the R57 CI lesson: never let line endings decide
    // a byte-identity test). .gitattributes additionally pins the fixture
    // to LF, but the code-side normalization keeps the test honest even in
    // working copies with local git overrides.
    const golden = readFileSync(join(import.meta.dirname, "fixtures", "prompt-golden-r61.txt"), "utf8").replace(/\r\n/g, "\n");
    const composed = buildProjectSystemPrompt(FULL_CTX).replace(/\r\n/g, "\n");
    expect(composed).toBe(golden);
  });
});

// ── ROUND-67 (R67-E): the field-report guidance pins ────────────────────────
// The owner's 0.66.0 live Windows run: the model drove the EMBEDDED browser
// with computer-use tools (the bridge was broken then — it is fixed now, so
// the prompt must steer to browser_control), guessed C:\ paths for chat
// image attachments, and had no element-discovery fallback on Windows. These
// pins hold the three teaching lines + the two R66 lines the truth retired.

describe("ROUND-67 (R67-E): browser discipline, tab-walk, attachments", () => {
  it("the browser-panel section teaches per-session tabs + browser_control ONLY (never computer-use tools)", () => {
    const composed = buildProjectSystemPrompt(FULL_CTX);
    const bp = composed.indexOf("## EMBEDDED BROWSER PANEL (browser_control)");
    expect(bp).toBeGreaterThan(-1);
    const rest = composed.slice(bp, bp + 5_000);
    expect(rest).toContain("ROUND-67 — THE EMBEDDED BROWSER IS YOURS");
    expect(rest).toContain("THIS chat session's OWN tab");
    expect(rest).toContain("get_state lists only this session's tab");
    expect(rest).toContain("DRIVE THE PANEL ONLY WITH browser_control (R67)");
    expect(rest).toContain("NEVER computer-use tools (left_click, scroll, type, mouse_move, screenshot)");
    expect(rest).toContain('never show "agent is using your computer"');
    // The (b) workflow: read_dom → the returned selector paths → click/type.
    expect(rest).toContain("read_dom first, then click / type the SELECTOR PATHS it returns");
    expect(rest).toContain("press_key Enter submits the focused form");
    // The R66 claims the R67 reality retired are GONE.
    expect(rest).not.toContain("every open tab, which tab is active");
    expect(rest).not.toContain("the tab the user is viewing");
  });

  it("the computer-use section teaches the TAB-WALK discovery fallback (key \"tab\" + the receipt's focused readback)", () => {
    const composed = buildProjectSystemPrompt(FULL_CTX);
    const cu = composed.indexOf("## COMPUTER USE (desktop control)");
    expect(cu).toBeGreaterThan(-1);
    const rest = composed.slice(cu, cu + 3_000);
    expect(rest).toContain("TAB-WALK DISCOVERY (R67)");
    expect(rest).toContain('press key "tab"');
    expect(rest).toContain("names the FOCUSED element");
    expect(rest).toContain("Combine with find_elements");
  });

  it("the tool-use rules teach the image-attachment path contract — analyze_image-gated", () => {
    const composed = buildProjectSystemPrompt(FULL_CTX);
    const tu = composed.indexOf("## TOOL USE");
    expect(tu).toBeGreaterThan(-1);
    const rest = composed.slice(tu, tu + 3_000);
    expect(rest).toContain("IMAGE ATTACHMENTS (R67)");
    expect(rest).toContain('"saved in the project at <path>"');
    expect(rest).toContain('analyze_image with path "<path>"');
    // The gate: an allowlist without analyze_image never sees the rule.
    const noVision = buildProjectSystemPrompt({
      ...FULL_CTX,
      toolNames: FULL_CTX.toolNames.filter((n) => n !== "analyze_image"),
    });
    expect(noVision).not.toContain("IMAGE ATTACHMENTS (R67)");
    expect(noVision).toContain("## TOOL USE");
  });
});

// ── ROUND-68 (R68-C): the computer-use anti-screenshot-spam pins ────────────
// The owner's live 0.67.0 report: "utilizing the screenshot capturing way
// too much… the coordinate-based system is not proper". The prompt now
// teaches the SEARCHABLE browser tree, the immediate observe→act chain
// (frames valid 30s), the small verification crop, middle_click=new-tab,
// and the raw-input auto-activation.

describe("ROUND-68 (R68-C): the computer-use discipline lines", () => {
  it("BROWSER CONTENT IS SEARCHABLE + CHAIN DISCIPLINE + middle_click = new tab", () => {
    const composed = buildProjectSystemPrompt(FULL_CTX);
    const cu = composed.indexOf("## COMPUTER USE (desktop control)");
    expect(cu).toBeGreaterThan(-1);
    // The section grew by two lines — the 3_000-char window covers it.
    const rest = composed.slice(cu, cu + 4_200);
    expect(rest).toContain("BROWSER CONTENT IS SEARCHABLE (R68)");
    expect(rest).toContain("find_elements {appRef, query:'Wikipedia'}");
    expect(rest).toContain("the web tree is activated automatically before every walk");
    expect(rest).toContain("element targets are the PRIMARY path for browser content");
    expect(rest).toContain("CHAIN DISCIPLINE (R68)");
    expect(rest).toContain("act IMMEDIATELY on its pixels (frames stay valid 30s)");
    expect(rest).toContain("never re-screenshot between observing and acting");
    expect(rest).toContain("a small zoom region crop of the one control");
    expect(rest).toContain("middle_click on a link = open in new tab");
  });

  it("the auto-activation teaching replaces the manual activate-then-retry dance", () => {
    const composed = buildProjectSystemPrompt(FULL_CTX);
    const cu = composed.indexOf("## COMPUTER USE (desktop control)");
    const rest = composed.slice(cu, cu + 4_200);
    expect(rest).toContain("ACTIVATE their target app automatically");
    expect(rest).toContain("a mismatch refusal means the activation itself failed");
    expect(rest).toContain("frontmost_pid_mismatch → the auto-activation failed");
    // The old manual-recovery parenthetical is retired.
    expect(rest).not.toContain("frontmost_pid_mismatch → activate → re-observe");
  });

  it("the lines are computer-use-gated (the section composes only when the master switch is on)", () => {
    const off = buildProjectSystemPrompt({ ...FULL_CTX, computerUse: { enabled: false, posture: "act" as const } });
    expect(off).not.toContain("## COMPUTER USE (desktop control)");
    expect(off).not.toContain("CHAIN DISCIPLINE (R68)");
    expect(off).not.toContain("BROWSER CONTENT IS SEARCHABLE (R68)");
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
