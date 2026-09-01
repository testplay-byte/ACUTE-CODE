import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAll,
  dismiss,
  errors,
  ERROR_BUS_DEDUPE_WINDOW_MS,
  ERROR_BUS_RING_CAP,
  reportAppError,
  scrub,
  subscribe,
} from "./error-bus";

/**
 * ROUND-59 (R59-E): pins for the frontend error bus — the store behind the
 * right-sidebar Console tab (owner: "proper console-like error monitoring
 * and error handling"). The bus is module-level state, so every test starts
 * from clearAll(); the dedupe window is exercised through fake timers so the
 * 5s boundary is deterministic.
 */

beforeEach(() => {
  clearAll();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("error-bus (R59-E)", () => {
  it("reports a newest-first row with the full AppError shape", () => {
    const id = reportAppError({
      source: "frontend",
      kind: "window.onerror",
      message: "Cannot read properties of undefined (reading 'map')",
      detail: "at ProjectList (ProjectList.tsx:42:17)",
    });
    expect(id).toBeTruthy();
    expect(errors()).toHaveLength(1);
    const row = errors()[0];
    expect(row).toMatchObject({
      id,
      source: "frontend",
      kind: "window.onerror",
      message: "Cannot read properties of undefined (reading 'map')",
      detail: "at ProjectList (ProjectList.tsx:42:17)",
      count: 1,
    });
    expect(row.ts).toBeTypeOf("number");
    expect(row.componentStack).toBeUndefined();

    // Second, different error → newest first.
    reportAppError({ source: "frontend", kind: "render", message: "boom" });
    expect(errors()[0].message).toBe("boom");
    expect(errors()[1].message).toContain("Cannot read properties");
  });

  it("increments count on identical consecutive errors inside the window (no new row)", () => {
    const first = reportAppError({ source: "frontend", kind: "query", message: "sidecar down" });
    vi.advanceTimersByTime(1_000);
    const second = reportAppError({ source: "frontend", kind: "query", message: "sidecar down" });
    // Same row absorbs the occurrence — id preserved, count bumped, ts moved.
    expect(second).toBe(first);
    expect(errors()).toHaveLength(1);
    expect(errors()[0].count).toBe(2);
    expect(errors()[0].ts).toBe(Date.now());

    // Third occurrence at the window edge (4999ms after the SECOND report)
    // still dedupes: the window is measured from the most recent occurrence.
    vi.advanceTimersByTime(4_999);
    reportAppError({ source: "frontend", kind: "query", message: "sidecar down" });
    expect(errors()).toHaveLength(1);
    expect(errors()[0].count).toBe(3);
  });

  it("opens a NEW row when the identical error arrives after the window", () => {
    reportAppError({ source: "frontend", kind: "query", message: "sidecar down" });
    vi.advanceTimersByTime(ERROR_BUS_DEDUPE_WINDOW_MS + 1);
    reportAppError({ source: "frontend", kind: "query", message: "sidecar down" });
    expect(errors()).toHaveLength(2);
    expect(errors()[0].count).toBe(1);
    expect(errors()[1].count).toBe(1);
  });

  it("does NOT dedupe across different source, kind, or message", () => {
    reportAppError({ source: "frontend", kind: "query", message: "same text" });
    reportAppError({ source: "sidecar", kind: "query", message: "same text" });
    reportAppError({ source: "frontend", kind: "render", message: "same text" });
    reportAppError({ source: "frontend", kind: "query", message: "other text" });
    expect(errors()).toHaveLength(4);
  });

  it("does not merge an error that follows a DIFFERENT error (consecutive means newest-row)", () => {
    reportAppError({ source: "frontend", kind: "query", message: "A" });
    reportAppError({ source: "frontend", kind: "query", message: "B" });
    // A again within the window — but B sits on top; A gets its own new row.
    reportAppError({ source: "frontend", kind: "query", message: "A" });
    expect(errors()).toHaveLength(3);
    expect(errors().map((e) => e.message)).toEqual(["A", "B", "A"]);
  });

  it("drops the oldest rows past the 200-entry cap", () => {
    expect(ERROR_BUS_RING_CAP).toBe(200);
    for (let i = 0; i < ERROR_BUS_RING_CAP + 17; i++) {
      // Alternate messages so nothing dedupes.
      reportAppError({ source: "frontend", kind: "window.onerror", message: `err-${i}` });
    }
    expect(errors()).toHaveLength(ERROR_BUS_RING_CAP);
    // Newest survived, oldest dropped.
    expect(errors()[0].message).toBe(`err-${ERROR_BUS_RING_CAP + 16}`);
    expect(errors().at(-1)?.message).toBe("err-17");
  });

  it("subscribe fires on report/dismiss/clearAll and unsubscribes cleanly", () => {
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);
    expect(listener).not.toHaveBeenCalled();

    reportAppError({ source: "frontend", kind: "render", message: "boom" });
    expect(listener).toHaveBeenCalledTimes(1);

    dismiss("does-not-exist");
    expect(listener).toHaveBeenCalledTimes(1); // no-op dismissal stays silent

    const id = errors()[0].id;
    dismiss(id);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(errors()).toHaveLength(0);

    clearAll(); // empty ring → no emit
    expect(listener).toHaveBeenCalledTimes(2);

    reportAppError({ source: "frontend", kind: "render", message: "boom again" });
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
    reportAppError({ source: "frontend", kind: "render", message: "boom once more" });
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("dismiss removes exactly one row; clearAll empties the ring", () => {
    reportAppError({ source: "frontend", kind: "a", message: "one" });
    reportAppError({ source: "frontend", kind: "b", message: "two" });
    reportAppError({ source: "frontend", kind: "c", message: "three" });
    const middleId = errors()[1].id;
    dismiss(middleId);
    expect(errors().map((e) => e.message)).toEqual(["three", "one"]);

    clearAll();
    expect(errors()).toHaveLength(0);
    clearAll(); // idempotent
    expect(errors()).toHaveLength(0);
  });

  it("scrubs bearer tokens, Authorization headers and key-shaped material before capture", () => {
    reportAppError({
      source: "frontend",
      kind: "fetch",
      message: "401 from Authorization: Bearer acute-dev-local-abcdef",
      detail: "token=sk-or-v1-0123456789abcdef header Authorization: Bearer supersecret123456",
      componentStack: "at Row (Row.tsx:1:1)\nAuthorization: Bearer anothersecretvalue",
    });
    const row = errors()[0];
    const everything = JSON.stringify(row);
    for (const secret of [
      "acute-dev-local-abcdef",
      "sk-or-v1-0123456789abcdef",
      "supersecret123456",
      "anothersecretvalue",
    ]) {
      expect(everything).not.toContain(secret);
    }
    expect(row.message).toContain("***"); // "Authorization: ***" won the overlap
    expect(row.detail).toContain("token: ***");
    expect(row.componentStack).toContain("Authorization: ***");
  });

  it("scrub() is the exported text filter — bearer keys and sk- tokens redact directly", () => {
    expect(scrub("Authorization: Bearer tok_9f8e7d6c5b")).not.toContain("tok_9f8e7d6c5b");
    expect(scrub("key sk-or-v1-abcdef123456 loaded")).toContain("sk-***");
    // Clean text passes through untouched.
    expect(scrub("plain error message")).toBe("plain error message");
  });

  it("caps oversized captured text (stacks stay bounded)", () => {
    const huge = "x".repeat(20_000);
    reportAppError({ source: "frontend", kind: "render", message: "big", detail: huge });
    expect(errors()[0].detail?.length).toBeLessThanOrEqual(8_100);
    expect(errors()[0].detail).toContain("(truncated");
  });

  it("keeps the snapshot identity stable between mutations (useSyncExternalStore contract)", () => {
    const before = errors();
    reportAppError({ source: "frontend", kind: "k", message: "m" });
    const after = errors();
    expect(after).not.toBe(before); // mutation → new array
    expect(errors()).toBe(after); // no mutation → same reference
    expect(after).not.toBe(after.slice()); // sanity: slice really copies
  });
});
