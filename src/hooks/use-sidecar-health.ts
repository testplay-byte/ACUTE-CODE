import { useEffect, useRef } from "react";
import { useConfigStore } from "../lib/config-store";

/**
 * useSidecarHealth (Round 28 WS-D2/WS-E): boot-time health ping.
 *
 * Owner R28 complaint: "The live response handling is not being done
 * properly. It completes all the tasks and then directly shows the results.
 * It does not show the typing effect."
 *
 * Root cause (plan §7.2): `demoData` defaults `true`. In demo mode,
 * AgentChatPanel falls back to the SYNCHRONOUS `POST /sessions/:id/messages`
 * route — the entire turn result returns only AFTER all tool calls + final
 * text complete. This matches "completes all tasks then directly shows the
 * results" exactly.
 *
 * The fix: on app boot, ping `GET {baseUrl}/api/v1/health`. If 200 + a token
 * is available, auto-call `setDemoData(false)`. This activates the streaming
 * path (the SSE `POST /sessions/:id/messages/stream` route) so text deltas
 * + tool calls land live with the typing-effect bubble.
 *
 * The config-store already flips demoData false when VITE_ACUTE_BASE_URL is
 * set (the dev env var path). This hook covers the BROWSER dev case where
 * the sidecar is running on the default port but the env var wasn't passed
 * to vite — and the Tauri packaged case where the shell hasn't answered
 * adoptEndpoint yet.
 *
 * Runs once on mount (ref-guarded). On failure (sidecar unreachable), leaves
 * demoData in its current state (true → demo mode persists; the demo-mode
 * banner from WS-E will inform the user).
 */
export function useSidecarHealth() {
  const ranRef = useRef(false);
  const baseUrl = useConfigStore((s) => s.baseUrl);
  const token = useConfigStore((s) => s.token);
  const setDemoData = useConfigStore((s) => s.setDemoData);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    // No token → no live streaming possible; stay in demo mode.
    if (!token) return;

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 3000);

    fetch(`${baseUrl}/api/v1/health`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    })
      .then((r) => {
        if (r.ok) {
          // Sidecar is up + token works → activate streaming path.
          setDemoData(false);
        }
      })
      .catch(() => {
        // Sidecar unreachable — leave demoData in its current state.
        // The demo-mode banner (AgentChatPanel) will inform the user.
      })
      .finally(() => clearTimeout(timeout));

    return () => {
      clearTimeout(timeout);
      ctrl.abort();
    };
  }, [baseUrl, token, setDemoData]);
}
