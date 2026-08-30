// @vitest-environment node
//
// ROUND-52 (R52-a + R52-b): command-supervision + sub-agent-control tests.
//
// The owner's round-52 case (Windows): `taskkill /F /PID 16132` succeeded,
// then `start /B node server.js > server.log 2>&1` showed "running…" for
// 10+ minutes — Node's `close` never fired because the detached grandchild
// inherited the shell's pipe handles, and nothing ever checked status.
//
// This suite pins the new contract:
//   1. exec unit helpers (background-launch detection, log-redirect parsing)
//   2. THE HANG FIX — a grandchild holding the pipes resolves FAST with a
//      background-job note (cross-platform: node spawns node)
//   3. the hard watchdog — a silent command that never exits is killed and
//      resolved as a timeout
//   4. live output frames (onOutput) — the "terminal interface" of commands
//   5. the job_status / job_stop tools through the real toolset
//   6. the /jobs REST routes (list / status / stop / 404s)
//   7. the orchestrator child registry — POST-stop semantics on a child
//      (owner stop → honest "STOPPED BY THE OWNER" report to the parent)
//   8. the stall sampler (sampleChildWatch) — pure unit on synthetic events
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

const generateTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({
  generateText: generateTextMock,
  stepCountIs: (count: number) => ({ type: "stepCount", count }),
  jsonSchema: <T>(schema: T) => schema,
}));

import type { ChatFn, ChatTurnOutput } from "../src/agents/chat";
import { getOrchestrator, sampleChildWatch } from "../src/agents/orchestrator";
import { abortTurn, liveTurnIds } from "../src/lib/turn-registry";
import { clearJobsForTest, getJobStatus, listJobs, stopJob } from "../src/lib/background-jobs";
import { buildProjectTools } from "../src/tools/index";
import type { ToolSet } from "ai";
import {
  looksLikeBackgroundLaunch,
  parseLogRedirect,
  runCommand,
} from "../src/tools/exec";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";
import { appendSessionEvent, createSession } from "../src/storage/sessions";
import { createAgent } from "../src/storage/agents";

const TOKEN = "test-token-52";
const KEY = "sk-or-vtest-52a";

let tempDir = "";
let projectDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r52-"));
  projectDir = join(tempDir, `proj-${randomUUID()}`);
  mkdirSync(projectDir, { recursive: true });
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  app = buildServer({
    token: TOKEN,
    db,
    keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
  });
  clearJobsForTest();
  generateTextMock.mockReset();
});

afterEach(async () => {
  await app.close();
  db.close();
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

async function authInject(options: {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  payload?: Record<string, unknown>;
}): Promise<LightMyRequestResponse> {
  return (await app.inject({
    ...options,
    headers: { authorization: `Bearer ${TOKEN}` },
  })) as LightMyRequestResponse;
}

// The AI SDK tool contract — narrow to what the tests call (same shape
// memory-tools.test.ts uses).
type ExecutableTool = {
  execute: (input: Record<string, unknown>) => Promise<{ ok: boolean; output: string }>;
};
function tool(set: ToolSet, name: string): ExecutableTool {
  return (set as unknown as Record<string, ExecutableTool>)[name];
}

/** A node one-liner whose CHILD (grandchild of the shell) inherits the
 * shell's stdio pipes and lives for `ms` — the EXACT shape of the owner's
 * `start /B node server.js` trap, cross-platform (node spawns node). The
 * `.unref()` is what makes the launcher EXIT while the grandchild keeps
 * holding the inherited pipe write-ends (without it the libuv process
 * handle would keep the launcher alive until the grandchild dies — a
 * different, less insidious failure shape). */
const PIPE_HOLDER = (ms: number): string =>
  `node -e "const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},${ms})'],{stdio:['ignore','inherit','inherit']});c.unref();console.log('launcher done')"`;

describe("ROUND-52 (R52-a): exec helpers", () => {
  it("looksLikeBackgroundLaunch detects the launch idioms", () => {
    expect(looksLikeBackgroundLaunch("start /B node server.js > server.log 2>&1")).toBe(true);
    expect(looksLikeBackgroundLaunch("start node app.js")).toBe(true);
    expect(looksLikeBackgroundLaunch("echo hi && start /MIN thing.exe")).toBe(true);
    expect(looksLikeBackgroundLaunch("node server.js > log 2>&1 &")).toBe(true);
    expect(looksLikeBackgroundLaunch("nohup python -m http.server &")).toBe(true);
    expect(looksLikeBackgroundLaunch("echo hello")).toBe(false);
    expect(looksLikeBackgroundLaunch("npm test")).toBe(false);
    expect(looksLikeBackgroundLaunch("git status && git diff")).toBe(false); // && is NOT &
  });

  it("parseLogRedirect extracts the first file redirection, ignores 2>&1", () => {
    expect(parseLogRedirect("start /B node server.js > server.log 2>&1")).toBe("server.log");
    expect(parseLogRedirect("node app.js >> out.log 2>&1")).toBe("out.log");
    expect(parseLogRedirect("node app.js > \"my log.txt\"")).toBe("my log.txt");
    expect(parseLogRedirect("node app.js 2>&1")).toBeNull();
    expect(parseLogRedirect("echo hello")).toBeNull();
  });
});

describe("ROUND-52 (R52-a): the hang fix — pipe-holding grandchildren", () => {
  it(
    "resolves FAST (background job note) when a grandchild holds the pipes — the owner's exact trap",
    async () => {
      const startedAt = Date.now();
      const result = await runCommand(projectDir, PIPE_HOLDER(9000));
      const elapsed = Date.now() - startedAt;

      // The OLD code hung until the grandchild died (9s). The new contract:
      // the shell exits, the grace passes, the call resolves with a job id.
      expect(elapsed).toBeLessThan(6000);
      expect(result.output).toContain("[background job");
      expect(result.output).toContain("job_status");
      expect(result.output).toContain("job_stop");
      // The registry holds a RUNNING job (the grandchild still lives).
      const jobs = listJobs();
      expect(jobs.length).toBeGreaterThanOrEqual(1);
      const running = jobs.find((j) => j.alive);
      expect(running).toBeDefined();
      expect(running?.command).toContain("node");
      // The tool result carries the registered job id.
      const idMatch = result.output.match(/\[background job (j[0-9a-f]+)\]/);
      expect(idMatch).not.toBeNull();
      expect(getJobStatus(idMatch![1])?.alive).toBe(true);
    },
    20_000,
  );

  it("the job flips to exited once the grandchild dies (pipe watcher)", async () => {
    // The grandchild must outlive the 2.5s pipe grace for the background-job
    // path to fire at all; it then dies at ~4s and the pipe watcher must flip
    // the job to `exited`.
    const result = await runCommand(projectDir, PIPE_HOLDER(4000));
    const idMatch = result.output.match(/\[background job (j[0-9a-f]+)\]/);
    expect(idMatch).not.toBeNull();
    const id = idMatch![1];
    expect(getJobStatus(id)?.alive).toBe(true);
    // Poll for the flip (pipe closes when the grandchild dies).
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      if (getJobStatus(id)?.status === "exited") break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    expect(getJobStatus(id)?.status).toBe("exited");
    expect(getJobStatus(id)?.alive).toBe(false);
  }, 25_000);

  it(
    "hard watchdog: a silent never-exiting command is killed and resolved as a timeout",
    async () => {
      const startedAt = Date.now();
      const result = await runCommand(projectDir, "node -e \"setTimeout(()=>{},20000)\"", undefined, {
        timeoutMs: 700,
      });
      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeLessThan(6000);
      expect(result.ok).toBe(false);
      expect(result.output).toContain("[timeout]");
      expect(result.output).toContain("job_status");
    },
    15_000,
  );

  it("live output: onOutput receives the command's stdout chunks", async () => {
    const chunks: string[] = [];
    const result = await runCommand(projectDir, "node -e \"console.log('line-1');console.log('line-2')\"", undefined, {
      onOutput: (chunk) => chunks.push(chunk),
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("line-1");
    expect(result.output).toContain("line-2");
    const joined = chunks.join("");
    expect(joined).toContain("line-1");
    expect(joined).toContain("line-2");
  });

  it("normal commands keep the exact old contract (output + exit code line)", async () => {
    const ok = await runCommand(projectDir, "node -e \"console.log('sync-ok')\"");
    expect(ok.ok).toBe(true);
    expect(ok.output).toBe("sync-ok");
    const bad = await runCommand(projectDir, "node -e \"process.exit(3)\"");
    expect(bad.ok).toBe(false);
    expect(bad.output).toContain("[exit code: 3]");
  });

  // ROUND-52 follow-up (found in the live battery): the Unix `cmd > log 2>&1 &`
  // shape closes the pipes the instant the shell exits (the grandchild
  // redirected everything to the file) — the old code resolved silently with
  // "(no output)" and NO job, so the agent lost track of the detached process.
  // POSIX-only: cmd.exe does not understand `&` (that shell fails the launch —
  // the non-zero-exit path reports it as a normal failure by design).
  it.skipIf(process.platform === "win32")(
    "the Unix `&` + full-redirect shape registers a DETACHED job (group liveness + log tail) and job_stop kills the group",
    async () => {
      const logName = `detached-${randomUUID().slice(0, 8)}.log`;
      const result = await runCommand(
        projectDir,
        `node -e "setTimeout(()=>{console.log('late-line');},6000)" > ${logName} 2>&1 &`,
      );
      // Resolved FAST (the shell exits immediately — no hang) WITH a job id.
      expect(result.output).toContain("[background job");
      expect(result.output).toContain("started DETACHED");
      const idMatch = result.output.match(/\[background job (j[0-9a-f]+)\]/);
      expect(idMatch).not.toBeNull();
      const id = idMatch![1];

      const status = getJobStatus(id);
      expect(status?.detached).toBe(true);
      expect(status?.logFile).toBe(logName);
      // Liveness = the PROCESS GROUP probe (the launching shell is dead; the
      // 6s grandchild keeps the group non-empty).
      expect(status?.alive).toBe(true);
      expect(status?.status).toBe("running");

      // Stop kills the whole group — the job flips to exited, probe goes dead.
      const stopped = await stopJob(id);
      expect(stopped.ok).toBe(true);
      expect(getJobStatus(id)?.alive).toBe(false);
      expect(getJobStatus(id)?.status).toBe("exited");
    },
    20_000,
  );

  // The Windows/POSIX-neutral counter-case: a background-looking command whose
  // LAUNCH fails (non-zero shell exit) must NOT register a phantom job — the
  // failure is reported as a normal command result. (A POSIX `badcmd &`
  // backgrounded launch still exits the SHELL 0 — the dead grandchild is the
  // detached job's problem, honestly reported by job_status; the non-zero
  // shape is a nohup/can't-exec failure, which fails the foreground shell.)
  it("a failed background launch reports the failure instead of registering a job", async () => {
    const before = listJobs().length;
    // nohup matches the background-launch grammar; the command can't exec —
    // the shell itself fails with a non-zero code on BOTH platforms.
    const result = await runCommand(projectDir, "nohup definitely-not-a-command-xyz > nope.log 2>&1");
    expect(result.ok).toBe(false);
    expect(result.output).not.toContain("[background job");
    expect(listJobs().length).toBe(before);
  }, 15_000);
});

describe("ROUND-52 (R52-a): job_status / job_stop tools + REST routes", () => {
  it("the tools exist in the full toolset and job_status lists tracked jobs", async () => {
    const launch = await runCommand(projectDir, PIPE_HOLDER(4000));
    expect(launch.output).toContain("[background job");

    const tools = await buildProjectTools(projectDir);
    expect(tools.job_status).toBeDefined();
    expect(tools.job_stop).toBeDefined();

    const listRes = await tool(tools, "job_status").execute({});
    expect(listRes.ok).toBe(true);
    expect(listRes.output).toContain("RUNNING");

    const idMatch = launch.output.match(/\[background job (j[0-9a-f]+)\]/);
    const oneRes = await tool(tools, "job_status").execute({ job: idMatch![1] });
    expect(oneRes.ok).toBe(true);
    expect(oneRes.output).toContain("launcher done");
    expect(oneRes.output).toContain("command:");

    const missing = await tool(tools, "job_status").execute({ job: "jnope000" });
    expect(missing.ok).toBe(false);
  }, 15_000);

  it("job_stop reports honestly for an already-exited job", async () => {
    // The grandchild outlives the grace (job registers), then dies — stop
    // must then report "already exited".
    const launch = await runCommand(projectDir, PIPE_HOLDER(4000));
    const idMatch = launch.output.match(/\[background job (j[0-9a-f]+)\]/);
    expect(idMatch).not.toBeNull();
    const id = idMatch![1];
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      if (getJobStatus(id)?.status === "exited") break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    const tools = await buildProjectTools(projectDir);
    const res = await tool(tools, "job_stop").execute({ job: id });
    expect(res.ok).toBe(true);
    expect(res.output).toContain("already exited");
  }, 25_000);

  it("REST routes: list, single status, 404s", async () => {
    const launch = await runCommand(projectDir, PIPE_HOLDER(5000));
    const idMatch = launch.output.match(/\[background job (j[0-9a-f]+)\]/);
    const id = idMatch![1];

    const listRes = await authInject({ method: "GET", url: "/api/v1/jobs" });
    expect(listRes.statusCode).toBe(200);
    const listBody = listRes.json() as { jobs: Array<{ id: string }> };
    expect(listBody.jobs.some((j) => j.id === id)).toBe(true);

    const oneRes = await authInject({ method: "GET", url: `/api/v1/jobs/${id}` });
    expect(oneRes.statusCode).toBe(200);
    expect((oneRes.json() as { job: { command: string } }).job.command).toContain("node");

    const missing = await authInject({ method: "GET", url: "/api/v1/jobs/jnope000" });
    expect(missing.statusCode).toBe(404);
    const stopMissing = await authInject({ method: "POST", url: "/api/v1/jobs/jnope000/stop" });
    expect(stopMissing.statusCode).toBe(404);
  }, 15_000);
});

describe("ROUND-52 (R52-b): sub-agent stop + supervisor", () => {
  it("a running child registers in the turn registry; owner stop aborts it and the parent gets an honest report", async () => {
    const agent = createAgent(db, {
      name: "R52-orchestrator",
      providerId: "openrouter",
      model: "test/r52-1",
    });
    const parent = createSession(db, { agentId: agent.id, mode: "single" });
    const orchestrator = getOrchestrator();

    // A chat fn that takes ~1.5s (long enough for the stop to land mid-turn
    // but not so long the test drags). The turn aborts BETWEEN iterations.
    const slowChat: ChatFn = async (): Promise<ChatTurnOutput> => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return {
        text: "child partial work",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        toolCalls: [],
      };
    };

    let stoppedChildId: string | null = null;
    const frames: Array<Record<string, unknown>> = [];
    const emit = (event: unknown): void => {
      const frame = event as Record<string, unknown>;
      frames.push(frame);
      // On the first RUNNING frame, stop the child like the UI's Stop
      // button would (POST /sessions/:id/stop → abortTurn(id, "owner")).
      if (
        stoppedChildId === null &&
        frame.type === "subagent-status" &&
        frame.status === "running"
      ) {
        stoppedChildId = frame.sessionId as string;
        expect(liveTurnIds()).toContain(stoppedChildId);
        expect(abortTurn(stoppedChildId, "owner")).toBe(true);
      }
    };

    const result = await orchestrator.delegateTask(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat: slowChat },
      parent.id,
      "long task that gets stopped",
      "researcher",
      emit,
    );

    expect(stoppedChildId).not.toBeNull();
    // The registry entry is cleaned up in the finally block.
    expect(liveTurnIds()).not.toContain(stoppedChildId);
    // The parent's tool result is the honest stop report.
    expect(result.ok).toBe(false);
    expect(result.output).toContain("STOPPED BY THE OWNER");
    // The terminal status frame carries the detail line for the UI.
    const failedFrame = frames.find((f) => f.type === "subagent-status" && f.status === "failed");
    expect(failedFrame).toBeDefined();
    expect(failedFrame?.detail).toBe("stopped by the owner");
  }, 15_000);

  it("sampleChildWatch: fresh events = healthy, old events = stalled (the stall signal)", () => {
    const agent = createAgent(db, { name: "r52-sampler", providerId: "openrouter", model: "m" });
    const session = createSession(db, { agentId: agent.id, mode: "single" });
    appendSessionEvent(db, session.id, {
      type: "tool.use",
      agentId: agent.id,
      payload: { role: "tool", toolName: "run_command", argsSummary: "command: node server.js", ok: true },
    });
    const now = Date.now();
    // Fresh: the last event is ~now → not stalled.
    const healthy = sampleChildWatch(db, session.id, now, 300_000, 1, 3);
    expect(healthy.stalled).toBe(false);
    expect(healthy.lastActivity).toContain("run_command");
    expect(healthy.lastActivity).toContain("node server.js");
    expect(healthy.toolCount).toBe(1);
    expect(healthy.todosDone).toBe(1);
    expect(healthy.todosTotal).toBe(3);

    // Stalled: an event 10 minutes old exceeds the 5-minute threshold.
    // Rewrite the event's timestamp through the storage layer's raw table.
    db.prepare("UPDATE session_events SET ts = ? WHERE session_id = ?")
      .run(new Date(now - 10 * 60_000).toISOString().replace("T", " ").replace("Z", ""), session.id);
    const stalled = sampleChildWatch(db, session.id, now - 10 * 60_000, 300_000, 0, 3);
    expect(stalled.stalled).toBe(true);
    expect(stalled.lastEventAgeMs).toBeGreaterThan(9 * 60_000);

    // Empty session: "waiting for its first model response", age 0 → healthy.
    const empty = createSession(db, { agentId: agent.id, mode: "single" });
    const freshEmpty = sampleChildWatch(db, empty.id, now, 300_000, 0, 0);
    expect(freshEmpty.stalled).toBe(false);
    expect(freshEmpty.lastActivity).toBe("waiting for its first model response");
  });
});
