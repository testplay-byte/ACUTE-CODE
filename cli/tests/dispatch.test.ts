/**
 * ROUND-107 (R107-c-impl, F1): the run() DISPATCH through the REAL
 * connection resolver — env-pair mode (ACUTE_BASE_URL + ACUTE_TOKEN), which
 * resolves WITHOUT spawning and WITHOUT health-checking. Fetch is stubbed
 * to die, so a command that dispatches correctly lands on the honest
 * "unreachable" envelope; a flag-routing regression would instead surface
 * the pre-connect "unknown flag(s)" error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/main.js";

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

describe("run(): the env-mode dispatch (the real resolver, no spawn)", () => {
  beforeEach(() => {
    process.env.ACUTE_BASE_URL = "http://127.0.0.1:4601";
    process.env.ACUTE_TOKEN = "dispatch-token";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (): Promise<Response> => {
        throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
      }),
    );
  });

  afterEach(() => {
    delete process.env.ACUTE_BASE_URL;
    delete process.env.ACUTE_TOKEN;
    vi.unstubAllGlobals();
  });

  it("`sessions ls --limit 5` reaches the honest unreachable error (NOT an unknown flag)", async () => {
    const w = writers();
    const code = await run(["sessions", "ls", "--limit", "5"], { stdout: w.stdout, stderr: w.stderr });
    expect(code).toBe(1);
    expect(w.captured.err).toContain("unreachable http://127.0.0.1:4601");
    expect(w.captured.err).not.toContain("unknown flag");
    expect(w.captured.err).not.toContain("unknown command");
  });

  it("`approvals ls --status pending` dispatches the same way", async () => {
    const w = writers();
    const code = await run(["approvals", "ls", "--status", "pending"], {
      stdout: w.stdout,
      stderr: w.stderr,
    });
    expect(code).toBe(1);
    expect(w.captured.err).toContain("unreachable http://127.0.0.1:4601");
    expect(w.captured.err).not.toContain("unknown flag");
  });

  it("the --mode json lifecycle rides the attach line even for a dying connection", async () => {
    const w = writers();
    const code = await run(["--mode", "json", "sessions", "ls"], { stdout: w.stdout, stderr: w.stderr });
    expect(code).toBe(1);
    const lines = w.captured.out.trimEnd().split("\n");
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      type: "cli.attach",
      baseUrl: "http://127.0.0.1:4601",
      source: "env",
    });
    expect(JSON.parse(lines[lines.length - 1] ?? "{}")).toEqual({ type: "cli.exit", code: 1 });
  });
});
