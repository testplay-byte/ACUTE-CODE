/**
 * ROUND-61 (R61): SKILLS storage — the owner's directive: "the ability to
 * add multiple skills". A skill is a SKILL.md-style prompt module with
 * PROGRESSIVE DISCLOSURE (the doc-09 pattern): the system prompt lists only
 * name + description; the BODY is loaded on demand via the read_skill tool.
 *
 * Built-ins (source='builtin') are seeded at database open with INSERT OR
 * IGNORE (one fixed id per skill — reapplied only when the row is missing,
 * so a user EDIT persists; deletion of built-ins is REFUSED with a note —
 * disable instead, which hides the prompt line + the read_skill listing).
 * User skills: full CRUD.
 *
 * ROUND-70 (R70-b, D2): the built-in family grew from one (computer-use)
 * to EIGHT — code-review, debugging, testing, git-workflow, web-research,
 * project-init, browser-use (R70-B recommendation #4). Same seeding
 * contract, one fixed id each. File-based skills (R70-b D1) merge with
 * these at the RESOLUTION layer — storage/skills-files.ts (DB rows shadow
 * same-name files; the DB stays the editable source of truth).
 */
import type { SqliteDatabase } from "./db.js";

export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  body: string;
  source: "builtin" | "user";
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

interface SkillRow {
  id: string;
  name: string;
  description: string;
  body: string;
  source: string;
  enabled: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

function toSkill(row: SkillRow): SkillRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    body: row.body,
    source: row.source === "builtin" ? "builtin" : "user",
    enabled: row.enabled === 1,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/* ── the built-in seed: the computer-use skill (doc 09, condensed) ────────── */

export const COMPUTER_USE_SKILL_ID = "skill_builtin_computer_use";

/**
 * The built-in COMPUTER-USE skill body — the behavioral contract from doc
 * 09-agent-skill-prompt.md, condensed to the operating core (the full doc
 * lives in docs/runbooks/COMPUTER-USE.md). Overridable like any skill
 * (edit the row; the prompt rides YOUR text).
 *
 * ROUND-64-a (R64-a): rewritten around the honest Windows surface — the
 * accessibility-first loop (no vision needed), app resolution by
 * processName OR title, the runningApps recovery payload, and
 * verify-after-every-write discipline.
 *
 * ROUND-66-2-d (R66-2-d): the BIG APPS paragraph — find_elements (the
 * server-side tree search) before screenshots in Chromium-sized windows
 * (the owner's live Edge failure: the agent looped screenshots because it
 * could not locate one control in a thousands-element tree).
 *
 * ROUND-67 (R67-E): the TAB-WALK DISCOVERY paragraph — the Windows key
 * tool now sends REAL SendInput chords (R68-C) and every key receipt
 * names the FOCUSED element, so walking Tab discovers the controls (the
 * owner's technique) — plus the embedded-browser boundary (browser_control
 * only, never computer-use tools on the in-app panel).
 *
 * ROUND-68 (R68-C): the browser-tree truth + chain discipline — the web
 * a11y tree IS searched (the Chromium poke activates it), screenshots are
 * the fallback for browser content, and the observe→act chain is
 * IMMEDIATE (frames valid 30s; verify with a small zoom crop). The
 * frontmost line teaches the AUTO-activation (a mismatch refusal now
 * means that activation failed).
 *
 * ROUND-69 (R69, verifier task 5): the observation-receipt loop — every
 * mutating action receipt now CARRIES the post-action observation (fresh
 * frame id, screenChanged, focusedElementName, activeApp title), so the
 * R68 "verify with a small zoom crop after the action" line is RETIRED
 * here (that zoom WAS the owner's screenshot-spam complaint). The body
 * now matches prompts.ts' R69 CHAIN DISCIPLINE: read the receipt, never
 * screenshot/zoom after acting; unchanged → adjust strategy, element
 * first; wait() after navigation reports what changed; a screen_unchanged
 * refusal means act or change strategy — never re-capture.
 */
export const COMPUTER_USE_SKILL_BODY = `# Skill: computer-use

Main-agent only. Never delegate Computer Use to a subagent (subagents lack the session-bound snapshot/frame state). UIA/AT-SPI element actions are the PRIMARY path: they need no vision and never steal the user's focus.

## Core loop
1. If readiness is unknown, call request_access once.
2. ALWAYS start with list_apps. name = the app's window TITLE ("Untitled - Notepad"); processName = the executable ("notepad"); both + pid are in every entry.
3. get_app_state resolves app_ref by pid (best), window title, processName, or a unique substring. If it refuses app_not_found, the payload's runningApps lists what IS running — pick the correct pid and retry with {pid}; never guess a pid. Two matches → ambiguous_app_ref lists the candidates; scope with pid.
4. If the user names an app that is absent, call open_application ONCE with the EXACT user-provided name — character-for-character (case, spaces, punctuation, suffixes like "app"). Never translate, normalize, shorten, retry spellings, or substitute a different running app.
5. After open_application, wait 0.5-1s (the wait tool, or return_state) for the window to exist BEFORE get_app_state.
6. If the target is in the tree, use an ELEMENT action ({type:"element", stateId, index}) — set_value / perform_action / left_click element. detail:"full" gives bounds + the element's advertised actions.
7. Only when the tree cannot locate or express the target, take a screenshot and use frame-bound coordinates ({type:"coordinate", x, y} copied UNCHANGED from the latest returned image — never pre-scale, never attach appRef/stateId).
8. VERIFY AFTER EVERY WRITE: the action receipt CARRIES a post-action observation (return_state defaults to "compact") — a fresh frame id, screenChanged, focusedElementName, the active app's title. READ the receipt; do NOT screenshot or zoom after acting. Only re-observe with get_app_state when the observation is missing or ambiguous.
9. Actions return receipts. action_sent=true means it MAY have happened — never blindly replay. The receipt's observation is the FIRST verification read; an external oracle (file exists, process exit code) is the strong one. An UNCHANGED screen means the action may not have registered: check focusedElementName, adjust strategy, switch to element targeting.

## Big apps (browsers, Edge, VS Code)
- get_app_state on a browser/IDE window returns a HUGE tree (Chromium exposes thousands of elements). Do NOT read it whole — SEARCH it: find_elements {appRef, query:"Sign in", kind:"button"} returns just the matching elements with indexes + bounds, far cheaper than get_app_state detail:"full".
- Browser pages (Edge/Chrome): the WEB accessibility tree IS searched — find_elements by name finds links, buttons, inputs (the tree is activated automatically). Element targets are the primary path for browser content; screenshots only when the tree genuinely misses.
- Prefer find_elements + element clicks (left_click/set_value with the returned stateId + index) over screenshots in big apps.
- Never loop screenshots when the tree can answer: find_elements by name first; screenshot/zoom only when names genuinely cannot identify the control. An empty result tells you the query and how many elements were searched — retry with a shorter substring or read the tree.
- CHAIN DISCIPLINE: screenshot → act IMMEDIATELY (frames stay valid 30s) — never re-screenshot between observing and acting, and never re-capture after acting: the receipt's observation is the post-action read. After navigation (Enter, links), call wait() — its receipt reports what changed while you waited. A screen_unchanged refusal means act or change strategy, not re-capture. middle_click a link = open in new tab.

## Tab-walk discovery (R67)
- Pressing key "tab" highlights the next focusable control on screen, and every key receipt names the FOCUSED element — walk Tab repeatedly to discover what is interactive when find_elements comes back empty or names cannot identify the target, then act on the element you reached. Combine with find_elements (search by name) when the app is big.

## The embedded browser is NOT a desktop app
- The app's EMBEDDED browser panel (the right-sidebar webview) is driven ONLY with browser_control (read_dom → click/type the returned selector paths) — NEVER with these computer-use tools. If the task is a web page, it is browser_control work; computer use is for the user's REAL apps.

## Discipline
- type REPLACES a field's contents (select first to insert). set_value is the preferred semantic write. Prefer set_value/perform_action over raw input.
- Raw input (coordinate clicks, key chords, app-scoped typing) on Windows/Linux needs the target frontmost — the raw-input tools now ACTIVATE their target automatically (R68: verified activation + one retry). A frontmost_pid_mismatch refusal means that auto-activation failed: check the app still runs (list_apps), re-observe, retry ONCE.
- scroll has no accessibility path — always coordinate. double/triple click are raw-only (coordinate). middle_click and right_click DO take element targets (R69): middle routes a raw click at the element's center; right clicks the center when the element has no menu.
- Modifiers: macOS uses "cmd"; Windows/Linux use "ctrl".
- Never send targetless type/key — scope with an element target or appRef.
- An unexpected modal dialog may be intercepting your action: inspect its contents FIRST; dismiss (Escape / its Cancel) only when it is NOT the task.
- An occlusion_owner_mismatch refusal names the covering window: re-activate the intended app; NEVER move/resize/close the reported window.
- After any element WRITE the stateId is consumed — get_app_state again before the next element action.
- Your OWN app window is not off-limits: if it covers the target, minimize it (key "win+down" with appRef {pid} of the ACUTE process, or element actions on its minimize button) — but only as much as needed to reach the target app.
- When the task is done, call stop_computer_control (releases held buttons); after it: no more computer-use calls, end the turn.

## Safety
- Destructive or hard-to-reverse actions (delete, overwrite, send, pay) need the user's explicit go-ahead unless durably authorized.
- NEVER type credentials (passwords, API keys, OTPs) into anything.
- Outward-facing sends are publishing — confirm unless told to proceed.
- Report outcomes faithfully; UI truth is not world truth.`;

/* ── ROUND-70 (R70-b, D2): the SEVEN new built-ins ───────────────────────────
 *
 * R70-B recommendation #4 — the agent's expanded brain, shipped as seeded
 * DB content (same INSERT OR IGNORE pattern as computer-use: one fixed id
 * per skill, user edits persist, deletion refused, disable hides). Bodies
 * 800–2,200 chars, Claude-skill style: terse, high-signal, imperative —
 * these are instructions the model will FOLLOW, not documentation it will
 * skim. The SKILLS prompt line carries only the description; the body
 * loads on demand via read_skill (progressive disclosure).
 *
 * `browser-use` deliberately COMPACTS the prompt's browser-panel teaching
 * into a loadable module (R70-c will trim the prompt section to essentials
 * and point here) — the body stays self-contained. `project-init` writes
 * AGENTS.md (R70-c makes the file auto-loadable; this skill creates it). */

export const CODE_REVIEW_SKILL_BODY = `# Skill: code-review

Review the CHANGE, not the whole repo. Scope to what the diff touches.

## Method
1. Read the diff first: git_diff (the touched paths). No diff to review = say so and stop.
2. Read enough surrounding code (read_file on the touched files) to judge the change in context — a hunk that looks right can break its caller.
3. Walk the checklist, then report.

## Checklist
- Correctness: error paths, nil/undefined returns, off-by-one, empty collections, unicode, timezone, rounding.
- Boundary conditions: inputs at min/max/empty/0/NULL; repeated or concurrent calls; what happens when the callee fails.
- Security: injection (SQL, command, path traversal), secrets in code or logs, auth checks on new routes, untrusted deserialization.
- API misuse: wrong types, stale contracts, breaking renames, missing migrations.
- Tests: do existing tests cover the changed behavior? Which case is now wrong?

## Report
Findings FIRST, ordered **critical** (correctness/security) > **bug** > **risk** (works but fragile) > **style** (only when it hides a bug).
Each finding: path:line + what is wrong + the concrete fix (a sentence or a snippet).
No praise. No restating what the diff obviously does.
End with a one-line verdict: approve / approve with N fixes / request changes.
If nothing is wrong, say exactly that and list the strongest check you ran.`;

export const DEBUGGING_SKILL_BODY = `# Skill: debugging

Fix the cause, never the symptom. Never "fix" a failure you cannot reproduce.

## Method
1. REPRODUCE. Run the failing case. No reproduction = no fix — report what you know and what you still need.
2. READ THE ERROR FULLY before reacting. The message names the file, the line, and usually the wrong value — half of all bugs die here. Do not skim; do not chase a different bug than the one reported.
3. ISOLATE. Narrow to the smallest input and the first wrong line:
   - git_log + git_diff the touched files — what changed recently?
   - Comment out or stub suspects; re-run after each cut.
   - search_code for the failing symbol — find where the bad value originates.
4. LOCATE the root cause. Trace the wrong value upstream to its source, then state it in one sentence: "X is null because Y only runs on the first mount."
5. FIX the root cause with a minimal change in the style of the surrounding code.
6. VERIFY: re-run the exact failing case, then the adjacent tests for that area.
7. GUARD: add a regression test that fails without the fix and passes with it.

## Discipline
- One hypothesis at a time: change one thing, re-run, observe.
- When two fixes both "work", prefer the one that also explains the error message.
- If you cannot locate the cause in a small number of steps, STOP and report what you ruled out — a pile of speculative edits is damage, not progress.`;

export const TESTING_SKILL_BODY = `# Skill: testing

A change is not done until its tests run and pass.

## Discipline
- Behavior spec'd but unwritten → write the failing test FIRST; watch it fail for the right reason; then implement.
- One behavior per test. A test that can fail for three different reasons explains none of them.
- Assert the error path, not only the happy path: the thrown message, the rejected promise, the empty result. A test that never fails proves nothing about failure.
- Run the affected suite after EVERY edit, not once at the end.
- NEVER weaken an assertion, delete a test, or widen a tolerance to make a suite green. A red test is information — making it green without understanding it is lying.
- A flaky test is a bug: isolate it (repeat, reduce, check time/random/order dependencies) or report it; never silently skip it.

## Commands
Find the project's REAL commands before inventing any: AGENTS.md, package.json scripts, the repo's CI config. Run the narrowest suite covering your change first (a file or a -t filter), the full affected package before claiming done. If no test setup exists, say so and propose one instead of pretending.`;

export const GIT_WORKFLOW_SKILL_BODY = `# Skill: git-workflow

The working tree belongs to the USER. Read-only by default.

## Rules
- Commit ONLY when the user asks. A finished task needs no commit — say what is uncommitted instead.
- NEVER revert, overwrite, or discard the user's uncommitted changes. NEVER git reset --hard, NEVER checkout -- over a modified file, NEVER git clean.
- If the worktree holds changes you did not make, STOP and report them before touching anything — a surprise in the tree is a signal, not noise.
- Stage related files explicitly: git add <path> ... . NEVER git add -A / git add . unless asked — commit exactly what the task changed.
- Before editing: git_status + git_diff to know what is already dirty.

## Commits (when asked)
- Conventional commits: type(scope): summary — feat/fix/refactor/test/docs/chore; imperative subject <= 72 chars, no trailing period.
- The body answers WHY (the what is in the diff). Reference the issue/PR when one exists.
- Verify the staged set (git diff --cached) BEFORE committing: the task's changes and nothing else.

## Branches & PRs
- Risky or experimental work: create a descriptive kebab-case branch first, when asked.
- PR description = WHAT changed + WHY + HOW IT WAS TESTED, three short paragraphs.
- Never amend, rebase, or force-push a branch you do not own.`;

export const WEB_RESEARCH_SKILL_BODY = `# Skill: web-research

Research ends in a DECISION, not a link dump.

## Method
1. SEARCH first (web_search) — 2-3 precise queries with the exact technical nouns, before fetching anything.
2. FETCH the 2-3 most authoritative hits (web_fetch). Prefer primary sources in this order: official docs / the project's source / the spec or RFC, then release notes and maintainer answers, then blog posts last (a blog may restate an old version).
3. When it matters (a version number, a breaking change, a security note), cross-check the claim across TWO independent sources.
4. Note the version AND date of what you read ("React 19 docs, updated 2025") — a right answer for the wrong version is still wrong.
5. SYNTHESIZE: the direct answer first, the evidence under it (one line per source, URL inline), then the open questions.

## Discipline
- Prefer documentation hosts (github.com, npmjs.com, MDN, nodejs.org) — they fetch freely.
- If sources disagree, say so and name the disagreement — never average two answers into a wrong one.
- Dated info: say when the newest source is old ("latest post is 2023 — this may have changed").
- Never invent a URL. Cite only what you actually fetched.`;

export const PROJECT_INIT_SKILL_BODY = `# Skill: project-init

Write the project's AGENTS.md — the convention file coding agents auto-load at session start. Goal: a fresh agent works in this repo correctly on turn one.

## Analyze first
1. list_dir the root. Read the README, the manifests (package.json / pyproject.toml / Cargo.toml / go.mod — whatever exists), and the CI config (.github/workflows, .gitlab-ci.yml).
2. Sample 5-10 real source files (the largest and most central, not config). Note the ACTUAL conventions: quote style, naming, error handling, where tests live, import order.
3. Run index_project; skim the summary for the package structure.

## Write AGENTS.md (<= 150 lines)
Terse sections:
- **What this is** — 2-3 sentences from the README, in your own words.
- **Stack** — languages, frameworks, package manager, key versions.
- **Commands** — setup, dev, build, test, lint, typecheck. ONLY commands you verified or copied from scripts/CI; mark unverified ones.
- **Conventions** — the rules a patch must follow (style, naming, test placement, commit style if evident).
- **Directory map** — one line per top-level directory.
- **Gotchas** — the traps you hit or can see (codegen, quirky build steps, platform notes, "don't edit X, it is generated").

## Rules
- Write only what you OBSERVED, never what a typical project of this type would have — a wrong command is worse than a missing one.
- write_file the result at the repo root, then report what you included and what you skipped.`;

export const BROWSER_USE_SKILL_BODY = `# Skill: browser-use

The embedded browser panel (browser_control) — a real webview the user watches live. It is NOT the user's desktop: never narrate panel actions as machine actions.

## Core loop
1. navigate to the absolute http(s) URL. Omit sessionId → it drives THIS session's own tab (auto-opened in the panel).
2. read_dom — the structured page outline (headings, links, buttons, inputs, forms with short selectors). This is how you know the page; screenshots only for layout/visual questions.
3. Act on DOM IDENTITY, never pixel coordinates: click by the returned selector or visible text; type into the returned selector.
4. VERIFY with get_state (currentUrl, title, canBack/canForward) — the navigation you expected, not the one you hoped for; read (fresh server text) or read_dom when the check must be about content.

## Forms
- Submit deliberately: type {selector, submit:true}, or press_key Enter (native form submission), or click the submit button by text. Typing alone never submits.
- Never eval a manual form click when the submit path above exists.

## Bot walls (CAPTCHA / Cloudflare / age gates)
- A result warning of a verification wall → STOP retrying. Call wait_for_verification: the user gets a countdown card, solves the wall in the panel, marks it done; you receive the honest re-probe result.
- Never hammer a walled page; never attempt to solve a CAPTCHA yourself.

## Discipline
- read = fresh server-side text; read_dom/click/type/eval = the LIVE page. They can disagree (logins, JS) — say which you used.
- eval runs as a function body in the page — end with return; use it only when read_dom/read/source cannot answer.
- Announce viewport changes (set_viewport) in one line — the user sees the panel live.
- source for the page's html/css/js; screenshot only when pixels are the question.`;

const BUILTIN_SKILLS: ReadonlyArray<Pick<SkillRecord, "id" | "name" | "description" | "body" | "source" | "sortOrder">> = [
  {
    id: COMPUTER_USE_SKILL_ID,
    name: "computer-use",
    description:
      "Observe and actuate the desktop GUI: accessibility-first element actions with screenshot-coordinate fallback, receipts, fail-closed refusals, verification discipline.",
    body: COMPUTER_USE_SKILL_BODY,
    source: "builtin",
    sortOrder: 0,
  },
  {
    id: "skill_builtin_code_review",
    name: "code-review",
    description:
      "Review code changes for defects and risks: read the diff first, findings ordered critical/bug/risk/style each with path:line and a concrete fix, no praise, end with a verdict.",
    body: CODE_REVIEW_SKILL_BODY,
    source: "builtin",
    sortOrder: 1,
  },
  {
    id: "skill_builtin_debugging",
    name: "debugging",
    description:
      "Systematic defect fixing: reproduce, read the actual error fully, isolate (git bisect/comment-out), locate the root cause, fix it not the symptom, verify, guard with a regression test.",
    body: DEBUGGING_SKILL_BODY,
    source: "builtin",
    sortOrder: 2,
  },
  {
    id: "skill_builtin_testing",
    name: "testing",
    description:
      "Testing discipline: test-first when behavior is spec'd, run the affected suite after every edit, one behavior per test, assert errors not just the happy path, never weaken an assertion.",
    body: TESTING_SKILL_BODY,
    source: "builtin",
    sortOrder: 3,
  },
  {
    id: "skill_builtin_git_workflow",
    name: "git-workflow",
    description:
      "Safe git habits: read-only by default, commit only when asked, conventional commits, stage related files explicitly (never add -A), never revert or hard-reset user changes, branch before risky work.",
    body: GIT_WORKFLOW_SKILL_BODY,
    source: "builtin",
    sortOrder: 4,
  },
  {
    id: "skill_builtin_web_research",
    name: "web-research",
    description:
      "Research with sources: web_search first, fetch the 2-3 most authoritative results, prefer primary docs over blog restatements, cite URLs inline, synthesize a decision not a link dump.",
    body: WEB_RESEARCH_SKILL_BODY,
    source: "builtin",
    sortOrder: 5,
  },
  {
    id: "skill_builtin_project_init",
    name: "project-init",
    description:
      "The /init skill: analyze the codebase (manifests, CI, sample sources) and write the repo's AGENTS.md — what it is, stack, verified setup/build/test/lint commands, conventions, directory map, gotchas; <= 150 lines.",
    body: PROJECT_INIT_SKILL_BODY,
    source: "builtin",
    sortOrder: 6,
  },
  {
    id: "skill_builtin_browser_use",
    name: "browser-use",
    description:
      "Drive the embedded browser panel: read_dom for interactive elements, click/type by DOM selector (never coordinates), submit forms with submit:true or Enter, the bot-wall wait_for_verification protocol, verify with get_state.",
    body: BROWSER_USE_SKILL_BODY,
    source: "builtin",
    sortOrder: 7,
  },
];

/** Seed built-in skills once per database open (INSERT OR IGNORE). */
export function seedBuiltinSkills(db: SqliteDatabase): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO skills (id, name, description, body, source, enabled, sort_order, created_at, updated_at)
     VALUES (@id, @name, @description, @body, @source, 1, @sortOrder, @createdAt, @createdAt)`,
  );
  const createdAt = new Date().toISOString();
  db.transaction(() => {
    for (const skill of BUILTIN_SKILLS) {
      insert.run({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        body: skill.body,
        source: skill.source,
        sortOrder: skill.sortOrder,
        createdAt,
      });
    }
  })();
}

const SELECT_SKILLS = `SELECT * FROM skills ORDER BY enabled DESC, sort_order ASC, name ASC`;

export function listSkills(db: SqliteDatabase): SkillRecord[] {
  return (db.prepare(SELECT_SKILLS).all() as SkillRow[]).map(toSkill);
}

export function getSkill(db: SqliteDatabase, id: string): SkillRecord | undefined {
  const row = db.prepare("SELECT * FROM skills WHERE id = ?").get(id) as SkillRow | undefined;
  return row ? toSkill(row) : undefined;
}

/** Enabled skills only — what the prompt lists + read_skill exposes. */
export function listEnabledSkills(db: SqliteDatabase): SkillRecord[] {
  return (db.prepare(`${SELECT_SKILLS} `).all() as SkillRow[])
    .map(toSkill)
    .filter((s) => s.enabled);
}

export interface SkillInput {
  name: string;
  description?: string;
  body?: string;
  enabled?: boolean;
  sortOrder?: number;
}

/** Tool-name grammar reused for skill names: a lowercase slug. Exported
 * for skills-files.ts (file-based skill validation shares the contract). */
export const NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

export function createSkill(db: SqliteDatabase, input: SkillInput): SkillRecord {
  const name = input.name.trim();
  if (!NAME_RE.test(name)) {
    throw new Error("skill name must be a lowercase slug (letters, digits, dashes; 2-64 chars)");
  }
  const existing = db.prepare("SELECT id FROM skills WHERE name = ?").get(name);
  if (existing !== undefined) {
    throw new Error(`a skill named '${name}' already exists`);
  }
  const id = `skill_${name.replace(/-/g, "_")}_${Date.now().toString(36)}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO skills (id, name, description, body, source, enabled, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'user', ?, ?, ?, ?)`,
  ).run(
    id,
    name,
    (input.description ?? "").slice(0, 500),
    (input.body ?? "").slice(0, 60000),
    input.enabled === false ? 0 : 1,
    input.sortOrder ?? 100,
    now,
    now,
  );
  return getSkill(db, id) as SkillRecord;
}

export interface SkillPatch {
  name?: string;
  description?: string;
  body?: string;
  enabled?: boolean;
  sortOrder?: number;
}

export function updateSkill(db: SqliteDatabase, id: string, patch: SkillPatch): SkillRecord | undefined {
  const existing = getSkill(db, id);
  if (existing === undefined) return undefined;
  const now = new Date().toISOString();
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!NAME_RE.test(name)) {
      throw new Error("skill name must be a lowercase slug (letters, digits, dashes; 2-64 chars)");
    }
    const clash = db.prepare("SELECT id FROM skills WHERE name = ? AND id != ?").get(name, id);
    if (clash !== undefined) {
      throw new Error(`a skill named '${name}' already exists`);
    }
  }
  db.prepare(
    `UPDATE skills SET
      name = ?, description = ?, body = ?, enabled = ?, sort_order = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    patch.name?.trim() ?? existing.name,
    (patch.description ?? existing.description).slice(0, 500),
    (patch.body ?? existing.body).slice(0, 60000),
    (patch.enabled ?? existing.enabled) ? 1 : 0,
    patch.sortOrder ?? existing.sortOrder,
    now,
    id,
  );
  return getSkill(db, id);
}

/** Built-ins refuse deletion (disable instead — the honest contract). */
export function deleteSkill(db: SqliteDatabase, id: string): { ok: boolean; note?: string } {
  const existing = getSkill(db, id);
  if (existing === undefined) return { ok: false, note: "no such skill" };
  if (existing.source === "builtin") {
    return {
      ok: false,
      note: "built-in skills can be disabled or edited, but not deleted (the seed would recreate them)",
    };
  }
  db.prepare("DELETE FROM skills WHERE id = ?").run(id);
  return { ok: true };
}
