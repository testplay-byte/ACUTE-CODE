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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { buildProjectSystemPrompt, buildSectionText, buildTaggedPromptLines } from "../src/agents/prompts";
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
  // ROUND-117 (R117-c, A6 — the fresh-golden re-pin): the toolNames list
  // now tracks the LIVE vocabulary ([...TOOL_NAMES, "mcp__demo__echo"]) —
  // the R73-era freeze (an R61-era tool set that silently missed
  // search_symbols/ask_user/session_recall/switch_mode/search_skills) was
  // the audit's "golden frozen at an R61-era tool set" finding. The new
  // fixtures/prompt-golden-r117.txt is regenerated against THIS list; the
  // R61-era fixtures/prompt-golden-r61.txt stays in fixtures/ as history
  // (pinned below — never consumed as a live byte-identity anchor again).
  toolNames: [...TOOL_NAMES, "mcp__demo__echo"],
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
    // ROUND-99 (R99-G): the PRECEDENCE header slots in DIRECTLY AFTER
    // identity — before any other guidance can conflict with anything, the
    // model already knows how conflicts resolve (the ladder, rules vs.
    // judgment, limits-are-not-targets).
    expect(PROMPT_SECTION_IDS.indexOf("precedence")).toBe(PROMPT_SECTION_IDS.indexOf("identity") + 1);
    expect(PROMPT_SECTION_IDS.indexOf("tool-use")).toBe(PROMPT_SECTION_IDS.indexOf("precedence") + 1);
    // ROUND-99 (R99-G): the AUTONOMY LADDER slots in DIRECTLY AFTER the
    // permission-mode narration it qualifies (mode = ceiling, ladder = the
    // graduated rule under it). Unconditional — it composes even when the
    // mode section does not (ask-mode sessions still need the ladder).
    expect(PROMPT_SECTION_IDS.indexOf("autonomy")).toBe(PROMPT_SECTION_IDS.indexOf("permission-mode") + 1);
    expect(PROMPT_SECTION_IDS.indexOf("sub-agents")).toBe(PROMPT_SECTION_IDS.indexOf("autonomy") + 1);
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

  it("ROUND-99 (R99-G): precision-discipline is RETIRED — merged into completion-discipline; a stale override file is diagnosed, never honored", () => {
    // The R66-2-c/R70-c removal-cascade precedent: registry entry +
    // composition block + golden + pins all moved together. The merged
    // section's content pins live in the ROUND-99 describe below; the
    // r96 suite re-pins its PRECISION content pins against the merged
    // section.
    expect(PROMPT_SECTION_IDS).not.toContain("precision-discipline");
    // code-navigation now directly precedes git (the precision section that
    // sat between them is gone).
    expect(PROMPT_SECTION_IDS.indexOf("git")).toBe(PROMPT_SECTION_IDS.indexOf("code-navigation") + 1);
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
    //
    // Regenerated AGAIN in R99-G (deliberately — the system-prompt overhaul
    // round for the owner's flaw list: "Length dilutes attention", "Heavy
    // duplication, no precedence rules", "Hard numbers become targets",
    // "no risk threshold for autonomy", "no guidance on where to use memory
    // save and memory recall", "some tools… only appear in the name list,
    // never described", "no output contract for subagents", "no confidence
    // tags", and the analyze-the-request-FIRST meta-directive). The verified
    // diff (git diff of the fixture, read before regenerating — never blind):
    // (1) the new ## PRECEDENCE section after the identity lines; (2) the new
    // ## AUTONOMY LADDER after ## OPERATING MODE; (3) the loop's new
    // "0. INTAKE" phase ahead of "1. PLAN" (which lost its clarify clause to
    // INTAKE); (4) TOOL USE gains the core-vocabulary descriptions block
    // after the rules (presence-filtered — the golden's frozen vocab lists
    // 20 lines, no search_symbols/ask_user); (5) SUB-AGENTS gains the REPORT
    // CONTRACT line (trims: the PARALLELISM example, AFTER DELEGATION, the
    // SUPERVISION/GOOD-BAD tightening); (6) BATCH DISCIPLINE's first two
    // bullets merged; (7) COMPLETION DISCIPLINE absorbs the PRECISION lines
    // (the standalone ## PRECISION DISCIPLINE section is GONE — its
    // AFTER-EDITING-VERIFY line was the fourth copy of the verify doctrine);
    // (8) COMMUNICATION's confidence-tag line gains the because/raising-it
    // contract; (9) Project memory's single save-discipline line became the
    // SAVE/RECALL/NEVER WHEN block; (10) the dedup trims across
    // file-editing/code-navigation/web-access/terminal/engineering and the
    // numbers-audit softenings ("1–3 sentence summary" → "a few sentences at
    // most"; "2-3 lines of context" → "the least context that makes the
    // match unique"). Golden delta: 29,582 → 30,847 bytes (29,276 →
    // 30,519 composed chars) — the additions (~+3.6K) outweigh the dedup
    // (~-2.4K) in the MAXIMAL kitchen-sink ctx because it composes the
    // descriptions block at full width + the memory WHEN block; the DEFAULT
    // full-tools budget (r71 D6) tells the honest net story: 22,962 →
    // 23,975 chars.
    // Regenerated AGAIN in R113-f (deliberately — the prompt-discipline
    // round from the owner's OMP-research directive; see prompts.ts's
    // ROUND-113 header for the full rationale). The verified diff (git diff
    // of the fixture, read before regenerating — never blind) was EXACTLY
    // five hunks, +5/−7 lines: (1) TOOL USE gains the ARGUMENTS COME FROM
    // OBSERVED DATA rule after MOST SPECIFIC (the R67 guessed-path / R94
    // stale-app_ref class); (2) CODE NAVIGATION loses the list_dir line
    // (the weakest survivor of every dedup audit); (3) GIT's three "Use
    // git_X to…" lines merge into one sequencing line ("Only commit when
    // asked" verbatim); (4) TERMINAL gains the benign-exit rule (grep /
    // test / diff exit 1 on no-match — the Claude-Code research §2.5
    // discipline) and loses "Prefer project-specific commands" (FILE
    // EDITING rule 8 owns discovery); (5) WEB ACCESS's search-first line
    // compresses and MCP's "don't retry in a loop" tail retires (RECOVERY
    // owns retry doctrine). NOTHING else moved. Default-composition delta:
    // 23,765 → 23,871 chars — the 24,000 budget holds without a bump; the
    // skills-surface twin (the read_skill envelope) changes no prompt bytes.
    //
    // Re-pinned in R117-c (deliberately — the prompt-engineering pass; see
    // prompts.ts's ROUND-117 header) as a NEW fixture —
    // fixtures/prompt-golden-r117.txt — against the LIVE tool vocabulary
    // (the R61-era list above became [...TOOL_NAMES, "mcp__demo__echo"]).
    // The verified diff (git diff, read before regenerating — never blind)
    // covers: the round-tag strip (every "(R\d+)"/"(round-N)" tag left the
    // model-facing text), the caps calibration (bullet labels → bold
    // sentence-case; mid-sentence shouts → plain; NEVER/ALWAYS/STOP + the
    // formal vocabularies stay), the "## BUDGETS" line replacing the loop's
    // budget bullet, FILE EDITING RULES renumbered 1-7 (rule 8 → 7), the
    // confidence-line if/else split, the <project_memory> fences around
    // both scopes' digests (+ the honest empty-state lines inside them),
    // the ALWAYS-ON preamble's audience-mixed tail retired, the live-vocab
    // TOOL USE descriptions block (search_symbols/ask_user/session_recall/
    // search_skills lines now compose), and the ask_user INTAKE variant.
    // The old fixtures/prompt-golden-r61.txt stays as HISTORY — pinned
    // below as present-on-disk, never byte-compared again.
    //
    // Re-pinned in R127-W6 (the agent-smarter round) as a NEW fixture —
    // fixtures/prompt-golden-r127.txt — per the SAME R117-c fork precedent
    // (the r117 file becomes history below). The verified diff (git diff of
    // the fixture, read before regenerating — never blind) is EXACTLY three
    // hunks, +3/−3 lines: (1) the AGENTIC LOOP's EXPLORE phase gains the
    // N-files arithmetic ("a file-reading task over N files is N read_file
    // calls in ONE message, never N messages of one call each") + the
    // dependent-set conditions rule ("When later calls DEPEND on earlier
    // results (a path you learn from a list_dir, an anchor you learn from a
    // read), WAIT — batch the independent prefix, then batch the dependent
    // set once the dependency lands"); (2) BATCH DISCIPLINE's first bullet
    // swaps its "three files" example for the same N-files arithmetic and
    // extends the wait clause with the prefix/dependent-set shape; (3) the
    // TOOL USE descriptions block's read_file line gains the ~128KB
    // whole-file clause. NOTHING else moved.
    const golden = readFileSync(join(import.meta.dirname, "fixtures", "prompt-golden-r127.txt"), "utf8").replace(/\r\n/g, "\n");
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
    writeFileSync(join(import.meta.dirname, "fixtures", "prompt-golden-r127.txt"), buildProjectSystemPrompt(FULL_CTX));
  });

  it("R127-W6: the R117-era golden stays in fixtures/ as HISTORY — superseded by prompt-golden-r127.txt, never byte-compared again", () => {
    // The R117-c fork precedent, one era later: the r117 fixture is the
    // record of what the prompt WAS before the R127-W6 agent-smarter
    // additions; the r127 fixture is the live byte-identity anchor. The
    // old file is pinned present-on-disk so it cannot be silently deleted.
    expect(existsSync(join(import.meta.dirname, "fixtures", "prompt-golden-r117.txt"))).toBe(true);
    const history = readFileSync(join(import.meta.dirname, "fixtures", "prompt-golden-r117.txt"), "utf8").replace(/\r\n/g, "\n");
    // It is the pre-R127 composition: its BATCH DISCIPLINE bullet still
    // carries the "three files" example the R127 arithmetic replaced, and
    // its EXPLORE phase has no N-files clause — the markers that prove it
    // is history, not live.
    expect(history).toContain("three files to read means three read_file calls in one message");
    expect(history).not.toContain("never N messages of one call each");
    expect(history).not.toContain("returns whole files under ~128KB in one call");
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
    expect(rest).toContain("this chat session's own tab");
    expect(rest).toContain("get_state lists only this session's tab");
    expect(rest).toContain("Drive the panel only with browser_control");
    expect(rest).toContain("never computer-use tools (left_click, scroll, type, mouse_move, screenshot)");
    expect(rest).toContain('never show "agent is using your computer"');
    // The (b) workflow: read_dom → the returned selector paths → click/type.
    expect(rest).toContain("read_dom first, then click / type the selector paths it returns");
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
    expect(rest).toContain("Tab-walk discovery");
    expect(rest).toContain('press key "tab"');
    expect(rest).toContain("names the focused element");
  });

  it("the tool-use rules teach the image-attachment path contract — analyze_image-gated", () => {
    const composed = buildProjectSystemPrompt(FULL_CTX);
    const tu = composed.indexOf("## TOOL USE");
    expect(tu).toBeGreaterThan(-1);
    const rest = composed.slice(tu, tu + 3_000);
    expect(rest).toContain("Image attachments");
    expect(rest).toContain('"saved in the project at <path>"');
    expect(rest).toContain('analyze_image with path "<path>"');
    // The gate: an allowlist without analyze_image never sees the rule.
    const noVision = buildProjectSystemPrompt({
      ...FULL_CTX,
      toolNames: FULL_CTX.toolNames.filter((n) => n !== "analyze_image"),
    });
    expect(noVision).not.toContain("Image attachments");
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
    expect(rest).toContain("Browser content is searchable");
    expect(rest).toContain("find_elements {appRef, query:'Wikipedia'}");
    expect(rest).toContain("the web tree is activated automatically before every walk");
    expect(rest).toContain("element targets are the primary path for browser content");
    // R70-c: middle_click guidance moved to the skill body — retired here.
    // The R68 zoom-crop verification teaching is RETIRED by R69's receipts.
    expect(rest).not.toContain("Chain discipline (R68)");
    expect(rest).not.toContain("a small zoom region crop of the one control");
  });

  it("the auto-activation teaching replaces the manual activate-then-retry dance", () => {
    const composed = buildProjectSystemPrompt(FULL_CTX);
    const cu = composed.indexOf("## COMPUTER USE (desktop control)");
    const rest = composed.slice(cu, cu + 4_200);
    expect(rest).toContain("activate their target app automatically");
    expect(rest).toContain("a mismatch refusal means the activation itself failed");
    expect(rest).toContain("frontmost_pid_mismatch → the auto-activation failed");
    // The old manual-recovery parenthetical is retired.
    expect(rest).not.toContain("frontmost_pid_mismatch → activate → re-observe");
  });

  it("the lines are computer-use-gated (the section composes only when the master switch is on)", () => {
    const off = buildProjectSystemPrompt({ ...FULL_CTX, computerUse: { enabled: false, posture: "act" as const } });
    expect(off).not.toContain("## COMPUTER USE (desktop control)");
    expect(off).not.toContain("Chain discipline");
    expect(off).not.toContain("Browser content is searchable");
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
    expect(rest).toContain("Chain discipline");
    expect(rest).toContain("every action receipt carries an observation");
    expect(rest).toContain("Do not screenshot or zoom after acting");
    expect(rest).toContain("read the receipt's observation instead");
  });

  it("unchanged → the action may not have registered → check focus, adjust, element-first", () => {
    const composed = buildProjectSystemPrompt(FULL_CTX);
    const cu = composed.indexOf("## COMPUTER USE (desktop control)");
    const rest = composed.slice(cu, cu + 4_600);
    expect(rest).toContain("screen is unchanged");
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

// ── ROUND-99 (R99-G): the system-prompt overhaul pins ───────────────────────
// The owner's flaw list, one describe per fix: precedence rules, the intake
// phase, the autonomy ladder, memory-tool guidance, tool descriptions, the
// subagent output contract, confidence tags, and the precision→completion
// merge that paid for it all.

describe("ROUND-99 (R99-G): PRECEDENCE + AUTONOMY — the two new identity sections", () => {
  it("precedence: the conflict ladder, rules-vs-judgment, limits-are-not-targets, scoped length", () => {
    const section = buildSectionText(FULL_CTX, "precedence") ?? "";
    expect(section).toContain("## PRECEDENCE");
    expect(section).toContain("SAFETY > TRUTH > THE USER'S CURRENT REQUEST > EFFICIENCY");
    expect(section).toContain("Never optimize speed or token cost by lying or guessing");
    expect(section).toContain("Lines marked as rules (NEVER/ALWAYS/maximums) are hard; everything else is judgment");
    expect(section).toContain("When a hard number appears as a LIMIT it is a maximum, never a target to fill");
    expect(section).toContain("the more specific one governs");
    expect(section).toContain("only the enabled surfaces' sections ride your context");
    // Static + unconditional: even a bare ctx resolves conflicts by the ladder.
    const bare = buildProjectSystemPrompt({ projectName: "Bare", rootPath: "/tmp/none", toolNames: ["read_file"] });
    expect(bare).toContain("## PRECEDENCE");
    // It sits BEFORE every other ## heading (identity carries none).
    const composed = buildProjectSystemPrompt(FULL_CTX);
    expect(composed.indexOf("## PRECEDENCE")).toBeLessThan(composed.indexOf("## TOOL USE"));
  });

  it("autonomy: the three tiers under the permission mode's ceiling — static + unconditional", () => {
    const section = buildSectionText(FULL_CTX, "autonomy") ?? "";
    expect(section).toContain("## AUTONOMY LADDER");
    expect(section).toContain("the permission MODE sets the ceiling; this ladder fills the space it leaves");
    expect(section).toContain("ACT WITHOUT ASKING (reversible, in-scope)");
    expect(section).toContain("reading files, searching, running read-only commands, creating/editing files inside the task's scope (git tracks them), writing todos");
    expect(section).toContain("ASK FIRST (consequential or ambiguous)");
    expect(section).toContain("git push/force-push/branch deletion, dependency installs, schema migrations, changes outside the stated scope");
    expect(section).toContain("NEVER (refuse + explain)");
    expect(section).toContain("exfiltrating secrets or credentials, disabling safety gates, destructive commands with no undo (rm -rf on user paths), actions that hide their own history");
    // Composes with NO permission mode too (ask-mode sessions keep the ladder).
    const noMode = buildProjectSystemPrompt({ projectName: "Bare", rootPath: "/tmp/none", toolNames: ["read_file"] });
    expect(noMode).toContain("## AUTONOMY LADDER");
    // And directly AFTER the OPERATING MODE narration when one composes.
    const composed = buildProjectSystemPrompt(FULL_CTX); // permissionMode: "plan"
    expect(composed.indexOf("## AUTONOMY LADDER")).toBeGreaterThan(composed.indexOf("## OPERATING MODE"));
    expect(composed.indexOf("## SUB-AGENTS (delegate_task)")).toBeGreaterThan(composed.indexOf("## AUTONOMY LADDER"));
  });
});

describe("ROUND-99 (R99-G): the loop's PHASE 0 — REQUEST INTAKE", () => {
  it("INTAKE opens the loop: restate, knowns vs. unknowns, skills check, out-of-scope, then plan", () => {
    const loop = buildSectionText(FULL_CTX, "agentic-loop") ?? "";
    expect(loop).toContain("0. INTAKE");
    expect(loop.indexOf("0. INTAKE")).toBeLessThan(loop.indexOf("1. PLAN"));
    expect(loop).toContain("(a) restate the goal in one line");
    expect(loop).toContain("(b) list what you already know vs. what you must find out");
    expect(loop).toContain("never a silent guess");
    expect(loop).toContain("check the SKILLS index (when one exists) — a matching skill is read before planning");
    expect(loop).toContain("(d) name what is out of scope — what you will not touch");
    expect(loop).toContain("(e) only then write the plan");
    // The five phase numbers survive untouched (the existing pins' anchor).
    for (const phase of ["1. PLAN", "2. EXPLORE", "3. ACT", "4. VERIFY", "5. FINISH"]) {
      expect(loop).toContain(phase);
    }
  });

  it("the ask_user variant moves the clarify clause INTO INTAKE (both vocabularies pinned)", () => {
    // R117-c: FULL_CTX now tracks the LIVE vocabulary (ask_user present) →
    // the tool form; the prose fallback is pinned on an ask_user-less ctx.
    const withAsk = buildSectionText(FULL_CTX, "agentic-loop") ?? "";
    expect(withAsk).toContain("gets ask_user early (batched questions, options where enumerable) or an explicit stated assumption");
    const bare = buildSectionText(
      { ...FULL_CTX, toolNames: FULL_CTX.toolNames.filter((n) => n !== "ask_user") },
      "agentic-loop",
    ) ?? "";
    expect(bare).toContain("missing context gets a clarifying question or an explicit assumption");
    // PLAN itself no longer carries the clarify clause in EITHER variant —
    // INTAKE owns it (one home for the clarify-early doctrine).
    expect(bare).not.toContain("ask ONE clarifying question");
    expect(withAsk).toContain("1. PLAN — tasks with 3+ steps get a todo_write list up front");
  });
});

describe("ROUND-99 (R99-G): the TOOL USE core-vocabulary descriptions block", () => {
  it("describes the core tools honestly — subordinated to the live list + schemas", () => {
    const section = buildSectionText(MODES_CTX, "tool-use") ?? "";
    expect(section).toContain("What the core tools DO");
    expect(section).toContain("stay authoritative for which exist");
    // The mandated core vocabulary (MODES_CTX carries the live TOOL_NAMES).
    for (const line of [
      "- read_file:",
      "- write_file:",
      "- edit_file:",
      "- search_files:",
      "- search_code:",
      "- search_symbols:",
      "- list_dir:",
      "- run_command:",
      "- git_status / git_diff / git_log:",
      "- todo_write:",
      "- web_fetch:",
      "- web_search:",
      "- delegate_task:",
      "- memory_save:",
      "- memory_recall:",
      "- read_skill:",
      "- ask_user:",
      "- browser_control:",
      "- job_status / job_stop:",
      "- analyze_image:",
    ]) {
      expect(section).toContain(line);
    }
    // The block stays a BLOCK, not a paragraph — scannable one-liners.
    expect((section.match(/^- [a-z_]/gm) ?? []).length).toBeGreaterThanOrEqual(20);
  });

  it("presence-filtered: a stripped vocabulary never describes absent tools", () => {
    const stripped = buildSectionText(
      { ...FULL_CTX, toolNames: ["read_file", "search_code", "run_command"] },
      "tool-use",
    ) ?? "";
    expect(stripped).toContain("- read_file:");
    expect(stripped).toContain("- search_code:");
    expect(stripped).toContain("- run_command:");
    expect(stripped).not.toContain("- write_file:");
    expect(stripped).not.toContain("- browser_control:");
    expect(stripped).not.toContain("- delegate_task:");
  });
});

describe("ROUND-99 (R99-G): the subagent REPORT CONTRACT + confidence tags + memory WHEN", () => {
  it("every delegated task ends with the five-field report — \"none\", never silence", () => {
    const sub = buildSectionText(FULL_CTX, "sub-agents") ?? "";
    expect(sub).toContain("Report contract");
    expect(sub).toContain("RESULT (done/blocked/failed, one line)");
    expect(sub).toContain("FILES TOUCHED (paths + what changed)");
    expect(sub).toContain("FINDINGS (facts the parent needs)");
    expect(sub).toContain("OPEN QUESTIONS (for the parent/user)");
    expect(sub).toContain("CONFIDENCE (high/medium/low + what raises it)");
    expect(sub).toContain('A sub-agent that cannot fill a field writes "none" — never silence');
  });

  it("COMMUNICATION: the confidence line earns its keep — because + raising-it + no-line-when-verified (R107-a F6: ONE vocabulary, the textual form)", () => {
    const comm = buildSectionText(FULL_CTX, "communication") ?? "";
    expect(comm).toContain("Confidence: high|medium|low — because <the specific reason>; raising it needs <the concrete next step>");
    // R117-c (A9): the contract's two rules are now explicit if/else lines —
    // the WHEN rule no longer hides inside the shape rule's tail.
    expect(comm).toContain("If every claim is verified by receipts, no confidence line is needed; if any claim rests on inference or is unverified, the line is required.");
    // The levels' definitions folded into the line (the emoji set retired —
    // a second vocabulary in one line, and the glyphs landed raw on the
    // CLI/phone channels).
    expect(comm).toContain("High = all claims verified by receipts");
    expect(comm).toContain("medium = partially verified, some claims rest on inference");
    expect(comm).toContain("low = unverified");
    expect(comm).not.toContain("🟢"); // the emoji vocabulary is GONE
    expect(comm).toContain("one line of devil's advocate — the strongest counter-argument to what you just did");
    // R107-a (F3): the channel-honesty line (desktop/terminal/phone).
    expect(comm).toContain("structure must survive plain text");
  });

  it("project-memory: the SAVE/RECALL/NEVER WHEN block (memory-tools-gated)", () => {
    const withMemory = buildSectionText(FULL_CTX, "project-memory") ?? "";
    expect(withMemory).toContain("When to use the memory tools");
    expect(withMemory).toContain("- **Save** when you discover something durable the next session needs");
    expect(withMemory).toContain("project conventions, the owner's confirmed preferences, environment gotchas, decisions with their reasons");
    expect(withMemory).toContain("Save at the moment of discovery: batch saves at turn-end get lost");
    expect(withMemory).toContain("- **Recall** at the start of a task whose topic matches a memory — search before re-deriving");
    expect(withMemory).toContain("- NEVER save: secrets or keys, per-session state, raw transcripts, anything the file ledger or git already records");
    // The gate: no memory TOOLS in vocab → the digest narration only.
    const noTools = buildSectionText({ ...FULL_CTX, toolNames: ["read_file"] }, "project-memory") ?? "";
    expect(noTools).toContain("## Project memory (persisted across sessions)");
    expect(noTools).not.toContain("When to use the memory tools");
  });

  it("the merged COMPLETION DISCIPLINE carries the precision lines (the retired section's survivors)", () => {
    const merged = buildSectionText(FULL_CTX, "completion-discipline") ?? "";
    // The R96-D ending contract survives…
    expect(merged).toContain("end with the line: Task complete.");
    expect(merged).toContain("NEVER pad finished work");
    expect(merged).toContain("NEVER restart finished work");
    // …and the R96-D precision lines fold in under their label, with the
    // LANDING/RIGHT aphorism folded into the DONE line.
    expect(merged).toContain("Precision (target before you read):");
    expect(merged).toContain("Target the file first");
    expect(merged).toContain("Read only what the task needs");
    expect(merged).toContain("Edits use exact anchors** from the current content");
    expect(merged).toContain("one character off is a miss");
    expect(merged).toContain('"Change X to Y in file F"');
    expect(merged).toContain("never analyze the whole project (or a whole HTML file) when one file and one string are named");
    expect(merged).toContain("a change landing is not a change being right");
    // The fourth-copy verify line is GONE (its doctrine lives in the loop's
    // VERIFY phase + DONE-means-VERIFIED + file-editing smart verification).
    expect(merged).not.toContain("AFTER EDITING, VERIFY: re-read the changed range");
    // And the standalone section no longer composes anywhere.
    expect(buildProjectSystemPrompt(FULL_CTX)).not.toContain("## PRECISION DISCIPLINE");
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
