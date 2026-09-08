// @vitest-environment node
//
// ROUND-71 (R71-e2): TOOL RELIABILITY — the R71-d design's D1–D5 pins
// (research: cline's progressive failure escalation + rejection semantics +
// overflow recovery; kilocode's exact-continuation truncation notices):
//   D1. read_file truncation markers carry the TOTAL line count + the EXACT
//       next call ("use offset=N to continue"); the degenerate single-line
//       cap says honestly that no continuation call exists; run_command's
//       middle-omission marker teaches the redirect-to-file recovery.
//   D2. edit_file anchor failures escalate per-session (cline's 3-tier:
//       2nd re-read → 3rd/4th change approach → 5th+ refuse) and reset on
//       any successful edit.
//   D3. owner DENIALS are user feedback, not tool/system failures; approval
//       TIMEOUTS get their own honest note (never conflated with a denial).
//   D4. classifyProviderError covers all six classes (incl. message-based
//       context-window detection and the rate-limit veto).
//   D5. a provider-side context-window overflow triggers ONE forced
//       compaction + retry; a second overflow fails honestly; non-overflow
//       errors never trigger compaction.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { createProject } from "../src/storage/projects";
import { createAgent } from "../src/storage/agents";
import { appendSessionEvent, createSession, listSessionEvents } from "../src/storage/sessions";
import { readFileWindow } from "../src/tools/fs-ops";
import { runCommand } from "../src/tools/exec";
import { buildProjectTools, type ToolDeps } from "../src/tools/index";
import {
  editFailureSuffix,
  editStreakCount,
  isEditAnchorFailure,
  recordEditFailure,
  resetEditStreaksForTest,
} from "../src/tools/edit-streak";
import {
  APPROVAL_TIMEOUT_MS,
  requestCommandApproval,
  requestWebFetchApproval,
  resolvePendingApproval,
  setApprovalStatus,
  type ApprovalRequestDeps,
} from "../src/approvals";
import { computerUsePlugin } from "../src/tools/plugins/computer-use";
import { setComputerUseSettings } from "../src/storage/computer-use";
import {
  classifyProviderError,
  runSingleAgentTurn,
  runStreamedAgentTurn,
  type ProviderErrorClass,
} from "../src/agents/runtime";
import { assembleWithCompaction, planCompaction, type SeqMessage } from "../src/agents/compaction";
import type { ChatFn, ChatTurnMessage, StreamChatFn, StreamChatEvent } from "../src/agents/chat";
import { ProviderKeyring } from "../src/providers/registry";
import type { ToolSet } from "ai";

const KEY = "sk-r71-reliability";
let tempDir = "";
let db: SqliteDatabase;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r71-"));
  resetEditStreaksForTest();
});

afterAll(() => {
  db?.close();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// The AI SDK tool contract — narrow to what the tests call.
type ExecutableTool = {
  description: string;
  execute: (input: Record<string, unknown>) => Promise<{ ok: boolean; output: string }>;
};
function tool(set: ToolSet, name: string): ExecutableTool {
  return (set as unknown as Record<string, ExecutableTool>)[name];
}

/* ── D1: exact-continuation truncation markers ─────────────────────────────── */

describe("R71-e2 D1: read_file truncation markers teach the exact next call", () => {
  const mk = (i: number): string => `L${i}-` + "z".repeat(96);

  it("the >256KB marker carries the byte count, boundary lines, TOTAL line count, and offset=<first omitted line>", () => {
    // 3000 lines × 103 bytes ≈ 309KB — over the 256KB cap.
    const content = Array.from({ length: 3000 }, (_, i) => mk(i + 1)).join("\n") + "\n";
    writeFileSync(join(tempDir, "r71-big.txt"), content, "utf8");
    const result = readFileWindow(tempDir, "r71-big.txt");
    expect(result.ok).toBe(true);
    const output = result.output;

    // The full kilocode contract: "…N bytes omitted between line A and line B
    // of T total — use offset=C to continue…" with T = the file's total.
    const marker = output.match(
      /…\[file truncated: (\d+) bytes omitted between line (\d+) and line (\d+) of (\d+) total — use offset=(\d+) to continue\]…/,
    );
    expect(marker).not.toBeNull();
    const [, , lastHeadLine, firstTailLine, total, continueFrom] = marker!.map(Number);
    expect(total).toBe(3000);
    // The exact next call is the FIRST OMITTED line — one past the kept head…
    expect(continueFrom).toBe(lastHeadLine + 1);
    // …strictly before the kept tail (which the model already has).
    expect(continueFrom).toBeLessThan(firstTailLine);

    // The marker's promise is REAL: calling read_file with exactly the
    // promised offset returns the first omitted line.
    const middle = readFileWindow(tempDir, "r71-big.txt", { offset: continueFrom, limit: 1 });
    expect(middle.ok).toBe(true);
    expect(middle.output).toBe(` ${String(continueFrom).padStart(5)}  ${mk(continueFrom)}`);
    // …and that line was genuinely omitted from the truncated read.
    expect(output).not.toContain(`${String(continueFrom).padStart(6)}  ${mk(continueFrom)}`);
  });

  it("the degenerate single-line cap: totals + byte semantics + an HONEST no-continuation statement", () => {
    writeFileSync(join(tempDir, "r71-one-line.txt"), "A".repeat(300_000), "utf8");
    const result = readFileWindow(tempDir, "r71-one-line.txt");
    expect(result.ok).toBe(true);
    const output = result.output;
    // Total line count…
    expect(output).toContain("of line 1 of 1 total");
    // …byte semantics (first/last 32KB of THE LINE kept)…
    expect(output).toContain("single line: first 32768 + last 32768 bytes kept");
    // …and the honest admission that offset/limit cannot page this middle
    // (it pages whole LINES) plus a real recovery tool.
    expect(output).toContain("no continuation call can reach this middle");
    expect(output).toContain("use search_code (content match) or run_command (grep) to inspect it");
  });

  it("the offset-past-EOF error still reports line totals (verified, kept from R70)", () => {
    writeFileSync(join(tempDir, "r71-five.txt"), ["one", "two", "three", "four", "five"].join("\n") + "\n", "utf8");
    const past = readFileWindow(tempDir, "r71-five.txt", { offset: 99 });
    expect(past.ok).toBe(false);
    expect(past.output).toBe("offset 99 is beyond end of file ('r71-five.txt' has 5 lines)");
  });

  it("the read_file TOOL description mentions the continuation hint", async () => {
    const tools = await buildProjectTools(tempDir);
    const desc = tool(tools, "read_file").description;
    expect(desc).toContain("use offset=N to continue");
  });

  it(
    "run_command's middle-omission marker teaches the redirect-to-file recovery (byte semantics kept)",
    async () => {
      const result = await runCommand(
        tempDir,
        "node -e \"process.stdout.write('HEAD' + 'x'.repeat(70000) + 'TAIL')\"",
      );
      expect(result.ok).toBe(true);
      // Byte semantics unchanged…
      expect(result.output).toContain("…[output truncated: 4472 bytes omitted from the middle");
      expect(result.output).toContain("the first 32KB and the last 32KB are kept");
      // …plus the recovery guidance for the omitted middle.
      expect(result.output).toContain("the tail is included");
      expect(result.output).toContain(
        "if the failure you need is in the omitted middle, re-run with output redirected to a file and read_file it in slices",
      );
    },
    15_000,
  );
});

/* ── D2: edit-failure escalation (cline's progressive tiers) ───────────────── */

describe("R71-e2 D2: edit-failure escalation — the pure tiers", () => {
  it("tier boundaries: 1st silent, 2nd re-read, 3rd/4th change approach, 5th+ refuse the pattern", () => {
    // First failure: the base error is already honest — no suffix.
    expect(editFailureSuffix(1)).toBe("");
    // 2nd: re-read + copy the anchor EXACTLY.
    expect(editFailureSuffix(2)).toBe(
      " (2nd consecutive edit failure — re-read the file with read_file and copy the anchor EXACTLY from the current content.)",
    );
    // 3rd: MUST change the approach.
    expect(editFailureSuffix(3)).toBe(
      " (3rd consecutive edit failure — you MUST change your approach: read_file the exact region, or use write_file to rewrite the whole file. Do not retry the same anchor.)",
    );
    // 4th: the same tier, honestly numbered.
    expect(editFailureSuffix(4)).toContain("4th consecutive edit failure");
    expect(editFailureSuffix(4)).toContain("you MUST change your approach");
    // 5th: refuse the pattern.
    expect(editFailureSuffix(5)).toBe(
      " (5th consecutive edit failure — refusing this pattern. Stop editing: read_file the file fresh, state the actual current content region containing your target, and choose edit_file with a verified anchor or write_file.)",
    );
    // Beyond: the same tier with the true ordinal (never a stale "5th").
    expect(editFailureSuffix(6)).toContain("6th consecutive edit failure");
    expect(editFailureSuffix(6)).toContain("refusing this pattern");
  });

  it("isEditAnchorFailure: only fs-ops' 'edit failed:' outcomes count (a missing file has its own remedy)", () => {
    expect(isEditAnchorFailure({ ok: false, output: "edit failed: oldString not found in 'a.ts'" })).toBe(true);
    expect(isEditAnchorFailure({ ok: false, output: "edit failed: oldString matches 2 times in 'a.ts' — provide a longer unique anchor" })).toBe(true);
    expect(isEditAnchorFailure({ ok: false, output: "cannot edit 'a.ts': no such file" })).toBe(false);
    expect(isEditAnchorFailure({ ok: false, output: "path escapes the project root (got '../x')" })).toBe(false);
    expect(isEditAnchorFailure({ ok: true, output: "edited 'a.ts' (1 replacement)" })).toBe(false);
  });

  it("the counter caps at 999 (no unbounded growth; the ordinal stays honest)", () => {
    const session = "r71-cap-session";
    for (let i = 0; i < 1_100; i++) recordEditFailure(session);
    expect(editStreakCount(session)).toBe(999);
    expect(editFailureSuffix(editStreakCount(session))).toContain("999th consecutive edit failure");
  });
});

describe("R71-e2 D2: edit-failure escalation — through the real toolset", () => {
  let tools: ToolSet;
  // A REAL session row: the successful-edit path records a file snapshot
  // (file_snapshots has an FK on session_id — a fake id would throw).
  const sessionDeps = {
    db: null as unknown as ToolDeps["db"],
    sessionId: "r71-d2-session",
    agentId: "r71-d2-agent",
  } as ToolDeps;

  beforeEach(async () => {
    db?.close();
    db = openDatabase(join(tempDir, `${randomUUID()}.db`));
    const agent = createAgent(db, { name: "R71 D2 Agent", providerId: "openrouter", model: "test/r71-1" });
    sessionDeps.db = db;
    sessionDeps.sessionId = createSession(db, { agentId: agent.id, mode: "single" }).id;
    writeFileSync(join(tempDir, "edit-target.txt"), "alpha\nbeta\ngamma\n", "utf8");
    tools = await buildProjectTools(join(tempDir), undefined, sessionDeps);
  });

  const session = (): string => sessionDeps.sessionId;

  it("consecutive anchor failures escalate (2nd → 3rd → 5th) and append AFTER the honest base error", async () => {
    const edit = tool(tools, "edit_file");
    // 1st failure: base error only, no escalation suffix.
    const first = await edit.execute({ path: "edit-target.txt", oldString: "nope", newString: "x" });
    expect(first.ok).toBe(false);
    expect(first.output).toBe("edit failed: oldString not found in 'edit-target.txt'");
    // 2nd failure: tier-2 suffix appended to the SAME base error.
    const second = await edit.execute({ path: "edit-target.txt", oldString: "nope", newString: "x" });
    expect(second.ok).toBe(false);
    expect(second.output).toBe(
      "edit failed: oldString not found in 'edit-target.txt' (2nd consecutive edit failure — re-read the file with read_file and copy the anchor EXACTLY from the current content.)",
    );
    // 3rd: change-approach tier.
    const third = await edit.execute({ path: "edit-target.txt", oldString: "still nope", newString: "x" });
    expect(third.output).toContain("3rd consecutive edit failure");
    expect(third.output).toContain("you MUST change your approach");
    // 4th and 5th keep escalating honestly.
    await edit.execute({ path: "edit-target.txt", oldString: "still nope", newString: "x" });
    const fifth = await edit.execute({ path: "edit-target.txt", oldString: "still nope", newString: "x" });
    expect(fifth.ok).toBe(false);
    expect(fifth.output).toContain("5th consecutive edit failure — refusing this pattern");
    // ok:false with the guidance as the output — the loop contract holds.
    expect(fifth.output).toContain("edit failed:");
  });

  it("a SUCCESSFUL edit resets the streak (a later failure starts from 1 again)", async () => {
    const edit = tool(tools, "edit_file");
    // Two failures arm the escalation…
    await edit.execute({ path: "edit-target.txt", oldString: "nope", newString: "x" });
    await edit.execute({ path: "edit-target.txt", oldString: "nope", newString: "x" });
    expect(editStreakCount(session())).toBe(2);
    // …a successful edit (matching anchor) proves the file view is current…
    const success = await edit.execute({ path: "edit-target.txt", oldString: "beta", newString: "BETA" });
    expect(success.ok).toBe(true);
    expect(editStreakCount(session())).toBe(0);
    // …so the NEXT failure is a first failure again — base error only.
    const after = await edit.execute({ path: "edit-target.txt", oldString: "nope", newString: "x" });
    expect(after.output).toBe("edit failed: oldString not found in 'edit-target.txt'");
  });

  it("a missing FILE (not an anchor failure) never escalates", async () => {
    const edit = tool(tools, "edit_file");
    for (let i = 0; i < 6; i++) {
      const missing = await edit.execute({ path: "does-not-exist.txt", oldString: "a", newString: "b" });
      expect(missing.output).toBe("cannot edit 'does-not-exist.txt': no such file");
    }
    expect(editStreakCount(session())).toBe(0);
  });

  it("bare builds (no toolDeps → no session) never escalate", async () => {
    const bare = await buildProjectTools(join(tempDir));
    const edit = tool(bare, "edit_file");
    const first = await edit.execute({ path: "edit-target.txt", oldString: "nope", newString: "x" });
    const second = await edit.execute({ path: "edit-target.txt", oldString: "nope", newString: "x" });
    expect(first.output).toBe(second.output);
    expect(second.output).not.toContain("consecutive edit failure");
  });
});

/* ── D3: rejection semantics — denial ≠ timeout ≠ failure ─────────────────── */

describe("R71-e2 D3: owner denials are user feedback, not tool failures", () => {
  beforeEach(() => {
    db?.close();
    db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  });

  /** The exact interactive deps shape the runtime builds for a live turn. */
  const makeDeps = (emit: (event: unknown) => void): ApprovalRequestDeps => ({
    db,
    sessionId: "r71-d3-session",
    agentId: "r71-d3-agent",
    interactive: true,
    emit,
  });

  /** Wait until an approval.requested event lands in the collector. */
  const waitForRequest = async (emitted: Array<Record<string, unknown>>): Promise<string> => {
    for (let i = 0; i < 100; i++) {
      const req = emitted.find((e) => e.type === "approval.requested");
      if (req !== undefined) return String(req.approvalId);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("no approval.requested event arrived");
  };

  it("an owner DENY on a command: 'NOT a tool or system failure' + ask-why guidance (ok:false stays)", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const pending = requestCommandApproval(makeDeps((e) => emitted.push(e as Record<string, unknown>)), 'printf "x" > r71-deny.txt');
    const approvalId = await waitForRequest(emitted);
    // The exact sequence POST /approvals/:id/decision runs (persist first,
    // then wake the waiter) — a persisted "denied" is the user-Deny evidence.
    setApprovalStatus(db, approvalId, "denied", undefined, "owner");
    resolvePendingApproval(approvalId, "denied");
    const outcome = await pending;
    expect(outcome.allowed).toBe(false);
    expect(outcome.note).toBe(
      "command denied by the owner — this is NOT a tool or system failure. The action was not performed. Ask the user why (one line), or propose an alternative approach.",
    );
  });

  it("an owner DENY on a web request carries the same semantics", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const pending = requestWebFetchApproval(makeDeps((e) => emitted.push(e as Record<string, unknown>)), "https://example-not-allowlisted.com/doc");
    const approvalId = await waitForRequest(emitted);
    setApprovalStatus(db, approvalId, "denied", undefined, "owner");
    resolvePendingApproval(approvalId, "denied");
    const outcome = await pending;
    expect(outcome.allowed).toBe(false);
    expect(outcome.note).toContain("web request denied by the owner");
    expect(outcome.note).toContain("this is NOT a tool or system failure");
    expect(outcome.note).toContain("Ask the user why (one line), or propose an alternative approach.");
  });

  it("an approval TIMEOUT gets its own honest note — never a denial (no 'NOT a failure' text, no rejection claim)", async () => {
    vi.useFakeTimers();
    try {
      const emitted: Array<Record<string, unknown>> = [];
      const pending = requestCommandApproval(makeDeps((e) => emitted.push(e as Record<string, unknown>)), 'printf "x" > r71-timeout.txt');
      await waitForRequest(emitted);
      await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS + 500);
      const outcome = await pending;
      expect(outcome.allowed).toBe(false);
      expect(outcome.note).toContain(`approval timed out after ${APPROVAL_TIMEOUT_MS / 1000}s`);
      expect(outcome.note).toContain("the user may be away; do not assume rejection");
      // The timeout note is DISTINCT from the denial text.
      expect(outcome.note).not.toContain("NOT a tool or system failure");
      expect(outcome.note).not.toContain("denied by the owner");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a computer-use consent denial separates user intent from tool/system failure and names the action", async () => {
    setComputerUseSettings(db, { enabled: true, permission: "act" });
    const emitted: Array<Record<string, unknown>> = [];
    const tools = await computerUsePlugin.createTools({
      root: tempDir,
      toolDeps: {
        db,
        sessionId: "r71-cu-session",
        agentId: "r71-cu-agent",
        interactiveApprovals: true,
        emit: (event: unknown) => emitted.push(event as Record<string, unknown>),
      },
    });
    const type = tools.find((t) => t.name === "type");
    expect(type).toBeDefined();
    const pending = type!.execute({ text: "hello", appRef: { pid: 999 } }, { root: tempDir });
    const approvalId = await waitForRequest(emitted);
    setApprovalStatus(db, approvalId, "denied", undefined, "owner");
    resolvePendingApproval(approvalId, "denied");
    const result = await pending;
    expect(result.ok).toBe(false);
    const parsed = JSON.parse(result.output) as {
      error: string;
      message: string;
      recovery?: string;
      payload?: { approvalNote?: string };
    };
    expect(parsed.error).toBe("host_policy_denied");
    // Names the action…
    expect(parsed.message).toContain('type "hello"');
    // …and separates user intent from failure.
    expect(parsed.message).toContain("this is NOT a tool or system failure");
    expect(parsed.message).toContain("The action was not performed");
    expect(parsed.message).toContain("Ask the user why (one line), or propose an alternative approach.");
    // The distinguishing approval note rides the payload.
    expect(parsed.payload?.approvalNote).toContain("command denied by the owner");
  });
});

/* ── D4: provider-error classification ─────────────────────────────────────── */

describe("R71-e2 D4: classifyProviderError — the classifier table", () => {
  const classified = (error: unknown): ProviderErrorClass => classifyProviderError(error).class;

  it("message-based context-window detection (the class D5 keys on)", () => {
    expect(classified(new Error("context_length_exceeded: your input is too large"))).toBe("context_window_exceeded");
    expect(classified(new Error("This model's maximum context length is 8192 tokens, however you requested 10000"))).toBe("context_window_exceeded");
    expect(classified(new Error("Prompt is too long: 9000 tokens > 8000 maximum"))).toBe("context_window_exceeded");
    expect(classified(new Error("Request too long"))).toBe("context_window_exceeded");
    expect(classified(new Error("input tokens exceed the allowed maximum for this model"))).toBe("context_window_exceeded");
  });

  it("auth by status ONLY (401/403), rate limit by status 429 or message, network by 5xx or transport messages", () => {
    const withStatus = (message: string, statusCode: number): Error =>
      Object.assign(new Error(message), { statusCode });
    expect(classified(withStatus("Unauthorized", 401))).toBe("auth");
    expect(classified(withStatus("Forbidden", 403))).toBe("auth");
    expect(classified(withStatus("Too Many Requests", 429))).toBe("rate_limit");
    expect(classified(new Error("Rate limit exceeded for requests"))).toBe("rate_limit");
    expect(classified(withStatus("Internal Server Error", 500))).toBe("network");
    expect(classified(new Error("500 Internal Server Error from provider"))).toBe("network");
    expect(classified(new Error("fetch failed: ECONNRESET"))).toBe("network");
    // A 413 payload-too-large is the unambiguous overflow status.
    expect(classified(withStatus("Payload Too Large", 413))).toBe("context_window_exceeded");
    // A message-only "Unauthorized" does NOT classify as auth (status-only rule).
    expect(classified(new Error("Unauthorized (quoted in a provider body)"))).not.toBe("auth");
  });

  it("the rate-limit VETO: 'tokens exceeded' wording in a TPM body classifies as rate_limit, never overflow", () => {
    expect(classified(new Error("Requested tokens exceed the TPM rate limit"))).toBe("rate_limit");
    expect(classified(Object.assign(new Error("Bad Request"), { statusCode: 400 }))).not.toBe("context_window_exceeded");
  });

  it("timeout via AbortError/TimeoutError names or timeout wording; everything else is unknown", () => {
    const timeoutError = new Error("The operation was aborted due to timeout");
    timeoutError.name = "TimeoutError";
    expect(classified(timeoutError)).toBe("timeout");
    const abortError = new Error("This operation was aborted");
    abortError.name = "AbortError";
    expect(classified(abortError)).toBe("timeout");
    expect(classified(new Error("request timed out after 60000ms"))).toBe("timeout");
    expect(classified(new Error("something entirely novel"))).toBe("unknown");
  });

  it("the status walk reaches nested cause/data objects (bounded, cycle-safe)", () => {
    const inner = Object.assign(new Error("quota exceeded"), { statusCode: 429 });
    const outer = new Error("provider call failed");
    (outer as Error & { cause?: unknown }).cause = { data: inner };
    expect(classified(outer)).toBe("rate_limit");
    const cyclic: Record<string, unknown> = { statusCode: 401 };
    cyclic.self = cyclic;
    expect(() => classifyProviderError(cyclic)).not.toThrow();
    expect(classified(cyclic)).toBe("auth");
  });

  it("every class carries a non-empty, honest userMessage", () => {
    // ROUND-78 (R78): userMessage is now the REAL provider text (the
    // unwrapped error's message) — "x" is what the provider said, so "x" is
    // the honest line; the generic CLASS_MESSAGES one-liner is only the
    // empty-message fallback. The old >10 pin assumed the generic line.
    for (const error of [
      new Error("prompt is too long"),
      Object.assign(new Error("x"), { statusCode: 401 }),
      Object.assign(new Error("x"), { statusCode: 429 }),
      new Error("ECONNREFUSED"),
      Object.assign(new Error("x"), { name: "TimeoutError" }),
      new Error("novel"),
    ]) {
      const cls = classifyProviderError(error);
      expect(cls.userMessage.length).toBeGreaterThan(0);
    }
  });
});

/* ── D5: overflow recovery (force compaction + retry once) ─────────────────── */

describe("R71-e2 D5: compaction force mode (the recovery primitive)", () => {
  const budget = { contextWindow: 200_000, maxOutputTokens: 32_768, margin: 8_000 };

  it("planCompaction: under budget → null without force; with force → a real plan", () => {
    const messages: SeqMessage[] = [
      { role: "user", content: "the original task", throughSeq: 1 },
      { role: "assistant", content: "did part one", throughSeq: 2 },
      { role: "user", content: "continue", throughSeq: 3 },
    ];
    expect(planCompaction(messages, budget)).toBeNull();
    const forced = planCompaction(messages, budget, true);
    expect(forced).not.toBeNull();
    expect(forced!.toSummarize.length).toBe(1);
    expect(forced!.toSummarize[0].content).toBe("the original task");
    // Nothing to summarize (a single message) → null even when forced — the
    // honest "nothing to compact" case.
    expect(planCompaction([messages[2]], budget, true)).toBeNull();
  });

  it("assembleWithCompaction with { force: true } compacts + persists the event even under the estimate", async () => {
    db?.close();
    db = openDatabase(join(tempDir, `${randomUUID()}.db`));
    const summarizer: ChatFn = async () => ({
      text: "SUMMARY: the user asked for the original task; part one is done.",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      toolCalls: [],
    });
    const deps = {
      db,
      sessionId: "r71-force-session",
      chat: summarizer,
      provider: { id: "openrouter", baseUrl: "https://example.test", apiFormat: "chat-completions" },
      apiKey: "k",
      model: "test/r71-1",
    };
    // Seed a prior exchange so there is something to summarize.
    appendSessionEvent(db, deps.sessionId, {
      type: "message.user",
      agentId: null,
      payload: { role: "user", content: "the original task" },
    });
    const messages: SeqMessage[] = [
      { role: "user", content: "the original task", throughSeq: 1 },
      { role: "user", content: "continue", throughSeq: 2 },
    ];
    const normal = await assembleWithCompaction(messages, budget, deps);
    expect(normal.compacted).toBe(false);
    const forced = await assembleWithCompaction(messages, budget, deps, { force: true });
    expect(forced.compacted).toBe(true);
    // The compacted list leads with the summary message; the covered head is gone.
    expect(forced.messages[0].content).toContain("[Earlier conversation compacted");
    expect(forced.messages[0].content).toContain("SUMMARY: the user asked for the original task");
    expect(forced.messages).toHaveLength(2);
    // The event persisted (reload would reuse it).
    const events = listSessionEvents(db, deps.sessionId);
    expect(events.some((e) => e.type === "context.compact")).toBe(true);
  });
});

describe("R71-e2 D5: overflow recovery — the STREAMED path", () => {
  function setup(name: string): { sessionId: string; keyring: ProviderKeyring } {
    db?.close();
    db = openDatabase(join(tempDir, `${randomUUID()}.db`));
    const project = createProject(db, { name, rootPath: join(tempDir, name) });
    const agent = createAgent(db, { name: `${name} Agent`, providerId: "openrouter", model: "test/r71-1" });
    const session = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
    // Seed a PRIOR exchange so the forced compaction has something to
    // summarize (a first-turn overflow has nothing to compact — cline's
    // NOTHING_TO_COMPACT case, covered by the sync test below).
    appendSessionEvent(db, session.id, {
      type: "message.user",
      agentId: agent.id,
      payload: { role: "user", content: "the original task: build the r71 feature" },
    });
    appendSessionEvent(db, session.id, {
      type: "message.assistant",
      agentId: agent.id,
      payload: { role: "assistant", content: "started part one of the r71 feature" },
    });
    return { sessionId: session.id, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }) };
  }

  const summarizerChat: ChatFn = async () => ({
    text: "SUMMARY: the user's original task (build the r71 feature); part one started.",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    toolCalls: [],
  });

  const overflowError = (): Error => new Error("This model's maximum context length is 4096 tokens, however you requested 10000 tokens");

  it("overflow → visible recovery line → forced compaction → retry once → SUCCESS", async () => {
    const { sessionId, keyring } = setup("R71-Stream-Recover");
    const emitted: Array<Record<string, unknown>> = [];
    const seenMessages: ChatTurnMessage[][] = [];
    let streamCalls = 0;
    const chatStream: StreamChatFn = async function* () {
      streamCalls += 1;
      if (streamCalls === 1) throw overflowError();
      yield { type: "text-delta", delta: "Done. The r71 feature is complete." };
      yield { type: "finish", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } };
    };
    const recordingStream: StreamChatFn = async function* (input) {
      seenMessages.push(input.messages.map((m) => ({ ...m })));
      yield* chatStream(input);
    };

    const outcome = await runStreamedAgentTurn(
      { db, keyring, chat: summarizerChat, chatStream: recordingStream },
      sessionId,
      "continue the work",
      (event) => emitted.push(event as Record<string, unknown>),
    );
    expect(outcome.ok).toBe(true);
    // Exactly TWO streamed calls: the overflowing one + the retry.
    expect(streamCalls).toBe(2);
    // The visible system line rode the stream (the meta-frame pattern).
    const recovery = emitted.find((e) => e.type === "meta.overflow_recovery");
    expect(recovery).toBeDefined();
    expect(recovery!.message).toBe("[context overflow → auto-compacted conversation → retrying]");
    // The forced compaction ACTUALLY ran: the event is persisted…
    const events = listSessionEvents(db, sessionId);
    expect(events.filter((e) => e.type === "context.compact")).toHaveLength(1);
    // …and the RETRY's message list leads with the compaction summary.
    expect(seenMessages).toHaveLength(2);
    expect(seenMessages[1][0].role).toBe("user");
    expect(seenMessages[1][0].content).toContain("[Earlier conversation compacted");
    expect(seenMessages[1][0].content).toContain("SUMMARY: the user's original task");
    // No turn.error — the turn recovered.
    expect(events.some((e) => e.type === "turn.error")).toBe(false);
  });

  it("overflow TWICE → honest terminal failure, exactly one recovery attempt, class on the envelope", async () => {
    const { sessionId, keyring } = setup("R71-Stream-Twice");
    const emitted: Array<Record<string, unknown>> = [];
    let streamCalls = 0;
    const chatStream: StreamChatFn = async function* () {
      streamCalls += 1;
      throw overflowError();
    };

    const outcome = await runStreamedAgentTurn(
      { db, keyring, chat: summarizerChat, chatStream },
      sessionId,
      "continue the work",
      (event) => emitted.push(event as Record<string, unknown>),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(502);
      expect(outcome.code).toBe("PROVIDER_ERROR");
      expect(outcome.message).toContain("context window exceeded even after compaction");
      expect(outcome.message).toContain("start a new session or /compact");
      expect(outcome.message).toContain("(class: context_window_exceeded)");
      expect(outcome.details?.errorClass).toBe("context_window_exceeded");
    }
    // ONE retry only — the second overflow does not re-arm recovery.
    expect(streamCalls).toBe(2);
    expect(emitted.filter((e) => e.type === "meta.overflow_recovery")).toHaveLength(1);
    // Exactly one compaction attempt (the forced one).
    const events = listSessionEvents(db, sessionId);
    expect(events.filter((e) => e.type === "context.compact")).toHaveLength(1);
    // The failure is persisted with the class (R42/R43 loud-and-retryable).
    const error = events.find((e) => e.type === "turn.error");
    expect(error).toBeDefined();
    expect((error!.payload as Record<string, unknown>).errorClass).toBe("context_window_exceeded");
    const row = db.prepare("SELECT status FROM sessions WHERE id = ?").get(sessionId) as { status: string };
    expect(row.status).toBe("queued");
  });

  it("a NON-overflow provider error NEVER triggers compaction or recovery (class network)", async () => {
    // ROUND-75 (R75): a network error is now TRANSIENT — the retry ladder
    // runs before the terminal path. To keep THIS test's original intent
    // (non-overflow classes never trigger the D5 compaction/recovery), the
    // first failure is the same 500, the immediate ladder rung retries
    // once, and the retry dies NON-transiently (401) so the turn ends fast
    // and honestly. The ladder's full transient lifecycle is covered in
    // r75-retry-ladder.test.ts.
    const { sessionId, keyring } = setup("R71-Stream-Network");
    const emitted: Array<Record<string, unknown>> = [];
    let streamCalls = 0;
    const chatStream: StreamChatFn = async function* () {
      streamCalls += 1;
      if (streamCalls === 1) throw new Error("500 Internal Server Error from provider");
      const authErr = new Error("401 Unauthorized: invalid API key");
      (authErr as Error & { statusCode?: number }).statusCode = 401;
      throw authErr;
    };

    const outcome = await runStreamedAgentTurn(
      { db, keyring, chat: summarizerChat, chatStream },
      sessionId,
      "continue the work",
      (event) => emitted.push(event as Record<string, unknown>),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("PROVIDER_ERROR");
      expect(outcome.message).toContain("(class: auth)");
      expect(outcome.details?.errorClass).toBe("auth");
      // R75: the network failure was retried once (the immediate rung)
      // before the auth error ended the turn.
      expect(outcome.details?.attempts).toBe(2);
    }
    expect(streamCalls).toBe(2);
    expect(emitted.some((e) => e.type === "meta.overflow_recovery")).toBe(false);
    const events = listSessionEvents(db, sessionId);
    expect(events.some((e) => e.type === "context.compact")).toBe(false);
  });

  it("an overflow AFTER partial content streamed → NO recovery (retrying would duplicate persisted work)", async () => {
    const { sessionId, keyring } = setup("R71-Stream-Partial");
    const emitted: Array<Record<string, unknown>> = [];
    let streamCalls = 0;
    const chatStream: StreamChatFn = async function* (): AsyncGenerator<StreamChatEvent> {
      streamCalls += 1;
      yield { type: "text-delta", delta: "partial answer " };
      throw overflowError();
    };

    const outcome = await runStreamedAgentTurn(
      { db, keyring, chat: summarizerChat, chatStream },
      sessionId,
      "continue the work",
      (event) => emitted.push(event as Record<string, unknown>),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      // Honest class on the envelope, but NOT the "even after compaction"
      // line — no compaction was attempted (content already streamed).
      expect(outcome.message).toContain("(class: context_window_exceeded)");
      expect(outcome.message).not.toContain("even after compaction");
    }
    expect(streamCalls).toBe(1);
    expect(emitted.some((e) => e.type === "meta.overflow_recovery")).toBe(false);
    const events = listSessionEvents(db, sessionId);
    expect(events.some((e) => e.type === "context.compact")).toBe(false);
  });
});

describe("R71-e2 D5: overflow recovery — the SYNC path (sub-agents)", () => {
  function setup(name: string): { sessionId: string; keyring: ProviderKeyring } {
    db?.close();
    db = openDatabase(join(tempDir, `${randomUUID()}.db`));
    const project = createProject(db, { name, rootPath: join(tempDir, name) });
    const agent = createAgent(db, { name: `${name} Agent`, providerId: "openrouter", model: "test/r71-1" });
    const session = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
    appendSessionEvent(db, session.id, {
      type: "message.user",
      agentId: agent.id,
      payload: { role: "user", content: "the original sync task" },
    });
    appendSessionEvent(db, session.id, {
      type: "message.assistant",
      agentId: agent.id,
      payload: { role: "assistant", content: "part one done" },
    });
    return { sessionId: session.id, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }) };
  }

  it("overflow → forced compaction → retry once → SUCCESS (chat doubles as the summarizer)", async () => {
    const { sessionId, keyring } = setup("R71-Sync-Recover");
    const calls: ChatTurnMessage[][] = [];
    let i = 0;
    const chat: ChatFn = async (input) => {
      calls.push(input.messages.map((m) => ({ ...m })));
      i += 1;
      if (i === 1) throw new Error("context_length_exceeded: the request does not fit");
      if (i === 2) {
        // The forced compaction's summarizer call.
        return {
          text: "SUMMARY: the original sync task; part one done.",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          toolCalls: [],
        };
      }
      return { text: "Done.", usage: { inputTokens: 3, outputTokens: 3, totalTokens: 6 }, toolCalls: [] };
    };

    const outcome = await runSingleAgentTurn({ db, keyring, chat }, sessionId, "continue");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.assistantMessage.content).toBe("Done.");
    }
    // Three chat calls: the overflow, the summarizer, the retry.
    expect(calls).toHaveLength(3);
    // The retry's message list leads with the compaction summary.
    expect(calls[2][0].content).toContain("[Earlier conversation compacted");
    expect(calls[2][0].content).toContain("SUMMARY: the original sync task");
    const events = listSessionEvents(db, sessionId);
    expect(events.filter((e) => e.type === "context.compact")).toHaveLength(1);
    expect(events.some((e) => e.type === "turn.error")).toBe(false);
  });

  it("an overflow on the LAST outer iteration fails honestly (no retry remains → no recovery attempt, never a fake success)", async () => {
    db?.close();
    db = openDatabase(join(tempDir, `${randomUUID()}.db`));
    const project = createProject(db, { name: "R71-Sync-LastIter", rootPath: join(tempDir, "R71-Sync-LastIter") });
    // maxOuterLoops: 1 — there is NO iteration left to retry into.
    const agent = createAgent(db, {
      name: "LastIter Agent",
      providerId: "openrouter",
      model: "test/r71-1",
      maxOuterLoops: 1,
    });
    const session = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
    appendSessionEvent(db, session.id, {
      type: "message.user",
      agentId: agent.id,
      payload: { role: "user", content: "the original sync task" },
    });
    appendSessionEvent(db, session.id, {
      type: "message.assistant",
      agentId: agent.id,
      payload: { role: "assistant", content: "part one done" },
    });
    let calls = 0;
    const chat: ChatFn = async () => {
      calls += 1;
      throw new Error("prompt is too long for this model");
    };
    const outcome = await runSingleAgentTurn(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat },
      session.id,
      "continue",
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      // No retry was possible → the honest PROVIDER_ERROR carries the class
      // WITHOUT claiming a compaction was attempted.
      expect(calls).toBe(1);
      expect(outcome.message).toContain("(class: context_window_exceeded)");
      expect(outcome.message).not.toContain("even after compaction");
    }
    const events = listSessionEvents(db, session.id);
    expect(events.some((e) => e.type === "context.compact")).toBe(false);
    expect(events.some((e) => e.type === "turn.error")).toBe(true);
  });

  it("a first-turn overflow with NOTHING to compact fails honestly (no invented compaction)", async () => {
    db?.close();
    db = openDatabase(join(tempDir, `${randomUUID()}.db`));
    const project = createProject(db, { name: "R71-Sync-Nothing", rootPath: join(tempDir, "R71-Sync-Nothing") });
    const agent = createAgent(db, { name: "Nothing Agent", providerId: "openrouter", model: "test/r71-1" });
    const session = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
    let calls = 0;
    const chat: ChatFn = async () => {
      calls += 1;
      throw new Error("prompt is too long for this model");
    };
    const outcome = await runSingleAgentTurn(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat },
      session.id,
      "a very large first message",
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      // Recovery was attempted (the retry re-sent once)…
      expect(calls).toBe(2);
      // …but nothing was compactable, so the honest terminal message names
      // the overflow (the class line, not a fake compaction claim).
      expect(outcome.message).toContain("(class: context_window_exceeded)");
      expect(outcome.message).toContain("context window exceeded even after compaction");
    }
    const events = listSessionEvents(db, session.id);
    expect(events.filter((e) => e.type === "context.compact")).toHaveLength(0);
    expect(events.some((e) => e.type === "turn.error")).toBe(true);
  });
});
