// @vitest-environment happy-dom
/**
 * ROUND-43 frontend tests — chat layout contract. (The per-send model
 * picker's free-only filter tests that lived here were REPLACED in ROUND-50
 * by src/components/project-chat/composer/Composer.test.tsx — the old flat
 * ComposerFooter list became the provider popover + hover flyout; its
 * ctx-meter duty moved into the context donut. Kept honestly: this file now
 * covers the layout contract + the R44-c revert flow only.)
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
import type { MessageRating, SessionEvent, SessionsBackend } from "../../lib/api";
import { useConfigStore } from "../../lib/config-store";
import { useNotificationStreamStore } from "../../hooks/use-notifications";
import { useSettingsStore } from "../../lib/settings-store";
import { useStreamStore } from "../../lib/stream-store";
import { renderWithProviders, resetTestState } from "../../test-utils";

/** ROUND-44 (R44-c): per-test override for getSessionsBackend(). */
const customBackend = vi.hoisted((): { backend: SessionsBackend | null } => ({
  backend: null,
}));

/** ROUND-59 (R59-D): the ratings client fns, mocked (the api module mock
 * below installs them). The holder lets tests assert/program them. */
const ratingsMock = vi.hoisted(() => ({
  rateReply: null as unknown as ReturnType<typeof vi.fn>,
  listSessionRatings: null as unknown as ReturnType<typeof vi.fn>,
  deleteRating: null as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock("../../lib/api", async () => {
  const mod = await import("../../lib/api");
  const agentsFx = await import("../../lib/agent-fixtures");
  const sessionsFx = await import("../../lib/session-fixtures");
  ratingsMock.rateReply = vi.fn();
  ratingsMock.listSessionRatings = vi.fn();
  ratingsMock.deleteRating = vi.fn();
  return {
    ...mod,
    getAgentsBackend: () => agentsFx.getFixtureAgents(),
    getSessionsBackend: () => customBackend.backend ?? sessionsFx.getFixtureSessions(),
    rateReply: ratingsMock.rateReply,
    listSessionRatings: ratingsMock.listSessionRatings,
    deleteRating: ratingsMock.deleteRating,
  };
});

afterEach(cleanup);

beforeEach(() => {
  resetTestState();
  // Live mode so the composer's backend-backed controls are enabled; the api
  // mock above keeps every query on the offline fixture adapters.
  useConfigStore.setState({ demoData: false });
  useSettingsStore.setState({ modelsFreeOnly: true });
  customBackend.backend = null;
  useNotificationStreamStore.getState().reset();
  // ROUND-59 (R59-D): the ratings client starts empty (each test programs it).
  // rateReply defaults to a resolved undefined — the component only chains
  // .then/.catch, and a test that forgets to program it should not crash on
  // `undefined.then`.
  ratingsMock.rateReply.mockReset();
  ratingsMock.listSessionRatings.mockReset();
  ratingsMock.deleteRating.mockReset();
  ratingsMock.listSessionRatings.mockResolvedValue([]);
  ratingsMock.rateReply.mockResolvedValue(undefined);
  ratingsMock.deleteRating.mockResolvedValue(undefined);
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

// ── ROUND-58 (R58-cf): the deliberate user stop renders a QUIET status card ──
describe("AgentChatPanel user-stop rendering (ROUND-58 R58-cf)", () => {
  const SLOW = { timeout: 5000 };

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

  /** A conversation whose last turn was user-stopped (the store carries the
   * post-clear signal: flag + ts, live turn handed to the folded log). */
  async function renderStoppedConversation(stoppedByUser: boolean): Promise<void> {
    const projects = await getFixtureProjects().list();
    customBackend.backend = createFixtureSessions([
      {
        session: {
          id: "sess_stop_card",
          projectId: projects[0].id,
          agentId: "agt_scribe",
          mode: "single",
          status: "completed",
          title: "Stop card probe",
          createdAt: "2026-08-31T11:00:00Z",
          updatedAt: "2026-08-31T11:05:00Z",
        },
        events: [
          messageEvent(1, "user", "write me a file", "2026-08-31T11:00:10Z"),
          // The backend's flushed partial (the stopped turn's reply so far).
          messageEvent(2, "assistant", "Here is the beginning of the work", "2026-08-31T11:00:20Z"),
        ],
      },
    ]);
    renderWithProviders(<AgentChatPanel projectId={projects[0].id} project={projects[0]} />);
    await screen.findByText("write me a file", {}, SLOW);
    useStreamStore.setState({
      bySession: {
        sess_stop_card: {
          liveTurn: null,
          streamBusy: false,
          sendError: null,
          liveError: null,
          pendingEcho: null,
          lastLiveEndMs: Date.now(),
          lastTurnStoppedByUser: stoppedByUser,
          lastTurnStoppedTs: stoppedByUser ? "2026-08-31T11:00:25Z" : null,
        },
      },
    });
  }

  it("renders the quiet 'Stopped by user' card under the persisted partial — never TurnErrorCard", async () => {
    await renderStoppedConversation(true);

    const card = await waitFor(() => {
      const el = document.querySelector("[data-stopped-card]") as HTMLElement;
      expect(el).toBeTruthy();
      return el;
    });
    expect(card.textContent).toContain("Stopped by user");
    // A quiet STATUS, not an alert: no role=alert, no "Generation failed".
    expect(card.getAttribute("role")).toBe("status");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Generation failed")).toBeNull();
    // The flushed partial stays visible above the card (RichText tokenizes
    // the answer into word spans — assert on one token).
    expect(screen.getByText("beginning")).toBeTruthy();
  });

  it("NO stopped card on a normal (not user-stopped) transcript", async () => {
    await renderStoppedConversation(false);
    expect(document.querySelector("[data-stopped-card]")).toBeNull();
  });
});

// ── ROUND-59 (R59-D): the response-rating cluster ───────────────────────────
describe("AgentChatPanel response ratings (ROUND-59 R59-D)", () => {
  const SLOW = { timeout: 5000 };

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

  function toolUseEvent(seq: number): SessionEvent {
    return {
      seq,
      type: "tool.use",
      agentId: "agt_scribe",
      payload: {
        role: "tool",
        toolName: "read_file",
        argsSummary: "path: a.ts",
        ok: true,
        agentId: "agt_scribe",
        ts: "2026-09-01T10:00:00Z",
      },
      ts: "2026-09-01T10:00:00Z",
    };
  }

  /**
   * One text turn (user q1 → assistant a1, rating key = seq 2) plus a
   * WORKING-ONLY turn (user q2 → one tool call, no assistant text — no
   * rating key, nothing to rate). `beforeRender` programs the ratings mock
   * BEFORE the first mount (React Query caches the initial fetch — a mock
   * set after render would never be seen without a refetch).
   */
  async function renderRatableConversation(beforeRender?: () => void): Promise<void> {
    const projects = await getFixtureProjects().list();
    customBackend.backend = createFixtureSessions([
      {
        session: {
          id: "sess_rate_probe",
          projectId: projects[0].id,
          agentId: "agt_scribe",
          mode: "single",
          status: "completed",
          title: "Rate probe",
          createdAt: "2026-09-01T10:00:00Z",
          updatedAt: "2026-09-01T10:05:00Z",
        },
        events: [
          messageEvent(1, "user", "first question", "2026-09-01T10:00:10Z"),
          messageEvent(2, "assistant", "first answer", "2026-09-01T10:00:20Z"),
          messageEvent(3, "user", "second question", "2026-09-01T10:01:00Z"),
          toolUseEvent(4),
        ],
      },
    ]);
    beforeRender?.();
    renderWithProviders(
      <AgentChatPanel projectId={projects[0].id} project={projects[0]} />,
    );
    await screen.findByText("first question", {}, SLOW);
  }

  it("renders the rating cluster on text-bearing turns ONLY (working-only turns have no key)", async () => {
    await renderRatableConversation();

    // Exactly ONE cluster: the turn whose last non-empty assistant text is
    // seq 2. The tool-only turn (seq 4) carries no rating key.
    const clusters = document.querySelectorAll("[data-rating-cluster]");
    expect(clusters).toHaveLength(1);
    const good = screen.getByTestId("rate-good");
    const bad = screen.getByTestId("rate-bad");
    expect(good.getAttribute("aria-pressed")).toBe("false");
    expect(bad.getAttribute("aria-pressed")).toBe("false");
    // Unrated cluster reveals on hover (opacity-0 until the turn is rated).
    expect(clusters[0].className).toContain("opacity-0");
  });

  it("thumbs up → rateReply(sessionId, {assistantSeq, rating:'good'}) + optimistic fill", async () => {
    await renderRatableConversation();
    const persisted: MessageRating[] = [];
    ratingsMock.rateReply.mockImplementation(async (_sid, input) => {
      const row: MessageRating = {
        id: 11,
        sessionId: "sess_rate_probe",
        assistantSeq: input.assistantSeq,
        rating: input.rating,
        note: input.note ?? null,
        model: null,
        agentId: "agt_scribe",
        createdAt: "2026-09-01T10:06:00Z",
        updatedAt: "2026-09-01T10:06:00Z",
      };
      persisted.push(row);
      return row;
    });
    ratingsMock.listSessionRatings.mockImplementation(async () => persisted);

    fireEvent.click(screen.getByTestId("rate-good"));

    await waitFor(
      () =>
        expect(ratingsMock.rateReply).toHaveBeenCalledWith("sess_rate_probe", {
          assistantSeq: 2,
          rating: "good",
        }),
      SLOW,
    );
    // Optimistic fill: the good thumb renders pressed.
    await waitFor(
      () => expect(screen.getByTestId("rate-good").getAttribute("aria-pressed")).toBe("true"),
      SLOW,
    );
    // Good ratings stay one-click: no note editor opens.
    expect(document.querySelector("[data-rating-note]")).toBeNull();
  });

  it("thumbs down opens the note editor; Save sends the note (re-rate upsert)", async () => {
    await renderRatableConversation();
    const persisted: MessageRating[] = [];
    ratingsMock.rateReply.mockImplementation(async (_sid, input) => {
      const row: MessageRating = {
        id: 12,
        sessionId: "sess_rate_probe",
        assistantSeq: input.assistantSeq,
        rating: input.rating,
        note: input.note ?? null,
        model: null,
        agentId: "agt_scribe",
        createdAt: "2026-09-01T10:06:00Z",
        updatedAt: "2026-09-01T10:06:00Z",
      };
      const existing = persisted.findIndex((r) => r.assistantSeq === row.assistantSeq);
      if (existing >= 0) persisted[existing] = row;
      else persisted.push(row);
      return row;
    });
    ratingsMock.listSessionRatings.mockImplementation(async () => persisted);

    fireEvent.click(screen.getByTestId("rate-bad"));
    await waitFor(
      () =>
        expect(ratingsMock.rateReply).toHaveBeenCalledWith("sess_rate_probe", {
          assistantSeq: 2,
          rating: "bad",
        }),
      SLOW,
    );

    // The "What went wrong?" editor unfolds under the actions row.
    const input = await screen.findByTestId("rating-note-input", {}, SLOW);
    expect(input.getAttribute("placeholder")).toBe("What went wrong?");
    fireEvent.change(input, { target: { value: "it edited the wrong file" } });
    fireEvent.click(screen.getByTestId("rating-note-save"));

    // The note travels on the re-rate call.
    await waitFor(
      () =>
        expect(ratingsMock.rateReply).toHaveBeenLastCalledWith("sess_rate_probe", {
          assistantSeq: 2,
          rating: "bad",
          note: "it edited the wrong file",
        }),
      SLOW,
    );
    // Saved → the editor closes.
    await waitFor(
      () => expect(document.querySelector("[data-rating-note]")).toBeNull(),
      SLOW,
    );
  });

  it("clicking the SAME thumb on a persisted verdict → deleteRating(id) + optimistic unfill", async () => {
    // Stateful mock (mirrors the real backend): delete removes the row, so
    // the post-mutation refetch settles on the UNFILLED state.
    const row: MessageRating = {
      id: 5,
      sessionId: "sess_rate_probe",
      assistantSeq: 2,
      rating: "good",
      note: null,
      model: null,
      agentId: "agt_scribe",
      createdAt: "2026-09-01T10:00:00Z",
      updatedAt: "2026-09-01T10:00:00Z",
    };
    let rows: MessageRating[] = [row];
    await renderRatableConversation(() => {
      ratingsMock.listSessionRatings.mockImplementation(async () => rows);
      ratingsMock.deleteRating.mockImplementation(async (id: number) => {
        rows = rows.filter((r) => r.id !== id);
      });
    });

    // The persisted verdict renders FILLED, persistently (no hover gate).
    const good = await waitFor(() => {
      const el = screen.getByTestId("rate-good");
      expect(el.getAttribute("aria-pressed")).toBe("true");
      return el;
    }, SLOW);
    expect(good.closest("[data-rating-cluster]")?.className).not.toContain("opacity-0");

    // Same thumb again → clear.
    fireEvent.click(good);
    await waitFor(() => expect(ratingsMock.deleteRating).toHaveBeenCalledWith(5), SLOW);
    await waitFor(
      () => expect(screen.getByTestId("rate-good").getAttribute("aria-pressed")).toBe("false"),
      SLOW,
    );
  }, 15_000);

  it("a failed rating REVERTS the optimistic fill and shows an honest inline transient message (no alert)", async () => {
    await renderRatableConversation();
    ratingsMock.rateReply.mockRejectedValue(new Error("sidecar unreachable (rating lost)"));
    ratingsMock.listSessionRatings.mockImplementation(async () => []);

    fireEvent.click(screen.getByTestId("rate-good"));

    // Revert: the thumb never stays filled.
    await waitFor(
      () => expect(screen.getByTestId("rate-good").getAttribute("aria-pressed")).toBe("false"),
      SLOW,
    );
    // The honest inline error line (role=alert, NOT window.alert).
    const error = await screen.findByText(/sidecar unreachable/, {}, SLOW);
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.closest("[data-rating-error]")).toBeTruthy();
  });

  it("loaded ratings render the filled thumb persistently and SURVIVE a reload (fresh mount + refetch)", async () => {
    const projects = await getFixtureProjects().list();
    const rows: MessageRating[] = [
      {
        id: 9,
        sessionId: "sess_rate_probe",
        assistantSeq: 2,
        rating: "bad",
        note: "wrong file",
        model: null,
        agentId: "agt_scribe",
        createdAt: "2026-09-01T10:00:00Z",
        updatedAt: "2026-09-01T10:00:00Z",
      },
    ];
    ratingsMock.listSessionRatings.mockResolvedValue(rows);
    const backend = createFixtureSessions([
      {
        session: {
          id: "sess_rate_probe",
          projectId: projects[0].id,
          agentId: "agt_scribe",
          mode: "single",
          status: "completed",
          title: "Rate probe",
          createdAt: "2026-09-01T10:00:00Z",
          updatedAt: "2026-09-01T10:05:00Z",
        },
        events: [
          messageEvent(1, "user", "first question", "2026-09-01T10:00:10Z"),
          messageEvent(2, "assistant", "first answer", "2026-09-01T10:00:20Z"),
        ],
      },
    ]);
    customBackend.backend = backend;

    renderWithProviders(
      <AgentChatPanel projectId={projects[0].id} project={projects[0]} />,
    );
    await screen.findByText("first question", {}, SLOW);
    const bad = await waitFor(() => {
      const el = screen.getByTestId("rate-bad");
      expect(el.getAttribute("aria-pressed")).toBe("true");
      return el;
    }, SLOW);
    expect(bad.closest("[data-rating-cluster]")?.className).not.toContain("opacity-0");
    void backend;

    // Reload: unmount, fresh mount (fresh QueryClient → fresh listSessionRatings).
    cleanup();
    renderWithProviders(
      <AgentChatPanel projectId={projects[0].id} project={projects[0]} />,
    );
    await screen.findByText("first question", {}, SLOW);
    await waitFor(
      () => expect(screen.getByTestId("rate-bad").getAttribute("aria-pressed")).toBe("true"),
      SLOW,
    );
  });

  it("LIVE-completed turn: the done-frame seq (LiveTurn.lastAssistantSeq) renders the cluster", async () => {
    const projects = await getFixtureProjects().list();
    // A stateful persisted row mirrors the real backend for the live rating.
    const persisted: MessageRating[] = [];
    ratingsMock.rateReply.mockImplementation(async (_sid, input) => {
      persisted.push({
        id: 21,
        sessionId: "sess_live_rate",
        assistantSeq: input.assistantSeq,
        rating: input.rating,
        note: input.note ?? null,
        model: null,
        agentId: "agt_scribe",
        createdAt: "2026-09-01T11:06:00Z",
        updatedAt: "2026-09-01T11:06:00Z",
      });
      return persisted[0];
    });
    ratingsMock.listSessionRatings.mockImplementation(async () => persisted);
    // An EMPTY folded log — only the live turn renders, so the cluster count
    // is unambiguous.
    customBackend.backend = createFixtureSessions([
      {
        session: {
          id: "sess_live_rate",
          projectId: projects[0].id,
          agentId: "agt_scribe",
          mode: "single",
          status: "completed",
          title: "Live rate",
          createdAt: "2026-09-01T11:00:00Z",
          updatedAt: "2026-09-01T11:05:00Z",
        },
        events: [],
      },
    ]);
    renderWithProviders(
      <AgentChatPanel projectId={projects[0].id} project={projects[0]} />,
    );
    // EMPTY folded log → the centered empty state (composer NOT docked).
    await waitFor(
      () => expect(document.querySelector("[data-empty-state]")).toBeTruthy(),
      SLOW,
    );

    // The stream store's live turn completed: the done frame pinned seq 6.
    useStreamStore.setState({
      bySession: {
        sess_live_rate: {
          liveTurn: {
            startedAtMs: Date.now() - 3000,
            working: [],
            streamText: "live reply",
            streamThinking: "",
            stopped: false,
            stoppedByUser: false,
            streamingToolInputs: [],
            lastAssistantSeq: 6,
          },
          streamBusy: false,
          sendError: null,
          liveError: null,
          pendingEcho: null,
          lastLiveEndMs: Date.now(),
          lastTurnStoppedByUser: false,
          lastTurnStoppedTs: null,
        },
      },
    });

    const cluster = await waitFor(() => {
      const el = document.querySelector("[data-rating-cluster]");
      expect(el).toBeTruthy();
      return el as HTMLElement;
    }, SLOW);
    void cluster;
    fireEvent.click(screen.getByTestId("rate-good"));
    await waitFor(
      () =>
        expect(ratingsMock.rateReply).toHaveBeenCalledWith("sess_live_rate", {
          assistantSeq: 6,
          rating: "good",
        }),
      SLOW,
    );
  }, 15_000);
});
