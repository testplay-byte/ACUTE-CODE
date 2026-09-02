/**
 * ROUND-64 (R64-d): the LIVE permissionMode getter in buildApprovalDeps.
 *
 * Owner: "If I changed the permissions midway, like from ask to full access,
 * then it should properly get applied for the next runs of commands and
 * other stuff." runtime.ts's prepareTurn snapshots session.permissionMode
 * ONCE per turn into toolDeps (a turn can run for minutes), while the PATCH
 * /sessions/:id/permissions route (updateSessionPermissionMode) writes the
 * new mode to the DB mid-turn — the snapshot never saw it, so the in-flight
 * turn's approval gates kept the OLD posture. buildApprovalDeps therefore
 * exposes permissionMode as a LIVE GETTER (re-reads the session row via the
 * sessions storage; falls back to the turn-captured value when the row is
 * absent or the read throws — fail-closed, never a widening default).
 * runtime.ts itself is untouched (another agent owns it this round); the
 * getter is transparent to every consumer reading deps.permissionMode at
 * decision time (approvals.ts ~496/~730), and nothing spreads the deps
 * object (a spread would snapshot the value).
 *
 * Pinned here:
 *  1. an "ask"-captured turn whose session row flips to "full" MID-FLIGHT
 *     auto-approves the next ask-tier gate (no approval row, no wait);
 *  2. flipping BACK to "ask" re-arms the gate (fail-closed both directions);
 *  3. a missing session row falls back to the turn-captured value;
 *  4. no row + no captured value → undefined (ask-tier semantics — the
 *     getter never widens);
 *  5. runCommand end-to-end: the same deps execute an ask-tier command
 *     without waiting once the row says "full".
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { requestCommandApproval, listApprovals } from "../src/approvals";
import { runCommand } from "../src/tools/exec";
import { buildApprovalDeps } from "../src/tools/approval-deps";
import type { ToolDeps } from "../src/tools/index";
import { createSession, updateSessionPermissionMode } from "../src/storage/sessions";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";

let tempDir = "";
let db: SqliteDatabase;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-approval-deps-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/** The toolDeps prepareTurn would build for an interactive "ask" turn. */
function turnDeps(sessionId: string, permissionMode: "ask" | "full"): ToolDeps {
  return {
    db,
    sessionId,
    agentId: "agt_r64d",
    interactiveApprovals: true,
    permissionMode,
  };
}

describe("buildApprovalDeps: LIVE permissionMode (ROUND-64 R64-d)", () => {
  it("a mid-flight ask→full flip auto-approves the turn's next ask-tier gate — no approval row, no wait", async () => {
    const session = createSession(db, { agentId: "agt_r64d", mode: "single" }); // default "ask"
    const deps = buildApprovalDeps(turnDeps(session.id, "ask"));
    // The getter re-reads the ROW, not the snapshot…
    expect(deps.permissionMode).toBe("ask");

    // …the owner flips the mode mid-turn (PATCH /sessions/:id/permissions).
    updateSessionPermissionMode(db, session.id, "full");
    expect(deps.permissionMode).toBe("full");

    // The turn is still in flight — its NEXT gate sees the new mode:
    // `git commit` is ask-tier, and full access auto-approves it.
    const gate = await requestCommandApproval(deps, "git commit -m 'mid-flight flip'");
    expect(gate.allowed).toBe(true);
    expect(gate.note).toContain("Full Access mode");
    // No approval row was ever created (the auto-approve path).
    expect(listApprovals(db, {})).toHaveLength(0);
  });

  it("flipping BACK to ask re-arms the gate (the live read is fail-closed both directions)", async () => {
    const session = createSession(db, { agentId: "agt_r64d", mode: "single" });
    const deps = buildApprovalDeps(turnDeps(session.id, "ask"));
    updateSessionPermissionMode(db, session.id, "full");
    expect(deps.permissionMode).toBe("full");
    updateSessionPermissionMode(db, session.id, "ask");
    expect(deps.permissionMode).toBe("ask");

    // Non-interactive deps + ask mode → the ask tier fails fast (proving the
    // full-mode widening is gone the moment the row says so).
    const deps2 = buildApprovalDeps({ ...turnDeps(session.id, "ask"), interactiveApprovals: false });
    const gate = await requestCommandApproval(deps2, "git commit -m 'back to ask'");
    expect(gate.allowed).toBe(false);
    expect(gate.note).toContain("interactive approval");
  });

  it("a MISSING session row falls back to the turn-captured value (error/absence = fail-closed)", async () => {
    // "sess_missing" has no row — the getter must yield the snapshot.
    const deps = buildApprovalDeps(turnDeps("sess_missing", "full"));
    expect(deps.permissionMode).toBe("full");
    const gate = await requestCommandApproval(deps, "git commit -m 'captured value'");
    expect(gate.allowed).toBe(true);
    expect(gate.note).toContain("Full Access mode");
  });

  it("no row AND no captured value → undefined (ask-tier semantics; the getter never widens)", () => {
    const deps = buildApprovalDeps({ db, sessionId: "sess_missing", agentId: "agt_r64d" });
    expect(deps.permissionMode).toBeUndefined();
  });

  it("runCommand end-to-end: after the mid-flight flip the turn EXECUTES an ask-tier command without waiting", async () => {
    const session = createSession(db, { agentId: "agt_r64d", mode: "single" });
    const deps = buildApprovalDeps(turnDeps(session.id, "ask")); // captured "ask"
    updateSessionPermissionMode(db, session.id, "full"); // the mid-turn PATCH

    // "node -e …" is ask-tier (not on the auto list) — pre-R64 this build of
    // deps would have created an approval and hung on the 120s wait.
    const result = await runCommand(tempDir, "node -e \"process.stdout.write('r64d-live')\"", deps);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("r64d-live");
    expect(result.output).not.toContain("not approved");
    expect(listApprovals(db, {})).toHaveLength(0);
  });
});
