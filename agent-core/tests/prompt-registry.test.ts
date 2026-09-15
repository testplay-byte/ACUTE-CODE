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

/** The maximal ctx — every tool, digest, index, mode, rules: ALL sections
 * (every conditional gate open) so the composition pin sees every id. The
 * rootPath is the golden's FIXED path (never exists on disk → no overrides
 * load, and the identity/environment lines match the fixture byte-for-byte).
 * ROUND-70 (R70-c): environment + maxOuterLoops are pinned to FIXED values
 * (the OS-aware TERMINAL branch and the outer-iteration line are part of
 * the golden now); the R61→R68 sections efficiency/task-planning/
 * todo-tracking are GONE (consolidated into agentic-loop). */
const GOLDEN_ROOT = "/tmp/acute-r61-golden-root";
const FULL_CTX = {
  projectName: "GoldenProject",
  rootPath: GOLDEN_ROOT,
  // ROUND-73 (R73-b): the toolNames list is FROZEN to the golden fixture's
  // exact vocabulary (previously [...TOOL_NAMES, "mcp__demo__echo"], which
  // silently tracked TOOL_NAMES — every vocabulary round would have rewritten
  // the golden's TOOL USE line and forced a regeneration; the fixture's md5
  // is the PIN). New tool vocabulary (R73's switch_mode) joins the LIVE turn
  // path and the MODES_CTX completeness ctx below — never this fixture.
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
  } as Parameters<typeof buildProjectSystemPrompt>[0]["indexSummary"],
  memoryDigest: "- [fact] The build is pnpm-based.",
  permissionMode: "plan" as const,
  // ROUND-61 (R61): the new gates — the skills index (progressive
  // disclosure) + the computer-use master switch, both open so the
  // COMPLETENESS pin sees every id.
  skills: [
    { name: "computer-use", description: "Observe and actuate the desktop GUI: accessibility-first element actions with screenshot-coordinate fallback." },
    { name: "demo-skill", description: "A demonstration user skill." },
    // ROUND-98 (R98-E2): the ALWAYS-LOAD tier's golden exercise — one pinned
    // skill (alwaysLoad + body) so the new "## ALWAYS-ON SKILLS" section is
    // BYTE-PINNED by the fixture (the zero-pinned byte-identity is pinned in
    // tests/r98-always-load.test.ts instead: a ctx with no alwaysLoad flags
    // composes byte-identically to the pre-R98 shape).
    {
      name: "demo-pinned",
      description: "A demonstration always-load skill.",
      alwaysLoad: true,
      body: "# Skill: demo-pinned\n\nR98-E2 GOLDEN PINNED BODY — this full body rides every turn because the owner pinned the skill (always_load). Follow it for every task in its domain.",
    },
  ],
  computerUse: { enabled: true, posture: "act" as const },
  // ROUND-94 (R94-G): the CAPABILITIES section's payload — the same
  // sessionHasVisionPath fact the screenshot tools gate on, pinned FALSE
  // here so the golden byte-pins the no-image-understanding line (the
  // vision:true and absent variants are pinned in r94-prompt-recovery).
  hasVisionPath: false,
  // ROUND-65 (R65) → R66: debugMode stays in the ctx (the field is retained
  // for the route-side analyst gate) but composes NOTHING since R66 removed
  // the self-report section — kept here to pin that the golden ctx passes
  // it with zero effect on the composition.
  debugMode: true,
};

/** ROUND-73 (R73-b): the TASK-MODES completeness ctx — FULL_CTX plus every
 * R73 gate opened (taskModes index, modeHints, activeTaskMode, and the
 * clearedModeNote). The BYTE-IDENTITY golden above stays on the bare
 * FULL_CTX (the sections are strictly gated → the fixture's md5 never
 * moves); THIS ctx is what proves the two new registry ids compose, in the
 * registry's exact order. toolNames deliberately tracks the LIVE TOOL_NAMES
 * here (this ctx is never byte-compared) so future vocabulary stays covered
 * by the completeness pin. */
const MODES_CTX = {
  ...FULL_CTX,
  toolNames: [...TOOL_NAMES, "mcp__demo__echo"],
  taskModes: [
    { id: "plan", name: "Plan", description: "Use when the user says 'plan this', 'write a spec' — the deliverable is a decision-ready specification, not code." },
    { id: "debug", name: "Debug", description: "Use when the user says 'fix this bug', 'why does this fail' — the cause is unknown; reproduce before theorizing." },
  ],
  modeHints: [{ modeId: "debug", score: 12 }],
  activeTaskMode: {
    id: "plan",
    name: "Plan",
    body: "# Mode: plan — SPEC-FIRST POSTURE\n\nWhile this mode is active, the deliverable is a DECISION-READY SPECIFICATION.",
  },
  clearedModeNote:
    "task mode 'custom-mode' from a previous turn no longer exists (its .acute/agents file was removed) — active mode cleared",
  // ROUND-79 (R79-a): the background-tasks gate — same completeness pattern
  // as the R73 pair above: opened HERE so the new section's id is covered by
  // the composition pin, while the BYTE-IDENTITY golden stays on the bare
  // FULL_CTX (strict gating → the fixture's md5 never moves).
  backgroundTasks: {
    tasks: [
      {
        taskId: "scan-deps",
        sessionId: "sess_r79golden0001aaaaaaaaaaaaaaaaaaaaa",
        code: "R79G",
        role: "coder",
        status: "running" as const,
        todosDone: 2,
        todosTotal: 5,
        elapsedMinutes: 3,
      },
      {
        taskId: "lint-report",
        sessionId: "sess_r79golden0002aaaaaaaaaaaaaaaaaaaaa",
        code: "R79H",
        role: "reviewer",
        status: "completed" as const,
        todosDone: 4,
        todosTotal: 4,
        elapsedMinutes: 9,
      },
    ],
    more: 0,
  },
  // ROUND-88 (R88): the todo-list gate — same completeness pattern as the
  // R79 background-tasks gate: opened HERE so the CURRENT TODO LIST section's
  // id is covered by the composition pin, while the BYTE-IDENTITY golden
  // stays on the bare FULL_CTX (strict gating → the fixture's md5 never
  // moves).
  todoList: {
    todos: [
      { content: "r88 golden task one", status: "completed" as const },
      { content: "r88 golden task two", status: "in_progress" as const },
      { content: "r88 golden task three", status: "pending" as const },
    ],
    source: "user" as const,
  },
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
    expect(PROMPT_SECTION_IDS).toContain("agentic-loop");
    expect(PROMPT_SECTION_IDS).toContain("project-memory");
    // R71-e1: the discipline section slots in right behind the agentic
    // loop's failure doctrine — R94-G moved that doctrine into its own
    // RECOVERY PROTOCOL section, and ROUND-96 (R96-D) slotted the BATCH +
    // COMPLETION execution doctrines between the loop and it (the loop's
    // how-to-run and how-to-end teachings ride directly behind the loop
    // itself). Discipline still follows recovery (still before
    // file-editing; the R71-d design position).
    expect(PROMPT_SECTION_IDS.indexOf("batch-discipline")).toBe(PROMPT_SECTION_IDS.indexOf("agentic-loop") + 1);
    expect(PROMPT_SECTION_IDS.indexOf("completion-discipline")).toBe(PROMPT_SECTION_IDS.indexOf("batch-discipline") + 1);
    expect(PROMPT_SECTION_IDS.indexOf("recovery")).toBe(PROMPT_SECTION_IDS.indexOf("completion-discipline") + 1);
    expect(PROMPT_SECTION_IDS.indexOf("engineering-discipline")).toBe(PROMPT_SECTION_IDS.indexOf("recovery") + 1);
    expect(PROMPT_SECTION_IDS.indexOf("engineering-discipline")).toBeLessThan(PROMPT_SECTION_IDS.indexOf("file-editing"));
    // R94-G: the CAPABILITIES section (hasVisionPath) sits between the
    // browser-panel section it modifies and COMMUNICATION.
    expect(PROMPT_SECTION_IDS.indexOf("capabilities")).toBe(PROMPT_SECTION_IDS.indexOf("browser-panel") + 1);
    expect(PROMPT_SECTION_IDS.indexOf("capabilities")).toBeLessThan(PROMPT_SECTION_IDS.indexOf("communication"));
    // ROUND-73 (R73-b): the task-modes pair slots in DIRECTLY AFTER skills
    // (the posture tier rides the methodology tier — the modes index is the
    // switch_mode vocabulary, the skills index is the read_skill one, and
    // the two access paths sit adjacent).
    // ROUND-98 (R98-E2, honest re-pin): the ALWAYS-ON SKILLS section slots
    // BETWEEN them — the "deep module follows its index" position the R73
    // pair established (task-modes → active-mode); always-on-skills is the
    // skills index's own deep-module tier (skills → always-on-skills →
    // task-modes → active-mode).
    expect(PROMPT_SECTION_IDS.indexOf("always-on-skills")).toBe(PROMPT_SECTION_IDS.indexOf("skills") + 1);
    expect(PROMPT_SECTION_IDS.indexOf("task-modes")).toBe(PROMPT_SECTION_IDS.indexOf("always-on-skills") + 1);
    expect(PROMPT_SECTION_IDS.indexOf("active-mode")).toBe(PROMPT_SECTION_IDS.indexOf("task-modes") + 1);
    expect(PROMPT_SECTION_IDS.indexOf("active-mode")).toBeLessThan(PROMPT_SECTION_IDS.indexOf("computer-use"));
    // R70-c (D2): the consolidated sections are RETIRED — the removal pin
    // (a stale entry can't linger; .acute/prompts/<id>.md for them is now an
    // unknown-file diagnostic, not an override).
    expect(PROMPT_SECTION_IDS).not.toContain("efficiency");
    expect(PROMPT_SECTION_IDS).not.toContain("task-planning");
    expect(PROMPT_SECTION_IDS).not.toContain("todo-tracking");
  });

  it("ROUND-96 (R96-D): PRECISION DISCIPLINE slots in behind code navigation, before git", () => {
    expect(PROMPT_SECTION_IDS.indexOf("precision-discipline")).toBe(PROMPT_SECTION_IDS.indexOf("code-navigation") + 1);
    expect(PROMPT_SECTION_IDS.indexOf("precision-discipline")).toBeLessThan(PROMPT_SECTION_IDS.indexOf("git"));
  });

  it("COMPLETENESS: the ids stamped by buildTaggedPromptLines are exactly the registry ids, in registry order", () => {
    // ROUND-73 (R73-b): the completeness ctx is MODES_CTX — FULL_CTX with
    // every R73 gate opened, so the two new sections (task-modes,
    // active-mode) compose and the pin covers them like every other
    // conditional section. The bare FULL_CTX (golden ctx) composes NEITHER
    // — the strict gating is the golden's byte-stability proof.
    const stamped: string[] = [];
    for (const entry of buildTaggedPromptLines(MODES_CTX)) {
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
    // Regenerated AGAIN in R70-c (deliberately — the prompt round: env
    // grounding + the four-section consolidation (efficiency/task-planning/
    // todo-tracking REMOVED, agentic-loop rewritten as the five-phase loop),
    // AGENTS.md custom-rules narration, the file-editing/communication
    // upgrades, the browser-panel/computer-use trims + read_skill pointers,
    // and the skills reload line). EVERY dynamic field pinned to FIXED
    // values in FULL_CTX (incl. environment). If this fails after a
    // deliberate prompts.ts change, regenerate deliberately and say so in
    // the round log.
    // Regenerated AGAIN in R71-e1 (deliberately — the discipline round:
    // the ENGINEERING DISCIPLINE section (karpathy mantras + self-tests,
    // [KNOWN]/[ASSUMED]/[UNKNOWN] tagging, 3-strike escalation, red-flags),
    // the PLAN-phase task→verifiable-goal transform, COMMUNICATION's
    // verification receipts + 🟢/🟡/🔴 confidence tags + anti-question rule,
    // and the SUB-AGENTS scope/no-polling lines. Additions-only: no
    // pre-existing line was removed except the two COMMUNICATION lines the
    // receipts/anti-question rules REWROTE ("VERIFICATION evidence (which
    // checks ran + their results)" → "VERIFICATION receipts (the exact
    // command… exit status…)"; the ambiguity line gained the blocked-clause).
    // Golden delta: 20,156 → 23,665 bytes (19,984 → 23,447 chars).
    // Regenerated AGAIN in R81 (deliberately — the unified-mode round: the
    // permission-mode section heading "## PERMISSION MODE" →
    // "## OPERATING MODE" (R81 renamed the section for the one-picker
    // redesign) and the PLAN narration rewritten to the new voice
    // ("read-only tools only — you cannot edit files or run commands.
    // Produce plans and research." → "read-only — you can plan, read files,
    // and research, but you cannot edit the project or run commands.
    // Produce plans, analysis, and research."). Exactly TWO lines changed
    // (the heading + the narration); every other byte is identical.
    // Regenerated AGAIN in R94-G (deliberately — the prompt-overhaul round
    // for the owner's v0.91.0 field report: the RECOVERY PROTOCOL section
    // after the agentic-loop (whose failure rule now points at it), the
    // CAPABILITIES section (FULL_CTX pins hasVisionPath:false so the
    // no-image-understanding line is byte-pinned between browser-panel and
    // communication), the browser-panel R94-F discipline (wait/sequence
    // vocabulary + the NAVIGATION SETTLES rule, paid for by absorbing the
    // fresh-fetch advisory + the viewport-announce line into the intro),
    // and the computer-use R94-E discipline (the WINDOWS line for
    // window_action/windows_overview + the app_ref re-resolution half of
    // the refusals rule, paid for by tightening BIG APPS/tab-walk/intro).
    // Regenerated AGAIN in R96-D (deliberately — the precision/batch/
    // completion round for the owner's v0.93.0 report: the BATCH +
    // COMPLETION DISCIPLINE pair behind the agentic loop, PRECISION
    // DISCIPLINE behind code navigation, the loop's VERIFY phase on-disk
    // + visual-screenshot lines, the FINISH phase's completion-line
    // pointer, and the SKILLS header naming search_skills. Additions-only
    // except the loop's VERIFY/FINISH phase lines (rewritten to the
    // verification doctrine) and the batch-section trims made to keep the
    // D6 budget honest (the r71 D6 bound moved 22K → 23K — see that
    // suite's ROUND-96 note).
    // Regenerated AGAIN in R98-E2 (deliberately — the always-load round for
    // the owner's "there are some skills which it must follow every single
    // time, every single session": FULL_CTX.skills gained ONE pinned entry
    // (demo-pinned, alwaysLoad:true + body — see the ctx above) so the new
    // "## ALWAYS-ON SKILLS" section is byte-pinned end-to-end. The verified
    // diff was EXACTLY: (1) the demo-pinned INDEX line gains the
    // "(ALWAYS-ON — full body in the ALWAYS-ON SKILLS section below)"
    // marker; (2) the new section (header + intro + "### Skill:
    // demo-pinned" + the pinned body) slots between the SKILLS reload line
    // and "## COMPUTER USE". NOTHING else moved — the byte-diff was read
    // before regenerating (git diff of the fixture), never blind. The
    // zero-pinned composition (no alwaysLoad flags anywhere) stays
    // byte-identical to the pre-R98 shape — pinned in
    // tests/r98-always-load.test.ts, not here (this fixture now exercises
    // the pinned case deliberately).
    // Regenerated AGAIN in R98-F2/F3 (deliberately — the edit-efficiency +
    // symbol-search round for the owner's "It should not be the one to read
    // the whole file again… context-optimized and token-optimized" +
    // "Implement grep functionality. Handle it properly. Look into
    // indexing…"). The verified diff (diff -u against the pre-R98-F23 copy,
    // never blind) was EXACTLY three hunks: (1) FILE EDITING RULES rule 1
    // REWRITTEN — the "ALWAYS use read_file before edit_file or write_file"
    // absolutism became the honest tiered rule ("Read before the FIRST
    // edit… the response IS the confirmation: edit the SAME file again
    // directly… Re-read only when a tool result warns the file changed on
    // disk or an edit fails") — the session file-freshness ledger backs the
    // silence; (2) CODE NAVIGATION gained ONE line (search_symbols before
    // search_code when hunting a definition); (3) CODEBASE AWARENESS — the
    // "Call index_project on the FIRST turn" imperative became the
    // auto-index truth line, and the FABRICATED "search_code… queries both
    // the live tree AND the index" claim (search_code never touched the
    // index) became the honest split: search_code = live-tree contents,
    // search_symbols = the index query leg. NOTHING else moved.
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

  it("REGEN PROCEDURE: UPDATE_GOLDEN=1 rewrites the fixture from FULL_CTX (the sanctioned regeneration)", () => {
    // The documented procedure for a DELIBRATE prompts.ts change: run
    //   UPDATE_GOLDEN=1 npx vitest run agent-core/tests/prompt-registry.test.ts
    // from the repo root — this test rewrites the fixture byte-exactly from
    // the composed FULL_CTX (every dynamic field pinned in the file above),
    // then the BYTE-IDENTITY pin above holds the new composition. Without
    // the env var this is a no-op (normal runs never touch the fixture).
    if (process.env.UPDATE_GOLDEN !== "1") return;
    writeFileSync(join(import.meta.dirname, "fixtures", "prompt-golden-r61.txt"), buildProjectSystemPrompt(FULL_CTX));
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
    // R70-c: the section was TRIMMED (deep craft → the browser-use skill);
    // the R67 per-session-tab + bridge teaching survives, folded into the
    // intro line + the DRIVE line.
    const rest = composed.slice(bp, bp + 5_000);
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
    // R70-c: the deep craft moved to the skill body — the pointer is the
    // section's closing line, and the old craft lines are retired.
    expect(rest).toContain('Full browser craft (the core loop, forms, wait patterns, layout testing): read_skill "browser-use"');
    expect(rest).not.toContain("TEST LAYOUTS by changing the display size");
    expect(rest).not.toContain("USE THE BROWSER LIKE A USER WOULD");
  });

  it("the computer-use section teaches the TAB-WALK discovery fallback (key \"tab\" + the receipt's focused readback)", () => {
    const composed = buildProjectSystemPrompt(FULL_CTX);
    const cu = composed.indexOf("## COMPUTER USE (desktop control)");
    expect(cu).toBeGreaterThan(-1);
    const rest = composed.slice(cu, cu + 3_600);
    expect(rest).toContain("TAB-WALK DISCOVERY (R67)");
    expect(rest).toContain('press key "tab"');
    expect(rest).toContain("names the FOCUSED element");
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

// ── ROUND-68 (R68-C) + ROUND-69 (R69, task 4-c-2): the computer-use anti-screenshot-spam pins ──
// The owner's live 0.67.0 report: "utilizing the screenshot capturing way
// too much… the coordinate-based system is not proper". R68 taught the
// searchable browser tree; R69 (4-c-2) REWRITES the chain discipline around
// the auto-observation receipts — every action receipt carries the
// post-action frame, so the model must READ the receipt instead of
// re-capturing. The old "verify with a small zoom crop AFTER the action"
// teaching is retired (that zoom WAS the spam).

describe("ROUND-68 (R68-C): the computer-use discipline lines", () => {
  it("BROWSER CONTENT IS SEARCHABLE survives the R69 rewrite (the R68 tree teaching is unchanged)", () => {
    const composed = buildProjectSystemPrompt(FULL_CTX);
    const cu = composed.indexOf("## COMPUTER USE (desktop control)");
    expect(cu).toBeGreaterThan(-1);
    const rest = composed.slice(cu, cu + 4_200);
    expect(rest).toContain("BROWSER CONTENT IS SEARCHABLE (R68)");
    expect(rest).toContain("find_elements {appRef, query:'Wikipedia'}");
    expect(rest).toContain("the web tree is activated automatically before every walk");
    expect(rest).toContain("element targets are the PRIMARY path for browser content");
    // R70-c: middle_click guidance moved to the skill body — retired here.
    // The R68 zoom-crop verification teaching is RETIRED by R69's receipts.
    expect(rest).not.toContain("CHAIN DISCIPLINE (R68)");
    expect(rest).not.toContain("a small zoom region crop of the one control");
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
    expect(off).not.toContain("CHAIN DISCIPLINE (R69)");
    expect(off).not.toContain("BROWSER CONTENT IS SEARCHABLE (R68)");
  });
});

// ── ROUND-69 (R69, task 4-c-2): the auto-observation discipline pins ────────
// The owner's #1 field failure: the model re-screenshotting after every
// action. The prompt now teaches the receipt's observation as THE
// post-action read, the unchanged→adjust-strategy move, element-first, and
// wait()'s what-changed receipt.

describe("ROUND-69 (4-c-2): the auto-observation chain discipline", () => {
  it("CHAIN DISCIPLINE (R69): read the receipt's observation — never screenshot/zoom after acting", () => {
    const composed = buildProjectSystemPrompt(FULL_CTX);
    const cu = composed.indexOf("## COMPUTER USE (desktop control)");
    const rest = composed.slice(cu, cu + 4_600);
    expect(rest).toContain("CHAIN DISCIPLINE (R69)");
    expect(rest).toContain("every ACTION receipt carries an observation");
    expect(rest).toContain("Do NOT screenshot or zoom after acting");
    expect(rest).toContain("read the receipt's observation instead");
  });

  it("unchanged → the action may not have registered → check focus, adjust, element-first", () => {
    const composed = buildProjectSystemPrompt(FULL_CTX);
    const cu = composed.indexOf("## COMPUTER USE (desktop control)");
    const rest = composed.slice(cu, cu + 4_600);
    expect(rest).toContain("screen is UNCHANGED");
    expect(rest).toContain("may not have registered");
    expect(rest).toContain("check focusedElementName");
    expect(rest).toContain("Element-first beats coordinate guessing");
  });

  it("wait() after navigation + the screen_unchanged refusal meaning", () => {
    const composed = buildProjectSystemPrompt(FULL_CTX);
    const cu = composed.indexOf("## COMPUTER USE (desktop control)");
    const rest = composed.slice(cu, cu + 4_600);
    expect(rest).toContain("After navigation (Enter, links), call wait()");
    expect(rest).toContain("what changed while you waited");
    expect(rest).toContain("A screen_unchanged refusal means: act or change strategy — do not re-capture");
  });

  it("the receipts-not-promises line points at the observation as the FIRST verification read", () => {
    const composed = buildProjectSystemPrompt(FULL_CTX);
    const cu = composed.indexOf("## COMPUTER USE (desktop control)");
    const rest = composed.slice(cu, cu + 4_600);
    // R70-c: the (screenChanged, …) parenthetical was dropped as duplicate
    // (the CHAIN DISCIPLINE line above lists it) — the semantics pin stays.
    expect(rest).toContain("the receipt's observation is the first verification read");
    expect(rest).toContain("an external oracle (file exists, exit code) is the strong one");
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
    writeFileSync(join(dir, "communication.md"), "\n  ## COMMUNICATION (custom)\nBe terse.\n\n");
    writeFileSync(join(dir, "git.md"), "Speak like a pirate.");

    const result = loadPromptOverrides(root);
    expect(result.overrides.get("communication")).toBe("## COMMUNICATION (custom)\nBe terse.");
    expect(result.overrides.get("git")).toBe("Speak like a pirate.");
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

  it("UNKNOWN filenames are ignored + diagnosed (wrong name, wrong case, missing .md, RETIRED ids)", () => {
    const root = tempRoot();
    const dir = join(root, ".acute", "prompts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Communication.md"), "wrong case"); // ids are case-sensitive slugs
    writeFileSync(join(dir, "not-a-section.md"), "unknown stem");
    writeFileSync(join(dir, "communication.txt"), "wrong extension");
    writeFileSync(join(dir, "readme.md"), "notes");
    // R70-c: the retired ids are unknown files now — a stale override for
    // the consolidated sections is DIAGNOSED, never silently honored.
    writeFileSync(join(dir, "efficiency.md"), "retired id");

    const result = loadPromptOverrides(root);
    expect(result.overrides.size).toBe(0); // nothing honored
    const unknowns = result.diagnostics.filter((d) => d.kind === "unknown-file");
    expect(unknowns.map((d) => d.file).sort()).toEqual(["Communication.md", "communication.txt", "efficiency.md", "not-a-section.md", "readme.md"]);
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
    mkdirSync(join(dir, "communication.md"), { recursive: true }); // a dir, not a file
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
    writeFileSync(join(dir, "communication.md"), "#".repeat(PROMPT_OVERRIDE_CHAR_CAP + 10));
    writeFileSync(join(dir, "_order.txt"), "communication\nbogus-id\n");
    const lines = promptOverrideDiagnostics(loadPromptOverrides(root));
    expect(lines.length).toBe(4); // unknown-file, capped, order-unknown-id, order-active
    for (const line of lines) expect(line.startsWith(".acute/prompts/")).toBe(true);
    expect(lines.some((l) => l.includes("ignored — filename must match a registry section id"))).toBe(true);
    expect(lines.some((l) => l.includes("capped at 8000 chars"))).toBe(true);
    expect(lines.some((l) => l.includes('unknown section id "bogus-id" ignored'))).toBe(true);
    expect(lines.some((l) => l.includes("order file active"))).toBe(true);
  });
});
