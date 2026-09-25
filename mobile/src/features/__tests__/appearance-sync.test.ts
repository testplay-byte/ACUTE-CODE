/**
 * appearance-sync.test.ts — the appearance domain's phone half (R113-e;
 * R114-c — extended to the FULL five-field shape: the four chat prefs ride
 * the GET, the partial PUT, the echo guard, and the live frames): the wire
 * pair (GET/PUT /api/v1/settings/appearance), the shape-checking parser
 * (missing chat fields = server defaults; present-but-invalid = reject),
 * THE ECHO GUARD (applying a server value never PUTs it back — the
 * loop-killer), the connection-gated optimistic write-through, and the live
 * leg (hydrate on connect + hello, apply settings/appearance frames as they
 * land off the events store).
 */

import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";

import type { ApiCallInit, ApiResult } from "@/link/connection";
import {
  APPEARANCE_SYNC_GAVE_UP,
  PENDING_FLUSH_MAX_ATTEMPTS,
  applyServerAppearanceValue,
  appearanceSyncStatus,
  fetchAppearance,
  isApplyingRemoteAppearance,
  putAppearance,
  pushAppearancePatch,
  resetAppearanceSyncForTest,
  startAppearanceSync,
  subscribeAppearanceSyncStatus,
  type AppearanceControl,
  type AppearancePushTarget,
} from "../appearance-sync";
import { CHAT_PREF_DEFAULTS, parseAppearanceValue } from "@/design/theme";
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
  setRespondOk(): void;
} {
  const calls: RecordedCall[] = [];
  let current = opts.status ?? "connected";
  const listeners = new Set<() => void>();
  let respond =
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
    /** Swap the responder to always-success (the recovery-leg fakes). */
    setRespondOk(): void {
      respond = () => ({
        ok: true,
        status: 200,
        headers: {},
        bodyText: JSON.stringify({ themeId: "bento", mode: "dark" }),
      });
    },
  };
  return Object.assign(manager, {
    calls,
    setStatus: manager.setStatus,
    setRespondOk: manager.setRespondOk,
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
    expect(parseAppearanceValue({ themeId: "bento", mode: "dark" })).toEqual({
      themeId: "bento",
      mode: "dark",
      ...CHAT_PREF_DEFAULTS,
    });
    expect(parseAppearanceValue({ themeId: null, mode: "system" })).toEqual({
      themeId: null,
      mode: "system",
      ...CHAT_PREF_DEFAULTS,
    });
    expect(parseAppearanceValue({ themeId: "clay", mode: "light" })).toEqual({
      themeId: "clay",
      mode: "light",
      ...CHAT_PREF_DEFAULTS,
    });
  });

  it("R114-c: the four chat-pref fields ride when present", () => {
    expect(
      parseAppearanceValue({
        themeId: "clay",
        mode: "dark",
        chatDensity: "compact",
        chatTextSize: "large",
        timestampsMode: "hidden",
        toolActivity: "compact",
      }),
    ).toEqual({
      themeId: "clay",
      mode: "dark",
      chatDensity: "compact",
      chatTextSize: "large",
      timestampsMode: "hidden",
      toolActivity: "compact",
    });
  });

  it("R114-c: a PRESENT-but-invalid chat field rejects the whole value — never a silent default", () => {
    expect(parseAppearanceValue({ themeId: "clay", mode: "light", chatDensity: "cozy" })).toBeNull();
    expect(parseAppearanceValue({ themeId: "clay", mode: "light", chatTextSize: "huge" })).toBeNull();
    expect(parseAppearanceValue({ themeId: "clay", mode: "light", timestampsMode: "always" })).toBeNull();
    expect(parseAppearanceValue({ themeId: "clay", mode: "light", toolActivity: "verbose" })).toBeNull();
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
    setChatDensity(density: "comfortable" | "compact"): void {
      log.push(`setChatDensity:${density}`);
    },
    setChatTextSize(size: "small" | "medium" | "large"): void {
      log.push(`setChatTextSize:${size}`);
    },
    setTimestampsMode(mode: "hidden" | "hover"): void {
      log.push(`setTimestampsMode:${mode}`);
    },
    setToolActivity(activity: "detailed" | "compact" | "hidden"): void {
      log.push(`setToolActivity:${activity}`);
    },
  });

  it("applies a valid five-field server value through ALL SIX setters and reports true", () => {
    const log: string[] = [];
    expect(
      applyServerAppearanceValue(
        {
          themeId: "midnight",
          mode: "light",
          chatDensity: "compact",
          chatTextSize: "large",
          timestampsMode: "hidden",
          toolActivity: "compact",
        },
        control(log),
      ),
    ).toBe(true);
    expect(log).toEqual([
      "setTheme:midnight",
      "setMode:light",
      "setChatDensity:compact",
      "setChatTextSize:large",
      "setTimestampsMode:hidden",
      "setToolActivity:compact",
    ]);
  });

  it("a null themeId applies the mode + chat prefs — the local flavor stands (the R113-a default)", () => {
    const log: string[] = [];
    expect(applyServerAppearanceValue({ themeId: null, mode: "dark" }, control(log))).toBe(true);
    expect(log).toEqual([
      "setMode:dark",
      "setChatDensity:comfortable",
      "setChatTextSize:medium",
      "setTimestampsMode:hover",
      "setToolActivity:detailed",
    ]);
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
    let seenDuringDensity: boolean | undefined;
    const probing: AppearanceControl = {
      setTheme(): void {
        seenDuringTheme = isApplyingRemoteAppearance();
      },
      setMode(): void {
        seenDuringMode = isApplyingRemoteAppearance();
      },
      setChatDensity(): void {
        seenDuringDensity = isApplyingRemoteAppearance();
      },
      setChatTextSize(): void {},
      setTimestampsMode(): void {},
      setToolActivity(): void {},
    };
    expect(isApplyingRemoteAppearance()).toBe(false);
    expect(applyServerAppearanceValue({ themeId: "bento", mode: "system", chatDensity: "compact" }, probing)).toBe(true);
    expect(isApplyingRemoteAppearance()).toBe(false);
    expect(seenDuringTheme).toBe(true);
    expect(seenDuringMode).toBe(true);
    expect(seenDuringDensity).toBe(true);
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

  it("R114-c: a chat-pref flip PUTs its ONE-field partial patch", async () => {
    const manager = makeManager();
    pushAppearancePatch(manager, { chatTextSize: "large" });
    await settle();
    expect(manager.calls).toHaveLength(1);
    expect(manager.calls[0]?.init?.method).toBe("PUT");
    expect(manager.calls[0]?.init?.bodyText).toBe('{"chatTextSize":"large"}');
  });

  it("R114-c: several chat fields ride one partial patch, key order intact", async () => {
    const manager = makeManager();
    pushAppearancePatch(manager, { chatDensity: "compact", toolActivity: "hidden" });
    await settle();
    expect(manager.calls[0]?.init?.bodyText).toBe('{"chatDensity":"compact","toolActivity":"hidden"}');
  });

  it("offline → the PUT is skipped and the patch is recorded PENDING (R128-W6: not lost — the next connect flushes it)", async () => {
    const manager = makeManager({ status: "offline" });
    pushAppearancePatch(manager, { mode: "dark" });
    await settle();
    expect(manager.calls).toHaveLength(0);
    // The patch rides the next boundary instead of dying here.
    expect(appearanceSyncStatus()).toEqual({ pending: { mode: "dark" }, flushAttempts: 0, error: null });
  });

  it("THE ECHO PIN: applying a server value through the theme setters NEVER PUTs it back", async () => {
    const manager = makeManager();
    // The theme provider's setters push on every call — exactly what the
    // real control does (all six fields). The echo guard must swallow every
    // write-through.
    const control: AppearanceControl = {
      setTheme(themeId: string): void {
        pushAppearancePatch(manager, { themeId });
      },
      setMode(mode: "system" | "light" | "dark"): void {
        pushAppearancePatch(manager, { mode });
      },
      setChatDensity(chatDensity: "comfortable" | "compact"): void {
        pushAppearancePatch(manager, { chatDensity });
      },
      setChatTextSize(chatTextSize: "small" | "medium" | "large"): void {
        pushAppearancePatch(manager, { chatTextSize });
      },
      setTimestampsMode(timestampsMode: "hidden" | "hover"): void {
        pushAppearancePatch(manager, { timestampsMode });
      },
      setToolActivity(toolActivity: "detailed" | "compact" | "hidden"): void {
        pushAppearancePatch(manager, { toolActivity });
      },
    };
    expect(
      applyServerAppearanceValue(
        { themeId: "midnight", mode: "light", chatDensity: "compact", chatTextSize: "large" },
        control,
      ),
    ).toBe(true);
    await settle();
    expect(manager.calls).toHaveLength(0); // no PUT-back — no echo loop
  });

  it("a failed PUT is no longer LOST — the patch is recorded pending (R128-W6), still no unhandled rejection", async () => {
    const manager = makeManager({
      respond: () => Promise.reject(new Error("transport died")),
    });
    pushAppearancePatch(manager, { themeId: "mono" });
    await expect(settle()).resolves.toBeUndefined();
    expect(manager.calls).toHaveLength(1); // it went out; the failure was swallowed
    // ...and recorded: the next hello retries it before any server apply.
    expect(appearanceSyncStatus().pending).toEqual({ themeId: "mono" });
  });

  it("an HTTP-level PUT failure (ok:false outcome) is pending too — not just transport throws", async () => {
    const manager = makeManager({
      respond: (call) =>
        call.init?.method === "PUT"
          ? { ok: false, status: 500, headers: {}, bodyText: "{\"error\":{\"code\":\"BOOM\",\"message\":\"no\"}}" }
          : { ok: true, status: 200, headers: {}, bodyText: JSON.stringify({ themeId: "bento", mode: "dark" }) },
    });
    pushAppearancePatch(manager, { toolActivity: "detailed" });
    await settle();
    expect(manager.calls).toHaveLength(1);
    expect(appearanceSyncStatus().pending).toEqual({ toolActivity: "detailed" });
  });

  it("a successful connected PUT leaves NO pending state (the normal flow is unchanged)", async () => {
    const manager = makeManager();
    pushAppearancePatch(manager, { themeId: "sunset" });
    await settle();
    expect(manager.calls).toHaveLength(1);
    expect(appearanceSyncStatus()).toEqual({ pending: null, flushAttempts: 0, error: null });
  });

  it("a second offline flip MERGES into the pending patch; a re-flip of the same field wins", async () => {
    const manager = makeManager({ status: "offline" });
    pushAppearancePatch(manager, { toolActivity: "detailed", mode: "dark" });
    pushAppearancePatch(manager, { chatTextSize: "large" });
    await settle();
    expect(appearanceSyncStatus().pending).toEqual({
      toolActivity: "detailed",
      mode: "dark",
      chatTextSize: "large",
    });
    // The re-flip overwrites its own field (partial-PUT semantics).
    pushAppearancePatch(manager, { mode: "light" });
    expect(appearanceSyncStatus().pending).toEqual({
      toolActivity: "detailed",
      mode: "light",
      chatTextSize: "large",
    });
  });

  it("the status seam notifies its subscribers (the Appearance row's re-render source)", () => {
    const seen: number[] = [];
    const stop = subscribeAppearanceSyncStatus(() => seen.push(seen.length));
    const offline = makeManager({ status: "offline" });
    pushAppearancePatch(offline, { mode: "dark" });
    expect(seen).toHaveLength(1); // the pending record notified
    stop();
    pushAppearancePatch(offline, { mode: "light" });
    expect(seen).toHaveLength(1); // unsubscribed — no further notify
  });
});

// ── R128-W6 — the pending-patch machinery (no silent hello-revert) ──────────

describe("startAppearanceSync — the pending flush at connect/hello boundaries", () => {
  /** A manager whose PUTs fail until the `putFailures`-th call (then land),
   * backed by a little SERVER STATE the successful PUTs merge into and the
   * GETs answer — the hello-revert shape honestly modeled: the server holds
   * the stale value until our PUT lands, then it echoes our own fix. Starts
   * offline so the sync's startup hydrate stays quiet until the test drives
   * a boundary. */
  function makeFlakyManager(putFailures: number): AppearancePushTarget & {
    calls: RecordedCall[];
    setStatus(next: string): void;
    setRespondOk(): void;
  } {
    let putIndex = 0;
    const server: Record<string, unknown> = {
      themeId: "bento",
      mode: "dark",
      toolActivity: "hidden", // the stale trap value
    };
    return makeManager({
      status: "offline",
      respond: (call) => {
        if (call.init?.method === "PUT") {
          putIndex += 1;
          if (putIndex <= putFailures) {
            return Promise.reject(new Error("relay blip"));
          }
          try {
            Object.assign(server, JSON.parse(String(call.init?.bodyText)));
          } catch {
            // the fake tolerates a malformed body — the route's own job
          }
        }
        return { ok: true, status: 200, headers: {}, bodyText: JSON.stringify(server) };
      },
    });
  }

  it("PUT fails while connected → the next boundary (the startup hydrate) FLUSHES first, then hydrates the server's ECHO of our fix", async () => {
    // The relay blip: the PUT for the un-hide fix dies mid-flight.
    const manager = makeFlakyManager(1);
    manager.setStatus("connected");
    pushAppearancePatch(manager, { toolActivity: "detailed" });
    await settle();
    expect(appearanceSyncStatus().pending).toEqual({ toolActivity: "detailed" });

    const applied: unknown[] = [];
    const frames = makeFrames();
    const stop = startAppearanceSync((value) => {
      applied.push(value);
      return true;
    }, { manager, events: frames });
    await settle();
    // The connect boundary: the flush PUT goes out FIRST (the failed
    // original + the flush retry)...
    const putCalls = manager.calls.filter((call) => call.init?.method === "PUT");
    expect(putCalls).toHaveLength(2);
    // ...and only after it lands does the hydration GET apply the server
    // value — which now echoes our own fix (toolActivity: detailed), never
    // the stale "hidden" the old code silently re-applied.
    expect(applied).toEqual([{ themeId: "bento", mode: "dark", toolActivity: "detailed" }]);
    expect(appearanceSyncStatus()).toEqual({ pending: null, flushAttempts: 0, error: null });
    stop();
  });

  it("an OFFLINE flip rides the reconnect: the connect transition flushes it before the hydration", async () => {
    const manager = makeManager({ status: "offline" });
    // The owner taps "Show tool activity" while the link is down.
    pushAppearancePatch(manager, { toolActivity: "detailed" });
    await settle();
    expect(manager.calls).toHaveLength(0);

    const applied: unknown[] = [];
    const frames = makeFrames();
    const stop = startAppearanceSync((value) => {
      applied.push(value);
      return true;
    }, { manager, events: frames });
    await settle();
    expect(applied).toEqual([]); // offline — nothing yet

    // The reconnect: flush FIRST (the PUT), hydrate SECOND (the GET).
    manager.setStatus("connected");
    await settle();
    const putCalls = manager.calls.filter((call) => call.init?.method === "PUT");
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0]?.init?.bodyText).toBe('{"toolActivity":"detailed"}');
    // The GET applied AFTER the flush (call order: PUT before GET).
    const methods = manager.calls.map((call) => call.init?.method ?? "GET");
    expect(methods.indexOf("PUT")).toBeLessThan(methods.lastIndexOf("GET"));
    expect(applied).toHaveLength(1);
    expect(appearanceSyncStatus().pending).toBeNull();
    stop();
  });

  it("THE WINS PIN: a failed flush (attempts left) BLOCKS the server apply — the local fix stands", async () => {
    // Every PUT fails forever — the flush can never land.
    const manager = makeFlakyManager(99);
    pushAppearancePatch(manager, { toolActivity: "detailed" });
    await settle();

    const applied: unknown[] = [];
    const frames = makeFrames();
    const stop = startAppearanceSync((value) => {
      applied.push(value);
      return true;
    }, { manager, events: frames });
    await settle();
    expect(applied).toEqual([]); // offline — nothing yet

    // Boundary #1 (the reconnect): the flush fails (attempt 1) — the
    // server's stale "hidden" is NOT applied over the local fix.
    manager.setStatus("connected");
    await settle();
    expect(applied).toEqual([]);
    expect(appearanceSyncStatus()).toEqual({
      pending: { toolActivity: "detailed" },
      flushAttempts: 1,
      error: null,
    });

    // Boundary #2 (a hello): the flush fails again — still protected.
    frames.emit({ type: "hello" });
    await settle();
    expect(applied).toEqual([]);
    expect(appearanceSyncStatus().flushAttempts).toBe(2);
    stop();
  });

  it("gives up after 3 failed flushes: the patch is dropped, the honest error surfaces, the hydration converges", async () => {
    const manager = makeFlakyManager(99);
    pushAppearancePatch(manager, { toolActivity: "detailed" });
    await settle();

    const applied: unknown[] = [];
    const frames = makeFrames();
    const stop = startAppearanceSync((value) => {
      applied.push(value);
      return true;
    }, { manager, events: frames });
    await settle();

    manager.setStatus("connected"); // boundary 1 — attempt 1, blocked
    await settle();
    frames.emit({ type: "hello" }); // boundary 2 — attempt 2, blocked
    await settle();
    frames.emit({ type: "hello" }); // boundary 3 — attempt 3: give up + converge
    await settle();
    expect(PENDING_FLUSH_MAX_ATTEMPTS).toBe(3);
    // The patch is gone, the honest error is surfaced (pinned copy)...
    expect(appearanceSyncStatus()).toEqual({
      pending: null,
      flushAttempts: 0,
      error: APPEARANCE_SYNC_GAVE_UP,
    });
    // ...and the hydration proceeded (converge with the story told).
    expect(applied).toEqual([{ themeId: "bento", mode: "dark", toolActivity: "hidden" }]);
    stop();
  });

  it("a landed PUT clears the surfaced error — the state is a story, not a scar", async () => {
    const manager = makeFlakyManager(99);
    pushAppearancePatch(manager, { toolActivity: "detailed" });
    await settle();
    const applied: unknown[] = [];
    const frames = makeFrames();
    const stop = startAppearanceSync((value) => {
      applied.push(value);
      return true;
    }, { manager, events: frames });
    await settle();
    manager.setStatus("connected");
    await settle();
    frames.emit({ type: "hello" });
    await settle();
    frames.emit({ type: "hello" }); // attempt 3 — give up, error surfaces
    await settle();
    expect(appearanceSyncStatus().error).toBe(APPEARANCE_SYNC_GAVE_UP);

    // The owner re-flips while connected — the fresh PUT lands (the manager
    // now answers) and the error clears.
    manager.setRespondOk();
    pushAppearancePatch(manager, { toolActivity: "compact" });
    await settle();
    expect(appearanceSyncStatus()).toEqual({ pending: null, flushAttempts: 0, error: null });
    stop();
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

  it("R114-c: a five-field appearance frame applies verbatim (the chat prefs ride the frame)", async () => {
    const manager = makeManager({ status: "offline" });
    const applied: unknown[] = [];
    const frames = makeFrames();
    const stop = startAppearanceSync(
      (value) => {
        applied.push(value);
        return true;
      },
      { manager, events: frames },
    );
    await settle();

    frames.emit({
      type: "settings",
      domain: "appearance",
      value: {
        themeId: "mono",
        mode: "dark",
        chatDensity: "compact",
        chatTextSize: "large",
        timestampsMode: "hidden",
        toolActivity: "hidden",
      },
    });
    expect(applied).toEqual([
      {
        themeId: "mono",
        mode: "dark",
        chatDensity: "compact",
        chatTextSize: "large",
        timestampsMode: "hidden",
        toolActivity: "hidden",
      },
    ]);
    expect(manager.calls).toHaveLength(0); // offline — the frame alone applied
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
