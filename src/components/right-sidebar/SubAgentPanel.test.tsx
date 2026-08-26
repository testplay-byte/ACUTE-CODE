// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  fetchSubAgentDetail,
  fetchSubAgents,
  retrySubAgent,
  type SessionDetail,
  type SessionEvent,
} from "../../lib/api";
import { SubAgentPanel } from "./SubAgentPanel";
import type { RightSidebarTab } from "../../lib/right-sidebar-store";
import { renderWithProviders, resetTestState } from "../../test-utils";

// The R43 phase-card redesign is a visual pass — the data layer (600ms
// detail polling, the subagents listing for the error reason, the retry
// endpoint) is mocked exactly as the real api module shapes it.
vi.mock("../../lib/api", () => ({
  fetchSubAgentDetail: vi.fn(),
  fetchSubAgents: vi.fn().mockResolvedValue([]),
  retrySubAgent: vi.fn().mockResolvedValue(undefined),
}));

afterEach(cleanup);

beforeEach(() => {
  resetTestState();
  vi.mocked(fetchSubAgentDetail).mockReset();
  vi.mocked(fetchSubAgents).mockReset().mockResolvedValue([]);
  vi.mocked(retrySubAgent).mockReset().mockResolvedValue(undefined);
});

const now = () => new Date().toISOString();

function ev(seq: number, type: string, payload: unknown): SessionEvent {
  return { seq, type, agentId: null, payload, ts: now() };
}

function detail(status: SessionDetail["status"], events: SessionEvent[]): SessionDetail {
  return {
    id: "child-1",
    projectId: "prj_1",
    agentId: "agt_coder",
    mode: "single",
    status,
    title: "Refactor auth module",
    createdAt: now(),
    updatedAt: now(),
    parentSessionId: "parent-1",
    subRole: "coder",
    events,
    lastSeq: events.length,
  };
}

const tab: RightSidebarTab = {
  id: "tab-1",
  type: "subagent",
  title: "Refactor auth module",
  subAgentId: "child-1",
  parentSessionId: "parent-1",
  subRole: "coder",
  createdAt: Date.now(),
};

const RUNNING_EVENTS: SessionEvent[] = [
  ev(1, "message.user", { role: "user", content: "Refactor src/auth into smaller modules and keep the public API." }),
  ev(2, "tool.use", { toolName: "write_file", argsSummary: "src/auth/fix.ts", ok: true, outputSummary: "wrote 42 lines" }),
  ev(3, "tool.use", { toolName: "run_command", argsSummary: "pnpm test", ok: null }),
];

describe("SubAgentPanel (R43 phase-card redesign)", () => {
  it("renders the four phase cards for a running child with the live chip", async () => {
    vi.mocked(fetchSubAgentDetail).mockResolvedValue(detail("running", RUNNING_EVENTS));
    renderWithProviders(<SubAgentPanel tab={tab} />);

    // Phase 1 — TASK: the delegation prompt, present + clamped component.
    expect(await screen.findByText("Task")).toBeTruthy();
    expect(
      screen.getByText("Refactor src/auth into smaller modules and keep the public API."),
    ).toBeTruthy();

    // Phase 2 — ACTIVITY: tool rows with mono names + basename args.
    expect(await screen.findByText("Activity")).toBeTruthy();
    expect(screen.getByText("write_file")).toBeTruthy();
    // The basename renders in the tool row AND in the Files manifest.
    expect(screen.getAllByText("fix.ts").length).toBe(2);
    expect(screen.getByText("run_command")).toBeTruthy();
    // The finished tool's summary shows through (ok row)…
    expect(screen.getByText("wrote 42 lines")).toBeTruthy();

    // Header status chip = running.
    expect(screen.getByTestId("subagent-status-chip").textContent).toContain("running");
  });

  it("shows the Files card with the manifest + count, clamped to 5 with show-all", async () => {
    const events: SessionEvent[] = [
      ev(1, "message.user", { role: "user", content: "touch some files" }),
      ...Array.from({ length: 7 }, (_, i) =>
        ev(i + 2, "tool.use", { toolName: "write_file", argsSummary: `src/mod/file${i}.ts`, ok: true }),
      ),
    ];
    vi.mocked(fetchSubAgentDetail).mockResolvedValue(detail("running", events));
    renderWithProviders(<SubAgentPanel tab={tab} />);

    expect(await screen.findByText("Files")).toBeTruthy();
    // Count badge = 7 (scoped to the Files card — the Activity badge also
    // counts 7 tool rows); only 5 rows visible until expanded.
    const filesCard = document.querySelector('[data-phase="files"]');
    expect(filesCard?.textContent).toContain("7");
    expect(filesCard?.textContent).toContain("file0.ts");
    expect(filesCard?.textContent).toContain("file4.ts");
    expect(filesCard?.textContent).not.toContain("file5.ts");
    fireEvent.click(screen.getByRole("button", { name: /show all 7 files/i }));
    expect(document.querySelector('[data-phase="files"]')?.textContent).toContain("file6.ts");
  });

  it("failed child → explicit banner with the error reason + Retry primary action", async () => {
    vi.mocked(fetchSubAgentDetail).mockResolvedValue(
      detail("failed", [
        ev(1, "message.user", { role: "user", content: "do the thing" }),
        ev(2, "tool.use", { toolName: "run_command", argsSummary: "pnpm build", ok: false, outputSummary: "exit 1" }),
      ]),
    );
    vi.mocked(fetchSubAgents).mockResolvedValue([
      {
        id: "child-1",
        title: "Refactor auth module",
        subRole: "coder",
        status: "failed",
        createdAt: now(),
        updatedAt: now(),
        todosDone: 0,
        todosTotal: 0,
        inputTokens: 0,
        outputTokens: 0,
        report: null,
        error: "provider 'openrouter' call failed: 429 rate limited",
      },
    ]);
    renderWithProviders(<SubAgentPanel tab={tab} />);

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("Sub-agent failed")).toBeTruthy();
    expect(screen.getByText(/429 rate limited/)).toBeTruthy();
    expect(screen.getByTestId("subagent-status-chip").textContent).toContain("failed");

    // Retry = the existing endpoint, wired to (parent, child).
    fireEvent.click(screen.getByRole("button", { name: "Retry sub-agent" }));
    await waitFor(() => expect(retrySubAgent).toHaveBeenCalledWith("parent-1", "child-1"));
  });

  it("completed child → Final report card, and the report is not duplicated in Activity", async () => {
    vi.mocked(fetchSubAgentDetail).mockResolvedValue(
      detail("completed", [
        ev(1, "message.user", { role: "user", content: "summarize the change" }),
        ev(2, "tool.use", { toolName: "read_file", argsSummary: "src/auth/fix.ts", ok: true, outputSummary: null }),
        ev(3, "message.assistant", { role: "assistant", content: "Reading the files now." }),
        ev(4, "message.assistant", { role: "assistant", content: "Done — auth split into 3 modules, all tests green." }),
      ]),
    );
    renderWithProviders(<SubAgentPanel tab={tab} />);

    expect(await screen.findByText("Final report")).toBeTruthy();
    expect(screen.getByText("Done — auth split into 3 modules, all tests green.")).toBeTruthy();
    // The last assistant message IS the report — Activity keeps the earlier
    // narration but not the duplicated final answer.
    expect(screen.getByText("Reading the files now.")).toBeTruthy();
    expect(
      screen.getAllByText("Done — auth split into 3 modules, all tests green.").length,
    ).toBe(1);
    expect(screen.getByTestId("subagent-status-chip").textContent).toContain("done");
  });

  it("initial load shows the single spinner state (no phase cards yet)", async () => {
    vi.mocked(fetchSubAgentDetail).mockReturnValue(new Promise<SessionDetail>(() => {}));
    renderWithProviders(<SubAgentPanel tab={tab} />);
    expect(await screen.findByText("Loading sub-agent…")).toBeTruthy();
    expect(screen.queryByText("Task")).toBeNull();
  });

  it("unbound tab → the empty message", () => {
    renderWithProviders(
      <SubAgentPanel
        tab={{ ...tab, subAgentId: undefined, parentSessionId: undefined }}
      />,
    );
    expect(screen.getByText("No sub-agent bound to this tab.")).toBeTruthy();
  });
});
