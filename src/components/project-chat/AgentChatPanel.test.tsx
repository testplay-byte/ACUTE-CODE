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
import type { MessageRating, Session, SessionEvent, SessionsBackend } from "../../lib/api";
import { ApiError } from "../../lib/api";
import { useConfigStore } from "../../lib/config-store";
import { useThemeStore } from "../../lib/theme-store";
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

/** ROUND-114 (R114-e): the pick-becomes-server-truth PATCH — mocked so a
 * picker click in these tests never touches the network (the interaction
 * pin lives in Composer.test.tsx's model-selector suite). */
const selectedModelMock = vi.hoisted(() => ({
  patchSessionSelectedModel: null as unknown as ReturnType<typeof vi.fn>,
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
  selectedModelMock.patchSessionSelectedModel = vi.fn();
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
    patchSessionSelectedModel: selectedModelMock.patchSessionSelectedModel,
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
  // R114-e: the session-model PATCH resolves the fresh row by default.
  selectedModelMock.patchSessionSelectedModel.mockReset();
  selectedModelMock.patchSessionSelectedModel.mockResolvedValue({
    id: "sess_selected_model",
    projectId: null,
    agentId: "agt_scribe",
    mode: "single",
    status: "queued",
    title: null,
    createdAt: "2026-09-20T00:00:00Z",
    updatedAt: "2026-09-20T00:00:00Z",
    parentSessionId: null,
    subRole: null,
    permissionMode: "ask",
    selectedModel: null,
  });
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
    // R100-D re-pin: the panel root's 16px radius now uses the SCALE utility
    // (rounded-2xl — §C4.1's window-card spec; same pixels, no arbitrary
    // value), so the root lookup follows the new spelling.
    const root = Array.from(document.querySelectorAll("div")).find((el) =>
      el.className.includes("rounded-2xl"),
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
    // R97-I re-pin: the greeting renders only after the session queries
    // settle (the chat-shaped skeleton holds the column while loading) —
    // await the READY state before counting the capped columns.
    await waitFor(() => expect(document.querySelector("[data-empty-state]")).toBeTruthy());
    const cols = Array.from(document.querySelectorAll("div")).filter((el) =>
      el.className.includes("max-w-[1080px]"),
    );
    expect(cols.length).toBeGreaterThanOrEqual(2); // messages + composer
    for (const col of cols) {
      expect(col.className).toContain("mx-auto");
      expect(col.className).toContain("w-full");
    }
  });

  it("R97-I: a loading conversation holds the SKELETON — the greeting never paints on a fetch in flight", async () => {
    const projects = await getFixtureProjects().list();
    const base = createFixtureSessions([]);
    // list() never settles → the sessions query stays pending forever.
    customBackend.backend = {
      ...base,
      list: () => new Promise<Session[]>(() => {}),
    };
    renderWithProviders(<AgentChatPanel projectId={projects[0].id} project={projects[0]} />);

    await waitFor(() =>
      expect(document.querySelector("[data-transcript-skeleton]")).toBeTruthy(),
    );
    // The FALSE greeting is the round's headline fix — it must not render
    // while the history is still unknown.
    expect(document.querySelector("[data-empty-state]")).toBeNull();
    // The skeleton announces itself exactly once (role=status container).
    expect(screen.getByLabelText("Loading conversation")).toBeTruthy();
  });

  it("R97-I: a fetch failure renders the retryable ERROR CARD — never the cheerful empty chat", async () => {
    const projects = await getFixtureProjects().list();
    const base = createFixtureSessions([]);
    customBackend.backend = {
      ...base,
      list: () => Promise.reject(new Error("sidecar down")),
    };
    renderWithProviders(<AgentChatPanel projectId={projects[0].id} project={projects[0]} />);

    await waitFor(() => expect(document.querySelector("[data-chat-load-error]")).toBeTruthy());
    expect(document.querySelector("[data-empty-state]")).toBeNull();
    expect(screen.getByRole("alert")).toBeTruthy();

    // Retry re-drives the fetch: flip list() back to a resolving backend and
    // click — the greeting then renders (the recovered ready state).
    const base2 = createFixtureSessions([]);
    customBackend.backend.list = base2.list;
    fireEvent.click(screen.getByRole("button", { name: "Retry loading the conversation" }));
    await waitFor(() => expect(document.querySelector("[data-empty-state]")).toBeTruthy());
    expect(document.querySelector("[data-chat-load-error]")).toBeNull();
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

  it("R97-H: hover timestamps render ONLY when the setting is on (user bubbles + assistant turn headers — R99-B re-pin: the chip moved from the footer to the turn header)", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question about the parser", {}, SLOW)).toBeTruthy();

    // Default ("hidden") — no chips anywhere in the transcript.
    expect(document.querySelectorAll("[data-chat-timestamp]")).toHaveLength(0);

    // "On hover" — every persisted item gains its chip: 2 user bubbles +
    // 2 assistant turn HEADERS (R99-B: the timestamp rides the header row,
    // one per turn — the count contract is unchanged).
    useThemeStore.setState({ timestampsMode: "hover" });
    await waitFor(() => {
      expect(document.querySelectorAll("[data-chat-timestamp]")).toHaveLength(4);
    });

    // The fixture's ts (2026-08-26) is NOT today in any relevant run → the
    // chip prefixes its short date; a today-run still shows the clock alone.
    // Assert through the same date math the chip uses, never a hardcoded
    // string, so the test holds in any timezone.
    const fixtureTs = "2026-08-26T10:00:10Z";
    const isToday = new Date().toDateString() === new Date(fixtureTs).toDateString();
    const first = document.querySelector("[data-chat-timestamp]") as HTMLElement;
    expect(first.textContent ?? "").toMatch(/^\S/);
    if (!isToday) expect(first.textContent).toContain("·");

    // Turning the setting back off removes every chip again.
    useThemeStore.setState({ timestampsMode: "hidden" });
    await waitFor(() => {
      expect(document.querySelectorAll("[data-chat-timestamp]")).toHaveLength(0);
    });
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
          queueKeptNotice: null,
          remote: false,
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
          queueKeptNotice: null,
          remote: false,
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
          queueKeptNotice: null,
          remote: false,
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
          queueKeptNotice: null,
          remote: false,
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

// ── R99-B: the chat-window visual overhaul — turn header, footer stats line,
//    user-bubble cap, suggestion cards, the streaming caret ───────────────────
describe("AgentChatPanel R99-B chat visual overhaul", () => {
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

  /** One turn whose assistant event carries model + usage + ms (the header
   * chip + the footer stats line both have real data to render). */
  async function renderHeaderConversation(): Promise<void> {
    const projects = await getFixtureProjects().list();
    customBackend.backend = createFixtureSessions([
      {
        session: {
          id: "sess_r99_header",
          projectId: projects[0].id,
          agentId: "agt_scribe",
          mode: "single",
          status: "completed",
          title: "R99 header probe",
          createdAt: "2026-09-12T10:00:00Z",
          updatedAt: "2026-09-12T10:05:00Z",
        },
        events: [
          messageEvent(1, "user", "answer with the new anatomy", "2026-09-12T10:00:10Z"),
          messageEvent(2, "assistant", "The redesigned answer.", "2026-09-12T10:00:20Z", {
            model: "test/model-9",
            ms: 4200,
            usage: { inputTokens: 1200, outputTokens: 850 },
          }),
        ],
      },
    ]);
    renderWithProviders(<AgentChatPanel projectId={projects[0].id} project={projects[0]} />);
    await screen.findByText("answer with the new anatomy", {}, SLOW);
  }

  it("the TURN HEADER renders the model identity chip — and NOTHING when the turn has no model and timestamps are hidden", async () => {
    await renderHeaderConversation();

    // ONE header for ONE turn: the accent dot + the model identity chip.
    const headers = document.querySelectorAll('[data-testid="turn-header"]');
    expect(headers).toHaveLength(1);
    expect(headers[0].textContent).toContain("test/model-9");
    // The identity marks are decorative (aria-hidden); the model chip is
    // metadata, not a persona name header (the R37 verdict).
    expect(headers[0].querySelector('[aria-hidden="true"]')).not.toBeNull();
    // timestampsMode "hidden" (the default) → no timestamp in the header.
    expect(headers[0].querySelector("[data-chat-timestamp]")).toBeNull();

    // A turn with NO model (the plain fixture conversation) renders NO
    // header at all — nothing to say, nothing shown. (cleanup() unmounts
    // the first panel so its header cannot bleed into this assertion.)
    cleanup();
    const projects = await getFixtureProjects().list();
    customBackend.backend = createFixtureSessions([
      {
        session: {
          id: "sess_r99_nomodel",
          projectId: projects[0].id,
          agentId: "agt_scribe",
          mode: "single",
          status: "completed",
          title: "No-model probe",
          createdAt: "2026-09-12T11:00:00Z",
          updatedAt: "2026-09-12T11:05:00Z",
        },
        events: [
          messageEvent(1, "user", "plain question", "2026-09-12T11:00:10Z"),
          messageEvent(2, "assistant", "plain answer", "2026-09-12T11:00:20Z"),
        ],
      },
    ]);
    renderWithProviders(<AgentChatPanel projectId={projects[0].id} project={projects[0]} />);
    await screen.findByText("plain answer", {}, SLOW);
    expect(document.querySelector('[data-testid="turn-header"]')).toBeNull();
  });

  it("timestampsMode ON: the header carries the hover timestamp (tabular-nums) exactly once per turn", async () => {
    await renderHeaderConversation();
    useThemeStore.setState({ timestampsMode: "hover" });
    await waitFor(() => {
      const header = document.querySelector('[data-testid="turn-header"]');
      expect(header).not.toBeNull();
      const chip = header!.querySelector("[data-chat-timestamp]");
      expect(chip).not.toBeNull();
      expect(chip!.className).toContain("tabular-nums");
    });
    // One user bubble chip + one turn-header chip — the R97-H count contract.
    expect(document.querySelectorAll("[data-chat-timestamp]")).toHaveLength(2);
    useThemeStore.setState({ timestampsMode: "hidden" });
  });

  it("the footer's stats cluster is ONE mono tabular-nums line (time · in · out · tok/s) — no per-stat chips, no model", async () => {
    await renderHeaderConversation();

    const stats = await waitFor(() => {
      const el = document.querySelector("[data-reply-stats]");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    }, SLOW);
    // The flattened grammar: 4.2s · ↑ 1.2k · ↓ 850 · 202 tok/s (middle-dot
    // separated — ONE text node, never bordered chips).
    expect(stats.textContent).toBe("4.2s · ↑ 1.2k · ↓ 850 · 202 tok/s");
    expect(stats.className).toContain("font-mono");
    expect(stats.className).toContain("tabular-nums");
    // Right-aligned in the footer row.
    expect(stats.className).toContain("ml-auto");
    // The model identity lives in the HEADER now — the footer never repeats it.
    const footer = document.querySelector("[data-rating-footer]");
    expect(footer).not.toBeNull();
    expect(footer!.textContent).not.toContain("test/model-9");
  });

  it("the user bubble caps at min(65%, 640px) of the reading column (a bubble, never a full-width document)", async () => {
    await renderHeaderConversation();
    // R100-D re-pin (§C4.3 — the input-row idiom): the messenger tail is
    // DELETED (uniform rounded-xl 12px — the lookup below matches the
    // bubble's unique class combo) and the row's cap tightens 75% → 65%.
    const bubble = Array.from(document.querySelectorAll("div")).find((el) =>
      el.className.includes("rounded-xl px-3.5 py-2.5 text-[13px]"),
    );
    expect(bubble).toBeTruthy();
    const row = bubble!.parentElement;
    expect(row).not.toBeNull();
    expect(row!.className).toContain("max-w-[min(65%,640px)]");
    // The squish tier keeps its wider relative room (R89-D2).
    expect(row!.className).toContain("@max-[420px]:max-w-[92%]");
  });

  it("the empty-state suggestions are pill-cards (1.5px border, CSS-var hover leg) that fill the composer on click", async () => {
    const projects = await getFixtureProjects().list();
    customBackend.backend = createFixtureSessions([]);
    renderWithProviders(<AgentChatPanel projectId={projects[0].id} project={projects[0]} />);
    await waitFor(() => expect(document.querySelector("[data-empty-state]")).toBeTruthy(), SLOW);

    const cards = screen.getAllByTestId("suggestion-card");
    expect(cards).toHaveLength(4);
    for (const card of cards) {
      // Real buttons with the pill-card grammar: 1.5px border-line + the
      // accent hover entirely on the CSS-var leg (no JS hover handlers).
      expect(card.tagName).toBe("BUTTON");
      expect(card.className).toContain("border-[1.5px]");
      expect(card.className).toContain("border-line");
      expect(card.className).toContain("hover:border-accent");
      expect(card.className).toContain("hover:bg-accent-soft");
      // The universal press contract.
      expect(card.className).toContain("active:scale-95");
    }
    // Click behavior unchanged: the prompt fills the composer.
    fireEvent.click(screen.getByRole("button", { name: /Explore this project/ }));
    const composer = screen.getByLabelText("Message composer") as HTMLTextAreaElement;
    await waitFor(() => expect(composer.value).toContain("Explore this project: list the top-level structure"));
  });

  it("the STREAMING CARET: a thin 2px ac-caret-pulse bar while the answer streams — gone the moment it settles", async () => {
    const projects = await getFixtureProjects().list();
    customBackend.backend = createFixtureSessions([
      {
        session: {
          id: "sess_r99_caret",
          projectId: projects[0].id,
          agentId: "agt_scribe",
          mode: "single",
          status: "completed",
          title: "Caret probe",
          createdAt: "2026-09-12T12:00:00Z",
          updatedAt: "2026-09-12T12:05:00Z",
        },
        events: [],
      },
    ]);
    renderWithProviders(<AgentChatPanel projectId={projects[0].id} project={projects[0]} />);
    await waitFor(() => expect(document.querySelector("[data-empty-state]")).toBeTruthy(), SLOW);

    const liveTurnBase: LiveTurn = {
      startedAtMs: Date.now() - 3000,
      working: [],
      streamText: "The answer is still arriving",
      streamThinking: "",
      stopped: false,
      stoppedByUser: false,
      streamingToolInputs: [],
      debugReport: null,
      browserCheckpoint: null,
      retry: null,
      note: null,
    };
    useStreamStore.setState({
      bySession: {
        sess_r99_caret: {
          liveTurn: liveTurnBase,
          streamBusy: true,
          sendError: null,
          liveError: null,
          pendingEcho: null,
          lastLiveEndMs: Date.now(),
          lastTurnStoppedByUser: false,
          lastTurnStoppedTs: null,
          queued: [],
          deliveredQueued: [],
          queueKeptNotice: null,
          remote: false,
        },
      },
    });

    // While streaming: the caret rides the answer's end — 2px wide, the
    // soft pulse keyframe, decorative.
    const caret = await waitFor(() => {
      const el = document.querySelector('[data-testid="streaming-caret"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    }, SLOW);
    expect(caret.className).toContain("ac-caret-pulse");
    expect(caret.className).toContain("w-[2px]");
    expect(caret.getAttribute("aria-hidden")).toBe("true");
    // The LIVE turn also carries its header (the effective model chip).
    const header = document.querySelector('[data-testid="turn-header"]');
    expect(header).not.toBeNull();

    // The stream settles (busy → false): the caret disappears — the stopped
    // text keeps plain text, never a stuck cursor.
    useStreamStore.setState({
      bySession: {
        sess_r99_caret: {
          liveTurn: liveTurnBase,
          streamBusy: false,
          sendError: null,
          liveError: null,
          pendingEcho: null,
          lastLiveEndMs: Date.now(),
          lastTurnStoppedByUser: false,
          lastTurnStoppedTs: null,
          queued: [],
          deliveredQueued: [],
          queueKeptNotice: null,
          remote: false,
        },
      },
    });
    await waitFor(() => {
      expect(document.querySelector('[data-testid="streaming-caret"]')).toBeNull();
      // The streamed text itself stays.
      expect(screen.getByText(/still arriving/)).toBeTruthy();
    }, SLOW);
  });
});

// ── ROUND-113 (R113-b): the REMOTE live turn — another device's turn on this
// session, replayed by the events stream into the SAME live section. The panel
// must render it with ZERO special-casing: streaming text + the caret, the
// queue chips the phone queued, and the busy composer (Stop reaches the
// server's /stop; Enter routes to the queue path). ──
describe("AgentChatPanel remote live turn (ROUND-113 R113-b)", () => {
  const SLOW = { timeout: 5000 };

  it("a remote mirror streams through the SAME live section: caret + text + queue chips + the busy composer", async () => {
    const projects = await getFixtureProjects().list();
    customBackend.backend = createFixtureSessions([
      {
        session: {
          id: "sess_r113b_remote",
          projectId: projects[0].id,
          agentId: "agt_scribe",
          mode: "single",
          status: "completed",
          title: "Remote mirror probe",
          createdAt: "2026-09-20T12:00:00Z",
          updatedAt: "2026-09-20T12:05:00Z",
        },
        events: [],
      },
    ]);
    renderWithProviders(<AgentChatPanel projectId={projects[0].id} project={projects[0]} />);
    await waitFor(() => expect(document.querySelector("[data-empty-state]")).toBeTruthy(), SLOW);

    // The slice exactly as ingestRemoteFrame leaves it mid-turn: remote:true,
    // streamBusy:false (a mirror never owns a fetch), one queued chip the
    // phone pushed, streamed text on the live turn.
    useStreamStore.setState({
      bySession: {
        sess_r113b_remote: {
          liveTurn: {
            startedAtMs: Date.now() - 3000,
            working: [],
            streamText: "The phone's turn is streaming on the desktop",
            streamThinking: "",
            stopped: false,
            stoppedByUser: false,
            streamingToolInputs: [],
            debugReport: null,
            browserCheckpoint: null,
            retry: null,
            note: null,
          },
          streamBusy: false,
          sendError: null,
          liveError: null,
          pendingEcho: null,
          lastLiveEndMs: 0,
          lastTurnStoppedByUser: false,
          lastTurnStoppedTs: null,
          queued: [{ seq: 12, content: "follow-up typed on the phone", ts: "2026-09-20T12:00:30Z" }],
          deliveredQueued: [],
          queueKeptNotice: null,
          remote: true,
        },
      },
    });

    // The SAME live section renders: streamed text + the pulsing caret (a
    // mirror in flight is just as "generating" as an own stream).
    expect(await screen.findByText(/phone's turn is streaming/, {}, SLOW)).toBeTruthy();
    await waitFor(() => {
      expect(document.querySelector('[data-testid="streaming-caret"]')).not.toBeNull();
    }, SLOW);
    // The phone's queued chip renders from the mirror.
    expect(document.querySelector("[data-queued-live-list]")?.textContent).toContain(
      "follow-up typed on the phone",
    );
    // busy: the composer swaps Send for Stop (a turn IS running server-side —
    // Stop routes to the server's /stop and resolves the remote turn).
    expect(await screen.findByRole("button", { name: "Stop generation" }, SLOW)).toBeTruthy();

    // The retire lands (the store's retire timer clears the mirror): the
    // caret goes, the streamed text follows the folded log's render.
    useStreamStore.setState({
      bySession: {
        sess_r113b_remote: {
          liveTurn: null,
          streamBusy: false,
          sendError: null,
          liveError: null,
          pendingEcho: null,
          lastLiveEndMs: Date.now(),
          lastTurnStoppedByUser: false,
          lastTurnStoppedTs: null,
          queued: [],
          deliveredQueued: [],
          queueKeptNotice: null,
          remote: false,
        },
      },
    });
    await waitFor(() => {
      expect(document.querySelector('[data-testid="streaming-caret"]')).toBeNull();
      expect(document.querySelector("[data-queued-live-list]")).toBeNull();
    }, SLOW);
  });
});

// ── ROUND-114 (R114-e, owner: "after sending from mobile, the PC send button
// status does not change; no processing/thinking status"): turn.started opens
// the remote mirror the INSTANT the phone sends — the user bubble renders from
// the frame's own text (no waiting for the debounced folded-log refetch), the
// "Thinking…" placeholder shows while no content has arrived (the empty-liveTurn
// placeholder applies to remote mirrors too), the resolved model labels the
// live turn, and the persisted message.user row REPLACES the live copy on
// refetch — never a double bubble. ──
describe("AgentChatPanel remote turn.started (ROUND-114 R114-e)", () => {
  const SLOW = { timeout: 5000 };

  /** The slice exactly as ingestRemoteFrame leaves it after the OPENING
   * turn.started frame: remote mirror open, the phone's text + the resolved
   * model stamped, no content yet. */
  function remoteStartedSlice(userText: string, model: string) {
    return {
      liveTurn: {
        startedAtMs: Date.now() - 500,
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
        // R114-e: the turn.started frame's stamps (the store's own branch).
        userText,
        model,
      } as LiveTurn,
      streamBusy: false,
      sendError: null,
      liveError: null,
      pendingEcho: null,
      lastLiveEndMs: 0,
      lastTurnStoppedByUser: false,
      lastTurnStoppedTs: null,
      queued: [],
      deliveredQueued: [],
      queueKeptNotice: null,
      remote: true,
    };
  }

  it("the phone's message + Thinking placeholder + the resolved model render the INSTANT the mirror opens; the composer flips to Stop", async () => {
    const projects = await getFixtureProjects().list();
    customBackend.backend = createFixtureSessions([
      {
        session: {
          id: "sess_r114e_started",
          projectId: projects[0].id,
          agentId: "agt_scribe",
          mode: "single",
          status: "completed",
          title: "turn.started probe",
          createdAt: "2026-09-20T12:00:00Z",
          updatedAt: "2026-09-20T12:05:00Z",
        },
        events: [],
      },
    ]);
    renderWithProviders(<AgentChatPanel projectId={projects[0].id} project={projects[0]} />);
    await waitFor(() => expect(document.querySelector("[data-empty-state]")).toBeTruthy(), SLOW);

    useStreamStore.setState({
      bySession: { sess_r114e_started: remoteStartedSlice("hey from the phone", "z-ai/glm-4.7") },
    });

    // The user bubble renders from the FRAME's own text — before any folded
    // log refetch could have carried the persisted row.
    expect(await screen.findByText("hey from the phone", {}, SLOW)).toBeTruthy();
    // The "Thinking…" placeholder (the empty-liveTurn path — applies to
    // remote mirrors exactly as to own turns).
    expect(await screen.findByText(/^Thinking/, {}, SLOW)).toBeTruthy();
    // The resolved model labels the live turn's header (the honest label —
    // the three-tier ladder's verdict off turn.started).
    await waitFor(() => {
      expect(document.querySelector('[data-testid="turn-header"]')?.textContent).toContain(
        "z-ai/glm-4.7",
      );
    }, SLOW);
    // busy: Send is gone, Stop owns the anchor (the phone's turn IS running).
    expect(await screen.findByRole("button", { name: "Stop generation" }, SLOW)).toBeTruthy();
  });

  it("the persisted message.user row REPLACES the live copy — never a double bubble (content dedupe)", async () => {
    const projects = await getFixtureProjects().list();
    // The folded log already carries the persisted row (the refetch landed).
    customBackend.backend = createFixtureSessions([
      {
        session: {
          id: "sess_r114e_dedupe",
          projectId: projects[0].id,
          agentId: "agt_scribe",
          mode: "single",
          status: "running",
          title: "dedupe probe",
          createdAt: "2026-09-20T12:00:00Z",
          updatedAt: "2026-09-20T12:05:00Z",
        },
        events: [
          {
            seq: 1,
            type: "message.user",
            agentId: "agt_scribe",
            payload: { role: "user", content: "hey from the phone", agentId: "agt_scribe", ts: "2026-09-20T12:00:10Z" },
            ts: "2026-09-20T12:00:10Z",
          },
        ],
      },
    ]);
    renderWithProviders(<AgentChatPanel projectId={projects[0].id} project={projects[0]} />);
    await waitFor(() => expect(screen.getByText("hey from the phone")).toBeTruthy(), SLOW);

    // The mirror opens with the IDENTICAL text — the dedupe must hold it.
    useStreamStore.setState({
      bySession: { sess_r114e_dedupe: remoteStartedSlice("hey from the phone", "z-ai/glm-4.7") },
    });
    await waitFor(() => {
      expect(document.querySelector('[data-testid="turn-header"]')?.textContent).toContain(
        "z-ai/glm-4.7",
      );
    }, SLOW);

    // Exactly ONE bubble carrying the phone's message.
    expect(screen.getAllByText("hey from the phone")).toHaveLength(1);
  });
});

// ── ROUND-101 (R101-D): the LEFT TIMELINE RAIL ───────────────────────────────
// Owner (v0.98.0): "I was hoping to see a timeline on the very left side of the
// chat window area to see the timeline of the things." Every transcript item
// renders in a 28px rail grid (20px under the 560px container floor); the items
// wrapper paints one continuous faded spine behind the rail column.
describe("AgentChatPanel timeline rail (ROUND-101 R101-D)", () => {
  const SLOW = { timeout: 5000 };

  /** Chat event exactly as the backend writes it (payload mirrors agentId + ts). */
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

  async function renderTimelineConversation(): Promise<void> {
    const projects = await getFixtureProjects().list();
    customBackend.backend = createFixtureSessions([
      {
        session: {
          id: "sess_r101_timeline",
          projectId: projects[0].id,
          agentId: "agt_scribe",
          mode: "single",
          status: "completed",
          title: "R101 timeline probe",
          createdAt: "2026-08-26T10:00:00Z",
          updatedAt: "2026-08-26T10:05:00Z",
        },
        events: [
          messageEvent(1, "user", "first question", "2026-08-26T10:00:10Z"),
          messageEvent(2, "assistant", "first answer", "2026-08-26T10:00:20Z", {
            model: "test/model-9",
            ms: 4200,
            usage: { inputTokens: 1200, outputTokens: 850 },
          }),
        ],
      },
    ]);
    renderWithProviders(<AgentChatPanel projectId={projects[0].id} project={projects[0]} />);
    await screen.findByText("first question", {}, SLOW);
  }

  it("every transcript item rides the RAIL GRID — 28px rail cell + content, kind-coded nodes, one node per item", async () => {
    await renderTimelineConversation();

    // The rail grids: the user bubble AND the assistant turn both render in
    // the two-column grid (28px rail + content; the 560px squish tier narrows
    // it to 20px in lockstep with the column padding).
    const grids = Array.from(document.querySelectorAll("div")).filter((el) =>
      el.className.includes("grid-cols-[28px_minmax(0,1fr)]"),
    );
    expect(grids.length).toBeGreaterThanOrEqual(2);
    for (const grid of grids) {
      expect(grid.className).toContain("gap-x-3");
      expect(grid.className).toContain("@max-[560px]:grid-cols-[20px_minmax(0,1fr)]");
      // First cell = the rail node; the content follows UNTOUCHED.
      expect(grid.querySelector("[data-timeline-node]")).not.toBeNull();
    }

    // The kind-coded dots: solid accent for the user, hollow accent (2px
    // border on the card background) for the assistant turn.
    const nodes = Array.from(document.querySelectorAll("[data-timeline-node]"));
    expect(nodes).toHaveLength(2);
    const [userNode, turnNode] = nodes as HTMLElement[];
    expect(userNode.dataset.timelineKind).toBe("user");
    const userDot = userNode.querySelector("span[aria-hidden='true']") as HTMLElement;
    expect(userDot.style.background).not.toBe("");
    expect(userDot.style.border).toBe("");
    expect(turnNode.dataset.timelineKind).toBe("turn");
    const turnDot = turnNode.querySelector("span[aria-hidden='true']") as HTMLElement;
    expect(turnDot.style.border).toContain("2px solid");
    // Every dot carries the punch-out ring in the transcript background so
    // the spine terminates AT the node, plus the 9px size + 7px offset.
    for (const dot of [userDot, turnDot]) {
      expect(dot.className).toContain("size-[9px]");
      expect(dot.className).toContain("mt-[7px]");
      expect(dot.className).toContain("rounded-full");
      expect(dot.style.boxShadow).toContain("2.5px");
    }

    // A11y: the dots are decorative, but the rail carries an sr-only label
    // AND a hover title — the timeline is perceivable without the visuals.
    expect(userNode.querySelector(".sr-only")?.textContent).toContain("You");
    expect(turnNode.querySelector(".sr-only")?.textContent).toContain("Assistant turn");
    expect(userDot.title).toContain("You");
    expect(turnDot.title).toContain("Assistant turn");
  });

  it("the SPINE: one continuous faded hairline over the rail axis — and NEVER on an empty transcript", async () => {
    await renderTimelineConversation();
    const spine = document.querySelector("[data-timeline-spine]") as HTMLElement | null;
    expect(spine).not.toBeNull();
    // Pure decoration: aria-hidden, no hit target.
    expect(spine!.getAttribute("aria-hidden")).toBe("true");
    expect(spine!.className).toContain("pointer-events-none");
    // The spine overlay carries the SAME graduated padding as the reading
    // column, so the hairline sits on the rail axis at every tier.
    expect(spine!.className).toContain("px-6");
    const line = spine!.firstElementChild as HTMLElement;
    expect(line.className).toContain("w-px");
    expect(line.className).toContain("ml-3.5");
    expect(line.className).toContain("@max-[560px]:ml-2.5");
    // Both ends fade (the mask) — the line never hard-cuts.
    expect(line.style.maskImage).toContain("linear-gradient");

    // The empty chat is a greeting, not a timeline: no spine at rest.
    cleanup();
    const projects = await getFixtureProjects().list();
    customBackend.backend = createFixtureSessions([]);
    renderWithProviders(<AgentChatPanel projectId={projects[0].id} project={projects[0]} />);
    await waitFor(() => expect(document.querySelector("[data-empty-state]")).toBeTruthy(), SLOW);
    expect(document.querySelector("[data-timeline-spine]")).toBeNull();
    expect(document.querySelector("[data-timeline-node]")).toBeNull();
  });

  it("the LIVE turn rides the same rail (the spine never slices the streaming block)", async () => {
    await renderTimelineConversation();
    // Arm a live turn exactly like the caret suite does.
    const liveTurn: LiveTurn = {
      startedAtMs: Date.now(),
      working: [],
      streamText: "the live answer",
      streamThinking: "",
      stopped: false,
      stoppedByUser: false,
      streamingToolInputs: [],
      debugReport: null,
      browserCheckpoint: null,
      retry: null,
      note: null,
    };
    useStreamStore.setState({
      bySession: {
        sess_r101_timeline: {
          liveTurn,
          streamBusy: true,
          sendError: null,
          liveError: null,
          pendingEcho: null,
          lastLiveEndMs: 0,
          lastTurnStoppedByUser: false,
          lastTurnStoppedTs: null,
          queued: [],
          deliveredQueued: [],
          queueKeptNotice: null,
          remote: false,
        },
      },
    });
    await screen.findByText(/the live answer/, {}, SLOW);

    // The live block wraps in the SAME grid with an assistant-turn node —
    // without it the streaming content would start 40px left of every other
    // row and the spine would cut through it.
    const liveGrid = Array.from(document.querySelectorAll("div"))
      .filter((el) => el.className.includes("grid-cols-[28px_minmax(0,1fr)]"))
      .find((el) => el.querySelector('[aria-live="polite"]') !== null);
    expect(liveGrid).toBeTruthy();
    const liveNode = liveGrid!.querySelector("[data-timeline-node]") as HTMLElement;
    expect(liveNode.dataset.timelineKind).toBe("turn");
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
          queueKeptNotice: null,
          remote: false,
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
          queueKeptNotice: null,
          remote: false,
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
          queueKeptNotice: null,
          remote: false,
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

    // R91-F (the owner: "That send message button should only appear when
    // I have typed some message"): the queue affordance is GONE while the
    // composer is empty — it appears the moment text lands.
    expect(screen.queryByRole("button", { name: "Queue message" })).toBeNull();

    fireEvent.change(screen.getByLabelText("Message composer"), { target: { value: "also add tests" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Queue message" })).toBeTruthy());
    fireEvent.keyDown(screen.getByLabelText("Message composer"), { key: "Enter" });

    // The queue POST carried the session + the typed text; the normal send
    // NEVER fired — the in-flight stream is untouched.
    await waitFor(
      () => expect(queueMock.queueSessionMessage).toHaveBeenCalledWith(SESSION_ID, { content: "also add tests" }),
      SLOW,
    );
    expect(streamMock.streamSessionMessage).not.toHaveBeenCalled();
    // The optimistic queued row (seq 41 — the mocked POST return) is
    // live-rendered. R119-C: it renders as a USER MESSAGE now — the content
    // rides the bubble and the always-visible mono "queued" caption below
    // it (the old amber banner's "Queued — sends after the current step"
    // headline is gone).
    const chip = await screen.findByTestId("queued-chip", {}, SLOW);
    expect(chip.getAttribute("data-queued-seq")).toBe("41");
    expect(chip.textContent).toContain("also add tests");
    expect(chip.querySelector('[data-testid="queued-state-caption"]')?.textContent).toBe("queued");
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

  it("R78-D: a queued-frame row (live store) renders as the USER BUBBLE with the queued caption; X-REMOVE DELETEs the event and drops the row optimistically", async () => {
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
          queueKeptNotice: null,
          remote: false,
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

// ── ROUND-119 (R119-C): the PC queued-message honesty. The owner's report had
// two defects: (1) a queued message "does not appear as a message, but rather
// as a notification or error message" — the amber banner is retired, the row
// renders through the SAME UserMessage bubble every sent message uses; (2)
// while a queued message waits, the transcript shows "the exact same thought
// process… the exact same reply" TWICE — the queued POST's debounced
// invalidation refetches the log mid-turn, the fold flushes the in-flight
// turn's persisted events as a trailing OPEN turn, and the panel rendered
// that AND the live section. The interlock: the items memo suppresses the
// folded turn(s) opened at-or-after the LIVE turn's opening user message
// (matched by content — the wire carries no seq for the opener) and the
// folded queued rows the live queue already mirrors; when the overlay
// clears, the fold renders everything exactly once. ──
describe("AgentChatPanel queued-message honesty (ROUND-119 R119-C)", () => {
  const SLOW = { timeout: 5000 };
  const SESSION_ID = "sess_r119c";

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

  function queuedEvent(seq: number, content: string, ts: string): SessionEvent {
    return {
      seq,
      type: "message.queued",
      agentId: "agt_scribe",
      payload: { role: "user", content, agentId: "agt_scribe", ts },
      ts,
    };
  }

  /** One live OWN-stream slice exactly as the stream left it when the queue
   * POST's invalidation refetched mid-turn (the owner's moment): the turn is
   * streaming, the optimistic echo is still armed, the queued message is in
   * the live queue. */
  const ownLiveSlice = (queued: Array<{ seq: number; content: string; ts: string }>) => ({
    liveTurn: {
      startedAtMs: Date.now() - 4000,
      working: [
        { type: "text" as const, content: "Let me inspect the project first.", ts: "2026-09-23T10:00:20Z" },
      ],
      streamText: "The file is ready.",
      streamThinking: "",
      stopped: false,
      stoppedByUser: false,
      streamingToolInputs: [],
      debugReport: null,
      browserCheckpoint: null,
      retry: null,
      note: null,
      model: "test/live-model",
    } satisfies LiveTurn,
    streamBusy: true,
    sendError: null,
    liveError: null,
    // The anchor content: the message that OPENED the live turn.
    pendingEcho: "please build the thing",
    lastLiveEndMs: Date.now(),
    lastTurnStoppedByUser: false,
    lastTurnStoppedTs: null,
    queued,
    deliveredQueued: [],
    queueKeptNotice: null,
    remote: false,
  });

  it("R119-C: THE OWNER'S DUPLICATE — a live turn + a folded log carrying the SAME in-flight turn renders it ONCE; the clearStream handoff renders it once again", async () => {
    const projects = await getFixtureProjects().list();
    // The mid-turn refetch's snapshot: the persisted opener, the in-flight
    // turn's already-persisted interim events (the trailing OPEN turn), and
    // the queued row whose POST triggered the invalidation.
    customBackend.backend = createFixtureSessions([
      {
        session: {
          id: SESSION_ID,
          projectId: projects[0].id,
          agentId: "agt_scribe",
          mode: "single",
          status: "running",
          title: "R119-C duplicate probe",
          createdAt: "2026-09-23T10:00:00Z",
          updatedAt: "2026-09-23T10:05:00Z",
        },
        events: [
          messageEvent(1, "user", "please build the thing", "2026-09-23T10:00:10Z"),
          messageEvent(2, "assistant", "Let me inspect the project first.", "2026-09-23T10:00:20Z", {
            model: "test/folded-model",
          }),
          queuedEvent(3, "and make it pretty", "2026-09-23T10:00:40Z"),
          messageEvent(4, "assistant", "The file is ready.", "2026-09-23T10:00:50Z", {
            model: "test/folded-model",
          }),
        ],
      },
    ]);
    renderWithProviders(<AgentChatPanel projectId={projects[0].id} project={projects[0]} />);

    // Pre-control (no live overlay): the fold owns everything — ONE user
    // row, ONE trailing turn, ONE queued row.
    await screen.findByText("please build the thing", {}, SLOW);
    expect(document.querySelectorAll('[data-testid="turn-header"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-testid="queued-chip"]')).toHaveLength(1);

    // The live overlay arms exactly as the stream left it mid-turn.
    useStreamStore.setState({
      bySession: {
        [SESSION_ID]: ownLiveSlice([{ seq: 3, content: "and make it pretty", ts: "2026-09-23T10:00:40Z" }]),
      },
    });
    await waitFor(() => expect(document.querySelector('[data-testid="streaming-caret"]')).not.toBeNull(), SLOW);

    // THE PIN: exactly ONE turn header — the LIVE one (its model stamp), not
    // the folded duplicate (the folded model never renders while live).
    // waitFor: the folded copy's AnimatePresence exit must settle first —
    // the DUPLICATE is the end state this test exists to kill.
    await waitFor(() => {
      const headers = Array.from(document.querySelectorAll('[data-testid="turn-header"]'));
      expect(headers).toHaveLength(1);
      expect(headers[0].textContent).toContain("test/live-model");
      expect(headers[0].textContent).not.toContain("test/folded-model");
    }, SLOW);
    // The reply text renders ONCE (the live stream's copy — the folded
    // trailing turn is suppressed, so the owner's "exact same reply" twice
    // is gone), and so do the opener's bubble and the queued message.
    await waitFor(() => expect(screen.getAllByText(/The file is ready/)).toHaveLength(1), SLOW);
    expect(screen.getAllByText("please build the thing")).toHaveLength(1);
    await waitFor(() => expect(screen.getAllByText("and make it pretty")).toHaveLength(1), SLOW);
    await waitFor(() => expect(document.querySelectorAll('[data-testid="queued-chip"]')).toHaveLength(1), SLOW);

    // The handoff (the stream ended; clearStream + the echo clear): the fold
    // takes over — STILL exactly one of everything, now the folded copies.
    useStreamStore.setState({
      bySession: {
        [SESSION_ID]: {
          liveTurn: null,
          streamBusy: false,
          sendError: null,
          liveError: null,
          pendingEcho: null,
          lastLiveEndMs: Date.now(),
          lastTurnStoppedByUser: false,
          lastTurnStoppedTs: null,
          queued: [],
          deliveredQueued: [],
          queueKeptNotice: null,
          remote: false,
        },
      },
    });
    await waitFor(() => {
      const headers = Array.from(document.querySelectorAll('[data-testid="turn-header"]'));
      expect(headers).toHaveLength(1);
      expect(headers[0].textContent).toContain("test/folded-model");
    }, SLOW);
    await waitFor(() => expect(screen.getAllByText(/The file is ready/)).toHaveLength(1), SLOW);
    expect(screen.getAllByText("please build the thing")).toHaveLength(1);
    // The FOLDED queued row owns the render now — the same bubble, with the
    // affordances bound through the panel's live path.
    await waitFor(() => {
      const chips = document.querySelectorAll('[data-testid="queued-chip"]');
      expect(chips).toHaveLength(1);
      expect(chips[0].getAttribute("data-queued-seq")).toBe("3");
    }, SLOW);
    expect(screen.getByRole("button", { name: "Remove the queued message" })).toBeTruthy();
  });

  it("R119-C: a REMOTE mirror suppresses its own folded turn too (the userText anchor) — the retire hands the fold the render", async () => {
    const projects = await getFixtureProjects().list();
    customBackend.backend = createFixtureSessions([
      {
        session: {
          id: "sess_r119c_remote",
          projectId: projects[0].id,
          agentId: "agt_scribe",
          mode: "single",
          status: "running",
          title: "R119-C remote probe",
          createdAt: "2026-09-23T11:00:00Z",
          updatedAt: "2026-09-23T11:05:00Z",
        },
        events: [
          messageEvent(1, "user", "hey from the phone", "2026-09-23T11:00:10Z"),
          messageEvent(2, "assistant", "The phone's answer so far", "2026-09-23T11:00:30Z", {
            model: "test/folded-model",
          }),
        ],
      },
    ]);
    renderWithProviders(<AgentChatPanel projectId={projects[0].id} project={projects[0]} />);
    await screen.findByText("hey from the phone", {}, SLOW);

    // The mirror mid-turn: remote, userText stamped from turn.started.
    useStreamStore.setState({
      bySession: {
        sess_r119c_remote: {
          liveTurn: {
            startedAtMs: Date.now() - 2000,
            working: [],
            streamText: "The phone's answer so far",
            streamThinking: "",
            stopped: false,
            stoppedByUser: false,
            streamingToolInputs: [],
            debugReport: null,
            browserCheckpoint: null,
            retry: null,
            note: null,
            model: "test/live-model",
            userText: "hey from the phone",
          } satisfies LiveTurn,
          streamBusy: false,
          sendError: null,
          liveError: null,
          pendingEcho: null,
          lastLiveEndMs: 0,
          lastTurnStoppedByUser: false,
          lastTurnStoppedTs: null,
          queued: [],
          deliveredQueued: [],
          queueKeptNotice: null,
          remote: true,
        },
      },
    });

    // While the mirror renders: ONE header (the live model), ONE answer, ONE
    // user bubble (the persisted row — the remote live copy deduped).
    await waitFor(() => {
      const headers = Array.from(document.querySelectorAll('[data-testid="turn-header"]'));
      expect(headers).toHaveLength(1);
      expect(headers[0].textContent).toContain("test/live-model");
    }, SLOW);
    await waitFor(() => expect(screen.getAllByText(/phone's answer so far/)).toHaveLength(1), SLOW);
    expect(screen.getAllByText("hey from the phone")).toHaveLength(1);

    // The retire timer lands → the fold owns the render, still once.
    useStreamStore.setState({
      bySession: {
        sess_r119c_remote: {
          liveTurn: null,
          streamBusy: false,
          sendError: null,
          liveError: null,
          pendingEcho: null,
          lastLiveEndMs: Date.now(),
          lastTurnStoppedByUser: false,
          lastTurnStoppedTs: null,
          queued: [],
          deliveredQueued: [],
          queueKeptNotice: null,
          remote: false,
        },
      },
    });
    await waitFor(() => {
      const headers = Array.from(document.querySelectorAll('[data-testid="turn-header"]'));
      expect(headers).toHaveLength(1);
      expect(headers[0].textContent).toContain("test/folded-model");
    }, SLOW);
    await waitFor(() => expect(screen.getAllByText(/phone's answer so far/)).toHaveLength(1), SLOW);
  });

  it("R119-C: the queued row renders AS A MESSAGE — the UserMessage bubble idiom, NO amber, the queued caption, and the affordances still fire", async () => {
    const projects = await getFixtureProjects().list();
    const longQueued =
      "first line of the queued message. second line of the queued message. third line of the queued message.";
    customBackend.backend = createFixtureSessions([
      {
        session: {
          id: "sess_r119c_idiom",
          projectId: projects[0].id,
          agentId: "agt_scribe",
          mode: "single",
          status: "completed",
          title: "R119-C idiom probe",
          createdAt: "2026-09-23T12:00:00Z",
          updatedAt: "2026-09-23T12:05:00Z",
        },
        events: [
          messageEvent(1, "user", "build the thing", "2026-09-23T12:00:10Z"),
          messageEvent(2, "assistant", "on it — writing files", "2026-09-23T12:00:20Z"),
          queuedEvent(3, longQueued, "2026-09-23T12:00:40Z"),
        ],
      },
    ]);
    renderWithProviders(<AgentChatPanel projectId={projects[0].id} project={projects[0]} />);
    const chip = await screen.findByTestId("queued-chip", {}, SLOW);
    expect(chip.getAttribute("data-queued-seq")).toBe("3");

    // The BUBBLE idiom: the chip's first child is the reduced-opacity
    // wrapper around the plain UserMessage — a right-aligned row capped at
    // min(65%, 640px) with the accent-soft rounded-xl bubble inside, exactly
    // like every sent message (NOT a bordered banner card).
    const wrapper = chip.firstElementChild as HTMLElement;
    expect(wrapper.style.opacity).toBe("0.75");
    const row = wrapper.querySelector("div.flex.justify-end") as HTMLElement | null;
    expect(row).not.toBeNull();
    const bubble = row?.querySelector("div.rounded-xl") as HTMLElement | null;
    expect(bubble).not.toBeNull();
    expect(bubble?.className).toContain("text-[13px]");
    // The FULL message rides the bubble — the old banner's line-clamp-2 is
    // gone (the bubble's own clamp owns long text now).
    expect(chip.querySelector(".line-clamp-2")).toBeNull();
    expect(chip.textContent).toContain("third line of the queued message.");

    // NO warning/amber styling anywhere on the row — the waiting state is
    // chrome (opacity + caption), never a colored card. Both spellings the
    // old banner used (#f59e0b and its withAlpha rgba form) must be absent.
    expect(chip.outerHTML).not.toContain("#f59e0b");
    expect(chip.outerHTML).not.toContain("rgba(245, 158, 11");

    // The always-visible caption BELOW the bubble: right-aligned mono 10px
    // "queued" (touch never sees hover — the state must not hide).
    const caption = chip.querySelector('[data-testid="queued-state-caption"]') as HTMLElement;
    expect(caption.textContent).toBe("queued");
    expect(caption.className).toContain("justify-end");
    expect(caption.className).toContain("font-mono");
    expect(caption.className).toContain("text-[10px]");
    // The hover-cluster state indicator + BOTH affordances ride the bubble's
    // reveal row (idle here — the folded row, no busy slice).
    expect(chip.querySelector('[data-testid="queued-hover-state"]')?.textContent).toContain("queued");
    expect(chip.querySelector("[data-queued-send-now]")).not.toBeNull();
    expect(chip.querySelector("[data-queued-remove]")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Send the queued message now" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove the queued message" })).toBeTruthy();

    // The rail keeps its honest queued node (hollow dot + sr-only label).
    const node = document.querySelector('[data-timeline-kind="queued"]');
    expect(node).not.toBeNull();
    expect(node?.querySelector(".sr-only")?.textContent).toContain("Queued message");

    // The affordances still FIRE through the new chrome: X-remove → DELETE
    // /sessions/:id/queue/:seq.
    fireEvent.click(screen.getByRole("button", { name: "Remove the queued message" }));
    await waitFor(() => expect(queueMock.dequeueSessionMessage).toHaveBeenCalledWith("sess_r119c_idiom", 3), SLOW);
  });
});

// ── R94-D2: stick-to-bottom auto-scroll ──────────────────────────────────────
// Owner (v0.91.0): "While the agent is doing its work, I should be able to
// scroll the chat up and down without it automatically re-scrolling to the
// very bottom. It should only auto-scroll if I have moved to the very bottom."
//
// happy-dom has NO layout — scrollHeight/clientHeight are 0 and the built-in
// scrollTo is a no-op that fires no events — so these tests assert on the
// LOGIC, not pixels: the scroll listener's pinned state, whether the
// auto-scroll path calls el.scrollTo, and the pill's presence. Where a real
// distance-from-bottom is needed the test gives the container a geometry via
// Object.defineProperty, and user gestures are dispatched exactly as the
// browser would (wheel / scroll / scrollend events).
describe("AgentChatPanel stick-to-bottom (R94-D2)", () => {
  const SLOW = { timeout: 5000 };
  const SESSION_ID = "sess_r94_scroll";

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

  /** A transcript with history (so there is somewhere to scroll up to) bound
   * to the first fixture project; returns the chat scroll container. */
  async function renderScrollPanel(): Promise<HTMLElement> {
    const projects = await getFixtureProjects().list();
    customBackend.backend = createFixtureSessions([
      {
        session: {
          id: SESSION_ID,
          projectId: projects[0].id,
          agentId: "agt_scribe",
          mode: "single",
          status: "running",
          title: "Scroll probe",
          createdAt: "2026-10-01T10:00:00Z",
          updatedAt: "2026-10-01T10:05:00Z",
        },
        events: [
          messageEvent(1, "user", "long running question", "2026-10-01T10:00:10Z"),
          messageEvent(2, "assistant", "working on it", "2026-10-01T10:00:20Z"),
        ],
      },
    ]);
    renderWithProviders(<AgentChatPanel projectId={projects[0].id} project={projects[0]} />);
    await screen.findByText("long running question", {}, SLOW);
    const scroller = document.querySelector(
      'div[class*="overflow-y-auto"][class*="overflow-x-hidden"]',
    ) as HTMLElement;
    expect(scroller).toBeTruthy();
    return scroller;
  }

  /** Arm the store's live turn exactly like a streaming tick would (the same
   * full-slice shape the rest of this suite builds). */
  function armLiveTurn(streamText: string): void {
    useStreamStore.setState({
      bySession: {
        [SESSION_ID]: {
          liveTurn: {
            startedAtMs: Date.now() - 3000,
            working: [],
            streamText,
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
          queueKeptNotice: null,
          remote: false,
        },
      },
    });
  }

  /** R95-D: arm the live turn with a LIVE THINKING BLOCK — a tool entry
   * makes the segment render as a live WorkingSection (a thinking-only
   * turn renders bare, where no row carries the live marker), and
   * streamThinking appends the in-flight thought the section marks live
   * (auto-expanded, its body the data-thinking-scroll scroller the owner
   * reads while sitting at the transcript bottom). */
  function armLiveThinkingTurn(thinkingText: string, streamText: string): void {
    useStreamStore.setState({
      bySession: {
        [SESSION_ID]: {
          liveTurn: {
            startedAtMs: Date.now() - 3000,
            working: [
              {
                type: "tool",
                tool: {
                  seq: 7,
                  toolName: "read_file",
                  argsSummary: "path: src/app.ts",
                  ok: null,
                  ts: "2026-10-01T10:01:00Z",
                },
              },
            ],
            streamText,
            streamThinking: thinkingText,
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
          queueKeptNotice: null,
          remote: false,
        },
      },
    });
  }

  /** Give the container a geometry (2000px of content in a 500px viewport)
   * so distance-from-bottom is real in the no-layout happy-dom world. */
  function giveGeometry(el: HTMLElement): void {
    Object.defineProperty(el, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 500, configurable: true });
  }

  const pill = () => screen.queryByRole("button", { name: "Jump to the latest message" });

  beforeEach(() => {
    streamMock.streamSessionMessage.mockReset().mockResolvedValue(undefined);
  });

  it("while pinned, every content tick smooth-scrolls to the bottom (the R37/R64 follow contract) and NO pill renders", async () => {
    const scroller = await renderScrollPanel();
    const scrollTo = vi.fn();
    scroller.scrollTo = scrollTo;

    armLiveTurn("the first streaming chunk");
    await screen.findByText(/first streaming chunk/, {}, SLOW);
    await waitFor(() => expect(scrollTo).toHaveBeenCalled());
    expect(scrollTo.mock.calls[0][0]).toMatchObject({ behavior: "smooth" });

    // Growth follows too — and the pill stays hidden while pinned.
    scrollTo.mockClear();
    armLiveTurn("the first streaming chunk — and then it kept growing");
    await screen.findByText(/kept growing/, {}, SLOW);
    await waitFor(() => expect(scrollTo).toHaveBeenCalled());
    expect(pill()).toBeNull();
  });

  it("wheel-up mid-turn DETACHES: further streaming ticks never move the viewport, and the Jump-to-latest pill appears", async () => {
    const scroller = await renderScrollPanel();
    const scrollTo = vi.fn();
    scroller.scrollTo = scrollTo;
    armLiveTurn("the first streaming chunk");
    await screen.findByText(/first streaming chunk/, {}, SLOW);

    // The user scrolls UP over the transcript (the owner's field report).
    fireEvent.wheel(scroller, { deltaY: -120 });
    expect(
      await screen.findByRole("button", { name: "Jump to the latest message" }, SLOW),
    ).toBeTruthy();

    // New content lands — their viewport must stay exactly where it is.
    scrollTo.mockClear();
    armLiveTurn("the first streaming chunk — and then it kept growing");
    await screen.findByText(/kept growing/, {}, SLOW);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("scrolling back to the bottom RE-PINS: the next tick follows again and the pill hides", async () => {
    const scroller = await renderScrollPanel();
    const scrollTo = vi.fn();
    scroller.scrollTo = scrollTo;
    armLiveTurn("the first streaming chunk");
    await screen.findByText(/first streaming chunk/, {}, SLOW);
    fireEvent.wheel(scroller, { deltaY: -120 });
    await screen.findByRole("button", { name: "Jump to the latest message" }, SLOW);

    // The user returns to the very bottom (a scrollbar drag all the way
    // down — distance 0, well inside the 96px pin threshold).
    giveGeometry(scroller);
    scroller.scrollTop = 2000;
    fireEvent.scroll(scroller);

    await waitFor(() => expect(pill()).toBeNull(), SLOW);
    scrollTo.mockClear();
    armLiveTurn("the first streaming chunk — resumed following the stream");
    await screen.findByText(/resumed following/, {}, SLOW);
    await waitFor(() => expect(scrollTo).toHaveBeenCalled());
  });

  it("a scrollbar DRAG (plain scroll events) detaches once no programmatic scroll is in flight", async () => {
    const scroller = await renderScrollPanel();
    armLiveTurn("the first streaming chunk");
    await screen.findByText(/first streaming chunk/, {}, SLOW);

    // scrollend: the browser settled our last programmatic follow — from
    // here every scroll event is the user's.
    scroller.dispatchEvent(new Event("scrollend"));
    giveGeometry(scroller);
    scroller.scrollTop = 100; // deep in history: 1400px from the bottom
    fireEvent.scroll(scroller);

    expect(
      await screen.findByRole("button", { name: "Jump to the latest message" }, SLOW),
    ).toBeTruthy();
  });

  it("the smooth-scroll trap: intermediate positions of OUR OWN follow never detach — but the user fighting it (moving UP mid-flight) does", async () => {
    const scroller = await renderScrollPanel();
    giveGeometry(scroller);
    armLiveTurn("the first streaming chunk"); // effect scrolls → flight armed
    await screen.findByText(/first streaming chunk/, {}, SLOW);

    // Our follow on its way DOWN (scrollTop rising toward the target): an
    // intermediate position — ignored, still pinned, no pill.
    scroller.scrollTop = 300;
    fireEvent.scroll(scroller);
    expect(pill()).toBeNull();

    // The user fights the follow (scrollTop falls mid-flight) → detach.
    scroller.scrollTop = 150;
    fireEvent.scroll(scroller);
    expect(
      await screen.findByRole("button", { name: "Jump to the latest message" }, SLOW),
    ).toBeTruthy();
  });

  it("the pill floats ABOVE the composer as an overlay — outside the scroll container, so the transcript scrolls under it", async () => {
    const scroller = await renderScrollPanel();
    armLiveTurn("the first streaming chunk");
    await screen.findByText(/first streaming chunk/, {}, SLOW);
    fireEvent.wheel(scroller, { deltaY: -120 });
    const button = await screen.findByRole("button", { name: "Jump to the latest message" });

    // A sibling of the scroller (inside the scroll-body wrapper)…
    expect(button.parentElement).toBe(scroller.parentElement);
    // …never inside the scroller itself (no covering the streaming text).
    expect(scroller.contains(button)).toBe(false);
    expect(button.className).toContain("absolute");
  });

  it("clicking the pill re-pins + smooth-scrolls to the bottom, and the pill hides", async () => {
    const scroller = await renderScrollPanel();
    const scrollTo = vi.fn();
    scroller.scrollTo = scrollTo;
    armLiveTurn("the first streaming chunk");
    await screen.findByText(/first streaming chunk/, {}, SLOW);
    fireEvent.wheel(scroller, { deltaY: -120 });
    const button = await screen.findByRole("button", { name: "Jump to the latest message" });

    scrollTo.mockClear();
    fireEvent.click(button);
    await waitFor(() => expect(scrollTo).toHaveBeenCalled(), SLOW);
    expect(scrollTo.mock.calls[0][0]).toMatchObject({ behavior: "smooth" });
    await waitFor(() => expect(pill()).toBeNull(), SLOW);
  });

  it("the user's own send (queued mid-turn — the owner's send-while-working flow) ALWAYS re-pins", async () => {
    const scroller = await renderScrollPanel();
    const scrollTo = vi.fn();
    scroller.scrollTo = scrollTo;
    armLiveTurn("the first streaming chunk");
    await screen.findByText(/first streaming chunk/, {}, SLOW);
    fireEvent.wheel(scroller, { deltaY: -120 });
    await screen.findByRole("button", { name: "Jump to the latest message" }, SLOW);

    scrollTo.mockClear();
    fireEvent.change(screen.getByLabelText("Message composer"), {
      target: { value: "come back down" },
    });
    fireEvent.keyDown(screen.getByLabelText("Message composer"), { key: "Enter" });

    // runTurn re-pinned before anything else: the follow fired and the
    // message took the QUEUE path (a live turn is running).
    await waitFor(() => expect(scrollTo).toHaveBeenCalled(), SLOW);
    await waitFor(
      () =>
        expect(queueMock.queueSessionMessage).toHaveBeenCalledWith(SESSION_ID, {
          content: "come back down",
        }),
      SLOW,
    );
    await waitFor(() => expect(pill()).toBeNull(), SLOW);
  });

  it("the user's own send from an IDLE detached position re-pins and starts the normal turn", async () => {
    const scroller = await renderScrollPanel();
    const scrollTo = vi.fn();
    scroller.scrollTo = scrollTo;

    // Idle transcript (no live turn): detach by wheel-up, then send.
    fireEvent.wheel(scroller, { deltaY: -120 });

    scrollTo.mockClear();
    fireEvent.change(screen.getByLabelText("Message composer"), {
      target: { value: "take this too" },
    });
    fireEvent.keyDown(screen.getByLabelText("Message composer"), { key: "Enter" });

    // The send re-pinned (the follow fired) and went through the NORMAL
    // stream path (idle → no queue).
    await waitFor(() => expect(scrollTo).toHaveBeenCalled(), SLOW);
    await waitFor(
      () =>
        expect(streamMock.streamSessionMessage).toHaveBeenCalledWith(
          SESSION_ID,
          "take this too",
          expect.any(Function),
          expect.anything(),
        ),
      SLOW,
    );
  });

  // ── R95-D: nested-scroller wheel chaining ─────────────────────────────────
  // Owner (v0.91.0): "The Jump to Latest button was showing even though I
  // was at the very bottom of it… The Jump to Latest button apparently was
  // not working properly in the thinking area." Root cause: the wheel
  // event BUBBLES out of the live thinking block, so wheeling up INSIDE it
  // detached the transcript pin even though the block itself consumed the
  // scroll — the pill then appeared at the very bottom and its jump moved
  // nothing. The chaining rule: an upward wheel belongs to the transcript
  // only once every nested scroller between the cursor and it is at its
  // own top.
  it("R95-D: wheeling UP inside the live thinking block (scrolled past its own top) does NOT detach the transcript — no pill, and the follow keeps running", async () => {
    const scroller = await renderScrollPanel();
    const scrollTo = vi.fn();
    scroller.scrollTo = scrollTo;
    armLiveThinkingTurn("the live thinking tail grows here", "the streaming answer text");
    await screen.findByText(/live thinking tail/, {}, SLOW);
    const inner = document.querySelector("[data-thinking-scroll]") as HTMLElement;
    expect(inner).toBeTruthy();

    // The user wheels UP over the thinking block while it sits scrolled
    // into its own content (scrollTop 80 — the block consumes the wheel).
    inner.scrollTop = 80;
    fireEvent.wheel(inner, { deltaY: -120 });
    expect(pill()).toBeNull(); // the transcript is still at the very bottom

    // The transcript keeps following its own stream (the R37/R64 contract
    // survived the wheel — the pill's "not working" report is dead).
    scrollTo.mockClear();
    armLiveThinkingTurn(
      "the live thinking tail grows here — and more",
      "the streaming answer text — and more",
    );
    await screen.findByText(/streaming answer text — and more/, {}, SLOW);
    await waitFor(() => expect(scrollTo).toHaveBeenCalled(), SLOW);
    expect(pill()).toBeNull();
  });

  it("R95-D: once the thinking block is at its OWN top, the wheel chains to the transcript and detaches (the honest chaining rule)", async () => {
    await renderScrollPanel();
    armLiveThinkingTurn("the live thinking tail grows here", "the streaming answer text");
    await screen.findByText(/live thinking tail/, {}, SLOW);
    const inner = document.querySelector("[data-thinking-scroll]") as HTMLElement;

    // The block cannot scroll up anymore (its scrollTop is 0): the browser
    // chains the wheel outward to the transcript — detaching is correct.
    inner.scrollTop = 0;
    fireEvent.wheel(inner, { deltaY: -120 });
    expect(
      await screen.findByRole("button", { name: "Jump to the latest message" }, SLOW),
    ).toBeTruthy();
  });

  // ── R96-E: the thinking-FIRST live segment ────────────────────────────────
  // Owner (v0.93.0): "the thinking was still not proper. It was not
  // auto-scrolling to the very bottom." Root cause: a live thought with NO
  // tool entries yet — the norm at every turn's start — fell to
  // BareWorkingEntries, which never passes `live` down: no auto-expand, no
  // stick-to-bottom, no jump pill. The fix: the segment carrying the live
  // entry renders as a LIVE WorkingSection.
  function armLiveThinkingOnlyTurn(thinkingText: string, streamText: string): void {
    useStreamStore.setState({
      bySession: {
        [SESSION_ID]: {
          liveTurn: {
            startedAtMs: Date.now() - 3000,
            working: [],
            streamText,
            streamThinking: thinkingText,
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
          queueKeptNotice: null,
          remote: false,
        },
      },
    });
  }

  it("R96-E: a thinking-first live turn (no tool entries yet) renders a LIVE working section — auto-expanded, with its own scroller and the live marker", async () => {
    const scroller = await renderScrollPanel();
    const scrollTo = vi.fn();
    scroller.scrollTo = scrollTo;
    armLiveThinkingOnlyTurn("the very first thought of the turn", "");

    // The section header reads "Working" (a live section owns the thought —
    // not the bare, live-less rendering of before).
    expect(await screen.findByText("Working", {}, SLOW), "the live section header").toBeTruthy();

    // The thought row is AUTO-EXPANDED (live) and its stick-to-bottom
    // scroller is attached — the data-thinking-scroll body exists.
    const inner = await waitFor(() => {
      const el = document.querySelector("[data-thinking-scroll]") as HTMLElement | null;
      expect(el, "the thinking scroller").toBeTruthy();
      return el as HTMLElement;
    }, SLOW);
    await screen.findByText(/the very first thought of the turn/, {}, SLOW);

    // Give the scroller a geometry and land it AT its bottom (scrollTop =
    // scrollHeight - clientHeight = 1500 → distance 0 → PINNED) — growth
    // then follows its own stream.
    giveGeometry(inner);
    inner.scrollTop = 1500;
    fireEvent.scroll(inner);
    scrollTo.mockClear();
    armLiveThinkingOnlyTurn("the very first thought of the turn — and it keeps going", "");
    await screen.findByText(/it keeps going/, {}, SLOW);

    // While pinned at the thinking block's own bottom, no inner jump pill
    // renders (it appears only when the user scrolls UP inside it).
    expect(screen.queryByTestId("thinking-jump-latest")).toBeNull();
  });
});

// ── ROUND-117 (R117-f): the PC transcript quality wave's panel legs ─────────
// Deliverable 2 — DELIVERY TICKS on user messages (mobile R116-m parity, the
// minimal honest PC version): the optimistic echo renders a subtle "…"
// ("sending") until the turn acks (the turn.started model stamp / first
// content frame — liveTurnAcked), the single check ("sent") after, and a
// PERSISTED message.user row renders NO glyph. The REMOTE bubble is born
// from the ack frame itself → it enters at "sent" (mobile's exact rule).
// Deliverable 3 — the BREATHING thinking placeholder (dot + "Thinking" +
// the resolved model) replaces the plain mono line.
describe("AgentChatPanel R117-f delivery ticks + breathing placeholder", () => {
  const SLOW = { timeout: 5000 };

  /** A minimal live-mode session with NO events (the optimistic echo owns the
   * transcript until the fold lands). */
  async function renderEchoProbe(sessionId: string) {
    const projects = await getFixtureProjects().list();
    customBackend.backend = createFixtureSessions([
      {
        session: {
          id: sessionId,
          projectId: projects[0].id,
          agentId: "agt_scribe",
          mode: "single",
          status: "completed",
          title: "echo probe",
          createdAt: "2026-09-22T12:00:00Z",
          updatedAt: "2026-09-22T12:05:00Z",
        },
        events: [],
      },
    ]);
    renderWithProviders(<AgentChatPanel projectId={projects[0].id} project={projects[0]} />);
    await waitFor(() => expect(document.querySelector("[data-empty-state]")).toBeTruthy(), SLOW);
  }

  /** The fresh-turn liveTurn shape exactly as startStream seeds it (NO
   * evidence the turn acked yet: no model stamp, no content). */
  const freshLiveTurn = (): LiveTurn => ({
    startedAtMs: Date.now() - 500,
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
  });

  const sliceWith = (liveTurn: LiveTurn | null, extra: Record<string, unknown> = {}) => ({
    liveTurn,
    streamBusy: liveTurn !== null,
    sendError: null,
    liveError: null,
    pendingEcho: "hello there",
    lastLiveEndMs: 0,
    lastTurnStoppedByUser: false,
    lastTurnStoppedTs: null,
    queued: [],
    deliveredQueued: [],
    queueKeptNotice: null,
    remote: false,
    ...extra,
  });

  it("the optimistic echo's tick: '…' while the POST is in flight → the single check the moment the turn acks", async () => {
    await renderEchoProbe("sess_r117f_echo");
    useStreamStore.setState({ bySession: { sess_r117f_echo: sliceWith(null) } });
    // The echo bubble + the SENDING rung (no liveTurn yet — the POST/stream
    // has not opened; the subtle "…" beat).
    expect(await screen.findByText("hello there", {}, SLOW)).toBeTruthy();
    const sending = await waitFor(() => {
      const tick = document.querySelector('[data-testid="user-delivery-tick"]');
      expect(tick).not.toBeNull();
      return tick as HTMLElement;
    }, SLOW);
    expect(sending.getAttribute("data-delivery")).toBe("sending");
    expect(sending.textContent).toContain("…");

    // The stream opens (startStream seeds the fresh turn) but NO ack evidence
    // yet — still "sending" (the honest generalization: no model stamp, no
    // content frame, nothing).
    useStreamStore.setState({ bySession: { sess_r117f_echo: sliceWith(freshLiveTurn()) } });
    await waitFor(() => {
      expect(
        document.querySelector('[data-testid="user-delivery-tick"]')?.getAttribute("data-delivery"),
      ).toBe("sending");
    }, SLOW);

    // The turn.started ack lands (the model stamp — R114-e) → the SINGLE
    // CHECK (the message is with the agent).
    useStreamStore.setState({
      bySession: { sess_r117f_echo: sliceWith({ ...freshLiveTurn(), model: "z-ai/glm-4.7" }) },
    });
    await waitFor(() => {
      const tick = document.querySelector('[data-testid="user-delivery-tick"]');
      expect(tick?.getAttribute("data-delivery")).toBe("sent");
      // The single check glyph (mobile's exact spec: Check 12 / 2.4).
      expect(tick?.querySelector("svg")).not.toBeNull();
    }, SLOW);
  });

  it("a PERSISTED message.user row renders NO glyph (the fold is the receipt — the tick never survives the fold)", async () => {
    const projects = await getFixtureProjects().list();
    customBackend.backend = createFixtureSessions([
      {
        session: {
          id: "sess_r117f_folded",
          projectId: projects[0].id,
          agentId: "agt_scribe",
          mode: "single",
          status: "completed",
          title: "fold probe",
          createdAt: "2026-09-22T12:00:00Z",
          updatedAt: "2026-09-22T12:05:00Z",
        },
        events: [
          {
            seq: 1,
            type: "message.user",
            agentId: "agt_scribe",
            payload: { role: "user", content: "hello there", agentId: "agt_scribe", ts: "2026-09-22T12:00:10Z" },
            ts: "2026-09-22T12:00:10Z",
          },
        ],
      },
    ]);
    renderWithProviders(<AgentChatPanel projectId={projects[0].id} project={projects[0]} />);
    await waitFor(() => expect(screen.getByText("hello there")).toBeTruthy(), SLOW);
    // The folded log already owns the row — no optimistic echo (content
    // dedupe), and the persisted bubble carries NO delivery glyph at all.
    expect(document.querySelector('[data-testid="user-delivery-tick"]')).toBeNull();
  });

  it("the REMOTE turn's bubble is born from the ack frame itself → it enters at 'sent' (mobile's rule)", async () => {
    await renderEchoProbe("sess_r117f_remote");
    useStreamStore.setState({
      bySession: {
        sess_r117f_remote: sliceWith(
          { ...freshLiveTurn(), model: "z-ai/glm-4.7", userText: "hey from the phone" },
          { remote: true, streamBusy: false },
        ),
      },
    });
    expect(await screen.findByText("hey from the phone", {}, SLOW)).toBeTruthy();
    const tick = await waitFor(() => {
      const el = document.querySelector('[data-testid="user-delivery-tick"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    }, SLOW);
    expect(tick.getAttribute("data-delivery")).toBe("sent");
  });

  it("the BREATHING thinking placeholder: pulsing accent dot + 'Thinking' + the resolved model (replaces the plain mono line)", async () => {
    await renderEchoProbe("sess_r117f_thinking");
    useStreamStore.setState({
      bySession: {
        sess_r117f_thinking: {
          liveTurn: { ...freshLiveTurn(), model: "z-ai/glm-4.7" },
          streamBusy: true,
          sendError: null,
          liveError: null,
          pendingEcho: null,
          lastLiveEndMs: 0,
          lastTurnStoppedByUser: false,
          lastTurnStoppedTs: null,
          queued: [],
          deliveredQueued: [],
          queueKeptNotice: null,
          remote: false,
        },
      },
    });
    const placeholder = await waitFor(() => {
      const el = document.querySelector('[data-testid="thinking-placeholder"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    }, SLOW);
    // The breathing accent dot (the app's shared live-dot animation)…
    expect(placeholder.querySelector(".ac-pulse")).not.toBeNull();
    // …the word…
    expect(screen.getByText("Thinking")).toBeTruthy();
    // …and the turn's resolved model in micro mono (the stream knows it —
    // the turn.started stamp).
    expect(placeholder.textContent).toContain("z-ai/glm-4.7");
  });
});
