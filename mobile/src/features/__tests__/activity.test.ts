/**
 * activity.test.ts — the live activity store + frame parser's contract
 * (R109: the live notifications stream the bell + badges ride).
 */

import { describe, expect, it, jest } from "@jest/globals";

// The pure core under test — the native transport chain is mocked so no
// React Native bridge is ever touched (the link-layer convention).
jest.mock("@/link/runtime", () => ({ getLinkManager: () => ({}) }));

import { ActivityStore, parseActivityFrame } from "../activity";

describe("parseActivityFrame", () => {
  it("parses the hello frame", () => {
    expect(parseActivityFrame(JSON.stringify({ type: "hello", unread: 3 }))).toEqual({
      type: "hello",
      unread: 3,
    });
  });

  it("parses a notification record", () => {
    const row = {
      id: "n1",
      ts: "2026-09-19T10:00:00Z",
      kind: "approval",
      title: "Command needs approval",
      body: "rm -rf …",
      sessionId: "s1",
      projectId: "p1",
      read: 0,
    };
    const frame = parseActivityFrame(JSON.stringify(row));
    expect(frame).toEqual({ type: "notification", ...row });
  });

  it("non-JSON and unknown shapes are honest nulls", () => {
    expect(parseActivityFrame("not json")).toBeNull();
    expect(parseActivityFrame(JSON.stringify({ type: "unknown" }))).toBeNull();
    expect(parseActivityFrame(JSON.stringify({ type: "hello", unread: "many" }))).toBeNull();
  });
});

describe("ActivityStore", () => {
  it("unread counts set, live rows increment + dedupe", () => {
    const store = new ActivityStore();
    store.setUnread(2);
    expect(store.getState().unread).toBe(2);
    const row = {
      id: "n1",
      ts: "2026-09-19T10:00:00Z",
      kind: "task",
      title: "done",
      body: "",
      sessionId: null,
      projectId: null,
      read: 0 as const,
    };
    store.applyLiveNotification(row);
    expect(store.getState().unread).toBe(3);
    // The same row re-delivered does not double-count.
    store.applyLiveNotification(row);
    expect(store.getState().unread).toBe(3);
    expect(store.getState().latest).toHaveLength(1);
  });

  it("a read notification does not bump unread", () => {
    const store = new ActivityStore();
    store.applyLiveNotification({
      id: "n2",
      ts: "2026-09-19T10:00:00Z",
      kind: "task",
      title: "done",
      body: "",
      sessionId: null,
      projectId: null,
      read: 1,
    });
    expect(store.getState().unread).toBe(0);
  });

  it("markRead decrements once and updates the row", () => {
    const store = new ActivityStore();
    store.applyPage({
      notifications: [
        {
          id: "a",
          ts: "2026-09-19T10:00:00Z",
          kind: "task",
          title: "t",
          body: "",
          sessionId: null,
          projectId: null,
          read: 0,
        },
      ],
      unread: 1,
    });
    expect(store.markRead("a")).toBeUndefined();
    expect(store.getState().unread).toBe(0);
    expect(store.getState().latest[0]?.read).toBe(1);
    // Marking twice does not go negative.
    store.markRead("a");
    expect(store.getState().unread).toBe(0);
  });

  it("markAllRead zeroes and flips every row", () => {
    const store = new ActivityStore();
    store.applyPage({
      notifications: [
        {
          id: "a",
          ts: "2026-09-19T10:00:00Z",
          kind: "task",
          title: "t",
          body: "",
          sessionId: null,
          projectId: null,
          read: 0,
        },
        {
          id: "b",
          ts: "2026-09-19T11:00:00Z",
          kind: "error",
          title: "e",
          body: "",
          sessionId: null,
          projectId: null,
          read: 0,
        },
      ],
      unread: 2,
    });
    store.markAllRead();
    expect(store.getState().unread).toBe(0);
    expect(store.getState().latest.every((n) => n.read === 1)).toBe(true);
  });

  it("subscribers fire on changes", () => {
    const store = new ActivityStore();
    let fired = 0;
    const unsub = store.subscribe(() => {
      fired += 1;
    });
    store.setUnread(1);
    store.setUnread(1); // no-op — no fire
    unsub();
    store.setUnread(2);
    expect(fired).toBe(1);
  });

  it("the ring caps at 30 rows, newest first", () => {
    const store = new ActivityStore();
    for (let i = 0; i < 35; i += 1) {
      store.applyLiveNotification({
        id: `n${i}`,
        ts: "2026-09-19T10:00:00Z",
        kind: "task",
        title: `t${i}`,
        body: "",
        sessionId: null,
        projectId: null,
        read: 1,
      });
    }
    expect(store.getState().latest).toHaveLength(30);
    expect(store.getState().latest[0]?.id).toBe("n34");
  });
});
