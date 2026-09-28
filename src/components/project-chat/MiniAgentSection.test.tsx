// @vitest-environment happy-dom
//
// ROUND-132 (R132-MA-ui): the MINI AGENT section's RENDER + FOLD pins —
// the owner's centerpiece directive ("a dedicated section for it will
// appear, and its actions will be shown in there. And the prompt given to
// it by the main agent will also be shown there, and it will be handled
// just like a tool call, but a mini agent tool call").
//
// What this suite pins:
//   1. THE FOLD — toProjectChatItems rebuilds the {type:"mini"} working
//      entry from the persisted mini_agent.* events (started opens at its
//      dispatch position, actions append in order, done terminalizes;
//      concurrent minis are sibling entries; an orphaned action/done is
//      dropped honestly).
//   2. THE RENDER — MiniAgentSection shows the skill badge, THE PROMPT the
//      main agent gave, the action rows (ok/fail), the terminal report +
//      the steps/token footer, and the honest failure state.
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { toProjectChatItems, type MiniAgentRun, type SessionEvent } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { MiniAgentSection } from "./MiniAgentSection";

afterEach(cleanup);

/* ── 1. THE FOLD ─────────────────────────────────────────────────────────── */

describe("R132-MA-ui: the mini runs fold from their persisted events", () => {
  const started = (miniId: string, ts: string): SessionEvent => ({
    seq: 10,
    type: "mini_agent.started",
    agentId: "ag1",
    payload: {
      miniId,
      skill: "browser",
      task: "find the docs page and report its URL",
      model: { providerId: "openrouter", modelId: "z-ai/glm-4.7-flash" },
    },
    ts,
  });
  const action = (miniId: string, seq: number): SessionEvent => ({
    seq: 11 + seq,
    type: "mini_agent.action",
    agentId: "ag1",
    payload: {
      miniId,
      seq,
      tool: "browser_control",
      argsSummary: `action: navigate, url: https://docs.example.com/${seq}`,
      ok: seq !== 2,
      outputSummary: seq === 2 ? null : `loaded (${seq})`,
    },
    ts: "2026-09-28T10:00:01.000Z",
  });
  const done = (miniId: string, ok: boolean): SessionEvent => ({
    seq: 30,
    type: "mini_agent.done",
    agentId: "ag1",
    payload: {
      miniId,
      ok,
      result: ok ? "## REPORT\nOUTCOME: done — the docs page is live" : "the mini agent (browser) failed: provider 502",
      steps: 2,
      usage: ok ? { inputTokens: 1840, outputTokens: 96 } : null,
    },
    ts: "2026-09-28T10:00:02.000Z",
  });

  it("started opens the section, actions append in order, done terminalizes — one {type:\"mini\"} entry", () => {
    const items = toProjectChatItems([
      started("mini-a", "2026-09-28T10:00:00.000Z"),
      action("mini-a", 1),
      action("mini-a", 2),
      done("mini-a", true),
    ]);
    const minis = items.flatMap((item) =>
      item.kind === "turn" ? item.working.filter((e) => e.type === "mini") : [],
    );
    expect(minis).toHaveLength(1);
    const run = minis[0]?.type === "mini" ? minis[0].run : null;
    expect(run).toMatchObject({
      miniId: "mini-a",
      skill: "browser",
      task: "find the docs page and report its URL",
      model: { providerId: "openrouter", modelId: "z-ai/glm-4.7-flash" },
      status: "done",
      result: "## REPORT\nOUTCOME: done — the docs page is live",
      steps: 2,
      usage: { inputTokens: 1840, outputTokens: 96 },
    });
    expect(run?.actions.map((a) => [a.seq, a.ok])).toEqual([[1, true], [2, false]]);
  });

  it("concurrent minis fold as SIBLING entries (any completion order — the R128-W5 lesson)", () => {
    const items = toProjectChatItems([
      started("mini-a", "2026-09-28T10:00:00.000Z"),
      started("mini-b", "2026-09-28T10:00:00.100Z"),
      action("mini-a", 1),
      action("mini-b", 1),
      // B finishes FIRST (out of order) — the fold keeps both runs intact.
      done("mini-b", true),
      done("mini-a", false),
    ]);
    const minis = items.flatMap((item) =>
      item.kind === "turn" ? item.working.filter((e) => e.type === "mini") : [],
    );
    expect(minis).toHaveLength(2);
    const byId = new Map(
      minis
        .filter((e) => e.type === "mini")
        .map((e) => (e.type === "mini" ? [e.run.miniId, e.run] : ["", null])),
    );
    expect(byId.get("mini-a")).toMatchObject({ status: "failed" });
    expect(byId.get("mini-b")).toMatchObject({ status: "done" });
  });

  it("an orphaned action/done (no started row) is dropped honestly — never a half-built section", () => {
    const items = toProjectChatItems([
      action("mini-ghost", 1),
      done("mini-ghost", true),
    ]);
    const minis = items.flatMap((item) =>
      item.kind === "turn" ? item.working.filter((e) => e.type === "mini") : [],
    );
    expect(minis).toHaveLength(0);
  });
});

/* ── 2. THE RENDER ───────────────────────────────────────────────────────── */

describe("R132-MA-ui: the MiniAgentSection render", () => {
  const baseRun: MiniAgentRun = {
    miniId: "mini-render-1",
    skill: "browser",
    task: "find the docs page and report its URL — I need the exact link for the README",
    model: { providerId: "openrouter", modelId: "z-ai/glm-4.7-flash" },
    status: "done",
    actions: [
      { seq: 1, tool: "browser_control", argsSummary: "action: navigate, url: https://docs.example.com", ok: true, outputSummary: "loaded in 812ms" },
      { seq: 2, tool: "browser_control", argsSummary: "action: read", ok: false, outputSummary: null },
    ],
    result: "## REPORT\nOUTCOME: done — the docs page is live\nSTATE: https://docs.example.com\nDETAILS: navigated + read the page",
    steps: 2,
    usage: { inputTokens: 1840, outputTokens: 96 },
    ts: "2026-09-28T10:00:00.000Z",
  };

  it("shows the skill badge, THE PROMPT the main agent gave, the action rows, the report, and the steps/token footer", async () => {
    renderWithProviders(<MiniAgentSection run={baseRun} projectId="prj_1" />);
    const section = screen.getByTestId("mini-agent-section");
    // The skill badge + the model chip + the terminal status.
    expect(section.textContent).toContain("browser");
    expect(section.textContent).toContain("z-ai/glm-4.7-flash");
    expect(screen.getByTestId("mini-agent-status").textContent).toContain("done");
    // THE PROMPT — the owner's explicit ask: the permanent task line under
    // the header renders EVEN COLLAPSED (plus the full body copy open).
    expect(screen.getByTestId("mini-agent-task-line").textContent).toContain(
      "find the docs page and report its URL",
    );
    // Expand for the body (the terminal section mounts collapsed).
    screen.getByTestId("mini-agent-toggle").click();
    await screen.findByTestId("mini-agent-body");
    // The full prompt copy + the action rows + the report.
    expect(screen.getByTestId("mini-agent-task").textContent).toContain(
      "find the docs page and report its URL",
    );
    expect(screen.getByTestId("mini-agent-actions").textContent).toContain("browser_control");
    expect(screen.getByTestId("mini-agent-actions").textContent).toContain("navigate");
    expect(screen.getByTestId("mini-agent-result").textContent).toContain("OUTCOME: done");
    // The footer (2 steps, the token spend).
    expect(section.textContent).toContain("2 steps");
  });

  it("a RUNNING run renders expanded with the live status; a FAILED run names the honest failure", async () => {
    renderWithProviders(
      <MiniAgentSection
        run={{ ...baseRun, status: "running", result: undefined, steps: undefined, usage: undefined }}
        projectId="prj_1"
      />,
    );
    expect(screen.getByTestId("mini-agent-status").textContent).toContain("running");
    // Running mounts EXPANDED (the owner watches the work happen).
    await screen.findByTestId("mini-agent-body");

    cleanup();
    renderWithProviders(
      <MiniAgentSection
        run={{ ...baseRun, status: "failed", result: "the mini agent (browser) failed: provider 502" }}
        projectId="prj_1"
      />,
    );
    expect(screen.getByTestId("mini-agent-status").textContent).toContain("failed");
    screen.getByTestId("mini-agent-toggle").click();
    const result = await screen.findByTestId("mini-agent-result");
    expect(result.textContent).toContain("provider 502");
  });

  it("the header toggle collapses/expands the body (the folded section mounts collapsed; the manual tap wins)", async () => {
    renderWithProviders(<MiniAgentSection run={baseRun} projectId="prj_1" />);
    const toggle = screen.getByTestId("mini-agent-toggle");
    // Terminal + untouched → mounted COLLAPSED (the DebugReportCard law):
    // the body is absent; the permanent task line still speaks.
    expect(screen.queryByTestId("mini-agent-body")).toBeNull();
    expect(screen.getByTestId("mini-agent-task-line").textContent).toContain("find the docs");
    toggle.click();
    // The manual tap expands — the body + report arrive.
    await screen.findByTestId("mini-agent-body");
    expect(screen.getByTestId("mini-agent-result").textContent).toContain("OUTCOME: done");
    toggle.click();
    // The collapse animation exits the body (the framer exit leg).
    await waitFor(() => expect(screen.queryByTestId("mini-agent-body")).toBeNull());
  });
});
