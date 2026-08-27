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
 *
 * ROUND-44 (R44-c) additions: the revert-to-message flow. A CUSTOM fixture
 * backend (session seeded into the first project) rides in via the hoisted
 * `customBackend` holder so the panel renders a deterministic conversation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { AgentChatPanel } from "./AgentChatPanel";
import { getFixtureProjects } from "../../lib/project-fixtures";
import { createFixtureSessions } from "../../lib/session-fixtures";
import type { SessionEvent, SessionsBackend } from "../../lib/api";
import { useConfigStore } from "../../lib/config-store";
import { useNotificationStreamStore } from "../../hooks/use-notifications";
import { useSettingsStore } from "../../lib/settings-store";
import { renderWithProviders, resetTestState } from "../../test-utils";

const MODELS = [
  "z-ai/glm-5.2:free",
  "openrouter/ox-alpha", // paid (the retired dead id — a known non-free id)
  "minimax/minimax-m3:free",
  "openrouter/gpt-5.2", // paid
];

/** ROUND-44 (R44-c): per-test override for getSessionsBackend(). */
const customBackend = vi.hoisted((): { backend: SessionsBackend | null } => ({
  backend: null,
}));

vi.mock("../../lib/api", async () => {
  const mod = await import("../../lib/api");
  const agentsFx = await import("../../lib/agent-fixtures");
  const sessionsFx = await import("../../lib/session-fixtures");
  return {
    ...mod,
    getAgentsBackend: () => agentsFx.getFixtureAgents(),
    getSessionsBackend: () => customBackend.backend ?? sessionsFx.getFixtureSessions(),
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
  customBackend.backend = null;
  useNotificationStreamStore.getState().reset();
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

// ── ROUND-44 (R44-c): revert-to-message ─────────────────────────────────────
describe("AgentChatPanel revert-to-message (ROUND-44 R44-c)", () => {
  const SLOW = { timeout: 5000 };

  /** Chat event exactly as the backend writes it (payload mirrors agentId + ts). */
  function messageEvent(
    seq: number,
    role: "user" | "assistant",
    content: string,
    ts: string,
  ): SessionEvent {
    return {
      seq,
      type: role === "user" ? "message.user" : "message.assistant",
      agentId: "agt_scribe",
      payload: { role, content, agentId: "agt_scribe", ts },
      ts,
    };
  }

  /** A deterministic two-turn conversation bound to the first fixture project. */
  async function renderPanelWithConversation(): Promise<SessionsBackend> {
    const projects = await getFixtureProjects().list();
    const backend = createFixtureSessions([
      {
        session: {
          id: "sess_revert_probe",
          projectId: projects[0].id,
          agentId: "agt_scribe",
          mode: "single",
          status: "completed",
          title: "Revert probe",
          createdAt: "2026-08-26T10:00:00Z",
          updatedAt: "2026-08-26T10:05:00Z",
        },
        events: [
          messageEvent(1, "user", "first question about the parser", "2026-08-26T10:00:10Z"),
          messageEvent(2, "assistant", "first answer", "2026-08-26T10:00:20Z"),
          messageEvent(3, "user", "second question", "2026-08-26T10:01:00Z"),
          messageEvent(4, "assistant", "second answer", "2026-08-26T10:01:30Z"),
        ],
      },
    ]);
    customBackend.backend = backend;
    renderWithProviders(
      <AgentChatPanel projectId={projects[0].id} project={projects[0]} />,
    );
    return backend;
  }

  it("user messages carry a Revert action (assistant turns do not)", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question about the parser", {}, SLOW)).toBeTruthy();

    // Exactly TWO revert buttons — one per persisted user bubble (seq 1 + 3).
    const revertButtons = screen.getAllByRole("button", { name: "Revert to this message" });
    expect(revertButtons).toHaveLength(2);
  });

  it("confirm flow: dialog shows the target snippet, confirm calls revertSession with the right seq, log truncates, toast lands", async () => {
    const backend = await renderPanelWithConversation();
    const revertSpy = vi.spyOn(backend, "revert");
    expect(await screen.findByText("first question about the parser", {}, SLOW)).toBeTruthy();

    // Hover action on the FIRST user message → the destructive confirm.
    fireEvent.click(screen.getAllByRole("button", { name: "Revert to this message" })[0]);

    // The dialog quotes the targeted message and warns it cannot be undone.
    expect(await screen.findByText("Revert session?", {}, SLOW)).toBeTruthy();
    const body = screen.getByText(/Removes the reply and everything after/);
    expect(body.textContent).toContain("first question about the parser");
    expect(body.textContent).toContain("This cannot be undone.");

    // Confirm → revertSession(sessionId, seq of that user message event).
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));
    await waitFor(() => expect(revertSpy).toHaveBeenCalledWith("sess_revert_probe", 1), SLOW);

    // The refetched log drops everything after seq 1: both replies + the
    // second turn are gone; the targeted user message SURVIVES. (Assistant
    // text renders as per-word RichText spans, so assert on body text.)
    await waitFor(() => {
      expect(document.body.textContent).not.toContain("first answer");
      expect(document.body.textContent).not.toContain("second question");
      expect(document.body.textContent).not.toContain("second answer");
    }, SLOW);
    expect(document.body.textContent).toContain("first question about the parser");

    // Success toast (Toaster lives in AppShell — assert the stream store).
    await waitFor(
      () =>
        expect(useNotificationStreamStore.getState().lastNotification?.title).toBe("Reverted"),
      SLOW,
    );
  });

  it("cancel keeps the conversation untouched", async () => {
    const backend = await renderPanelWithConversation();
    const revertSpy = vi.spyOn(backend, "revert");
    expect(await screen.findByText("first question about the parser", {}, SLOW)).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "Revert to this message" })[0]);
    expect(await screen.findByText("Revert session?", {}, SLOW)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByText("Revert session?")).toBeNull(), SLOW);
    expect(revertSpy).not.toHaveBeenCalled();
    // Assistant text renders as per-word spans — assert on body text.
    expect(document.body.textContent).toContain("second answer");
  });
});
