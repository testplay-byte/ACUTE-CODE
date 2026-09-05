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

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

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
