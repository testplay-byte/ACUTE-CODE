// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTimeoutClear } from "./use-timeout-clear";

/**
 * ROUND-57: the leak-safe transient-message scheduler. The bare
 * `setTimeout(() => setX(null), N)` idiom leaked timers past unmount — in
 * the happy-dom suite the callback fired AFTER teardown, React-DOM hit
 * `window is not defined`, and vitest failed the WHOLE suite despite every
 * test passing (CI run 33411797885). These tests pin the three properties
 * that make the hook safe.
 */

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useTimeoutClear (ROUND-57 leak-safe scheduler)", () => {
  it("fires the callback after the delay", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useTimeoutClear());
    const fired = vi.fn();
    act(() => {
      result.current(fired, 1500);
    });
    expect(fired).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1499);
    });
    expect(fired).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it("cancels the pending timer on unmount — the callback never fires, no teardown race (the exact CI 33411797885 failure mode)", () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useTimeoutClear());
    const fired = vi.fn();
    act(() => {
      result.current(fired, 1500);
    });
    unmount();
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(fired).not.toHaveBeenCalled();
  });

  it("rescheduling replaces the previous timer — only the latest reset wins", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useTimeoutClear());
    const first = vi.fn();
    const second = vi.fn();
    act(() => {
      result.current(first, 1500);
    });
    act(() => {
      result.current(second, 1500);
    });
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
