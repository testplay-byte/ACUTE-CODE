// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router";
import {
  fetchDetailedUsage,
  fetchKeyPool,
  fetchProviders,
  fetchUsageStats,
  type KeyPoolSlot,
  type ProviderView,
} from "../../lib/api";
import { UsageScreen } from "./UsageScreen";
import { useConfigStore } from "../../lib/config-store";
import { renderWithProviders, resetTestState } from "../../test-utils";
import type { DetailedUsage } from "../../lib/api";

// The screen is a VIEW over GET /usage/detailed — the api module is mocked
// exactly as the sidecar shapes it (the live-mode hook drives the fetch).
// ROUND-64 (R64-e): fetchProviders + fetchKeyPool are mocked too — the
// "API keys" section joins the detailed-usage keys rollup with the
// providers list + masked key pools.
vi.mock("../../lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...original,
    fetchDetailedUsage: vi.fn(),
    fetchProviders: vi.fn(),
    fetchKeyPool: vi.fn(),
    // R98-I2: the DataStatsPanel's fetcher — mocked so the panel renders
    // its empty-stats state deterministically (never a fetch error card).
    fetchUsageStats: vi.fn(),
  };
});

afterEach(cleanup);

beforeEach(() => {
  resetTestState();
  // The usage hook only runs against the live sidecar (demo mode has no
  // usage log) — flip the store so the mocked fetch actually executes.
  useConfigStore.setState({ demoData: false });
  vi.mocked(fetchDetailedUsage).mockReset().mockResolvedValue(emptyDetailedUsage());
  // R98-I2: the stats aggregate defaults to an empty 12-month window.
  vi.mocked(fetchUsageStats).mockReset().mockResolvedValue({
    months: 12,
    totals: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      requests: 0,
      providerCalls: 0,
    },
    peak: { date: null, tokens: 0 },
    series: [],
    models: [],
    health: { turnErrors: [], toolFailures: [] },
    generatedAt: "2026-09-15T00:00:00.000Z",
  });
  // ROUND-64 (R64-e): no providers / no keys by default — the existing
  // fixtures exercise the sections without the keys join.
  vi.mocked(fetchProviders).mockReset().mockResolvedValue([]);
  vi.mocked(fetchKeyPool).mockReset().mockResolvedValue([]);
});

/** The /usage route with a stub chat target so session navigation is observable. */
function renderUsageScreen() {
  return renderWithProviders(
    <Routes>
      <Route path="/usage" element={<UsageScreen />} />
      <Route path="/project/:id/chat" element={<div>project chat stub</div>} />
      <Route path="*" element={<div>not found</div>} />
    </Routes>,
    { route: "/usage" },
  );
}

function tokens(input: number, output: number, cached = 0) {
  return { input, output, cached };
}

function emptyDetailedUsage(): DetailedUsage {
  return {
    days: [
      { date: "2025-06-01", inputTokens: 0, outputTokens: 0, requests: 0, costUsd: 0 },
    ],
    totals: {
      projects: 0,
      sessions: 0,
      subagentSessions: 0,
      toolCalls: 0,
      requests: 0,
      tokens: tokens(0, 0),
      costUsd: 0,
    },
    tools: [],
    models: [],
    // ROUND-64 (R64-e): empty keys rollup (no usage rows).
    keys: [],
    projects: [],
    generatedAt: "2025-06-02T12:00:00.000Z",
  };
}

function seededDetailedUsage(): DetailedUsage {
  return {
    days: [
      { date: "2025-06-01", inputTokens: 100, outputTokens: 50, requests: 2, costUsd: 0.25 },
      { date: "2025-06-02", inputTokens: 230, outputTokens: 100, requests: 1, costUsd: 0.55 },
    ],
    totals: {
      projects: 1,
      sessions: 2,
      subagentSessions: 1,
      toolCalls: 4,
      requests: 3,
      tokens: tokens(330, 150, 50),
      costUsd: 0.8,
    },
    tools: [
      { tool: "read_file", count: 3, failures: 1 },
      { tool: "write_file", count: 1, failures: 0 },
    ],
    models: [
      {
        model: "z-ai/glm-5.2:free",
        calls: 3,
        tokens: tokens(330, 150, 50),
        costUsd: 0.8,
      },
    ],
    // ROUND-64 (R64-e): the per-key rollup — primary spent $0.30, pool slot 2
    // (the sub-agent child) spent $0.50. Cost-desc order like the server.
    keys: [
      {
        providerId: "openrouter",
        keySlot: 2,
        requests: 1,
        inputTokens: 200,
        outputTokens: 80,
        costUsd: 0.5,
        lastUsedAt: "2025-06-02T10:00:00.000Z",
      },
      {
        providerId: "openrouter",
        keySlot: 0,
        requests: 2,
        inputTokens: 130,
        outputTokens: 70,
        costUsd: 0.3,
        lastUsedAt: "2025-06-02T09:30:00.000Z",
      },
    ],
    projects: [
      {
        id: "prj_alpha",
        name: "Alpha",
        color: "#3B82F6",
        synthetic: false,
        sessionCount: 1,
        firstActivity: "2025-06-01T10:00:00.000Z",
        lastActivity: "2025-06-02T10:00:00.000Z",
        totals: {
          sessions: 1,
          subagents: 1,
          toolCalls: 4,
          requests: 3,
          costUsd: 0.8,
          tokens: tokens(330, 150, 50),
        },
        toolCalls: [
          { tool: "read_file", count: 3, failures: 1 },
          { tool: "write_file", count: 1, failures: 0 },
        ],
        subagents: {
          count: 1,
          toolCalls: 1,
          requests: 1,
          tokens: tokens(200, 80, 40),
          costUsd: 0.5,
        },
        models: [
          { model: "z-ai/glm-5.2:free", calls: 3, tokens: tokens(330, 150, 50), costUsd: 0.8 },
        ],
        sessions: [
          {
            id: "sess_child",
            title: "Research sub-task",
            status: "completed",
            model: "z-ai/glm-5.2:free",
            startedAt: "2025-06-02T09:30:00.000Z",
            endedAt: "2025-06-02T09:31:00.000Z",
            durationMs: 60_000,
            tokens: tokens(200, 80, 40),
            costUsd: 0.5,
            requests: 1,
            toolCalls: [{ tool: "read_file", count: 1, failures: 0 }],
            toolCallCount: 1,
            subagentCount: 0,
            isSubagent: true,
            parentId: "sess_main",
            role: "researcher",
          },
          {
            id: "sess_main",
            title: "Ship the feature",
            status: "completed",
            model: "z-ai/glm-5.2:free",
            startedAt: "2025-06-02T09:00:00.000Z",
            endedAt: "2025-06-02T09:30:00.000Z",
            durationMs: 1_800_000,
            tokens: tokens(130, 70, 10),
            costUsd: 0.3,
            requests: 2,
            toolCalls: [
              { tool: "read_file", count: 2, failures: 1 },
              { tool: "write_file", count: 1, failures: 0 },
            ],
            toolCallCount: 3,
            subagentCount: 1,
            isSubagent: false,
            parentId: null,
            role: null,
          },
        ],
      },
    ],
    generatedAt: "2025-06-02T12:00:00.000Z",
  };
}

describe("UsageScreen (ROUND-52 R52-b)", () => {
  it("renders the range toolbar + overview stat cards, tool leaderboard and model card — the R113-d hero is GONE", async () => {
    vi.mocked(fetchDetailedUsage).mockResolvedValue(seededDetailedUsage());
    renderUsageScreen();

    // R113-d (owner: the page headers are "unnecessary, unneeded, and not
    // required"): the Kicker + 24px "Usage" title + description hero is
    // deleted; the day-range picker survives as the one functional toolbar
    // row at the top of the page.
    expect(screen.queryByText("Data & Statistics")).toBeNull();
    expect(screen.queryByRole("heading", { level: 1, name: "Usage" })).toBeNull();
    expect(screen.queryByText(/Every project, every session, every tool call/i)).toBeNull();
    expect(screen.getByRole("group", { name: /day range/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Last 30 days" })).toBeTruthy();

    // Overview stat cards (await — the skeleton yields to data once the
    // mocked fetch resolves). ROUND-64 (R64-e): the API-keys cards also
    // label turns — the overview assertion reads ALL of them. ROUND-83
    // (R83): "Requests" → "Turns" (the honest relabel — a usage row is a
    // TURN since R24; the provider-call count is the StatCard title).
    expect(await screen.findByText("Tokens")).toBeTruthy();
    expect(screen.getAllByText("Turns").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Sessions")).toBeTruthy();
    expect(screen.getByText("Tool calls")).toBeTruthy();

    // Tool leaderboard rows (failures ride along in the danger color).
    expect(screen.getByText("read_file")).toBeTruthy();
    expect(screen.getByText("write_file")).toBeTruthy();

    // Model card with its mono model id.
    expect(screen.getByText("z-ai/glm-5.2:free")).toBeTruthy();
  });

  it("drill-down: project section expands on click to its sessions with the nested sub-agent run", async () => {
    vi.mocked(fetchDetailedUsage).mockResolvedValue(seededDetailedUsage());
    renderUsageScreen();

    // Project section header renders collapsed — sessions hidden until click.
    const toggle = await screen.findByRole("button", { name: /Toggle project Alpha sessions/i });
    expect(screen.queryByText("Ship the feature")).toBeNull();

    fireEvent.click(toggle);
    expect(screen.getByText("Ship the feature")).toBeTruthy();
    // The sub-agent child nests under its parent with the role badge.
    expect(screen.getByText("Research sub-task")).toBeTruthy();
    expect(screen.getByText("sub-agent · researcher")).toBeTruthy();

    // Clicking the main session deep-links into the project chat (?session=).
    fireEvent.click(screen.getByRole("button", { name: /Open session Ship the feature/i }));
    expect(await screen.findByText("project chat stub")).toBeTruthy();
  });

  it("range selector drives a refetch with the new window", async () => {
    vi.mocked(fetchDetailedUsage).mockResolvedValue(seededDetailedUsage());
    renderUsageScreen();

    // Wait for data-driven content (a stat card) so the query has settled
    // before reading the fetch calls.
    expect(await screen.findByText("Tokens")).toBeTruthy();
    expect(vi.mocked(fetchDetailedUsage)).toHaveBeenCalledWith(30);

    // R98-I2: the screen now hosts TWO range pickers (the activity chart's
    // + the DataStatsPanel's model-mix chart) — scope to the ACTIVITY chart's
    // group so the query stays unambiguous. The stat label "Tokens" also
    // renders twice now (the overview's + the panel's stat card) — the
    // settled assertion rides findAllByText.
    const activityRange = within(
      screen.getByRole("group", { name: "Activity chart day range" }),
    );
    fireEvent.click(activityRange.getByRole("button", { name: "Last 7 days" }));
    expect((await screen.findAllByText("Tokens")).length).toBeGreaterThan(0);
    expect(vi.mocked(fetchDetailedUsage)).toHaveBeenCalledWith(7);
  });

  it("shows the empty state when the ledger has no sessions", async () => {
    vi.mocked(fetchDetailedUsage).mockResolvedValue(emptyDetailedUsage());
    renderUsageScreen();

    expect(await screen.findByText(/No usage yet — start a conversation/i)).toBeTruthy();
    expect(screen.queryByText("Tokens")).toBeNull(); // stat cards stay hidden
  });

  // R97-I part 2 (owner: a UI "aware of its states"): the error banner is
  // RETRYABLE — pre-R97 it pointed at a full app reload for what one refetch
  // fixes.
  it("a failed fetch renders the retryable error banner — Retry re-drives the query", async () => {
    vi.mocked(fetchDetailedUsage).mockRejectedValueOnce(new Error("sidecar down"));
    renderUsageScreen();

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/Could not load usage analytics/i)).toBeTruthy();
    const retry = screen.getByRole("button", { name: "Retry loading usage analytics" });

    // Retry re-drives the query: the next fetch resolves and the screen
    // recovers to its data view (the banner is gone).
    vi.mocked(fetchDetailedUsage).mockResolvedValueOnce(seededDetailedUsage());
    fireEvent.click(retry);
    expect(await screen.findByText("Tokens")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

/* ── ROUND-64 (R64-e): the "API keys" section — per-key cards joining the
 * detailed-usage keys rollup with the providers list + masked key pools. */

const OPENROUTER_VIEW: ProviderView = {
  id: "openrouter",
  name: "OpenRouter",
  kind: "openai-compatible",
  baseUrl: "https://openrouter.ai/api/v1",
  apiFormat: "chat-completions",
  enabled: true,
  createdAt: "2025-01-01T00:00:00.000Z",
  hasKey: true,
};

function pool(slots: KeyPoolSlot[]): KeyPoolSlot[] {
  return slots;
}

describe("UsageScreen API keys section (ROUND-64 R64-e)", () => {
  it("renders one card per key: usage slots, configured-but-unused slots, masked previews and stats", async () => {
    vi.mocked(fetchDetailedUsage).mockResolvedValue(seededDetailedUsage());
    vi.mocked(fetchProviders).mockResolvedValue([OPENROUTER_VIEW]);
    // The keyring holds the primary + SLOT2 (both used) and SLOT3 (never
    // used) — the section must show all three.
    vi.mocked(fetchKeyPool).mockResolvedValue(
      pool([
        { slot: 0, hasKey: true, masked: "sk-o…36a" },
        { slot: 2, hasKey: true, masked: "sk-o…36b" },
        { slot: 3, hasKey: true, masked: "sk-o…36c" },
      ]),
    );
    renderUsageScreen();

    // Section header: count + all-time cost of the shown keys.
    expect(await screen.findByRole("region", { name: "API keys" })).toBeTruthy();
    expect(screen.getByText("3 keys · $0.80 all-time")).toBeTruthy();

    // Provider name + the three slot labels (slot 0 = Primary key).
    expect(screen.getAllByText("OpenRouter").length).toBe(3);
    expect(screen.getByText("Primary key")).toBeTruthy();
    expect(screen.getByText("Pool slot 2")).toBeTruthy();
    expect(screen.getByText("Pool slot 3")).toBeTruthy();

    // Masked previews (mono, from GET /providers/:id/keys).
    expect(screen.getByText("sk-o…36a")).toBeTruthy();
    expect(screen.getByText("sk-o…36b")).toBeTruthy();

    // Usage stats: the pool-slot-2 card (cost-desc first) carries its rollup.
    expect(screen.getAllByText("$0.50").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("$0.30").length).toBeGreaterThanOrEqual(1);

    // The configured-but-unused key shows its honest "not used yet" note.
    expect(screen.getByText(/Not used yet/i)).toBeTruthy();
  });

  it("flags usage on a slot the keyring no longer holds as a removed key", async () => {
    vi.mocked(fetchDetailedUsage).mockResolvedValue(seededDetailedUsage());
    vi.mocked(fetchProviders).mockResolvedValue([OPENROUTER_VIEW]);
    // Only the primary is held — slot 2's spend is real but its key is gone.
    vi.mocked(fetchKeyPool).mockResolvedValue(pool([{ slot: 0, hasKey: true, masked: "sk-o…36a" }]));
    renderUsageScreen();

    expect(await screen.findByText("removed key")).toBeTruthy();
    // The removed card still shows its spend (honest accounting).
    expect(screen.getByText("Pool slot 2")).toBeTruthy();
    expect(screen.getByText("$0.50")).toBeTruthy();
  });

  it("shows configured keys below the empty state (zeros + not used yet)", async () => {
    vi.mocked(fetchDetailedUsage).mockResolvedValue(emptyDetailedUsage());
    vi.mocked(fetchProviders).mockResolvedValue([OPENROUTER_VIEW]);
    vi.mocked(fetchKeyPool).mockResolvedValue(pool([{ slot: 0, hasKey: true, masked: "sk-o…36a" }]));
    renderUsageScreen();

    // The empty ledger state renders AND the configured key's card below it.
    expect(await screen.findByText(/No usage yet — start a conversation/i)).toBeTruthy();
    expect(await screen.findByText(/Not used yet/i)).toBeTruthy();
    expect(screen.getByText("Primary key")).toBeTruthy();
    expect(screen.getByText("1 key · $0.00 all-time")).toBeTruthy();
  });
});
