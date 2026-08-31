import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { useConfigStore } from "./config-store";
import {
  MAX_POOL_SLOT,
  MIN_POOL_SLOT,
  nextFreeSlot,
  revealProviderKeys,
  type RevealedKey,
} from "./key-pool";

// ROUND-47 (R47-c1): the KeyPoolSection slot-collision fix — pure unit tests
// (gaps, full pool, empty pool, bounds). The component-level regression test
// (slots 2 & 4 held → the next add writes slot 3) lives in
// ModelsProvidersTab.test.tsx.
describe("nextFreeSlot (ROUND-47 R47-c1)", () => {
  it("empty pool → the first pool slot (2)", () => {
    expect(nextFreeSlot([])).toBe(2);
  });

  it("contiguous held slots → one past the last", () => {
    expect(nextFreeSlot([2, 3, 4])).toBe(5);
  });

  it("GAP (the old `slots.length + 2` collision): slots 2 & 4 held → 3, never 4", () => {
    // The old code computed 2 + 2 = 4 and overwrote the held slot-4 key.
    expect(nextFreeSlot([2, 4])).toBe(3);
    expect(nextFreeSlot([3, 5, 7])).toBe(2);
  });

  it("ignores ordering, duplicates and out-of-range held slots", () => {
    expect(nextFreeSlot([4, 2, 4])).toBe(3);
    // Slots outside [2, 31] never block the scan (slot 0 is the primary key).
    expect(nextFreeSlot([0, 1, 32, 99])).toBe(2);
  });

  it("full pool (every slot 2–31 held) → -1", () => {
    const all = Array.from({ length: MAX_POOL_SLOT - MIN_POOL_SLOT + 1 }, (_, i) => MIN_POOL_SLOT + i);
    expect(nextFreeSlot(all)).toBe(-1);
  });

  it("honors custom bounds", () => {
    expect(nextFreeSlot([5], 5, 7)).toBe(6);
    expect(nextFreeSlot([5, 6, 7], 5, 7)).toBe(-1);
    // Empty range (min > max) → nothing free.
    expect(nextFreeSlot([], 8, 3)).toBe(-1);
  });
});

// ── ROUND-58 (R58-d): the reveal client fn ──────────────────────────────────

describe("revealProviderKeys (ROUND-58 R58-d)", () => {
  const BASE = "http://127.0.0.1:5199";
  /** The stubbed global — its own call log is the assertion surface
   * (mockResolvedValueOnce bypasses the impl, so a manual log would miss
   * those calls). */
  const fetchMock = vi.fn(async (): Promise<Response> => ({
    status: 200,
    ok: true,
    text: async () => "",
  } as unknown as Response));

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (): Promise<Response> => ({
      status: 200,
      ok: true,
      text: async () => "",
    } as unknown as Response));
    useConfigStore.setState({ baseUrl: BASE, token: "tok-58", demoData: false });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A 200 reveal response body. */
  const revealBody = (keys: RevealedKey[]): string =>
    JSON.stringify({ keys: keys.map((k) => ({ slot: k.slot, value: k.value })) });

  it("POSTs the reveal route with the bearer token and returns the full values", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      text: async () => revealBody([{ slot: 0, value: "sk-or-primary" }, { slot: 2, value: "sk-or-pool-2" }]),
    } as unknown as Response);

    const keys = await revealProviderKeys("openrouter");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit | undefined];
    expect(String(firstCall[0])).toBe(`${BASE}/api/v1/providers/openrouter/keys/reveal`);
    expect(firstCall[1]?.method).toBe("POST");
    expect((firstCall[1]?.headers as Record<string, string>).Authorization).toBe("Bearer tok-58");
    expect(keys).toEqual([
      { slot: 0, value: "sk-or-primary" },
      { slot: 2, value: "sk-or-pool-2" },
    ]);
  });

  it("URL-encodes the provider id (custom ids with slashes/spaces)", async () => {
    await expect(revealProviderKeys("my gateway")).rejects.toBeInstanceOf(ApiError); // empty body → honest error
    const firstCall = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit | undefined];
    expect(String(firstCall[0])).toBe(`${BASE}/api/v1/providers/my%20gateway/keys/reveal`);
  });

  it("throws ApiError with the envelope's code + message on a 404", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 404,
      ok: false,
      text: async () => JSON.stringify({ error: { code: "NOT_FOUND", message: "no provider with id nope" } }),
    } as unknown as Response);

    await expect(revealProviderKeys("nope")).rejects.toSatisfy((err: unknown) => {
      const apiErr = err as ApiError;
      return apiErr instanceof ApiError && apiErr.status === 404 && apiErr.code === "NOT_FOUND" && apiErr.message === "no provider with id nope";
    });
  });

  it("throws ApiError NETWORK when fetch itself rejects (sidecar down)", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(revealProviderKeys("openrouter")).rejects.toSatisfy((err: unknown) => {
      const apiErr = err as ApiError;
      return apiErr instanceof ApiError && apiErr.code === "NETWORK" && apiErr.message.includes(BASE);
    });
  });

  it("skips malformed entries and surfaces a missing keys array honestly", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      text: async () =>
        JSON.stringify({ keys: [{ slot: 0, value: "ok" }, { slot: "x" }, null, { slot: 3, value: 7 }] }),
    } as unknown as Response);
    const keys = await revealProviderKeys("openrouter");
    expect(keys).toEqual([{ slot: 0, value: "ok" }]);

    fetchMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      text: async () => JSON.stringify({}),
    } as unknown as Response);
    await expect(revealProviderKeys("openrouter")).rejects.toSatisfy((err: unknown) => {
      const apiErr = err as ApiError;
      return apiErr instanceof ApiError && apiErr.message === "reveal response missing keys array";
    });
  });
});
