/**
 * ROUND-94 (R94-G): THE PROMPT-OVERHAUL ROUND — pins for every deliverable
 * (the owner's v0.91.0 field report: "our system prompts need to be much
 * better… Learn from the best of the best… It should be able to follow our
 * commands properly. It should be flexible where needed."):
 *
 *   1. RECOVERY PROTOCOL (the core ask): the section composes right after
 *      the agentic-loop (whose failure rule points at it), STATIC +
 *      UNCONDITIONAL (a bare read-only session still gets it), and carries
 *      the six imperative rules — re-observe before retrying, ≤2 identical
 *      retries then CHANGE STRATEGY, recovery hints exactly once, believe
 *      refusals, let the world settle (wait; never race a loading page;
 *      wait_for_verification for human-solvable walls), never abandon the
 *      task. Plus the registry cascade: a .acute/prompts/recovery.md file
 *      replaces the section; an empty one drops it.
 *   2. CAPABILITIES (the vision line — the prompt-side half of the R94-E/F
 *      screenshot gate): hasVisionPath:false + an image-capable tool → the
 *      ONE clear line (no image understanding; NEVER call screenshot, zoom,
 *      or any image-analysis tool — they will be REFUSED; perceive via
 *      browser read_dom/read/source and desktop get_app_state/
 *      find_elements/get_tree). hasVisionPath:true → the converse MAY line.
 *      Absent, or no image-capable tool in the toolset → NO section
 *      (byte-identical pre-R94 composition — every gate is honest).
 *   3. SIZE BUDGET: the additions stayed TIGHT — the recovery section keeps
 *      a sub-1.5K window ("the best agents' prompts are concise"); the
 *      browser/computer-use section budgets live in r70-prompt-round.test.ts
 *      (updated there with the R94-G deltas).
 *
 * The BROWSER DISCIPLINE (wait/sequence vocabulary + NAVIGATION SETTLES)
 * and COMPUTER-USE DISCIPLINE (windows by exact title/pid, window_action,
 * the app_ref re-resolution rule) pins were added to r70-prompt-round.test.ts
 * next to the sections they extend — this file pins the NEW sections.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  buildProjectSystemPrompt,
  buildSectionText,
  type PromptContext,
  type PromptEnvironment,
} from "../src/agents/prompts";
import { TOOL_NAMES } from "../src/storage/agents";

afterAll(() => {
  try {
    rmSync(join(tmpdir(), "acute-r94g-"), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/** Fresh project root for the override-hook fixtures. */
function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "acute-r94g-"));
}

const BASE_ENV: PromptEnvironment = {
  osPlatform: "Linux",
  osRelease: "6.5.0-r94g",
  shell: "/bin/sh",
  currentDate: "2026-06-11 (Thursday)",
  gitBranch: "main",
  gitDirty: false,
};

/** A maximal-ish ctx: every relevant gate open, env pinned. */
function ctxFor(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    projectName: "R94gProject",
    rootPath: "/tmp/acute-r94g-never-exists",
    toolNames: [...TOOL_NAMES],
    maxTurns: 40,
    maxOuterLoops: 5,
    environment: { ...BASE_ENV },
    ...overrides,
  };
}

// ── 1: the RECOVERY PROTOCOL ────────────────────────────────────────────────

describe("R94-G: the RECOVERY PROTOCOL section", () => {
  it("is STATIC + UNCONDITIONAL — even a bare read-only ctx gets the doctrine", () => {
    const bare = buildProjectSystemPrompt({
      projectName: "Bare",
      rootPath: "/tmp/acute-r94g-never-exists",
      toolNames: ["read_file", "search_code"],
    });
    expect(bare).toContain("## RECOVERY PROTOCOL (tool failures)");
    // The core rules survive the minimal composition.
    expect(bare).toContain("RE-OBSERVE BEFORE RETRYING");
    expect(bare).toContain("CHANGE STRATEGY");
    expect(bare).toContain("NEVER ABANDON THE TASK");
  });

  it("composes immediately after the agentic-loop, whose failure rule points at it", () => {
    const composed = buildProjectSystemPrompt(ctxFor());
    const idx = (needle: string) => composed.indexOf(needle);
    expect(idx("## RECOVERY PROTOCOL (tool failures)")).toBeGreaterThan(idx("## AGENTIC LOOP — MULTI-TURN COMPLETION"));
    expect(idx("## ENGINEERING DISCIPLINE")).toBeGreaterThan(idx("## RECOVERY PROTOCOL (tool failures)"));
    const loop = buildSectionText(ctxFor(), "agentic-loop") ?? "";
    expect(loop).toContain("the RECOVERY PROTOCOL below governs. Do not abort.");
  });

  it("rule 1 — RE-OBSERVE before retrying, with BOTH surfaces' observation tools", () => {
    const recovery = buildSectionText(ctxFor(), "recovery") ?? "";
    expect(recovery).toContain("RE-OBSERVE BEFORE RETRYING");
    expect(recovery).toContain("read the CURRENT state first");
    // Browser: get_state/read_dom; desktop: get_app_state/list_apps.
    expect(recovery).toContain("browser: get_state/read_dom");
    expect(recovery).toContain("desktop: get_app_state/list_apps");
    expect(recovery).toContain("never retry blind");
  });

  it("rule 2 — at most 2 identical retries, then CHANGE STRATEGY via a different path", () => {
    const recovery = buildSectionText(ctxFor(), "recovery") ?? "";
    expect(recovery).toContain("IDENTICAL RETRIES: at most 2");
    expect(recovery).toContain("fails the same way twice, CHANGE STRATEGY");
    // The strategy menu: selector, action, or a different path (eval
    // fallback, another element, keyboard instead of mouse).
    expect(recovery).toContain("eval as the fallback");
    expect(recovery).toContain("keyboard instead of mouse");
  });

  it("rule 3 — tool error recovery hints are followed EXACTLY ONCE", () => {
    const recovery = buildSectionText(ctxFor(), "recovery") ?? "";
    expect(recovery).toContain("when a tool error names a recovery, follow it EXACTLY ONCE");
    expect(recovery).toContain("if the hint's fix also fails, change strategy");
  });

  it("rule 4 — refused/blocked results are BELIEVED, not immediately repeated", () => {
    const recovery = buildSectionText(ctxFor(), "recovery") ?? "";
    expect(recovery).toContain("REFUSALS ARE REAL");
    expect(recovery).toContain("refused or blocked");
    expect(recovery).toContain("do not immediately repeat the call");
  });

  it("rule 5 — let the world settle: wait, never race a loading page, wait_for_verification for walls", () => {
    const recovery = buildSectionText(ctxFor(), "recovery") ?? "";
    expect(recovery).toContain("LET THE WORLD SETTLE");
    expect(recovery).toContain("browser wait / desktop wait; sequence waits automatically");
    expect(recovery).toContain("never race a loading page");
    expect(recovery).toContain("wait_for_verification, never a retry loop");
  });

  it("rule 6 — never abandon the task; honest progress + the stop condition", () => {
    const recovery = buildSectionText(ctxFor(), "recovery") ?? "";
    expect(recovery).toContain("NEVER ABANDON THE TASK on tool failures");
    expect(recovery).toContain("report progress honestly and continue with a changed approach");
    expect(recovery).toContain("say what was tried and what is needed");
  });

  it("has its prompt-module override hook (replace + drop, the R71-d D5 cascade)", () => {
    const root = tempRoot();
    const dir = join(root, ".acute", "prompts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "recovery.md"), "## RECOVERY PROTOCOL (project override)\nR94G-MARKER-RECOVERY\nStay calm.", "utf8");
    const replaced = buildProjectSystemPrompt(ctxFor({ rootPath: root }));
    expect(replaced).toContain("R94G-MARKER-RECOVERY");
    expect(replaced).not.toContain("RE-OBSERVE BEFORE RETRYING");
    // Neighbors survive untouched.
    expect(replaced).toContain("## AGENTIC LOOP — MULTI-TURN COMPLETION");
    expect(replaced).toContain("## ENGINEERING DISCIPLINE");

    const empty = tempRoot();
    const emptyDir = join(empty, ".acute", "prompts");
    mkdirSync(emptyDir, { recursive: true });
    writeFileSync(join(emptyDir, "recovery.md"), "  \n\n", "utf8");
    const dropped = buildProjectSystemPrompt(ctxFor({ rootPath: empty }));
    expect(dropped).not.toContain("## RECOVERY PROTOCOL");
    expect(dropped).toContain("## ENGINEERING DISCIPLINE"); // neighbors intact
  });

  it("the size budget: the section keeps a sub-1.5K window (the best agents are concise)", () => {
    const recovery = buildSectionText(ctxFor(), "recovery") ?? "";
    // Measured 1,282 at R94-G — the window keeps any future growth honest:
    // new rules must pay for themselves by compressing old ones.
    expect(recovery.length).toBeGreaterThanOrEqual(900);
    expect(recovery.length).toBeLessThanOrEqual(1_500);
  });
});

// ── 2: the CAPABILITIES vision line ────────────────────────────────────────

describe("R94-G: CAPABILITIES — the hasVisionPath line", () => {
  it("no vision + image-capable tools → the ONE clear line (refused + the text alternatives)", () => {
    const composed = buildProjectSystemPrompt(ctxFor({ hasVisionPath: false }));
    const cap = composed.indexOf("## CAPABILITIES");
    expect(cap).toBeGreaterThan(-1);
    const rest = composed.slice(cap, cap + 700);
    expect(rest).toContain("IMAGE UNDERSTANDING: NONE in this session");
    expect(rest).toContain("NEVER call screenshot, zoom, or any image-analysis tool");
    expect(rest).toContain("they cannot help you and will be REFUSED");
    // The perception alternatives — browser AND desktop, the real tool names.
    expect(rest).toContain("browser read_dom/read/source");
    expect(rest).toContain("desktop get_app_state/find_elements/get_tree");
  });

  it("the section sits between the browser-panel section it modifies and COMMUNICATION", () => {
    const composed = buildProjectSystemPrompt(ctxFor({ hasVisionPath: false }));
    const idx = (needle: string) => composed.indexOf(needle);
    expect(idx("## CAPABILITIES")).toBeGreaterThan(idx("## EMBEDDED BROWSER PANEL (browser_control)"));
    expect(idx("## COMMUNICATION")).toBeGreaterThan(idx("## CAPABILITIES"));
  });

  it("vision present → the short converse MAY line (no refusal doctrine)", () => {
    const composed = buildProjectSystemPrompt(ctxFor({ hasVisionPath: true }));
    const rest = composed.slice(composed.indexOf("## CAPABILITIES"), composed.indexOf("## CAPABILITIES") + 700);
    expect(rest).toContain("IMAGE UNDERSTANDING: available");
    expect(rest).toContain("you MAY analyze images");
    expect(rest).toContain("when the VISUAL LAYOUT itself is the question");
    // The no-vision doctrine is GONE in this polarity.
    expect(rest).not.toContain("NONE in this session");
    expect(rest).not.toContain("will be REFUSED");
  });

  it("absent hasVisionPath → NO section at all (pre-R94 callers compose byte-identically)", () => {
    const composed = buildProjectSystemPrompt(ctxFor());
    expect(composed).not.toContain("## CAPABILITIES");
    expect(composed).not.toContain("IMAGE UNDERSTANDING");
  });

  it("honest gating: no image-capable tool in the toolset → no section (the line is never noise)", () => {
    // browser_control + analyze_image removed, computer-use master switch off.
    const stripped = buildProjectSystemPrompt({
      ...ctxFor({ hasVisionPath: false }),
      toolNames: TOOL_NAMES.filter((t) => t !== "browser_control" && t !== "analyze_image"),
    });
    expect(stripped).not.toContain("## CAPABILITIES");
    expect(stripped).toContain("## TOOL USE"); // the rest composes normally
  });

  it("each image-capable trigger opens the gate alone: browser_control OR analyze_image OR the computer-use switch", () => {
    const justBrowser = buildProjectSystemPrompt({
      ...ctxFor({ hasVisionPath: false }),
      toolNames: ["browser_control", "read_file"],
    });
    expect(justBrowser).toContain("IMAGE UNDERSTANDING: NONE in this session");
    const justAnalyze = buildProjectSystemPrompt({
      ...ctxFor({ hasVisionPath: false }),
      toolNames: ["analyze_image", "read_file"],
    });
    expect(justAnalyze).toContain("IMAGE UNDERSTANDING: NONE in this session");
    const justComputerUse = buildProjectSystemPrompt({
      ...ctxFor({ hasVisionPath: false }),
      toolNames: ["read_file"],
      computerUse: { enabled: true, posture: "act" },
    });
    expect(justComputerUse).toContain("IMAGE UNDERSTANDING: NONE in this session");
  });

  it("the golden fixture byte-pins the no-vision line (FULL_CTX carries hasVisionPath:false)", () => {
    // prompt-registry.test.ts regenerates the fixture with hasVisionPath
    // false pinned in FULL_CTX — this pin just re-states the coupling so a
    // future FULL_CTX flip cannot silently drift the fixture's meaning.
    const golden = buildProjectSystemPrompt({
      projectName: "GoldenProject",
      rootPath: "/tmp/acute-r61-golden-root",
      toolNames: [
        "list_dir", "read_file", "write_file", "edit_file", "create_dir", "delete_file",
        "search_files", "search_code", "git_status", "git_diff", "git_log", "run_command",
        "todo_write", "web_fetch", "web_search", "index_project", "delegate_task",
        "browser_control", "memory_save", "memory_recall", "memory_list",
        "job_status", "job_stop", "read_skill", "analyze_image", "mcp__demo__echo",
      ],
      customRules: "Always write tests first.",
      maxTurns: 37,
      maxOuterLoops: 5,
      environment: {
        osPlatform: "Linux",
        osRelease: "6.5.0-r70c",
        shell: "/bin/sh",
        currentDate: "2026-06-11 (Thursday)",
        gitBranch: "main",
        gitDirty: true,
      },
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
      } as PromptContext["indexSummary"],
      memoryDigest: "- [fact] The build is pnpm-based.",
      permissionMode: "plan" as const,
      skills: [
        { name: "computer-use", description: "Observe and actuate the desktop GUI: accessibility-first element actions with screenshot-coordinate fallback." },
        { name: "demo-skill", description: "A demonstration user skill." },
      ],
      computerUse: { enabled: true, posture: "act" as const },
      hasVisionPath: false,
      debugMode: true,
    });
    expect(golden).toContain("## CAPABILITIES");
    expect(golden).toContain("IMAGE UNDERSTANDING: NONE in this session");
  });
});
