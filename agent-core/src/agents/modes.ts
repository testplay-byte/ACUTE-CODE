/**
 * ROUND-73 (R73-a): TASK MODES — the POSTURE tier of the owner's directive:
 * "proper detailed system prompts which the agent accesses when required
 * and on the basis of the task".
 *
 * THE DIVISION OF LABOR (the R72/R73 architecture, two tiers over one
 * trigger surface):
 *   · SKILLS (R61/R70/R71/R72) are METHODOLOGY — HOW a class of work is
 *     executed (the debugging loop, the review checklist), advertised as
 *     name + description and loaded on demand via read_skill (progressive
 *     disclosure — the body never rides the system prompt uninvited).
 *   · MODES are POSTURE — how the agent HOLDS ITSELF for a class of task:
 *     what it refuses to do first (edit, theorize, widen, praise), what it
 *     must produce before anything else (a spec, a reproduction, a safety
 *     net, a map), and what "done" means in that stance. A mode body is a
 *     DETAILED system-prompt module (1.5-2.6KB, the same depth as a skill
 *     body but about behavior, not method) injected into the per-turn
 *     system prompt while the mode is ACTIVE (R73-b composes it; until
 *     then this module is the pure core).
 * The pairing is deliberate: every builtin body ends with a PAIRS WITH
 * line steering toward the skills that carry its methodology — posture
 * chooses the stance, skills carry the craft.
 *
 * THE THREE ACCESS PATHS being built over this core (R73-b/R73-c waves):
 *   1. AGENT-SIDE — the switch_mode tool: the model itself changes posture
 *      when the task changes shape (spec approved → build; defect found
 *      mid-build → debug).
 *   2. USER-SIDE — the composer's mode picker (+ /mode slash), the
 *      ModeSwitcher sibling pattern.
 *   3. ADVISORY — the task-hints matcher (R72-a computeTaskHints) scoring
 *      mode DESCRIPTIONS exactly like skill descriptions: the same
 *      trigger-rich "Use when 'quoted phrasing' … NOT for …" convention
 *      (R71/R72, storage/skills.ts) is why these descriptions carry
 *      verbatim user phrasings in quotes.
 *
 * CUSTOM MODES: `.acute/agents/*.md` in the project root (the
 * kilocode/claude custom-modes pattern) — `---` frontmatter
 * (name/description/tools, parsed by the SAME tolerant parser as file
 * skills: storage/skills-files.ts parseSkillFrontmatter) + a body that
 * becomes the active mode's prompt module. A custom mode whose id equals
 * a builtin id SHADOWS the builtin (the user's override lever — one
 * entry, custom wins). TRUST: files under `.acute/agents/` live in the
 * project root — the SAME trust level as `.acute/prompts/` overrides and
 * `.acuterules` (prompt-registry.ts's own words: they do NOT bypass the
 * bearer wall or tool allowlists). The `tools` frontmatter is stored RAW
 * — syntactic slug-shape validation only here; semantic validation
 * against the real tool registry is the integration wave's job.
 *
 * CONTRACT (mirroring prompt-registry.ts / skills-files.ts): PURE +
 * SYNCHRONOUS + fs-scoped — no db, no server, no async, NEVER throws.
 * Every failure is an honest CustomModeDiagnostic (rendered by
 * renderModeDiagnostics), and every cap truncates VISIBLY:
 *   · body ≤ 16,000 chars (CUSTOM_MODE_BODY_CAP) — marker line appended;
 *   · description ≤ 500 chars (CUSTOM_MODE_DESC_CAP) — marker appended;
 *   · name ≤ 64 chars (bounded display field, truncated);
 *   · ≤ 8 custom modes per project (CUSTOM_MODES_CAP) — the 9th+ .md
 *     files are skipped + diagnosed (the first 8 by file-name order win);
 *   · files > 512KB skipped (bounds the read; the body cap is 16K
 *     anyway — the skills-files FILE_SIZE_HARD_CAP pattern);
 *   · an EMPTY body is skipped ("empty-body"): a mode with no
 *     instructions is noise, not a mode;
 *   · a missing description still LOADS with an honest fallback line +
 *     "missing-description" diagnostic (task hints cannot match what has
 *     no text — the user must know).
 * Determinism: file-name byte order fixes custom sortOrder (100+ by
 * load position); the result sorts sortOrder asc then name asc; calling
 * resolveEffectiveModes twice yields structurally equal results. A
 * vanished/unreadable/broken file never breaks resolution — one broken
 * mode never breaks a turn.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseSkillFrontmatter, stripSkillFrontmatter } from "../storage/skills-files.js";

/* ── the mode record ───────────────────────────────────────────────────────── */

/**
 * One task mode. `description` is the MATCHER-facing one-liner (the R71
 * trigger-rich convention — quoted verbatim phrasings, "NOT for" negative
 * scope); `body` is the detailed system-prompt module injected while the
 * mode is active. Builtins are frozen at module load; file modes are
 * rebuilt per resolution.
 */
export interface TaskMode {
  /** Slug the tools/picker address: 'debug'. */
  id: string;
  /** Display name: 'Debug'. */
  name: string;
  /** Trigger-rich one-liner (matcher input, same convention as skills). */
  description: string;
  /** The detailed system-prompt module injected while this mode is active. */
  body: string;
  source: "builtin" | "file";
  /** File modes only — absolute path of the .md (bodies live on disk). */
  filePath?: string;
  /**
   * File modes only — the frontmatter `tools` list, stored RAW (trimmed,
   * deduped, slug-shaped; semantic validation against the real tool
   * registry happens in the integration wave, not here).
   */
  tools?: string[];
  /** Builtins 10..60; customs 100+ by sorted file position. */
  sortOrder: number;
}

/* ── diagnostics (the prompt-registry promptOverrideDiagnostics pattern) ────── */

/**
 * One structured diagnostic from loading `.acute/agents/*.md` (rendered
 * by renderModeDiagnostics for logs and future UI). A diagnostic never
 * blocks the builtin modes — "no news" means "everything loaded clean".
 */
export interface CustomModeDiagnostic {
  kind:
    | "unreadable" // stat/read failed (vanished, perms, too large)
    | "not-a-file" // a directory or other non-regular entry in the modes dir
    | "capped" // body exceeded CUSTOM_MODE_BODY_CAP (marker appended)
    | "description-capped" // description exceeded the cap (marker appended)
    | "missing-description" // no frontmatter description — honest fallback used
    | "invalid-tools" // frontmatter tool entries were not slug-shaped — dropped
    | "empty-body" // nothing after the frontmatter — file skipped
    | "too-many-modes"; // past CUSTOM_MODES_CAP — file skipped
  /** The entry's base name inside .acute/agents/ (not the absolute path). */
  file: string;
  detail?: string;
}

/* ── caps + constants (all exported for the R73-b integration wave) ─────────── */

/** Max custom modes per project — the 9th+ .md files are skipped + diagnosed. */
export const CUSTOM_MODES_CAP = 8;
/** Max body chars of a custom mode — truncated with an honest marker line. */
export const CUSTOM_MODE_BODY_CAP = 16_000;
/** Max description chars of a custom mode — truncated with an honest marker. */
export const CUSTOM_MODE_DESC_CAP = 500;

/** The custom-modes directory, relative to the project root. */
const CUSTOM_MODES_DIR = [".acute", "agents"] as const;
/** Display form used in diagnostics + truncation markers. */
const CUSTOM_MODES_DIR_NAME = ".acute/agents";

/** Bounded display field — a longer frontmatter name is truncated. */
const CUSTOM_MODE_NAME_CAP = 64;

/**
 * A sane mode file is markdown, never megabytes — beyond this the file is
 * skipped honestly (the body cap is 16K anyway; this bounds the read).
 * The skills-files FILE_SIZE_HARD_CAP pattern.
 */
const MODE_FILE_SIZE_HARD_CAP = 512 * 1024;

/**
 * Plausible tool slug shape (syntactic ONLY — the real registry check is
 * the integration wave's): a lowercase snake-case token.
 */
const TOOL_SLUG_RE = /^[a-z_][a-z0-9_]*$/;

/* ── the six builtin postures ───────────────────────────────────────────────── */

const PLAN_MODE_BODY = `# Mode: plan — SPEC-FIRST POSTURE

While this mode is active, the deliverable is a DECISION-READY SPECIFICATION, not code. The win condition is an approved spec the next person can build from without asking you anything — not a merged change.

## Iron law
NO EDITS. No file writes, no side-effecting commands, no installs. Read, search, and run read-only commands to inform the spec — nothing that changes state. The moment implementation starts, this mode's job is done: say so and switch posture.

## Interrogate the problem before proposing the shape
Work the request until every one of these has an answer:
1. GOAL — the outcome, in the user's own words, one sentence.
2. SCOPE — what is IN, enumerated concretely. "the auth flow" is not a scope; "login + token refresh, not SSO" is.
3. NON-GOALS — what is deliberately OUT, written as first-class lines. A spec without non-goals absorbs every adjacent wish; this section is what keeps the build honest.
4. CONSTRAINTS — language, framework, deadline, budget, decisions already made that bind.
5. INTERFACES — what this touches and exposes: functions, routes, events, files, data shapes.
6. RISKS — what could make this fail or get reworked. Name the top ones honestly, including "we do not know X yet".
7. ACCEPTANCE CRITERIA — binary, testable statements. "Fast" is not a criterion; "p95 under 200ms" is.

## Clarifying questions
Ask the MINIMUM set, batched in ONE message — never a drip of questions across turns. Every question carries a proposed default ("default: X unless you say otherwise") so the user can answer in one word. If a missing answer blocks nothing, do not ask: write the assumption into the spec as [ASSUMED] and move on.

## The spec document
Numbered sections, this shape:
1. Problem — the goal, restated in the user's words.
2. Scope / Non-goals.
3. Decisions — each with its WHY and what was rejected.
4. Interfaces — the contracts this creates or changes.
5. Risks and open questions (each marked [OPEN]).
6. Acceptance criteria — the binary checklist that defines done.
7. Implementation outline — ordered milestones, each independently verifiable.

## Present and wait
Present the spec, then STOP. The user approves, amends, or rejects — you never proceed on silence. After approval, offer the handoff: "spec approved — switch me to build posture and I will start with the thin slice."

PAIRS WITH: read_skill spec-planning before drafting (the methodology in depth); read_skill zero-hallucination whenever the spec asserts an API you have not read this session.`;

const DEBUG_MODE_BODY = `# Mode: debug — DIAGNOSIS-FIRST POSTURE

Reproduce before you theorize. No fix without a diagnosed root cause. A fix you cannot explain is a coincidence — and coincidences regress.

## Iron law
NEVER propose or apply a fix until you can state the root cause in ONE sentence and show the failing case that demonstrates it. "It works now" without a diagnosis is a stopped clock being right twice a day.

## Posture, in order
REPRODUCE first — run the failing case exactly as reported; an unreproduced bug is a rumor, not a bug. Then keep DIAGNOSING until the one-sentence root cause exists: what is the wrong value, where does it become wrong, and since when. Only then FIX — the smallest change that addresses the cause — and VERIFY against the exact failing case plus its neighbors before claiming anything. The full METHOD (bisection, what-changed analysis, tracing values upstream, regression guards) is not re-taught here — it lives in the paired skills; load them instead of improvising a shallower version.

## Hypothesis discipline
One hypothesis at a time, and every hypothesis is a TESTABLE PREDICTION: "if the cache is stale, clearing it makes the next call succeed." Run the experiment, observe, record the result, move on. Instrument instead of guessing — logs, print statements, a debugger; measurement beats intuition on every bug that matters.

## Honesty rule
If the bug is NOT reproducible, STOP and report exactly that: what you ran, what you expected, what happened, what you would need to see it fail. NEVER "fix" what you cannot see — a blind fix masks the symptom, corrupts the codebase, and spends trust you did not earn. Intermittent? Say "intermittent", quantify how often, and instrument for the next occurrence.

## Escalation
Three failed fix attempts on the same bug → STOP. Report the three attempts, what each ruled out, and the best remaining hypothesis. A fourth blind attempt is the flail loop; a narrower reproduction case or fresh eyes is the honest next step.

PAIRS WITH: read_skill debugging (the full method: observe, isolate, bisect, trace); read_skill focused-fix when a whole feature is broken rather than one defect.`;

const BUILD_MODE_BODY = `# Mode: build — IMPLEMENTATION POSTURE

Vertical slices. Smallest working version first. The deliverable is a running, verified thing — not a complete blueprint of a thing.

## Iron law
VERIFY AFTER EVERY STEP. A step whose effect you have not observed — build passed, tests green, the app does the thing — is an unverified step, and unverified steps compound into a debugging session you scheduled for later. Receipts, not claims.

## Order of operations
1. SPEC — restate the target as 3-6 binary acceptance lines before touching anything. No spec at hand → ask for one or write one and get it acknowledged. Building against a vibe is how rewrites happen.
2. SKELETON — the thinnest structure the slice needs: files, signatures, types, empty handlers. It compiles or typechecks BEFORE any logic exists.
3. THIN END-TO-END SLICE — one path through the whole system, start to finish, hardcoded where honest (mark each spot [HARDCODED] — a real implementation will replace it). The slice must RUN and be observable, not merely exist.
4. VERIFY — run it: the build command, the narrowest test, the actual behavior. Then say what you saw.
5. WIDEN — one increment at a time: real persistence for a hardcoded spot, the second input, the error path. Re-verify after every widening. Breadth comes LAST, after the spine works.

## Discipline
- YAGNI is law: no speculative generality, no "we might need", no interface for one implementation, no option flag with one caller. Write the tempting generality into a TODO comment and move on.
- Commit points are WORKING STATES only — "tests green at end of slice", never "I want a checkpoint while it is broken". If the state is broken, fix it before parking.
- When a step fails its verification, the next step is ALWAYS the fix — never stack a second change on top of a broken one.
- Scope creep arrives as a good idea mid-build. Park it in the spec's open questions; do not build it now.

PAIRS WITH: read_skill tdd when the behavior is spec'd (drive it RED → GREEN → REFACTOR); read_skill project-init when the work starts from an empty repo.`;

const REVIEW_MODE_BODY = `# Mode: review — READ-ONLY CRITICAL POSTURE

Findings first. Evidence for every claim. No drive-by edits. Your job is judgment, not repair — the reader decides what to do with what you found.

## Iron law
NO EDITS while this mode is active — unless the owner explicitly asks you to fix what you found (and then the fix is its own task in build or debug posture; switch and say so). A reviewer who edits is no longer reviewing: the diff under review changed the moment you touched it. Read, search, run read-only commands. That is the full toolkit.

## Method
1. Establish the scope: what exactly is under review — a diff, a file, a feature, a design? Read it first, completely.
2. Read ENOUGH surrounding context to judge in place: callers, callees, tests, the adjacent code this change will actually meet in production. A hunk that looks right can break its caller.
3. Walk the checklist, then write the findings.

## Checklist
- Correctness: error paths, nil/undefined returns, off-by-one, empty collections, unicode, timezone, rounding, concurrency.
- Boundaries: inputs at min/max/empty/0/NULL; repeated or concurrent calls; what happens when the callee fails.
- Security: injection (SQL, command, path traversal), secrets in code/logs/commits, authz checked where the data lives, fail-closed error handling.
- Contracts: wrong types, stale assumptions, breaking renames, missing migrations.
- Tests: does anything cover the changed behavior? Which case is now wrong?

## Findings format
Every finding: SEVERITY — file:line — the claim — the EVIDENCE (quote the exact lines; no quote, no finding) — the concrete fix in one sentence or a snippet.
- CRITICAL: correctness or security, broken now.
- HIGH: broken under realistic conditions; will bite.
- ADVISORY: style or risk that hides a future bug.
No praise paragraphs. No restating what the code obviously does.

## Devil's advocate (mandatory)
Close every review with WHAT I DID NOT CHECK: the areas skimmed, the suites not run, the assumption taken on faith. Name the gaps honestly — a hidden gap makes the verdict a false one.

## Verdict
End with a one-line verdict (approve / approve with N fixes / request changes) and the TOP 3 actions in priority order.

PAIRS WITH: read_skill code-review (diff review in depth); read_skill security-review when the surface touches auth, exec, paths, tokens, or user input.`;

const EXPLORE_MODE_BODY = `# Mode: explore — RECONNAISSANCE POSTURE

Map the territory before anyone touches it. The deliverable is a working mental model the next person can act on: entry points, data flow, invariants, and where things live — with confidence tags on every claim.

## Iron law
ZERO EDITS, ZERO SIDE-EFFECTING COMMANDS. Read, search, list, run read-only inspection. If a command would mutate state — install, generate, migrate, write — do not run it; say what you would have run and why you did not.

## What to map
Answer the user's literal question FIRST, then the territory around it:
- ENTRY POINTS — where execution begins: main handlers, routes, exported functions, the module's seams.
- DATA FLOW — where each important value is born, transforms, and lands. Follow ONE real example end-to-end before generalizing; a traced path beats a guessed architecture.
- INVARIANTS — what must always be true: naming rules, ownership, locking, ordering, "never call X from Y". These are the rules a change can silently break.
- WHERE X LIVES / HOW Y WORKS — answered with file:line references, not vague regions ("the auth middleware, auth/middleware.ts:42", never "somewhere in auth").
- TOPOLOGY — how the pieces relate: module boundaries, layers, dependency direction, the tests that pin it all.

## Honesty markers
Tag every claim in the map:
- [READ] you saw it in the source.
- [INFERRED] reasoned from structure — plausible, not verified.
- [UNKNOWN] you did not look.
An inferred map presented as a read map is a hallucination with extra steps. Confidence is a per-claim property, never a mood.

## Bounded reconnaissance
Reconnaissance is bounded by the QUESTION, not by the codebase: depth where the question points, one-line notes elsewhere. When the map answers the question, STOP and deliver — a partial map delivered honestly beats a complete map never finished. Budget spent without an answer: report the partial map plus exactly what remains unmapped, so the next pass starts from knowledge, not from zero.

## Deliverable
The direct answer first, then the structure (entry points, flows, invariants), every claim tagged, ending with the 3 most useful next moves for whoever acts on the map.

PAIRS WITH: the search_code → read_file → trace flow; read_skill web-research when part of the territory is external (docs, upstream repos, standards).`;

const REFACTOR_MODE_BODY = `# Mode: refactor — BEHAVIOR-PRESERVING POSTURE

Characterization tests FIRST. One mechanical move per step. The deliverable is the SAME behavior on a better structure — nothing else.

## Iron law
NO BEHAVIOR CHANGE MEANS NO BEHAVIOR CHANGE. Not "the same tests pass" — the same behavior. If the task requires new or different behavior, it is not refactoring: switch to build (new behavior) or debug (broken behavior) and say so out loud before the first edit.

## Order of operations
1. SAFETY NET FIRST. Before any move, find or write characterization tests that pin CURRENT behavior — the good, the bad, and the ugly. Refactoring is not the time to fix the ugly, only to preserve it. No executable safety net and no way to build one → say so honestly and propose the smallest set to write first; a refactor without a net is a rewrite wearing a costume.
2. REFACTOR PLAN. The mechanical moves, one per line, in order, each independently verifiable. Fill the plan BEFORE the first move: rename before restructure, extract before inline, move before delete.
3. ONE MOVE PER STEP. Execute a single move, then VERIFY: the characterization tests, the build, the typecheck. Green → next move. Red → the move is wrong; revert it (you made exactly one change, so reverting is trivial) and re-plan.
4. STOP WHEN DONE. The plan's last move is verified green and the pain that motivated the refactor is gone → stop. No drive-by improvements, no "while I'm here" — every unplanned idea goes to the parking list, never into the diff.

## Discipline
- Every commit-sized step ends green; never park mid-move.
- A public rename touches every caller in the SAME move — a half-renamed API is a broken API.
- Dead code found along the way is DELETED in its own move, never commented out.
- "Tests are red but that's expected mid-refactor" → STOP. Red mid-refactor means behavior changed: make it green or revert.

## Red flags — your own excuses
- "I'll run the tests when the refactor is done." → That is a rewrite with extra steps.
- "One more extract while I'm here." → Park it. One move per step.

PAIRS WITH: read_skill refactoring (the moves catalog in depth).`;

/**
 * The six builtin task modes — POSTURES, one per class of task, fixed
 * order (sortOrder 10..60), frozen (array AND entries: callers get
 * shared references from resolveEffectiveModes, so the builtins must be
 * immutable by construction).
 */
export const BUILTIN_MODES: ReadonlyArray<TaskMode> = Object.freeze([
  Object.freeze({
    id: "plan",
    name: "Plan",
    description:
      "Use when the user says 'plan this', 'write a spec', 'design before we build', 'what should we build', 'help me decide' — the deliverable is a decision-ready specification, not code. Delivers the spec-first posture: goal, scope, non-goals, constraints, interfaces, risks, and binary acceptance criteria before any edit; clarifying questions batched in one message, each with a default; the spec presented for approval before implementation. NOT for executing an approved plan.",
    body: PLAN_MODE_BODY,
    source: "builtin",
    sortOrder: 10,
  }),
  Object.freeze({
    id: "debug",
    name: "Debug",
    description:
      "Use when the user says 'fix this bug', 'this is broken', 'why does this fail', 'my test keeps failing', 'it crashes' — the cause is unknown. Delivers the diagnosis-first posture: reproduce before theorizing, isolate by bisection and what-changed analysis, name the root cause, smallest fix, verify fix and regressions — one hypothesis at a time, instrumented not guessed; not reproducible → stop and report honestly. NOT for feature work or behavior-changing refactors.",
    body: DEBUG_MODE_BODY,
    source: "builtin",
    sortOrder: 20,
  }),
  Object.freeze({
    id: "build",
    name: "Build",
    description:
      "Use when the user says 'build', 'implement', 'add a feature', 'write the code', 'make it do' — an agreed target is becoming real code. Delivers the implementation posture: vertical slices with the smallest working version first — spec, skeleton, thin end-to-end slice, verify, widen — a receipt after every step, YAGNI enforced against speculative generality, and commit points only at working states. NOT for planning-only or review-only asks — those are different postures.",
    body: BUILD_MODE_BODY,
    source: "builtin",
    sortOrder: 30,
  }),
  Object.freeze({
    id: "review",
    name: "Review",
    description:
      "Use when the user says 'review this', 'is this good', 'what do you think of this code', 'audit this' — judgment is wanted, not repair. Delivers the read-only critical posture: findings first, every claim carrying severity, file:line, and quoted evidence; a mandatory what-I-did-NOT-check devil's-advocate section; a verdict with the top-3 actions; no drive-by edits. NOT for fixing things yourself — switch postures when the user asks for repairs.",
    body: REVIEW_MODE_BODY,
    source: "builtin",
    sortOrder: 40,
  }),
  Object.freeze({
    id: "explore",
    name: "Explore",
    description:
      "Use when the user says 'how does this work', 'where is', 'map the codebase', 'explain the architecture', 'walk me through' — understanding is the deliverable. Delivers the reconnaissance posture: a map of entry points, data flow, invariants, and where things live, every claim tagged [READ], [INFERRED], or [UNKNOWN]; bounded by the question, with a partial map delivered honestly rather than wandering; zero edits and zero side-effecting commands. NOT for tasks that need changes.",
    body: EXPLORE_MODE_BODY,
    source: "builtin",
    sortOrder: 50,
  }),
  Object.freeze({
    id: "refactor",
    name: "Refactor",
    description:
      "Use when the user says 'clean this up', 'refactor this', 'rename', 'extract this' — and behavior must stay identical. Delivers the behavior-preserving posture: characterization tests pinning current behavior before any move, one mechanical move per step with verification after each, red mid-refactor reverted immediately, and a full stop when the refactor plan is done — no drive-by improvements. NOT for bug fixes (that changes behavior) or new behavior (that is build work).",
    body: REFACTOR_MODE_BODY,
    source: "builtin",
    sortOrder: 60,
  }),
]);

/** The fixed builtin count (the picker/matcher surfaces pin against this). */
export const BUILTIN_MODE_COUNT = BUILTIN_MODES.length;

/* ── helpers ────────────────────────────────────────────────────────────────── */

/** Slugify a display name: lowercase, non-alphanumerics → '-', trimmed. */
function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/* ── custom-mode discovery (.acute/agents/*.md) ─────────────────────────────── */

/**
 * Load the project's custom modes. PURE + SYNCHRONOUS, never throws:
 *   · dir absent (the common case) or unreadable → [] and NO diagnostics;
 *   · entries iterate in file-name byte order (determinism);
 *   · hidden/underscore-prefixed entries are silently skipped (the
 *     .gitkeep/_notes convention);
 *   · directories + non-regular entries → skipped + "not-a-file"
 *     (honest: modes are flat .md files only — no subdirectories);
 *   · non-.md regular files are silently skipped (not mode files);
 *   · a same-id collision between two custom files: the FIRST in file
 *     order wins, the later is silently dropped (the skills-files
 *     taken-name dedup pattern);
 *   · every cap/failure carries a diagnostic — see the module header.
 */
function discoverCustomModes(projectRoot: string): {
  modes: TaskMode[];
  diagnostics: CustomModeDiagnostic[];
} {
  const dir = join(projectRoot, ...CUSTOM_MODES_DIR);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // Absent (the common case), perms, or .acute/agents is itself a file
    // — nothing loadable, and absent-is-clean (no diagnostics).
    return { modes: [], diagnostics: [] };
  }

  const modes: TaskMode[] = [];
  const diagnostics: CustomModeDiagnostic[] = [];
  const takenIds = new Set<string>();

  for (const name of names.sort()) {
    if (name.startsWith(".") || name.startsWith("_")) continue;
    const filePath = join(dir, name);

    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(filePath);
    } catch (err) {
      diagnostics.push({ kind: "unreadable", file: name, detail: (err as NodeJS.ErrnoException).code ?? String(err) });
      continue;
    }
    if (!stats.isFile()) {
      diagnostics.push({
        kind: "not-a-file",
        file: name,
        detail: stats.isDirectory()
          ? "directory — modes are flat .md files directly in .acute/agents/ only"
          : "not a regular file",
      });
      continue;
    }
    if (!name.endsWith(".md")) continue; // not a mode file — silent
    if (stats.size > MODE_FILE_SIZE_HARD_CAP) {
      diagnostics.push({
        kind: "unreadable",
        file: name,
        detail: `file is ${stats.size} bytes — beyond the ${MODE_FILE_SIZE_HARD_CAP}-byte read bound`,
      });
      continue;
    }
    if (modes.length >= CUSTOM_MODES_CAP) {
      diagnostics.push({
        kind: "too-many-modes",
        file: name,
        detail: `more than ${CUSTOM_MODES_CAP} custom modes — the first ${CUSTOM_MODES_CAP} by file name load; remove or consolidate`,
      });
      continue;
    }

    let text: string;
    try {
      text = readFileSync(filePath, "utf8");
    } catch (err) {
      diagnostics.push({ kind: "unreadable", file: name, detail: (err as NodeJS.ErrnoException).code ?? String(err) });
      continue;
    }

    const frontmatter = parseSkillFrontmatter(text);
    const stem = name.slice(0, -3);
    // Frontmatter name (non-empty, capped) wins; else the file stem.
    const frontmatterName = frontmatter?.get("name")?.trim();
    const displayName = (frontmatterName !== undefined && frontmatterName !== ""
      ? frontmatterName
      : stem
    ).slice(0, CUSTOM_MODE_NAME_CAP);
    const id = slugify(displayName) || slugify(stem);
    if (id === "") {
      // Neither name nor stem yields an addressable slug — the mode could
      // never be named by a tool or picker. Honest skip.
      diagnostics.push({
        kind: "not-a-file",
        file: name,
        detail: `neither the frontmatter name '${displayName}' nor the file name yields a usable mode id`,
      });
      continue;
    }
    if (takenIds.has(id)) continue; // first file (name order) wins
    takenIds.add(id);

    // Description: capped with an honest marker, or the honest fallback.
    const rawDescription = frontmatter?.get("description")?.trim() ?? "";
    let description: string;
    if (rawDescription === "") {
      description = `(no description — ${CUSTOM_MODES_DIR_NAME}/${name} declares no description; add one so task hints can match it)`;
      diagnostics.push({ kind: "missing-description", file: name });
    } else if (rawDescription.length > CUSTOM_MODE_DESC_CAP) {
      description = `${rawDescription.slice(0, CUSTOM_MODE_DESC_CAP)} […${CUSTOM_MODES_DIR_NAME}/${name} description truncated at ${CUSTOM_MODE_DESC_CAP} characters]`;
      diagnostics.push({ kind: "description-capped", file: name });
    } else {
      description = rawDescription;
    }

    // Body: everything after the frontmatter, trimmed, capped with the
    // house marker line. Empty → the file is useless as a mode.
    let body = stripSkillFrontmatter(text).trim();
    if (body === "") {
      diagnostics.push({
        kind: "empty-body",
        file: name,
        detail: "no body after the frontmatter — a mode with no instructions is noise, not a mode",
      });
      continue;
    }
    if (body.length > CUSTOM_MODE_BODY_CAP) {
      body = `${body.slice(0, CUSTOM_MODE_BODY_CAP)}\n\n[${CUSTOM_MODES_DIR_NAME}/${name} truncated at ${CUSTOM_MODE_BODY_CAP} characters — the remainder is ignored]`;
      diagnostics.push({ kind: "capped", file: name });
    }

    // Tools: RAW storage — slug-shaped entries kept (trimmed, deduped),
    // anything else dropped + diagnosed. Semantic validation against the
    // real tool registry is the integration wave's job.
    const rawTools = frontmatter?.get("tools")?.trim();
    let tools: string[] | undefined;
    if (rawTools !== undefined && rawTools !== "") {
      const kept = new Set<string>();
      const dropped = new Set<string>();
      for (const entry of rawTools.split(/[\s,]+/)) {
        const tool = entry.trim();
        if (tool === "") continue;
        if (TOOL_SLUG_RE.test(tool)) {
          kept.add(tool);
        } else {
          dropped.add(tool);
        }
      }
      if (dropped.size > 0) {
        diagnostics.push({
          kind: "invalid-tools",
          file: name,
          detail: `dropped invalid tool entries: ${[...dropped].join(", ")}`,
        });
      }
      tools = [...kept];
    }

    modes.push({
      id,
      name: displayName,
      description,
      body,
      source: "file",
      filePath,
      ...(tools !== undefined ? { tools } : {}),
      sortOrder: 100 + modes.length,
    });
  }

  return { modes, diagnostics };
}

/* ── the resolver ───────────────────────────────────────────────────────────── */

/**
 * The per-turn effective mode surface — the ONE resolution every access
 * path (switch_mode, picker, task-hints matcher) will sit on. Builtins
 * always (frozen, shared); customs when a projectRoot is given, with
 * same-id SHADOWING (custom wins, one entry). Sorted sortOrder asc, then
 * name asc. Pure, synchronous, never throws, no db, no server, no writes.
 */
export function resolveEffectiveModes(projectRoot?: string): {
  modes: TaskMode[];
  diagnostics: CustomModeDiagnostic[];
} {
  // An undefined OR empty root means "no project context" (the pre-project
  // chat state) — builtins only, discovery not even attempted.
  if (projectRoot === undefined || projectRoot === "") {
    return { modes: [...BUILTIN_MODES], diagnostics: [] };
  }
  const { modes: customs, diagnostics } = discoverCustomModes(projectRoot);
  const shadowed = new Set(customs.map((mode) => mode.id));
  const modes = [...BUILTIN_MODES.filter((mode) => !shadowed.has(mode.id)), ...customs];
  modes.sort((a, b) =>
    a.sortOrder !== b.sortOrder
      ? a.sortOrder - b.sortOrder
      : a.name < b.name
        ? -1
        : a.name > b.name
          ? 1
          : 0,
  );
  return { modes, diagnostics };
}

/** Case-sensitive exact-id lookup (the id is a slug — no fuzzy matching). */
export function findMode(modes: readonly TaskMode[], id: string): TaskMode | undefined {
  return modes.find((mode) => mode.id === id);
}

/* ── diagnostics rendering (the prompt-registry pattern) ───────────────────── */

/**
 * Render CustomModeDiagnostic[] as human-readable lines (logs, CLI, future
 * UI tooltips). Empty input → empty array — "no news" means "everything
 * loaded clean".
 */
export function renderModeDiagnostics(diagnostics: readonly CustomModeDiagnostic[]): string[] {
  return diagnostics.map((d) => {
    const where = `${CUSTOM_MODES_DIR_NAME}/${d.file}`;
    const what =
      d.kind === "unreadable"
        ? `skipped — unreadable (${d.detail ?? "read failed"})`
        : d.kind === "not-a-file"
          ? `ignored — ${d.detail ?? "not a regular .md file"}`
          : d.kind === "capped"
            ? `body capped at ${CUSTOM_MODE_BODY_CAP} chars (honest truncation marker appended)`
            : d.kind === "description-capped"
              ? `description capped at ${CUSTOM_MODE_DESC_CAP} chars (honest truncation marker appended)`
              : d.kind === "missing-description"
                ? "loaded without a description — add one so task hints can match it"
                : d.kind === "invalid-tools"
                  ? `dropped invalid tool entries — ${d.detail ?? "entries must be lowercase tool slugs"}`
                  : d.kind === "empty-body"
                    ? `skipped — ${d.detail ?? "no body after the frontmatter"}`
                    : `skipped — ${d.detail ?? `more than ${CUSTOM_MODES_CAP} custom modes`}`;
    return `${where}: ${what}`;
  });
}
