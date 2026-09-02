/**
 * ROUND-61 (R61): the refusal catalog (doc 11) — every message must carry
 * the self-teaching shape: what was refused, why, the nothing-sent fact,
 * and the exact next step. Plus the audit journal's redaction policy.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ambiguousAppRef,
  appNotFound,
  elementStaleSuperseded,
  frontmostPidMismatch,
  killSwitchActive,
  occlusionOwnerMismatch,
  rasterOutOfBounds,
  targetlessInputRefused,
  uipiBlocked,
  visionDisabled,
} from "../src/computer/errors";
import type { AppInfo } from "../src/computer/types";
import { appendAudit, auditPath, redactForAudit, resetAuditForTests } from "../src/computer/audit";

/* ── errors: the doc-11 message shape ──────────────────────────────────────── */

describe("ROUND-61 (R61): the refusal catalog (doc 11)", () => {
  const cases: Array<{ name: string; make: () => { kind: "refusal"; refusal: { error: string; message: string; recovery?: string } } }> = [
    { name: "kill_switch_active", make: () => killSwitchActive() },
    {
      name: "element_stale",
      make: () => elementStaleSuperseded("s-7"),
    },
    {
      name: "frontmost_pid_mismatch",
      make: () => frontmostPidMismatch(9752, 4312),
    },
    {
      name: "occlusion_owner_mismatch",
      make: () => occlusionOwnerMismatch("Invisible Overlay"),
    },
    { name: "raster_out_of_bounds", make: () => rasterOutOfBounds(5000, 10, 1920, 1080) },
    { name: "targetless_input_refused", make: () => targetlessInputRefused("key") },
    { name: "uipi_blocked", make: () => uipiBlocked("elevated.exe") },
    { name: "vision_disabled", make: () => visionDisabled("vision is OFF") },
  ];

  for (const { name, make } of cases) {
    it(`${name}: names the code, explains, prescribes the recovery`, () => {
      const { refusal } = make();
      expect(refusal.error).toBe(name);
      // The self-teaching shape: a sentence + a recovery instruction.
      expect(refusal.message.length).toBeGreaterThan(20);
      expect(refusal.message).toMatch(/[.!?]$/);
      expect(refusal.recovery).toBeDefined();
      expect(refusal.recovery!.length).toBeGreaterThan(20);
    });
  }

  it("frontmost_pid_mismatch carries the pids in the payload + nothing-sent", () => {
    const { refusal } = frontmostPidMismatch(9752, 4312);
    expect(refusal.payload).toEqual({ scopePid: 9752, activePid: 4312 });
    expect(refusal.message).toContain("action_sent=false");
  });

  it("element_stale (superseded) says the token was consumed and prescribes a fresh get_app_state", () => {
    const { refusal } = elementStaleSuperseded("s-7");
    expect(refusal.message).toContain("s-7");
    expect(refusal.recovery).toContain("get_app_state");
    expect(refusal.payload).toEqual({ stateId: "s-7", cause: "superseded" });
  });
});

/* ── R64-a: app-resolution refusals carry the recovery payload ───────────── */

describe("ROUND-64-a (R64-a): app-resolution refusals list the running apps", () => {
  const RUNNING: AppInfo[] = [
    { name: "Untitled - Notepad", processName: "notepad", pid: 4012, active: true },
    { name: "ACUTE-CODE — Mozilla Firefox", processName: "firefox", pid: 8104, active: false },
  ];

  it("app_not_found WITH the running list: payload.runningApps (capped) + a pick-the-pid recovery", () => {
    const { refusal } = appNotFound("Notepad", RUNNING);
    expect(refusal.error).toBe("app_not_found");
    expect(refusal.message).toContain("Notepad");
    expect((refusal.payload as { runningApps: unknown[] }).runningApps).toEqual([
      { name: "Untitled - Notepad", processName: "notepad", pid: 4012 },
      { name: "ACUTE-CODE — Mozilla Firefox", processName: "firefox", pid: 8104 },
    ]);
    expect(refusal.recovery).toContain("runningApps");
    expect(refusal.recovery).toContain("pid");
  });

  it("app_not_found WITHOUT a list keeps the list_apps recovery (no payload bloat)", () => {
    const { refusal } = appNotFound("Ghost");
    expect(refusal.payload).toEqual({ requested: "Ghost" });
    expect(refusal.recovery).toContain("list_apps");
  });

  it("app_not_found WITH an EMPTY list says so honestly (runningApps: [] — enumeration itself failed)", () => {
    const { refusal } = appNotFound("Ghost", []);
    expect((refusal.payload as { runningApps: unknown[] }).runningApps).toEqual([]);
    // The no-list recovery still applies: nothing is running (or the probe failed).
    expect(refusal.recovery).toContain("list_apps");
  });

  it("app_not_found caps runningApps at 25 (list_apps is the full surface)", () => {
    const many: AppInfo[] = Array.from({ length: 40 }, (_, i) => ({ name: `App ${i}`, pid: 1000 + i, active: false }));
    const { refusal } = appNotFound("Ghost", many);
    expect((refusal.payload as { runningApps: unknown[] }).runningApps).toHaveLength(25);
  });

  it("ambiguous_app_ref lists full candidates (name + processName + pid), not bare pids", () => {
    const { refusal } = ambiguousAppRef("notepad", [
      { name: "Untitled - Notepad", processName: "notepad", pid: 4012 },
      { name: "notes.txt - Notepad", processName: "notepad", pid: 5208 },
    ]);
    expect(refusal.error).toBe("ambiguous_app_ref");
    const candidates = (refusal.payload as { candidates: Array<{ name: string; processName?: string; pid: number }> }).candidates;
    expect(candidates).toEqual([
      { name: "Untitled - Notepad", processName: "notepad", pid: 4012 },
      { name: "notes.txt - Notepad", processName: "notepad", pid: 5208 },
    ]);
    expect(refusal.recovery).toContain("pid");
  });
});

/* ── audit: the JSONL journal + redaction ──────────────────────────────────── */

describe("ROUND-61 (R61): the audit journal (doc 08 §4)", () => {
  const root = mkdtempSync(join(tmpdir(), "acute-audit-"));
  afterEach(() => {
    resetAuditForTests(root);
  });
  afterAllCleanup();

  function afterAllCleanup() {
    // registered once; vitest runs afterAll at file scope
    process.on("exit", () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    });
  }

  it("appendAudit writes one JSONL line per call (ts, tool, args, outcome)", () => {
    const ok = appendAudit(root, {
      ts: 1,
      sessionStartedAt: 1,
      tool: "left_click",
      args: { target: { type: "element", stateId: "s-1", index: 4 } },
      outcome: {
        kind: "receipt",
        receipt: { schemaVersion: "v1", actionSent: true, dispatchStatus: "accepted", retryAction: false },
      },
    });
    expect(ok).toBe(true);
    const line = readFileSync(auditPath(root), "utf8").trim();
    const parsed = JSON.parse(line);
    expect(parsed.tool).toBe("left_click");
    expect(parsed.outcome.kind).toBe("receipt");
    expect(parsed.outcome.receipt.actionSent).toBe(true);
  });

  it("redactForAudit scrubs credential-shaped strings wherever they hide", () => {
    const redacted = redactForAudit({
      note: "the key is sk-or-v1-0123456789abcdef0123456789abcdef here",
      nested: { token: "password: hunter2secret" },
      arr: ["ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234"],
    }) as Record<string, unknown>;
    expect(JSON.stringify(redacted)).not.toContain("sk-or-v1-0123");
    expect(JSON.stringify(redacted)).not.toContain("hunter2secret");
    expect(JSON.stringify(redacted)).not.toContain("ghp_ABC");
    expect(JSON.stringify(redacted)).toContain("[REDACTED]");
  });

  it("redactForAudit omits clipboard/text VALUE payloads (length markers only)", () => {
    const redacted = redactForAudit({ text: "hello world", other: "kept" }) as Record<string, unknown>;
    expect(redacted["text"]).toEqual({ redacted: true, len: 11 });
    expect(redacted["other"]).toBe("kept");
  });

  it("redactForAudit caps monster strings (2000 chars)", () => {
    const redacted = redactForAudit({ blob: "x".repeat(100000) }) as Record<string, unknown>;
    expect((redacted["blob"] as string).length).toBe(2000);
  });

  it("appendAudit redacts on write — the journal never holds the raw payload", () => {
    writeFileSync(auditPath(root), "", "utf8");
    appendAudit(root, {
      ts: 2,
      sessionStartedAt: 1,
      tool: "type",
      args: { text: "my sk-or-v1-0123456789abcdef0123456789abcdef key" },
      outcome: {
        kind: "refusal",
        refusal: { error: "host_policy_denied", message: "declined" },
      },
    });
    const raw = readFileSync(auditPath(root), "utf8");
    expect(raw).not.toContain("sk-or-v1-0123");
    // The typed text became a length marker (omitKeys default).
    expect(raw).toContain('"text":{"redacted":true');
  });
});
