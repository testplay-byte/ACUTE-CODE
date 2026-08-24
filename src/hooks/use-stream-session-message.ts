import { useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { streamSessionMessage, type StreamTurnEvent } from "../lib/api";

/**
 * useStreamSessionMessage (Round 28 WS-D2, merged with WS-E): React Query
 * wrapper around the SSE streaming path.
 *
 * The AgentChatPanel's `runTurn` used to call `streamSessionMessage` inline.
 * This hook wraps it so:
 *   - the AbortController is owned by the hook (exposed via `stopRef` for
 *     the D3 Stop button to call `stopRef.current?.abort()`)
 *   - the onEvent callback is stable (no stale closure across re-renders)
 *   - the post-stream invalidations are centralized (session/sessions/usage/
 *     project-tree)
 *
 * Usage:
 *   const { runStreamed, stopRef, isStreaming } = useStreamSessionMessage();
 *   await runStreamed(sessionId, text, onEvent, { model });
 *   // Stop button: stopRef.current?.abort();
 */
export function useStreamSessionMessage() {
  const queryClient = useQueryClient();
  const abortRef = useRef<AbortController | null>(null);
  const streamingRef = useRef(false);

  const runStreamed = useCallback(
    async (
      sessionId: string,
      content: string,
      onEvent: (event: StreamTurnEvent) => void,
      options?: { model?: string },
    ) => {
      // Abort any in-flight stream first (defensive — the UI should disable
      // Send while streaming, but this guards against double-invocation).
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      streamingRef.current = true;

      try {
        await streamSessionMessage(sessionId, content, onEvent, {
          model: options?.model,
          signal: ctrl.signal,
        });
      } finally {
        streamingRef.current = false;
        // Centralized post-stream invalidations (session event log is the
        // canonical source of truth; sessions list + usage + tree follow).
        await queryClient.invalidateQueries({ queryKey: ["session"] });
        await queryClient.invalidateQueries({ queryKey: ["sessions"] });
        await queryClient.invalidateQueries({ queryKey: ["usage"] });
        void queryClient.invalidateQueries({ queryKey: ["project-tree"] });
        abortRef.current = null;
      }
    },
    [queryClient],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    streamingRef.current = false;
  }, []);

  return { runStreamed, stop, stopRef: abortRef, isStreamingRef: streamingRef };
}
