// @vitest-environment happy-dom
/**
 * ROUND-47 (R47-c1) — provider-management consolidation regression tests:
 *
 *  1. KeyPoolSection slot-collision fix: slots 2 & 4 held → the next add
 *     writes slot 3 (the old `slots.length + 2` computed 4 and OVERWROTE
 *     the held slot-4 key).
 *  2. Full pool (slots 2–31) → honest error, no PUT.
 *  3. The connection card's new test surface: key selector (primary + held
 *     pool slots) + model selector (reachability default) → POST
 *     /providers/:id/test carries {slot, model}; ok:false at HTTP 200
 *     renders the honest red message; reachability-only surfaces the
 *     backend's own note.
 *  4. Browser-dev ephemeral-key notes render (isTauri() is false in tests).
 *
 * The api-level fns themselves are covered exhaustively in
 * src/lib/api.test.ts; this file covers the WIRING.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { KeyPoolSection, ModelsProvidersTab } from "./ModelsProvidersTab";
import { resetTestState, renderWithProviders } from "../../test-utils";
import type { KeyPoolSlot, ProviderView } from "../../lib/api";

/* ── Stateful fetch mock (the sidecar API surface this tab touches) ───────── */

const BASE = "http://127.0.0.1:5178";
const calls: Array<{ method: string; url: string; body?: unknown }> = [];

const PROVIDER: ProviderView = {
  id: "openrouter",
  name: "OpenRouter",
  kind: "openai-compatible",
  baseUrl: "https://openrouter.ai/api/v1",
  apiFormat: "chat-completions",
  enabled: true,
  createdAt: "2026-08-21T09:00:00Z",
  hasKey: true,
};

let pool: KeyPoolSlot[] = [];
/** What POST /providers/:id/test answers this test (ok:true / ok:false). */
let testResponse: unknown = {
  ok: true,
  latencyMs: 312,
  message: "Reachable — pick a model for a full key + model test.",
};

function jsonResponse(body: unknown): Response {
  return { status: 200, ok: true, text: async () => JSON.stringify(body) } as unknown as Response;
}

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();
  const body = init?.body !== undefined ? (JSON.parse(String(init.body)) as unknown) : undefined;
  calls.push({ method, url, body });

  if (url === `${BASE}/api/v1/providers` && method === "GET") {
    return jsonResponse({ providers: [PROVIDER] });
  }
  // Key pool (GET list + stateful PUT/DELETE per slot).
  const keyMatch = url.match(/\/api\/v1\/providers\/openrouter\/keys(?:\/(\d+))?$/);
  if (keyMatch !== null) {
    if (keyMatch[1] === undefined) return jsonResponse({ keys: pool });
    const slot = Number(keyMatch[1]);
    if (method === "PUT") {
      const value = String((body as { value: string }).value);
      pool = pool.filter((k) => k.slot !== slot);
      pool.push({ slot, hasKey: true, masked: `${value.slice(0, 5)}…${value.slice(-4)}` });
      pool.sort((a, b) => a.slot - b.slot);
      return jsonResponse({ keys: pool });
    }
    if (method === "DELETE") {
      pool = pool.filter((k) => k.slot !== slot);
      pool.push({ slot, hasKey: false, masked: null });
      pool.sort((a, b) => a.slot - b.slot);
      return jsonResponse({ keys: pool });
    }
  }
  if (url === `${BASE}/api/v1/providers/openrouter/models-config` && method === "GET") {
    return jsonResponse({ models: [] });
  }
  if (url === `${BASE}/api/v1/providers/openrouter/models` && method === "GET") {
    return jsonResponse({ models: [{ id: "z-ai/glm-5.2:free", name: "Z.ai: GLM 5.2" }] });
  }
  if (url === `${BASE}/api/v1/providers/openrouter/test` && method === "POST") {
    return jsonResponse(testResponse);
  }
  return {
    status: 404,
    ok: false,
    text: async () => JSON.stringify({ error: { code: "NOT_FOUND", message: `unmocked ${method} ${url}` } }),
  } as unknown as Response;
});

beforeEach(() => {
  resetTestState();
  calls.length = 0;
  pool = [];
  testResponse = { ok: true, latencyMs: 312, message: "Reachable — pick a model for a full key + model test." };
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/* ── KeyPoolSection: the slot-collision fix (the round's bug) ─────────────── */

describe("KeyPoolSection — next-free-slot (ROUND-47 R47-c1)", () => {
  it("slots 2 & 4 held → the next add PUTs slot 3 (the old code overwrote 4)", async () => {
    pool = [
      { slot: 2, hasKey: true, masked: "sk-o…aaaa" },
      { slot: 4, hasKey: true, masked: "sk-o…cccc" },
    ];
    renderWithProviders(<KeyPoolSection providerId="openrouter" />);

    fireEvent.change(await screen.findByLabelText("New pool key"), {
      target: { value: "sk-or-v1-pool-key-003" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add slot/i }));

    await waitFor(() => {
      const put = calls.find((c) => c.method === "PUT" && c.url.endsWith("/keys/3"));
      expect(put).toBeDefined();
      expect(put?.body).toEqual({ value: "sk-or-v1-pool-key-003" });
    });
    // The held slot-4 key is NEVER written.
    expect(calls.some((c) => c.method === "PUT" && c.url.endsWith("/keys/4"))).toBe(false);
    // The saved slot re-renders masked.
    await waitFor(() => expect(screen.getByText("sk-or…-003")).toBeTruthy());
  });

  it("contiguous pool → one past the last (2,3,4 held → slot 5)", async () => {
    pool = [
      { slot: 2, hasKey: true, masked: "sk-o…aaaa" },
      { slot: 3, hasKey: true, masked: "sk-o…bbbb" },
      { slot: 4, hasKey: true, masked: "sk-o…cccc" },
    ];
    renderWithProviders(<KeyPoolSection providerId="openrouter" />);

    fireEvent.change(await screen.findByLabelText("New pool key"), {
      target: { value: "sk-or-v1-pool-key-005" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add slot/i }));

    await waitFor(() => {
      expect(calls.find((c) => c.method === "PUT" && c.url.endsWith("/keys/5"))).toBeDefined();
    });
  });

  it("full pool (slots 2–31) → honest error, no PUT at all", async () => {
    pool = Array.from({ length: 30 }, (_, i) => ({
      slot: i + 2,
      hasKey: true,
      masked: `sk-o…${String(i).padStart(2, "0")}`,
    }));
    renderWithProviders(<KeyPoolSection providerId="openrouter" />);

    fireEvent.change(await screen.findByLabelText("New pool key"), {
      target: { value: "sk-or-v1-overflow" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add slot/i }));

    await waitFor(() =>
      expect(screen.getByText("the key pool is full (slots 2–31)")).toBeTruthy(),
    );
    expect(calls.every((c) => c.method !== "PUT")).toBe(true);
  });

  it("shows the browser-dev ephemeral-key note (isTauri() false)", async () => {
    renderWithProviders(<KeyPoolSection providerId="openrouter" />);
    await waitFor(() =>
      expect(screen.getByText(/Browser-dev keys live in server memory only/)).toBeTruthy(),
    );
  });
});

/* ── The connection card's explicit test surface (key + model selectors) ──── */

describe("Connection card — key + model scoped test (ROUND-47 R47-c1)", () => {
  /** Render the tab and open the (single) provider's detail pane. */
  async function openProviderDetail() {
    renderWithProviders(<ModelsProvidersTab />);
    fireEvent.click(await screen.findByRole("button", { name: /openrouter/i }));
    await waitFor(() => expect(screen.getByLabelText("Test key")).toBeTruthy());
  }

  it("key selector offers the primary + every HELD pool slot (shared key-pool cache)", async () => {
    pool = [
      { slot: 2, hasKey: true, masked: "sk-o…aaaa" },
      { slot: 3, hasKey: false, masked: null }, // keyless rows are NOT offered
      { slot: 4, hasKey: true, masked: "sk-o…cccc" },
    ];
    await openProviderDetail();

    // The pool query lands async — wait for its options before asserting.
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Pool slot 2" })).toBeTruthy(),
    );
    expect(screen.getByRole("option", { name: "Primary key" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Pool slot 4" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Pool slot 3" })).toBeNull();
    // Model selector: the honest reachability default + the live catalog.
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "z-ai/glm-5.2:free" })).toBeTruthy(),
    );
    expect(screen.getByRole("option", { name: "(reachability only)" })).toBeTruthy();
  });

  it("default test POSTs an empty body (primary key, reachability only) and surfaces the backend's note", async () => {
    await openProviderDetail();

    fireEvent.click(screen.getByRole("button", { name: /test connection/i }));

    await waitFor(() => {
      const post = calls.find(
        (c) => c.method === "POST" && c.url.endsWith("/providers/openrouter/test"),
      );
      expect(post).toBeDefined();
      expect(post?.body).toEqual({});
    });
    // ok + server-measured latency in green…
    await waitFor(() => expect(screen.getByText(/Connected · 312ms/)).toBeTruthy());
    // …plus the backend's OWN reachability-only message (not hardcoded copy).
    expect(screen.getByText(/Reachable — pick a model for a full key \+ model test/)).toBeTruthy();
  });

  it("selecting a pool slot + a model sends {slot, model} — the R47-b contract body", async () => {
    pool = [{ slot: 2, hasKey: true, masked: "sk-o…aaaa" }];
    testResponse = { ok: true, latencyMs: 87, model: "z-ai/glm-5.2:free" };
    await openProviderDetail();

    // The slot option must exist before the select can take its value.
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Pool slot 2" })).toBeTruthy(),
    );
    fireEvent.change(screen.getByLabelText("Test key"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Test model"), {
      target: { value: "z-ai/glm-5.2:free" },
    });
    fireEvent.click(screen.getByRole("button", { name: /test connection/i }));

    await waitFor(() => {
      const post = calls.find(
        (c) => c.method === "POST" && c.url.endsWith("/providers/openrouter/test"),
      );
      expect(post).toBeDefined();
      expect(post?.body).toEqual({ slot: 2, model: "z-ai/glm-5.2:free" });
    });
    await waitFor(() =>
      expect(screen.getByText(/Connected · 87ms · z-ai\/glm-5\.2:free/)).toBeTruthy(),
    );
  });

  it("ok:false at HTTP 200 renders the provider's honest refusal in red — no error toast", async () => {
    testResponse = { ok: false, message: "key rejected by provider (HTTP 401)" };
    await openProviderDetail();

    fireEvent.click(screen.getByRole("button", { name: /test connection/i }));

    const refusal = await screen.findByText("key rejected by provider (HTTP 401)");
    expect(refusal.style.color).toBe("#ef4444");
  });
});
