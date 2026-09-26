/**
 * ROUND-129 (R129-CTX1) — the replay-hygiene passes on assembleHistory +
 * the persistence-side marker, the five-reference research synthesis's
 * first implementation wave (round-129.md §4 stages 1-2):
 *
 *   · SUPERSEDE-STALE-READS (oh-my-pi pruning.ts's readToolSupersedeKey +
 *     cline's "[outdated - see the latest file content]" rewrite — the two
 *     projects' TOP adoption verdict): an older read_file/list_dir of a
 *     path the log has since re-read OR written stubs to the honest
 *     marker; the newest touch of every path rides full; writes never
 *     stub; FAILED reads never stub (no content to supersede).
 *   · OLD-ATTACHMENT STRIPPING (cline's MessageBuilder law): attachment
 *     BODIES ride only the NEWEST attachment-bearing user message; older
 *     ones render the one-line re-read stubs.
 *   · THE ACTIONABLE TRUNCATION MARKER (opencode's pointer discipline):
 *     the read family's persistence-side truncation marker names the
 *     recovery move; other families keep the plain count marker.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { assembleHistory } from "../src/agents/runtime";
import { renderOldAttachmentStubs, summarizeToolOutput } from "../src/agents/chat";
import { appendSessionEvent } from "../src/storage/sessions";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";

let tempDir = "";
let db: SqliteDatabase;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r129ctx1-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }
});

const AGENT = "agt_x";

function userMessage(content: string, attachments?: unknown[]): {
  type: string;
  agentId: string;
  payload: Record<string, unknown>;
} {
  return {
    type: "message.user",
    agentId: AGENT,
    payload: {
      role: "user",
      content,
      ...(attachments !== undefined ? { attachments } : {}),
    },
  };
}

function toolUse(
  toolName: string,
  argsSummary: string,
  outputSummary: string,
  ok = true,
): { type: string; agentId: string; payload: Record<string, unknown> } {
  return {
    type: "tool.use",
    agentId: AGENT,
    payload: { role: "tool", toolName, argsSummary, ok, outputSummary },
  };
}

function assistantMessage(content: string): {
  type: string;
  agentId: string;
  payload: Record<string, unknown>;
} {
  return { type: "message.assistant", agentId: AGENT, payload: { role: "assistant", content } };
}

const SUPERSEDED_MARKER =
  "[superseded — a newer read or write of this path appears below; re-read it if you need the contents]";

// ─────────────────────────────────────────────────────────────────────────────
// 1. Supersede-stale-reads
// ─────────────────────────────────────────────────────────────────────────────

describe("R129-CTX1 supersede-stale-reads (assembleHistory)", () => {
  it("stubs an OLDER read of a path the log re-read, keeps the newest full", () => {
    const sessionId = "sess-sup-1";
    appendSessionEvent(db, sessionId, userMessage("read it twice"));
    appendSessionEvent(db, sessionId, toolUse("read_file", "path: src/a.ts", "CONTENT-v1 the original body"));
    appendSessionEvent(db, sessionId, assistantMessage("ok v1"));
    appendSessionEvent(db, sessionId, toolUse("read_file", "path: src/a.ts", "CONTENT-v2 the fresh body"));

    const messages = assembleHistory(db, sessionId);
    const content = messages.map((m) => m.content).join("\n");
    expect(content).toContain(SUPERSEDED_MARKER);
    // The OLDER read's body is gone…
    expect(content).not.toContain("CONTENT-v1");
    // …the NEWEST read's body rides full…
    expect(content).toContain("CONTENT-v2");
    // …and the older read's CALL line stays (traceability).
    expect(content.match(/read_file\(path: src\/a\.ts\)/g)?.length).toBe(2);
  });

  it("a WRITE supersedes every earlier read of the same path (cline's outdated law)", () => {
    const sessionId = "sess-sup-2";
    appendSessionEvent(db, sessionId, userMessage("read then edit"));
    appendSessionEvent(db, sessionId, toolUse("read_file", "path: lib.ts", "OLD CONTENT before the edit"));
    appendSessionEvent(db, sessionId, toolUse("edit_file", "path: lib.ts, 2 replacements, +4 −1 lines", "ok"));
    appendSessionEvent(db, sessionId, assistantMessage("edited"));

    const content = assembleHistory(db, sessionId).map((m) => m.content).join("\n");
    expect(content).toContain(SUPERSEDED_MARKER);
    expect(content).not.toContain("OLD CONTENT before the edit");
    // The WRITE itself is never stubbed — it is the ground truth.
    expect(content).toContain("edit_file(path: lib.ts");
  });

  it("a FAILED read never stubs (its error is short + it never carried content)", () => {
    const sessionId = "sess-sup-3";
    appendSessionEvent(db, sessionId, userMessage("fail then read"));
    appendSessionEvent(db, sessionId, toolUse("read_file", "path: gone.txt", "no such file", false));
    appendSessionEvent(db, sessionId, toolUse("read_file", "path: gone.txt", "CONTENT the recovered body"));

    const content = assembleHistory(db, sessionId).map((m) => m.content).join("\n");
    expect(content).toContain("no such file");
    expect(content).toContain("CONTENT the recovered body");
    expect(content).not.toContain(SUPERSEDED_MARKER);
  });

  it("list_dir listings supersede by path like reads (the same deterministic key)", () => {
    const sessionId = "sess-sup-4";
    appendSessionEvent(db, sessionId, userMessage("list twice"));
    appendSessionEvent(db, sessionId, toolUse("list_dir", "path: src", "a.ts b.ts OLD-LISTING"));
    appendSessionEvent(db, sessionId, toolUse("list_dir", "path: src", "a.ts c.ts NEW-LISTING"));

    const content = assembleHistory(db, sessionId).map((m) => m.content).join("\n");
    expect(content).not.toContain("OLD-LISTING");
    expect(content).toContain("NEW-LISTING");
    expect(content).toContain(SUPERSEDED_MARKER);
  });

  it("un-superseded reads keep the R58-c fidelity rules verbatim (composition)", () => {
    const sessionId = "sess-sup-5";
    appendSessionEvent(db, sessionId, userMessage("different files"));
    // 10 reads of DIFFERENT paths — no supersede applies; the R58-c window
    // (last 8 full, older stubbed) is the only rule in play.
    for (let i = 0; i < 10; i++) {
      appendSessionEvent(db, sessionId, toolUse("read_file", `path: f${i}.txt`, `${"x".repeat(2000)} body ${i} ${"y".repeat(2000)}`));
    }

    const content = assembleHistory(db, sessionId).map((m) => m.content).join("\n");
    expect(content).not.toContain(SUPERSEDED_MARKER);
    expect(content.match(/…\[older result truncated\]/g)?.length).toBe(2);
  });

  it("sticky tools are untouched by the supersede families (not read-family)", () => {
    const sessionId = "sess-sup-6";
    appendSessionEvent(db, sessionId, userMessage("skill then read"));
    appendSessionEvent(db, sessionId, toolUse("read_skill", "name: build-steps", "THE SKILL BODY — must survive"));
    appendSessionEvent(db, sessionId, toolUse("read_file", "path: anything.ts", "some body"));

    const content = assembleHistory(db, sessionId).map((m) => m.content).join("\n");
    expect(content).toContain("THE SKILL BODY — must survive");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Old-attachment stripping
// ─────────────────────────────────────────────────────────────────────────────

describe("R129-CTX1 old-attachment stripping (assembleHistory)", () => {
  it("rides BODIES only on the newest attachment-bearing message; older ones get stubs", () => {
    const sessionId = "sess-att-1";
    appendSessionEvent(db, sessionId, userMessage("first with attachment", [
      { name: "notes-old.txt", path: "uploads/notes-old.txt", text: "THE OLD ATTACHMENT BODY — should not re-ride" },
    ]));
    appendSessionEvent(db, sessionId, assistantMessage("got it"));
    appendSessionEvent(db, sessionId, userMessage("second with attachment", [
      { name: "notes-new.txt", path: "uploads/notes-new.txt", text: "THE NEW ATTACHMENT BODY — rides in full" },
    ]));

    const messages = assembleHistory(db, sessionId);
    const joined = messages.map((m) => m.content).join("\n---MSG---\n");
    expect(joined).toContain("THE NEW ATTACHMENT BODY — rides in full");
    expect(joined).not.toContain("THE OLD ATTACHMENT BODY — should not re-ride");
    expect(joined).toContain("attached file: notes-old.txt (saved at uploads/notes-old.txt)");
    expect(joined).toContain("body not re-sent");
  });

  it("a SINGLE attachment message (the only one) keeps its body — no regression", () => {
    const sessionId = "sess-att-2";
    appendSessionEvent(db, sessionId, userMessage("only attachment", [
      { name: "solo.txt", path: "uploads/solo.txt", text: "SOLO BODY" },
    ]));

    const content = assembleHistory(db, sessionId).map((m) => m.content).join("\n");
    expect(content).toContain("SOLO BODY");
    expect(content).not.toContain("body not re-sent");
  });

  it("renderOldAttachmentStubs is pure + names the file, path, and the recovery pointer", () => {
    const out = renderOldAttachmentStubs("the message", [
      { name: "a.txt", path: "uploads/a.txt", text: "BODY A" },
      { name: "b.txt", text: "BODY B" },
    ]);
    expect(out).toContain("the message");
    expect(out).toContain("--- attached file: a.txt (saved at uploads/a.txt)");
    expect(out).toContain("--- attached file: b.txt —");
    expect(out).toContain("re-read it if needed");
    expect(out).not.toContain("BODY A");
    expect(out).not.toContain("BODY B");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The actionable truncation marker (persistence side, chat.ts)
// ─────────────────────────────────────────────────────────────────────────────

describe("R129-CTX1 actionable truncation marker (summarizeToolOutput)", () => {
  it("the read family's marker names the recovery move (re-read with an offset)", () => {
    const long = `${"a".repeat(5000)}middle${"b".repeat(5000)}`;
    const out = summarizeToolOutput(long, "read_file");
    expect(out).toContain("[truncated 6006 chars — re-read with an offset to see the omitted middle]");
  });

  it("other families keep the plain count marker (their output is not offset-fetchable)", () => {
    const long = `${"a".repeat(5000)}middle${"b".repeat(5000)}`;
    const out = summarizeToolOutput(long, "run_command");
    expect(out).toContain("[truncated 6006 chars]");
    expect(out).not.toContain("re-read with an offset");
  });
});
