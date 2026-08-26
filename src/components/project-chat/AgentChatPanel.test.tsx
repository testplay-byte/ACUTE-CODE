// @vitest-environment happy-dom
/**
 * ROUND-43 frontend tests — chat layout contract + the per-send model
 * picker's free-only filter (owner: "a lot of empty space on the right side
 * of the chat window… a scroll bar at the bottom" + "the maximum width…
 * gets restricted" + the free-models-only default directive).
 *
 * The api module is mocked at the BACKEND-SELECTOR level: live mode
 * (demoData=false, which enables the composer's model picker) still serves
 * the in-memory fixture adapters, and fetchProviderModels returns a
 * controlled free/paid mix.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { AgentChatPanel } from "./AgentChatPanel";
import { getFixtureProjects } from "../../lib/project-fixtures";
import { useConfigStore } from "../../lib/config-store";
import { useSettingsStore } from "../../lib/settings-store";
import { renderWithProviders, resetTestState } from "../../test-utils";

const MODELS = [
  "z-ai/glm-5.2:free",
  "openrouter/ox-alpha", // paid (the retired dead id — a known non-free id)
  "minimax/minimax-m3:free",
  "openrouter/gpt-5.2", // paid
];

vi.mock("../../lib/api", async () => {
  const mod = await import("../../lib/api");
  const agentsFx = await import("../../lib/agent-fixtures");
  const sessionsFx = await import("../../lib/session-fixtures");
  return {
    ...mod,
    getAgentsBackend: () => agentsFx.getFixtureAgents(),
    getSessionsBackend: () => sessionsFx.getFixtureSessions(),
    fetchProviderModels: vi.fn(async () => [...MODELS]),
  };
});

afterEach(cleanup);

beforeEach(() => {
  resetTestState();
  // Live mode so the composer footer's model picker is enabled; the api mock
  // above keeps every query on the offline fixture adapters.
  useConfigStore.setState({ demoData: false });
  useSettingsStore.setState({ modelsFreeOnly: true });
});

async function renderPanel() {
  const projects = await getFixtureProjects().list();
  renderWithProviders(<AgentChatPanel projectId={projects[0].id} project={projects[0]} />);
}

describe("AgentChatPanel layout contract (Round 43)", () => {
  it("panel root FILLS its column (w-full) — the shrink-to-fit dead-space bug", async () => {
    await renderPanel();
    const root = Array.from(document.querySelectorAll("div")).find((el) =>
      el.className.includes("rounded-[16px]"),
    );
    expect(root).toBeTruthy();
    expect(root?.className).toContain("w-full");
    expect(root?.className).toContain("min-w-0");
  });

  it("the message scroller pins overflow-x hidden — no bottom horizontal scrollbar", async () => {
    await renderPanel();
    const scroller = document.querySelector('div[class*="overflow-y-auto"][class*="overflow-x-hidden"]');
    expect(scroller).not.toBeNull();
  });

  it("reading column is capped + centered, and the composer shares the SAME column", async () => {
    await renderPanel();
    const cols = Array.from(document.querySelectorAll("div")).filter((el) =>
      el.className.includes("max-w-[1080px]"),
    );
    expect(cols.length).toBeGreaterThanOrEqual(2); // messages + composer
    for (const col of cols) {
      expect(col.className).toContain("mx-auto");
      expect(col.className).toContain("w-full");
    }
  });
});

describe("ComposerFooter model picker — free-only filter (Round 43)", () => {
  async function openPicker() {
    fireEvent.click(screen.getByRole("button", { name: "Choose model" }));
    await waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy());
  }

  it("lists only free models by default (persisted modelsFreeOnly=true)", async () => {
    await renderPanel();
    await openPicker();
    // The models query resolves async — wait for the free-only list.
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(2));

    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["z-ai/glm-5.2:free", "minimax/minimax-m3:free"]);

    // The inline escape hatch: segmented Free-only/All control, in the picker.
    const group = screen.getByRole("group", { name: "Model filter" });
    expect(group).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Free only" }) as HTMLElement).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      (screen.getByRole("button", { name: "All" }) as HTMLElement).getAttribute("aria-pressed"),
    ).toBe("false");

    // Subtle affordance: hidden paid models are counted + one click away.
    expect(screen.getByText(/2 paid models hidden — show all/i)).toBeTruthy();
  });

  it("the inline toggle flips the SHARED persisted preference and reveals all models", async () => {
    await renderPanel();
    await openPicker();

    fireEvent.click(screen.getByRole("button", { name: "All" }));

    await waitFor(() => {
      expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(MODELS);
    });
    // Same store the Settings → Providers list reads — both stay in sync.
    expect(useSettingsStore.getState().modelsFreeOnly).toBe(false);
    // No "hidden" hint while everything is shown.
    expect(screen.queryByText(/paid models hidden/i)).toBeNull();
  });

  it("'show all' escape-hint row flips the same preference", async () => {
    await renderPanel();
    await openPicker();
    await waitFor(() => expect(screen.getByText(/2 paid models hidden — show all/i)).toBeTruthy());

    fireEvent.click(screen.getByText(/2 paid models hidden — show all/i));
    await waitFor(() => {
      expect(useSettingsStore.getState().modelsFreeOnly).toBe(false);
    });
    await waitFor(() => {
      expect(screen.getAllByRole("option").length).toBe(4);
    });
  });

  it("picking a model selects it as the per-send override", async () => {
    await renderPanel();
    await openPicker();
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(2));

    fireEvent.click(screen.getByRole("option", { name: "minimax/minimax-m3:free" }));

    // The footer button now shows the override (agent fixture model is
    // openrouter/ox-alpha, so the label change proves the override landed).
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /choose model/i }).textContent).toContain(
        "minimax/minimax-m3:free",
      );
    });
  });
});
