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
 *
 * ROUND-64 (R64-d): (1) buildApprovalDeps' permissionMode is now a LIVE
 * GETTER re-reading the session row — mid-turn mode changes reach the
 * in-flight turn's gates (see tools/approval-deps.ts); (2) the AUTO list
 * grew with provably read-only search/inspection + Windows commands, and
 * matching runs on a whitespace-normalized, word-boundary-checked copy (the
 * ORIGINAL command still flows to execution untouched).
 */
import { randomUUID } from "node:crypto";
import type { PermissionMode, ToolPermission } from "shared";
import type { SqliteDatabase } from "./storage/db.js";
import { logApproval } from "./lib/log.js";
import { appendSessionEvent } from "./storage/sessions.js";
// ROUND-40: permission requests publish an app-level notification so the user
// sees the prompt even if they're not watching the chat (the owner: "after
// requesting a permission, and various other things, make sure to add this
// notification functionality").
import { getNotificationBus } from "./lib/notification-bus.js";

/** Risk tier for a prospective tool action. */
export type ActionCategory = ToolPermission | "destructive";

export const APPROVAL_TIMEOUT_MS = 120_000;

/** Read-only + build/test commands eligible for automatic execution.
 * ROUND-37 amendment #1: `npm install`, `git commit`, `git add`, `yarn`,
 * `pip`, `go run` etc. MOVED to "ask" (first use; rule-able afterwards);
 * `env` (dumps non-keyring secrets) and `echo` (pointless as an agent tool)
 * were dropped from auto entirely.
 *
 * ROUND-64 (R64-d, owner: "for normal safe commands it does not need to
 * ask for permission… like for search commands"): the read-only set grew to
 * cover the commands the agent actually runs on the owner's WINDOWS
 * machine + the common search tools. Every entry is PROVABLY read-only —
 * no writes, no network, no installs, no arbitrary code execution
 * (sed/awk/powershell -command/wmic/xargs/tee are deliberately NOT here;
 * fd/find exec-style flags are demoted separately — see hasFdFindExecFlag).
 * Entries are matched on a WORD BOUNDARY (matchesAutoPrefix: end or space
 * after the entry), so bare `rg` finally auto-runs and "rgx" does not;
 * they carry no trailing spaces anymore. */
const AUTO_PREFIXES: readonly string[] = [
  // listing / reading / searching
  "ls", "dir", "cat", "type", "head", "tail", "wc", "find", "grep", "rg", "which", "where",
  // ROUND-64 (R64-d): search/navigation + inspection tools (read-only)
  "fd", "ag", "ack", "command -v", "whereis", "file", "stat", "du", "df",
  "tree", "more", "fc", "md5sum", "sha256sum", "uname", "whoami",
  // ROUND-64 (R64-d): Windows/PowerShell READ-ONLY cmdlets + probes
  "get-childitem", "get-content", "get-item", "get-process", "get-service",
  "get-date", "get-command", "select-string", "findstr", "tasklist",
  "systeminfo", "ver",
  // version probes
  "node --version", "npm --version", "pnpm --version", "python --version", "python3 --version",
  // read-only git
  "git status", "git diff", "git log", "git branch", "git show", "git tag",
  // ROUND-64 (R64-d): read-only git extras
  "git grep", "git remote -v", "git ls-files", "git stash list",
  "git describe", "git rev-parse", "git shortlog", "git blame",
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

/** ROUND-64 (R64-d): prefix match on the WORD BOUNDARY — the entry must be
 * followed by end-of-string or a space. Bare `rg` auto-runs, `rg pattern`
 * auto-runs, but "rgx" / "rgexec" do NOT (the old "rg " trailing-space
 * entry missed the bare form; a bare "rg" entry without a boundary check
 * would over-match). */
function matchesAutoPrefix(lowered: string, prefix: string): boolean {
  if (!lowered.startsWith(prefix)) return false;
  return lowered.length === prefix.length || lowered[prefix.length] === " ";
}

/** ROUND-64 (R64-d): fd and find have EXEC/DELETE/FILE-WRITE flag forms
 * (`fd -x rm`, `find . -delete`, `find . -name x -exec rm {} ;`) that turn a
 * "read-only search" into arbitrary execution — this round's own safety
 * review of the widened list. Those forms demote the auto tier to ASK
 * (fail-closed); plain searches stay auto. */
function hasFdFindExecFlag(normalized: string): boolean {
  const tokens = normalized.split(" ");
  if (tokens[0] !== "fd" && tokens[0] !== "find") return false;
  return tokens.slice(1).some(
    (token) =>
      token === "-x" || token === "-X" || token === "--exec" || token === "--exec-batch" ||
      token === "-exec" || token === "-execdir" || token === "-ok" || token === "-okdir" ||
      token === "-delete" || token === "-fprint" || token === "-fprint0" ||
      token === "-fprintf" || token === "-fls",
  );
}

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

/**
 * Split a command on shell separators (&&, ||, ;, |, newline, backtick,
 * $(…)). Used by the compound-command guard: prefix matching on the WHOLE
 * string is bypassable ("pnpm test && curl …"), so compounds are analyzed
 * segment-wise and NEVER auto-run.
 */
function splitCompound(command: string): string[] {
  return command
    .split(/&&|\|\||[;|\n\r`]|\$\(/g)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
}

/** ROUND-64 (R64-d): the MATCHING copy of a command — leading/trailing
 * whitespace stripped, internal runs collapsed to single spaces, lowercased.
 * The ORIGINAL string is untouched and still flows to execution — only the
 * matching copy is normalized — so "git  remote -v" (double space) matches
 * the "git remote -v" prefix, "RG  PATTERN" matches "rg", and multi-word
 * prefixes stay robust. */
function normalizeForMatch(action: string): string {
  return action.trim().replace(/\s+/g, " ").toLowerCase();
}

/** The policy tier for a command (pure — no DB, no environment). */
export function categorize(action: string): ActionCategory {
  // ROUND-64 (R64-d): normalization for MATCHING only (see normalizeForMatch).
  const normalized = normalizeForMatch(action);
  const segments = splitCompound(normalized);
  if (segments.length > 1) {
    // REVIEW B1 (compound bypass): a compound command can hide a blocked
    // tail behind an auto head ("cat x; sudo …"). Segment-wise: any blocked
    // segment blocks the whole; destructive escalates; NEVER auto (the
    // owner sees the full command and decides — fail-closed).
    let worst: ActionCategory = "auto";
    for (const segment of segments) {
      const tier = categorize(segment); // segments are simple — no recursion depth
      if (tier === "blocked") return "blocked";
      if (tier === "destructive") worst = "destructive";
      else if (tier === "confirm" && worst === "auto") worst = "confirm";
    }
    return worst === "auto" ? "confirm" : worst;
  }
  if (hasRecursiveOrForceRm(normalized)) return "blocked";
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(normalized)) return "blocked";
  }
  if (BLOCKED_PREFIXES.some((p) => normalized.startsWith(p))) return "blocked";
  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(normalized)) return "destructive";
  }
  // ROUND-64 (R64-d): word-boundary matching + the fd/find exec-flag demotion.
  if (AUTO_PREFIXES.some((p) => matchesAutoPrefix(normalized, p))) {
    return hasFdFindExecFlag(normalized) ? "confirm" : "auto";
  }
  return "confirm";
}

/** The layered decision every run_command passes through. */
export type CommandDecision =
  | { action: "deny"; category: "blocked"; reason: string }
  | { action: "run"; category: "auto" | "rule"; reason: string }
  | { action: "ask"; category: Extract<ActionCategory, "confirm" | "destructive"> };

/* ── ROUND-45 (audit P0-4): path containment for the AUTO tier ─────────────── */

/**
 * Does any path-looking token in the command resolve OUTSIDE the project
 * root? (P0-4: the read-only auto tier — ls/cat/grep/find/head/tail/… —
 * could touch ANY file on the machine: `cat /etc/passwd`, `cat ~/.ssh/id_rsa`
 * all auto-ran before this. Now such commands demote to ASK; the owner's
 * explicit "always allow" rules and interactive approval still work.)
 *
 * Token model is deliberately conservative (fail-closed):
 *   - `~/…`             → outside (home is never inside a project)
 *   - absolute POSIX /… → inside only if under root
 *   - Windows drive X:\… (or X:/…) → inside only if under root (normalized,
 *     case-insensitive — Windows paths are)
 *   - relative token containing `..` segments → resolved against root and
 *     checked (`cat ../x` demotes; `cat a/../b` stays — it equals root/b)
 *   - flags (`-x`, `--long`) are skipped UNLESS they carry `=path` (then the
 *     value is checked)
 *   - everything else (bare names, ./rel, globs without ..) → inside
 * Quoted tokens are unquoted first (single or double quotes, one level).
 */
export function commandTouchesOutsideRoot(command: string, root: string): boolean {
  const segments = splitCompound(command);
  for (const segment of segments.length > 0 ? segments : [command]) {
    for (const rawToken of segment.split(/\s+/)) {
      const token = unquote(rawToken);
      if (token === "") continue;
      const candidate = token.startsWith("-") && token.includes("=") ? token.slice(token.indexOf("=") + 1) : token;
      if (candidate === "" || candidate === "-") continue;
      if (isOutside(candidate, root)) return true;
    }
  }
  return false;
}

function unquote(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return token.slice(1, -1);
    }
  }
  return token;
}

/** Absolute-path + home + ..-escape check for ONE token (POSIX + Windows). */
function isOutside(token: string, root: string): boolean {
  // Home-relative paths can never be inside the project root.
  if (token === "~" || token.startsWith("~/") || token.startsWith("~\\")) return true;
  const normalizedRoot = normalizePath(root);
  // Windows drive-letter paths.
  if (/^[a-zA-Z]:[\\/]/.test(token)) {
    const normalized = resolveDots(normalizePath(token));
    // A drive path is inside a drive-letter root only (case-insensitive).
    if (/^[a-zA-Z]:\//.test(normalizedRoot)) {
      const resolvedRoot = resolveDots(normalizedRoot);
      return !normalized.startsWith(resolvedRoot + "/");
    }
    // Root is POSIX (dev sandbox running a windows-shaped token): outside.
    return true;
  }
  // Absolute POSIX paths.
  if (token.startsWith("/")) {
    return !resolveDots(normalizePath(token)).startsWith(resolveDots(normalizedRoot) + "/");
  }
  // Relative: only `..` segments can escape — resolve them mentally.
  if (token.includes("..")) {
    const parts = normalizePath(token).split("/");
    const stack: string[] = [];
    for (const part of parts) {
      if (part === "" || part === ".") continue;
      if (part === "..") {
        if (stack.length === 0) return true; // escaped the root
        stack.pop();
      } else {
        stack.push(part);
      }
    }
  }
  return false;
}

/** Lexically resolve `.` and `..` segments in a normalized (slash, lc) path
 *  so `/root/../etc/x` is correctly seen as OUTSIDE `/root`. */
function resolveDots(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function decideCommand(
  db: SqliteDatabase | undefined,
  projectId: string | undefined,
  command: string,
  /** ROUND-45 (P0-4): the project root — when provided, AUTO-tier commands
   * touching paths outside it demote to ASK (fail-closed; rules stay
   * authoritative — the owner may explicitly allow anything). */
  root?: string,
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
    // ROUND-45 (P0-4): the AUTO tier is path-contained. A read-only command
    // touching anything outside the project root (`cat /etc/passwd`,
    // `cat ~/.ssh/id_rsa`, `head ../secrets.env`) demotes to ASK — fail
    // closed. An explicit project "always allow" rule for the exact command
    // still wins (the owner already decided).
    if (root !== undefined && commandTouchesOutsideRoot(command, root)) {
      if (db !== undefined && projectId !== undefined && hasApprovalRule(db, projectId, command.trim())) {
        return { action: "run", category: "rule", reason: "always-allow rule for this project" };
      }
      return { action: "ask", category: "confirm" };
    }
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
      `SELECT id, session_id AS sessionId, agent_id AS agentId FROM approvals
       WHERE status = 'pending' AND expires_at != '' AND expires_at < ?`,
    )
    .all(now) as Array<{ id: string; sessionId: string | null; agentId: string | null }>;
  for (const row of stale) {
    resolvePendingApproval(row.id, "denied");
    // R37 review #6: persist the resolution so the folded log doesn't render
    // a "waiting…" card forever after a crash.
    if (row.sessionId !== null && row.agentId !== null) {
      appendSessionEvent(db, row.sessionId, {
        type: "approval.resolved",
        agentId: row.agentId,
        payload: { approvalId: row.id, decision: "expired" },
      });
    }
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
  /** ROUND-50 (R50-c1, the composer's permission-mode switcher): the
   * session's standing posture. In "full" mode every ASK-tier decision
   * auto-approves WITHOUT waiting (the owner pre-trusted the session); the
   * DENYLIST-SUPREME refusals (decideCommand/decideWebFetch "deny") are
   * checked BEFORE this and are NEVER bypassed in any mode. Undefined /
   * "ask" / "plan" / "editor" keep today's ask-tier behavior exactly. */
  permissionMode?: PermissionMode;
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
  /** ROUND-45 (P0-4): project root for AUTO-tier path containment. */
  opts?: { root?: string },
): Promise<ApprovalGateOutcome> {
  const { db } = deps;
  const decision = decideCommand(db, deps.projectId, command, opts?.root);

  if (decision.action === "deny") {
    return { allowed: false, note: `command blocked: ${decision.reason}. Blocked: ${BLOCKED_PREFIXES.slice(0, 6).join(", ")}…` };
  }
  if (decision.action === "run") {
    return { allowed: true, note: decision.reason };
  }

  // ROUND-50 (R50-c1): FULL ACCESS mode — every ask-tier decision
  // auto-approves without waiting. Checked AFTER the denylist-supreme
  // refusal above (sudo / rm -rf / curl &c. NEVER run in any mode) and
  // after the explicit auto/rule tiers (already "run"). Allowlists stay
  // authoritative: mode only widens within what the session may do.
  if (deps.permissionMode === "full") {
    return {
      allowed: true,
      note: "auto-approved (session is in Full Access mode)",
    };
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
  // ROUND-40: push a permission_request notification so the user is alerted
  // even when the chat window isn't focused. The body carries the command +
  // category so the toast is actionable; the approval modal still does the
  // actual Allow/Deny round-trip in the chat.
  getNotificationBus().publish(deps.db, {
    kind: "permission_request",
    title: `Permission requested: ${decision.category}`,
    body: command.slice(0, 160),
    sessionId: deps.sessionId,
    projectId: deps.projectId,
  });

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

/* ── ROUND-45 (audit P0-5): web-tool gating (web_fetch + browser_control) ──── */

/**
 * Curated hosts the agent may fetch WITHOUT asking. Documentation, package
 * registries and source hosts — the everyday reading list of a coding agent.
 * Exact-host matches only (fail-closed: a.example.com is NOT covered by
 * example.com; www is checked as a sibling). The owner extends this per
 * project by choosing "Always allow" on a web approval card (web_host_rules).
 */
export const DEFAULT_WEB_HOST_ALLOWLIST: readonly string[] = [
  // source control + raw content
  "github.com",
  "raw.githubusercontent.com",
  "gist.github.com",
  "api.github.com",
  "gitlab.com",
  // JS ecosystem
  "npmjs.com",
  "www.npmjs.com",
  "registry.npmjs.org",
  "docs.npmjs.com",
  "react.dev",
  "vitejs.dev",
  "vitest.dev",
  "nextjs.org",
  "tanstack.com",
  "tailwindcss.com",
  // TS / JS core docs
  "typescriptlang.org",
  "www.typescriptlang.org",
  "nodejs.org",
  "developer.mozilla.org",
  // Rust
  "rust-lang.org",
  "www.rust-lang.org",
  "doc.rust-lang.org",
  "docs.rs",
  "crates.io",
  "tauri.app",
  "v2.tauri.app",
  // Python
  "pypi.org",
  "docs.python.org",
  "packaging.python.org",
  // reference + search (the search tool's own endpoints)
  "duckduckgo.com",
  "html.duckduckgo.com",
  "lite.duckduckgo.com",
  // ROUND-65 (R65, owner directive: simple browsing needs no permission —
  // the owner was asked to approve a google.com NAVIGATION in the embedded
  // browser): the everyday search engines join the default allowlist. A
  // search results page is the same reading tier as the docs hosts above;
  // site-specific "always allow" stays owner-decided via the approval card.
  "google.com",
  "www.google.com",
  "bing.com",
  "www.bing.com",
  "en.wikipedia.org",
  "stackoverflow.com",
  "learn.microsoft.com",
  "developer.apple.com",
  "caniuse.com",
];

/** Project-scoped "always allow this host" rules (web_host_rules, 0016). */
export function hasWebHostRule(db: SqliteDatabase, projectId: string, host: string): boolean {
  return (
    db.prepare("SELECT 1 FROM web_host_rules WHERE project_id = ? AND host = ?").get(projectId, host) !==
    undefined
  );
}

export function addWebHostRule(db: SqliteDatabase, projectId: string, host: string): void {
  db.prepare("INSERT OR IGNORE INTO web_host_rules (id, project_id, host, created_at) VALUES (?, ?, ?, ?)").run(
    `whr_${randomUUID()}`,
    projectId,
    host,
    new Date().toISOString(),
  );
}

export function listWebHostRules(db: SqliteDatabase, projectId: string): string[] {
  return (
    db
      .prepare("SELECT host FROM web_host_rules WHERE project_id = ? ORDER BY created_at DESC")
      .all(projectId) as Array<{ host: string }>
  ).map((row) => row.host);
}

export type WebFetchDecision =
  | { action: "deny"; reason: string }
  | { action: "run"; category: "auto" | "rule"; reason: string }
  | { action: "ask"; host: string };

/** Host-shape normalization for rule matching (lowercase, strip trailing dot). */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * The layered decision every web_fetch / browser_control-navigate URL passes
 * through (P0-5). Pure given (db, projectId, url).
 */
export function decideWebFetch(
  db: SqliteDatabase | undefined,
  projectId: string | undefined,
  url: string,
): WebFetchDecision {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return { action: "deny", reason: "invalid URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { action: "deny", reason: `scheme "${parsed.protocol}" is not allowed (http/https only)` };
  }
  const host = normalizeHost(parsed.hostname);
  if (host === "") return { action: "deny", reason: "URL has no host" };
  if (db !== undefined && projectId !== undefined && hasWebHostRule(db, projectId, host)) {
    return { action: "run", category: "rule", reason: `host ${host} is always-allowed for this project` };
  }
  if (DEFAULT_WEB_HOST_ALLOWLIST.includes(host)) {
    return { action: "run", category: "auto", reason: `${host} is on the default documentation/source allowlist` };
  }
  return { action: "ask", host };
}

/**
 * The web_fetch / browser_control-navigate gate — the mirror of
 * requestCommandApproval for outbound HTTP. Ask-tier waits on the SAME
 * interactive approval round-trip (SSE card + notification + timeout);
 * "always allow" remembers the HOST (not the URL) via web_host_rules.
 */
export async function requestWebFetchApproval(
  deps: ApprovalRequestDeps,
  url: string,
  toolName: "web_fetch" | "browser_control" = "web_fetch",
): Promise<ApprovalGateOutcome> {
  const { db } = deps;
  const decision = decideWebFetch(db, deps.projectId, url);

  if (decision.action === "deny") {
    return { allowed: false, note: `request blocked: ${decision.reason}` };
  }
  if (decision.action === "run") {
    return { allowed: true, note: decision.reason };
  }

  // ROUND-50 (R50-c1): FULL ACCESS mode — a non-allowlisted host
  // auto-allows without asking (mirrors requestCommandApproval; the deny
  // cases above — invalid URL / non-http scheme — are never bypassed).
  if (deps.permissionMode === "full") {
    return {
      allowed: true,
      note: `auto-approved: ${decision.host} (session is in Full Access mode)`,
    };
  }

  if (!deps.interactive) {
    return {
      allowed: false,
      note: `fetching ${decision.host} needs the owner's interactive approval (not on the default allowlist) — stick to documentation/source hosts or ask the owner to allow it`,
    };
  }

  // ASK — same persistence + notification + wait machinery as commands.
  const approval = createApproval(db, {
    sessionId: deps.sessionId,
    agentId: deps.agentId,
    projectId: deps.projectId,
    toolCall: url.slice(0, 2000),
    category: "web",
  });
  const requested = {
    type: "approval.requested" as const,
    approvalId: approval.id,
    toolName,
    argsSummary: url.slice(0, 2000),
    category: "web",
  };
  deps.emit?.(requested);
  deps.appendEvent?.({ type: "approval.requested", agentId: deps.agentId, payload: { ...requested } });
  logApproval("requested", approval.id, { sessionId: deps.sessionId, command: url, category: "web" });
  getNotificationBus().publish(deps.db, {
    kind: "permission_request",
    title: "Permission requested: web",
    body: url.slice(0, 160),
    sessionId: deps.sessionId,
    projectId: deps.projectId,
  });

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
    if (remember === "always" && deps.projectId !== undefined) {
      // Remember the HOST — a per-URL rule would be nearly useless.
      addWebHostRule(db, deps.projectId, decision.host);
    }
  } else {
    const after = getApproval(db, approval.id);
    if (after?.status === "pending") {
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
    return {
      allowed: true,
      note: remember === "always" ? `approved — ${decision.host} always allowed for this project` : "approved by the owner",
    };
  }
  return { allowed: false, note: "web request denied by the owner (or the approval timed out)" };
}
