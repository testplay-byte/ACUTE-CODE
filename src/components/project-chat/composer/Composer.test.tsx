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
 *  - the donut toolbar shows NO inline value AT ALL — neither the % (R51-c)
 *    nor the measured token count (ROUND-96 R96-H: the owner REVERSED the
 *    R95-F inline readout — "It should not show that value alongside it";
 *    every number is hover/popover-only now); the popover has a
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
 * ROUND-62 (R62-2b) additions — session-page reflection of Models &
 *   Providers edits (the owner's directive):
 *  - a models-config row NOT in the live catalog (added by id in Settings)
 *    appears in the flyout — display-name label, raw-id pick;
 *  - a HIDDEN config-only row is excluded and counted in the footer note;
 *  - a provider DISABLED in Settings leaves the popover (the button keeps
 *    the agent's own model label).
 * ROUND-64 (R64-d) replacement — the flyout is CONFIG-ONLY (owner: "only
 *   the models which I had added in the models and providers Page should
 *   be shown"): catalog-only models are NOT listed, the live-catalog fetch
 *   is never issued, and an empty/error config renders the honest pointer
 *   row ("No models configured — add them in Settings → Models & Providers").
 * ROUND-67 (R67-A) additions — the REAL attachment ingestion pipeline (the
 *   owner's #1 complaint: "I uploaded an image directly in chat and the agent
 *   said the image doesn't exist"):
 *  - a binary DRIP keeps its bytes (dataBase64): the send path uploads them
 *    (uploadAttachmentBytes) and the wire attachment carries the
 *    project-relative path; a failed upload keeps the old path-less shape
 *    + a visible per-file toast;
 *  - a PASTED image stages as a chip (preventDefault'd); a text-only paste
 *    is untouched (no preventDefault, native insertion);
 *  - a BINARY OS-picker file is INGESTED by absolute path
 *    (ingestAttachmentPath) — the sidecar copy's path rides the chip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation, useSearchParams } from "react-router";
import type { ReactNode } from "react";
import { AgentChatPanel } from "../AgentChatPanel";
import { getFixtureProjects } from "../../../lib/project-fixtures";
// ROUND-92 (R92-B): the picker self-heal tests plant a NULL/NULL session
// agent through an isolated fixture backend (the customAgentsBackend holder).
import { createFixtureAgents } from "../../../lib/agent-fixtures";
import { createFixtureSessions } from "../../../lib/session-fixtures";
import {
  dequeueSessionMessage,
  fetchProviderModelConfig,
  fetchProviders,
  fetchSessionContext,
  fetchProviderModels,
  ingestAttachmentPath,
  patchSessionPermissions,
  pickFilesViaBackend,
  queueSessionMessage,
  readAttachmentFiles,
  streamSessionMessage,
  uploadAttachmentBytes,
  type Project,
  type ProviderModelConfig,
  type SessionContextReport,
  type SessionDetail,
  type SessionEvent,
  type SessionsBackend,
  type ProviderView,
  type AgentsBackend,
} from "../../../lib/api";
import { SEMANTIC_COLORS } from "../../../lib/semantics";
import { useConfigStore } from "../../../lib/config-store";
import { useNotificationStreamStore } from "../../../hooks/use-notifications";
import { useSettingsStore } from "../../../lib/settings-store";
import { useStreamStore } from "../../../lib/stream-store";
import { renderWithProviders, resetTestState } from "../../../test-utils";
import {
  computeFlyoutGeometry,
  flyoutRetargetIntent,
  FLYOUT_MARGIN,
  shouldArmAgentFromPick,
  type ModelOverride,
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
 * custom pricing). ROUND-64 (R64-d): the config is now the flyout's ONLY
 * source, so this fixture mirrors the old live-catalog mix (one :free id +
 * two paid ids, no display names, no custom pricing) — the pre-R64
 * assertions keep their exact expectations with the config as the origin.
 * Per-test mockResolvedValue overrides still narrow it. */
const MODEL_CONFIG: ProviderModelConfig[] = [
  modelConfigRow({ modelId: "z-ai/glm-5.2:free" }),
  modelConfigRow({ modelId: "openrouter/ox-alpha" }),
  modelConfigRow({ modelId: "openrouter/gpt-5.2" }),
];

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
    supportsVision: false,
    // ROUND-82: the tri-state capability flags (null = unknown).
    supportsTools: true,
    supportsAudio: null,
    supportsVideo: null,
    supportsPdf: null,
    supportsTextOutput: true,
    supportsImageOutput: null,
    supportsVideoOutput: null,
    supportsAudioOutput: null,
    sizeLabel: null,
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
  // ROUND-83 (R83): the budget trio + provenance + the measured block +
  // providerCalls — the wire fields the donut's new lines render.
  contextWindowSource: "override",
  maxOutputTokens: 32_768,
  available: 959_232,
  usedTokensBasis: "estimated",
  usedTokens: 420_000,
  actual: {
    inputTokens: 390_000,
    outputTokens: 12_000,
    cachedInputTokens: 82_000,
    at: "2026-09-10T10:00:00Z",
    model: "openrouter/ox-alpha",
  },
  breakdown: {
    systemPrompt: 9_000,
    systemTools: 1_000,
    memory: 4_000,
    messages: 400_000,
    meta: 6_000,
    mcpTools: 0,
  },
  cache: { inputTokens: 100_000, cachedInputTokens: 82_000, hitRate: 0.82 },
  sessionTotals: { inputTokens: 250_000, outputTokens: 12_000, requests: 7, costUsd: 0.1234, providerCalls: 9 },
  // ROUND-51 (R51-c): the main/sub-agents/combined usage split.
  usage: {
    main: { inputTokens: 250_000, outputTokens: 12_000, requests: 7, costUsd: 0.1234, providerCalls: 9 },
    subagents: { inputTokens: 60_000, outputTokens: 3_400, requests: 4, costUsd: 0.0311 },
    combined: { inputTokens: 310_000, outputTokens: 15_400, requests: 11, costUsd: 0.1545, providerCalls: 9 },
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

/** ROUND-92 (R92-B): per-test override for getAgentsBackend() — the picker
 * self-heal tests plant a session agent at NULL/NULL (the R91-A reset state)
 * and spy the PATCH. */
const customAgentsBackend = vi.hoisted((): { backend: AgentsBackend | null } => ({
  backend: null,
}));

vi.mock("../../../lib/api", async () => {
  const mod = await import("../../../lib/api");
  const agentsFx = await import("../../../lib/agent-fixtures");
  const projectsFx = await import("../../../lib/project-fixtures");
  const sessionsFx = await import("../../../lib/session-fixtures");
  return {
    ...mod,
    getAgentsBackend: () => customAgentsBackend.backend ?? agentsFx.getFixtureAgents(),
    getProjectsBackend: () => projectsFx.getFixtureProjects(),
    getSessionsBackend: () => customBackend.backend ?? sessionsFx.getFixtureSessions(),
    fetchProviderModels: vi.fn(async () => [...MODELS]),
    fetchProviderModelConfig: vi.fn(async () => MODEL_CONFIG.map((m) => ({ ...m }))),
    fetchProviders: vi.fn(async () => PROVIDERS.map((p) => ({ ...p }))),
    pickFilesViaBackend: vi.fn(async () => [] as string[]),
    readAttachmentFiles: vi.fn(async () => [] as never[]),
    // ROUND-67 (R67-A): the ingestion pair — defaults are inert shapes; the
    // R67-A tests override per-case (path/size/mode).
    uploadAttachmentBytes: vi.fn(async () => ({ path: "attachments/staged.png", name: "staged.png", size: 0 })),
    ingestAttachmentPath: vi.fn(async () => ({ path: "attachments/staged.png", name: "staged.png", size: 0 })),
    patchSessionPermissions: vi.fn(async () => PATCHED_DETAIL),
    fetchSessionContext: vi.fn(async () => CONTEXT_REPORT),
    streamSessionMessage: vi.fn(async () => undefined),
    // ROUND-78 (R78-D): the queue client pair — defaults resolve happy
    // paths; the R78 tests program per-case (the NO_LIVE_TURN fallback
    // lives in AgentChatPanel.test.tsx).
    queueSessionMessage: vi.fn(async () => ({ ok: true, seq: 41 })),
    dequeueSessionMessage: vi.fn(async () => undefined),
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
  customAgentsBackend.backend = null;
  useNotificationStreamStore.getState().reset();
  useStreamStore.setState({ bySession: {}, subagentsLive: {} });
  vi.mocked(fetchProviderModels).mockReset().mockResolvedValue([...MODELS]);
  vi.mocked(fetchProviderModelConfig).mockReset().mockResolvedValue(MODEL_CONFIG.map((m) => ({ ...m })));
  vi.mocked(fetchProviders).mockReset().mockResolvedValue(PROVIDERS.map((p) => ({ ...p })));
  vi.mocked(pickFilesViaBackend).mockReset().mockResolvedValue([]);
  vi.mocked(readAttachmentFiles).mockReset().mockResolvedValue([]);
  vi.mocked(uploadAttachmentBytes)
    .mockReset()
    .mockResolvedValue({ path: "attachments/staged.png", name: "staged.png", size: 0 });
  vi.mocked(ingestAttachmentPath)
    .mockReset()
    .mockResolvedValue({ path: "attachments/staged.png", name: "staged.png", size: 0 });
  vi.mocked(patchSessionPermissions).mockReset().mockResolvedValue(PATCHED_DETAIL);
  vi.mocked(fetchSessionContext).mockReset().mockResolvedValue(CONTEXT_REPORT);
  vi.mocked(streamSessionMessage).mockReset().mockResolvedValue(undefined);
  // R78: the queue pair starts at the happy default each test.
  vi.mocked(queueSessionMessage).mockReset().mockResolvedValue({ ok: true, seq: 41 });
  vi.mocked(dequeueSessionMessage).mockReset().mockResolvedValue(undefined);
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
      "Operating mode: Ask",
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

  it("ROUND-78 (R78-B, owner: \"Continue 按钮等选项有时位置异常\"): the ACTION GROUP is a NON-WRAPPING anchor OUTSIDE the wrapping area — pinned right by justify-between; the selectors wrap INSIDE the flex-1 area", async () => {
    await renderEmptyPanel();
    const toolbar = document.querySelector("[data-composer-toolbar]") as HTMLElement;
    // R78: the toolbar itself NO LONGER wraps — it is justify-between with
    // TWO children (wrapping area + action anchor). items-end keeps the
    // actions aligned to the toolbar's LAST line (the owner's drifting
    // action-button fix).
    expect(toolbar.className).toContain("justify-between");
    expect(toolbar.className).toContain("items-end");
    expect(toolbar.className).not.toContain("flex-wrap");
    const left = toolbar.querySelector("[data-composer-left]") as HTMLElement;
    const right = toolbar.querySelector("[data-composer-right]") as HTMLElement;
    const actions = toolbar.querySelector("[data-composer-actions]") as HTMLElement;
    expect(left).toBeTruthy();
    expect(right).toBeTruthy();
    expect(actions).toBeTruthy();
    // The wrapping area: the LEFT cluster's flex-1 min-w-0 parent — wrap
    // happens THERE (the R51-c never-overlap fallback lives inside the
    // area, never on the action side).
    const wrapArea = left.parentElement as HTMLElement;
    expect(wrapArea).not.toBe(toolbar);
    expect(wrapArea.className).toContain("flex-wrap");
    expect(wrapArea.className).toContain("flex-1");
    expect(wrapArea.className).toContain("min-w-0");
    // THE ANCHOR: the action group is a SIBLING of the wrapping area (a
    // DIRECT toolbar child, OUTSIDE the wrapping area — it can never wrap)
    // and the LAST toolbar child (justify-between pins it right).
    expect(actions.parentElement).toBe(toolbar);
    expect(wrapArea.parentElement).toBe(toolbar);
    const toolbarKids = Array.from(toolbar.children) as HTMLElement[];
    expect(toolbarKids.indexOf(actions)).toBe(toolbarKids.length - 1);
    expect(actions.className).toContain("shrink-0");
    expect(actions.className).not.toContain("flex-wrap");
    // The send button lives in THE ANCHOR (not the selectors row).
    const send = screen.getByRole("button", { name: "Send message" }) as HTMLElement;
    expect(actions.contains(send)).toBe(true);
    expect(right.contains(send)).toBe(false);
    // R75's spacer is GONE (ml-auto replaced it long ago; the anchor keeps
    // it dead).
    const spacers = (Array.from(toolbar.children) as HTMLElement[]).filter(
      (c) => c.getAttribute("aria-hidden") === "true",
    );
    expect(spacers).toHaveLength(0);
    // LEFT cluster order (R81): attach, THE unified operating-mode picker —
    // the R73 task-mode pill was folded into the single selector (postures
    // are agent-selected via switch_mode now).
    const orderIn = (host: HTMLElement, name: string | RegExp): number => {
      const btn = screen.getByRole("button", { name }) as HTMLElement;
      let node: HTMLElement | null = btn;
      while (node !== null && node.parentElement !== host) node = node.parentElement;
      const kids = Array.from(host.children) as HTMLElement[];
      return kids.indexOf(node ?? btn);
    };
    const attach = orderIn(left, "Add context");
    const access = orderIn(left, "Operating mode: Ask");
    expect(attach).toBeGreaterThanOrEqual(0);
    expect(attach).toBeLessThan(access);
    expect(left.textContent).not.toContain("Task mode");
    // SELECTORS order (the old right cluster, minus the action button):
    // context donut, model, reasoning.
    const context = orderIn(right, "Context window usage");
    const model = orderIn(right, "Choose model");
    const thinking = orderIn(right, "Thinking level: Default");
    expect(context).toBeGreaterThanOrEqual(0);
    expect(context).toBeLessThan(model);
    expect(model).toBeLessThan(thinking);
    // Every control sits INSIDE one of the two clusters (no strays).
    expect(left.contains(screen.getByRole("button", { name: "Add context" }))).toBe(true);
    // DOM order: the left cluster precedes the right cluster (inside the
    // wrapping area); the wrapping area precedes the action anchor.
    expect(
      left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      wrapArea.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("ROUND-77 (R77) + R87-A1: the model pill leads with a Cpu icon and its label SHRINKS in graduated tiers instead of hiding", async () => {
    await renderEmptyPanel();
    const modelBtn = screen.getByRole("button", { name: "Choose model" }) as HTMLElement;
    const icon = modelBtn.querySelector("[data-model-icon]") as HTMLElement;
    expect(icon).toBeTruthy();
    expect(icon.tagName.toLowerCase()).toBe("svg");
    // R87-A1: the label NEVER hides — it narrows first (240 → 170px below a
    // 520px @container → 90px below 420), animated via max-width, so the
    // model name stays identifiable while the other pills still show full
    // labels. The icon carries no tier classes at any width.
    const label = modelBtn.querySelector("[data-model-label]") as HTMLElement;
    expect(label.className).toContain("max-w-[240px]");
    expect(label.className).toContain("@max-[520px]:max-w-[170px]");
    expect(label.className).toContain("@max-[420px]:max-w-[90px]");
    expect(label.className).toContain("transition-all");
    // R89-D2: the LOGO-ONLY tier — below 350px the label collapses fully
    // (icon + chevron only), never a half-cut name.
    expect(label.className).toContain("@max-[350px]:max-w-0");
    expect(label.className).toContain("@max-[350px]:opacity-0");
    expect(label.className).toContain("truncate");
    expect(label.className).not.toContain(":hidden");
    expect(icon.getAttribute("class") ?? "").not.toContain("@max-");
    // The OTHER pills fold in staggered tiers around it: the MODE label
    // (widest text) first at 560px, THINKING one step later at 500px — both
    // COLLAPSE (animated max-width + fade), never hard-hide.
    const modeLabel = document.querySelector("[data-mode-label]") as HTMLElement;
    expect(modeLabel.className).toContain("@max-[560px]:max-w-0");
    expect(modeLabel.className).toContain("@max-[560px]:opacity-0");
    // The collapsed tier shuts the span's gap slot too — the icon-only
    // pill keeps its normal icon↔chevron spacing, no dead 12px hole.
    expect(modeLabel.className).toContain("@max-[560px]:-mr-1.5");
    expect(modeLabel.className).not.toContain(":hidden");
    const thinkingLabel = document.querySelector("[data-thinking-label]") as HTMLElement;
    expect(thinkingLabel.className).toContain("@max-[500px]:max-w-0");
    expect(thinkingLabel.className).toContain("@max-[500px]:opacity-0");
    expect(thinkingLabel.className).toContain("@max-[500px]:-mr-1.5");
    expect(thinkingLabel.className).not.toContain(":hidden");
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

  // ── ROUND-67 (R67-A): the OS-picker BINARY goes into the project ────────

  it("ROUND-67 (R67-A): a BINARY OS-picker file is INGESTED — the sidecar copy's path rides the chip and the send body", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    vi.mocked(pickFilesViaBackend).mockResolvedValue(["C:\\Users\\dev\\shot.png"]);
    vi.mocked(readAttachmentFiles).mockResolvedValue([
      { path: "C:\\Users\\dev\\shot.png", name: "shot.png", size: 4096, text: null, truncated: false },
    ]);
    vi.mocked(ingestAttachmentPath).mockResolvedValue({
      path: "attachments/shot.png",
      name: "shot.png",
      size: 4096,
    });

    fireEvent.click(screen.getByRole("button", { name: "Add context" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Attach files…/ }));

    // The picker's ABSOLUTE path is handed to the sidecar for the copy.
    await waitFor(() =>
      expect(ingestAttachmentPath).toHaveBeenCalledWith(
        "prj_seed_acute",
        "shot.png",
        "C:\\Users\\dev\\shot.png",
      ),
    );
    await waitFor(() => expect(screen.getByText("shot.png")).toBeTruthy());

    fireEvent.change(textarea(), { target: { value: "read the screenshot" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(streamSessionMessage).toHaveBeenCalled());
    const opts = vi.mocked(streamSessionMessage).mock.calls[0][3];
    // The PROJECT-RELATIVE path of the copy — not the OS path — rides the wire.
    expect(opts?.attachments).toEqual([
      { name: "shot.png", path: "attachments/shot.png", size: 4096 },
    ]);
    await sendSettled();
  });

  it("ROUND-67 (R67-A): a failed INGEST keeps the chip with the picker's absolute path + a per-file toast (never silent)", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    vi.mocked(pickFilesViaBackend).mockResolvedValue(["C:\\Users\\dev\\shot.png"]);
    vi.mocked(readAttachmentFiles).mockResolvedValue([
      { path: "C:\\Users\\dev\\shot.png", name: "shot.png", size: 4096, text: null, truncated: false },
    ]);
    vi.mocked(ingestAttachmentPath).mockRejectedValue(new Error("sidecar answered HTTP 500"));

    fireEvent.click(screen.getByRole("button", { name: "Add context" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Attach files…/ }));

    await waitFor(() => expect(screen.getByText("shot.png")).toBeTruthy());
    await waitFor(() =>
      expect(useNotificationStreamStore.getState().lastNotification?.title).toBe(
        "File could not be uploaded",
      ),
    );

    // Old behavior: the chip keeps the picker's absolute path.
    fireEvent.change(textarea(), { target: { value: "read it anyway" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(streamSessionMessage).toHaveBeenCalled());
    const opts = vi.mocked(streamSessionMessage).mock.calls[0][3];
    expect(opts?.attachments).toEqual([
      { name: "shot.png", path: "C:\\Users\\dev\\shot.png", size: 4096 },
    ]);
    await sendSettled();
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

  // ── ROUND-67 (R67-A): the dropped binary's BYTES reach the project ──────

  it("ROUND-67 (R67-A): a binary drop keeps its bytes — the SEND path uploads them and the wire attachment carries the project-relative path", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    vi.mocked(uploadAttachmentBytes).mockResolvedValue({
      path: "attachments/blob.bin",
      name: "blob.bin",
      size: 4,
    });
    const binary = new Uint8Array([0x00, 0x01, 0x02, 0x00]);
    fireEvent.drop(composerBox(), { dataTransfer: { files: [new File([binary], "blob.bin")] } });
    await waitFor(() => expect(screen.getByText("blob.bin")).toBeTruthy());

    fireEvent.change(textarea(), { target: { value: "analyze this image" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    // The upload happens BEFORE the message leaves, with the exact bytes.
    await waitFor(() => expect(uploadAttachmentBytes).toHaveBeenCalledTimes(1));
    expect(uploadAttachmentBytes).toHaveBeenCalledWith("prj_seed_acute", "blob.bin", "AAECAA==");
    await waitFor(() => expect(streamSessionMessage).toHaveBeenCalled());
    const opts = vi.mocked(streamSessionMessage).mock.calls[0][3];
    expect(opts?.attachments).toEqual([
      { name: "blob.bin", path: "attachments/blob.bin", size: 4 },
    ]);
    await sendSettled();
  });

  it("ROUND-67 (R67-A): a FAILED upload keeps the old behavior (path-less attachment rides the message) + a visible per-file toast", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    vi.mocked(uploadAttachmentBytes).mockRejectedValue(new Error("sidecar answered HTTP 500"));
    const binary = new Uint8Array([0x00, 0x01, 0x02, 0x00]);
    fireEvent.drop(composerBox(), { dataTransfer: { files: [new File([binary], "blob.bin")] } });
    await waitFor(() => expect(screen.getByText("blob.bin")).toBeTruthy());

    fireEvent.change(textarea(), { target: { value: "analyze anyway" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    // The send is NEVER blocked — the attachment rides the message path-less
    // (the model sees the honest "no readable text" placeholder).
    await waitFor(() => expect(streamSessionMessage).toHaveBeenCalled());
    const opts = vi.mocked(streamSessionMessage).mock.calls[0][3];
    expect(opts?.attachments).toEqual([{ name: "blob.bin", size: 4 }]);
    // …and the failure is visible, per-file, exactly like read failures.
    await waitFor(() =>
      expect(useNotificationStreamStore.getState().lastNotification?.title).toBe(
        "File could not be uploaded",
      ),
    );
    await sendSettled();
  });
});

// ── ROUND-67 (R67-A): pasted images ─────────────────────────────────────────
describe("Composer: pasted images (ROUND-67 R67-A)", () => {
  it("pasting an image file stages a binary chip whose bytes upload on send (the path rides the wire)", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    vi.mocked(uploadAttachmentBytes).mockResolvedValue({
      path: "attachments/pasted.png",
      name: "pasted.png",
      size: 10,
    });
    // PNG magic + NUL bytes (the binary sniff is a NUL byte in the first 8KB
    // — a real screenshot always carries them; the bare 8-byte magic doesn't).
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    fireEvent.paste(textarea(), {
      clipboardData: { files: [new File([pngBytes], "pasted.png", { type: "image/png" })] },
    });

    // The chip appears (binary — "no text"), exactly like a drop.
    await waitFor(() => expect(screen.getByText("pasted.png")).toBeTruthy());
    expect(screen.getByText("no text")).toBeTruthy();

    fireEvent.change(textarea(), { target: { value: "what is in this screenshot" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(uploadAttachmentBytes).toHaveBeenCalledWith("prj_seed_acute", "pasted.png", "iVBORw0KGgoAAQ=="),
    );
    await waitFor(() => expect(streamSessionMessage).toHaveBeenCalled());
    const opts = vi.mocked(streamSessionMessage).mock.calls[0][3];
    expect(opts?.attachments).toEqual([
      { name: "pasted.png", path: "attachments/pasted.png", size: 10 },
    ]);
    await sendSettled();
  });

  it("a file paste is preventDefault'd; a TEXT-ONLY paste is untouched (native insertion, no chip)", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    // A document-level listener reads defaultPrevented AFTER React's root
    // handler ran (bubbling reaches document last) — the honest way to pin
    // "text paste keeps the default".
    let defaultPrevented: boolean | null = null;
    const onDocPaste = (e: Event): void => {
      defaultPrevented = e.defaultPrevented;
    };
    document.addEventListener("paste", onDocPaste);
    try {
      // Image file paste → intercepted (no native insertion). PNG magic +
      // NULs — a binary blob, like a real clipboard screenshot.
      const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
      fireEvent.paste(textarea(), {
        clipboardData: { files: [new File([pngBytes], "clip.png", { type: "image/png" })] },
      });
      await waitFor(() => expect(screen.getByText("clip.png")).toBeTruthy());
      expect(defaultPrevented).toBe(true);

      // Text-only paste → the browser default (no preventDefault, no chip).
      fireEvent.paste(textarea(), { clipboardData: { files: [] } });
      expect(defaultPrevented).toBe(false);
      expect(screen.queryByText("no text")).toBeTruthy(); // only the earlier chip's badge
      expect(screen.getAllByText("no text")).toHaveLength(1);
    } finally {
      document.removeEventListener("paste", onDocPaste);
    }
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

    const btn = screen.getByRole("button", { name: "Operating mode: Ask" });
    expect(btn.textContent).toContain("Ask");

    fireEvent.click(btn);
    const menu = await screen.findByRole("menu", { name: "Operating mode" });
    // R75 (owner: descriptions "should not be shown by default; only on
    // hover") / R81: the menu lists the THREE operating-mode NAMES (the
    // unified picker — "Editor" was retired); the one-line descriptions
    // ride each row's native title tooltip.
    expect(menu.textContent).toContain("Full Access");
    expect(menu.textContent).toContain("Ask");
    expect(menu.textContent).toContain("Plan");
    expect(menu.textContent).not.toContain("Editor");
    expect(menu.textContent).not.toContain("no permission asks");
    const rows = menu.querySelectorAll('[role="menuitemradio"]');
    expect(rows).toHaveLength(3);
    const titles = Array.from(rows).map((r) => r.getAttribute("title"));
    expect(titles).toContain("All tools, no permission asks — the agent decides how to work (research, plan, build, debug) and switches postures itself.");
    expect(titles).toContain("Full tools; asks before important commands and changes.");
    expect(titles).toContain("Read-only — research and plan, no edits or commands.");

    fireEvent.click(screen.getByRole("menuitemradio", { name: /Plan/ }));

    await waitFor(() => expect(patchSessionPermissions).toHaveBeenCalledWith(SESSION_ID, "plan"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Operating mode: Plan" }).textContent).toContain("Plan"),
    );
  });

  it("the label flips OPTIMISTICALLY — before the PATCH round-trip resolves", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    // The PATCH never resolves: the label must ALREADY show Plan.
    vi.mocked(patchSessionPermissions).mockImplementation(() => new Promise(() => {}));
    fireEvent.click(screen.getByRole("button", { name: "Operating mode: Ask" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /Plan/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Operating mode: Plan" })).toBeTruthy(),
    );
  });

  it("a failed PATCH rolls the label back + surfaces the error", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    vi.mocked(patchSessionPermissions).mockRejectedValue(new Error("sidecar down"));
    fireEvent.click(screen.getByRole("button", { name: "Operating mode: Ask" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /Plan/ }));

    await waitFor(() =>
      expect(useNotificationStreamStore.getState().lastNotification?.title).toBe("Mode change failed"),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Operating mode: Ask" })).toBeTruthy(),
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
          title: "Plan-mode session",
          createdAt: "2026-08-26T10:00:00Z",
          updatedAt: "2026-08-26T10:05:00Z",
          permissionMode: "plan",
        },
        events: [messageEvent(1, "user", "hello", "2026-08-26T10:00:10Z")],
      },
    ]);
    renderWithProviders(<AgentChatPanel projectId={projects[0].id} project={projects[0]} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Operating mode: Plan" })).toBeTruthy(),
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

  // ROUND-95 (R95-E, the owner: "The reasoning level… was supposed to be
  // model-specific"): the composer resolves the CURRENT effective model's
  // DETECTED reasoning capability from its provider's configured rows and
  // the button offers ONLY what that model supports.
  it("R95-E: a detected [low, medium] ladder offers Default/Low/Medium (High/Max hidden, cap note shown)", async () => {
    // The agent fixture's model is "openrouter/ox-alpha" (provider openrouter)
    // — give its config row a detected [low, medium] ladder; the extra
    // reasoningSupport field is the R95-B wire addition (ProviderModelConfig's
    // mirror type hasn't caught up — the composer reads it through its local
    // widening, so cast through the wire shape here).
    const row = {
      ...modelConfigRow({ modelId: "openrouter/ox-alpha" }),
      reasoningSupport: { supported: true, efforts: ["low", "medium"] },
    };
    vi.mocked(fetchProviderModelConfig).mockResolvedValue([row as ProviderModelConfig]);

    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Thinking level: Default" }));
    await waitFor(() => {
      expect(screen.getAllByRole("menuitemradio").map((o) => o.textContent)).toEqual([
        "DefaultThe model's own reasoning default.",
        "LowLight reasoning — fastest replies.",
        "MediumBalanced reasoning effort.",
      ]);
    });
    // ROUND-96 (R96-F): the note NAMES THE SOURCE — the detected list IS the
    // honest cap (the old "caps reasoning at medium" wording retired).
    expect(document.querySelector("[data-thinking-menu-note]")?.textContent).toBe(
      "detected from provider: low, medium",
    );
    await sendSettled();
  });

  it("R95-E: a model the catalog marks NOT reasoning-capable disables the button honestly", async () => {
    const row = {
      ...modelConfigRow({ modelId: "openrouter/ox-alpha" }),
      reasoningSupport: { supported: false, efforts: [] },
    };
    vi.mocked(fetchProviderModelConfig).mockResolvedValue([row as ProviderModelConfig]);

    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    const button = await waitFor(() =>
      screen.getByRole("button", { name: "Thinking level: No thinking" }),
    );
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute("title")).toBe("This model does not support reasoning");
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

  // R87-A1: the frosted-glass backdrop — renders with the popover, sits
  // BELOW it (z-40 vs z-50), and clicking it dismisses the popover.
  it("R87-A1: opening the popover renders the frosted backdrop; clicking it closes (owner spec F)", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    const backdrop = (): HTMLElement | null => document.querySelector("[data-model-backdrop]");
    expect(backdrop()).toBeNull(); // closed → no scrim

    fireEvent.click(screen.getByRole("button", { name: "Choose model" }));
    const popover = await screen.findByRole("menu", { name: "Choose model" });
    const scrim = backdrop();
    expect(scrim).toBeTruthy();
    // The scrim sits BELOW the popover (z-40 vs its z-50) and covers the
    // viewport — fixed inset-0. R93-A2 (owner: "it should become slightly
    // blurred only"): the frost is now a SLIGHT 1.5px (was 3px) with a
    // lighter 16% dim, and the marker carries the radius so the webview
    // guard mirrors the SAME blur into the browser page itself.
    expect(scrim?.className).toContain("fixed");
    expect(scrim?.className).toContain("inset-0");
    expect(scrim?.className).toContain("z-40");
    expect(scrim?.style.backdropFilter).toBe("blur(1.5px)");
    // happy-dom normalizes the rgba() spacing.
    expect(scrim?.style.background).toBe("rgba(0, 0, 0, 0.16)");
    expect(scrim?.dataset.webviewBackdrop).toBe("1.5");
    expect(popover.className).toContain("z-50");

    // Clicking the backdrop dismisses the whole thing (popover + scrim).
    fireEvent.click(scrim as HTMLElement);
    await waitFor(() => expect(backdrop()).toBeNull());
    expect(screen.queryByRole("menu", { name: "Choose model" })).toBeNull();
  });
});

// ── F2. Model selector × models config (ROUND-58 R58-d → ROUND-64 R64-d) ───
// R64-d: the flyout is CONFIG-ONLY — these cases pin the Settings-sourced
// list itself (hidden exclusion, display names, pricing filter, honest
// failure) instead of the old live+config merge.
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
      modelConfigRow({ modelId: "z-ai/glm-5.2:free" }),
      modelConfigRow({ modelId: "openrouter/ox-alpha" }),
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

  it("a config row with an EMPTY display name falls back to the raw id — and the R58-d \"configured\" dot is retired (R64-d)", async () => {
    vi.mocked(fetchProviderModelConfig).mockResolvedValue([
      modelConfigRow({ modelId: "z-ai/glm-5.2:free", displayName: "" }),
      modelConfigRow({ modelId: "openrouter/ox-alpha" }),
    ]);
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    await openFlyout();
    // Empty displayName → the raw id stays the row's label.
    expect(screen.getByRole("option", { name: "z-ai/glm-5.2:free" })).toBeTruthy();
    // R64-d: the flyout is config-only, so EVERY row is a configured row —
    // the marker carried no information and is gone entirely.
    expect(
      document.querySelector('[title="Configured in Settings — pricing and visibility customized"]'),
    ).toBeNull();
  });

  it("a config price of $0 makes a paid-id model count as FREE for the shared filter", async () => {
    vi.mocked(fetchProviderModelConfig).mockResolvedValue([
      modelConfigRow({ modelId: "openrouter/ox-alpha", inputPricePerMtok: 0 }),
      modelConfigRow({ modelId: "openrouter/gpt-5.2" }),
    ]);
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    await openFlyout();
    // Free-only default now lists ONLY the configured $0-priced one
    // (isFreeModelEntry honors inputPricePerMtok === 0).
    await waitFor(() =>
      expect(screen.getAllByRole("option").map((o) => o.getAttribute("title"))).toEqual([
        "openrouter/ox-alpha",
      ]),
    );
    // The paid-hidden hint counts only the remaining unknown-price model.
    expect(screen.getByText("1 paid model hidden — show all")).toBeTruthy();
  });

  it("a FAILING config fetch renders the honest error row — no catalog fallback (R64-d)", async () => {
    // R95-E: the Composer itself now consumes the same
    // fetchProviderModelConfig (the thinking button's capability query), so
    // the mock must fail for EVERY call — a one-shot mockRejectedValueOnce
    // would be eaten by the Composer's own mount query and the flyout would
    // see the healthy default instead of the error under test.
    vi.mocked(fetchProviderModelConfig).mockRejectedValue(
      new Error("models-config unreachable"),
    );
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Choose model" }));
    await screen.findByRole("menu", { name: "Choose model" });
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Models of OpenRouter" })).toBeTruthy(),
    );
    fireEvent.mouseEnter(screen.getByRole("menuitem", { name: "Models of OpenRouter" }));
    await screen.findByRole("listbox", { name: "Models of OpenRouter" });
    // The config (the flyout's only source) failed → the honest error row,
    // NOT the old live-catalog ids-only fallback.
    expect(
      await screen.findByText("couldn't load this provider's models — check the connection and retry"),
    ).toBeTruthy();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(fetchProviderModels).not.toHaveBeenCalled();
  });
});

// ── ROUND-62 (R62-2b) → ROUND-64 (R64-d): session-page reflection of ──────
// Models & Providers edits. R62-2b made the flyout a UNION (config-only
// rows joined the live catalog, and disabled providers left the popover).
// R64-d (owner: "only the models which I had added in the models and
// providers Page should be shown") removed the catalog half: the flyout
// lists EXACTLY the provider's config rows.
describe("Composer: model picker reflects Models & Providers edits (R62-2b / R64-d)", () => {
  /** Open the popover + hover the OpenRouter row → the flyout, settled: the
   * R64-d config-only list renders honest ROWS (empty/error) when there is
   * nothing to pick, so the wait is on "loading…" being gone — NOT on
   * options existing. */
  async function openFlyout() {
    fireEvent.click(screen.getByRole("button", { name: "Choose model" }));
    await screen.findByRole("menu", { name: "Choose model" });
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Models of OpenRouter" })).toBeTruthy(),
    );
    fireEvent.mouseEnter(screen.getByRole("menuitem", { name: "Models of OpenRouter" }));
    await screen.findByRole("listbox", { name: "Models of OpenRouter" });
    await waitFor(() => expect(screen.queryByText("loading models…")).toBeNull());
  }

  it("a config-only row (added by id in Settings) IS the list — display name label, raw id pick (R64-d)", async () => {
    // A $0-priced config-only row: free under the default free-only filter.
    vi.mocked(fetchProviderModelConfig).mockResolvedValue([
      modelConfigRow({
        modelId: "custom/manual-model",
        displayName: "Manual Model",
        inputPricePerMtok: 0,
        outputPricePerMtok: 0,
      }),
    ]);
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    await openFlyout();
    // The flyout lists EXACTLY the config rows — no live-catalog ids ride
    // along anymore (the union order is gone with the union itself).
    await waitFor(() =>
      expect(screen.getAllByRole("option").map((o) => o.getAttribute("title"))).toEqual([
        "custom/manual-model",
      ]),
    );
    // …with the Settings display name as the accessible label.
    expect(screen.getByRole("option", { name: "Manual Model" }).getAttribute("title")).toBe(
      "custom/manual-model",
    );

    // Picking it persists the RAW id (the API identifier).
    fireEvent.click(screen.getByRole("option", { name: "Manual Model" }));
    await waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem(`acute-model:${SESSION_ID}`) ?? "null")).toEqual({
        model: "custom/manual-model",
        providerId: "openrouter",
      }),
    );
  });

  it("a CATALOG-ONLY model is NOT listed — the live catalog no longer feeds the flyout (R64-d)", async () => {
    // Config: only the manual row. The live-catalog mock still offers the
    // 3-model mix — none of it may appear.
    vi.mocked(fetchProviderModelConfig).mockResolvedValue([
      modelConfigRow({ modelId: "custom/manual-model", inputPricePerMtok: 0 }),
    ]);
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    await openFlyout();
    const titles = screen.getAllByRole("option").map((o) => o.getAttribute("title"));
    expect(titles).toEqual(["custom/manual-model"]);
    for (const catalogOnly of MODELS) {
      expect(titles).not.toContain(catalogOnly);
    }
    // The live-catalog fn is never even issued (the query was removed from
    // the component — the mock only exists to prove the negative).
    expect(fetchProviderModels).not.toHaveBeenCalled();
  });

  it("a HIDDEN config-only row is excluded and counted in the honest footer note", async () => {
    vi.mocked(fetchProviderModelConfig).mockResolvedValue([
      modelConfigRow({ modelId: "custom/manual-model", hidden: true }),
    ]);
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    await openFlyout();
    // The only config row is hidden → nothing selectable, the honest
    // empty-state row points at Settings (NO catalog fallback)…
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.queryByTitle("custom/manual-model")).toBeNull();
    expect(
      screen.getByText("No models configured — add them in Settings → Models & Providers"),
    ).toBeTruthy();
    // …and the hidden-row footer note still counts it.
    expect(screen.getByText("1 model hidden in Settings")).toBeTruthy();
  });

  it("an EMPTY config renders the honest pointer row — no options, no catalog fallback (R64-d)", async () => {
    vi.mocked(fetchProviderModelConfig).mockResolvedValue([]);
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    await openFlyout();
    expect(
      screen.getByText("No models configured — add them in Settings → Models & Providers"),
    ).toBeTruthy();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(fetchProviderModels).not.toHaveBeenCalled();
  });

  it("a provider DISABLED in Settings is absent from the popover (enabled one stays; the button keeps the current model)", async () => {
    // Z.AI disabled server-side (the Settings toggle's PATCH landed).
    vi.mocked(fetchProviders).mockResolvedValue(
      PROVIDERS.map((p) => (p.id === "z-ai" ? { ...p, enabled: false } : { ...p })),
    );
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Choose model" }));
    const menu = await screen.findByRole("menu", { name: "Choose model" });
    // The enabled provider's row is there…
    await waitFor(() =>
      expect(within(menu).getByRole("menuitem", { name: "Models of OpenRouter" })).toBeTruthy(),
    );
    // …and the disabled one never renders.
    expect(within(menu).queryByRole("menuitem", { name: "Models of Z.AI" })).toBeNull();
    // The button itself still shows the AGENT's model (provider label lookup
    // keeps the unfiltered list — a disabled provider stays honest there).
    const label = document.querySelector("[data-model-label]") as HTMLElement | null;
    expect(label?.textContent).toBe("openrouter/ox-alpha");
  });
});

// ── ROUND-89 (R89-B3/B4): keyless providers leave the picker; the
// last-used model becomes the next chats' default. ────────────────────────
describe("Composer: model picker — the R89 provider filter + last-used memory", () => {
  it("B3: a KEYLESS provider (never added) is absent from the popover — no dead 'no models' rows", async () => {
    // A seeded built-in the owner never configured rides the providers
    // list (hasKey false) — the owner's verdict: those rows showed
    // "no models configured" in chat despite never being added.
    vi.mocked(fetchProviders).mockResolvedValue([
      ...PROVIDERS,
      {
        id: "anthropic",
        name: "Anthropic",
        kind: "anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        enabled: true,
        createdAt: "2026-08-20T09:02:00Z",
        hasKey: false,
      },
    ]);
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Choose model" }));
    const menu = await screen.findByRole("menu", { name: "Choose model" });
    await waitFor(() =>
      expect(within(menu).getByRole("menuitem", { name: "Models of OpenRouter" })).toBeTruthy(),
    );
    expect(within(menu).queryByRole("menuitem", { name: "Models of Anthropic" })).toBeNull();
  });

  it("B4: picking a model remembers it GLOBALLY (acute.lastModel) — the next chats' default", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Choose model" }));
    await screen.findByRole("menu", { name: "Choose model" });
    fireEvent.mouseEnter(screen.getByRole("menuitem", { name: "Models of OpenRouter" }));
    await screen.findByRole("listbox", { name: "Models of OpenRouter" });
    await waitFor(() =>
      expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["z-ai/glm-5.2:free"]),
    );
    fireEvent.click(screen.getByRole("option", { name: "z-ai/glm-5.2:free" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Choose model" }).textContent).toContain(
        "z-ai/glm-5.2:free",
      ),
    );
    // THE R89-B4 ASSERTION: the pick landed in the GLOBAL key too (the
    // per-session key was already asserted by the ROUND-50 test above).
    expect(JSON.parse(window.localStorage.getItem("acute.lastModel") ?? "null")).toEqual({
      model: "z-ai/glm-5.2:free",
      providerId: "openrouter",
    });
  });
});

// ── G. Context donut ────────────────────────────────────────────────────────
describe("Composer: context donut (owner spec G)", () => {
  it("renders the ring from GET /sessions/:id/context — ICON-ONLY (no value beside it; R51-c kept, R95-F REVERSED by R96-H)", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    const donut = await screen.findByRole("button", { name: /~42% of context window projected/ });
    // ROUND-51 (R51-c) KEPT: NO PERCENTAGE beside the ring — the % still
    // lives on the button's title/aria-label and inside the popover.
    // ROUND-96 (R96-H) — the owner's seventh report REVERSED R95-F's inline
    // MEASURED readout ("The context window was showing me how many tokens
    // have been used and such… It should not show that value alongside
    // it."): the ring renders ALONE at rest. The measured count moved to the
    // hover popover (asserted in the popover test below), joining the % —
    // the R51 icon-only contract, restored in full. The ring itself stays
    // the ~-labeled ESTIMATE (R83 one-rule: every number carries its basis,
    // never conflated).
    expect(document.querySelector("[data-donut-label]")).toBeNull();
    expect(donut.textContent?.trim()).toBe("");
    expect(donut.querySelector("svg")).toBeTruthy();
    // ROUND-83 (R83): the title is the honest two-number summary — the
    // projection LABELED with a ~ + the provider's measured number.
    expect(donut.getAttribute("title")).toContain("~42% of context window projected");
    expect(donut.getAttribute("title")).toContain("390k measured at last request");
    // ROUND-82: the meter now carries the EFFECTIVE provider as a third arg —
    // the report keys its window/pricing lookups on the provider that will
    // serve the next send (override ?? agent.providerId; here the agent's).
    expect(fetchSessionContext).toHaveBeenCalledWith(SESSION_ID, "openrouter/ox-alpha", "openrouter");
  });

  it("popover shows the big donut, breakdown mini-bars, cache line, and session totals", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    fireEvent.click(await screen.findByRole("button", { name: /~42% of context window projected/ }));
    const popover = await screen.findByRole("dialog", { name: "Context window details" });

    // Big donut summary (ROUND-83): "~% projected" + used / window tokens
    // · estimated + the MEASURED line + the model.
    expect(popover.textContent).toContain("~42% projected");
    // R91-H: the million tier — a 1,000,000-token window renders as 1m.
    expect(popover.textContent).toContain("420k / 1m tokens · estimated");
    // ROUND-95 (R95-F): the measured line was PROMOTED to a two-span row
    // (bold number + label), so the DOM concatenates without the space this
    // used to assert — number + basis still both pinned.
    expect(popover.textContent).toContain("390kmeasured at last request");
    expect(popover.textContent).toContain("openrouter/ox-alpha");
    // The budget line (the compaction-line tick + the output reserve) and
    // the window's provenance.
    expect(popover.querySelector("[data-context-budget]")?.textContent).toContain("compaction line 959k");
    expect(popover.querySelector("[data-context-budget]")?.textContent).toContain("your override");

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
    expect(group("main").textContent).toContain("Turns");
    // ROUND-83 (R83): the real SDK-call count beside the turns (7 turns ·
    // 9 calls — the multi-iteration distinction, pinned).
    expect(group("main").textContent).toContain("Provider calls");
    expect(group("main").textContent).toContain("9");
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

    fireEvent.click(await screen.findByRole("button", { name: /~42% of context window projected/ }));
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
    const donut = await screen.findByRole("button", { name: /~42% of context window projected/ });

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
    const donut = await screen.findByRole("button", { name: /~42% of context window projected/ });

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
    const donut = await screen.findByRole("button", { name: /~42% of context window projected/ });

    vi.useFakeTimers();
    const popoverEl = (): HTMLElement | null => document.querySelector("[data-context-popover]");
    fireEvent.focus(donut);
    expect(popoverEl()).not.toBeNull(); // no advanceTimersByTime needed
    vi.useRealTimers();
  });

  it("HOVER BRIDGE: leaving the trigger does NOT close instantly; entering the popover cancels the timer (R51-c)", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();
    const donut = await screen.findByRole("button", { name: /~42% of context window projected/ });

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
    const donut = await screen.findByRole("button", { name: /~42% of context window projected/ });

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
    const donut = await screen.findByRole("button", { name: /~70% of context window projected/ });
    // circles[0] = track, circles[1] = the arc — amber in the 60–85% band.
    expect(donut.querySelectorAll("circle")[1].getAttribute("stroke")).toBe(DONUT_WARN_COLOR);

    cleanup();
    vi.mocked(fetchSessionContext).mockResolvedValue({ ...CONTEXT_REPORT, usedTokens: 900_000 });
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();
    const hot = await screen.findByRole("button", { name: /~90% of context window projected/ });
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

// ── R87-A1: flyoutRetargetIntent — pure trajectory math ─────────────────────
describe("flyoutRetargetIntent (R87-A1) — pure unit tests", () => {
  // A flyout sitting to the RIGHT of the provider rows (the usual side).
  const rightFlyout: PlainRect = { top: 100, bottom: 380, left: 960, right: 1240 };
  // …and one to the LEFT (the narrow-viewport side).
  const leftFlyout: PlainRect = { top: 100, bottom: 380, left: 20, right: 300 };

  it("no movement sample (keyboard/touch/jsdom), stationary-ish pointer, or unknown flyout rect → instant retarget (old behavior)", () => {
    expect(flyoutRetargetIntent(null, 500, rightFlyout)).toBe("retarget");
    expect(flyoutRetargetIntent({ dx: 1, dy: 1 }, 500, rightFlyout)).toBe("retarget"); // < 3px jitter
    expect(flyoutRetargetIntent({ dx: 40, dy: 0 }, 500, null)).toBe("retarget"); // nothing to aim at yet
  });

  it("mostly-horizontal movement toward the flyout's x-range → CORRIDOR (never re-target mid-transit)", () => {
    // Pointer left of a right-side flyout, moving right (and even a bit down
    // — diagonals toward a vertically-clamped flyout).
    expect(flyoutRetargetIntent({ dx: 24, dy: 8 }, 400, rightFlyout)).toBe("corridor");
    expect(flyoutRetargetIntent({ dx: 15, dy: 12 }, 400, rightFlyout)).toBe("corridor");
    // Pointer right of a left-side flyout, moving left.
    expect(flyoutRetargetIntent({ dx: -24, dy: 8 }, 700, leftFlyout)).toBe("corridor");
  });

  it("mostly-vertical movement or heading AWAY from the flyout → SCAN (hold, promote after the dwell)", () => {
    // Scanning down the provider list (the rows are the only thing under
    // the pointer) — even with a horizontal drift.
    expect(flyoutRetargetIntent({ dx: 4, dy: 28 }, 400, rightFlyout)).toBe("scan");
    expect(flyoutRetargetIntent({ dx: 0, dy: -28 }, 400, rightFlyout)).toBe("scan");
    // Horizontal but AWAY from the flyout's x-range.
    expect(flyoutRetargetIntent({ dx: -30, dy: 0 }, 400, rightFlyout)).toBe("scan");
    // Moving right while ALREADY inside the flyout's x-range (beside it,
    // not toward it).
    expect(flyoutRetargetIntent({ dx: 30, dy: 0 }, 1000, rightFlyout)).toBe("scan");
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
          queued: [],
          deliveredQueued: [],
          queueKeptNotice: null,
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

// ── ROUND-78 (R78-B + R78-D): the ACTION ANCHOR + the queue-send button ─────
// R78-B (owner: "Continue 按钮等选项有时位置异常" — the action buttons
// occasionally render in a wrong position): while a turn runs, the action
// group holds BOTH Stop AND the queue-send button, OUTSIDE the wrapping
// area (a direct toolbar child pinned right by justify-between) — the
// actions can never wrap, so their position is stable at every width.
// R78-D (owner: "工作中发送消息（排队）" — send while the agent works): the
// queue-send button routes to onQueue (runTurn's queue path →
// POST /sessions/:id/queue), NOT the normal send; Enter does the same.
describe("Composer: the action anchor + queue-send (ROUND-78 R78-B/R78-D)", () => {
  /** Arm a LIVE stream on the session (streamBusy + an open liveTurn) — the
   * panel's `busy` follows the store, so the busy composer renders without
   * driving a real send. */
  function armLiveStream(): void {
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
          queued: [],
          deliveredQueued: [],
          queueKeptNotice: null,
        },
      },
    });
  }

  /** Render the docked composer with the live stream armed (busy). */
  async function renderBusyComposer(): Promise<void> {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();
    armLiveStream();
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop generation" })).toBeTruthy());
  }

  it("while busy: Stop AND Queue-send coexist in THE ANCHOR — a direct toolbar child, outside the wrapping area", async () => {
    await renderBusyComposer();

    const stop = screen.getByRole("button", { name: "Stop generation" }) as HTMLElement;
    // R91-F: the queue affordance appears only once text is typed — stage
    // text first so BOTH buttons are live for the anchor-structure checks.
    fireEvent.change(textarea(), { target: { value: "queued follow-up" } });
    const queue = (await screen.findByRole("button", { name: "Queue message" })) as HTMLElement;
    const actions = document.querySelector("[data-composer-actions]") as HTMLElement;
    const toolbar = document.querySelector("[data-composer-toolbar]") as HTMLElement;
    expect(actions).toBeTruthy();
    // BOTH action buttons live in the anchor group.
    expect(actions.contains(stop)).toBe(true);
    expect(actions.contains(queue)).toBe(true);
    // The anchor is a DIRECT toolbar child (a sibling of the wrapping area —
    // never inside it) and the LAST one (justify-between pins it right).
    expect(actions.parentElement).toBe(toolbar);
    const wrapArea = (document.querySelector("[data-composer-left]") as HTMLElement)
      .parentElement as HTMLElement;
    expect(wrapArea.parentElement).toBe(toolbar);
    const kids = Array.from(toolbar.children) as HTMLElement[];
    expect(kids.indexOf(actions)).toBe(kids.length - 1);
    // The wrapping area (not the toolbar) carries the wrap fallback.
    expect(wrapArea.className).toContain("flex-wrap");
    expect(toolbar.className).not.toContain("flex-wrap");
    // The busy composer shows NO Send button (Stop owns that state).
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
  });

  it("the queue-send button is GONE while the input is empty and appears with text (R91-F — the owner: only when a message is typed)", async () => {
    await renderBusyComposer();

    // Empty composer: NO queue button at all (the pre-R91 disabled ghost
    // read as a second send button doing nothing).
    expect(screen.queryByRole("button", { name: "Queue message" })).toBeNull();

    // Text lands → the affordance appears, immediately usable.
    fireEvent.change(textarea(), { target: { value: "and also add tests" } });
    const queue = await screen.findByRole("button", { name: "Queue message" });
    expect((queue as HTMLButtonElement).disabled).toBe(false);
    expect(queue.getAttribute("title")).toBe(
      "Queues right after the agent finishes the current step",
    );
  });

  it("clicking Queue-send POSTs the QUEUE (not the send) and clears the composer", async () => {
    await renderBusyComposer();

    fireEvent.change(textarea(), { target: { value: "and also add tests" } });
    fireEvent.click(screen.getByRole("button", { name: "Queue message" }));

    await waitFor(() => expect(queueSessionMessage).toHaveBeenCalled());
    // The queue POST carries the session + the typed content.
    expect(vi.mocked(queueSessionMessage).mock.calls.at(-1)).toEqual([
      SESSION_ID,
      { content: "and also add tests" },
    ]);
    // The normal send NEVER fired — the in-flight stream is untouched.
    expect(streamSessionMessage).not.toHaveBeenCalled();
    // The composer text cleared exactly like a normal send.
    await waitFor(() => expect(textarea().value).toBe(""));
  });

  it("Enter while busy routes to the QUEUE (the R78-D keyboard path)", async () => {
    await renderBusyComposer();

    fireEvent.change(textarea(), { target: { value: "follow-up while you work" } });
    fireEvent.keyDown(textarea(), { key: "Enter" });

    await waitFor(() => expect(queueSessionMessage).toHaveBeenCalled());
    expect(vi.mocked(queueSessionMessage).mock.calls.at(-1)).toEqual([
      SESSION_ID,
      { content: "follow-up while you work" },
    ]);
    expect(streamSessionMessage).not.toHaveBeenCalled();
    await waitFor(() => expect(textarea().value).toBe(""));
  });

  it("WITHOUT onQueue (fixture/demo mode): busy renders Stop ONLY — no queue button, Enter does nothing (the legacy behavior)", async () => {
    // Fixture mode FROM THE START (flipping demoData mid-render swaps the
    // data source and re-resolves the session — not what this pins). The
    // mock's backend selectors are mode-independent, so the same fixture
    // conversation renders; liveMode=false is the only difference.
    useConfigStore.setState({ demoData: true });
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();
    armLiveStream();
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop generation" })).toBeTruthy());

    // liveMode false → the panel passes NO onQueue → no queue-send button.
    expect(screen.queryByRole("button", { name: "Queue message" })).toBeNull();

    fireEvent.change(textarea(), { target: { value: "no queue in demo mode" } });
    fireEvent.keyDown(textarea(), { key: "Enter" });
    // Nothing fired — no queue POST, no send (the pre-R78 no-op stands).
    expect(queueSessionMessage).not.toHaveBeenCalled();
    expect(streamSessionMessage).not.toHaveBeenCalled();
    // The text stays (the send was refused, not queued).
    expect(textarea().value).toBe("no queue in demo mode");
  });
});

/* ── ROUND-92 (R92-B): the picker's SELF-HEAL — an unconfigured agent arms
 * itself from the first chat pick. The decision helper (pure), then the flow
 * through the panel: a NULL/NULL session agent (the R91-A force-delete reset
 * state) + a picker pick → PATCH /agents/:id with the picked pair, while a
 * CONFIGURED agent keeps today's localStorage-only override semantics. ───── */
describe("shouldArmAgentFromPick (ROUND-92 R92-B) — pure unit tests", () => {
  const pair: ModelOverride = { model: "z-ai/glm-5.2:free", providerId: "openrouter" };

  it("arms ONLY an unconfigured agent — either side null qualifies", () => {
    expect(shouldArmAgentFromPick(pair, { providerId: null, model: null })).toBe(true);
    expect(shouldArmAgentFromPick(pair, { providerId: "openrouter", model: null })).toBe(true);
    expect(shouldArmAgentFromPick(pair, { providerId: null, model: "z-ai/glm-5.2:free" })).toBe(true);
  });

  it("a CONFIGURED agent NEVER arms from a pick (the override stays per-send)", () => {
    expect(
      shouldArmAgentFromPick(pair, { providerId: "openrouter", model: "openrouter/ox-alpha" }),
    ).toBe(false);
  });

  it("no pick (the override cleared) or no agent → never arms", () => {
    expect(shouldArmAgentFromPick(null, { providerId: null, model: null })).toBe(false);
    expect(shouldArmAgentFromPick(pair, null)).toBe(false);
    expect(shouldArmAgentFromPick(null, null)).toBe(false);
  });
});

describe("Composer: the picker self-heal (ROUND-92 R92-B)", () => {
  /** The R91-A end-state as a fixture agent: NULL/NULL, non-template. */
  function unconfiguredAgent() {
    return {
      id: "agt_reset_probe",
      name: "Reset Probe",
      role: "implementer",
      systemPrompt: "You do the work.",
      providerId: null,
      model: null,
      visionModel: null,
      allowedTools: [],
      memoryPolicy: "every-turn" as const,
      skills: [],
      maxTurns: 40,
      temperature: 0.2,
      isTemplate: false,
      version: 4,
      createdAt: "2026-09-11T09:00:00Z",
      updatedAt: "2026-09-11T09:00:00Z",
    };
  }

  /** A session bound to the unconfigured agent, with one persisted turn. */
  async function renderPanelWithUnconfiguredAgent(): Promise<void> {
    const projects = await getFixtureProjects().list();
    const backend = createFixtureAgents([unconfiguredAgent()]);
    customAgentsBackend.backend = backend;
    customBackend.backend = createFixtureSessions([
      {
        session: {
          id: SESSION_ID,
          projectId: projects[0].id,
          agentId: "agt_reset_probe",
          mode: "single",
          status: "completed",
          title: "Self-heal probe",
          createdAt: "2026-09-11T10:00:00Z",
          updatedAt: "2026-09-11T10:05:00Z",
        },
        events: [
          {
            seq: 1,
            type: "message.user",
            agentId: "agt_reset_probe",
            payload: { role: "user", content: "first question", agentId: "agt_reset_probe", ts: "2026-09-11T10:00:10Z" },
            ts: "2026-09-11T10:00:10Z",
          },
          {
            seq: 2,
            type: "message.assistant",
            agentId: "agt_reset_probe",
            payload: { role: "assistant", content: "first answer", agentId: "agt_reset_probe", ts: "2026-09-11T10:00:20Z" },
            ts: "2026-09-11T10:00:20Z",
          },
        ],
      },
    ]);
    renderWithProviders(<AgentChatPanel projectId={projects[0].id} project={projects[0]} />);
  }

  it("picking a model on the UNCONFIGURED agent PATCHes the agent row with the picked pair", async () => {
    await renderPanelWithUnconfiguredAgent();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    const updateSpy = vi.spyOn(customAgentsBackend.backend!, "update");
    try {
      // The button honestly shows the unconfigured state.
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Choose model" }).textContent).toBe("no model"),
      );

      // Open the picker → hover the provider → pick the free model (the
      // same interaction the R50-c2 suite drives).
      fireEvent.click(screen.getByRole("button", { name: "Choose model" }));
      const popover = await screen.findByRole("menu", { name: "Choose model" });
      await waitFor(() => expect(popover.textContent).toContain("OpenRouter"));
      fireEvent.mouseEnter(screen.getByRole("menuitem", { name: "Models of OpenRouter" }));
      await screen.findByRole("listbox", { name: "Models of OpenRouter" });
      await waitFor(() =>
        expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["z-ai/glm-5.2:free"]),
      );
      fireEvent.click(screen.getByRole("option", { name: "z-ai/glm-5.2:free" }));

      // THE self-heal pin: the pick armed the agent row.
      await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1));
      expect(updateSpy.mock.calls[0]).toEqual([
        "agt_reset_probe",
        { providerId: "openrouter", model: "z-ai/glm-5.2:free" },
      ]);

      // The per-send override semantics are UNCHANGED — the pick still
      // persists to localStorage and the button shows it.
      expect(
        JSON.parse(window.localStorage.getItem(`acute-model:${SESSION_ID}`) ?? "null"),
      ).toEqual({ model: "z-ai/glm-5.2:free", providerId: "openrouter" });
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Choose model" }).textContent).toBe(
          "z-ai/glm-5.2:free",
        ),
      );
    } finally {
      updateSpy.mockRestore();
    }
  });

  it("picking a model on a CONFIGURED agent NEVER writes the row (localStorage only, exactly as before R92)", async () => {
    await renderPanelWithConversation();
    expect(await screen.findByText("first question", {}, { timeout: 5000 })).toBeTruthy();

    const { getFixtureAgents } = await import("../../../lib/agent-fixtures");
    const updateSpy = vi.spyOn(getFixtureAgents(), "update");
    try {
      fireEvent.click(screen.getByRole("button", { name: "Choose model" }));
      const popover = await screen.findByRole("menu", { name: "Choose model" });
      await waitFor(() => expect(popover.textContent).toContain("OpenRouter"));
      fireEvent.mouseEnter(screen.getByRole("menuitem", { name: "Models of OpenRouter" }));
      await screen.findByRole("listbox", { name: "Models of OpenRouter" });
      await waitFor(() =>
        expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["z-ai/glm-5.2:free"]),
      );
      fireEvent.click(screen.getByRole("option", { name: "z-ai/glm-5.2:free" }));

      // The override lands; the row is NEVER written.
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Choose model" }).textContent).toBe(
          "z-ai/glm-5.2:free",
        ),
      );
      expect(updateSpy).not.toHaveBeenCalled();
    } finally {
      updateSpy.mockRestore();
    }
  });
});
