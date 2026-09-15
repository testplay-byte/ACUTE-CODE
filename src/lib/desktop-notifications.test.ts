// @vitest-environment happy-dom
/**
 * ROUND-98 (R98-J) — the desktop-notification BRIDGE unit pins:
 *  · web-mode no-op (no window.__TAURI__ ⇒ nothing is ever invoked);
 *  · the VISIBILITY rule (visible document ⇒ no fire; hidden ⇒ fire);
 *  · the permission flow (granted fires; denied skips without throwing;
 *    null requests ONCE and honors the result);
 *  · the SETTINGS gate (the in-memory enabled flag suppresses everything);
 *  · init's best-effort pre-check (never throws).
 *
 * The bridge holds module-level state (the enabled flag + the one-shot
 * permission guard), so every test re-imports a FRESH module copy via
 * vi.resetModules() + dynamic import.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type InvokeMock = ReturnType<typeof vi.fn>;

interface BridgeModule {
  notifyDesktop: (input: {
    title: string;
    body?: string;
    kind: "task_complete" | "task_failed" | "permission_request";
  }) => Promise<void>;
  initDesktopNotifications: () => void;
  setDesktopNotificationsEnabled: (value: boolean) => void;
  isDesktopNotificationsEnabled: () => boolean;
}

/** A stateful plugin invoke mock: answers the three plugin commands. */
function makeInvoke(overrides?: {
  isGranted?: boolean | null;
  requestResult?: string;
  notifyError?: Error;
}): { invoke: InvokeMock; notifyCalls: Array<Record<string, unknown>> } {
  const notifyCalls: Array<Record<string, unknown>> = [];
  const invoke = vi.fn(
    async (command: string, args?: Record<string, unknown>): Promise<boolean | string | null> => {
      if (command === "plugin:notification|is_permission_granted") {
        return overrides?.isGranted ?? true;
      }
      if (command === "plugin:notification|request_permission") {
        return overrides?.requestResult ?? "granted";
      }
      if (command === "plugin:notification|notify") {
        if (overrides?.notifyError) throw overrides.notifyError;
        notifyCalls.push(args ?? {});
        return null;
      }
      return null;
    },
  );
  return { invoke, notifyCalls };
}

/** Install the Tauri global + hide the document (the visibility rule). */
function stubTauri(invoke: InvokeMock, visibility: "visible" | "hidden"): void {
  vi.stubGlobal("__TAURI__", { core: { invoke } });
  Object.defineProperty(document, "visibilityState", {
    value: visibility,
    configurable: true,
  });
}

async function freshBridge(): Promise<BridgeModule> {
  vi.resetModules();
  return (await import("./desktop-notifications")) as unknown as BridgeModule;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(document, "visibilityState", {
    value: "visible",
    configurable: true,
  });
});

describe("R98-J: the desktop-notifications bridge", () => {
  it("web mode is a no-op — no __TAURI__ means nothing is ever invoked", async () => {
    const bridge = await freshBridge();
    const { invoke, notifyCalls } = makeInvoke();
    // NOT stubbed — plain browser mode.

    await bridge.notifyDesktop({ title: "Task complete", body: "done", kind: "task_complete" });
    expect(invoke).not.toHaveBeenCalled();
    expect(notifyCalls).toEqual([]);
    // The flag defaults ON — the gate is not what stopped it.
    expect(bridge.isDesktopNotificationsEnabled()).toBe(true);
  });

  it("the visibility rule: a VISIBLE document never fires; hidden does", async () => {
    const bridge = await freshBridge();
    const { invoke, notifyCalls } = makeInvoke();
    stubTauri(invoke, "visible");

    await bridge.notifyDesktop({ title: "Task complete", body: "done", kind: "task_complete" });
    expect(invoke).not.toHaveBeenCalled();

    stubTauri(invoke, "hidden");
    await bridge.notifyDesktop({ title: "Task complete", body: "done", kind: "task_complete" });
    expect(notifyCalls).toHaveLength(1);
  });

  it("fires plugin:notification|notify with the EXACT options wrapper shape", async () => {
    const bridge = await freshBridge();
    const { invoke, notifyCalls } = makeInvoke();
    stubTauri(invoke, "hidden");

    await bridge.notifyDesktop({ title: "Task failed", body: "engine exploded", kind: "task_failed" });
    expect(invoke).toHaveBeenCalledWith("plugin:notification|notify", {
      options: { title: "Task failed", body: "engine exploded" },
    });
    expect(notifyCalls).toEqual([{ options: { title: "Task failed", body: "engine exploded" } }]);
    // A missing body rides as the empty string (the plugin requires it).
    await bridge.notifyDesktop({ title: "Permission needed", kind: "permission_request" });
    expect(notifyCalls[1]).toEqual({ options: { title: "Permission needed", body: "" } });
  });

  it("denied permission skips silently — never throws into the stream", async () => {
    const bridge = await freshBridge();
    const { invoke, notifyCalls } = makeInvoke({ isGranted: false });
    stubTauri(invoke, "hidden");

    await expect(
      bridge.notifyDesktop({ title: "Task complete", body: "done", kind: "task_complete" }),
    ).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledTimes(1); // only the check, never a request
    expect(notifyCalls).toEqual([]);
  });

  it("an undetermined (null) permission requests ONCE and honors the answer", async () => {
    const bridge = await freshBridge();
    let granted: boolean | null = null; // undetermined
    const notifyCalls: Array<Record<string, unknown>> = [];
    const invoke = vi.fn(
      async (command: string, args?: Record<string, unknown>): Promise<boolean | string | null> => {
        if (command === "plugin:notification|is_permission_granted") return granted;
        if (command === "plugin:notification|request_permission") {
          granted = true; // the OS granted it
          return "granted";
        }
        notifyCalls.push(args ?? {});
        return null;
      },
    );
    stubTauri(invoke, "hidden");

    // First need: request once → granted → the notification fires.
    await bridge.notifyDesktop({ title: "Task complete", body: "one", kind: "task_complete" });
    expect(invoke).toHaveBeenCalledWith("plugin:notification|request_permission");
    expect(notifyCalls).toHaveLength(1);

    // Second need: granted now — request_permission is NEVER called again.
    await bridge.notifyDesktop({ title: "Task complete", body: "two", kind: "task_complete" });
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "plugin:notification|request_permission")).toHaveLength(1);
    expect(notifyCalls).toHaveLength(2);
  });

  it("the settings gate: a disabled flag suppresses everything (no IPC at all)", async () => {
    const bridge = await freshBridge();
    const { invoke, notifyCalls } = makeInvoke();
    stubTauri(invoke, "hidden");

    bridge.setDesktopNotificationsEnabled(false);
    await bridge.notifyDesktop({ title: "Task complete", body: "done", kind: "task_complete" });
    expect(invoke).not.toHaveBeenCalled();
    expect(notifyCalls).toEqual([]);

    // Re-enabling applies to the very next record — the LIVE push contract.
    bridge.setDesktopNotificationsEnabled(true);
    await bridge.notifyDesktop({ title: "Task complete", body: "done", kind: "task_complete" });
    expect(notifyCalls).toHaveLength(1);
  });

  it("a throwing invoke never rejects the caller (the stream must not die)", async () => {
    const bridge = await freshBridge();
    const { invoke } = makeInvoke({ notifyError: new Error("quiet hours") });
    stubTauri(invoke, "hidden");

    await expect(
      bridge.notifyDesktop({ title: "Task complete", body: "done", kind: "task_complete" }),
    ).resolves.toBeUndefined();
  });

  it("init pre-checks the permission best-effort and swallows failures", async () => {
    const bridge = await freshBridge();
    const failing = vi.fn(async (): Promise<boolean | null> => {
      throw new Error("plugin missing");
    });
    const invoke = vi.fn(
      async (command: string): Promise<boolean | null> => {
        if (command === "plugin:notification|is_permission_granted") return failing();
        return null;
      },
    );
    stubTauri(invoke, "visible");

    expect(() => bridge.initDesktopNotifications()).not.toThrow();
    // Web mode: init is a plain no-op.
    vi.unstubAllGlobals();
    expect(() => bridge.initDesktopNotifications()).not.toThrow();
  });
});
