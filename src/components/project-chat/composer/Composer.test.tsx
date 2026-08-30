// @vitest-environment happy-dom
/**
 * ROUND-50 (R50-c2) tests — the owner-spec composer, rendered through
 * AgentChatPanel (integration, the same backend-selector mock pattern as
 * AgentChatPanel.test.tsx):
 *
 *  - the toolbar renders INSIDE the composer box (owner: "These options will
 *    not be shown below it but inside the chat section itself");
 *  - empty state: the composer sits centered, pushed below the middle of the
 *    pane, with the suggestion chips above it; once the conversation exists
 *    it docks to the bottom edge;
 *  - Add Context: OS-picker attach flow (pickFilesViaBackend +
 *    readAttachmentFiles → chips → the SEND BODY carries the attachments);
 *    per-file read errors surface as toasts, never silently;
 *  - drag-and-drop reads dropped Files client-side (FileReader) into chips;
 *  - the @ quick-picker filters project files live and attaches on pick;
 *  - the mode switcher PATCHes /sessions/:id/permissions with an optimistic
 *    update + rollback on failure;
 *  - the thinking-level popover offers EXACTLY 4 options and persists per
 *    session (localStorage);
 *  - the model selector shows `Provider · model`, lists providers, opens a
 *    hover flyout of that provider's models, selects + persists the override
 *    per session, and Manage Models / Configure navigate to /settings?tab=api;
 *  - the context donut renders from GET /sessions/:id/context with the full
 *    breakdown / cache / session-totals popover;
 *  - the send button's disabled states.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation, useSearchParams } from "react-router";
import type { ReactNode } from "react";
import { AgentChatPanel } from "../AgentChatPanel";
import { getFixtureProjects } from "../../../lib/project-fixtures";
import { createFixtureSessions } from "../../../lib/session-fixtures";
import {
  fetchProviders,
  fetchSessionContext,
  fetchProviderModels,
  patchSessionPermissions,
  pickFilesViaBackend,
  readAttachmentFiles,
  streamSessionMessage,
  type Project,
  type SessionContextReport,
  type SessionDetail,
  type SessionEvent,
  type SessionsBackend,
  type ProviderView,
} from "../../../lib/api";
import { useConfigStore } from "../../../lib/config-store";
import { useNotificationStreamStore } from "../../../hooks/use-notifications";
import { useSettingsStore } from "../../../lib/settings-store";
import { useStreamStore } from "../../../lib/stream-store";
import { renderWithProviders, resetTestState } from "../../../test-utils";

const MODELS = [
  "z-ai/glm-5.2:free",
  "openrouter/ox-alpha", // paid (the agent fixture's own model)
  "openrouter/gpt-5.2", // paid
];

const PROVIDERS: ProviderView[] = [
  {
    id: "openrouter",
    name: "OpenRouter",
    kind: "openrouter-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    enabled: true,
    createdAt: "2026-08-20T09:00:00Z",
    hasKey: true,
  },
  {
    id: "z-ai",
    name: "Z.AI",
    kind: "openai-compatible",
    baseUrl: "https://api.z.ai/v1",
    enabled: true,
    createdAt: "2026-08-20T09:01:00Z",
    hasKey: true,
  },
];

const CONTEXT_REPORT: SessionContextReport = {
  model: "openrouter/ox-alpha",
  providerId: "openrouter",
  contextWindow: 1_000_000,
  usedTokens: 420_000,
  breakdown: {
    systemPrompt: 9_000,
    systemTools: 1_000,
    memory: 4_000,
    messages: 400_000,
    meta: 6_000,
    mcpTools: 0,
  },
  cache: { inputTokens: 100_000, cachedInputTokens: 82_000, hitRate: 0.82 },
  sessionTotals: { inputTokens: 250_000, outputTokens: 12_000, requests: 7, costUsd: 0.1234 },
};

const SESSION_ID = "sess_c2_probe";

/** A completed GET /sessions/:id shape for the PATCH mock's response. */
const PATCHED_DETAIL: SessionDetail = {
  id: SESSION_ID,
  projectId: null,
  agentId: "agt_scribe",
  mode: "single",
  status: "completed",
  title: "Composer probe",
  createdAt: "2026-08-26T10:00:00Z",
  updatedAt: "2026-08-26T10:05:00Z",
  permissionMode: "plan",
  events: [],
  lastSeq: 0,
};

/** ROUND-44-style per-test override for getSessionsBackend(). */
const customBackend = vi.hoisted((): { backend: SessionsBackend | null } => ({
  backend: null,
}));

vi.mock("../../../lib/api", async () => {
  const mod = await import("../../../lib/api");
  const agentsFx = await import("../../../lib/agent-fixtures");
  const projectsFx = await import("../../../lib/project-fixtures");
  const sessionsFx = await import("../../../lib/session-fixtures");
  return {
    ...mod,
    getAgentsBackend: () => agentsFx.getFixtureAgents(),
    getProjectsBackend: () => projectsFx.getFixtureProjects(),
    getSessionsBackend: () => customBackend.backend ?? sessionsFx.getFixtureSessions(),
    fetchProviderModels: vi.fn(async () => [...MODELS]),
    fetchProviders: vi.fn(async () => PROVIDERS.map((p) => ({ ...p }))),
    pickFilesViaBackend: vi.fn(async () => [] as string[]),
    readAttachmentFiles: vi.fn(async () => [] as never[]),
    patchSessionPermissions: vi.fn(async () => PATCHED_DETAIL),
    fetchSessionContext: vi.fn(async () => CONTEXT_REPORT),
    streamSessionMessage: vi.fn(async () => undefined),
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  resetTestState();
  useConfigStore.setState({ demoData: false }); // live mode: composer controls enabled
  useSettingsStore.setState({ modelsFreeOnly: true });
  customBackend.backend = null;
  useNotificationStreamStore.getState().reset();
  useStreamStore.setState({ bySession: {}, subagentsLive: {} });
  vi.mocked(fetchProviderModels).mockReset().mockResolvedValue([...MODELS]);
  vi.mocked(fetchProviders).mockReset().mockResolvedValue(PROVIDERS.map((p) => ({ ...p })));
  vi.mocked(pickFilesViaBackend).mockReset().mockResolvedValue([]);
  vi.mocked(readAttachmentFiles).mockReset().mockResolvedValue([]);
  vi.mocked(patchSessionPermissions).mockReset().mockResolvedValue(PATCHED_DETAIL);
  vi.mocked(fetchSessionContext).mockReset().mockResolvedValue(CONTEXT_REPORT);
  vi.mocked(streamSessionMessage).mockReset().mockResolvedValue(undefined);
});

/** Render the panel with an EMPTY transcript (no project-bound sessions). */
async function renderEmptyPanel() {
  const projects = await getFixtureProjects().list();
  return renderWithProviders(<AgentChatPanel projectId={projects[0].id} project={projects[0]} />);
}

/** Chat event exactly as the backend writes it. */
function messageEvent(seq: number, role: "user" | "assistant", content: string, ts: string): SessionEvent {
  return {
    seq,
    type: role === "user" ? "message.user" : "message.assistant",
    agentId: "agt_scribe",
    payload: { role, content, agentId: "agt_scribe", ts },
    ts,
  };
}

/** Render the panel with ONE persisted user turn (composer DOCKED at bottom). */
async function renderPanelWithConversation(): Promise<{ projectId: string }> {
  const projects = await getFixtureProjects().list();
  customBackend.backend = createFixtureSessions([
    {
      session: {
        id: SESSION_ID,
        projectId: projects[0].id,
        agentId: "agt_scribe",
        mode: "single",
        status: "completed",
        title: "Composer probe",
        createdAt: "2026-08-26T10:00:00Z",
        updatedAt: "2026-08-26T10:05:00Z",
      },
      events: [
        messageEvent(1, "user", "first question", "2026-08-26T10:00:10Z"),
        messageEvent(2, "assistant", "first answer", "2026-08-26T10:00:20Z"),
      ],
    },
  ]);
  renderWithProviders(<AgentChatPanel projectId={projects[0].id} project={projects[0]} />);
  return { projectId: projects[0].id };
}

/** The /settings route probe — shows its query string so the ?tab=api
 * deep-link (Manage Models / per-provider Configure) is assertable. */
function SettingsProbe() {
  const location = useLocation();
  return (
    <div>
      SETTINGS PAGE<span data-settings-search>{location.search}</span>
    </div>
  );
}

/** Round-30 contract: the ?session= param is the AUTHORITATIVE selection —
 * this harness flips it so a test can switch sessions in-place (exactly what
 * the sidebar's session rows do). */
function SessionSwitchHarness({
  projectId,
  project,
  target,
}: {
  projectId: string;
  project: Project;
  target: string;
}) {
  const [, setSearchParams] = useSearchParams();
  return (
    <div>
      <AgentChatPanel projectId={projectId} project={project} />
      <button type="button" onClick={() => setSearchParams({ session: target })}>
        Switch session
      </button>
    </div>
  );
}

/** Render with real routing so navigation assertions work (/settings route). */
async function renderPanelWithRoutes(): Promise<void> {
  const projects = await getFixtureProjects().list();
  customBackend.backend = createFixtureSessions([
    {
      session: {
        id: SESSION_ID,
        projectId: projects[0].id,
        agentId: "agt_scribe",
        mode: "single",
        status: "completed",
        title: "Composer probe",
        createdAt: "2026-08-26T10:00:00Z",
        updatedAt: "2026-08-26T10:05:00Z",
      },
      events: [messageEvent(1, "user", "first question", "2026-08-26T10:00:10Z")],
    },
  ]);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<AgentChatPanel projectId={projects[0].id} project={projects[0]} />} />
          <Route path="/settings" element={<SettingsProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// render is imported lazily to keep the import list tidy for the mock above.
async function render(ui: ReactNode): Promise<void> {
  const { render: r } = await import("@testing-library/react");
  r(ui);
}

const composerBox = (): HTMLElement => document.querySelector("[data-composer]") as HTMLElement;
const textarea = (): HTMLTextAreaElement =>
  screen.getByLabelText("Message composer") as HTMLTextAreaElement;

/** Wait for runTurn to FULLY settle (busy clears → the Send button returns in
 * place of Stop). Keeps the async send continuation inside the test's lifetime
 * so no setState races the environment teardown. */
async function sendSettled(): Promise<void> {
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send message" })).toBeTruthy(),
  );
}

// ── B. The composer box — toolbar INSIDE the box ─────────────────────────────
describe("Composer: toolbar inside the box (owner spec B)", () => {
  it("the box contains the textarea AND the toolbar row with all seven controls", async () => {
    await renderEmptyPanel();
    const box = composerBox();
    expect(box).toBeTruthy();
    expect(box.className).toContain("rounded-[18px]");
    expect(box.contains(textarea())).toBe(true);

    const toolbar = box.querySelector("[data-composer-toolbar]") as HTMLElement;
    expect(toolbar).toBeTruthy();
    // The toolbar is INSIDE the rounded box — the owner's core directive.
    expect(box.contains(toolbar)).toBe(true);

    // Left group: Add Context + mode switcher. Right group: donut + model +
    // thinking + send. (The box is one element; all buttons live within it.)
    for (const label of [
      "Add context",
      "Permission mode: Ask",
      "Context window usage",
      "Choose model",
      "Thinking level: Default",
      "Send message",
    ]) {
      const btn = screen.getByRole("button", { name: label });
      expect(box.contains(btn)).toBe(true);
    }
  });

  it("the old flat footer (ctx bar / hint text below the box) is gone", async () => {
    await renderEmptyPanel();
    expect(document.body.textContent).not.toContain("Ctrl K search");
    expect(document.body.textContent).not.toContain("to send");
    expect(screen.queryByText(/^ctx$/)).toBeNull();
  });
});

// ── A. Empty state — composer centered, lower half ───────────────────────────
describe("Composer: empty-state placement (owner spec A)", () => {
  it("EMPTY transcript: composer inside the scroller, below the middle, chips above it", async () => {
    await renderEmptyPanel();

    const emptyState = document.querySelector("[data-empty-state]") as HTMLElement;
    expect(emptyState).toBeTruthy();
    const box = composerBox();
    expect(emptyState.contains(box)).toBe(true);

    // The composer reflows inside the scroll column — NOT absolutely
    // positioned, and there is no docked bottom composer in this state.
    const scroller = document.querySelector('div[class*="overflow-y-auto"]');
    expect(scroller?.contains(box)).toBe(true);
    expect(document.querySelector("[data-composer-dock]")).toBeNull();

    // Spacer approach: the top spacer is SMALLER than the bottom spacer —
    // the composer sits "a bit more towards the bottom half".
    const topSpacer = emptyState.querySelector(".flex-\\[0\\.45\\]");
    const bottomSpacer = emptyState.querySelector(".flex-\\[0\\.55\\]");
    expect(topSpacer).toBeTruthy();
    expect(bottomSpacer).toBeTruthy();
    expect(
      topSpacer!.compareDocumentPosition(bottomSpacer!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // Suggestion chips render ABOVE the composer (DOM order) — they load
    // with the agents query, so await them.
    const chip = await screen.findByRole("button", { name: /Explore this project/i });
    expect(
      chip.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("conversation exists: the composer DOCKS at the bottom, outside the scroller", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    const dock = document.querySelector("[data-composer-dock]") as HTMLElement;
    expect(dock).toBeTruthy();
    const box = composerBox();
    expect(dock.contains(box)).toBe(true);
    const scroller = document.querySelector('div[class*="overflow-y-auto"]');
    expect(scroller?.contains(box)).toBe(false);
    // No empty-state wrapper anymore.
    expect(document.querySelector("[data-empty-state]")).toBeNull();
  });
});

// ── C. Add Context ────────────────────────────────────────────────────────────
describe("Composer: Add Context (owner spec C)", () => {
  it("menu opens with both entry points + the @ hint line", async () => {
    await renderEmptyPanel();
    fireEvent.click(screen.getByRole("button", { name: "Add context" }));
    expect(await screen.findByRole("menu", { name: "Add context" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Attach files…/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Add project files…/ })).toBeTruthy();
    expect(screen.getByText("type @ to mention a project file")).toBeTruthy();
  });

  it("Attach files… → OS picker → read → chip; the SEND BODY carries the attachment", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    vi.mocked(pickFilesViaBackend).mockResolvedValue(["C:\\Users\\dev\\notes.md"]);
    vi.mocked(readAttachmentFiles).mockResolvedValue([
      {
        path: "C:\\Users\\dev\\notes.md",
        name: "notes.md",
        size: 2048,
        text: "# notes",
        truncated: false,
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Add context" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Attach files…/ }));

    // The chip appears: name + human size.
    await waitFor(() => expect(screen.getByText("notes.md")).toBeTruthy());
    expect(screen.getByText("2.0 KB")).toBeTruthy();

    // Sending carries the attachment (name/path/size/text) + the default
    // thinking level through the streamed send path.
    fireEvent.change(textarea(), { target: { value: "read the notes" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(streamSessionMessage).toHaveBeenCalled());
    const [sid, content, , opts] = vi.mocked(streamSessionMessage).mock.calls[0];
    expect(sid).toBe(SESSION_ID);
    expect(content).toBe("read the notes");
    expect(opts?.attachments).toEqual([
      { name: "notes.md", path: "C:\\Users\\dev\\notes.md", size: 2048, text: "# notes" },
    ]);
    // The default thinking level is omitted from the wire body by api.ts —
    // the composer passes it, api drops it (tested in api.test.ts).
    expect(opts?.thinkingLevel).toBe("default");

    // Chips are per-composer: they cleared with the send.
    await waitFor(() => expect(screen.queryByText("notes.md")).toBeNull());
    await sendSettled();
  });

  it("per-file read errors surface as a toast — never silent, no chip", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    vi.mocked(pickFilesViaBackend).mockResolvedValue(["/gone.txt"]);
    vi.mocked(readAttachmentFiles).mockResolvedValue([
      { path: "/gone.txt", name: "gone.txt", size: 10, text: null, truncated: false, error: "file not found" },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Add context" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Attach files…/ }));

    await waitFor(() =>
      expect(useNotificationStreamStore.getState().lastNotification?.title).toBe(
        "File could not be read",
      ),
    );
    expect(screen.queryByText("gone.txt")).toBeNull();
  });

  it("Add project files… → searchable multi-select → relative paths read WITH the project id", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    const { projectId } = { projectId: "prj_seed_acute" };
    vi.mocked(readAttachmentFiles).mockResolvedValue([
      { path: "src/lib/util.ts", name: "util.ts", size: 204, text: "export const clamp", truncated: false },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Add context" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Add project files…/ }));

    // The searchable picker: filter the fixture tree live.
    const search = await screen.findByLabelText("Search project files");
    fireEvent.change(search, { target: { value: "util" } });
    const option = await screen.findByRole("option", { name: /util\.ts/ });
    fireEvent.click(option);
    fireEvent.click(screen.getByRole("button", { name: "Attach 1 project file" }));

    await waitFor(() =>
      expect(readAttachmentFiles).toHaveBeenCalledWith(["src/lib/util.ts"], projectId),
    );
    await waitFor(() => expect(screen.getByText("util.ts")).toBeTruthy());
  });

  it("staged chips are PER-SESSION — switching sessions drops them", async () => {
    const projects = await getFixtureProjects().list();
    customBackend.backend = createFixtureSessions([
      {
        session: {
          id: SESSION_ID,
          projectId: projects[0].id,
          agentId: "agt_scribe",
          mode: "single",
          status: "completed",
          title: "Session A",
          createdAt: "2026-08-26T10:00:00Z",
          updatedAt: "2026-08-26T10:05:00Z",
        },
        events: [messageEvent(1, "user", "first question", "2026-08-26T10:00:10Z")],
      },
      {
        session: {
          id: "sess_c2_other",
          projectId: projects[0].id,
          agentId: "agt_scribe",
          mode: "single",
          status: "completed",
          title: "Session B",
          createdAt: "2026-08-26T11:00:00Z",
          updatedAt: "2026-08-26T11:05:00Z",
        },
        events: [messageEvent(1, "user", "other question", "2026-08-26T11:00:10Z")],
      },
    ]);
    // The ?session= param is the authoritative selection (round-30 fix).
    renderWithProviders(<SessionSwitchHarness projectId={projects[0].id} project={projects[0]} target="sess_c2_other" />, {
      route: `/?session=${SESSION_ID}`,
    });
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    // Stage a chip on session A.
    vi.mocked(pickFilesViaBackend).mockResolvedValue(["C:\\notes.md"]);
    vi.mocked(readAttachmentFiles).mockResolvedValue([
      { path: "C:\\notes.md", name: "notes.md", size: 10, text: "x", truncated: false },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Add context" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Attach files…/ }));
    await waitFor(() => expect(screen.getByText("notes.md")).toBeTruthy());

    // Switch to session B — the chip must NOT ride into the other conversation.
    fireEvent.click(screen.getByRole("button", { name: "Switch session" }));
    expect(await screen.findByText("other question", {}, { timeout: 5000 })).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("notes.md")).toBeNull());
  });
});

// ── C (cont.) Drag-and-drop ──────────────────────────────────────────────────
describe("Composer: drag-and-drop (owner spec C)", () => {
  it("dropping a File reads it client-side (FileReader) into a chip; send carries the text", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    const box = composerBox();
    const file = new File(["dropped file body"], "dropped.txt", { type: "text/plain" });
    fireEvent.dragOver(box, { dataTransfer: { types: ["Files"] } });
    expect(box.getAttribute("data-dragging")).toBe("true"); // drop-highlight state
    fireEvent.drop(box, { dataTransfer: { files: [file] } });

    await waitFor(() => expect(screen.getByText("dropped.txt")).toBeTruthy());
    expect(box.getAttribute("data-dragging")).toBeNull();

    fireEvent.change(textarea(), { target: { value: "summarize the drop" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(streamSessionMessage).toHaveBeenCalled());
    const opts = vi.mocked(streamSessionMessage).mock.calls[0][3];
    expect(opts?.attachments).toEqual([
      { name: "dropped.txt", size: 17, text: "dropped file body" },
    ]);
    await sendSettled();
  });

  it("a binary drop (NUL bytes) becomes a chip with no readable text", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    const binary = new Uint8Array([0x00, 0x01, 0x02, 0x00]);
    const file = new File([binary], "blob.bin");
    fireEvent.drop(composerBox(), { dataTransfer: { files: [file] } });

    await waitFor(() => expect(screen.getByText("blob.bin")).toBeTruthy());
    expect(screen.getByText("no text")).toBeTruthy();
  });
});

// ── C (cont.) @ quick-picker ────────────────────────────────────────────────
describe("Composer: @ quick-picker (owner spec C)", () => {
  it("typing @ lists project files, filters live, Enter attaches + removes the @token", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    const ta = textarea();
    // "@" opens the popup with the fixture project's files (≤8 rows).
    fireEvent.change(ta, { target: { value: "look at @" } });
    await waitFor(() => expect(document.querySelector("[data-at-mention-picker]")).toBeTruthy());
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("option").length).toBeLessThanOrEqual(8);

    // Live filter: "@rea" narrows to README.md.
    fireEvent.change(ta, { target: { value: "look at @rea" } });
    await waitFor(() =>
      expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["README.md"]),
    );

    vi.mocked(readAttachmentFiles).mockResolvedValue([
      { path: "README.md", name: "README.md", size: 1204, text: "# ACUTE-CODE", truncated: false },
    ]);

    // Enter attaches the highlighted file and strips the @token.
    fireEvent.keyDown(ta, { key: "Enter" });
    await waitFor(() =>
      expect(readAttachmentFiles).toHaveBeenCalledWith(["README.md"], "prj_seed_acute"),
    );
    await waitFor(() => expect(screen.getByText("README.md")).toBeTruthy());
    await waitFor(() => expect(ta.value).toBe("look at "));
    expect(document.querySelector("[data-at-mention-picker]")).toBeNull();
  });

  it("Esc closes the popup for the current @ and keeps the text", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    const ta = textarea();
    fireEvent.change(ta, { target: { value: "hi @pack" } });
    await waitFor(() => expect(document.querySelector("[data-at-mention-picker]")).toBeTruthy());
    fireEvent.keyDown(ta, { key: "Escape" });
    expect(document.querySelector("[data-at-mention-picker]")).toBeNull();
    expect(ta.value).toBe("hi @pack");

    // Dismissal sticks for THIS @ occurrence (typing more does not reopen)…
    fireEvent.change(ta, { target: { value: "hi @packa" } });
    await waitFor(() => {
      // one render tick — the picker must stay closed
      expect(document.querySelector("[data-at-mention-picker]")).toBeNull();
    });
    // …but a NEW @ opens it again.
    fireEvent.change(ta, { target: { value: "hi @packa @" } });
    await waitFor(() => expect(document.querySelector("[data-at-mention-picker]")).toBeTruthy());
  });
});

// ── D. Mode switcher ─────────────────────────────────────────────────────────
describe("Composer: permission mode switcher (owner spec D)", () => {
  it("shows the session's mode (Ask default), PATCHes on change, label updates", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    const btn = screen.getByRole("button", { name: "Permission mode: Ask" });
    expect(btn.textContent).toContain("Ask");

    fireEvent.click(btn);
    const menu = await screen.findByRole("menu", { name: "Permission mode" });
    // All four modes with their one-line descriptions.
    expect(menu.textContent).toContain("Full Access");
    expect(menu.textContent).toContain("All tools auto-approved. No permission asks.");
    expect(menu.textContent).toContain("Ask");
    expect(menu.textContent).toContain("Asks before commands and external sites.");
    expect(menu.textContent).toContain("Plan");
    expect(menu.textContent).toContain("Read-only. Research and plan, no edits.");
    expect(menu.textContent).toContain("Editor");
    expect(menu.textContent).toContain("Edits files freely. No terminal. Deletes still ask.");

    fireEvent.click(screen.getByRole("menuitemradio", { name: /Plan/ }));

    await waitFor(() => expect(patchSessionPermissions).toHaveBeenCalledWith(SESSION_ID, "plan"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Permission mode: Plan" }).textContent).toContain("Plan"),
    );
  });

  it("the label flips OPTIMISTICALLY — before the PATCH round-trip resolves", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    // The PATCH never resolves: the label must ALREADY show Plan.
    vi.mocked(patchSessionPermissions).mockImplementation(() => new Promise(() => {}));
    fireEvent.click(screen.getByRole("button", { name: "Permission mode: Ask" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /Plan/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Permission mode: Plan" })).toBeTruthy(),
    );
  });

  it("a failed PATCH rolls the label back + surfaces the error", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    vi.mocked(patchSessionPermissions).mockRejectedValue(new Error("sidecar down"));
    fireEvent.click(screen.getByRole("button", { name: "Permission mode: Ask" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /Plan/ }));

    await waitFor(() =>
      expect(useNotificationStreamStore.getState().lastNotification?.title).toBe("Mode change failed"),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Permission mode: Ask" })).toBeTruthy(),
    );
  });

  it("the initial value comes from the session's own permissionMode", async () => {
    const projects = await getFixtureProjects().list();
    customBackend.backend = createFixtureSessions([
      {
        session: {
          id: SESSION_ID,
          projectId: projects[0].id,
          agentId: "agt_scribe",
          mode: "single",
          status: "completed",
          title: "Editor-mode session",
          createdAt: "2026-08-26T10:00:00Z",
          updatedAt: "2026-08-26T10:05:00Z",
          permissionMode: "editor",
        },
        events: [messageEvent(1, "user", "hello", "2026-08-26T10:00:10Z")],
      },
    ]);
    renderWithProviders(<AgentChatPanel projectId={projects[0].id} project={projects[0]} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Permission mode: Editor" })).toBeTruthy(),
    );
  });
});

// ── E. Thinking level ────────────────────────────────────────────────────────
describe("Composer: thinking level (owner spec E)", () => {
  it("EXACTLY four options; selection persists per session in localStorage", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Thinking level: Default" }));
    const options = screen.getAllByRole("menuitemradio");
    expect(options.map((o) => o.textContent)).toEqual([
      "DefaultThe model's own reasoning default.",
      "LowLight reasoning — fastest replies.",
      "HighDeeper reasoning for complex work.",
      "MaxMaximum reasoning effort.",
    ]);

    fireEvent.click(screen.getByRole("menuitemradio", { name: /High/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Thinking level: High" }).textContent).toContain("High"),
    );
    expect(window.localStorage.getItem(`acute-thinking:${SESSION_ID}`)).toBe("high");

    // The level rides the next send as thinkingLevel.
    fireEvent.change(textarea(), { target: { value: "think hard" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(streamSessionMessage).toHaveBeenCalled());
    expect(vi.mocked(streamSessionMessage).mock.calls[0][3]?.thinkingLevel).toBe("high");
    await sendSettled();
  });
});

// ── F. Model selector ────────────────────────────────────────────────────────
describe("Composer: model selector (owner spec F)", () => {
  it("button shows ProviderLabel · full-model-id (fallback providerId)", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    const btn = screen.getByRole("button", { name: "Choose model" });
    // Agent fixture: providerId "openrouter", model "openrouter/ox-alpha";
    // the providers list names it "OpenRouter".
    await waitFor(() => expect(btn.textContent).toContain("OpenRouter · openrouter/ox-alpha"));
    expect(btn.getAttribute("title")).toBe("OpenRouter · openrouter/ox-alpha");
  });

  it("popover lists ADDED providers; hover opens the model flyout; picking persists the override", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Choose model" }));
    const popover = await screen.findByRole("menu", { name: "Choose model" });

    // One row per ADDED provider + the Free only/All segmented control
    // (the providers query loads up-front — wait for the rows).
    await waitFor(() => expect(popover.textContent).toContain("OpenRouter"));
    expect(popover.textContent).toContain("Z.AI");
    expect(screen.getByRole("group", { name: "Model filter" })).toBeTruthy();

    // The current provider row is marked.
    expect(screen.getByRole("menuitem", { name: "Models of OpenRouter" }).textContent).toContain("current");

    // HOVER a provider row → the flyout lists its selectable models
    // (free-only by default — the shared persisted preference).
    fireEvent.mouseEnter(screen.getByRole("menuitem", { name: "Models of OpenRouter" }));
    const flyout = await screen.findByRole("listbox", { name: "Models of OpenRouter" });
    await waitFor(() =>
      expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["z-ai/glm-5.2:free"]),
    );
    // The agent's own model is paid → hidden under free-only, with the hint.
    expect(flyout.textContent).toContain("2 paid models hidden — show all");

    // Pick the free model → per-send override + per-session persistence.
    fireEvent.click(screen.getByRole("option", { name: "z-ai/glm-5.2:free" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Choose model" }).textContent).toContain(
        "z-ai/glm-5.2:free",
      ),
    );
    expect(JSON.parse(window.localStorage.getItem(`acute-model:${SESSION_ID}`) ?? "null")).toEqual({
      model: "z-ai/glm-5.2:free",
      providerId: "openrouter",
    });

    // The override model rides the next send.
    fireEvent.change(textarea(), { target: { value: "go" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(streamSessionMessage).toHaveBeenCalled());
    expect(vi.mocked(streamSessionMessage).mock.calls[0][3]?.model).toBe("z-ai/glm-5.2:free");
    await sendSettled();
  });

  it("Manage Models + per-provider Configure navigate to /settings?tab=api (the api tab deep-link)", async () => {
    await renderPanelWithRoutes();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    // Per-provider Configure gear → the Models & Providers tab deep-link.
    fireEvent.click(screen.getByRole("button", { name: "Choose model" }));
    const popover = await screen.findByRole("menu", { name: "Choose model" });
    await waitFor(() => expect(popover.textContent).toContain("OpenRouter"));
    fireEvent.click(screen.getByRole("button", { name: "Configure OpenRouter" }));
    expect(await screen.findByText("SETTINGS PAGE", {}, { timeout: 5000 })).toBeTruthy();
    expect(document.querySelector("[data-settings-search]")?.textContent).toBe("?tab=api");

    // Back to the panel: the full-width footer row does the same.
    cleanup();
    await renderPanelWithRoutes();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Choose model" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Manage Models/ }));
    expect(await screen.findByText("SETTINGS PAGE", {}, { timeout: 5000 })).toBeTruthy();
    expect(document.querySelector("[data-settings-search]")?.textContent).toBe("?tab=api");
  });

  it("the Free only/All segmented control in the popover flips the SHARED preference and the flyout follows", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Choose model" }));
    await screen.findByRole("menu", { name: "Choose model" });

    // Free only (default): the flyout lists ONLY the free model.
    fireEvent.mouseEnter(screen.getByRole("menuitem", { name: "Models of OpenRouter" }));
    await waitFor(() =>
      expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["z-ai/glm-5.2:free"]),
    );

    // Flip to All — the SAME flyout immediately lists every model.
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    await waitFor(() =>
      expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
        "z-ai/glm-5.2:free",
        "openrouter/ox-alpha",
        "openrouter/gpt-5.2",
      ]),
    );
    expect(useSettingsStore.getState().modelsFreeOnly).toBe(false);
  });

  it("the persisted override SURVIVES a panel remount (per-session localStorage)", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Choose model" }));
    fireEvent.mouseEnter(screen.getByRole("menuitem", { name: "Models of OpenRouter" }));
    fireEvent.click(await screen.findByRole("option", { name: "z-ai/glm-5.2:free" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Choose model" }).textContent).toContain(
        "z-ai/glm-5.2:free",
      ),
    );

    // Unmount + remount the SAME session — the override reloads from
    // localStorage (the label shows it once the session query resolves).
    cleanup();
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Choose model" }).textContent).toContain(
        "z-ai/glm-5.2:free",
      ),
    );
  });
});

// ── G. Context donut ────────────────────────────────────────────────────────
describe("Composer: context donut (owner spec G)", () => {
  it("renders used/window from GET /sessions/:id/context with the compact % label", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    const donut = await screen.findByRole("button", { name: /Context window: 42% used/ });
    expect(donut.textContent).toContain("42%");
    expect(fetchSessionContext).toHaveBeenCalledWith(SESSION_ID, "openrouter/ox-alpha");
  });

  it("popover shows the big donut, breakdown mini-bars, cache line, and session totals", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    fireEvent.click(await screen.findByRole("button", { name: /Context window: 42% used/ }));
    const popover = await screen.findByRole("dialog", { name: "Context window details" });

    // Big donut summary: "% used" + used / window tokens + the model line.
    expect(popover.textContent).toContain("42% used");
    expect(popover.textContent).toContain("420k / 1000k tokens");
    expect(popover.textContent).toContain("openrouter/ox-alpha");

    // Breakdown rows (mini-bars) — MCP tools honestly "none configured".
    for (const row of [
      "Messages",
      "System prompt",
      "System tools",
      "MCP tools",
      "Memory & skills",
      "Meta & project",
    ]) {
      expect(popover.querySelector(`[data-breakdown-row="${row}"]`)).toBeTruthy();
    }
    expect(popover.querySelector('[data-breakdown-row="MCP tools"]')?.textContent).toContain(
      "none configured",
    );
    expect(popover.querySelector('[data-breakdown-row="Messages"]')?.textContent).toContain("400k");

    // Cache line: hit rate + cached/total tokens.
    expect(popover.textContent).toContain("Cache hit rate");
    expect(popover.textContent).toContain("82%");
    expect(popover.textContent).toContain("82k / 100k cached");

    // Session section (requests, sent, received, cost).
    const totals = popover.querySelector("[data-session-totals]") as HTMLElement;
    expect(totals.textContent).toContain("Requests");
    expect(totals.textContent).toContain("7");
    expect(totals.textContent).toContain("Tokens sent ↑");
    expect(totals.textContent).toContain("250k");
    expect(totals.textContent).toContain("Tokens received ↓");
    expect(totals.textContent).toContain("12k");
    expect(totals.textContent).toContain("Cost");
    expect(totals.textContent).toContain("$0.1234");
  });

  it("a failed context report renders the honest '—' (never a fake 0%)", async () => {
    vi.mocked(fetchSessionContext).mockRejectedValue(new Error("boom"));
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    const donut = await screen.findByRole("button", { name: "Context window usage unavailable" });
    expect(donut.textContent).toContain("—");
  });
});

// ── H. Send button ───────────────────────────────────────────────────────────
describe("Composer: send button states (owner spec H)", () => {
  it("disabled when the input is empty, enabled once text exists", async () => {
    await renderEmptyPanel();
    const send = screen.getByRole("button", { name: "Send message" });
    expect((send as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(textarea(), { target: { value: "hello" } });
    expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("Enter sends, Shift+Enter inserts a newline", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    const ta = textarea();
    fireEvent.change(ta, { target: { value: "via enter" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    await waitFor(() => expect(streamSessionMessage).toHaveBeenCalled());
    await sendSettled();

    fireEvent.change(ta, { target: { value: "line one" } });
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: true });
    expect(streamSessionMessage).toHaveBeenCalledTimes(1); // NOT a second send
  });
});
