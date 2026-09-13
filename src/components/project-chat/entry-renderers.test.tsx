// @vitest-environment happy-dom
/**
 * ROUND-95 (R95-F) tests — the working-entry RENDERER REGISTRY
 * (src/components/project-chat/entry-renderers.tsx), the extensibility step
 * for the owner's "it should be able to display various other info in the
 * future too… much more compatible in the future, much more robust".
 *
 * The registry is deliberately UNWIRED into WorkingSection this round (D's
 * committed file — see the module's ADOPTION PATH header). These tests pin
 * the registry's own contract so the wire-up round inherits a proven
 * dispatch: default coverage, the missing-kinds gate, context threading,
 * replacement/unregistration, the surface skip rule, and the honest
 * placeholder for unregistered + never-seen kinds.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import {
  KNOWN_WORKING_ENTRY_KINDS,
  missingWorkingEntryKinds,
  pendingAdoptionNote,
  registeredWorkingEntryKinds,
  registerWorkingEntryRenderer,
  renderWorkingEntry,
  resetWorkingEntryRenderersForTests,
  unregisterWorkingEntryRenderer,
  workingEntryRegistrationMeta,
  type WorkingEntryRenderContext,
} from "./entry-renderers";
import type { WorkingEntry } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetWorkingEntryRenderersForTests();
});

const CTX: WorkingEntryRenderContext = {
  surface: "section",
  entryIndex: 0,
  liveEntryIndex: 0,
  live: true,
  sessionId: "sess_r95f",
  projectId: "proj_r95f",
};

/** Render one entry through the registry inside a stable host. */
function renderEntry(entry: WorkingEntry, ctx: Partial<WorkingEntryRenderContext> = {}): void {
  renderWithProviders(<div data-testid="registry-host">{renderWorkingEntry(entry, { ...CTX, ...ctx })}</div>);
}

describe("ROUND-95 (R95-F) registry coverage — the wire-up gate", () => {
  it("knows every WorkingEntry kind (the exhaustiveness map stays in lockstep)", () => {
    expect([...KNOWN_WORKING_ENTRY_KINDS].sort()).toEqual([
      "approval",
      "question",
      "screenshot",
      "text",
      "thinking",
      "todo",
      "tool",
    ]);
  });

  it("registers the four importable kinds by default; the three module-internal kinds are the honest gap", () => {
    expect(registeredWorkingEntryKinds().sort()).toEqual(["question", "screenshot", "thinking", "todo"]);
    // text/tool/approval render inside WorkingSection.tsx (module-internal
    // NarrationRow/ToolLine/ApprovalRow) — the wire-up round exports +
    // registers them; until then the gate reports exactly these three.
    expect(missingWorkingEntryKinds().sort()).toEqual(["approval", "text", "tool"]);
    expect(pendingAdoptionNote("text")).toContain("NarrationRow");
    expect(pendingAdoptionNote("tool")).toContain("ToolLine");
    expect(pendingAdoptionNote("approval")).toContain("ApprovalRow");
    expect(pendingAdoptionNote("todo")).toBeUndefined();
  });
});

describe("ROUND-95 (R95-F) dispatch — the default renderers", () => {
  it("a thinking entry renders ThoughtRow (live when it is the live entry)", () => {
    renderEntry({ type: "thinking", text: "weighing the options carefully", ts: "2026-09-13T10:00:00Z" });
    expect(screen.getByText("Thinking")).toBeTruthy();
    expect(screen.getByText("weighing the options carefully")).toBeTruthy();
  });

  it("a thinking entry that is NOT the live entry renders settled (Thought)", () => {
    renderEntry(
      { type: "thinking", text: "a completed thought", ts: "2026-09-13T10:00:00Z" },
      { live: false, liveEntryIndex: undefined },
    );
    expect(screen.getByText("Thought")).toBeTruthy();
  });

  it("a pending question entry renders the QuestionCard with its option pills (resolver wired)", () => {
    renderEntry(
      {
        type: "question",
        questionId: "q1",
        questions: [{ question: "Pick one", options: ["first", "second"], allowCustom: false }],
        status: "pending",
        ts: "2026-09-13T10:00:00Z",
      },
      { onQuestionAnswer: () => undefined },
    );
    expect(screen.getByTestId("question-card-pending")).toBeTruthy();
    expect(screen.getByText("Pick one")).toBeTruthy();
    expect(screen.getByRole("button", { name: "first" })).toBeTruthy();
  });

  it("the same entry WITHOUT a resolver renders read-only (no dead option buttons)", () => {
    renderEntry(
      {
        type: "question",
        questionId: "q1",
        questions: [{ question: "Pick one", options: ["first", "second"], allowCustom: false }],
        status: "pending",
        ts: "2026-09-13T10:00:00Z",
      },
      { onQuestionAnswer: undefined },
    );
    expect(screen.getByText("Pick one")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "first" })).toBeNull();
  });

  it("a todo entry renders the TodoCard with its items", () => {
    renderEntry({
      type: "todo",
      items: [
        { content: "survey the code", status: "completed" },
        { content: "write the fix", status: "in_progress" },
      ],
      ts: "2026-09-13T10:00:00Z",
    });
    expect(screen.getByTestId("todo-card")).toBeTruthy();
    expect(screen.getByText("survey the code")).toBeTruthy();
    expect(screen.getByText("write the fix")).toBeTruthy();
  });

  it("a screenshot entry renders the inline ScreenshotRow on the section surface", () => {
    renderEntry({ type: "screenshot", frameId: "frame_r95f", tool: "screenshot", ts: "2026-09-13T10:00:00Z" });
    expect(screen.getByTestId("screenshot-row")).toBeTruthy();
  });

  it("the SAME screenshot entry skips on the bare surface (WorkingSection's live-only rule, verbatim)", () => {
    renderEntry({ type: "screenshot", frameId: "frame_r95f", tool: "screenshot", ts: "2026-09-13T10:00:00Z" }, {
      surface: "bare",
    });
    expect(screen.queryByTestId("screenshot-row")).toBeNull();
    // The host rendered — with an empty (skipped) body, no placeholder.
    expect(screen.getByTestId("registry-host")).toBeTruthy();
    expect(document.body.textContent).not.toContain("unrecognized");
  });
});

describe("ROUND-95 (R95-F) honest placeholders", () => {
  it("an UNREGISTERED known kind renders the explicit not-registered-yet note (never 'unknown')", () => {
    renderEntry({ type: "text", content: "narration", ts: "2026-09-13T10:00:00Z" });
    const row = document.querySelector("[data-unknown-entry-kind='text']");
    expect(row?.textContent).toContain("text — renderer not registered yet");
  });

  it("a NEVER-SEEN kind (a future wire variant) renders the unrecognized note — no crash, no drop", () => {
    renderEntry({ type: "plutonium", payload: { shiny: true } } as unknown as WorkingEntry);
    const row = document.querySelector("[data-unknown-entry-kind='plutonium']");
    expect(row?.textContent).toContain("unrecognized entry kind: plutonium");
  });
});

describe("ROUND-95 (R95-F) registration lifecycle", () => {
  it("registering a renderer closes the gap for that kind (a future info type needs ONE call)", () => {
    registerWorkingEntryRenderer({
      kind: "text",
      label: "Narration (registered)",
      render: (entry) => <span data-testid="custom-narration">{entry.content}</span>,
    });
    renderEntry({ type: "text", content: "brand new narration kind", ts: "2026-09-13T10:00:00Z" });
    expect(screen.getByTestId("custom-narration").textContent).toBe("brand new narration kind");
    expect(missingWorkingEntryKinds().sort()).toEqual(["approval", "tool"]);
    expect(workingEntryRegistrationMeta("text")?.label).toBe("Narration (registered)");
  });

  it("re-registration REPLACES the renderer (last wins — surface overrides)", () => {
    registerWorkingEntryRenderer({
      kind: "todo",
      label: "Todo override",
      render: () => <span data-testid="todo-override" />,
    });
    renderEntry({ type: "todo", items: [], ts: "2026-09-13T10:00:00Z" });
    expect(screen.getByTestId("todo-override")).toBeTruthy();
    expect(screen.queryByTestId("todo-card")).toBeNull();
  });

  it("unregister + reset restore the DEFAULT registrations exactly", () => {
    unregisterWorkingEntryRenderer("thinking");
    expect(missingWorkingEntryKinds().sort()).toEqual(["approval", "text", "thinking", "tool"]);
    resetWorkingEntryRenderersForTests();
    expect(registeredWorkingEntryKinds().sort()).toEqual(["question", "screenshot", "thinking", "todo"]);
  });

  it("the FULL render context threads through to the renderer unchanged", () => {
    const seen: Array<WorkingEntryRenderContext | undefined> = [];
    registerWorkingEntryRenderer({
      kind: "tool",
      label: "Tool spy",
      render: (entry, ctx) => {
        seen.push({ ...ctx });
        return <span data-testid="tool-spy">{entry.tool.toolName}</span>;
      },
    });
    const onApprovalDecision = vi.fn();
    const onQuestionAnswer = vi.fn();
    const delegateClaims = new Map<number, string>([[7, "child-a"]]);
    renderEntry(
      { type: "tool", tool: { seq: 7, toolName: "run_command", argsSummary: "ls", ok: true, ts: "2026-09-13T10:00:00Z" } },
      {
        surface: "bare",
        entryIndex: 3,
        liveEntryIndex: 3,
        live: true,
        onApprovalDecision,
        onQuestionAnswer,
        delegateClaims,
      },
    );
    expect(screen.getByTestId("tool-spy").textContent).toBe("run_command");
    expect(seen[0]).toMatchObject({ surface: "bare", entryIndex: 3, liveEntryIndex: 3, live: true });
    expect(seen[0]?.onApprovalDecision).toBe(onApprovalDecision);
    expect(seen[0]?.onQuestionAnswer).toBe(onQuestionAnswer);
    expect(seen[0]?.delegateClaims).toBe(delegateClaims);
  });
});
