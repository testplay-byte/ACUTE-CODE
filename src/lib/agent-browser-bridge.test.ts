// @vitest-environment happy-dom
/**
 * ROUND-62 (D8) — the FRONTEND side of the agent-browser command bridge.
 *
 * Unit-tests the dispatch registry: a registered handler's reply is POSTed
 * back as the REST result; a missing handler answers an honest error
 * immediately (the tool fails fast instead of burning its 15s timeout); a
 * throwing handler never breaks the dispatch. The api module is mocked —
 * the REST contract itself is pinned agent-core-side (browser-tool.test.ts
 * boots the real server).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const posted: Array<{ commandId: string; result: { ok: boolean; data?: unknown; error?: string } }> = [];

vi.mock("./api", () => ({
  postBrowserCommandResult: vi.fn(
    (commandId: string, result: { ok: boolean; data?: unknown; error?: string }) => {
      posted.push({ commandId, result });
      return Promise.resolve();
    },
  ),
}));

import {
  clearBrowserCommandHandlersForTest,
  dispatchBrowserCommand,
  hasBrowserCommandHandler,
  registerBrowserCommandHandler,
} from "./agent-browser-bridge";

beforeEach(() => {
  posted.length = 0;
  clearBrowserCommandHandlersForTest();
});

afterEach(() => {
  clearBrowserCommandHandlersForTest();
});

function frame(commandId: string, tabId: string, action: string, payload: Record<string, unknown> = {}) {
  return { type: "browser-command" as const, commandId, tabId, action, payload };
}

describe("agent-browser-bridge (R62 D8 dispatch registry)", () => {
  it("dispatches to the registered handler and POSTs its reply as the command result", async () => {
    registerBrowserCommandHandler("tab-1", async (action, payload) => {
      expect(action).toBe("eval");
      expect(payload).toEqual({ script: "return 1" });
      return { ok: true, data: { ok: true, value: 1 } };
    });
    dispatchBrowserCommand(frame("cmd-1", "tab-1", "eval", { script: "return 1" }));
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      commandId: "cmd-1",
      result: { ok: true, data: { ok: true, value: 1 } },
    });
  });

  it("no handler registered → immediate honest error result (no 15s timeout burn)", async () => {
    dispatchBrowserCommand(frame("cmd-2", "tab-gone", "eval", { script: "return 1" }));
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].result.ok).toBe(false);
    expect(posted[0].result.error).toContain("no embedded browser panel is mounted");
    expect(posted[0].commandId).toBe("cmd-2");
  });

  it("a THROWING handler answers with the exception's message (dispatch never rejects)", async () => {
    registerBrowserCommandHandler("tab-3", () => {
      throw new Error("webview exploded");
    });
    dispatchBrowserCommand(frame("cmd-3", "tab-3", "screenshot_meta"));
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].result.ok).toBe(false);
    expect(posted[0].result.error).toContain("webview exploded");
  });

  it("unregister removes only OUR handler (a newer mount's registration survives)", async () => {
    const unregisterOld = registerBrowserCommandHandler("tab-4", () => ({ ok: true, data: "old" }));
    registerBrowserCommandHandler("tab-4", () => ({ ok: true, data: "new" }));
    unregisterOld();
    expect(hasBrowserCommandHandler("tab-4")).toBe(true);
    dispatchBrowserCommand(frame("cmd-4", "tab-4", "eval"));
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].result.data).toBe("new");
  });

  it("a missing payload degrades to an empty object (the handler's shape checks stay simple)", async () => {
    let seen: Record<string, unknown> | null = null;
    registerBrowserCommandHandler("tab-5", (_action, payload) => {
      seen = payload;
      return { ok: true };
    });
    const noPayload = { type: "browser-command" as const, commandId: "cmd-5", tabId: "tab-5", action: "eval" };
    dispatchBrowserCommand(noPayload);
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(seen).toEqual({});
  });
});
