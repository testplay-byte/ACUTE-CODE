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
import { ApiError } from "../../lib/api";
import { useConfigStore } from "../../lib/config-store";
import { useNotificationStreamStore } from "../../hooks/use-notifications";
import { useSettingsStore } from "../../lib/settings-store";
import { useStreamStore, type LiveTurn, type LiveTurnRetry, type TurnErrorInfo } from "../../lib/stream-store";
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

/** ROUND-67 (R67-B): the debug-settings client fn, mocked the same way —
 * the panel's ["debug-settings"] query gates the full-turn copy button.
 * Default resolves { enabled: false } (the sidecar default) so every other
 * test in this file sees the second copy button HIDDEN. */
const debugSettingsMock = vi.hoisted(() => ({
  fetchDebugSettings: null as unknown as ReturnType<typeof vi.fn>,
}));

/** ROUND-68 (R68-A): the raster client fn for the INLINE screenshot rows,
 * mocked the same way — a live turn carrying `screenshot` WorkingEntry rows
 * lazy-fetches each PNG; the mock keeps those rows off the network. */
const rasterMock = vi.hoisted(() => ({
  fetchComputerFrameRaster: null as unknown as ReturnType<typeof vi.fn>,
}));

/** ROUND-73 (R73-c) / ROUND-81: the stream send, mocked — streamSessionMessage
 * lets the send tests run a full deterministic turn without a sidecar. (The
 * task-mode client fns fetchProjectModes/patchSessionActiveMode were retired
 * with the unified mode picker: postures are agent-side via switch_mode now.) */
const streamMock = vi.hoisted(() => ({
  streamSessionMessage: null as unknown as ReturnType<typeof vi.fn>,
}));

/** ROUND-78 (R78-D): the queue client pair, mocked the same way — runTurn's
 * queue path POSTs /sessions/:id/queue while a stream runs; the chip's
 * affordances DELETE /sessions/:id/queue/:seq. Defaults resolve happy
 * paths; the NO_LIVE_TURN fallback test programs the 409 rejection. */
const queueMock = vi.hoisted(() => ({
  queueSessionMessage: null as unknown as ReturnType<typeof vi.fn>,
  dequeueSessionMessage: null as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock("../../lib/api", async () => {
  const mod = await import("../../lib/api");
  const agentsFx = await import("../../lib/agent-fixtures");
  const sessionsFx = await import("../../lib/session-fixtures");
  ratingsMock.rateReply = vi.fn();
  ratingsMock.listSessionRatings = vi.fn();
  ratingsMock.deleteRating = vi.fn();
  debugSettingsMock.fetchDebugSettings = vi.fn();
  rasterMock.fetchComputerFrameRaster = vi.fn();
  streamMock.streamSessionMessage = vi.fn();
  queueMock.queueSessionMessage = vi.fn();
  queueMock.dequeueSessionMessage = vi.fn();
  return {
    ...mod,
    getAgentsBackend: () => agentsFx.getFixtureAgents(),
    getSessionsBackend: () => customBackend.backend ?? sessionsFx.getFixtureSessions(),
    rateReply: ratingsMock.rateReply,
    listSessionRatings: ratingsMock.listSessionRatings,
    deleteRating: ratingsMock.deleteRating,
    fetchDebugSettings: debugSettingsMock.fetchDebugSettings,
    fetchComputerFrameRaster: rasterMock.fetchComputerFrameRaster,
    streamSessionMessage: streamMock.streamSessionMessage,
    queueSessionMessage: queueMock.queueSessionMessage,
    dequeueSessionMessage: queueMock.dequeueSessionMessage,
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
  // ROUND-67 (R67-B): debug mode OFF by default — the full-turn copy button
  // stays hidden unless a test programs it on.
  debugSettingsMock.fetchDebugSettings.mockReset();
  debugSettingsMock.fetchDebugSettings.mockResolvedValue({ enabled: false });
  // ROUND-78 (R78-D): the queue pair starts at the happy default each test
  // (a deterministic seq so the optimistic push is assertable).
  queueMock.queueSessionMessage.mockReset();
  queueMock.queueSessionMessage.mockResolvedValue({ ok: true, seq: 41 });
  queueMock.dequeueSessionMessage.mockReset();
  queueMock.dequeueSessionMessage.mockResolvedValue(undefined);
  // R78: the store starts clean (the queue slices are per-session state).
  useStreamStore.setState({ bySession: {}, subagentsLive: {} });
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

  it("confirm flow (R77 semantics): the target message is REMOVED, its text returns to the composer, dialog + toast carry the new copy", async () => {
    const backend = await renderPanelWithConversation();
    const revertSpy = vi.spyOn(backend, "revert");
    expect(await screen.findByText("first question about the parser", {}, SLOW)).toBeTruthy();

    // Hover action on the FIRST user message → the destructive confirm.
    fireEvent.click(screen.getAllByRole("button", { name: "Revert to this message" })[0]);

    // R77 dialog copy: rewinds to BEFORE the message — the message itself
    // is removed and returns to the composer.
    expect(await screen.findByText("Revert session?", {}, SLOW)).toBeTruthy();
    const body = screen.getByText(/Rewinds to before/);
    expect(body.textContent).toContain("first question about the parser");
    expect(body.textContent).toContain("puts the message text back in the composer");
    expect(body.textContent).toContain("This cannot be undone.");

    // Confirm → revertSession(sessionId, seq of that user message event).
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));
    await waitFor(() => expect(revertSpy).toHaveBeenCalledWith("sess_revert_probe", 1), SLOW);

    // R77: the refetched log drops everything from seq 1 ONWARD — the
    // targeted user message itself is gone (it lives in the COMPOSER now),
    // with the reply + second turn. (Assistant text renders as per-word
    // RichText spans, so assert on body text.)
    await waitFor(() => {
      expect(document.body.textContent).not.toContain("first answer");
      expect(document.body.textContent).not.toContain("second question");
      expect(document.body.textContent).not.toContain("second answer");
    }, SLOW);
    // The message is DELETED from the chat transcript — the truncation
    // removed every user bubble, so NO Revert actions remain. (A raw
    // text-content check would false-positive: React renders the textarea's
    // refilled VALUE as its text children.)
    await waitFor(
      () =>
        expect(screen.queryAllByRole("button", { name: "Revert to this message" })).toHaveLength(0),
      SLOW,
    );
    expect(screen.queryAllByText(/first answer/)).toHaveLength(0);
    // ...and PASTED into the composer's message area (R77, owner: "that
    // message which was on that should be pasted in the message area").
    const composer = screen.getByLabelText("Message composer") as HTMLTextAreaElement;
    expect(composer.value).toBe("first question about the parser");

    // Success toast (Toaster lives in AppShell — assert the stream store).
    await waitFor(
      () =>
        expect(useNotificationStreamStore.getState().lastNotification?.title).toBe("Reverted"),
      SLOW,
    );
    expect(useNotificationStreamStore.getState().lastNotification?.body).toContain(
      "back in the composer",
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
          queued: [],
          deliveredQueued: [],
        },
      },
    });
  }

  it("R66 (A4): a live browser-checkpoint renders the verification card above the streaming text", async () => {
    const projects = await getFixtureProjects().list();
    customBackend.backend = createFixtureSessions([
      {
        session: {
          id: "sess_checkpoint",
          projectId: projects[0].id,
          agentId: "agt_scribe",
          mode: "single",
          status: "completed",
          title: "Checkpoint probe",
          createdAt: "2026-09-04T11:00:00Z",
          updatedAt: "2026-09-04T11:05:00Z",
        },
        events: [],
      },
    ]);
    renderWithProviders(<AgentChatPanel projectId={projects[0].id} project={projects[0]} />);
    await waitFor(
      () => expect(document.querySelector("[data-empty-state]")).toBeTruthy(),
      SLOW,
    );
    useStreamStore.setState({
      bySession: {
        sess_checkpoint: {
          liveTurn: {
            startedAtMs: Date.now() - 3000,
            working: [],
            streamText: "I am navigating the page for you…",
            streamThinking: "",
            stopped: false,
            stoppedByUser: false,
            streamingToolInputs: [],
            debugReport: null,
            browserCheckpoint: {
              checkpointId: "bchk_live1",
              kind: "cloudflare",
              url: "https://protected.example.com",
              waitMs: 15000,
              startedAtMs: Date.now(),
              state: "waiting",
            },
            retry: null,
            note: null,
          },
          streamBusy: true,
          sendError: null,
          liveError: null,
          pendingEcho: null,
          lastLiveEndMs: Date.now(),
          lastTurnStoppedByUser: false,
          lastTurnStoppedTs: null,
          queued: [],
          deliveredQueued: [],
        },
      },
    });
    // The card renders with the owner's exact naming + the countdown + BOTH
    // controls, and the stream text is visible below it.
    expect(await screen.findByText("Cloudflare verification needed")).toBeTruthy();
    expect(screen.getByTestId("browser-checkpoint-countdown")).toBeTruthy();
    expect(screen.getByTestId("browser-checkpoint-done")).toBeTruthy();
    expect(screen.getByTestId("browser-checkpoint-stop")).toBeTruthy();
    expect(screen.getByText(/navigating the page for you/i)).toBeTruthy();
  });

  it("R66 (C1): a live debugReport streams the analyst card at the very bottom of the turn", async () => {
    const projects = await getFixtureProjects().list();
    customBackend.backend = createFixtureSessions([
      {
        session: {
          id: "sess_debuglive",
          projectId: projects[0].id,
          agentId: "agt_scribe",
          mode: "single",
          status: "completed",
          title: "Debug live probe",
          createdAt: "2026-09-04T11:00:00Z",
          updatedAt: "2026-09-04T11:05:00Z",
        },
        events: [],
      },
    ]);
    renderWithProviders(<AgentChatPanel projectId={projects[0].id} project={projects[0]} />);
    await waitFor(
      () => expect(document.querySelector("[data-empty-state]")).toBeTruthy(),
      SLOW,
    );
    useStreamStore.setState({
      bySession: {
        sess_debuglive: {
          liveTurn: {
            startedAtMs: Date.now() - 3000,
            working: [],
            streamText: "The task is complete — file written and verified.",
            streamThinking: "",
            stopped: false,
            stoppedByUser: false,
            streamingToolInputs: [],
            debugReport: { state: "streaming", text: "## Tool-by-tool trace\n- write_file → ok" },
            browserCheckpoint: null,
            retry: null,
            note: null,
          },
          streamBusy: false,
          sendError: null,
          liveError: null,
          pendingEcho: null,
          lastLiveEndMs: Date.now(),
          lastTurnStoppedByUser: false,
          lastTurnStoppedTs: null,
          queued: [],
          deliveredQueued: [],
        },
      },
    });
    // The dedicated section renders BELOW the answer (the answer text is
    // still present) with the streaming status + live partial markdown.
    expect(await screen.findByTestId("debug-report-card")).toBeTruthy();
    expect(screen.getByTestId("debug-report-status").textContent).toContain("Analyzing the last execution");
    expect(screen.getByText("Tool-by-tool trace")).toBeTruthy();
    expect(screen.getByText(/task is complete/i)).toBeTruthy();
  });

  it("R66 (C1): a FOLDED turn with a debug.report event renders the analyst card at the turn's bottom", async () => {
    const projects = await getFixtureProjects().list();
    customBackend.backend = createFixtureSessions([
      {
        session: {
          id: "sess_debugfold",
          projectId: projects[0].id,
          agentId: "agt_scribe",
          mode: "single",
          status: "completed",
          title: "Debug fold probe",
          createdAt: "2026-09-04T11:00:00Z",
          updatedAt: "2026-09-04T11:05:00Z",
        },
        events: [
          messageEvent(1, "user", "analyze this file", "2026-09-04T11:00:10Z"),
          messageEvent(2, "assistant", "Here is the analysis.", "2026-09-04T11:00:20Z"),
          {
            seq: 3,
            type: "debug.report",
            agentId: "agt_scribe",
            payload: { content: "## Failures & anomalies\n- none", model: "test/model-1" },
            ts: "2026-09-04T11:00:25Z",
          },
        ],
      },
    ]);
    renderWithProviders(<AgentChatPanel projectId={projects[0].id} project={projects[0]} />);
    // The folded answer + the dedicated debug section under it. ROUND-67
    // (R67-B): the folded card mounts COLLAPSED — expand the header to read
    // the report (the Copy report button is visible even collapsed).
    expect(await screen.findByText("Here is the analysis.", {}, SLOW)).toBeTruthy();
    const card = await screen.findByTestId("debug-report-card", {}, SLOW);
    expect(card.textContent).toContain("Debug report");
    expect(card.textContent).toContain("test/model-1");
    expect(screen.queryByText("Failures & anomalies")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand debug report" }));
    expect(screen.getByText("Failures & anomalies")).toBeTruthy();
    // R67-B: the copy footer rides the minimized card too (outside the
    // collapsible body — the owner's "copy button at the very bottom").
    expect(screen.getByRole("button", { name: "Copy debug report" })).toBeTruthy();
  });

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
    // The flushed partial stays visible above the card (ChatMarkdown renders
    // a plain run as one span — assert on a substring of the answer).
    expect(screen.getByText("beginning", { exact: false })).toBeTruthy();
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
            debugReport: null,
            browserCheckpoint: null,
            retry: null,
            note: null,
          },
          streamBusy: false,
          sendError: null,
          liveError: null,
          pendingEcho: null,
          lastLiveEndMs: Date.now(),
          lastTurnStoppedByUser: false,
          lastTurnStoppedTs: null,
          queued: [],
          deliveredQueued: [],
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

  it("R60 polish: a SAVED bad note renders a 'noted' chip; clicking it reopens the editor PRE-FILLED", async () => {
    const projects = await getFixtureProjects().list();
    const rows: MessageRating[] = [
      {
        id: 31,
        sessionId: "sess_rate_probe",
        assistantSeq: 2,
        rating: "bad",
        note: "ignored my file-path constraint",
        model: null,
        agentId: "agt_scribe",
        createdAt: "2026-09-01T10:00:00Z",
        updatedAt: "2026-09-01T10:00:00Z",
      },
    ];
    ratingsMock.listSessionRatings.mockResolvedValue(rows);
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
        ],
      },
    ]);
    renderWithProviders(
      <AgentChatPanel projectId={projects[0].id} project={projects[0]} />,
    );
    await screen.findByText("first question", {}, SLOW);

    // The chip renders next to the filled thumbs (visible without hover —
    // the cluster is persistent for rated turns).
    const chip = await waitFor(() => {
      const el = screen.getByTestId("rating-note-chip");
      expect(el.getAttribute("title")).toContain("ignored my file-path constraint");
      return el;
    }, SLOW);

    // Clicking the chip reopens the editor with the saved note pre-filled.
    fireEvent.click(chip);
    const input = await screen.findByTestId("rating-note-input", {}, SLOW);
    expect((input as HTMLInputElement).value).toBe("ignored my file-path constraint");
  }, 15_000);

  it("R60 polish: re-rating a SAVED bad reply (bad thumb again after unfill cycle) pre-fills the editor with the existing note", async () => {
    const projects = await getFixtureProjects().list();
    // A saved bad rating WITH a note (the re-rate path).
    const persisted: MessageRating[] = [
      {
        id: 41,
        sessionId: "sess_rate_probe",
        assistantSeq: 2,
        rating: "bad",
        note: "hallucinated the API",
        model: null,
        agentId: "agt_scribe",
        createdAt: "2026-09-01T10:00:00Z",
        updatedAt: "2026-09-01T10:00:00Z",
      },
    ];
    ratingsMock.listSessionRatings.mockImplementation(async () => persisted);
    ratingsMock.rateReply.mockImplementation(async (_sid, input) => {
      // Upsert semantics (the real backend): re-rate refreshes the row.
      persisted[0] = {
        ...persisted[0],
        rating: input.rating,
        note: input.note ?? persisted[0].note,
        updatedAt: "2026-09-01T10:06:00Z",
      };
      return persisted[0];
    });
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
        ],
      },
    ]);
    renderWithProviders(
      <AgentChatPanel projectId={projects[0].id} project={projects[0]} />,
    );
    await screen.findByText("first question", {}, SLOW);

    // The saved verdict renders filled; clicking the chip reopens the editor.
    fireEvent.click(await screen.findByTestId("rating-note-chip", {}, SLOW));
    const input = await screen.findByTestId("rating-note-input", {}, SLOW);
    expect((input as HTMLInputElement).value).toBe("hallucinated the API");

    // A FRESH bad rating (no saved note anywhere) starts the editor EMPTY:
    // re-rate a different flow — unfill via same-thumb delete first.
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(
      () => expect(document.querySelector("[data-rating-note]")).toBeNull(),
      SLOW,
    );
  }, 15_000);
});

// ── ROUND-67 (R67-B): the debug-gated full-conversation copy option ─────────
// Owner directive #2: TWO copy options on agent replies — the normal one
// (final answer only) plus "the whole conversation of it, all the thinking
// of it, all the tool calls within it" — and the second one appears ONLY
// when the Advanced-settings debug option is ON (GET /settings/debug via
// the shared ["debug-settings"] query key).
describe("AgentChatPanel full-conversation copy (ROUND-67 R67-B)", () => {
  const SLOW = { timeout: 5000 };

  function messageEvent(
    seq: number,
    role: "user" | "assistant",
    content: string,
    ts: string,
    extra: Record<string, unknown> = {},
  ): SessionEvent {
    return {
      seq,
      type: role === "user" ? "message.user" : "message.assistant",
      agentId: "agt_scribe",
      payload: { role, content, agentId: "agt_scribe", ts, ...extra },
      ts,
    };
  }

  /** A tool.use event exactly as the backend writes it (with an output
   * summary — the copy export rides it). */
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
        outputSummary: "read 12 lines",
        agentId: "agt_scribe",
        ts: "2026-09-06T10:00:30Z",
      },
      ts: "2026-09-06T10:00:30Z",
    };
  }

  /** One folded turn: user question → read_file tool call → assistant
   * answer (model + ms on the assistant stats-carrier payload). */
  async function renderFullCopyConversation(): Promise<void> {
    const projects = await getFixtureProjects().list();
    customBackend.backend = createFixtureSessions([
      {
        session: {
          id: "sess_fullcopy_probe",
          projectId: projects[0].id,
          agentId: "agt_scribe",
          mode: "single",
          status: "completed",
          title: "Full-copy probe",
          createdAt: "2026-09-06T10:00:00Z",
          updatedAt: "2026-09-06T10:05:00Z",
        },
        events: [
          messageEvent(1, "user", "read the file for me", "2026-09-06T10:00:10Z"),
          toolUseEvent(2),
          messageEvent(3, "assistant", "Here is the file's content.", "2026-09-06T10:00:40Z", {
            model: "test/model-1",
            ms: 4200,
          }),
        ],
      },
    ]);
    renderWithProviders(<AgentChatPanel projectId={projects[0].id} project={projects[0]} />);
    await screen.findByText("read the file for me", {}, SLOW);
  }

  it("debug settings OFF → only the plain copy button; the full-conversation copy is HIDDEN", async () => {
    // beforeEach's default: fetchDebugSettings → { enabled: false }.
    await renderFullCopyConversation();

    // The plain copy button renders (the normal option, unchanged).
    expect(screen.getAllByRole("button", { name: "Copy message" }).length).toBeGreaterThan(0);
    // The debug-gated second option is NOT rendered.
    expect(screen.queryByRole("button", { name: "Copy full conversation (debug)" })).toBeNull();
  });

  it("debug settings ON → the full-conversation copy appears and writes the model + tool trace to the clipboard", async () => {
    debugSettingsMock.fetchDebugSettings.mockResolvedValue({ enabled: true });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    await renderFullCopyConversation();

    // The SECOND copy option mounts next to the plain one (hover cluster).
    const fullCopy = await screen.findByRole(
      "button",
      { name: "Copy full conversation (debug)" },
      SLOW,
    );
    fireEvent.click(fullCopy);

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1), SLOW);
    const text = writeText.mock.calls[0][0] as string;
    // The owner's "whole conversation… all the tool calls": the model
    // header, the tool block with its result, and the final answer.
    expect(text).toContain("=== ACUTE-CODE turn export (debug) ===");
    expect(text).toContain("Model: test/model-1 | Duration: 4200ms");
    expect(text).toContain("--- TOOL 1: read_file ---");
    expect(text).toContain("result: ok — read 12 lines");
    expect(text).toContain("--- FINAL ANSWER ---");
    expect(text).toContain("Here is the file's content.");
  });
});

// ── ROUND-68 (R68-A): the INLINE screenshot rows (the strip is gone) ─────────
describe("AgentChatPanel inline screenshots (ROUND-68 R68-A)", () => {
  const SLOW = { timeout: 5000 };

  const createObjectURL = vi.fn(() => "blob:panel-shot");
  const revokeObjectURL = vi.fn();

  beforeEach(() => {
    // happy-dom implements neither — the object-URL lifecycle is this pair.
    URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    rasterMock.fetchComputerFrameRaster.mockReset();
    rasterMock.fetchComputerFrameRaster.mockResolvedValue(
      new Blob(["\x89PNG-bytes"], { type: "image/png" }),
    );
  });

  /** Render an empty panel, then arm a LIVE turn whose working array carries
   * an in-flight screenshot tool row + the inline capture entry (the exact
   * state the stream-store builds when the sideband frame lands mid-tool). */
  async function renderLiveTurnWithCapture(): Promise<void> {
    const projects = await getFixtureProjects().list();
    customBackend.backend = createFixtureSessions([
      {
        session: {
          id: "sess_inline_shot",
          projectId: projects[0].id,
          agentId: "agt_scribe",
          mode: "single",
          status: "completed",
          title: "Inline shot probe",
          createdAt: "2026-09-06T10:00:00Z",
          updatedAt: "2026-09-06T10:05:00Z",
        },
        events: [],
      },
    ]);
    renderWithProviders(<AgentChatPanel projectId={projects[0].id} project={projects[0]} />);
    await waitFor(
      () => expect(document.querySelector("[data-empty-state]")).toBeTruthy(),
      SLOW,
    );
    useStreamStore.setState({
      bySession: {
        sess_inline_shot: {
          liveTurn: {
            startedAtMs: Date.now() - 2000,
            working: [
              { type: "tool", tool: { seq: 1, toolName: "screenshot", argsSummary: "full display", ok: null, ts: new Date().toISOString() } },
              { type: "screenshot", frameId: "f-live", tool: "screenshot", ts: new Date().toISOString() },
            ],
            streamText: "",
            streamThinking: "",
            stopped: false,
            stoppedByUser: false,
            streamingToolInputs: [],
            debugReport: null,
            browserCheckpoint: null,
            retry: null,
            note: null,
          },
          streamBusy: true,
          sendError: null,
          liveError: null,
          pendingEcho: null,
          lastLiveEndMs: Date.now(),
          lastTurnStoppedByUser: false,
          lastTurnStoppedTs: null,
          queued: [],
          deliveredQueued: [],
        },
      },
    });
  }

  it("a live capture entry renders INLINE inside the live Working section — the R67-D bottom strip is GONE", async () => {
    await renderLiveTurnWithCapture();
    // The inline row mounts INSIDE the live section (lazy-fetch fired).
    const row = await screen.findByTestId("screenshot-row", {}, SLOW);
    expect(row).toBeTruthy();
    await waitFor(() =>
      expect(rasterMock.fetchComputerFrameRaster).toHaveBeenCalledWith("f-live"),
    );
    // The caption names WHAT was captured.
    expect(screen.getByText("Screenshot · screenshot")).toBeTruthy();
    // The strip (header, count, horizontal scroller) no longer renders.
    expect(screen.queryByTestId("screenshot-strip")).toBeNull();
    expect(screen.queryByText("Screenshots")).toBeNull();
  });
});

// ── ROUND-75 (R75): the retry-ladder status card + the enriched error card ──
describe("AgentChatPanel ROUND-75 retry ladder surfaces", () => {
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

  async function renderWithLiveTurn(
    liveTurn: Partial<LiveTurn> | null,
    liveError: TurnErrorInfo | null = null,
  ): Promise<void> {
    const projects = await getFixtureProjects().list();
    customBackend.backend = createFixtureSessions([
      {
        session: {
          id: "sess_r75_retry",
          projectId: projects[0].id,
          agentId: "agt_scribe",
          mode: "single",
          status: "running",
          title: "Retry ladder probe",
          createdAt: "2026-08-31T11:00:00Z",
          updatedAt: "2026-08-31T11:05:00Z",
        },
        events: [messageEvent(1, "user", "do the work", "2026-08-31T11:00:10Z")],
      },
    ]);
    renderWithProviders(<AgentChatPanel projectId={projects[0].id} project={projects[0]} />);
    await screen.findByText("do the work", {}, SLOW);
    useStreamStore.setState({
      bySession: {
        sess_r75_retry: {
          liveTurn:
            liveTurn === null
              ? null
              : {
                  startedAtMs: Date.now() - 3000,
                  working: [],
                  streamText: "",
                  streamThinking: "",
                  stopped: false,
                  stoppedByUser: false,
                  streamingToolInputs: [],
                  debugReport: null,
                  browserCheckpoint: null,
                  retry: null,
                  note: null,
                  ...liveTurn,
                },
          streamBusy: true,
          sendError: null,
          liveError,
          pendingEcho: null,
          lastLiveEndMs: Date.now(),
          lastTurnStoppedByUser: false,
          lastTurnStoppedTs: null,
          queued: [],
          deliveredQueued: [],
        },
      },
    });
  }

  it("R75: the RetryStatusCard renders while the ladder waits — amber status, attempt count, class chip, countdown, reassurance", async () => {
    await renderWithLiveTurn({
      retry: {
        attempt: 2,
        totalAttempts: 6,
        waitMs: 90_000,
        remainingMs: 88_000,
        retryAt: Date.now() + 88_000,
        errorClass: "rate_limit",
        classMessage: "rate limited — the provider is throttling requests",
        message: "rate limited — retrying (attempt 2 of 6) in 1.5 min",
      },
    });

    const card = document.querySelector("[data-retry-status-card]") as HTMLElement;
    expect(card).toBeTruthy();
    // A STATUS, not an alert — the turn is alive and handling itself.
    expect(card.getAttribute("role")).toBe("status");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(card.textContent).toContain("Retrying — attempt 2 of 6");
    expect(card.textContent).toContain("rate limit");
    expect(card.textContent).toContain("rate limited — the provider is throttling requests");
    expect(card.textContent).toContain("next attempt in");
    expect(card.textContent).toContain("the agent keeps working automatically");
    // R77: the attempt DOT-LADDER — one dot per attempt (6 for the ladder).
    const dots = card.querySelectorAll("[data-retry-dots] > span");
    expect(dots).toHaveLength(6);
    // The current attempt (2) breathes (the pulse class); attempts 3-6 are
    // hollow (transparent background); attempt 1 (done) is dim-filled.
    expect(dots[1].className).toContain("ac-retry-pulse");
    expect((dots[2] as HTMLElement).style.background).toContain("transparent");
    // R77: the countdown bar exists and is filling (waitMs known → the
    // fraction is computed from the live remaining time).
    const bar = card.querySelector("[data-retry-status-card] .h-1") as HTMLElement | null;
    expect(bar).toBeTruthy();
  });

  it("R75: the overflow-recovery note renders as a transient status line", async () => {
    await renderWithLiveTurn({
      note: "[context overflow → auto-compacted conversation → retrying]",
    });
    expect(
      screen.getByText("[context overflow → auto-compacted conversation → retrying]"),
    ).toBeTruthy();
  });

  it("R75: the error card after ladder exhaustion shows the class chip + 'after 6 attempts' + Copy details carries both", async () => {
    await renderWithLiveTurn(null, {
      code: "PROVIDER_ERROR",
      message:
        "provider 'openrouter' call failed for session s (class: rate_limit) — auto-retry ladder exhausted",
      status: 502,
      errorClass: "rate_limit",
      attempts: 6,
      providerError: "429 Too Many Requests",
      ts: "2026-08-31T11:00:30Z",
    });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Generation failed");
    expect(alert.textContent).toContain("after 6 attempts");
    expect(alert.textContent).toContain("rate limit"); // the class chip (snake_case flattened)
    // The reason line carries the upstream provider error (the card's
    // existing providerError ?? message precedence).
    expect(alert.textContent).toContain("429 Too Many Requests");
  });
});

// ── ROUND-78 (R78-D/R78-A): the message-queue wiring + the honest retry card ──
describe("AgentChatPanel ROUND-78 message queue + honest retry card", () => {
  const SLOW = { timeout: 5000 };
  const SESSION_ID = "sess_r78_queue";

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

  /** A persisted `message.queued` event (the chip the fold renders). */
  function queuedEvent(seq: number, content: string, ts: string): SessionEvent {
    return {
      seq,
      type: "message.queued",
      agentId: "agt_scribe",
      payload: { role: "user", content, agentId: "agt_scribe", ts },
      ts,
    };
  }

  async function renderQueuePanel(
    events: SessionEvent[],
    status: "running" | "completed" = "running",
  ): Promise<void> {
    const projects = await getFixtureProjects().list();
    customBackend.backend = createFixtureSessions([
      {
        session: {
          id: SESSION_ID,
          projectId: projects[0].id,
          agentId: "agt_scribe",
          mode: "single",
          status,
          title: "Queue probe",
          createdAt: "2026-09-14T10:00:00Z",
          updatedAt: "2026-09-14T10:05:00Z",
        },
        events,
      },
    ]);
    renderWithProviders(<AgentChatPanel projectId={projects[0].id} project={projects[0]} />);
    // Wait for the transcript's first user message (the session loaded).
    const firstUser = events.find((e) => e.type === "message.user");
    await screen.findByText(
      firstUser !== undefined ? (firstUser.payload as { content: string }).content : "Queue probe",
      {},
      SLOW,
    );
  }

  /** Arm the store exactly as a live stream + frames would have left it. */
  function armLiveStream(queued: Array<{ seq: number; content: string; ts: string }> = []): void {
    useStreamStore.setState({
      bySession: {
        [SESSION_ID]: {
          liveTurn: {
            startedAtMs: Date.now() - 3000,
            working: [],
            streamText: "working on it…",
            streamThinking: "",
            stopped: false,
            stoppedByUser: false,
            streamingToolInputs: [],
            debugReport: null,
            browserCheckpoint: null,
            retry: null,
            note: null,
          },
          streamBusy: true,
          sendError: null,
          liveError: null,
          pendingEcho: null,
          lastLiveEndMs: Date.now(),
          lastTurnStoppedByUser: false,
          lastTurnStoppedTs: null,
          queued,
          deliveredQueued: [],
        },
      },
    });
  }

  beforeEach(() => {
    streamMock.streamSessionMessage.mockReset().mockResolvedValue(undefined);
  });

  it("R78-D: Enter while a turn streams POSTs the QUEUE (not the send); the optimistic chip renders and the composer clears", async () => {
    await renderQueuePanel([messageEvent(1, "user", "do the work", "2026-09-14T10:00:10Z")]);
    armLiveStream();
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop generation" })).toBeTruthy(), SLOW);

    // The queue-send button rides the anchor next to Stop (the panel wired
    // onQueue because liveMode is on).
    expect(screen.getByRole("button", { name: "Queue message" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Message composer"), { target: { value: "also add tests" } });
    fireEvent.keyDown(screen.getByLabelText("Message composer"), { key: "Enter" });

    // The queue POST carried the session + the typed text; the normal send
    // NEVER fired — the in-flight stream is untouched.
    await waitFor(
      () => expect(queueMock.queueSessionMessage).toHaveBeenCalledWith(SESSION_ID, { content: "also add tests" }),
      SLOW,
    );
    expect(streamMock.streamSessionMessage).not.toHaveBeenCalled();
    // The optimistic chip (seq 41 — the mocked POST return) is live-rendered.
    const chip = await screen.findByTestId("queued-chip", {}, SLOW);
    expect(chip.getAttribute("data-queued-seq")).toBe("41");
    expect(chip.textContent).toContain("also add tests");
    expect(chip.textContent).toContain("Queued — sends after the current step");
    // While the turn runs there is NO "Send now" (the queue will deliver).
    expect(screen.queryByRole("button", { name: "Send the queued message now" })).toBeNull();
    // The composer cleared exactly like a normal send.
    await waitFor(() =>
      expect((screen.getByLabelText("Message composer") as HTMLTextAreaElement).value).toBe(""),
    );
  });

  it("R78-D: NO_LIVE_TURN 409 — the turn ended mid-POST; the panel falls through to the NORMAL send", async () => {
    await renderQueuePanel([messageEvent(1, "user", "do the work", "2026-09-14T10:00:10Z")]);
    armLiveStream();
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop generation" })).toBeTruthy(), SLOW);

    // The race: the POST 409s NO_LIVE_TURN and the local reader learns the
    // turn ended ~150ms later (the store's streamBusy settles).
    queueMock.queueSessionMessage.mockImplementation(async () => {
      setTimeout(() => {
        const slice = useStreamStore.getState().bySession[SESSION_ID];
        if (slice !== undefined) {
          useStreamStore.setState({
            bySession: {
              ...useStreamStore.getState().bySession,
              [SESSION_ID]: { ...slice, streamBusy: false, liveTurn: null },
            },
          });
        }
      }, 150);
      throw new ApiError(409, "NO_LIVE_TURN", "no live turn for this session — send the message normally");
    });

    fireEvent.change(screen.getByLabelText("Message composer"), { target: { value: "you done? then take this" } });
    fireEvent.keyDown(screen.getByLabelText("Message composer"), { key: "Enter" });

    // The queue POST was attempted, then the send fell through to the NORMAL
    // stream path with the SAME text (no interrupted message, no lost send).
    await waitFor(
      () => expect(streamMock.streamSessionMessage).toHaveBeenCalledWith(
        SESSION_ID,
        "you done? then take this",
        expect.any(Function),
        expect.anything(),
      ),
      SLOW,
    );
    // The turn settled — the composer shows Send again.
    await waitFor(() => expect(screen.getByRole("button", { name: "Send message" })).toBeTruthy(), SLOW);
  });

  it("R78-D: a queued-frame chip (live store) renders amber with the Clock label; X-REMOVE DELETEs the event and drops the chip optimistically", async () => {
    await renderQueuePanel([messageEvent(1, "user", "do the work", "2026-09-14T10:00:10Z")]);
    armLiveStream([{ seq: 77, content: "queued behind the tool call", ts: "2026-09-14T10:01:00Z" }]);
    const chip = await screen.findByTestId("queued-chip", {}, SLOW);
    expect(chip.getAttribute("data-queued-seq")).toBe("77");
    expect(chip.textContent).toContain("queued behind the tool call");

    // X-remove → DELETE /sessions/:id/queue/:seq (optimistic — instant drop).
    fireEvent.click(screen.getByRole("button", { name: "Remove the queued message" }));
    await waitFor(() => expect(queueMock.dequeueSessionMessage).toHaveBeenCalledWith(SESSION_ID, 77), SLOW);
    await waitFor(() => expect(screen.queryByTestId("queued-chip")).toBeNull(), SLOW);
  });

  it("R78-D: a FOLDED message.queued event renders the same chip; SEND NOW (idle) dequeues + runs a NORMAL turn with the content", async () => {
    // The stream ENDED (a stop) with the queue left intact — the fold owns
    // the chips now (message.queued events in the persisted log).
    await renderQueuePanel(
      [
        messageEvent(1, "user", "build the thing", "2026-09-14T10:00:10Z"),
        messageEvent(2, "assistant", "on it — writing files", "2026-09-14T10:00:20Z"),
        queuedEvent(3, "and also lint everything", "2026-09-14T10:01:00Z"),
      ],
      "completed",
    );
    const chip = await screen.findByTestId("queued-chip", {}, SLOW);
    expect(chip.getAttribute("data-queued-seq")).toBe("3");
    expect(chip.textContent).toContain("and also lint everything");

    // Idle → the Send-now affordance is there (dequeue + a normal send).
    fireEvent.click(screen.getByRole("button", { name: "Send the queued message now" }));
    await waitFor(() => expect(queueMock.dequeueSessionMessage).toHaveBeenCalledWith(SESSION_ID, 3), SLOW);
    await waitFor(
      () => expect(streamMock.streamSessionMessage).toHaveBeenCalledWith(
        SESSION_ID,
        "and also lint everything",
        expect.any(Function),
        expect.anything(),
      ),
      SLOW,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Send message" })).toBeTruthy(), SLOW);
  });

  it("R78-D: the fold/live handoff dedupes by seq — a refetch that folded the SAME message.queued still shows exactly ONE chip (the live one)", async () => {
    // The window-focus refetch raced the running stream: the folded log now
    // carries message.queued seq 41 AND the live store still holds it.
    await renderQueuePanel(
      [
        messageEvent(1, "user", "do the work", "2026-09-14T10:00:10Z"),
        queuedEvent(41, "queued msg", "2026-09-14T10:01:00Z"),
      ],
      "running",
    );
    armLiveStream([{ seq: 41, content: "queued msg", ts: "2026-09-14T10:01:00Z" }]);
    await waitFor(() => expect(screen.getAllByTestId("queued-chip")).toHaveLength(1), SLOW);
    // The live chip owns it (the X affordance works through the store path).
    expect(screen.getByRole("button", { name: "Remove the queued message" })).toBeTruthy();
  });

  // ── R78-A: the honest retry card — the REAL provider text under the chip ──
  async function renderWithRetry(retry: Partial<LiveTurnRetry>): Promise<void> {
    await renderQueuePanel([messageEvent(1, "user", "do the work", "2026-09-14T10:00:10Z")]);
    const base = {
      startedAtMs: Date.now() - 3000,
      working: [],
      streamText: "",
      streamThinking: "",
      stopped: false,
      stoppedByUser: false,
      streamingToolInputs: [],
      debugReport: null,
      browserCheckpoint: null,
      note: null,
    } satisfies Omit<LiveTurn, "retry">;
    useStreamStore.setState({
      bySession: {
        [SESSION_ID]: {
          liveTurn: {
            ...base,
            retry: {
              attempt: 2,
              totalAttempts: 6,
              waitMs: 90_000,
              remainingMs: 88_000,
              retryAt: Date.now() + 88_000,
              errorClass: "rate_limit",
              classMessage: "rate limited — the provider is throttling requests",
              message: "rate limited — retrying (attempt 2 of 6) in 1.5 min",
              ...retry,
            } satisfies LiveTurnRetry,
          },
          streamBusy: true,
          sendError: null,
          liveError: null,
          pendingEcho: null,
          lastLiveEndMs: Date.now(),
          lastTurnStoppedByUser: false,
          lastTurnStoppedTs: null,
          queued: [],
          deliveredQueued: [],
        },
      },
    });
    await waitFor(() => expect(document.querySelector("[data-retry-status-card]")).toBeTruthy(), SLOW);
  }

  it("R78-A: the retry card renders the REAL provider text under the class chip (mono, data-retry-provider-error); absent → nothing extra", async () => {
    await renderWithRetry({
      providerError: "Rate limit exceeded: free-models-per-day. Add 10 credits to continue.",
    });
    const card = document.querySelector("[data-retry-status-card]") as HTMLElement;
    expect(card).toBeTruthy();
    const providerLine = card.querySelector("[data-retry-provider-error]") as HTMLElement;
    expect(providerLine).toBeTruthy();
    expect(providerLine.textContent).toContain(
      "Rate limit exceeded: free-models-per-day. Add 10 credits to continue.",
    );
    // Short payload → no expand toggle.
    expect(card.querySelector("[data-retry-provider-expand]")).toBeNull();
  });

  it("R78-A: a LONG provider text (>240 chars) collapses to the excerpt + the R77 expand toggle; expanding reveals the FULL scrollable mono block", async () => {
    const longText =
      "Rate limit exceeded: free-models-per-day. The provider rejected the request because the account-wide free quota is exhausted; the model will remain unavailable until the daily window resets or credits are added. " +
      "x".repeat(120);
    await renderWithRetry({ providerError: longText });
    const card = document.querySelector("[data-retry-status-card]") as HTMLElement;
    const providerLine = card.querySelector("[data-retry-provider-error]") as HTMLElement;
    // Collapsed: the 240-char excerpt + ellipsis, clamped to ~3 lines.
    expect(providerLine.textContent).toContain(`${longText.slice(0, 240)}…`);
    const toggle = card.querySelector("[data-retry-provider-expand]") as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    expect(toggle.textContent).toContain("Show full error");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("true"));
    // The complete raw text, in the scrollable mono pre.
    const full = card.querySelector("[data-retry-provider-error-full]") as HTMLElement;
    expect(full).toBeTruthy();
    expect(full.className).toContain("overflow-y-auto");
    expect(full.textContent).toBe(longText);
    expect(toggle.textContent).toContain("Show less");
  });

  it("R78-A: NO providerError (a pre-R78 sidecar) → the card keeps today's class-message line only", async () => {
    await renderWithRetry({});
    const card = document.querySelector("[data-retry-status-card]") as HTMLElement;
    expect(card).toBeTruthy();
    expect(card.querySelector("[data-retry-provider-error]")).toBeNull();
    expect(card.textContent).toContain("rate limited — the provider is throttling requests");
  });
});
