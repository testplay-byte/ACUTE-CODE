// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { Route, Routes } from "react-router";
import { fetchDetailedUsage } from "../../lib/api";
import { UsageScreen } from "./UsageScreen";
import { useConfigStore } from "../../lib/config-store";
import { renderWithProviders, resetTestState } from "../../test-utils";
import type { DetailedUsage } from "../../lib/api";

// The screen is a VIEW over GET /usage/detailed — the api module is mocked
// exactly as the sidecar shapes it (the live-mode hook drives the fetch).
vi.mock("../../lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...original,
    fetchDetailedUsage: vi.fn(),
  };
});

afterEach(cleanup);

beforeEach(() => {
  resetTestState();
  // The usage hook only runs against the live sidecar (demo mode has no
  // usage log) — flip the store so the mocked fetch actually executes.
  useConfigStore.setState({ demoData: false });
  vi.mocked(fetchDetailedUsage).mockReset().mockResolvedValue(emptyDetailedUsage());
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
  it("renders the hero, overview stat cards, tool leaderboard and model card", async () => {
    vi.mocked(fetchDetailedUsage).mockResolvedValue(seededDetailedUsage());
    renderUsageScreen();

    // Hero (kicker + title + range selector).
    expect(await screen.findByText(/Usage Analytics/i)).toBeTruthy();
    expect(screen.getByRole("group", { name: /day range/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Last 30 days" })).toBeTruthy();

    // Overview stat cards (await — the skeleton yields to data once the
    // mocked fetch resolves).
    expect(await screen.findByText("Tokens")).toBeTruthy();
    expect(screen.getByText("Requests")).toBeTruthy();
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

    fireEvent.click(screen.getByRole("button", { name: "Last 7 days" }));
    expect(await screen.findByText("Tokens")).toBeTruthy();
    expect(vi.mocked(fetchDetailedUsage)).toHaveBeenCalledWith(7);
  });

  it("shows the empty state when the ledger has no sessions", async () => {
    vi.mocked(fetchDetailedUsage).mockResolvedValue(emptyDetailedUsage());
    renderUsageScreen();

    expect(await screen.findByText(/No usage yet — start a conversation/i)).toBeTruthy();
    expect(screen.queryByText("Tokens")).toBeNull(); // stat cards stay hidden
  });
});
