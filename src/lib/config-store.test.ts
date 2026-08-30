// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ROUND-53 (R53): the stale-port regression suite.
 *
 * The owner's first run of the packaged app showed "Could not reach
 * agent-core at http://127.0.0.1:55963 (TypeError: Failed to fetch)". The
 * sidecar binds an EPHEMERAL port per launch; the store persisted that port
 * (baseUrl) + demoData:false, so the NEXT boot rehydrated a dead endpoint
 * and every request died. These tests pin the fix: inside Tauri NOTHING is
 * persisted and persisted v1 blobs (from pre-R53 installs) are dropped on
 * rehydrate.
 */

const STORAGE_KEY = "acute-code.config";

/** A persisted blob — v1 mirrors a pre-R53 install (discarded by the v2
 * store); v2 is the current browser-dev contract. */
function seedPersisted(version: 1 | 2): void {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      state: { baseUrl: "http://127.0.0.1:55963", demoData: false },
      version,
    }),
  );
}

/** A pre-R53 persisted blob — exactly what the owner's install had on disk. */
function seedStalePersisted(): void {
  seedPersisted(1);
}

function setTauriGlobal(on: boolean): void {
  if (on) {
    (window as { __TAURI__?: unknown }).__TAURI__ = {
      core: { invoke: async () => ({}) },
    };
  } else {
    delete (window as { __TAURI__?: unknown }).__TAURI__;
  }
}

async function freshStore() {
  vi.resetModules();
  return import("./config-store");
}

beforeEach(() => {
  localStorage.clear();
  setTauriGlobal(false);
});

describe("config store — ROUND-53 stale-port fix", () => {
  it("TAURI mode: a persisted v1 blob with the dead port 55963 is IGNORED on rehydrate", async () => {
    setTauriGlobal(true);
    seedStalePersisted();
    const { useConfigStore } = await freshStore();

    const s = useConfigStore.getState();
    // The safe default — NOT the previous session's ephemeral port.
    expect(s.baseUrl).toBe("http://127.0.0.1:5178");
    // demoData back to its safe default too (the blob's false is retired).
    expect(s.demoData).toBe(true);
    // The webview starts gated until the connect loop adopts the live port.
    expect(s.connection).toBe("connecting");
    expect(s.connectionError).toBeNull();
  });

  it("TAURI mode: nothing is ever persisted (adoptEndpoint leaves no trace)", async () => {
    setTauriGlobal(true);
    const { useConfigStore } = await freshStore();

    useConfigStore.getState().adoptEndpoint({ port: 55963, token: "tok-53" });
    expect(useConfigStore.getState().baseUrl).toBe("http://127.0.0.1:55963");

    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null) {
      // A v2 blob may exist but must carry NO endpoint state.
      const parsed = JSON.parse(raw) as { state: Record<string, unknown> };
      expect(parsed.state.baseUrl).toBeUndefined();
      expect(parsed.state.demoData).toBeUndefined();
      expect(parsed.state.token).toBeUndefined();
    }
  });

  it("TAURI mode: adoptEndpoint flips demoData off and stores the live endpoint in memory", async () => {
    setTauriGlobal(true);
    const { useConfigStore } = await freshStore();

    useConfigStore.getState().adoptEndpoint({ port: 41234, token: "bearer" });
    const s = useConfigStore.getState();
    expect(s.baseUrl).toBe("http://127.0.0.1:41234");
    expect(s.token).toBe("bearer");
    expect(s.demoData).toBe(false);
  });

  it("browser mode: keeps the historical persistence (stable dev port)", async () => {
    // The repo root's .env wires VITE_ACUTE_* for dev — stub them empty so
    // this test pins the PURE persisted-rehydration behavior.
    vi.stubEnv("VITE_ACUTE_BASE_URL", "");
    vi.stubEnv("VITE_ACUTE_TOKEN", "");
    const { useConfigStore } = await freshStore();
    expect(useConfigStore.getState().connection).toBe("connected");

    useConfigStore.getState().setBaseUrl("http://127.0.0.1:5178/");
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).state).toEqual({
      baseUrl: "http://127.0.0.1:5178",
      demoData: true,
    });
    vi.unstubAllEnvs();
  });

  it("browser mode: rehydrates a CURRENT (v2) persisted baseUrl + demoData (dev flow unchanged)", async () => {
    vi.stubEnv("VITE_ACUTE_BASE_URL", "");
    vi.stubEnv("VITE_ACUTE_TOKEN", "");
    seedPersisted(2);
    const { useConfigStore } = await freshStore();
    const s = useConfigStore.getState();
    expect(s.baseUrl).toBe("http://127.0.0.1:55963");
    expect(s.demoData).toBe(false);
    expect(s.connection).toBe("connected");
    vi.unstubAllEnvs();
  });

  it("browser mode: a v1 (pre-R53) blob is retired too — the dead port never rehydrates anywhere", async () => {
    vi.stubEnv("VITE_ACUTE_BASE_URL", "");
    vi.stubEnv("VITE_ACUTE_TOKEN", "");
    seedPersisted(1);
    const { useConfigStore } = await freshStore();
    const s = useConfigStore.getState();
    expect(s.baseUrl).toBe("http://127.0.0.1:5178");
    expect(s.demoData).toBe(true);
    vi.unstubAllEnvs();
  });

  it("setConnection carries the offline error and clears it on reconnect", async () => {
    const { useConfigStore } = await freshStore();
    useConfigStore.getState().setConnection("offline", "sidecar failed: spawn error");
    expect(useConfigStore.getState().connection).toBe("offline");
    expect(useConfigStore.getState().connectionError).toBe("sidecar failed: spawn error");

    useConfigStore.getState().setConnection("connecting");
    expect(useConfigStore.getState().connection).toBe("connecting");
    expect(useConfigStore.getState().connectionError).toBeNull();
  });
});
