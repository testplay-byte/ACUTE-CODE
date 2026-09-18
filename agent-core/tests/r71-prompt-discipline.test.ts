/**
 * ROUND-71 (R71-e1): THE PROMPT DISCIPLINE ROUND — pins for every deliverable:
 *
 *   D1 — ENGINEERING DISCIPLINE section (right after the agentic-loop in
 *        composition order): the four karpathy mantras with binary
 *        self-tests, [KNOWN]/[ASSUMED]/[UNKNOWN] evidence tagging (never
 *        write code that depends on an [UNKNOWN]), the THREE-STRIKE
 *        architecture escalation, and the red-flags anti-rationalization
 *        table.
 *   D2 — the PLAN-phase task→verifiable-goal transform (three canonical
 *        mappings, unconditional across both PLAN variants).
 *   D3 — COMMUNICATION upgrades: verification receipts (command + exit
 *        status / key output line — an assertion without a receipt is not
 *        verification), the 🟢/🟡/🔴 confidence tags + the devil's-advocate
 *        line, and the anti-question-padding rule.
 *   D4 — SUB-AGENTS discipline: deliver only the delegated scope (never
 *        duplicate it) + results arrive as tool results (never sleep/wait/
 *        poll for a sub-agent; job_status is for background SHELL jobs).
 *   D5 — the registry cascade: the section has its override hook (a
 *        .acute/prompts/engineering-discipline.md file replaces it; empty
 *        drops it). The order/completeness + golden byte-identity pins live
 *        in prompt-registry.test.ts (regenerated via the sanctioned
 *        UPDATE_GOLDEN=1 procedure — 20,156 → 23,665 bytes).
 *   D6 — the size budget: the DEFAULT full-tools composition (what a real
 *        session's system prompt looks like before project-injected
 *        content) stays ≤ 22,000 chars — was 14,757 at R70, 18,220 after
 *        R71-e1's ~3.5K of discipline content. The discipline section
 *        itself stays within its designed 1.8–2.6K window.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  buildProjectSystemPrompt,
  buildSectionText,
  buildTaggedPromptLines,
  type PromptContext,
  type PromptEnvironment,
} from "../src/agents/prompts";
import { PROMPT_SECTION_IDS } from "../src/agents/prompt-registry";
import { TOOL_NAMES } from "../src/storage/agents";

afterAll(() => {
  try {
    rmSync(join(tmpdir(), "acute-r71e1-"), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/** Fresh project root for the override-hook fixture. */
function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "acute-r71e1-"));
}

const BASE_ENV: PromptEnvironment = {
  osPlatform: "Linux",
  osRelease: "6.5.0-r71e1",
  shell: "/bin/sh",
  currentDate: "2026-06-11 (Thursday)",
  gitBranch: "main",
  gitDirty: false,
};

/** A maximal-ish ctx: every relevant gate open, env pinned. */
function ctxFor(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    projectName: "R71e1Project",
    rootPath: "/tmp/acute-r71e1-never-exists",
    toolNames: [...TOOL_NAMES],
    maxTurns: 40,
    maxOuterLoops: 5,
    environment: { ...BASE_ENV },
    ...overrides,
  };
}

/** The PLAN-mode vocabulary (runtime.ts PLAN_MODE_TOOLS, pinned inline so
 * this prompt test stays hermetic — permission-modes.test.ts owns the
 * mode-logic pin): read-only/research + todos + memory + delegation + the
 * browser panel — NO run_command, NO file mutation, NO index_project. */
const PLAN_VOCAB: readonly string[] = [
  "read_file",
  "list_dir",
  "search_files",
  "search_code",
  "web_search",
  "web_fetch",
  "browser_control",
  "todo_write",
  "memory_save",
  "memory_recall",
  "memory_list",
  "delegate_task",
  "read_skill",
];

// ── D1: the ENGINEERING DISCIPLINE section ──────────────────────────────────

describe("D1: the section exists, in the designed position", () => {
  it("the registry lists engineering-discipline behind the recovery protocol, right after the agentic-loop pair (before file-editing)", () => {
    const i = PROMPT_SECTION_IDS.indexOf("engineering-discipline");
    expect(i).toBeGreaterThan(-1);
    // ROUND-94 (R94-G): the RECOVERY PROTOCOL now sits directly after the
    // agentic-loop (the loop's failure rule points at it) — discipline
    // follows recovery, still before file-editing (the R71-d design
    // position, one slot later than originally pinned).
    // ROUND-96 (R96-D): the BATCH + COMPLETION discipline pair now sits
    // between the agentic-loop and recovery (the owner's batching +
    // completion directives) — engineering-discipline keeps its position
    // AFTER recovery, now four slots after the loop.
    expect(PROMPT_SECTION_IDS[i - 1]).toBe("recovery");
    expect(PROMPT_SECTION_IDS[i - 2]).toBe("completion-discipline");
    expect(PROMPT_SECTION_IDS[i - 3]).toBe("batch-discipline");
    expect(PROMPT_SECTION_IDS[i - 4]).toBe("agentic-loop");
    expect(PROMPT_SECTION_IDS[i + 1]).toBe("file-editing");
  });

  it("the stamped composition order agrees (registry == stamped runs)", () => {
    const stamped: string[] = [];
    for (const entry of buildTaggedPromptLines(ctxFor())) {
      if (stamped[stamped.length - 1] !== entry.sectionId) stamped.push(entry.sectionId as string);
    }
    expect(stamped.indexOf("engineering-discipline")).toBe(stamped.indexOf("recovery") + 1);
    // ROUND-96 (R96-D): recovery follows the batch + completion pair, which
    // follows the agentic loop.
    expect(stamped.indexOf("recovery")).toBe(stamped.indexOf("completion-discipline") + 1);
    expect(stamped.indexOf("completion-discipline")).toBe(stamped.indexOf("batch-discipline") + 1);
    expect(stamped.indexOf("batch-discipline")).toBe(stamped.indexOf("agentic-loop") + 1);
  });

  it("the composed prompt orders AGENTIC LOOP → RECOVERY PROTOCOL → ENGINEERING DISCIPLINE → FILE EDITING RULES", () => {
    const composed = buildProjectSystemPrompt(ctxFor());
    const idx = (needle: string) => composed.indexOf(needle);
    expect(idx("## AGENTIC LOOP — MULTI-TURN COMPLETION")).toBeGreaterThan(-1);
    expect(idx("## RECOVERY PROTOCOL (tool failures)")).toBeGreaterThan(idx("## AGENTIC LOOP — MULTI-TURN COMPLETION"));
    expect(idx("## ENGINEERING DISCIPLINE")).toBeGreaterThan(idx("## RECOVERY PROTOCOL (tool failures)"));
    expect(idx("## FILE EDITING RULES")).toBeGreaterThan(idx("## ENGINEERING DISCIPLINE"));
  });

  it("the section is STATIC + UNCONDITIONAL: it composes even for a bare read-only ctx", () => {
    const bare = buildProjectSystemPrompt({
      projectName: "Bare",
      rootPath: "/tmp/acute-r71e1-never-exists",
      toolNames: ["read_file", "search_code"],
    });
    expect(bare).toContain("## ENGINEERING DISCIPLINE");
    // Discipline is core persona, not a gated capability: a minimal session
    // still gets the mantras + the 3-strike rule.
    expect(bare).toContain("Don't assume. Don't hide confusion. Surface tradeoffs.");
    expect(bare).toContain("THREE-STRIKE ESCALATION");
  });
});

describe("D1: the four karpathy mantras + binary self-tests", () => {
  const section = (): string => buildSectionText(ctxFor(), "engineering-discipline") ?? "";

  it("every principle mantra appears", () => {
    const text = section();
    expect(text).toContain("Don't assume. Don't hide confusion. Surface tradeoffs.");
    expect(text).toContain("Minimum code that solves the problem. Nothing speculative.");
    expect(text).toContain("Touch only what you must. Clean up only your own mess.");
    expect(text).toContain("Define success criteria. Loop until verified.");
  });

  it("each principle carries a self-test the model can run on its own work", () => {
    const text = section();
    expect((text.match(/Self-test:/g) ?? []).length).toBeGreaterThanOrEqual(4);
    // The karpathy canonical self-checks survive the compression.
    expect(text).toContain("would a senior engineer call this overcomplicated");
    expect(text).toContain("Every changed line should trace directly to the request");
  });

  it("the surgical rules: orphan asymmetry + the 200/50 rewrite rule", () => {
    const text = section();
    expect(text).toContain("Remove imports YOUR change orphaned");
    expect(text).toContain("never delete pre-existing dead code unless asked");
    expect(text).toContain("If you wrote 200 lines and 50 would do, rewrite");
    expect(text).toContain("No \"might be useful later\" abstractions");
    expect(text).toContain("no defensive code for impossible states");
  });

  it("interpretation surfacing: multiple interpretations are presented, never picked silently", () => {
    expect(section()).toContain("present them — never pick one silently");
    expect(section()).toContain("restate what \"done\" means in checkable terms");
  });
});

describe("D1: [KNOWN]/[ASSUMED]/[UNKNOWN] evidence tagging", () => {
  it("all three tags are defined and the read-the-source rule is enforced", () => {
    const text = buildSectionText(ctxFor(), "engineering-discipline") ?? "";
    expect(text).toContain("[KNOWN]");
    expect(text).toContain("[ASSUMED]");
    expect(text).toContain("[UNKNOWN]");
    expect(text).toContain("facts you read this session are [KNOWN]");
    expect(text).toContain("reasonable inferences are [ASSUMED]");
    expect(text).toContain("read the source before writing code that depends on it");
    // The iron rule, verbatim.
    expect(text).toContain("NEVER write code that depends on an [UNKNOWN]");
  });
});

describe("D1: the THREE-STRIKE architecture escalation", () => {
  it("the rule composes verbatim-ish (stop, no 4th fix of the same shape, re-diagnose, escalate)", () => {
    const text = buildSectionText(ctxFor(), "engineering-discipline") ?? "";
    expect(text).toContain("THREE-STRIKE ESCALATION");
    expect(text).toContain("three failed attempts to fix the same problem = STOP");
    expect(text).toContain("Do not attempt a 4th fix of the same shape");
    expect(text).toContain("Re-read the evidence (logs, test output, the actual code)");
    expect(text).toContain("question your diagnosis");
    expect(text).toContain("the problem is elsewhere (architecture, wrong file, wrong assumption)");
    expect(text).toContain("Escalate to the user with what you tried and what you learned");
  });
});

describe("D1: the red-flags anti-rationalization table", () => {
  const flags: readonly [string, string][] = [
    ["It's probably fine to skip verification", "run the check; it's one command"],
    ["I'll fix that later", "fix it now or write it down as a todo"],
    ["The user surely means X", "ask, or state your interpretation in one line"],
    ["This small change can't break anything", "run the touched checks"],
    ["I remember the file looking like this", "re-read it; memory of content is not content"],
  ];

  it("every red-flag phrase appears with its rebuttal", () => {
    const text = buildSectionText(ctxFor(), "engineering-discipline") ?? "";
    expect(text).toContain("Red flags — catch yourself thinking any of these → STOP");
    for (const [excuse, rebuttal] of flags) {
      expect(text).toContain(`"${excuse}" → ${rebuttal}`);
    }
  });

  it("the agentic-loop's fix-retry rule still stands (R94-G folded it into the pointer form; the escalation gates it, does not replace it)", () => {
    const loop = buildSectionText(ctxFor(), "agentic-loop") ?? "";
    // ROUND-94 (R94-G): the rule POINTS at the RECOVERY PROTOCOL that
    // immediately follows the loop; the do-not-abort tail survives verbatim.
    // ROUND-99 (R99-G, conscious re-pin): the read-error/fix-root-cause head
    // retired — the TOOL USE rules ("READ tool errors fully before reacting")
    // and the RECOVERY PROTOCOL own that doctrine; the loop keeps the pointer
    // + the do-not-abort core.
    expect(loop).toContain("- If a tool call fails: the RECOVERY PROTOCOL below governs. Do not abort.");
  });
});

// ── D2: the PLAN-phase task→verifiable-goal transform ───────────────────────

describe("D2: the task→verifiable-goal transform", () => {
  it("the three canonical mappings compose in the AGENTIC LOOP, right after the PLAN phase", () => {
    const loop = buildSectionText(ctxFor(), "agentic-loop") ?? "";
    expect(loop).toContain("Transform vague tasks into verifiable goals before acting");
    expect(loop).toContain("\"fix the bug\" → \"write a test that reproduces it, then make it pass\"");
    expect(loop).toContain("\"make it faster\" → \"define the measurable, then optimize until it moves\"");
    expect(loop).toContain("\"clean this up\" → \"name the concrete smell, remove exactly it\"");
    // Position: the transform sits between the PLAN line and EXPLORE.
    const idx = (needle: string) => loop.indexOf(needle);
    expect(idx("1. PLAN")).toBeGreaterThan(-1);
    expect(idx("Transform vague tasks")).toBeGreaterThan(idx("1. PLAN"));
    expect(idx("2. EXPLORE")).toBeGreaterThan(idx("Transform vague tasks"));
  });

  it("unconditional: composes with AND without todo_write (both PLAN variants)", () => {
    const withTodo = buildProjectSystemPrompt(ctxFor());
    const noTodo = buildProjectSystemPrompt({
      ...ctxFor(),
      toolNames: ctxFor().toolNames.filter((t) => t !== "todo_write"),
    });
    for (const composed of [withTodo, noTodo]) {
      expect(composed).toContain("Transform vague tasks into verifiable goals before acting");
      expect(composed).toContain("\"fix the bug\" → \"write a test that reproduces it, then make it pass\"");
    }
  });
});

// ── D3: COMMUNICATION — receipts, confidence tags, anti-question ────────────

describe("D3: verification receipts + confidence tags + anti-question-padding", () => {
  const comm = (): string => buildSectionText(ctxFor(), "communication") ?? "";

  it("receipts: the exact command + exit status / key output line; assertions without receipts are not verification", () => {
    const text = comm();
    expect(text).toContain("the VERIFICATION receipts (the exact command you ran + its exit status or key output line");
    expect(text).toContain("\"pnpm test → 2165 passed\"");
    expect(text).toContain("An assertion without a receipt is not verification.");
  });

  it("the confidence line (ONE vocabulary — R107-a F6) + the devil's-advocate line", () => {
    const text = comm();
    expect(text).toContain("End substantive replies with a confidence line");
    expect(text).toContain("High = all claims verified by receipts");
    expect(text).toContain("medium = partially verified, some claims rest on inference");
    expect(text).toContain("low = unverified");
    expect(text).not.toContain("🟢"); // the emoji vocabulary retired (raw glyphs on CLI/phone)
    expect(text).toContain("one line of devil's advocate — the strongest counter-argument to what you just did");
  });

  it("anti-question-padding: no question unless genuinely blocked; if blocked, state exactly what you need", () => {
    const text = comm();
    expect(text).toContain("Do NOT end a reply with a question unless you are genuinely blocked");
    expect(text).toContain("say exactly what you need (\"I need the DB password\" / \"two valid interpretations: A or B\")");
    // The pre-R71 concise contract survives (R70-c D5 pins, re-checked here).
    expect(text).toContain("CONCISE BY DEFAULT");
    expect(text).toContain("state WHAT you did (the files touched)");
    expect(text).toContain("Cite code locations as path:line (e.g. src/app.ts:42)");
  });
});

// ── D4: SUB-AGENTS discipline ────────────────────────────────────────────────

describe("D4: sub-agent scope + no-polling discipline", () => {
  it("the discipline lines compose in the SUB-AGENTS section (delegate_task-gated)", () => {
    const sub = buildSectionText(ctxFor(), "sub-agents") ?? "";
    expect(sub).toContain("SCOPE DISCIPLINE: the sub-agent reads the delegation brief and delivers only its scope");
    expect(sub).toContain("do not duplicate that work yourself");
    expect(sub).toContain(
      "Delegation results arrive as tool results — do NOT sleep, wait, or poll for a sub-agent (job_status exists only for explicitly-backgrounded shell jobs)",
    );
    // The pre-existing delegation contract survives.
    expect(sub).toContain("SELF-CONTAINED TASKS");
    expect(sub).toContain("PARALLELISM");
  });

  it("honest gating: an allowlist without delegate_task never sees the discipline lines", () => {
    const noDelegate = buildProjectSystemPrompt({
      ...ctxFor(),
      toolNames: ctxFor().toolNames.filter((t) => t !== "delegate_task"),
    });
    expect(noDelegate).not.toContain("## SUB-AGENTS (delegate_task)");
    expect(noDelegate).not.toContain("SCOPE DISCIPLINE");
    expect(noDelegate).not.toContain("do NOT sleep, wait, or poll for a sub-agent");
  });
});

// ── D5: the registry cascade (override hook for the new section) ─────────────

describe("D5: engineering-discipline has its prompt-module override hook", () => {
  it("a .acute/prompts/engineering-discipline.md file REPLACES the section wholesale", () => {
    const root = tempRoot();
    const dir = join(root, ".acute", "prompts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "engineering-discipline.md"), "## ENGINEERING DISCIPLINE (project override)\nR71E1-MARKER-DISCIPLINE\nBe terse, be honest.", "utf8");
    const ctx = ctxFor({ rootPath: root });
    const prompt = buildProjectSystemPrompt(ctx);
    expect(prompt).toContain("R71E1-MARKER-DISCIPLINE");
    expect(prompt).not.toContain("Don't assume. Don't hide confusion. Surface tradeoffs.");
    // Neighbors survive untouched.
    expect(prompt).toContain("## AGENTIC LOOP — MULTI-TURN COMPLETION");
    expect(prompt).toContain("## FILE EDITING RULES");
  });

  it("an EMPTY override file DROPS the section (the remove lever)", () => {
    const root = tempRoot();
    const dir = join(root, ".acute", "prompts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "engineering-discipline.md"), "  \n\n", "utf8");
    const ctx = ctxFor({ rootPath: root });
    const prompt = buildProjectSystemPrompt(ctx);
    expect(prompt).not.toContain("## ENGINEERING DISCIPLINE");
    expect(prompt).not.toContain("THREE-STRIKE ESCALATION");
    expect(prompt).toContain("## AGENTIC LOOP — MULTI-TURN COMPLETION"); // neighbors intact
  });
});

// ── PLAN MODE: the discipline path excludes nothing relevant ─────────────────

describe("PLAN mode: every discipline surface composes (read-only vocabulary)", () => {
  const planCtx = (): PromptContext =>
    ctxFor({ toolNames: [...PLAN_VOCAB], permissionMode: "plan" });

  it("the mode narration + read-only honesty, with the discipline intact", () => {
    const composed = buildProjectSystemPrompt(planCtx());
    // ROUND-81: the section is "## OPERATING MODE" (renamed from
    // "## PERMISSION MODE" by the unified-mode picker) and the plan
    // narration carries the R81 voice.
    expect(composed).toContain("## OPERATING MODE");
    expect(composed).toContain(
      "You are in PLAN mode: read-only — you can plan, read files, and research, but you cannot edit the project or run commands. Produce plans, analysis, and research.",
    );
    // D1 — the discipline section (static, unconditional).
    expect(composed).toContain("## ENGINEERING DISCIPLINE");
    expect(composed).toContain("NEVER write code that depends on an [UNKNOWN]");
    expect(composed).toContain("THREE-STRIKE ESCALATION");
    expect(composed).toContain("It's probably fine to skip verification");
    // D2 — the task→verifiable-goal transform (plan mode HAS todo_write).
    expect(composed).toContain("Transform vague tasks into verifiable goals before acting");
    expect(composed).toContain("\"fix the bug\" → \"write a test that reproduces it, then make it pass\"");
    // D3 — receipts + the confidence line + anti-question (COMMUNICATION is unconditional).
    expect(composed).toContain("An assertion without a receipt is not verification.");
    expect(composed).toContain("High = all claims verified by receipts");
    expect(composed).toContain("Do NOT end a reply with a question unless you are genuinely blocked");
    // D4 — sub-agent discipline (plan mode HAS delegate_task).
    expect(composed).toContain("delivers only its scope");
    expect(composed).toContain("do NOT sleep, wait, or poll for a sub-agent");
    // The plan vocabulary is honest: no terminal/file-mutation tools advertised.
    expect(composed).not.toContain("**Verify after edit**");
    expect(composed).not.toContain("**Dirty worktree discipline**");
  });
});

// ── D6: the size budget ──────────────────────────────────────────────────────

describe("D6: the size budget (the hard bound + the section window)", () => {
  it("the DEFAULT full-tools composition stays ≤ 24,000 chars", () => {
    // The bound guards the BUILT-IN system prompt — the composition a
    // real session composes before any project-injected dynamic content
    // (custom rules have their own 32K cap; the memory digest, index
    // summary, and skills list are budgeted separately). R70 baseline:
    // 14,757 chars; R71-e1: 18,220; R94-G: ~20.0K; R96-D: ~21.1K.
    // ROUND-96 (R96-D): 22,000 → 23,000 — the owner-directed discipline
    // trio added ~1.9K of mandated content; the sections were TRIMMED to
    // their load-bearing lines and the bound moved to hold the owner's
    // explicit asks rather than degrading them under an arbitrary number.
    // ROUND-99 (R99-G): 23,000 → 24,000 — the SAME precedent, one more
    // turn. The system-prompt overhaul adds ~3.8K of owner-mandated
    // content (precedence header, autonomy ladder, INTAKE phase, the
    // tool-descriptions block, the subagent report contract, the
    // confidence because/raising-it line) and pays for it with the
    // deepest dedup yet (~2.3K retired: precision-discipline merged into
    // completion-discipline, the third copies of the read-error and
    // verify doctrines retired, batch/tool-use/terminal/file-editing/
    // code-navigation/web-access trims — every phrase the rounds' pins
    // assert survived). Pre-trim the additions would have landed ~26.9K;
    // the measured result is 23,975 — the cap still guards against
    // unbounded growth (the budget discipline itself is R71's point) and
    // the floor below keeps the additions honest content, not a gutting.
    const composed = buildProjectSystemPrompt(ctxFor());
    expect(composed.length).toBeLessThanOrEqual(24_000);
    expect(composed.length).toBeGreaterThan(15_000); // the R71 delta is real content, not a gutting
  });

  it("the discipline section itself stays in its designed 1.8–2.6K window", () => {
    const section = buildSectionText(ctxFor(), "engineering-discipline") ?? "";
    expect(section.length).toBeGreaterThanOrEqual(1_800);
    expect(section.length).toBeLessThanOrEqual(2_600);
  });
});
