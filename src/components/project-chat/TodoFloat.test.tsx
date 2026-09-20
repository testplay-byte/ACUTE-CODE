// @vitest-environment happy-dom
/**
 * ROUND-88 (R88, owner's spec) — the FLOATING TODO WIDGET:
 *  · "it will show at the top-right corner of the chat window, and it will
 *    be a floating view" — the widget renders in the panel's top-right.
 *  · "The user will be shown only the current task at hand" — the collapsed
 *    pill names the in-progress (or next pending) task ONLY.
 *  · "When the user clicks on it, the to-do list will expand" — one click.
 *  · "It will show only the top 10 to-do list entries, and the user will be
 *    able to scroll and see the other ones too" — the rows container caps
 *    at the ten-row height and scrolls (ALL rows render, 12 → 12 rows in a
 *    393px scroll box + the "+N more" hint).
 *  · "manually edit the to-do list … so that the agent can properly and
 *    easily work with them" — the pencil opens the editor (content inputs,
 *    status cycle, delete, add, move); Save POSTs the FULL snapshot through
 *    saveSessionTodo and invalidates the session query (the fold re-reads
 *    the source:"user" event).
 *
 * The api module is mocked (saveSessionTodo overridden, toLatestTodo kept
 * real via importOriginal — the fold's own extractor is part of the
 * contract under test); useSession is mocked at the hooks layer (the widget
 * subscribes with the panel's session id).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { useStreamStore } from "../../lib/stream-store";
import type { StreamSessionState } from "../../lib/stream-store";
import { resetTestState, renderWithProviders } from "../../test-utils";
import { saveSessionTodo, toLatestTodo } from "../../lib/api";
import { TodoFloat, useTodoFloatState } from "./TodoFloat";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, saveSessionTodo: vi.fn() };
});

vi.mock("../../hooks/use-sessions", () => ({
  useSession: vi.fn(),
}));

import { useSession } from "../../hooks/use-sessions";
import type { SessionEvent } from "../../lib/api";

afterEach(cleanup);

/** The session event the fold reads: one todo.update snapshot. */
function todoEvent(seq: number, todos: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>, source?: "user"): SessionEvent {
  return {
    seq,
    type: "todo.update",
    agentId: "agt_default_nova",
    ts: new Date().toISOString(),
    payload: { todos, ...(source !== undefined ? { source } : {}) },
  } as SessionEvent;
}

function sessionState(over: Partial<StreamSessionState> = {}): StreamSessionState {
  return {
    liveTurn: null,
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
          remote: false,
    ...over,
  };
}

function mockSession(events: SessionEvent[]) {
  vi.mocked(useSession).mockReturnValue({
    data: { id: "ses_r88", events },
    isLoading: false,
    isError: false,
  } as never);
}

beforeEach(() => {
  resetTestState();
  useStreamStore.setState({ bySession: {} });
  vi.mocked(saveSessionTodo).mockReset();
  vi.mocked(saveSessionTodo).mockResolvedValue({ ok: true, todos: [] });
});

describe("TodoFloat (ROUND-88) — the collapsed pill", () => {
  it("renders NOTHING when the session has no todo list", () => {
    mockSession([]);
    renderWithProviders(<TodoFloat sessionId="ses_r88" />);
    expect(screen.queryByTestId("todo-float")).toBeNull();
  });

  it("hides after the owner's CLEAR (the empty latest snapshot is a real state)", () => {
    mockSession([todoEvent(1, [{ content: "a", status: "pending" }]), todoEvent(2, [], "user")]);
    renderWithProviders(<TodoFloat sessionId="ses_r88" />);
    expect(screen.queryByTestId("todo-float")).toBeNull();
    // The extractor's own contract: the EMPTY latest wins over the prior one.
    expect(toLatestTodo([todoEvent(1, [{ content: "a", status: "pending" }]), todoEvent(2, [], "user")])?.todos).toEqual([]);
  });

  it("shows ONLY the current task (the in-progress one) + the N/M counter", () => {
    mockSession([
      todoEvent(1, [
        { content: "First task", status: "completed" },
        { content: "The current task at hand", status: "in_progress" },
        { content: "Later task", status: "pending" },
      ]),
    ]);
    renderWithProviders(<TodoFloat sessionId="ses_r88" />);
    const pill = screen.getByTestId("todo-float-pill");
    expect(pill.textContent).toContain("The current task at hand");
    expect(pill.textContent).toContain("1/3");
    // Only the current task — the others are NOT in the collapsed pill.
    expect(pill.textContent).not.toContain("Later task");
    expect(screen.queryByTestId("todo-float-rows")).toBeNull();
  });

  it("falls to the next PENDING task when nothing is in progress", () => {
    mockSession([todoEvent(1, [{ content: "done one", status: "completed" }, { content: "next up", status: "pending" }])]);
    renderWithProviders(<TodoFloat sessionId="ses_r88" />);
    expect(screen.getByTestId("todo-float-pill").textContent).toContain("next up");
  });

  it("reads 'All tasks done' when every task is completed", () => {
    mockSession([todoEvent(1, [{ content: "only", status: "completed" }])]);
    renderWithProviders(<TodoFloat sessionId="ses_r88" />);
    expect(screen.getByTestId("todo-float-pill").textContent).toContain("All tasks done");
  });
});

describe("TodoFloat (ROUND-88) — the expanded list", () => {
  it("one click expands; renders every row inside the TEN-ROW scroll box; +N more hint", () => {
    const todos = Array.from({ length: 12 }, (_, i) => ({
      content: `Task ${i + 1}`,
      status: (i === 3 ? "in_progress" : i < 3 ? "completed" : "pending") as "in_progress" | "completed" | "pending",
    }));
    mockSession([todoEvent(1, todos)]);
    renderWithProviders(<TodoFloat sessionId="ses_r88" />);
    fireEvent.click(screen.getByTestId("todo-float-pill"));

    const rows = screen.getAllByTestId("todo-float-row");
    expect(rows.length).toBe(12); // all rendered…
    const box = screen.getByTestId("todo-float-rows");
    expect(box.style.maxHeight).toBe("393px"); // …but the box caps at ten rows (39px each) and scrolls
    expect(screen.getByText("scroll for 2 more")).toBeTruthy();
  });

  it("badges the owner's manual edits (EDITED BY YOU) on the user-source snapshot", () => {
    mockSession([todoEvent(1, [{ content: "owner's plan", status: "pending" }], "user")]);
    renderWithProviders(<TodoFloat sessionId="ses_r88" />);
    fireEvent.click(screen.getByTestId("todo-float-pill"));
    expect(screen.getByText("EDITED BY YOU")).toBeTruthy();
  });
});

describe("TodoFloat (ROUND-88) — the manual editor", () => {
  it("edits content, cycles status, deletes, adds, reorders — then saves the FULL snapshot", async () => {
    mockSession([
      todoEvent(1, [
        { content: "Original A", status: "pending" },
        { content: "Original B", status: "pending" },
      ]),
    ]);
    renderWithProviders(<TodoFloat sessionId="ses_r88" />);
    fireEvent.click(screen.getByTestId("todo-float-pill"));

    // Open the editor.
    fireEvent.click(screen.getByRole("button", { name: "Edit the to-do list" }));
    expect(screen.getAllByRole("textbox").length).toBe(2);

    // Edit the first row's content.
    const first = screen.getByLabelText("Task 1 content");
    fireEvent.change(first, { target: { value: "Renamed by the owner" } });

    // Cycle the first row's status: pending → in_progress (both rows start
    // pending — target the FIRST cycle button explicitly).
    fireEvent.click(screen.getAllByRole("button", { name: "Cycle status (now pending)" })[0]);

    // Delete the second row.
    fireEvent.click(screen.getByRole("button", { name: "Delete task 2" }));

    // Add a new row + type into it.
    fireEvent.click(screen.getByTestId("todo-float-add-row"));
    const fresh = screen.getByLabelText("Task 2 content");
    fireEvent.change(fresh, { target: { value: "Brand new task" } });

    // Move the new row up (reorder affordance).
    fireEvent.click(screen.getByRole("button", { name: "Move task 2 up" }));

    // Save — the FULL snapshot POSTs through the R88 route.
    fireEvent.click(screen.getByTestId("todo-float-save"));
    await waitFor(() => expect(saveSessionTodo).toHaveBeenCalledTimes(1));
    expect(saveSessionTodo).toHaveBeenCalledWith(
      "ses_r88",
      expect.arrayContaining([
        expect.objectContaining({ content: "Renamed by the owner", status: "in_progress" }),
        expect.objectContaining({ content: "Brand new task", status: "pending" }),
      ]),
    );
    // The delete is honored: only TWO rows in the saved snapshot.
    const savedCall = vi.mocked(saveSessionTodo).mock.calls[0][1];
    expect(savedCall.length).toBe(2);

    // The editor closes back to the list after the save resolves.
    await waitFor(() => expect(screen.queryByTestId("todo-float-edit-rows")).toBeNull());
  });

  it("surfaces the save error honestly and KEEPS the draft", async () => {
    mockSession([todoEvent(1, [{ content: "Keep me", status: "pending" }])]);
    vi.mocked(saveSessionTodo).mockRejectedValueOnce(new Error("route down"));
    renderWithProviders(<TodoFloat sessionId="ses_r88" />);
    fireEvent.click(screen.getByTestId("todo-float-pill"));
    fireEvent.click(screen.getByRole("button", { name: "Edit the to-do list" }));
    fireEvent.click(screen.getByTestId("todo-float-save"));
    await waitFor(() => expect(screen.getByTestId("todo-float-save-error").textContent).toContain("route down"));
    expect(screen.getByTestId("todo-float-edit-rows")).toBeTruthy(); // draft intact
  });
});

describe("useTodoFloatState (ROUND-88) — the live/folded merge", () => {
  it("the LIVE turn's snapshot wins while streaming; the fold takes over after", () => {
    mockSession([
      todoEvent(1, [
        { content: "folded old state", status: "pending" },
        { content: "folded second", status: "pending" },
      ]),
    ]);
    // Prime the live store with a fresher snapshot.
    useStreamStore.setState({
      bySession: {
        ses_r88: sessionState({
          streamBusy: true,
          liveTurn: {
            working: [{ type: "todo", items: [{ content: "LIVE fresh state", status: "in_progress" }], ts: new Date().toISOString() }],
          } as never,
        }),
      },
    });

    let seen: ReturnType<typeof useTodoFloatState> | undefined;
    function Probe() {
      seen = useTodoFloatState("ses_r88");
      return null;
    }
    renderWithProviders(<Probe />);
    expect(seen?.todos).toEqual([{ content: "LIVE fresh state", status: "in_progress" }]);
    expect(seen?.streamBusy).toBe(true);

    // Stream over: the store clears → the fold's latest wins again.
    act(() => {
      useStreamStore.setState({ bySession: { ses_r88: sessionState() } });
    });
    expect(seen?.todos.length).toBe(2);
    expect(seen?.todos[0].content).toBe("folded old state");
  });
});
