/**
 * ROUND-66 (R66, A4) — the browser checkpoint registry + the bot-wall
 * detector (browser-checkpoint.ts).
 *
 * Mirrors browser-tool.test.ts's harness style: the detector is PURE (direct
 * calls), the registry is round-tripped through its real module functions,
 * and the REST answer route (server.ts POST /browser-checkpoints/:id/resolve)
 * is exercised by booting a real buildServer — server.test.ts does not cover
 * the browser route family, so the route wiring lives here (the same pattern
 * browser-tool.test.ts uses for POST /browser-commands/:id/result).
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_CHECKPOINT_MAX_WAIT_MS,
  detectVerificationWall,
  openBrowserCheckpoint,
  pendingBrowserCheckpointCount,
  resetBrowserCheckpointsForTest,
  resolveBrowserCheckpoint,
  type BrowserCheckpointFrame,
  type BrowserCheckpointResolvedFrame,
} from "../src/browser-checkpoint.js";
import { buildServer } from "../src/server";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { ProviderKeyring } from "../src/providers/registry";

type Frame = BrowserCheckpointFrame | BrowserCheckpointResolvedFrame;
const frameType = (event: Frame): string => (event as { type: string }).type;

let tempDir = "";
let db: SqliteDatabase | undefined;
let app: Awaited<ReturnType<typeof buildServer>> | null = null;
const TOKEN = "test-token-checkpoint";

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-browser-checkpoint-"));
  // Never let one test's pending wait leak into the next.
  resetBrowserCheckpointsForTest();
});

afterEach(async () => {
  if (app !== null) {
    await app.close();
    app = null;
  }
  if (db !== undefined) {
    db.close();
    db = undefined;
  }
  resetBrowserCheckpointsForTest();
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* Windows handle lag — best effort */
  }
});

// ── detectVerificationWall (pure) ─────────────────────────────────────────

describe("detectVerificationWall", () => {
  it("recognizes a Cloudflare interstitial from the title alone", () => {
    const hit = detectVerificationWall({ title: "Just a moment..." });
    expect(hit).not.toBeNull();
    expect(hit?.kind).toBe("cloudflare");
    expect(hit?.evidence.toLowerCase()).toContain("just a moment");
  });

  it("recognizes a captcha widget from raw html markers", () => {
    const hit = detectVerificationWall({ html: '<div class="g-recaptcha" data-sitekey="x"></div>' });
    expect(hit?.kind).toBe("captcha");
    // Word-boundary matching: the hyphen edge still trips the marker.
    const h = detectVerificationWall({ text: "This page is protected by h-captcha" });
    expect(h?.kind).toBe("captcha");
  });

  it("recognizes an age gate from visible text", () => {
    const hit = detectVerificationWall({ text: "Welcome! Are you over 18? This site contains age-restricted material." });
    expect(hit?.kind).toBe("age");
  });

  it("returns null for a clean page (title AND body)", () => {
    expect(detectVerificationWall({ title: "Wikipedia", text: "the free encyclopedia that anyone can edit" })).toBeNull();
    expect(detectVerificationWall({})).toBeNull();
  });

  it("prioritizes cloudflare > captcha > age > generic verification", () => {
    // cloudflare beats an embedded captcha marker.
    expect(detectVerificationWall({ text: "Checking your browser before accessing. recaptcha required." })?.kind).toBe("cloudflare");
    // captcha beats an age gate in the same text.
    expect(detectVerificationWall({ text: "complete the captcha to prove you are over 18" })?.kind).toBe("captcha");
    // "age verification" is age, not the generic fallback.
    expect(detectVerificationWall({ text: "age verification required to continue" })?.kind).toBe("age");
    // only the generic word remains → the generic kind.
    expect(detectVerificationWall({ text: "human verification required" })?.kind).toBe("verification");
  });

  it("title is scanned before body; body is still scanned when the title is clean", () => {
    const hit = detectVerificationWall({ title: "Totally normal page", text: "Please complete the verification challenge below" });
    expect(hit?.kind).toBe("verification");
  });

  it("evidence is trimmed and capped at 120 chars", () => {
    const hit = detectVerificationWall({
      title: "A".repeat(300) + " just a moment " + "B".repeat(300),
    });
    expect(hit).not.toBeNull();
    expect(hit?.evidence.length).toBeLessThanOrEqual(120);
    expect(hit?.evidence).toBe(hit?.evidence.trim());
    expect(hit?.evidence.toLowerCase()).toContain("just a moment");
  });

  it("word-boundary matching: marker substrings inside bigger words do not trip", () => {
    // "captchasaurus" must NOT trip the "captcha" marker.
    expect(detectVerificationWall({ text: "the captchasaurus module renders charts" })).toBeNull();
    // "verificationing" is not the word "verification".
    expect(detectVerificationWall({ text: "verificationing the process takes time" })).toBeNull();
  });
});

// ── the pending-checkpoint registry ───────────────────────────────────────

describe("the checkpoint registry (openBrowserCheckpoint / resolveBrowserCheckpoint)", () => {
  it("open → resolve 'done' settles the promise, emits open + resolved frames, empties the map", async () => {
    const frames: Frame[] = [];
    const emit = (event: unknown) => {
      frames.push(event as Frame);
    };
    const pending = openBrowserCheckpoint(emit, { tabId: "tab-1", kind: "cloudflare", url: "https://example.com/gate", waitMs: 60_000 });
    expect(pendingBrowserCheckpointCount()).toBe(1);

    // The open frame: the exact chat-card contract (sessionId "" — the
    // frontend takes the real session id from its own stream context).
    const opened = frames[0];
    expect(frameType(opened)).toBe("browser-checkpoint");
    expect(opened as unknown as Record<string, unknown>).toMatchObject({
      type: "browser-checkpoint",
      sessionId: "",
      tabId: "tab-1",
      kind: "cloudflare",
      url: "https://example.com/gate",
      waitMs: 60_000,
    });
    const checkpointId = (opened as unknown as { checkpointId: string }).checkpointId;
    expect(checkpointId.startsWith("bchk_")).toBe(true);

    expect(resolveBrowserCheckpoint(checkpointId, "done")).toBe(true);
    await expect(pending).resolves.toEqual({ resolution: "done" });

    // The resolved frame collapses the chat card.
    expect(frames).toHaveLength(2);
    expect(frames[1] as unknown as Record<string, unknown>).toMatchObject({
      type: "browser-checkpoint.resolved",
      sessionId: "",
      checkpointId,
      resolution: "done",
    });
    expect(pendingBrowserCheckpointCount()).toBe(0);
  });

  it("resolve 'stop' settles with resolution stop", async () => {
    const frames: Frame[] = [];
    const pending = openBrowserCheckpoint((event) => frames.push(event as Frame), {
      tabId: "tab-2",
      kind: "captcha",
      url: "https://example.com/login",
      waitMs: 5_000,
    });
    const checkpointId = (frames[0] as unknown as { checkpointId: string }).checkpointId;
    expect(resolveBrowserCheckpoint(checkpointId, "stop")).toBe(true);
    await expect(pending).resolves.toEqual({ resolution: "stop" });
    expect(frames[1] as unknown as Record<string, unknown>).toMatchObject({ resolution: "stop" });
  });

  it("the countdown fires on timeout (resolved frame says timeout)", async () => {
    vi.useFakeTimers();
    try {
      const frames: Frame[] = [];
      const pending = openBrowserCheckpoint((event) => frames.push(event as Frame), {
        tabId: "tab-3",
        kind: "age",
        url: "https://example.com/18",
        waitMs: 15_000,
      });
      vi.advanceTimersByTime(15_000);
      await expect(pending).resolves.toEqual({ resolution: "timeout" });
      expect(frames[1] as unknown as Record<string, unknown>).toMatchObject({
        type: "browser-checkpoint.resolved",
        resolution: "timeout",
      });
      expect(pendingBrowserCheckpointCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolving an already-timed-out checkpoint returns false (unknown id)", async () => {
    vi.useFakeTimers();
    try {
      const frames: Frame[] = [];
      const pending = openBrowserCheckpoint((event) => frames.push(event as Frame), {
        tabId: "tab-4",
        kind: "verification",
        url: "https://example.com",
        waitMs: 3_000,
      });
      const checkpointId = (frames[0] as unknown as { checkpointId: string }).checkpointId;
      vi.advanceTimersByTime(3_500);
      await expect(pending).resolves.toEqual({ resolution: "timeout" });
      // The entry is gone — a late owner click answers "expired".
      expect(resolveBrowserCheckpoint(checkpointId, "done")).toBe(false);
      // Unknown ids and invalid actions never resolve anything (the route
      // validates the action; the registry double-checks).
      expect(resolveBrowserCheckpoint("bchk_nope", "done")).toBe(false);
      expect(resolveBrowserCheckpoint("bchk_nope", "maybe" as unknown as "done")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waitMs above the 60s hard cap (or junk) rejects honestly", async () => {
    await expect(
      openBrowserCheckpoint(() => {}, { tabId: "t", kind: "captcha", url: "https://x", waitMs: BROWSER_CHECKPOINT_MAX_WAIT_MS + 1 }),
    ).rejects.toThrow(/60s/);
    await expect(
      openBrowserCheckpoint(() => {}, { tabId: "t", kind: "captcha", url: "https://x", waitMs: Number.NaN }),
    ).rejects.toThrow();
    // Nothing pended — the rejection happened before any frame.
    expect(pendingBrowserCheckpointCount()).toBe(0);
  });

  it("the test reset resolves everything in flight as a timeout and empties the map", async () => {
    const frames: Frame[] = [];
    const one = openBrowserCheckpoint((event) => frames.push(event as Frame), { tabId: "t1", kind: "captcha", url: "https://x", waitMs: 30_000 });
    const two = openBrowserCheckpoint((event) => frames.push(event as Frame), { tabId: "t2", kind: "age", url: "https://y", waitMs: 30_000 });
    expect(pendingBrowserCheckpointCount()).toBe(2);
    resetBrowserCheckpointsForTest();
    expect(pendingBrowserCheckpointCount()).toBe(0);
    await expect(one).resolves.toEqual({ resolution: "timeout" });
    await expect(two).resolves.toEqual({ resolution: "timeout" });
  });

  it("an emit that THROWS on the open frame rejects the wait instead of hanging", async () => {
    await expect(
      openBrowserCheckpoint(
        () => {
          throw new Error("stream already closed");
        },
        { tabId: "t", kind: "captcha", url: "https://x", waitMs: 5_000 },
      ),
    ).rejects.toThrow(/stream already closed/);
    expect(pendingBrowserCheckpointCount()).toBe(0);
  });
});

// ── the REST answer route (server.ts) ─────────────────────────────────────

describe("POST /browser-checkpoints/:checkpointId/resolve (the chat card's answer channel)", () => {
  it("resolves a live checkpoint over HTTP; unknown ids answer the {ok:false, resolution:'timeout'} contract; bearer wall + body validation", async () => {
    db = openDatabase(join(tempDir, `${randomUUID()}.db`));
    app = buildServer({
      token: TOKEN,
      db,
      keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: "sk-or-vtest" }),
    });

    // One live checkpoint (a no-op emitter — the frames are not under test
    // here; the route wiring is).
    const frames: Frame[] = [];
    const pending = openBrowserCheckpoint((event) => frames.push(event as Frame), {
      tabId: "tab-route",
      kind: "cloudflare",
      url: "https://example.com/behind-cf",
      waitMs: 30_000,
    });
    const checkpointId = (frames[0] as unknown as { checkpointId: string }).checkpointId;

    // The bearer wall (same as every /api/v1 route).
    const unauthed = await app.inject({
      method: "POST",
      url: `/api/v1/browser-checkpoints/${checkpointId}/resolve`,
      payload: { action: "done" },
    });
    expect(unauthed.statusCode).toBe(401);

    // Body validation: action must be done|stop.
    const badAction = await app.inject({
      method: "POST",
      url: `/api/v1/browser-checkpoints/${checkpointId}/resolve`,
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      payload: { action: "maybe" },
    });
    expect(badAction.statusCode).toBe(400);
    expect((badAction.json() as { error: { code: string } }).error.code).toBe("VALIDATION");

    // Unknown id → 200 with the frontend client's exact fallback contract.
    const unknown = await app.inject({
      method: "POST",
      url: "/api/v1/browser-checkpoints/bchk_unknown/resolve",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      payload: { action: "done" },
    });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json()).toEqual({ ok: false, resolution: "timeout", error: "unknown or expired checkpoint" });

    // The live id resolves the pending tool promise.
    const resolved = await app.inject({
      method: "POST",
      url: `/api/v1/browser-checkpoints/${checkpointId}/resolve`,
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      payload: { action: "done" },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toEqual({ ok: true, resolution: "done" });
    await expect(pending).resolves.toEqual({ resolution: "done" });
    expect(pendingBrowserCheckpointCount()).toBe(0);
  });
});
