/**
 * ROUND-107 (R107-c-impl, F1/F3/F4/F7): the run() ARGUMENT GATES — every
 * error below must fire BEFORE resolveConnection (the connection module is
 * mocked to throw a sentinel: reaching it in an error test is the failure).
 * The happy-connection dispatch leg (`sessions ls --limit 5` → the real
 * resolver → the honest unreachable error) lives in dispatch.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import { run } from "../src/main.js";

vi.mock("../src/connection.js", () => ({
  defaultRepoRoot: () => "/nonexistent-repo",
  releaseConnection: vi.fn(async () => undefined),
  resolveConnection: vi.fn(async () => {
    throw new Error("SENTINEL: resolveConnection must not be reached by an argument error");
  }),
}));

interface Captured {
  out: string;
  err: string;
}

function writers(): { stdout: (s: string) => void; stderr: (s: string) => void; captured: Captured } {
  const captured: Captured = { out: "", err: "" };
  return {
    stdout: (s) => {
      captured.out += s;
    },
    stderr: (s) => {
      captured.err += s;
    },
    captured,
  };
}

describe("run(): the pre-connect short-circuits (no dialing, no spawning)", () => {
  it("--help renders the new surface (approvals row + --version) and exits 0", async () => {
    const w = writers();
    const code = await run(["--help"], { stdout: w.stdout, stderr: w.stderr });
    expect(code).toBe(0);
    expect(w.captured.out).toContain("approvals");
    expect(w.captured.out).toContain("--version");
    expect(w.captured.out).toContain("print the CLI version and exit");
    expect(w.captured.err).toBe("");
  });

  it("--help wins even over unknown flags (the flags table IS the help)", async () => {
    const w = writers();
    const code = await run(["--bogus", "--help"], { stdout: w.stdout, stderr: w.stderr });
    expect(code).toBe(0);
    expect(w.captured.out).toContain("usage:");
  });

  it("--version prints the CLI version and exits 0 (F4)", async () => {
    const w = writers();
    const code = await run(["--version"], { stdout: w.stdout, stderr: w.stderr });
    expect(code).toBe(0);
    expect(w.captured.out).toMatch(/^acute-cli \d+\.\d+\.\d+\n$/);
    expect(w.captured.err).toBe("");
  });

  it("an unknown command errors WITHOUT resolving a connection (F3)", async () => {
    const w = writers();
    const code = await run(["badcmd"], { stdout: w.stdout, stderr: w.stderr });
    expect(code).toBe(1);
    expect(w.captured.err).toContain("unknown command 'badcmd'");
    expect(w.captured.err).toContain("see: acute --help");
    expect(w.captured.err).not.toContain("SENTINEL");
  });

  it("a typo'd command gets a did-you-mean (F4)", async () => {
    const w = writers();
    const code = await run(["sesions"], { stdout: w.stdout, stderr: w.stderr });
    expect(code).toBe(1);
    expect(w.captured.err).toContain("unknown command 'sesions'");
    expect(w.captured.err).toContain("did you mean 'sessions'?");
  });

  it("an unknown flag with a close spelling suggests it (F4)", async () => {
    const w = writers();
    const code = await run(["--quie"], { stdout: w.stdout, stderr: w.stderr });
    expect(code).toBe(1);
    expect(w.captured.err).toContain("unknown flag(s): --quie — did you mean '--quiet'? — see: acute --help");
  });

  it("a typo'd COMMAND-scoped flag suggests the scoped row (F1+F4)", async () => {
    const w = writers();
    const code = await run(["sessions", "ls", "--limt", "5"], { stdout: w.stdout, stderr: w.stderr });
    expect(code).toBe(1);
    expect(w.captured.err).toContain("did you mean '--limit'?");
    expect(w.captured.err).not.toContain("SENTINEL");
  });

  it("a bare value flag errors: flag '--print' needs a value (F7)", async () => {
    const w = writers();
    const code = await run(["-p"], { stdout: w.stdout, stderr: w.stderr });
    expect(code).toBe(1);
    expect(w.captured.err).toContain("flag '--print' needs a value");
    expect(w.captured.err).not.toContain("SENTINEL");
  });

  it("the same gate for --model / --agent / --session / --db (F7)", async () => {
    for (const flag of ["--model", "--agent", "--session", "--db"]) {
      const w = writers();
      const code = await run([flag], { stdout: w.stdout, stderr: w.stderr });
      expect(code).toBe(1);
      expect(w.captured.err).toContain(`flag '${flag}' needs a value`);
    }
  });

  it("`sessions ls --limit 5` parses the scoped flag and REACHES the connection stage (F1)", async () => {
    const w = writers();
    const code = await run(["sessions", "ls", "--limit", "5"], { stdout: w.stdout, stderr: w.stderr });
    // Before F1 this failed with "unknown flag(s): --limit" BEFORE any
    // connection attempt; now the sentinel (the mocked resolver) is the
    // ONLY thing that can stop it — the flag parsed and dispatch began.
    expect(code).toBe(1);
    expect(w.captured.err).toContain("SENTINEL: resolveConnection");
    expect(w.captured.err).not.toContain("unknown flag");
  });

  it("`approvals ls --status pending` parses the scoped flags the same way (F1)", async () => {
    const w = writers();
    const code = await run(["approvals", "ls", "--status", "pending"], { stdout: w.stdout, stderr: w.stderr });
    expect(code).toBe(1);
    expect(w.captured.err).toContain("SENTINEL: resolveConnection");
    expect(w.captured.err).not.toContain("unknown flag");
  });
});
