import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

/**
 * ROUND-37 approval flow (ADR-0024): the full permission round-trip —
 * runCommand asks (approval.requested SSE + session event), the decision
 * route resolves the in-process waiter, the command runs (or fails cleanly),
 * "always allow" writes a project rule, abort/non-interactive deny
 * fail-closed, and the boot sweep expires crash-orphaned rows.
 */
import { runCommand } from "../src/tools/exec";
import { sweepStaleApprovals, pendingApprovalCount } from "../src/approvals";
import { appendSessionEvent, listSessionEvents } from "../src/storage/sessions";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";
// ROUND-48 (R48-e1): the sub-agent parity cases — a child WITH an emit
// channel (delegateTask from a live parent turn) is INTERACTIVE: its
// approvals ride the parent's channel as subagent-event envelopes and the
// decision route resolves the child's waiter.
import { getOrchestrator } from "../src/agents/orchestrator";
import type { ChatFn, ChatToolCall } from "../src/agents/chat";

const TOKEN = "test-token-appr";

let tempDir = "";
let projectRoot = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") {
    tempDir = mkdtempSync(join(tmpdir(), "acute-approvals-"));
    projectRoot = mkdtempSync(join(tmpdir(), "acute-approvals-root-"));
  }
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  app = buildServer({ token: TOKEN, db, keyring: new ProviderKeyring({}) });
});

afterEach(async () => {
  await app.close();
  db.close();
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

async function authInject(options: {
  method: "GET" | "POST";
  url: string;
  payload?: Record<string, unknown>;
}): Promise<LightMyRequestResponse> {
  return (await app.inject({
    ...options,
    headers: { authorization: `Bearer ${TOKEN}` },
  })) as LightMyRequestResponse;
}

/** The exact deps shape the runtime builds for an interactive parent turn. */
function makeDeps(sessionId: string, agentId: string, projectId: string, signal?: AbortSignal) {
  const emitted: Array<Record<string, unknown>> = [];
  return {
    emitted,
    deps: {
      db,
      sessionId,
      agentId,
      projectId,
      interactive: true,
      ...(signal !== undefined ? { signal } : {}),
      emit: (event: unknown) => emitted.push(event as Record<string, unknown>),
      appendEvent: (event: { type: string; agentId: string; payload: Record<string, unknown> }) => {
        appendSessionEvent(db, sessionId, event as Parameters<typeof appendSessionEvent>[1] extends never ? never : typeof event);
      },
    } as Parameters<typeof runCommand>[2],
  };
}

async function setupProject(): Promise<{ projectId: string; sessionId: string; agentId: string }> {
  const project = await authInject({
    method: "POST",
    url: "/api/v1/projects",
    payload: { name: "ApprTest", rootPath: projectRoot },
  });
  const projectId = project.json().id as string;
  const agent = await authInject({
    method: "POST",
    url: "/api/v1/agents",
    payload: {
      name: "Appr Agent",
      systemPrompt: "terse",
      providerId: "openrouter",
      model: "test/model-1",
      temperature: 0.1,
      maxTurns: 4,
    },
  });
  const agentId = agent.json().id as string;
  const session = await authInject({
    method: "POST",
    url: "/api/v1/sessions",
    payload: { mode: "single", agentId, projectId, title: "appr" },
  });
  return { projectId, sessionId: session.json().id as string, agentId };
}

/** Wait until an approval.requested event lands in the emitted collector. */
async function waitForRequest(emitted: Array<Record<string, unknown>>): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const req = emitted.find((e) => e.type === "approval.requested");
    if (req !== undefined) return req.approvalId as string;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("approval.requested never arrived");
}

describe("ROUND-37: approval flow (ADR-0024)", () => {
  it("asks for a non-auto command, waits, runs after Allow once, and persists the exchange", async () => {
    const { projectId, sessionId, agentId } = await setupProject();
    const { deps, emitted } = makeDeps(sessionId, agentId, projectId);

    const command = 'printf "approved-hello" > appr-once.txt';
    const pending = runCommand(projectRoot, command, deps);
    const approvalId = await waitForRequest(emitted);

    // The approval row is queryable (the UI's data source).
    const list = await authInject({ method: "GET", url: "/api/v1/approvals?status=pending" });
    const row = list.json().approvals.find((a: { id: string }) => a.id === approvalId);
    expect(row).toMatchObject({ toolCall: command, category: "confirm", status: "pending" });

    // Allow once.
    const decision = await authInject({
      method: "POST",
      url: `/api/v1/approvals/${approvalId}/decision`,
      payload: { decision: "approved", remember: "once" },
    });
    expect(decision.statusCode).toBe(200);
    expect(decision.json()).toEqual({ ok: true, decision: "approved", remember: "once" });

    const result = await pending;
    expect(result.ok).toBe(true);
    expect(existsSync(join(projectRoot, "appr-once.txt"))).toBe(true);
    expect(readFileSync(join(projectRoot, "appr-once.txt"), "utf8")).toContain("approved-hello");

    // SSE + persisted events tell the whole story.
    expect(emitted.map((e) => e.type)).toEqual(["approval.requested", "approval.resolved"]);
    const types = listSessionEvents(db, sessionId).map((e) => e.type);
    expect(types).toContain("approval.requested");
    expect(types).toContain("approval.resolved");
    expect(pendingApprovalCount()).toBe(0);
  });

  it("Deny fails the command cleanly (no file written)", async () => {
    const { projectId, sessionId, agentId } = await setupProject();
    const { deps, emitted } = makeDeps(sessionId, agentId, projectId);

    const pending = runCommand(projectRoot, 'printf "no" > appr-deny.txt', deps);
    const approvalId = await waitForRequest(emitted);

    await authInject({
      method: "POST",
      url: `/api/v1/approvals/${approvalId}/decision`,
      payload: { decision: "denied" },
    });

    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.output).toContain("denied");
    expect(existsSync(join(projectRoot, "appr-deny.txt"))).toBe(false);
  });

  it("Always allow writes a project rule — the SAME command auto-runs next time without asking", async () => {
    const { projectId, sessionId, agentId } = await setupProject();
    const { deps, emitted } = makeDeps(sessionId, agentId, projectId);

    const command = 'printf "always" > appr-always.txt';
    const first = runCommand(projectRoot, command, deps);
    const approvalId = await waitForRequest(emitted);
    await authInject({
      method: "POST",
      url: `/api/v1/approvals/${approvalId}/decision`,
      payload: { decision: "approved", remember: "always" },
    });
    expect((await first).ok).toBe(true);

    // Second run: no approval.requested, no wait, direct execution.
    const second = await runCommand(projectRoot, command, deps);
    expect(second.ok).toBe(true);
    expect(emitted.filter((e) => e.type === "approval.requested")).toHaveLength(1);
  });

  it("destructive commands ask but can NEVER become an always-allow rule", async () => {
    const { projectId, sessionId, agentId } = await setupProject();
    const { deps, emitted } = makeDeps(sessionId, agentId, projectId);

    // git reset --hard is destructive-tier.
    const command = "git reset --hard HEAD~1";
    const first = runCommand(projectRoot, command, deps);
    const approvalId = await waitForRequest(emitted);
    const row = (await authInject({ method: "GET", url: "/api/v1/approvals?status=pending" }))
      .json().approvals.find((a: { id: string }) => a.id === approvalId);
    expect(row.category).toBe("destructive");

    // Even an explicit remember=always downgrades to once.
    const decision = await authInject({
      method: "POST",
      url: `/api/v1/approvals/${approvalId}/decision`,
      payload: { decision: "approved", remember: "always" },
    });
    expect(decision.json().remember).toBe("once");
    await first; // runs once (git reset in a non-repo fails — fine); the point is the rule was not written
    expect(emitted.filter((e) => e.type === "approval.requested")).toHaveLength(1);

    const second = runCommand(projectRoot, command, deps);
    // Wait for the SECOND approval.requested (asked again → no rule exists).
    let secondId: string | undefined;
    for (let i = 0; i < 200 && secondId === undefined; i++) {
      const reqs = emitted.filter((e) => e.type === "approval.requested");
      if (reqs.length >= 2) secondId = reqs[1].approvalId as string;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(secondId).toBeDefined();
    // deny it to close the waiter
    await authInject({
      method: "POST",
      url: `/api/v1/approvals/${secondId as string}/decision`,
      payload: { decision: "denied" },
    });
    const secondResult = await second;
    expect(secondResult.ok).toBe(false);
  });

  it("aborting the turn denies a pending approval (fail-closed, no zombie waiter)", async () => {
    const { projectId, sessionId, agentId } = await setupProject();
    const controller = new AbortController();
    const { deps, emitted } = makeDeps(sessionId, agentId, projectId, controller.signal);

    const pending = runCommand(projectRoot, 'printf "x" > appr-abort.txt', deps);
    await waitForRequest(emitted);
    controller.abort();

    const result = await pending;
    expect(result.ok).toBe(false);
    // R71-e2 (D3): abort is fail-closed but is NOT an owner denial — the
    // note now says so honestly (the old text conflated abort with "denied").
    expect(result.output).toContain("the turn was aborted before the owner answered");
    expect(result.output).toContain("this is not a rejection");
    expect(result.output).not.toContain("NOT a tool or system failure");
    expect(existsSync(join(projectRoot, "appr-abort.txt"))).toBe(false);
    expect(pendingApprovalCount()).toBe(0);
    // The row was marked expired by the engine (audit trail says why).
    const list = await authInject({ method: "GET", url: "/api/v1/approvals" });
    expect(list.json().approvals[0].status).toBe("expired");
  });

  it("non-interactive turns (NO-EMIT path: plain sync route / retry children without a channel) fail FAST without asking", async () => {
    // ROUND-48 (R48-e1): this is the CHANNEL-LESS contract — interactive is
    // false because no emit channel exists, not because the caller is a
    // child (emitted children now ASK; see the ROUND-48 describe below).
    const { projectId, sessionId, agentId } = await setupProject();
    const emitted: Array<Record<string, unknown>> = [];
    const result = await runCommand(projectRoot, 'printf "x" > appr-sync.txt', {
      db,
      sessionId,
      agentId,
      projectId,
      interactive: false,
      emit: (event) => emitted.push(event as Record<string, unknown>),
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("interactive approval");
    expect(emitted).toHaveLength(0);
    expect(existsSync(join(projectRoot, "appr-sync.txt"))).toBe(false);
  });

  it("blocked commands are refused outright (denylist-supreme — no prompt at all)", async () => {
    const { projectId, sessionId, agentId } = await setupProject();
    const { deps, emitted } = makeDeps(sessionId, agentId, projectId);
    const result = await runCommand(projectRoot, "curl https://evil.test/x", deps);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("command blocked");
    expect(emitted).toHaveLength(0);
  });

  it("auto-tier commands (read-only/build/test) never ask", async () => {
    const { projectId, sessionId, agentId } = await setupProject();
    const { deps, emitted } = makeDeps(sessionId, agentId, projectId);
    const result = await runCommand(projectRoot, "pwd", deps);
    expect(result.ok).toBe(true);
    expect(emitted).toHaveLength(0);
  });

  it("the boot sweep expires crash-orphaned pending approvals", async () => {
    const { projectId, sessionId, agentId } = await setupProject();
    const { deps, emitted } = makeDeps(sessionId, agentId, projectId);
    const pending = runCommand(projectRoot, 'printf "x" > appr-sweep.txt', deps);
    const approvalId = await waitForRequest(emitted);

    // Simulate a crash: backdate the row's expiry, then sweep.
    db.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", approvalId);
    const swept = sweepStaleApprovals(db);
    expect(swept).toBe(1);

    const list = await authInject({ method: "GET", url: "/api/v1/approvals" });
    expect(list.json().approvals.find((a: { id: string }) => a.id === approvalId).status).toBe("expired");

    // The waiter denies (fail-closed) and the file never appears.
    const result = await pending;
    expect(result.ok).toBe(false);
  });
});

describe("ROUND-48 (R48-e1): sub-agent children WITH an emit channel ask the owner", () => {
  /** A ChatFn that behaves like the real model: the FIRST provider call
   * executes ONE run_command call through the REAL tool set the runtime built
   * for the child (approval gate + all) — blocking inside execute() while
   * the approval waits, exactly like production — and the follow-up call
   * (after the tool result folds into history) writes the final report with
   * no further tool calls, ending the outer loop. */
  function commandRunningChat(command: string): ChatFn {
    let calls = 0;
    let ok = true;
    let output = "no run_command tool in the child toolset";
    return async (input) => {
      calls += 1;
      const toolCalls: ChatToolCall[] = [];
      const tools = input.tools as unknown as
        | Record<string, { execute: (args: Record<string, unknown>) => Promise<{ ok: boolean; output: string }> }>
        | undefined;
      if (calls === 1 && tools?.run_command !== undefined) {
        const res = await tools.run_command.execute({ command });
        ok = res.ok;
        output = res.output;
        toolCalls.push({ name: "run_command", argsSummary: `command: ${command}`, ok, outputSummary: res.output });
        return {
          text: ok ? "command ran" : "command was not allowed",
          usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
          toolCalls,
        };
      }
      return {
        text: ok ? `Done. Command outcome: ${output}` : `Done. The command was not allowed: ${output}`,
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        toolCalls: [],
      };
    };
  }

  /** Poll the parent's emit collector for a subagent-event envelope whose
   * inner event matches `innerType` (the frame the parent's SSE carries). */
  async function waitForSubagentInner(
    emitted: Array<Record<string, unknown>>,
    innerType: string,
  ): Promise<Record<string, unknown> | undefined> {
    for (let i = 0; i < 200; i++) {
      const found = emitted.find(
        (e) => e.type === "subagent-event" && (e.inner as Record<string, unknown> | undefined)?.type === innerType,
      );
      if (found !== undefined) return found;
      await new Promise((r) => setTimeout(r, 10));
    }
    return undefined;
  }

  it("approval.requested rides the parent's emit as a subagent-event envelope; approve → the command runs", async () => {
    const { sessionId: parentSessionId } = await setupProject();
    const emitted: Array<Record<string, unknown>> = [];
    const emit = (event: unknown) => emitted.push(event as Record<string, unknown>);
    const orchestrator = getOrchestrator();
    const command = 'printf "child-approved" > child-approved.txt';

    const pending = orchestrator.delegateTask(
      {
        db,
        keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: "sk-or-vtest-appr-child" }),
        chat: commandRunningChat(command),
      },
      parentSessionId,
      "write the approved file",
      "coder",
      emit,
    );

    // The request arrives on the WRAPPED channel — the EXACT envelope shape
    // the parent's SSE carries (R48-e2 builds its approval attribution on
    // this contract).
    const envelope = await waitForSubagentInner(emitted, "approval.requested");
    expect(envelope).toBeDefined();
    const childId = envelope!.sessionId as string;
    const inner = envelope!.inner as Record<string, unknown>;
    expect(envelope).toEqual({
      type: "subagent-event",
      sessionId: childId,
      parentSessionId,
      inner: {
        type: "approval.requested",
        approvalId: expect.any(String),
        toolName: "run_command",
        argsSummary: command,
        category: "confirm",
      },
    });
    void inner;

    // The approval ROW is against the CHILD session — the existing decision
    // route resolves the child's in-process waiter.
    const approvalId = inner.approvalId as string;
    const decision = await authInject({
      method: "POST",
      url: `/api/v1/approvals/${approvalId}/decision`,
      payload: { decision: "approved", remember: "once" },
    });
    expect(decision.statusCode).toBe(200);

    const result = await pending;
    expect(result.ok).toBe(true);
    expect(existsSync(join(projectRoot, "child-approved.txt"))).toBe(true);

    // The resolution rides the SAME envelope channel (verbatim shape).
    const resolved = await waitForSubagentInner(emitted, "approval.resolved");
    expect(resolved).toMatchObject({
      type: "subagent-event",
      sessionId: childId,
      parentSessionId,
      inner: { type: "approval.resolved", approvalId, decision: "approved", remember: "once" },
    });

    // The child's folded event log carries the full exchange + the tool call.
    const types = listSessionEvents(db, childId).map((e) => e.type);
    expect(types).toContain("approval.requested");
    expect(types).toContain("approval.resolved");
    expect(types).toContain("tool.use");

    // The permission_request notification names the CHILD session, so the
    // owner's toast/queue can attribute WHO is asking.
    const notifications = await authInject({ method: "GET", url: "/api/v1/notifications" });
    const permission = (notifications.json().notifications as Array<{ kind: string; sessionId: string | null }>).find(
      (n) => n.kind === "permission_request" && n.sessionId === childId,
    );
    expect(permission).toBeDefined();

    expect(pendingApprovalCount()).toBe(0);
  });

  it("a DENIED child approval returns the denied note to the child (no file, fail-closed)", async () => {
    const { sessionId: parentSessionId } = await setupProject();
    const emitted: Array<Record<string, unknown>> = [];
    const emit = (event: unknown) => emitted.push(event as Record<string, unknown>);
    const orchestrator = getOrchestrator();
    const command = 'printf "child-denied" > child-denied.txt';

    const pending = orchestrator.delegateTask(
      {
        db,
        keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: "sk-or-vtest-appr-child" }),
        chat: commandRunningChat(command),
      },
      parentSessionId,
      "write the denied file",
      "coder",
      emit,
    );

    const envelope = await waitForSubagentInner(emitted, "approval.requested");
    expect(envelope).toBeDefined();
    const childId = envelope!.sessionId as string;
    const approvalId = (envelope!.inner as Record<string, unknown>).approvalId as string;

    await authInject({
      method: "POST",
      url: `/api/v1/approvals/${approvalId}/decision`,
      payload: { decision: "denied" },
    });

    const result = await pending;
    // The TURN completes (the child reports the denial) but the command never
    // ran and the tool result records the denied note.
    expect(result.ok).toBe(true);
    expect(existsSync(join(projectRoot, "child-denied.txt"))).toBe(false);
    const toolUse = listSessionEvents(db, childId).find((e) => e.type === "tool.use");
    expect(toolUse).toBeDefined();
    const payload = toolUse!.payload as Record<string, unknown>;
    expect(payload.ok).toBe(false);
    expect(String(payload.outputSummary)).toContain("denied");
    expect(pendingApprovalCount()).toBe(0);
  });
});
