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
 */
export const COMPUTER_USE_SKILL_BODY = `# Skill: computer-use

Main-agent only. Never delegate Computer Use to a subagent (subagents lack the session-bound snapshot/frame state).

## Core loop
1. If readiness is unknown, call request_access once.
2. list_apps shows RUNNING apps only. If the user names an app that is absent, call open_application ONCE with the EXACT user-provided name — character-for-character (case, spaces, punctuation, suffixes like "app"). Never translate, normalize, shorten, retry spellings, or substitute a different running app.
3. Call get_app_state. Start with the accessibility tree, no screenshot.
4. If the target is in the tree, use an ELEMENT action ({type:"element", stateId, index}) — semantic, precise, background-safe, never steals the user's focus.
5. Only when accessibility cannot locate or express the target, take a screenshot and use frame-bound coordinates ({type:"coordinate", x, y} copied UNCHANGED from the latest returned image — never pre-scale, never attach appRef/stateId).
6. Actions return receipts. action_sent=true means it MAY have happened — never blindly replay. Verify via fresh get_app_state or an external oracle (file exists, process exit code) when the outcome matters.

## Discipline
- One observation, one action, then verify. Never re-observe an unchanged state before acting.
- type REPLACES a field's contents (select first to insert). set_value is the preferred semantic write. Prefer set_value/perform_action over raw input.
- Raw input (coordinate clicks, key chords, typing) on Windows/Linux requires the target app frontmost — a frontmost_pid_mismatch refusal means: open_application(activate=true) → fresh get_app_state → retry ONCE.
- scroll has no accessibility path — always coordinate. double/triple/middle click have no a11y equivalent — element targets fail closed; use coordinates.
- Modifiers: macOS uses "cmd"; Windows/Linux use "ctrl".
- Never send targetless type/key — scope with an element target or appRef.
- An unexpected modal dialog may be intercepting your action: inspect its contents FIRST; dismiss (Escape / its Cancel) only when it is NOT the task.
- An occlusion_owner_mismatch refusal names the covering window: re-activate the intended app; NEVER move/resize/close the reported window.
- After any element WRITE the stateId is consumed — get_app_state again before the next element action.
- After stop_computer_control: no more computer-use calls; end the turn.

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
