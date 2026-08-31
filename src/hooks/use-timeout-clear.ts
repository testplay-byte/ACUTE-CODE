import { useCallback, useEffect, useRef } from "react";

/**
 * ROUND-57: schedule a one-shot state reset that is safe across unmount and
 * test-environment teardown.
 *
 * The bare `setTimeout(() => setX(null), N)` idiom (11 call sites when this
 * landed) leaks its timer past component unmount. In the vitest happy-dom
 * suite that leaked callback can fire AFTER the environment is torn down —
 * React-DOM's dispatchSetState then hits `window is not defined`, vitest
 * reports an uncaught exception, and the WHOLE suite fails despite every
 * test passing (CI run 33411797885, a docs-only commit: the 1500 ms
 * "Slot added." reset in ModelsProvidersTab outlived its test).
 *
 * This hook:
 *  - tracks the handle in a ref and CLEARS it on unmount (useEffect cleanup),
 *  - clears the PREVIOUS timer when a new one is scheduled (only the latest
 *    reset should win — same intent as the bare idiom, minus the leak),
 *  - nulls the ref when the timer fires so cleanup is a no-op.
 *
 * Usage:
 *   const resetAfter = useTimeoutClear();
 *   setMsg("Slot added.");
 *   resetAfter(() => setMsg(null), 1500);
 */
export function useTimeoutClear(): (fn: () => void, ms: number) => void {
  const handleRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (handleRef.current !== null) clearTimeout(handleRef.current);
    };
  }, []);

  return useCallback((fn: () => void, ms: number) => {
    if (handleRef.current !== null) clearTimeout(handleRef.current);
    handleRef.current = setTimeout(() => {
      handleRef.current = null;
      fn();
    }, ms);
  }, []);
}
