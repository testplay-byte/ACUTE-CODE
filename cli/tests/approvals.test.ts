/**
 * ROUND-107 (R107-c-impl, F9): the APPROVALS command units — `approvals ls`
 * over GET /approvals (the --status filter rides the query), `approvals
 * <id> approve|deny` over POST /approvals/:id/decision with the exact body
 * spelling {decision, remember?}, the usage/validation errors, and the
 * did-you-mean on a typo'd subcommand. Fetch stubbed — no server.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { colorKitFor } from "../src/color.js";
import type { Connection } from "../src/connection.js";
import type { CliContext } from "../src/context.js";
import { runApprovalsCommand } from "../src/commands/approvals.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const PLAIN_KIT = colorKitFor(false, {});

const CONN: Connection = {
  baseUrl: "http://127.0.0.1:4603",
  token: "approvals-token",
  source: "env",
  ownsSidecar: false,
  portalFile: null,
  port: 4603,
  spawned: null,
};

/** One GET /approvals row (agent-core ApprovalRow, camelCase aliases). */
const ROW = {
  id: "appr_11111111-2222-3333-4444-555555555555",
  sessionId: "s1",
  agentId: "a1",
  projectId: null,
  toolCall: "run_command(command: rm -rf /tmp/scratch)",
  category: "destructive",
  status: "pending",
  decidedBy: null,
  reason: null,
  remember: null,
  createdAt: "2026-09-18T01:02:03.456Z",
  decidedAt: null,
  expiresAt: "2026-09-18T01:04:03.456Z",
};

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function stubApi(json: unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({
        url: String(url),
        method: String(init?.method ?? "GET"),
        body: init?.body !== undefined ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify(json), { status: 200 });
    },
  );
  return calls;
}

function makeCtx(overrides: Partial<CliContext> = {}): CliContext {
  return {
    stdout: () => {},
    stderr: () => {},
    kit: PLAIN_KIT,
    plain: true,
    quiet: false,
    json: false,
    autoApprove: false,
    config: {},
    flags: {},
    repoRoot: "/repo",
    conn: CONN,
    ...overrides,
  };
}

describe("`approvals ls` (GET /approvals)", () => {
  it("renders the rows in the sessions-ls table style (id · status · category · toolCall · createdAt)", async () => {
    stubApi({ approvals: [ROW] });
    let out = "";
    let err = "";
    const code = await runApprovalsCommand(
      makeCtx({
        stdout: (s) => {
          out += s;
        },
        stderr: (s) => {
          err += s;
        },
      }),
      ["ls"],
    );
    expect(code).toBe(0);
    expect(err).toContain("1 approval(s)");
    expect(out).toContain(ROW.id.slice(0, 17)); // the id column truncates at 18
    expect(out).toContain("pending");
    expect(out).toContain("destructive");
    expect(out).toContain("run_command(command: rm -rf /tmp/scratch)");
    expect(out).toContain(ROW.createdAt);
  });

  it("--status pending rides the query string; a bare `approvals` lists too", async () => {
    const calls = stubApi({ approvals: [] });
    let out = "";
    const ctx = makeCtx({
      flags: { status: "pending" },
      stdout: (s) => {
        out += s;
      },
    });
    expect(await runApprovalsCommand(ctx, ["ls"])).toBe(0);
    expect(calls[0]?.url).toBe("http://127.0.0.1:4603/api/v1/approvals?status=pending");
    expect(out).toBe(""); // zero rows → header only (on stderr)
    const calls2 = stubApi({ approvals: [] });
    expect(await runApprovalsCommand(makeCtx(), [])).toBe(0); // default sub = ls
    expect(calls2[0]?.url).toBe("http://127.0.0.1:4603/api/v1/approvals");
  });

  it("an invalid --status is the honest usage error", async () => {
    stubApi({ approvals: [] });
    let err = "";
    const code = await runApprovalsCommand(
      makeCtx({
        flags: { status: "bogus" },
        stderr: (s) => {
          err += s;
        },
      }),
      ["ls"],
    );
    expect(code).toBe(1);
    expect(err).toContain("--status must be pending|approved|denied|expired (got 'bogus')");
  });

  it("--mode json prints the rows verbatim", async () => {
    stubApi({ approvals: [ROW] });
    let out = "";
    const code = await runApprovalsCommand(
      makeCtx({
        json: true,
        stdout: (s) => {
          out += s;
        },
      }),
      ["ls"],
    );
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ approvals: [ROW] });
  });
});

describe("`approvals <id> approve|deny` (POST /approvals/:id/decision)", () => {
  it("approve POSTs {decision:'approved'} and reports the effective remember", async () => {
    const calls = stubApi({ ok: true, decision: "approved", remember: "once" });
    let out = "";
    const code = await runApprovalsCommand(
      makeCtx({
        stdout: (s) => {
          out += s;
        },
      }),
      ["appr_123", "approve"],
    );
    expect(code).toBe(0);
    expect(calls[0]).toEqual({
      url: "http://127.0.0.1:4603/api/v1/approvals/appr_123/decision",
      method: "POST",
      body: { decision: "approved" },
    });
    expect(out).toContain("approval appr_123 approved (remember once)");
  });

  it("deny POSTs {decision:'denied'}; --remember rides the body when given", async () => {
    const calls = stubApi({ ok: true, decision: "denied", remember: "always" });
    let out = "";
    const code = await runApprovalsCommand(
      makeCtx({
        flags: { remember: "always" },
        stdout: (s) => {
          out += s;
        },
      }),
      ["appr_123", "deny"],
    );
    expect(code).toBe(0);
    expect(calls[0]?.body).toEqual({ decision: "denied", remember: "always" });
    expect(out).toContain("approval appr_123 denied (remember always)");
  });

  it("a missing id / a bad --remember / a typo'd verb are honest usage errors", async () => {
    stubApi({ ok: true });
    let err = "";
    const ctx = makeCtx({
      stderr: (s) => {
        err += s;
      },
    });
    expect(await runApprovalsCommand(ctx, ["approve"])).toBe(1);
    expect(err).toContain("usage:");
    err = "";
    expect(
      await runApprovalsCommand(makeCtx({ flags: { remember: "forever" }, stderr: (s) => (err += s) }), [
        "appr_1",
        "approve",
      ]),
    ).toBe(1);
    expect(err).toContain("--remember must be once or always (got 'forever')");
    err = "";
    expect(await runApprovalsCommand(makeCtx({ stderr: (s) => (err += s) }), ["appr_1", "aprove"])).toBe(1);
    expect(err).toContain("unknown approvals subcommand: aprove");
    expect(err).toContain("did you mean 'approve'?");
    expect(err).toContain("usage:");
  });
});
