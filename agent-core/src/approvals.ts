/**
 * ROUND-37 approvals engine (owner directive: unapproved commands must
 * "properly and clearly highlight it with me and ask me for permission and
 * wait for my permission… options to allow it always or allow it this time").
 *
 * Design (ADR-0024, plan §3 + review amendments #1/#2/#5):
 * - ONE decision function — decideCommand() — is the single source of truth
 *   for command policy (exec.ts delegates; the old static SAFE_PREFIX gate
 *   in exec.ts is retired).
 * - Layered, fail-closed: BLOCKED → deny forever (denylist-supreme);
 *   DESTRUCTIVE → ask ALWAYS (never "always allow" — hard rule);
 *   AUTO safe list (read-only + build/test) → run; project-scoped exact-match
 *   "always allow" rule → run; everything else → ask.
 * - The interactive wait uses an IN-PROCESS RESOLVER MAP (approvalId →
 *   resolver), NOT DB polling — the decision route runs in this process.
 *   The DB rows are the audit trail + crash recovery (boot sweep marks
 *   stale pending rows expired — fail-closed).
 * - Sync turns + sub-agent children are NON-interactive: a non-safe command
 *   fails fast with a clear note (no 120s burn).
 */
import { randomUUID } from "node:crypto";
import type { ToolPermission } from "shared";
import type { SqliteDatabase } from "./storage/db.js";
import { logApproval } from "./lib/log.js";

/** Risk tier for a prospective tool action. */
export type ActionCategory = ToolPermission | "destructive";

export const APPROVAL_TIMEOUT_MS = 120_000;

/** Read-only + build/test commands eligible for automatic execution.
 * ROUND-37 amendment #1: `npm install`, `git commit`, `git add`, `yarn`,
 * `pip`, `go run` etc. MOVED to "ask" (first use; rule-able afterwards);
 * `env` (dumps non-keyring secrets) and `echo` (pointless as an agent tool)
 * were dropped from auto entirely. */
const AUTO_PREFIXES: readonly string[] = [
  // listing / reading / searching
  "ls", "dir", "cat", "type", "head", "tail", "wc", "find", "grep", "rg ", "which", "where",
  // version probes
  "node --version", "npm --version", "pnpm --version", "python --version", "python3 --version",
  // read-only git
  "git status", "git diff", "git log", "git branch", "git show", "git tag",
  // tests + builds + lints (no installs, no dev servers)
  "npm test", "npm run test", "pnpm test", "pnpm run test", "yarn test",
  "vitest", "jest", "tsc", "npx tsc",
  "pnpm lint", "pnpm typecheck", "npm run lint", "npm run typecheck",
  "pnpm verify", "pnpm build", "npm run build", "yarn build",
  "cargo check", "cargo test", "cargo build", "cargo clippy",
  "go test", "go build", "go vet", "go fmt",
  // harmless info
  "pwd", "date", "help",
];

/** Commands that NEVER run — destructive, system-level, or network risk. */
const BLOCKED_PREFIXES: readonly string[] = [
  "rm -rf /", "sudo ", "su ", "shutdown", "reboot", "mkfs", "dd if=",
  "curl ", "wget ", "ssh ", "scp ", "nc ", "telnet ",
  "pnpm dev", "npm start", "next dev", "npx playwright", "npx puppeteer",
];

/** Windows-shaped disk-wiping variants + exact-token commands (a bare
 * "vite" prefix would also block "vitest" — hence word-boundary regexes). */
const BLOCKED_PATTERNS: readonly RegExp[] = [
  /^format\s+[a-z]:/i,
  /^del\s+\/[sq]/i,
  /^rmdir\s+\/s/i,
  /^remove-item\s+.*-recurse/i,
  /^vite(\s|$)/i,
]

/** Irreversible-but-legitimate git operations: askable, NEVER "always allow". */
const DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  /git\s+push\s+.*(--force\b|-f\b)/i,
  /git\s+reset\s+--hard/i,
  /git\s+clean\s+-[a-z]*f/i,
];

/** `rm` with -r and/or -f in any flag position. */
function hasRecursiveOrForceRm(command: string): boolean {
  const tokens = command.trim().split(/\s+/);
  if ((tokens[0] ?? "").toLowerCase() !== "rm") return false;
  return tokens.slice(1).some(
    (token) => /^-[a-z]*[rf]/i.test(token) || token === "--recursive" || token === "--force",
  );
}

/** The policy tier for a command (pure — no DB, no environment). */
export function categorize(action: string): ActionCategory {
  const normalized = action.trim();
  const lowered = normalized.toLowerCase();
  if (hasRecursiveOrForceRm(normalized)) return "blocked";
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(normalized)) return "blocked";
  }
  if (BLOCKED_PREFIXES.some((p) => lowered.startsWith(p))) return "blocked";
  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(normalized)) return "destructive";
  }
  if (AUTO_PREFIXES.some((p) => lowered.startsWith(p))) return "auto";
  return "confirm";
}

/** The layered decision every run_command passes through. */
export type CommandDecision =
  | { action: "deny"; category: "blocked"; reason: string }
  | { action: "run"; category: "auto" | "rule"; reason: string }
  | { action: "ask"; category: Extract<ActionCategory, "confirm" | "destructive"> };

export function decideCommand(
  db: SqliteDatabase | undefined,
  projectId: string | undefined,
  command: string,
): CommandDecision {
  const tier = categorize(command);
  if (tier === "blocked") {
    return { action: "deny", category: "blocked", reason: "this command is on the blocklist and can never run" };
  }
  if (tier === "destructive") {
    // Hard rule: destructive operations ALWAYS ask — an "always allow" rule
    // never bypasses them.
    return { action: "ask", category: "destructive" };
  }
  if (tier === "auto") {
    return { action: "run", category: "auto", reason: "read-only/build/test command (auto-approved)" };
  }
  if (db !== undefined && projectId !== undefined && hasApprovalRule(db, projectId, command.trim())) {
    return { action: "run", category: "rule", reason: "always-allow rule for this project" };
  }
  return { action: "ask", category: "confirm" };
}

export function riskNote(action: string): string {
  return `[${categorize(action)}] review before approving: ${action}`;
}

/* ── Persistence ───────────────────────────────────────────────────────────── */

export interface ApprovalRow {
  id: string;
  sessionId: string | null;
  agentId: string | null;
  projectId: string | null;
  toolCall: string;
  category: string;
  status: string;
  decidedBy: string | null;
  reason: string | null;
  remember: string | null;
  createdAt: string;
  decidedAt: string | null;
  expiresAt: string;
}

export function createApproval(
  db: SqliteDatabase,
  input: {
    sessionId: string;
    agentId: string;
    projectId?: string;
    toolCall: string;
    category: string;
  },
): ApprovalRow {
  const id = `appr_${randomUUID()}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO approvals (id, session_id, agent_id, project_id, tool_call, category, status, decided_by, reason, created_at, decided_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, NULL, ?)`,
  ).run(id, input.sessionId, input.agentId, input.projectId ?? null, input.toolCall, input.category, now, new Date(Date.now() + APPROVAL_TIMEOUT_MS).toISOString());
  return getApproval(db, id) as ApprovalRow;
}

export function getApproval(db: SqliteDatabase, id: string): ApprovalRow | undefined {
  const row = db
    .prepare(
      `SELECT id, session_id AS sessionId, agent_id AS agentId, project_id AS projectId,
              tool_call AS toolCall, category, status, decided_by AS decidedBy, reason,
              remember, created_at AS createdAt, decided_at AS decidedAt, expires_at
       FROM approvals WHERE id = ?`,
    )
    .get(id) as ApprovalRow | undefined;
  return row;
}

export function listApprovals(
  db: SqliteDatabase,
  filter: { status?: string; projectId?: string } = {},
): ApprovalRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.status !== undefined) {
    clauses.push("status = ?");
    params.push(filter.status);
  }
  if (filter.projectId !== undefined) {
    clauses.push("project_id = ?");
    params.push(filter.projectId);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return db
    .prepare(
      `SELECT id, session_id AS sessionId, agent_id AS agentId, project_id AS projectId,
              tool_call AS toolCall, category, status, decided_by AS decidedBy, reason,
              remember, created_at AS createdAt, decided_at AS decidedAt, expires_at
       FROM approvals ${where} ORDER BY created_at DESC`,
    )
    .all(...params) as ApprovalRow[];
}

export function setApprovalStatus(
  db: SqliteDatabase,
  id: string,
  status: "approved" | "denied" | "expired",
  remember?: "once" | "always",
  decidedBy = "owner",
): ApprovalRow | undefined {
  db.prepare(
    `UPDATE approvals SET status = ?, remember = ?, decided_by = ?, decided_at = ? WHERE id = ?`,
  ).run(status, remember ?? null, decidedBy, new Date().toISOString(), id);
  return getApproval(db, id);
}

/** Project-scoped "always allow" rules (EXACT command match). */
export function hasApprovalRule(db: SqliteDatabase, projectId: string, command: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM approval_rules WHERE project_id = ? AND command = ?")
      .get(projectId, command) !== undefined
  );
}

export function addApprovalRule(db: SqliteDatabase, projectId: string, command: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO approval_rules (id, project_id, command, created_at) VALUES (?, ?, ?, ?)",
  ).run(`rule_${randomUUID()}`, projectId, command, new Date().toISOString());
}

/** Boot sweep: crash-orphaned pending approvals fail closed (expired) —
 * and any in-process waiter wakes denied (no zombies). */
export function sweepStaleApprovals(db: SqliteDatabase): number {
  const now = new Date().toISOString();
  const stale = db
    .prepare(
      `SELECT id FROM approvals WHERE status = 'pending' AND expires_at != '' AND expires_at < ?`,
    )
    .all(now) as Array<{ id: string }>;
  for (const { id } of stale) {
    resolvePendingApproval(id, "denied");
  }
  const info = db
    .prepare(
      `UPDATE approvals SET status = 'expired', decided_by = 'system', decided_at = ?
       WHERE status = 'pending' AND expires_at != '' AND expires_at < ?`,
    )
    .run(now, now);
  return info.changes;
}

/* ── The interactive wait (in-process resolver map — no polling) ──────────── */

type PendingWaiter = {
  resolve: (decision: "approved" | "denied") => void;
};

const pendingWaiters = new Map<string, PendingWaiter>();

/** Resolve a waiting approval (called by POST /approvals/:id/decision). */
export function resolvePendingApproval(
  approvalId: string,
  decision: "approved" | "denied",
): boolean {
  const waiter = pendingWaiters.get(approvalId);
  if (waiter === undefined) return false;
  pendingWaiters.delete(approvalId);
  waiter.resolve(decision);
  return true;
}

/** Test/introspection helper. */
export function pendingApprovalCount(): number {
  return pendingWaiters.size;
}

export interface ApprovalRequestDeps {
  db: SqliteDatabase;
  sessionId: string;
  agentId: string;
  projectId?: string;
  /** Only INTERACTIVE streamed parent turns may wait for a decision; sync
   * turns + sub-agent children fail fast on non-auto commands. */
  interactive: boolean;
  /** SSE channel of the live turn (approval.requested/resolved ride it). */
  emit?: (event: unknown) => void;
  /** Client abort — the waiter races it (deny on abort, fail-closed). */
  signal?: AbortSignal;
  /** Persisted-event writer (the folded log renders the exchange). */
  appendEvent?: (event: { type: "approval.requested" | "approval.resolved"; agentId: string; payload: Record<string, unknown> }) => void;
}

export interface ApprovalGateOutcome {
  allowed: boolean;
  note: string;
}

/**
 * The run_command gate: decide → (auto/rule: run) | (blocked: deny) |
 * (ask: create the approval, notify the owner, and WAIT — up to
 * APPROVAL_TIMEOUT_MS, racing the abort signal; timeout/abort = denied).
 */
export async function requestCommandApproval(
  deps: ApprovalRequestDeps,
  command: string,
): Promise<ApprovalGateOutcome> {
  const { db } = deps;
  const decision = decideCommand(db, deps.projectId, command);

  if (decision.action === "deny") {
    return { allowed: false, note: `command blocked: ${decision.reason}. Blocked: ${BLOCKED_PREFIXES.slice(0, 6).join(", ")}…` };
  }
  if (decision.action === "run") {
    return { allowed: true, note: decision.reason };
  }

  if (!deps.interactive) {
    return {
      allowed: false,
      note: "this command needs the owner's interactive approval, which is only available in a live streamed session — stick to read-only/build/test commands or ask the owner to run it themselves",
    };
  }

  // ASK — create the approval row + notify + wait.
  const approval = createApproval(db, {
    sessionId: deps.sessionId,
    agentId: deps.agentId,
    projectId: deps.projectId,
    toolCall: command,
    category: decision.category,
  });
  const requested = {
    type: "approval.requested" as const,
    approvalId: approval.id,
    toolName: "run_command",
    argsSummary: command,
    category: decision.category,
  };
  deps.emit?.(requested);
  deps.appendEvent?.({ type: "approval.requested", agentId: deps.agentId, payload: { ...requested } });
  logApproval("requested", approval.id, { sessionId: deps.sessionId, command, category: decision.category });

  const finalDecision = await new Promise<"approved" | "denied">((resolve) => {
    let settled = false;
    const finish = (d: "approved" | "denied") => {
      if (settled) return;
      settled = true;
      pendingWaiters.delete(approval.id);
      clearTimeout(timer);
      deps.signal?.removeEventListener("abort", onAbort);
      resolve(d);
    };
    pendingWaiters.set(approval.id, { resolve: finish });
    const timer = setTimeout(() => finish("denied"), APPROVAL_TIMEOUT_MS);
    const onAbort = () => finish("denied");
    deps.signal?.addEventListener("abort", onAbort, { once: true });
  });

  let remember: "once" | "always" | undefined;
  if (finalDecision === "approved") {
    const after = getApproval(db, approval.id);
    remember = after?.remember === "always" ? "always" : "once";
    if (remember === "always" && deps.projectId !== undefined && decision.category !== "destructive") {
      addApprovalRule(db, deps.projectId, command.trim());
    }
  } else {
    const after = getApproval(db, approval.id);
    if (after?.status === "pending") {
      // aborted/timed out — mark expired so the audit trail says why
      setApprovalStatus(db, approval.id, "expired", undefined, "system");
    }
  }

  const resolved = {
    type: "approval.resolved" as const,
    approvalId: approval.id,
    decision: finalDecision,
    ...(remember !== undefined ? { remember } : {}),
  };
  deps.emit?.(resolved);
  deps.appendEvent?.({ type: "approval.resolved", agentId: deps.agentId, payload: { ...resolved } });
  logApproval("resolved", approval.id, { sessionId: deps.sessionId, decision: finalDecision, remember });

  if (finalDecision === "approved") {
    return { allowed: true, note: remember === "always" ? "approved (always for this project)" : "approved by the owner" };
  }
  return { allowed: false, note: "command denied by the owner (or the approval timed out) — ask for a different approach" };
}
