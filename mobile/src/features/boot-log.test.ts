/**
 * boot-log — the startup breadcrumb trail's pure-logic pins (R108).
 *
 * The trail is the app's own failure forensics (the v0.103.0 splash-forever
 * lesson: a stuck boot left NO evidence). These pins hold the contract:
 * stages record in order with deltas, the ERROR record formats honestly,
 * the global hook chains the previous handler, and identity degrades
 * gracefully where Platform has no numeric version.
 */

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { bootIdentity, bootLog, getBootError, getBootStages, getBootTrace, installBootErrorHandling, recordBootError, _resetBootLogForTests } from "./boot-log";

beforeEach(() => {
  _resetBootLogForTests();
});

describe("bootLog / getBootTrace", () => {
  it("records stages in order and formats the trail one-per-line", () => {
    bootLog("first");
    bootLog("second", "with detail");
    const lines = getBootTrace().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.some((l) => l.includes("ms first"))).toBe(true);
    expect(lines.some((l) => l.includes("ms second — with detail"))).toBe(true);
    // Order: the "first" line precedes the "second" line in the trail.
    const firstIdx = lines.findIndex((l) => l.includes("first"));
    const secondIdx = lines.findIndex((l) => l.includes("second"));
    expect(firstIdx).toBeLessThan(secondIdx);
  });

  it("keeps the stage list bounded (a long boot never grows without limit)", () => {
    for (let i = 0; i < 80; i++) bootLog(`stage-${i}`);
    expect(getBootStages().length).toBeLessThanOrEqual(64);
  });

  it("exposes stages as data with non-decreasing timestamps", () => {
    bootLog("a");
    bootLog("b");
    const stages = getBootStages();
    for (let i = 1; i < stages.length; i++) {
      expect(stages[i].at).toBeGreaterThanOrEqual(stages[i - 1].at);
    }
  });
});

describe("recordBootError", () => {
  it("formats an Error as name: message + stack", () => {
    const boom = new Error("the ship sank");
    recordBootError(boom);
    expect(getBootError()).toContain("Error: the ship sank");
  });

  it("formats a non-Error throw honestly (String())", () => {
    recordBootError("just a string");
    expect(getBootError()).toContain("just a string");
  });
});

describe("installBootErrorHandling", () => {
  type Handler = (error: unknown, isFatal?: boolean) => void;

  function installWithFakeErrorUtils(previous?: Handler) {
    let wired: Handler | null = null;
    const ErrorUtils = {
      setGlobalHandler: (h: Handler) => {
        wired = h;
      },
      getGlobalHandler: () => previous ?? (() => {}),
    };
    const saved = (globalThis as Record<string, unknown>).ErrorUtils;
    (globalThis as Record<string, unknown>).ErrorUtils = ErrorUtils;
    installBootErrorHandling();
    (globalThis as Record<string, unknown>).ErrorUtils = saved;
    return () => wired;
  }

  it("wires the handler and chains the previous one", () => {
    const previous = jest.fn();
    const getWired = installWithFakeErrorUtils(previous);
    const wired = getWired();
    expect(wired).not.toBeNull();
    wired?.(new Error("fatal thing"), true);
    expect(previous).toHaveBeenCalledWith(expect.any(Error), true);
    expect(getBootError()).toContain("fatal thing");
  });

  it("survives a previous handler that itself throws (the record wins)", () => {
    const previous = () => {
      throw new Error("previous handler is broken");
    };
    const getWired = installWithFakeErrorUtils(previous);
    expect(() => getWired()?.(new Error("the real error"))).not.toThrow();
    expect(getBootError()).toContain("the real error");
  });

  it("is a no-op without ErrorUtils (jest/web) and does not throw", () => {
    const saved = (globalThis as Record<string, unknown>).ErrorUtils;
    delete (globalThis as Record<string, unknown>).ErrorUtils;
    expect(() => installBootErrorHandling()).not.toThrow();
    (globalThis as Record<string, unknown>).ErrorUtils = saved;
  });
});

describe("bootIdentity", () => {
  it("returns a non-empty platform string", () => {
    expect(bootIdentity().length).toBeGreaterThan(0);
  });
});
