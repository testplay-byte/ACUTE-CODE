// @vitest-environment node
//
// ROUND-117 (R117-e) — deliverable 1: the PROCESS-LEVEL CRASH HANDLERS
// (lib/crash-handlers.ts). installCrashHandlers is fully injectable (the
// ring sink, the log fn, the exit fn) and takes a fake signal target, so
// the suite drives the registered listeners directly — the REAL process is
// never touched (an actual uncaughtException in the vitest worker would
// otherwise be fatal noise).
import { describe, expect, it } from "vitest";
import {
  CRASH_LOG_PREFIX,
  formatCrashError,
  installCrashHandlers,
  scrubCrashText,
  type CrashHandlerDeps,
  type CrashSignalTarget,
} from "../src/lib/crash-handlers";

/** A fake process: captures the listeners installCrashHandlers registers. */
class FakeSignalTarget implements CrashSignalTarget {
  readonly listeners = new Map<string, (arg: unknown) => void>();
  on(event: string, listener: (...args: unknown[]) => void): unknown {
    this.listeners.set(event, listener);
    return this;
  }
  fire(event: "uncaughtException" | "unhandledRejection", arg: unknown): void {
    const listener = this.listeners.get(event);
    if (listener === undefined) throw new Error(`no listener for ${event}`);
    listener(arg);
  }
}

/** Injectable deps capturing every effect. */
function makeDeps(): CrashHandlerDeps & {
  recorded: string[];
  logged: unknown[][];
  exits: number[];
} {
  const recorded: string[] = [];
  const logged: unknown[][] = [];
  const exits: number[] = [];
  return {
    recorded,
    logged,
    exits,
    record: (message) => {
      recorded.push(message);
    },
    log: (...args) => {
      logged.push(args);
    },
    exit: (code) => {
      exits.push(code);
    },
  };
}

describe("R117-e: installCrashHandlers (the process-level crash net)", () => {
  it("registers BOTH signals on the target", () => {
    const target = new FakeSignalTarget();
    installCrashHandlers(makeDeps(), target);
    expect([...target.listeners.keys()].sort()).toEqual(["uncaughtException", "unhandledRejection"]);
  });

  it("uncaughtException: records + logs the scrubbed error, then exits 1 — ONCE", () => {
    const target = new FakeSignalTarget();
    const deps = makeDeps();
    installCrashHandlers(deps, target);

    target.fire("uncaughtException", new Error("boom: the engine tripped"));
    expect(deps.exits).toEqual([1]);
    expect(deps.recorded).toHaveLength(1);
    expect(deps.recorded[0]).toContain("uncaughtException");
    expect(deps.recorded[0]).toContain("Error: boom: the engine tripped");
    expect(deps.recorded[0]).toContain(CRASH_LOG_PREFIX);
    // The log line IS the record line (one line, both sinks).
    expect(deps.logged).toHaveLength(1);
    expect(deps.logged[0][0]).toBe(deps.recorded[0]);
    // The error's stack rides along (the post-mortem gold).
    expect(deps.recorded[0]).toContain("at ");
  });

  it("unhandledRejection: same treatment (record + log + exit 1)", () => {
    const target = new FakeSignalTarget();
    const deps = makeDeps();
    installCrashHandlers(deps, target);

    // A rejection reason can be anything — an Error, a string, an object.
    target.fire("unhandledRejection", new Error("the promise nobody awaited"));
    expect(deps.exits).toEqual([1]);
    expect(deps.recorded[0]).toContain("unhandledRejection");
    expect(deps.recorded[0]).toContain("the promise nobody awaited");
  });

  it("a NON-Error rejection reason still formats honestly (no throw, no \"[object Object]\")", () => {
    // Fresh install — the double-fire guard would swallow a second crash on
    // the same handler (pinned in its own test below).
    const target = new FakeSignalTarget();
    const deps = makeDeps();
    installCrashHandlers(deps, target);
    target.fire("unhandledRejection", { weird: "reason" });
    expect(deps.exits).toEqual([1]);
    expect(deps.recorded[0]).toContain("weird");
    expect(deps.recorded[0]).not.toContain("[object Object]");
  });

  it("double-fire guard: after the first crash the exit is in flight — later crashes change nothing", () => {
    const target = new FakeSignalTarget();
    const deps = makeDeps();
    installCrashHandlers(deps, target);

    target.fire("uncaughtException", new Error("the FIRST error"));
    target.fire("uncaughtException", new Error("cascade noise"));
    target.fire("unhandledRejection", new Error("more cascade noise"));
    expect(deps.exits).toEqual([1]);
    expect(deps.recorded).toHaveLength(1);
    expect(deps.logged).toHaveLength(1);
    expect(deps.recorded[0]).toContain("the FIRST error");
  });

  it("scrubs secret shapes from BOTH sinks (the ring record + the sidecar.log line)", () => {
    const target = new FakeSignalTarget();
    const deps = makeDeps();
    installCrashHandlers(deps, target);

    target.fire(
      "uncaughtException",
      new Error("provider call failed with Bearer abc123def456ghi789 and key sk-or-v1-abcdef0123456789"),
    );
    const line = deps.recorded[0];
    expect(line).not.toContain("abc123def456ghi789");
    expect(line).not.toContain("sk-or-v1-abcdef0123456789");
    expect(line).toContain("Bearer ***");
    expect(line).toContain("sk-***");
    expect(String(deps.logged[0][0])).not.toContain("sk-or-v1-abcdef0123456789");
  });

  it("a THROWING record sink never breaks the durable half (log + exit still fire)", () => {
    const target = new FakeSignalTarget();
    const logged: unknown[][] = [];
    const exits: number[] = [];
    installCrashHandlers(
      {
        record: () => {
          throw new Error("the ring itself is broken");
        },
        log: (...args) => {
          logged.push(args);
        },
        exit: (code) => {
          exits.push(code);
        },
      },
      target,
    );
    target.fire("uncaughtException", new Error("boom"));
    expect(exits).toEqual([1]);
    expect(logged).toHaveLength(1);
  });
});

describe("R117-e: crash formatting helpers", () => {
  it("formatCrashError: Error → name + message + stack; string passes through; objects JSON", () => {
    const err = new Error("x");
    expect(formatCrashError(err)).toContain("Error: x");
    expect(formatCrashError(err)).toContain("at ");
    expect(formatCrashError("plain string")).toBe("plain string");
    expect(formatCrashError({ a: 1 })).toBe('{"a":1}');
  });

  it("scrubCrashText: Bearer tokens + the R82 key shapes (sk-/github_pat_/nvapi-)", () => {
    const scrubbed = scrubCrashText(
      "Authorization: Bearer tok-1234567890 key=sk-abc123abc123abc1 pat=github_pat_aaaa nvapi-nvapi-nvapi-nvapi-nvapi",
    );
    expect(scrubbed).toContain("Bearer ***");
    expect(scrubbed).not.toContain("tok-1234567890");
    expect(scrubbed).not.toContain("sk-abc123abc123abc1");
    expect(scrubbed).not.toContain("github_pat_aaaa");
    expect(scrubbed).not.toContain("nvapi-nvapi-nvapi-nvapi-nvapi");
  });
});

describe("R117-e: main.ts production wiring shape (static import contract)", () => {
  it("main.ts installs the handlers with the module sink + console.error + a deferred exit", async () => {
    // Read the compiled source as TEXT — the entry cannot be imported in a
    // test worker (it exits when ACUTE_TOKEN is absent), so pin the wiring
    // shape statically: the install call, the sink, the log, the exit code.
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const source = await readFile(
      fileURLToPath(new URL("../src/main.ts", import.meta.url)),
      "utf8",
    );
    expect(source).toContain("installCrashHandlers({");
    expect(source).toContain('recordDiagnostic("crash", message)');
    expect(source).toContain("console.error");
    expect(source).toContain("process.exitCode = code");
    expect(source).toContain("process.exit(code)");
  });
});
