// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetTestState } from "../test-utils";
import { type MiniSessionState } from "./mini-client";
import { MiniApp } from "./MiniApp";

/**
 * ROUND-64 (R64-b) — unit tests for the floating computer-use mini monitor
 * page (mini.html, the always-on-top window built by src-tauri/src/mini.rs).
 *
 * The Tauri global is faked with a minimal `__TAURI__` stub (the
 * popout.test.tsx pattern): `isTauri()` from lib/sidecar stays REAL so the
 * web-mode notice is tested through the actual shell detection, and the
 * stub's `core.invoke` doubles as the command recorder (sidecar_info +
 * close_computer_mini). The sidecar's REST surface is stubbed via
 * global.fetch with the REAL mini-client underneath — the URL, the bearer
 * token and the stop body are exactly what the wire sees.
 *
 * Timing: MiniApp takes poll/close delays as props, so the tests drive REAL
 * timers with tiny values (30ms polls, 80/120ms close windows) — no fake
 * timers to fight framer-motion.
 */

/** One recorded fetch: [input, init]. */
type FetchCall = [input: RequestInfo | URL, init?: RequestInit];

const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
const fetchCalls: FetchCall[] = [];

/** What the NEXT GET /computer-use/session resolves with (tests mutate it). */
let nextSession: MiniSessionState | null;

/** The stop endpoint's answer (default success; tests can fail it). */
let stopResponds: { ok: boolean; status: number };

function sessionFixture(over: Partial<MiniSessionState> = {}): MiniSessionState {
  const startedAt = Date.now() - 134_000; // → "2m 14s" elapsed
  return {
    active: true,
    killSwitch: false,
    backendKind: "enigo",
    startedAt,
    stopReason: null,
    stats: { startedAt, actionsSent: 12, actionsRefused: 1, observations: 30, visionCalls: 4 },
    events: [
      { seq: 2, ts: Date.now() - 1_000, kind: "action", label: "Clicking the “Sign in” button", tool: "computer_click" },
      { seq: 1, ts: Date.now() - 9_000, kind: "vision", label: "Vision (main): a login form" },
    ],
    ...over,
  };
}

/** The fetch stub: the engine's two endpoints, shaped exactly as the real
 * sidecar answers them. Everything else 404s. */
function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push([input, init]);
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/v1/computer-use/session")) {
        if (nextSession === null) throw new Error("fetch failed");
        return { ok: true, status: 200, json: async () => nextSession } as unknown as Response;
      }
      if (url.endsWith("/api/v1/computer-use/stop")) {
        return {
          ok: stopResponds.ok,
          status: stopResponds.status,
          json: async () => ({ ok: stopResponds.ok, reason: "" }),
        } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    }),
  );
}

/** Installs a capturable `window.__TAURI__` answering sidecar_info. */
function stubTauri(): void {
  vi.stubGlobal("__TAURI__", {
    core: {
      invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        if (cmd === "sidecar_info") {
          return { port: 5178, token: "tok_mini" };
        }
        return null;
      }),
    },
  });
}

/** The close_computer_mini invocations recorded so far. */
function closeInvokes(): number {
  return calls.filter((c) => c.cmd === "close_computer_mini").length;
}

beforeEach(() => {
  resetTestState();
  calls.length = 0;
  fetchCalls.length = 0;
  nextSession = sessionFixture();
  stopResponds = { ok: true, status: 200 };
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe("MiniApp — web mode (no Tauri shell)", () => {
  it("renders the honest tiny notice and never polls the engine", async () => {
    stubFetch();
    // No __TAURI__ → miniShell() → null → the notice (isTauri stays real).
    render(<MiniApp pollMs={30} />);

    expect(screen.getByTestId("mini-web-notice").textContent).toContain(
      "The floating monitor needs the desktop app",
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 90));
    });
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("MiniApp — the minimal floating bar (Tauri)", () => {
  it("polls the session with the sidecar token and renders label + activity + elapsed", async () => {
    stubTauri();
    stubFetch();
    render(<MiniApp pollMs={30} />);

    // The first poll is immediate: label + latest activity + tabular elapsed.
    expect((await screen.findByTestId("mini-label")).textContent).toBe("Agent is using your computer");
    await waitFor(() =>
      expect(screen.getByTestId("mini-activity").textContent).toContain("Clicking the “Sign in” button"),
    );
    await waitFor(() => expect(screen.getByTestId("mini-elapsed").textContent).toMatch(/2m 1[0-9]s/));

    // The wire: GET on the right URL with the bearer token from sidecar_info.
    const get = fetchCalls.find(([input]) => String(input).endsWith("/api/v1/computer-use/session"));
    expect(get).toBeTruthy();
    expect(String(get?.[0])).toBe("http://127.0.0.1:5178/api/v1/computer-use/session");
    expect(get?.[1]?.headers).toEqual({ Authorization: "Bearer tok_mini" });

    // The poll keeps flowing: a NEW newest event lands in the activity row.
    nextSession = sessionFixture({
      events: [
        { seq: 3, ts: Date.now(), kind: "action", label: "Typing the password", tool: "computer_type" },
        ...sessionFixture().events,
      ],
    });
    await waitFor(
      () => expect(screen.getByTestId("mini-activity").textContent).toContain("Typing the password"),
      { timeout: 1_500 },
    );
  });

  it("a failed poll keeps the window alive with the honest disconnected line (no crash)", async () => {
    stubTauri();
    stubFetch();
    nextSession = null; // every poll throws at the network layer
    render(<MiniApp pollMs={30} />);

    await waitFor(() =>
      expect(screen.getByTestId("mini-activity").textContent).toContain("Monitor disconnected — retrying…"),
    );
    // The bar itself keeps rendering — a lost packet never kills the monitor.
    expect(screen.getByTestId("mini-label").textContent).toBe("Agent is using your computer");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 90));
    });
    expect(closeInvokes()).toBe(0);
  });

  it("STOP posts to the right URL with the token and the recorded reason, then locks", async () => {
    stubTauri();
    stubFetch();
    render(<MiniApp pollMs={30} />);

    // Wait for the first poll to land (the session + its newest event) so
    // the STOP click can never race the sidecar_info resolution.
    await screen.findByText("Clicking the “Sign in” button");

    // The post-stop session will report the kill switch engaged.
    nextSession = sessionFixture({
      active: false,
      killSwitch: true,
      stopReason: "stopped by the owner from the floating monitor",
    });

    fireEvent.click(screen.getByTestId("mini-stop-button"));

    // The wire: POST with bearer + JSON body carrying the provenance reason.
    await waitFor(() => {
      const post = fetchCalls.find(
        ([input, init]) => String(input).endsWith("/api/v1/computer-use/stop") && init?.method === "POST",
      );
      expect(post).toBeTruthy();
      expect(String(post?.[0])).toBe("http://127.0.0.1:5178/api/v1/computer-use/stop");
      expect(post?.[1]?.headers).toEqual({
        Authorization: "Bearer tok_mini",
        "Content-Type": "application/json",
      });
      expect(post?.[1]?.body).toBe(JSON.stringify({ reason: "stopped by the owner from the floating monitor" }));
    });

    // The post-stop truth locks the button into the stopped state.
    await waitFor(() => {
      const btn = screen.getByTestId("mini-stop-button") as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
    });
    await waitFor(() => expect(screen.getByTestId("mini-label").textContent).toBe("Stopped — kill switch active"));
  });

  it("an ACTIVE session never self-closes, however long it runs", async () => {
    stubTauri();
    stubFetch();
    render(<MiniApp pollMs={30} />);

    await screen.findByTestId("mini-label");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 160)); // 5+ polls, active throughout
    });
    expect(closeInvokes()).toBe(0);
  });

  it("self-closes ~6s-equivalent after the kill switch (once, not repeatedly)", async () => {
    stubTauri();
    stubFetch();
    nextSession = sessionFixture({ active: false, killSwitch: true, stopReason: "stopped by the owner from the floating monitor" });
    render(<MiniApp pollMs={30} stoppedCloseMs={80} />);

    await screen.findByTestId("mini-label");
    await waitFor(() => expect(closeInvokes()).toBe(1), { timeout: 1_000 });
    // Further polls do not re-invoke (the window lifetime guard).
    await act(async () => {
      await new Promise((r) => setTimeout(r, 120));
    });
    expect(closeInvokes()).toBe(1);
  });

  it("self-closes after a session_stop event ends the session", async () => {
    stubTauri();
    stubFetch();
    nextSession = sessionFixture({
      active: false,
      events: [{ seq: 3, ts: Date.now(), kind: "session_stop", label: "Control session stopped" }],
    });
    render(<MiniApp pollMs={30} stoppedCloseMs={80} />);

    await screen.findByTestId("mini-label");
    await waitFor(() => expect(closeInvokes()).toBe(1), { timeout: 1_000 });
  });

  it("self-closes once an inactive, un-stopped session has had no new events for the idle window", async () => {
    stubTauri();
    stubFetch();
    // Inactive, no kill switch, no session_stop — only silence closes it.
    nextSession = sessionFixture({ active: false });
    render(<MiniApp pollMs={30} idleCloseMs={120} />);

    await screen.findByTestId("mini-label");
    await waitFor(() => expect(closeInvokes()).toBe(1), { timeout: 1_500 });
  });

  it("resumes: new events after the idle window RESET the close clock (activity cancels dismissal)", async () => {
    stubTauri();
    stubFetch();
    // INACTIVE the whole time (no kill switch, no session_stop) — the only
    // thing keeping the window up is fresh events resetting lastEventAt.
    nextSession = sessionFixture({
      active: false,
      events: [{ seq: 5, ts: Date.now() - 500, kind: "action", label: "Idle action" }],
    });
    render(<MiniApp pollMs={30} idleCloseMs={150} />);

    await screen.findByTestId("mini-activity");
    // Activity keeps flowing (a fresh seq every poll) — never closes.
    for (let i = 0; i < 6; i++) {
      nextSession = sessionFixture({
        active: false,
        events: [{ seq: 6 + i, ts: Date.now(), kind: "action", label: `Action ${i}` }],
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 40));
      });
    }
    expect(closeInvokes()).toBe(0);
  });

  it("a failing STOP keeps the button honest with the surfaced error", async () => {
    stubTauri();
    stubFetch();
    stopResponds = { ok: false, status: 500 };
    render(<MiniApp pollMs={30} />);

    // The first poll must land before the click (see the test above).
    await screen.findByText("Clicking the “Sign in” button");
    fireEvent.click(screen.getByTestId("mini-stop-button"));
    await waitFor(() =>
      expect(screen.getByTestId("mini-activity").textContent).toContain("Stop failed with HTTP 500"),
    );
    // Still armed — the owner can retry.
    const btn = screen.getByTestId("mini-stop-button") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });
});
