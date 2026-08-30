// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ROUND-53 (R53): the connect-loop suite.
 *
 * The one-shot `sidecar_info` adoption lost the race against the Rust
 * handshake and left the webview on a dead endpoint for the whole session.
 * These tests pin the loop's contract: retry until Running, fail fast on a
 * shell-reported failure, time out honestly, watchdog a mid-session death,
 * and restart through the shell on retry.
 */

const sidecarMock = vi.hoisted(() => ({
  isTauri: vi.fn((): boolean => false),
  getSidecarInfo: vi.fn(),
  getSidecarStatus: vi.fn(),
  restartSidecar: vi.fn(),
  pingSidecar: vi.fn(),
}));

vi.mock("./sidecar", () => sidecarMock);

const invalidateQueries = vi.fn();
vi.mock("./query-client", () => ({
  getQueryClient: () => ({ invalidateQueries }),
}));

// Imported AFTER the mocks (vi.mock hoists, but be explicit for readers).
import { useConfigStore } from "./config-store";
import {
  __resetConnectionLoopForTests,
  beginSidecarConnect,
  retryConnection,
} from "./sidecar-connection";

function resetStore(): void {
  useConfigStore.setState({
    baseUrl: "http://127.0.0.1:5178",
    token: null,
    demoData: true,
    connection: "connected",
    connectionError: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetConnectionLoopForTests();
  resetStore();
  sidecarMock.isTauri.mockReturnValue(true);
  sidecarMock.getSidecarStatus.mockResolvedValue({ phase: "starting" });
  sidecarMock.restartSidecar.mockResolvedValue(true);
  sidecarMock.pingSidecar.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  __resetConnectionLoopForTests();
});

describe("connect loop — happy path", () => {
  it("adopts the endpoint once the shell answers, flips demoData off, invalidates queries", async () => {
    vi.useFakeTimers();
    sidecarMock.getSidecarInfo
      .mockResolvedValueOnce(null) // handshake still running
      .mockResolvedValueOnce(null) // still running
      .mockResolvedValueOnce({ port: 55963, token: "tok-53" });

    beginSidecarConnect();

    await vi.advanceTimersByTimeAsync(0); // attempt 1 → not ready → sleep
    await vi.advanceTimersByTimeAsync(400); // attempt 2 → not ready → sleep
    await vi.advanceTimersByTimeAsync(400); // attempt 3 → adopted

    const s = useConfigStore.getState();
    expect(s.connection).toBe("connected");
    expect(s.baseUrl).toBe("http://127.0.0.1:55963");
    expect(s.token).toBe("tok-53");
    expect(s.demoData).toBe(false);
    expect(invalidateQueries).toHaveBeenCalled();
  });

  it("reads sidecar_status between failed attempts (the shell's phase decides the next move)", async () => {
    vi.useFakeTimers();
    sidecarMock.getSidecarInfo.mockResolvedValue(null);

    beginSidecarConnect();
    await vi.advanceTimersByTimeAsync(0);

    expect(sidecarMock.getSidecarStatus).toHaveBeenCalled();
    // "starting" → still connecting, not offline.
    expect(useConfigStore.getState().connection).toBe("connecting");
  });
});

describe("connect loop — failure paths", () => {
  it("fails FAST with the shell-reported startup error (no 90s burn)", async () => {
    vi.useFakeTimers();
    sidecarMock.getSidecarInfo.mockResolvedValue(null);
    sidecarMock.getSidecarStatus.mockResolvedValue({
      phase: "failed",
      error: "spawning `node.exe` in `C:\\…\\sidecar`: program not found",
    });

    beginSidecarConnect();
    await vi.advanceTimersByTimeAsync(0);

    const s = useConfigStore.getState();
    expect(s.connection).toBe("offline");
    expect(s.connectionError).toContain("program not found");

    // And it STOPPED — one attempt, no polling loop left running.
    const callsAfterFirst = sidecarMock.getSidecarInfo.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sidecarMock.getSidecarInfo.mock.calls.length).toBe(callsAfterFirst);
  });

  it("goes offline on phase=stopped with a restart hint", async () => {
    vi.useFakeTimers();
    sidecarMock.getSidecarInfo.mockResolvedValue(null);
    sidecarMock.getSidecarStatus.mockResolvedValue({ phase: "stopped" });

    beginSidecarConnect();
    await vi.advanceTimersByTimeAsync(0);

    expect(useConfigStore.getState().connection).toBe("offline");
    expect(useConfigStore.getState().connectionError).toContain("stopped");
  });

  it("times out honestly after the deadline (cold-boot migrations can't hang forever)", async () => {
    vi.useFakeTimers();
    sidecarMock.getSidecarInfo.mockResolvedValue(null);
    sidecarMock.getSidecarStatus.mockResolvedValue({ phase: "starting" });

    beginSidecarConnect();
    // R54: the deadline is 150s now (the Rust handshake retries 3× before
    // declaring Failed) — 150s of "starting" must still resolve to offline.
    await vi.advanceTimersByTimeAsync(149_000);
    expect(useConfigStore.getState().connection).toBe("connecting");
    await vi.advanceTimersByTimeAsync(2_000);

    const s = useConfigStore.getState();
    expect(s.connection).toBe("offline");
    expect(s.connectionError).toContain("did not become ready");
  });

  it("no-ops entirely in a plain browser (pre-R53 behavior)", async () => {
    vi.useFakeTimers();
    sidecarMock.isTauri.mockReturnValue(false);
    beginSidecarConnect();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sidecarMock.getSidecarInfo).not.toHaveBeenCalled();
    expect(useConfigStore.getState().connection).toBe("connected");
  });
});

describe("connect loop — watchdog", () => {
  it("a mid-session death flips to offline with the exit reason", async () => {
    vi.useFakeTimers();
    sidecarMock.getSidecarInfo.mockResolvedValue({ port: 55963, token: "tok-53" });

    beginSidecarConnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(useConfigStore.getState().connection).toBe("connected");

    // The backend dies: the watchdog's ping fails, the shell reports the exit.
    sidecarMock.pingSidecar.mockResolvedValueOnce(false);
    sidecarMock.getSidecarInfo.mockResolvedValue(null);
    sidecarMock.getSidecarStatus.mockResolvedValue({
      phase: "failed",
      error: "agent-core exited unexpectedly (code 1)",
    });

    await vi.advanceTimersByTimeAsync(20_000);

    const s = useConfigStore.getState();
    expect(s.connection).toBe("offline");
    expect(s.connectionError).toContain("exited unexpectedly");
  });

  it("a transient blip reconnects and re-invalidates queries", async () => {
    vi.useFakeTimers();
    sidecarMock.getSidecarInfo.mockResolvedValue({ port: 55963, token: "tok-53" });

    beginSidecarConnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(useConfigStore.getState().connection).toBe("connected");
    invalidateQueries.mockClear();

    // Blip: one failed ping, then the sidecar answers again on the new port.
    sidecarMock.pingSidecar.mockResolvedValueOnce(false);
    sidecarMock.getSidecarInfo.mockResolvedValue({ port: 56001, token: "tok-53b" });

    await vi.advanceTimersByTimeAsync(20_100);

    const s = useConfigStore.getState();
    expect(s.connection).toBe("connected");
    expect(s.baseUrl).toBe("http://127.0.0.1:56001");
    expect(invalidateQueries).toHaveBeenCalled();
  });
});

describe("connect loop — retryConnection (the offline banner's button)", () => {
  it("restarts the backend through the shell, then adopts the fresh endpoint", async () => {
    vi.useFakeTimers();
    // First pass: stopped → offline.
    sidecarMock.getSidecarInfo.mockResolvedValueOnce(null);
    sidecarMock.getSidecarStatus.mockResolvedValueOnce({ phase: "stopped" });
    beginSidecarConnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(useConfigStore.getState().connection).toBe("offline");

    // Retry: the shell restarts, the fresh endpoint answers immediately.
    sidecarMock.getSidecarInfo.mockResolvedValueOnce({ port: 61000, token: "tok-b" });
    await retryConnection();

    expect(sidecarMock.restartSidecar).toHaveBeenCalledTimes(1);
    const s = useConfigStore.getState();
    expect(s.connection).toBe("connected");
    expect(s.baseUrl).toBe("http://127.0.0.1:61000");
    expect(s.token).toBe("tok-b");
  });
});
