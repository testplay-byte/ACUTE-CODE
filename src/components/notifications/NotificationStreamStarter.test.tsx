// @vitest-environment happy-dom
/**
 * ROUND-98 (R98-J, owner: task complete / failed / permission needed →
 * "it will send me a notification on my PC") — the SSE fan-out pins:
 * task_complete / task_failed / permission_request records call
 * notifyDesktop with the FIXED titles and the record's message as the
 * body; subagent_* records stay in-app ONLY (never called).
 *
 * The stream is mocked at its seam (streamNotifications): the captured
 * onEvent callback is driven directly with records, exactly as the real
 * SSE reader would deliver them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, waitFor } from "@testing-library/react";
import type { NotificationRecord } from "../../lib/notifications-api";
import { useConfigStore } from "../../lib/config-store";
import { useNotificationStreamStore } from "../../hooks/use-notifications";
import { renderWithProviders, resetTestState } from "../../test-utils";

// vi.hoisted: the mock factory + the test body share ONE notifyDesktop spy
// (vi.mock factories run before module-level const initialization).
const mocks = vi.hoisted(() => ({
  notifyDesktop: vi.fn(async (): Promise<void> => undefined),
}));
const notifyDesktop = mocks.notifyDesktop;

vi.mock("../../lib/desktop-notifications", () => ({
  notifyDesktop: mocks.notifyDesktop,
  initDesktopNotifications: vi.fn(),
  setDesktopNotificationsEnabled: vi.fn(),
  isDesktopNotificationsEnabled: vi.fn(() => true),
}));

type StreamEventHandler = (event: Record<string, unknown>) => void;
const handlers: StreamEventHandler[] = [];

vi.mock("../../lib/notifications-api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/notifications-api")>();
  return {
    ...original,
    streamNotifications: vi.fn(async (onEvent: StreamEventHandler) => {
      handlers.push(onEvent);
      // The stream stays "open" for the test's lifetime — no reconnect
      // churn, no resolution (the abort signal is the only closer).
      return new Promise<void>(() => undefined);
    }),
  };
});

import { NotificationStreamStarter } from "./NotificationStreamStarter";

beforeEach(() => {
  resetTestState();
  handlers.length = 0;
  notifyDesktop.mockClear();
  // Live mode so the starter actually opens the stream.
  useConfigStore.setState({ demoData: false, baseUrl: "http://127.0.0.1:5178", token: "tok" });
  useNotificationStreamStore.getState().reset();
});

afterEach(() => {
  cleanup();
});

function record(overrides: Partial<NotificationRecord>): NotificationRecord {
  return {
    id: `ntf_${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    kind: "task_complete",
    title: "Ship the feature",
    body: "Done — all checks green",
    sessionId: "sess_1",
    projectId: "prj_1",
    read: 0,
    ...overrides,
  };
}

describe("R98-J: the notification stream's desktop fan-out", () => {
  it("task_complete → notifyDesktop with the fixed title + the record's message as the body", async () => {
    renderWithProviders(<NotificationStreamStarter />);
    await waitFor(() => expect(handlers.length).toBeGreaterThan(0));

    act(() => {
      handlers[0]({
        ...record({ kind: "task_complete", title: "Ship the feature", body: "Done — 3 files changed" }),
      });
    });

    expect(notifyDesktop).toHaveBeenCalledTimes(1);
    expect(notifyDesktop).toHaveBeenCalledWith({
      title: "Task complete",
      body: "Done — 3 files changed",
      kind: "task_complete",
    });
  });

  it("task_failed + permission_request use their fixed titles; a null body falls back to the record's title", async () => {
    renderWithProviders(<NotificationStreamStarter />);
    await waitFor(() => expect(handlers.length).toBeGreaterThan(0));

    act(() => {
      handlers[0]({
        ...record({ kind: "task_failed", title: "Debug the build", body: "Provider 429 after 6 attempts" }),
      });
    });
    act(() => {
      handlers[0]({
        ...record({ kind: "permission_request", title: "Approve run_command?", body: null }),
      });
    });

    expect(notifyDesktop).toHaveBeenCalledTimes(2);
    expect(notifyDesktop).toHaveBeenNthCalledWith(1, {
      title: "Task failed",
      body: "Provider 429 after 6 attempts",
      kind: "task_failed",
    });
    expect(notifyDesktop).toHaveBeenNthCalledWith(2, {
      title: "Permission needed",
      body: "Approve run_command?",
      kind: "permission_request",
    });
  });

  it("subagent_* records stay in-app ONLY — notifyDesktop is never called", async () => {
    renderWithProviders(<NotificationStreamStarter />);
    await waitFor(() => expect(handlers.length).toBeGreaterThan(0));

    act(() => {
      handlers[0]({
        ...record({ kind: "subagent_complete", title: "Sub-agent (researcher) completed", body: "found 3 refs" }),
      });
    });
    act(() => {
      handlers[0]({
        ...record({ kind: "subagent_failed", title: "Sub-agent (coder) failed", body: "no keys" }),
      });
    });

    expect(notifyDesktop).not.toHaveBeenCalled();
    // …but the in-app leg still ticked (the toast + bell read the store).
    expect(useNotificationStreamStore.getState().unread).toBe(2);
  });

  it("demo mode never opens the stream (and thus never fans out)", async () => {
    useConfigStore.setState({ demoData: true });
    renderWithProviders(<NotificationStreamStarter />);
    await waitFor(() => {
      expect(useNotificationStreamStore.getState().status).toBe("demo");
    });
    expect(handlers).toHaveLength(0);
    expect(notifyDesktop).not.toHaveBeenCalled();
  });
});
