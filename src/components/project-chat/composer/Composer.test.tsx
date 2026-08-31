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
 *  - the model selector lists providers, opens a hover flyout of that
 *    provider's models, selects + persists the override per session, and
 *    Manage Models / Configure navigate to /settings?tab=api;
 *  - the context donut renders from GET /sessions/:id/context with the full
 *    breakdown / cache / session-totals popover;
 *  - the send button's disabled states.
 *
 * ROUND-51 (R51-c) additions, per the owner's fourth test round:
 *  - Add Context is ICON-ONLY (no "Context" text) — name on aria+title;
 *  - the model button shows the MODEL ID ONLY ("Provider · model" on title);
 *  - computeFlyoutGeometry PURE unit tests (side + vertical clamping);
 *  - the flyout applies the measured geometry; the popover scrolls
 *    internally; the flyout carries the provider-name header chip;
 *  - the donut toolbar shows NO inline % label; the popover has a
 *    hover-bridge (grace-period close, cancellable from the popover) and the
 *    ring color grades accent → amber → danger;
 *  - the Session section splits Main agent / Sub-agents / Combined (with a
 *    pre-R51 no-`usage` report falling back to zeros);
 *  - the toolbar never overlaps: shrink-0 clusters + flex spacer + wrap.
 *
 * ROUND-52 (R52-a) additions, per the owner's flyout complaint:
 *  - the provider→models flyout has a HOVER BRIDGE (grace-period close,
 *    cancellable from the flyout) — leaving the provider row no longer snaps
 *    it shut in the popover-padding + FLYOUT_MARGIN dead zone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation, useSearchParams } from "react-router";
import type { ReactNode } from "react";
import { AgentChatPanel } from "../AgentChatPanel";
import { getFixtureProjects } from "../../../lib/project-fixtures";
import { createFixtureSessions } from "../../../lib/session-fixtures";
import {
  fetchProviderModelConfig,
  fetchProviders,
  fetchSessionContext,
  fetchProviderModels,
  patchSessionPermissions,
  pickFilesViaBackend,
  readAttachmentFiles,
  streamSessionMessage,
  type Project,
  type ProviderModelConfig,
  type SessionContextReport,
  type SessionDetail,
  type SessionEvent,
  type SessionsBackend,
  type ProviderView,
} from "../../../lib/api";
import { SEMANTIC_COLORS } from "../../../lib/semantics";
import { useConfigStore } from "../../../lib/config-store";
import { useNotificationStreamStore } from "../../../hooks/use-notifications";
import { useSettingsStore } from "../../../lib/settings-store";
import { useStreamStore } from "../../../lib/stream-store";
import { renderWithProviders, resetTestState } from "../../../test-utils";
import {
  computeFlyoutGeometry,
  FLYOUT_MARGIN,
  type PlainRect,
} from "./composer-utils";
import {
  CONTEXT_DONUT_DANGER,
  CONTEXT_DONUT_WARN,
  contextDonutColor,
  DONUT_WARN_COLOR,
  POPOVER_OPEN_INTENT_MS,
} from "./ContextDonut";

const MODELS = [
  "z-ai/glm-5.2:free",
  "openrouter/ox-alpha", // paid (the agent fixture's own model)
  "openrouter/gpt-5.2", // paid
];

/** ROUND-58 (R58-d): the provider's models-CONFIG rows (Settings → Models &
 * Providers) — the model picker merge surface (hidden / displayName /
 * custom pricing). Empty by default so pre-R58 assertions stay green. */
const MODEL_CONFIG: ProviderModelConfig[] = [];

/** Build a full models-config row the way the sidecar does (R58-d tests). */
function modelConfigRow(
  overrides: Partial<ProviderModelConfig> & { modelId: string },
): ProviderModelConfig {
  return {
    id: `mdl_${overrides.modelId}`,
    providerId: "openrouter",
    displayName: overrides.modelId,
    contextWindow: null,
    maxOutputTokens: null,
    inputPricePerMtok: null,
    inputPriceCachedPerMtok: null,
    outputPricePerMtok: null,
    supportsThinking: false,
    hidden: false,
    sortOrder: 0,
    createdAt: "2026-08-30T09:00:00Z",
    updatedAt: "2026-08-30T09:00:00Z",
    ...overrides,
  };
}

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
  // ROUND-51 (R51-c): the main/sub-agents/combined usage split.
  usage: {
    main: { inputTokens: 250_000, outputTokens: 12_000, requests: 7, costUsd: 0.1234 },
    subagents: { inputTokens: 60_000, outputTokens: 3_400, requests: 4, costUsd: 0.0311 },
    combined: { inputTokens: 310_000, outputTokens: 15_400, requests: 11, costUsd: 0.1545 },
  },
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
    fetchProviderModelConfig: vi.fn(async () => MODEL_CONFIG.map((m) => ({ ...m }))),
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
  vi.useRealTimers();
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
  vi.mocked(fetchProviderModelConfig).mockReset().mockResolvedValue(MODEL_CONFIG.map((m) => ({ ...m })));
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

  it("ROUND-51 (R51-c): shrink-0 clusters + flex spacer + wrap — the clusters can never overlap", async () => {
    await renderEmptyPanel();
    const toolbar = document.querySelector("[data-composer-toolbar]") as HTMLElement;
    // The row wraps when the two clusters can't share it (left wraps ABOVE
    // the right — DOM order left → spacer → right).
    expect(toolbar.className).toContain("flex-wrap");
    const children = Array.from(toolbar.children) as HTMLElement[];
    expect(children.length).toBe(3);
    const [left, spacer, right] = children;
    expect(left.className).toContain("shrink-0");
    expect(right.className).toContain("shrink-0");
    // The spacer absorbs the shrink (flex-1 min-w-0) — never the clusters.
    expect(spacer.className).toContain("flex-1");
    expect(spacer.className).toContain("min-w-0");
    expect(
      left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // The clusters hold their own controls (left: context + mode; right:
    // donut + model + thinking + send).
    expect(left.contains(screen.getByRole("button", { name: "Add context" }))).toBe(true);
    expect(left.contains(screen.getByRole("button", { name: "Permission mode: Ask" }))).toBe(true);
    expect(right.contains(screen.getByRole("button", { name: "Context window usage" }))).toBe(true);
    expect(right.contains(screen.getByRole("button", { name: "Choose model" }))).toBe(true);
    expect(right.contains(screen.getByRole("button", { name: "Thinking level: Default" }))).toBe(true);
    expect(right.contains(screen.getByRole("button", { name: "Send message" }))).toBe(true);
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
  it("the button is ICON-ONLY — no 'Context' text; name on aria-label + title (R51-c)", async () => {
    await renderEmptyPanel();
    const btn = screen.getByRole("button", { name: "Add context" });
    // ROUND-51 (R51-c, owner: "there should be just the logo"): the Paperclip
    // carries no text — the label lives on aria-label + the title tooltip.
    expect(btn.textContent?.trim()).toBe("");
    expect(btn.querySelector("svg")).toBeTruthy();
    expect(btn.getAttribute("title")).toBe("Attach files or project files");
    // The toolbar itself carries no "Context" text either.
    const toolbar = document.querySelector("[data-composer-toolbar]") as HTMLElement;
    expect(toolbar.textContent).not.toContain("Context");
  });

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
  it("button shows the MODEL ID ONLY; the full Provider · model stays on the title (R51-c)", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    const btn = screen.getByRole("button", { name: "Choose model" });
    // Agent fixture: providerId "openrouter", model "openrouter/ox-alpha";
    // ROUND-51 (R51-c): the label is the model id ONLY — no provider prefix.
    await waitFor(() => expect(btn.textContent).toBe("openrouter/ox-alpha"));
    // The full "Provider · model" stays on the tooltip.
    expect(btn.getAttribute("title")).toBe("OpenRouter · openrouter/ox-alpha");
    expect(btn.querySelector("[data-model-label]")?.textContent).toBe("openrouter/ox-alpha");
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

  it("the flyout applies the MEASURED geometry; the popover scrolls internally; header chip + footer (R51-c)", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Choose model" }));
    const popover = await screen.findByRole("menu", { name: "Choose model" });
    // The popover is capped + scrolls — N providers never overflow the viewport.
    expect(popover.className).toContain("overflow-y-auto");
    expect(popover.className).toContain("max-h-[min(24rem,calc(100vh-2rem))]");

    // Hover a provider row — happy-dom: every rect is 0 and the viewport is
    // 1024×768, so the pure helper resolves side=right, left=12, top=12,
    // maxHeight=280 (the row's zero top clamps up to the 12px margin).
    fireEvent.mouseEnter(screen.getByRole("menuitem", { name: "Models of OpenRouter" }));
    const flyout = await screen.findByRole("listbox", { name: "Models of OpenRouter" });
    expect(flyout.getAttribute("data-flyout-side")).toBe("right");
    expect(flyout.style.left).toBe("12px");
    expect(flyout.style.top).toBe("12px");
    expect(flyout.style.maxHeight).toBe("280px");
    expect(flyout.style.overflowY).toBe("auto");
    // Polish: provider-name header chip (with the model count once loaded) +
    // the hidden-paid footer row.
    await waitFor(() => expect(flyout.textContent).toContain("1 model"));
    expect(flyout.textContent).toContain("OpenRouter");
    expect(flyout.textContent).toContain("2 paid models hidden — show all");
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

  // ROUND-52 (R52-a): the flyout hover bridge — the same grace-period shape
  // the ContextDonut popover shipped in R51-c, applied to the provider row
  // → models flyout pair (the flyout is position:fixed one popover padding +
  // FLYOUT_MARGIN away from the row's box; crossing that dead zone used to
  // fire the row's mouseleave and close it before the pointer arrived).
  it("HOVER BRIDGE: leaving the provider row does NOT close the flyout instantly — it closes after the grace period (R52-a)", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Choose model" }));
    await screen.findByRole("menu", { name: "Choose model" });
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Models of OpenRouter" })).toBeTruthy(),
    );

    vi.useFakeTimers();
    const row = (): HTMLElement => document.querySelector(
      '[data-provider-row="openrouter"]',
    ) as HTMLElement;
    const flyoutEl = (): HTMLElement | null => document.querySelector("[data-model-flyout]");

    // Hovering the row opens the flyout (existing behavior — the row itself,
    // not just its inner menuitem button, carries the handlers).
    fireEvent.mouseEnter(row());
    expect(flyoutEl()).not.toBeNull();

    // Leaving the row toward the flyout: stays open through the grace period
    // (the OLD code closed it instantly — the owner's round-52 complaint).
    fireEvent.mouseLeave(row());
    expect(flyoutEl()).not.toBeNull();
    vi.advanceTimersByTime(210);
    expect(flyoutEl()).not.toBeNull();

    // After the full grace period the close lands (act(): the timer's
    // setState must flush before the assertion).
    act(() => {
      vi.advanceTimersByTime(40);
    });
    expect(flyoutEl()).toBeNull();
    vi.useRealTimers();
  });

  it("HOVER BRIDGE: entering the flyout cancels the pending close; leaving it re-schedules (R52-a)", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Choose model" }));
    await screen.findByRole("menu", { name: "Choose model" });
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Models of OpenRouter" })).toBeTruthy(),
    );

    vi.useFakeTimers();
    const row = (): HTMLElement => document.querySelector(
      '[data-provider-row="openrouter"]',
    ) as HTMLElement;
    const flyoutEl = (): HTMLElement | null => document.querySelector("[data-model-flyout]");

    // Row → gap → flyout: the leave schedules a close, the flyout's enter
    // cancels it entirely (the pointer crossed the dead zone in time).
    fireEvent.mouseEnter(row());
    fireEvent.mouseLeave(row());
    fireEvent.mouseEnter(flyoutEl() as HTMLElement);
    vi.advanceTimersByTime(2_000);
    expect(flyoutEl()).not.toBeNull();

    // Leaving the FLYOUT starts the timer again — still open inside the
    // grace period, closed just past it.
    fireEvent.mouseLeave(flyoutEl() as HTMLElement);
    act(() => {
      vi.advanceTimersByTime(210);
    });
    expect(flyoutEl()).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(20);
    });
    expect(flyoutEl()).toBeNull();
    vi.useRealTimers();
  });
});

// ── F2. Model selector × models-config merge (ROUND-58 R58-d) ────────────────
describe("Composer: model selector respects the models config (ROUND-58 R58-d)", () => {
  /** Open the popover + hover the OpenRouter row → the flyout. */
  async function openFlyout() {
    fireEvent.click(screen.getByRole("button", { name: "Choose model" }));
    await screen.findByRole("menu", { name: "Choose model" });
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Models of OpenRouter" })).toBeTruthy(),
    );
    fireEvent.mouseEnter(screen.getByRole("menuitem", { name: "Models of OpenRouter" }));
    await screen.findByRole("listbox", { name: "Models of OpenRouter" });
    // Wait for the merged rows to land.
    await waitFor(() =>
      expect(screen.getAllByRole("option").length).toBeGreaterThan(0),
    );
  }

  it("models hidden in Settings are EXCLUDED — even under \"All\" — with the honest footer note", async () => {
    vi.mocked(fetchProviderModelConfig).mockResolvedValue([
      modelConfigRow({ modelId: "openrouter/gpt-5.2", hidden: true }),
    ]);
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    await openFlyout();
    // Free-only default: only the free model (ox-alpha is paid-and-unknown).
    await waitFor(() =>
      expect(screen.getAllByRole("option").map((o) => o.getAttribute("title"))).toEqual([
        "z-ai/glm-5.2:free",
      ]),
    );

    // "show all" reveals the PAID model but NEVER the config-hidden one…
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    await waitFor(() =>
      expect(screen.getAllByRole("option").map((o) => o.getAttribute("title"))).toEqual([
        "z-ai/glm-5.2:free",
        "openrouter/ox-alpha",
      ]),
    );
    // …and its own footer note says why.
    expect(screen.getByText("1 model hidden in Settings")).toBeTruthy();
  });

  it("a config displayName replaces the raw id in the row — the PICK still sends the raw id", async () => {
    vi.mocked(fetchProviderModelConfig).mockResolvedValue([
      modelConfigRow({ modelId: "z-ai/glm-5.2:free", displayName: "My Custom GLM" }),
    ]);
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    await openFlyout();
    // The option's accessible name is the display name…
    const option = screen.getByRole("option", { name: "My Custom GLM" });
    // …while the title carries the raw id (what actually gets sent).
    expect(option.getAttribute("title")).toBe("z-ai/glm-5.2:free");

    fireEvent.click(option);
    // The override persists the RAW model id (the API identifier).
    await waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem(`acute-model:${SESSION_ID}`) ?? "null")).toEqual({
        model: "z-ai/glm-5.2:free",
        providerId: "openrouter",
      }),
    );
  });

  it("a configured model carries the subtle \"configured\" dot", async () => {
    vi.mocked(fetchProviderModelConfig).mockResolvedValue([
      modelConfigRow({ modelId: "z-ai/glm-5.2:free", displayName: "My Custom GLM" }),
    ]);
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    await openFlyout();
    const option = screen.getByRole("option", { name: "My Custom GLM" });
    // The dot rides INSIDE the option row.
    expect(option.querySelector('[title="Configured in Settings — pricing and visibility customized"]')).not.toBeNull();
    // Unconfigured models carry no dot — flip to All to reveal the paid one.
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    const paid = await screen.findByRole("option", { name: "openrouter/ox-alpha" });
    expect(paid.querySelector('[title="Configured in Settings — pricing and visibility customized"]')).toBeNull();
  });

  it("a config price of $0 makes a paid-id model count as FREE for the shared filter", async () => {
    vi.mocked(fetchProviderModelConfig).mockResolvedValue([
      modelConfigRow({ modelId: "openrouter/ox-alpha", inputPricePerMtok: 0 }),
    ]);
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    await openFlyout();
    // Free-only default now lists BOTH the :free model AND the configured
    // $0-priced one (isFreeModelEntry honors inputPricePerMtok === 0).
    await waitFor(() =>
      expect(screen.getAllByRole("option").map((o) => o.getAttribute("title"))).toEqual([
        "z-ai/glm-5.2:free",
        "openrouter/ox-alpha",
      ]),
    );
    // The paid-hidden hint counts only the remaining unknown-price model.
    expect(screen.getByText("1 paid model hidden — show all")).toBeTruthy();
  });

  it("a failing config fetch falls back to the plain ids-only list (robust merge)", async () => {
    vi.mocked(fetchProviderModelConfig).mockRejectedValueOnce(
      new Error("models-config unreachable"),
    );
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    await openFlyout();
    // Identical to the pre-R58 behavior: free-only rows, ids as labels.
    await waitFor(() =>
      expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["z-ai/glm-5.2:free"]),
    );
    expect(screen.getByText("2 paid models hidden — show all")).toBeTruthy();
  });
});

// ── G. Context donut ────────────────────────────────────────────────────────
describe("Composer: context donut (owner spec G)", () => {
  it("renders the ring from GET /sessions/:id/context — ICON-ONLY, no inline % label (R51-c)", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    const donut = await screen.findByRole("button", { name: /Context window: 42% used/ });
    // ROUND-51 (R51-c): the toolbar shows ONLY the ring — the % lives on the
    // button's title/aria-label and inside the popover, never beside it.
    expect(document.querySelector("[data-donut-label]")).toBeNull();
    expect(donut.textContent?.trim()).toBe("");
    expect(donut.querySelector("svg")).toBeTruthy();
    expect(donut.getAttribute("title")).toContain("42% used");
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

    // Session section (ROUND-51 R51-c): Main agent / Sub-agents / Combined —
    // each group with requests, tokens sent ↑ / received ↓, cost.
    const totals = popover.querySelector("[data-session-totals]") as HTMLElement;
    expect(totals.textContent).toContain("Main agent");
    expect(totals.textContent).toContain("Sub-agents");
    expect(totals.textContent).toContain("Combined");
    const group = (id: string): HTMLElement =>
      totals.querySelector(`[data-usage-group="${id}"]`) as HTMLElement;
    for (const id of ["main", "subagents", "combined"]) expect(group(id)).toBeTruthy();
    expect(group("main").textContent).toContain("Requests");
    expect(group("main").textContent).toContain("7");
    expect(group("main").textContent).toContain("250k");
    expect(group("main").textContent).toContain("12k");
    expect(group("main").textContent).toContain("$0.1234");
    expect(group("subagents").textContent).toContain("4");
    expect(group("subagents").textContent).toContain("60k");
    expect(group("subagents").textContent).toContain("3.4k");
    expect(group("subagents").textContent).toContain("$0.0311");
    expect(group("combined").textContent).toContain("11");
    expect(group("combined").textContent).toContain("310k");
    expect(group("combined").textContent).toContain("15k"); // fmtTokens(15 400)
    expect(group("combined").textContent).toContain("$0.1545");
  });

  it("a failed context report renders the honest '—' (never a fake 0%)", async () => {
    vi.mocked(fetchSessionContext).mockRejectedValue(new Error("boom"));
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    const donut = await screen.findByRole("button", { name: "Context window usage unavailable" });
    // Icon-only: no '—' text label either — just the ring with the danger track.
    expect(donut.textContent?.trim()).toBe("");
  });

  it("a pre-R51 report (no `usage` split) falls back: main = sessionTotals, sub-agents = zeros (R51-c)", async () => {
    const { usage: _usage, ...flatReport } = CONTEXT_REPORT;
    vi.mocked(fetchSessionContext).mockResolvedValue(flatReport);
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    fireEvent.click(await screen.findByRole("button", { name: /Context window: 42% used/ }));
    const popover = await screen.findByRole("dialog", { name: "Context window details" });
    const totals = popover.querySelector("[data-session-totals]") as HTMLElement;
    const group = (id: string): HTMLElement =>
      totals.querySelector(`[data-usage-group="${id}"]`) as HTMLElement;
    // Main falls back to the flat sessionTotals.
    expect(group("main").textContent).toContain("7");
    expect(group("main").textContent).toContain("250k");
    // Sub-agents honestly show zeros (cost '—' when 0).
    expect(group("subagents").textContent).toContain("0");
    expect(group("subagents").textContent).toContain("—");
    // Combined falls back to main.
    expect(group("combined").textContent).toContain("250k");
  });

  it("HOVER INTENT (R58-cf): the popover does NOT open instantly — only after the pointer rests ~600ms", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();
    const donut = await screen.findByRole("button", { name: /Context window: 42% used/ });

    vi.useFakeTimers();
    const popoverEl = (): HTMLElement | null => document.querySelector("[data-context-popover]");

    // Entering starts the intent timer — nothing opens yet (the owner's
    // complaint: the popover startled open on the way to Send).
    fireEvent.mouseEnter(donut);
    expect(popoverEl()).toBeNull();
    act(() => {
      vi.advanceTimersByTime(POPOVER_OPEN_INTENT_MS - 1);
    });
    expect(popoverEl()).toBeNull();
    // The pointer RESTED the full intent window → open.
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(popoverEl()).not.toBeNull();
    vi.useRealTimers();
  });

  it("HOVER INTENT (R58-cf): leaving before the intent fires CANCELS the open — a pass-through never opens it", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();
    const donut = await screen.findByRole("button", { name: /Context window: 42% used/ });

    vi.useFakeTimers();
    const popoverEl = (): HTMLElement | null => document.querySelector("[data-context-popover]");
    fireEvent.mouseEnter(donut);
    act(() => {
      vi.advanceTimersByTime(300); // resting, but not long enough
    });
    expect(popoverEl()).toBeNull();
    fireEvent.mouseLeave(donut); // cancelled — the pointer moved on
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(popoverEl()).toBeNull();
    vi.useRealTimers();
  });

  it("FOCUS opens INSTANTLY — the keyboard path never pays the hover-intent toll (R58-cf)", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();
    const donut = await screen.findByRole("button", { name: /Context window: 42% used/ });

    vi.useFakeTimers();
    const popoverEl = (): HTMLElement | null => document.querySelector("[data-context-popover]");
    fireEvent.focus(donut);
    expect(popoverEl()).not.toBeNull(); // no advanceTimersByTime needed
    vi.useRealTimers();
  });

  it("HOVER BRIDGE: leaving the trigger does NOT close instantly; entering the popover cancels the timer (R51-c)", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();
    const donut = await screen.findByRole("button", { name: /Context window: 42% used/ });

    vi.useFakeTimers();
    const popoverEl = (): HTMLElement | null => document.querySelector("[data-context-popover]");

    // Hover + the full intent window opens the popover (R58-cf).
    fireEvent.mouseEnter(donut);
    act(() => {
      vi.advanceTimersByTime(POPOVER_OPEN_INTENT_MS);
    });
    expect(popoverEl()).not.toBeNull();

    // Leaving the trigger toward the popover: stays open through the grace
    // period (the OLD code closed it instantly — the owner's complaint).
    fireEvent.mouseLeave(donut);
    expect(popoverEl()).not.toBeNull();
    vi.advanceTimersByTime(210);
    expect(popoverEl()).not.toBeNull();

    // Entering the popover cancels the close entirely.
    fireEvent.mouseEnter(popoverEl() as HTMLElement);
    vi.advanceTimersByTime(2_000);
    expect(popoverEl()).not.toBeNull();

    // Leaving the popover starts the timer again — closing after the grace
    // period (act(): the timer's setState must flush before the assertion).
    fireEvent.mouseLeave(popoverEl() as HTMLElement);
    act(() => {
      vi.advanceTimersByTime(210);
    });
    expect(popoverEl()).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(20);
    });
    expect(popoverEl()).toBeNull();
    vi.useRealTimers();
  });

  it("CLICK still pins: a pinned popover survives leaving both trigger and popover (R51-c)", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();
    const donut = await screen.findByRole("button", { name: /Context window: 42% used/ });

    vi.useFakeTimers();
    const popoverEl = (): HTMLElement | null => document.querySelector("[data-context-popover]");
    fireEvent.click(donut); // pin ON
    expect(popoverEl()).not.toBeNull();
    fireEvent.mouseLeave(donut);
    fireEvent.mouseLeave(popoverEl() as HTMLElement);
    vi.advanceTimersByTime(3_000);
    expect(popoverEl()).not.toBeNull(); // pinned survives the grace period
    // Click again unpins + closes immediately (existing semantics).
    fireEvent.click(donut);
    expect(popoverEl()).toBeNull();
    vi.useRealTimers();
  });

  it("the ring color grades by pressure: amber at 70%, danger at 90% (R51-c)", async () => {
    vi.mocked(fetchSessionContext).mockResolvedValue({ ...CONTEXT_REPORT, usedTokens: 700_000 });
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();
    const donut = await screen.findByRole("button", { name: /Context window: 70% used/ });
    // circles[0] = track, circles[1] = the arc — amber in the 60–85% band.
    expect(donut.querySelectorAll("circle")[1].getAttribute("stroke")).toBe(DONUT_WARN_COLOR);

    cleanup();
    vi.mocked(fetchSessionContext).mockResolvedValue({ ...CONTEXT_REPORT, usedTokens: 900_000 });
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();
    const hot = await screen.findByRole("button", { name: /Context window: 90% used/ });
    expect(hot.querySelectorAll("circle")[1].getAttribute("stroke")).toBe(SEMANTIC_COLORS.danger);
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

// ── ROUND-51 (R51-c): computeFlyoutGeometry — pure placement math ────────────
describe("computeFlyoutGeometry (ROUND-51 R51-c) — pure unit tests", () => {
  const row = (top: number, left = 40): PlainRect => ({ top, bottom: top + 30, left, right: left + 220 });
  const popover = (left: number, right: number, top = 200): PlainRect => ({
    top,
    bottom: top + 300,
    left,
    right,
  });

  it("RIGHT side when the viewport has room: left = popover right + margin, top-aligned with the row", () => {
    // 1280 - 940 = 340 ≥ 280 + 12 → right.
    const geo = computeFlyoutGeometry(row(300), popover(700, 940), { width: 1280, height: 800 }, 280);
    expect(geo.side).toBe("right");
    expect(geo.left).toBe(940 + FLYOUT_MARGIN);
    expect(geo.viewportTop).toBe(300); // row sits inside the clamp band
    expect(geo.top).toBe(0); // row-relative offset = 0 (aligned)
    expect(geo.maxHeight).toBe(280);
  });

  it("LEFT side when only the left has room: left = popover left - width - margin", () => {
    // spaceRight = 1280 - 1240 = 40 < 292; spaceLeft = 1000 ≥ 292.
    const geo = computeFlyoutGeometry(row(300), popover(1000, 1240), { width: 1280, height: 800 }, 280);
    expect(geo.side).toBe("left");
    expect(geo.left).toBe(1000 - 280 - FLYOUT_MARGIN);
  });

  it("INLINE when neither side has room (narrow/touch fallback)", () => {
    // spaceRight = 560 - 480 = 80; spaceLeft = 280 — both < 292.
    const geo = computeFlyoutGeometry(row(300), popover(280, 480), { width: 560, height: 800 }, 280);
    expect(geo.side).toBe("inline");
    expect(geo.left).toBeNull();
    expect(geo.top).toBe(0);
  });

  it("clamps the flyout INSIDE the viewport when the row sits low (negative top shift)", () => {
    // Row at y=700, viewport 800 tall, worst-case height 280 → bottom ≤ 788.
    const geo = computeFlyoutGeometry(row(700), popover(700, 940, 640), { width: 1280, height: 800 }, 280);
    expect(geo.side).toBe("right");
    expect(geo.viewportTop).toBe(800 - FLYOUT_MARGIN - 280);
    expect(geo.top).toBe(800 - FLYOUT_MARGIN - 280 - 700); // negative → shifts UP
  });

  it("clamps down to the top margin when the row is above it", () => {
    const geo = computeFlyoutGeometry(row(2), popover(700, 940, 0), { width: 1280, height: 800 }, 280);
    expect(geo.viewportTop).toBe(FLYOUT_MARGIN);
    expect(geo.top).toBe(FLYOUT_MARGIN - 2);
  });

  it("maxHeight = min(280, viewportH - 24) — short viewports cap lower", () => {
    expect(
      computeFlyoutGeometry(row(50), popover(700, 940), { width: 1280, height: 700 }, 280).maxHeight,
    ).toBe(280);
    expect(
      computeFlyoutGeometry(row(50), popover(700, 940), { width: 1280, height: 200 }, 280).maxHeight,
    ).toBe(200 - 24);
  });

  it("an explicit (measured) flyout height tightens the vertical clamp", () => {
    const geo = computeFlyoutGeometry(
      row(700),
      popover(700, 940, 640),
      { width: 1280, height: 800 },
      280,
      120,
    );
    expect(geo.viewportTop).toBe(800 - FLYOUT_MARGIN - 120);
    expect(geo.top).toBe(800 - FLYOUT_MARGIN - 120 - 700);
  });

  it("degenerate tiny viewport: the top margin still wins (never an inverted clamp)", () => {
    // maxHeight = 76 → clamp(rowTop=50, 12, 100-12-76=12) = 12.
    const geo = computeFlyoutGeometry(row(50), popover(700, 940), { width: 1280, height: 100 }, 280);
    expect(geo.viewportTop).toBe(FLYOUT_MARGIN);
  });
});

// ── ROUND-51 (R51-c): contextDonutColor — pure grading thresholds ────────────
describe("contextDonutColor grading (ROUND-51 R51-c) — pure unit tests", () => {
  const ACCENT = "#7c5cff";
  it("exports the thresholds the UI grades by (accent < 60 ≤ amber ≤ 85 < danger)", () => {
    expect(CONTEXT_DONUT_WARN).toBe(0.6);
    expect(CONTEXT_DONUT_DANGER).toBe(0.85);
  });

  it("accent below 60%, amber in the 60–85% band, danger above 85%", () => {
    expect(contextDonutColor(59, 100, ACCENT)).toBe(ACCENT);
    expect(contextDonutColor(60, 100, ACCENT)).toBe(DONUT_WARN_COLOR); // boundary inclusive
    expect(contextDonutColor(85, 100, ACCENT)).toBe(DONUT_WARN_COLOR); // boundary inclusive
    expect(contextDonutColor(86, 100, ACCENT)).toBe(SEMANTIC_COLORS.danger);
  });

  it("no window (or zero usage) never looks scary — accent", () => {
    expect(contextDonutColor(1, 0, ACCENT)).toBe(ACCENT);
    expect(contextDonutColor(0, 100, ACCENT)).toBe(ACCENT);
  });
});

// ── I. Continue affordance after a user stop (ROUND-58 R58-cf) ───────────────
describe("Composer: Continue after a user stop (ROUND-58 R58-cf)", () => {
  /** The post-stop store slice: the last turn ended by user stop, live turn
   * already handed to the folded log (the panel clears + re-arms the flag). */
  function armStoppedSignal(): void {
    useStreamStore.setState({
      bySession: {
        [SESSION_ID]: {
          liveTurn: null,
          streamBusy: false,
          sendError: null,
          liveError: null,
          pendingEcho: null,
          lastLiveEndMs: Date.now(),
          lastTurnStoppedByUser: true,
          lastTurnStoppedTs: "2026-08-31T12:00:00Z",
        },
      },
    });
  }

  it("NO Continue button on a normal session (the last turn was not user-stopped)", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();
    // The marker attribute AND the accessible name are both absent (the
    // queryByTestId form would silently match nothing — data-continue-button
    // is not data-testid).
    expect(document.querySelector("[data-continue-button]")).toBeNull();
    expect(screen.queryByRole("button", { name: /Continue from where you left off/ })).toBeNull();
  });

  it("the Continue button appears next to Send after a user stop — secondary styling, Play icon", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();
    armStoppedSignal();

    const btn = await screen.findByRole("button", { name: "Continue from where you left off" });
    expect(btn.textContent).toContain("Continue");
    expect(btn.querySelector("svg")).toBeTruthy(); // the Play glyph
    // Send stays beside it.
    expect(screen.getByRole("button", { name: "Send message" })).toBeTruthy();
  });

  it("clicking Continue sends the EXACT resume message as a normal user turn", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();
    armStoppedSignal();

    fireEvent.click(await screen.findByRole("button", { name: "Continue from where you left off" }));
    await waitFor(() => expect(streamSessionMessage).toHaveBeenCalled());
    // The exact string is a product decision (composer-utils pins it).
    expect(
      vi.mocked(streamSessionMessage).mock.calls.at(-1)?.[1],
    ).toBe("Continue from where you left off.");
    await sendSettled();
    // The next send reset the user-stop signal — the affordance is gone.
    await waitFor(() => expect(screen.queryByRole("button", { name: /Continue from where you left off/ })).toBeNull());
  });

  it("the Stop button still owns the toolbar while a turn runs (Continue never shows busy)", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();
    armStoppedSignal();
    // A new turn goes out (busy) — Continue must vanish while it streams.
    fireEvent.change(textarea(), { target: { value: "next task" } });
    fireEvent.keyDown(textarea(), { key: "Enter" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop generation" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Continue from where you left off/ })).toBeNull();
    await sendSettled();
  });
});
