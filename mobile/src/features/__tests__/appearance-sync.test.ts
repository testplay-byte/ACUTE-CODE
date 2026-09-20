/**
 * appearance-sync.test.ts — the appearance domain's phone half (R113-e):
 * the wire pair (GET/PUT /api/v1/settings/appearance), the shape-checking
 * parser, THE ECHO GUARD (applying a server value never PUTs it back — the
 * loop-killer), the connection-gated optimistic write-through, and the live
 * leg (hydrate on connect + hello, apply settings/appearance frames as they
 * land off the events store).
 */

import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";

import type { ApiCallInit, ApiResult } from "@/link/connection";
import {
  applyServerAppearanceValue,
  fetchAppearance,
  isApplyingRemoteAppearance,
  putAppearance,
  pushAppearancePatch,
  resetAppearanceSyncForTest,
  startAppearanceSync,
  type AppearanceControl,
  type AppearancePushTarget,
} from "../appearance-sync";
import { parseAppearanceValue } from "@/design/theme";
import type { EventsFrame } from "../events";

// ── fakes (injected, zero React Native at the transport) ────────────────────

interface RecordedCall {
  path: string;
  init?: ApiCallInit;
}

function makeManager(opts: {
  status?: string;
  respond?: (call: RecordedCall) => ApiResult | Promise<ApiResult>;
} = {}): AppearancePushTarget & {
  calls: RecordedCall[];
  setStatus(next: string): void;
} {
  const calls: RecordedCall[] = [];
  let current = opts.status ?? "connected";
  const listeners = new Set<() => void>();
  const respond =
    opts.respond ??
    (() => ({
      ok: true,
      status: 200,
      headers: {},
      bodyText: JSON.stringify({ themeId: "bento", mode: "dark" }),
    }));
  const manager = {
    api(path: string, init?: ApiCallInit): Promise<ApiResult> {
      const call = { path, init };
      calls.push(call);
      return Promise.resolve(respond(call));
    },
    getStatus(): string {
      return current;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setStatus(next: string): void {
      current = next;
      for (const listener of listeners) listener();
    },
  };
  return Object.assign(manager, {
    calls,
    setStatus: manager.setStatus,
  });
}

/** A fake events store — just the subscribeFrames surface startAppearanceSync needs. */
function makeFrames() {
  const listeners = new Set<(frame: EventsFrame) => void>();
  return {
    subscribeFrames(listener: (frame: EventsFrame) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(frame: EventsFrame): void {
      for (const listener of listeners) listener(frame);
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

beforeEach(() => {
  resetAppearanceSyncForTest();
});

afterEach(() => {
  resetAppearanceSyncForTest();
});

// ── the parser (design/theme.tsx owns the vocabulary) ───────────────────────

describe("parseAppearanceValue", () => {
  it("accepts the six-id + three-mode vocabulary, null themeId included", () => {
    expect(parseAppearanceValue({ themeId: "bento", mode: "dark" })).toEqual({ themeId: "bento", mode: "dark" });
    expect(parseAppearanceValue({ themeId: null, mode: "system" })).toEqual({ themeId: null, mode: "system" });
    expect(parseAppearanceValue({ themeId: "clay", mode: "light" })).toEqual({ themeId: "clay", mode: "light" });
  });

  it("rejects malformed values honestly — never a guess", () => {
    expect(parseAppearanceValue(null)).toBeNull();
    expect(parseAppearanceValue("dark")).toBeNull();
    expect(parseAppearanceValue(7)).toBeNull();
    expect(parseAppearanceValue({ themeId: 3, mode: "dark" })).toBeNull();
    expect(parseAppearanceValue({ themeId: "bento", mode: "auto" })).toBeNull();
    expect(parseAppearanceValue({ themeId: "bento" })).toBeNull();
    expect(parseAppearanceValue({ mode: "dark" })).toBeNull();
  });
});

// ── the wire pair ───────────────────────────────────────────────────────────

describe("the appearance wire pair", () => {
  it("GETs /api/v1/settings/appearance and types the body", async () => {
    const manager = makeManager();
    const outcome = await fetchAppearance(manager);
    expect(manager.calls[0]?.path).toBe("/api/v1/settings/appearance");
    expect(outcome.ok && outcome.data).toEqual({ themeId: "bento", mode: "dark" });
  });

  it("PUTs a partial patch — the server's appearance route contract", async () => {
    const manager = makeManager();
    const outcome = await putAppearance(manager, { themeId: "midnight", mode: "light" });
    expect(manager.calls[0]?.init?.method).toBe("PUT");
    expect(manager.calls[0]?.init?.bodyText).toBe('{"themeId":"midnight","mode":"light"}');
    expect(outcome.ok).toBe(true);
  });
});

// ── the echo guard + the two apply paths ────────────────────────────────────

describe("applyServerAppearanceValue", () => {
  const control = (log: string[]): AppearanceControl => ({
    setTheme(themeId: string): void {
      log.push(`setTheme:${themeId}`);
    },
    setMode(mode: "system" | "light" | "dark"): void {
      log.push(`setMode:${mode}`);
    },
  });

  it("applies a valid server value through BOTH setters and reports true", () => {
    const log: string[] = [];
    expect(applyServerAppearanceValue({ themeId: "midnight", mode: "light" }, control(log))).toBe(true);
    expect(log).toEqual(["setTheme:midnight", "setMode:light"]);
  });

  it("a null themeId applies ONLY the mode — the local flavor stands (the R113-a default)", () => {
    const log: string[] = [];
    expect(applyServerAppearanceValue({ themeId: null, mode: "dark" }, control(log))).toBe(true);
    expect(log).toEqual(["setMode:dark"]);
  });

  it("a malformed value touches NOTHING and reports false", () => {
    const log: string[] = [];
    expect(applyServerAppearanceValue({ themeId: 3, mode: "dark" }, control(log))).toBe(false);
    expect(applyServerAppearanceValue("dark", control(log))).toBe(false);
    expect(log).toEqual([]);
  });

  it("the guard brackets the apply — false before and after, true while the setters run", () => {
    let seenDuringTheme: boolean | undefined;
    let seenDuringMode: boolean | undefined;
    const probing: AppearanceControl = {
      setTheme(): void {
        seenDuringTheme = isApplyingRemoteAppearance();
      },
      setMode(): void {
        seenDuringMode = isApplyingRemoteAppearance();
      },
    };
    expect(isApplyingRemoteAppearance()).toBe(false);
    expect(applyServerAppearanceValue({ themeId: "bento", mode: "system" }, probing)).toBe(true);
    expect(isApplyingRemoteAppearance()).toBe(false);
    expect(seenDuringTheme).toBe(true);
    expect(seenDuringMode).toBe(true);
  });
});

describe("pushAppearancePatch — the optimistic write-through", () => {
  it("a LOCAL flip PUTs while connected (fire-and-forget)", async () => {
    const manager = makeManager();
    pushAppearancePatch(manager, { themeId: "sunset" });
    await settle();
    expect(manager.calls).toHaveLength(1);
    expect(manager.calls[0]?.path).toBe("/api/v1/settings/appearance");
    expect(manager.calls[0]?.init?.method).toBe("PUT");
    expect(manager.calls[0]?.init?.bodyText).toBe('{"themeId":"sunset"}');
  });

  it("offline → the PUT is skipped (the local value is the offline fallback)", async () => {
    const manager = makeManager({ status: "offline" });
    pushAppearancePatch(manager, { mode: "dark" });
    await settle();
    expect(manager.calls).toHaveLength(0);
  });

  it("THE ECHO PIN: applying a server value through the theme setters NEVER PUTs it back", async () => {
    const manager = makeManager();
    // The theme provider's setters push on every call — exactly what the
    // real control does. The echo guard must swallow the write-through.
    const control: AppearanceControl = {
      setTheme(themeId: string): void {
        pushAppearancePatch(manager, { themeId });
      },
      setMode(mode: "system" | "light" | "dark"): void {
        pushAppearancePatch(manager, { mode });
      },
    };
    expect(applyServerAppearanceValue({ themeId: "midnight", mode: "light" }, control)).toBe(true);
    await settle();
    expect(manager.calls).toHaveLength(0); // no PUT-back — no echo loop
  });

  it("a failed PUT is silent (the local value stands; no unhandled rejection)", async () => {
    const manager = makeManager({
      respond: () => Promise.reject(new Error("transport died")),
    });
    pushAppearancePatch(manager, { themeId: "mono" });
    await expect(settle()).resolves.toBeUndefined();
    expect(manager.calls).toHaveLength(1); // it went out; the failure was swallowed
  });
});

// ── the live leg ────────────────────────────────────────────────────────────

describe("startAppearanceSync — hydrate + live frames", () => {
  it("hydrates on connect when already connected, and again on every reconnect", async () => {
    const manager = makeManager({ status: "offline" });
    const applied: unknown[] = [];
    const frames = makeFrames();
    const stop = startAppearanceSync((value) => {
      applied.push(value);
      return true;
    }, { manager, events: frames });
    await settle();
    expect(manager.calls).toHaveLength(0); // offline — nothing yet

    manager.setStatus("connected");
    await settle();
    expect(manager.calls).toHaveLength(1); // the hydration GET
    expect(applied).toEqual([{ themeId: "bento", mode: "dark" }]);

    // A blip that returns to connected hydrates again (server wins).
    manager.setStatus("offline");
    manager.setStatus("connected");
    await settle();
    expect(manager.calls).toHaveLength(2);
    stop();
  });

  it("a settings frame for ANOTHER domain never applies; the appearance domain applies LIVE", async () => {
    const manager = makeManager({ status: "offline" });
    const applied: unknown[] = [];
    const frames = makeFrames();
    const stop = startAppearanceSync((value) => {
      applied.push(value);
      return true;
    }, { manager, events: frames });
    await settle();

    frames.emit({ type: "settings", domain: "retry", value: 3 });
    frames.emit({ type: "session", sessionId: "s", projectId: null, kind: "event" });
    frames.emit({ type: "hello" });
    frames.emit({ type: "turn", sessionId: "s", frame: { type: "text-delta", delta: "x" } });
    expect(applied).toEqual([]); // none of those are appearance

    frames.emit({ type: "settings", domain: "appearance", value: { themeId: "midnight", mode: "light" } });
    expect(applied).toEqual([{ themeId: "midnight", mode: "light" }]);
    // The one GET on the wire is the HELLO's hydration — the live appearance
    // frame applied WITHOUT its own fetch (the frame IS the value).
    expect(manager.calls).toHaveLength(1);
    expect(manager.calls[0]?.path).toBe("/api/v1/settings/appearance");
    stop();
  });

  it("hello (the resync) hydrates — whatever landed while the stream was down is caught", async () => {
    const manager = makeManager();
    const applied: unknown[] = [];
    const frames = makeFrames();
    const stop = startAppearanceSync((value) => {
      applied.push(value);
      return true;
    }, { manager, events: frames });
    await settle();
    expect(manager.calls).toHaveLength(1); // the connect hydration

    frames.emit({ type: "hello" });
    await settle();
    expect(manager.calls).toHaveLength(2); // the resync hydration
    stop();
  });

  it("unsubscribes cleanly — frames and manager transitions stop applying", async () => {
    const manager = makeManager({ status: "offline" });
    const applied: unknown[] = [];
    const frames = makeFrames();
    const stop = startAppearanceSync((value) => {
      applied.push(value);
      return true;
    }, { manager, events: frames });
    manager.setStatus("connected");
    await settle();
    expect(applied).toHaveLength(1);

    stop();
    frames.emit({ type: "settings", domain: "appearance", value: { themeId: "mono", mode: "dark" } });
    manager.setStatus("offline");
    manager.setStatus("connected");
    await settle();
    expect(applied).toHaveLength(1); // nothing after the unsubscribe
    expect(manager.calls).toHaveLength(1);
  });

  it("a GET that fails to parse (BAD_JSON outcome) applies NOTHING — honest, never a guess", async () => {
    const manager = makeManager({
      respond: () => ({ ok: true, status: 200, headers: {}, bodyText: "not json" }),
    });
    const applied: unknown[] = [];
    const frames = makeFrames();
    const stop = startAppearanceSync((value) => {
      applied.push(value);
      return true;
    }, { manager, events: frames });
    await settle();
    expect(manager.calls).toHaveLength(1);
    expect(applied).toEqual([]); // the outcome was {ok:false} — no apply
    stop();
  });
});
