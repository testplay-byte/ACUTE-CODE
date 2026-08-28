import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * ROUND-45 security round (audit Track 1, the three owner-deferred holes):
 *   P0-4 — the AUTO command tier is path-contained (no more `cat /etc/passwd`
 *          auto-running; it ASKS now, and explicit rules still win).
 *   P0-5 — web tools are gated: web_fetch + browser_control navigate pass
 *          a host gate (default allowlist / per-project rule / ask), and the
 *          web_search query is secret-scrubbed before leaving the machine.
 * (P0-3 — env scrubbing — lives in child-env.test.ts.)
 */
import {
  commandTouchesOutsideRoot,
  decideCommand,
  decideWebFetch,
  DEFAULT_WEB_HOST_ALLOWLIST,
  addWebHostRule,
  hasWebHostRule,
  listWebHostRules,
  requestWebFetchApproval,
} from "../src/approvals";
import { scrubSearchQuery } from "../src/tools/web";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";

let tempDir = "";
let db: SqliteDatabase;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r45-sec-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("P0-4: commandTouchesOutsideRoot (path tokens)", () => {
  const root = "/home/dev/proj";
  const outside = [
    "cat /etc/passwd",
    "cat /etc/shadow",
    "head -n 5 /var/log/syslog",
    "cat ~/.ssh/id_rsa",
    "ls ~",
    "cat ../secrets.env",
    "cat ../../outside.txt",
    "cat /home/dev/proj/../other/key.pem",
    `type C:\\Users\\dev\\.ssh\\id_rsa`,
    `type C:\\Windows\\system32\\config\\SAM`,
    "cat --file=/etc/passwd",
    "cat /etc/passwd && cat src/ok.ts", // compound: one bad segment poisons all
    "cat '/etc/passwd'", // quoted
    'cat "/etc/passwd"',
  ];
  const inside = [
    "ls",
    "cat src/index.ts",
    "cat ./package.json",
    "cat src/../src/index.ts", // resolves back inside
    'cat "my notes.txt"',
    "grep -r pattern",
    "grep -rn TODO src",
    "git status",
    "pnpm test",
    "node --version",
    "cat a/../b.txt", // root/b.txt
    "rg -t ts pattern",
    `type src\\main.rs`,
  ];

  it.each(outside)("flags OUTSIDE: %s", (command) => {
    expect(commandTouchesOutsideRoot(command, root)).toBe(true);
  });

  it.each(inside)("keeps INSIDE: %s", (command) => {
    expect(commandTouchesOutsideRoot(command, root)).toBe(false);
  });

  it("windows roots contain their own drive paths (case-insensitive)", () => {
    const winRoot = "C:\\Users\\dev\\proj";
    expect(commandTouchesOutsideRoot("type src\\main.rs", winRoot)).toBe(false);
    expect(commandTouchesOutsideRoot("type C:\\Users\\dev\\proj\\src\\main.rs", winRoot)).toBe(false);
    expect(commandTouchesOutsideRoot("type C:\\Users\\dev\\other\\x.txt", winRoot)).toBe(true);
    expect(commandTouchesOutsideRoot("cat D:\\x.txt", winRoot)).toBe(true);
  });
});

describe("P0-4: decideCommand demotes escaping AUTO commands to ASK", () => {
  const root = "/home/dev/proj";

  it("`cat /etc/passwd` asks instead of auto-running", () => {
    const decision = decideCommand(undefined, undefined, "cat /etc/passwd", root);
    expect(decision).toMatchObject({ action: "ask", category: "confirm" });
  });

  it("`cat src/index.ts` still auto-runs (containment must not cripple the tier)", () => {
    const decision = decideCommand(undefined, undefined, "cat src/index.ts", root);
    expect(decision).toMatchObject({ action: "run", category: "auto" });
  });

  it("without a root the legacy behavior is unchanged (back-compat seam)", () => {
    expect(decideCommand(undefined, undefined, "cat /etc/passwd")).toMatchObject({
      action: "run",
      category: "auto",
    });
  });

  it("an explicit always-allow rule beats the containment demotion", () => {
    db.prepare(
      "INSERT INTO approval_rules (id, project_id, command, created_at) VALUES (?, ?, ?, ?)",
    ).run(`rule_${randomUUID()}`, "proj_x", "cat /etc/passwd", new Date().toISOString());
    const decision = decideCommand(db, "proj_x", "cat /etc/passwd", root);
    expect(decision).toMatchObject({ action: "run", category: "rule" });
  });
});

describe("P0-5: decideWebFetch (host gate)", () => {
  it("allowlisted documentation hosts run on the auto tier", () => {
    expect(decideWebFetch(db, "proj_x", "https://developer.mozilla.org/en-US/docs/Web/API/fetch")).toEqual({
      action: "run",
      category: "auto",
      reason: expect.stringContaining("developer.mozilla.org"),
    });
    expect(decideWebFetch(db, "proj_x", "https://raw.githubusercontent.com/o/r/main/README.md").action).toBe("run");
    expect(decideWebFetch(db, "proj_x", "https://v2.tauri.app/reference/").action).toBe("run");
  });

  it("non-allowlisted hosts ASK (the exfiltration gate)", () => {
    const decision = decideWebFetch(db, "proj_x", "https://evil.example.org/payload");
    expect(decision).toEqual({ action: "ask", host: "evil.example.org" });
  });

  it("sub-domains do NOT inherit the parent's allowlist entry (fail-closed)", () => {
    // npmjs.com is allowlisted; registry.npmjs.org is separately listed — but
    // evil-npmjs.com.attacker.io and att-acker.npmjs.com.evil.io must ask.
    expect(decideWebFetch(db, "proj_x", "https://npmjs.com.evil.io/x").action).toBe("ask");
    expect(decideWebFetch(db, "proj_x", "https://x.npmjs.com.evil.io/").action).toBe("ask");
  });

  it("non-http(s) schemes and invalid URLs deny outright", () => {
    expect(decideWebFetch(db, "proj_x", "file:///etc/passwd")).toMatchObject({ action: "deny" });
    expect(decideWebFetch(db, "proj_x", "ftp://x/y")).toMatchObject({ action: "deny" });
    expect(decideWebFetch(db, "proj_x", "not a url")).toMatchObject({ action: "deny" });
  });

  it("project host rules run on the rule tier and are idempotent + listed", () => {
    addWebHostRule(db, "proj_x", "internal-docs.corp");
    expect(hasWebHostRule(db, "proj_x", "internal-docs.corp")).toBe(true);
    addWebHostRule(db, "proj_x", "internal-docs.corp"); // UNIQUE — no throw
    expect(listWebHostRules(db, "proj_x")).toContain("internal-docs.corp");
    expect(decideWebFetch(db, "proj_x", "https://internal-docs.corp/wiki")).toMatchObject({
      action: "run",
      category: "rule",
    });
    // scoped per project:
    expect(decideWebFetch(db, "proj_y", "https://internal-docs.corp/wiki").action).toBe("ask");
  });

  it("the default allowlist contains no wildcard entries and no localhost", () => {
    for (const host of DEFAULT_WEB_HOST_ALLOWLIST) {
      expect(host).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/);
      expect(host).not.toContain("*");
      expect(host).not.toContain("localhost");
      expect(host).not.toContain("127.0.0.1");
      expect(host).not.toContain("169.254"); // no link-local metadata endpoints
    }
  });
});

describe("P0-5: requestWebFetchApproval (interactive round-trip)", () => {
  function deps(overrides: Partial<Parameters<typeof requestWebFetchApproval>[0]> = {}) {
    return {
      db,
      sessionId: "sess_r45",
      agentId: "agt_r45",
      projectId: "proj_r45",
      interactive: false,
      ...overrides,
    };
  }

  it("non-interactive turns fail fast on non-allowlisted hosts (sub-agents can't wait)", async () => {
    const gate = await requestWebFetchApproval(deps(), "https://evil.example.org/x");
    expect(gate.allowed).toBe(false);
    expect(gate.note).toContain("interactive approval");
  });

  it("non-interactive turns still fetch allowlisted hosts without friction", async () => {
    const gate = await requestWebFetchApproval(deps(), "https://nodejs.org/api/fs.html");
    expect(gate.allowed).toBe(true);
  });

  it("the full ask → approve-always round-trip writes a host rule", async () => {
    const { setApprovalStatus, resolvePendingApproval } = await import("../src/approvals");
    const pendingApprovalId = await new Promise<string>((resolve) => {
      void (async () => {
        void requestWebFetchApproval(
          deps({ interactive: true }),
          "https://example.org/docs/api",
        );
        // Poll for the pending row, then approve-always out of band (the
        // decision route does BOTH: persist + wake the waiter).
        for (let i = 0; i < 100; i++) {
          await new Promise((r) => setTimeout(r, 20));
          const row = db
            .prepare("SELECT id FROM approvals WHERE status = 'pending' AND category = 'web' ORDER BY created_at DESC LIMIT 1")
            .get() as { id: string } | undefined;
          if (row !== undefined) {
            setApprovalStatus(db, row.id, "approved", "always");
            resolvePendingApproval(row.id, "approved");
            resolve(row.id);
            return;
          }
        }
        resolve("never");
      })();
    });
    expect(pendingApprovalId).not.toBe("never");
    // The host rule from the FIRST approval is already active — the second
    // call of the SAME host short-circuits on the rule tier (no new ask).
    const gate = await requestWebFetchApproval(deps({ interactive: true }), "https://example.org/docs/api");
    expect(gate.allowed).toBe(true);
    expect(gate.note).toContain("always-allowed");

    // The host rule exists and the pure decision agrees.
    expect(hasWebHostRule(db, "proj_r45", "example.org")).toBe(true);
    expect(decideWebFetch(db, "proj_r45", "https://example.org/other")).toMatchObject({
      action: "run",
      category: "rule",
    });
    // No lingering pending rows.
    const pending = db
      .prepare("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'")
      .get() as { n: number };
    expect(pending.n).toBe(0);
  });

  it("denied web approvals write no host rule", async () => {
    const { setApprovalStatus, resolvePendingApproval } = await import("../src/approvals");
    const gatePromise = requestWebFetchApproval(deps({ interactive: true }), "https://denied.example.org/x");
    await new Promise((r) => setTimeout(r, 120));
    const row = db
      .prepare("SELECT id FROM approvals WHERE status = 'pending' AND category = 'web' ORDER BY created_at DESC LIMIT 1")
      .get() as { id: string } | undefined;
    expect(row).toBeDefined();
    setApprovalStatus(db, row!.id, "denied", "once");
    resolvePendingApproval(row!.id, "denied");
    const gate = await gatePromise;
    expect(gate.allowed).toBe(false);
    expect(hasWebHostRule(db, "proj_r45", "denied.example.org")).toBe(false);
  });
});

describe("P0-5: scrubSearchQuery (the query never exfiltrates keys)", () => {
  it("replaces keyring-held secrets with [redacted]", () => {
    const out = scrubSearchQuery("what does sk-or-v1-abc123def456ghi789 do in node", [
      "sk-or-v1-abc123def456ghi789",
      "another-known-secret-value",
    ]);
    expect(out).toContain("[redacted]");
    expect(out).not.toContain("sk-or-v1-abc123def456ghi789");
  });

  it("catches key-SHAPED strings even when not in the keyring", () => {
    const out = scrubSearchQuery("error with ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop and AKIAIOSFODNN7EXAMPLE");
    expect(out).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop");
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out.match(/\[redacted\]/g)?.length).toBe(2);
  });

  it("leaves ordinary technical queries untouched", () => {
    const q = "vitest how to mock fetch in node environment 2026";
    expect(scrubSearchQuery(q, [])).toBe(q);
  });

  it("github PAT shape is caught", () => {
    const out = scrubSearchQuery("is github_pat_TESTFIXTURE-PURGED still active");
    expect(out).toContain("[redacted]");
    expect(out).not.toContain("github_pat_");
  });
});
