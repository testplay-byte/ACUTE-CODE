// @vitest-environment happy-dom
/**
 * ROUND-44 (R44-e) — streaming Terminal panel tests. The panel is a VIEW
 * over the streaming terminal surface: live mode runs commands through
 * runProjectTerminalStream (SSE frames append to the tab scrollback as they
 * arrive, exit code renders as a `↳ exit N` footer), the Stop button aborts
 * the in-flight stream, a non-200/unreachable stream endpoint falls back to
 * the sync runProjectTerminal, and demo mode stays on the offline notice.
 *
 * ROUND-45 (R45-b) — Shell mode tests: the mode toggle defaults to Run
 * (existing behavior untouched), switching to Shell creates a persistent
 * session + opens its SSE viewer, output frames render in the monospace
 * area, Enter sends input (with a dim local echo on the pipe engine only),
 * arrow keys walk the shell's own history, Kill destroys the session, and a
 * pre-frame failure renders a visible error state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  createTerminalSession,
  killTerminalSession,
  runProjectTerminal,
  runProjectTerminalStream,
  sendTerminalSessionInput,
  streamTerminalSession,
} from "../../lib/api";
import { useConfigStore } from "../../lib/config-store";
import { useRightSidebarStore, type RightSidebarTab } from "../../lib/right-sidebar-store";
import { renderWithProviders, resetTestState } from "../../test-utils";
import { TerminalPanel } from "./TerminalPanel";

vi.mock("../../lib/api", () => ({
  runProjectTerminal: vi.fn(),
  runProjectTerminalStream: vi.fn(),
  createTerminalSession: vi.fn(),
  listTerminalSessions: vi.fn(async () => []),
  sendTerminalSessionInput: vi.fn(),
  resizeTerminalSession: vi.fn(),
  killTerminalSession: vi.fn(),
  streamTerminalSession: vi.fn(),
}));

afterEach(cleanup);

const tab: RightSidebarTab = {
  id: "tab-term",
  type: "terminal",
  title: "Terminal",
  createdAt: Date.now(),
};

function seedTerminalTab(): void {
  useRightSidebarStore.setState({
    byProject: {
      "prj_test::default": {
        open: true,
        width: 460,
        tabs: [tab],
        activeTabId: tab.id,
        terminalLinesByTab: {},
      },
    },
    activeProjectId: "prj_test",
    activeSessionByProject: {},
  });
}

/** The live scrollback for the tab (lines the panel appended). */
function tabLines() {
  const slice =
    useRightSidebarStore.getState().byProject["prj_test::default"] ?? undefined;
  return slice?.terminalLinesByTab[tab.id] ?? [];
}

beforeEach(() => {
  resetTestState();
  // Live mode: the sidecar is "connected".
  useConfigStore.setState({ demoData: false });
  seedTerminalTab();
  vi.mocked(runProjectTerminalStream).mockReset();
  vi.mocked(runProjectTerminal).mockReset();
  vi.mocked(createTerminalSession).mockReset();
  vi.mocked(sendTerminalSessionInput).mockReset();
  vi.mocked(killTerminalSession).mockReset();
  vi.mocked(streamTerminalSession).mockReset();
  vi.mocked(streamTerminalSession).mockImplementation(async () => {});
});

async function typeAndRun(command: string): Promise<void> {
  fireEvent.change(screen.getByLabelText("Terminal command input"), {
    target: { value: command },
  });
  fireEvent.keyDown(screen.getByLabelText("Terminal command input"), { key: "Enter" });
  await waitFor(() => expect(runProjectTerminalStream).toHaveBeenCalled());
}

describe("TerminalPanel streaming (ROUND-44 R44-e)", () => {
  it("appends stdout/stderr chunks as they arrive and renders the exit-code footer", async () => {
    vi.mocked(runProjectTerminalStream).mockImplementation(
      async (_projectId, _command, onFrame) => {
        onFrame({ type: "stdout", text: "hello" });
        onFrame({ type: "stderr", text: "warned" });
        onFrame({ type: "exit", code: 0, ms: 12 });
      },
    );

    renderWithProviders(<TerminalPanel projectId="prj_test" tab={tab} />);
    await typeAndRun("echo hello");

    await waitFor(() => expect(screen.getByText("hello")).toBeTruthy());
    expect(screen.getByText("warned")).toBeTruthy();
    expect(screen.getByText("↳ exit 0")).toBeTruthy();
    // Input echo line + streamed chunks in order, exit line carries ok:true.
    const lines = tabLines();
    expect(lines[0]).toEqual({ kind: "in", text: "echo hello" });
    expect(lines[1]).toEqual({ kind: "out", text: "hello" });
    expect(lines[2]).toEqual({ kind: "err", text: "warned" });
    expect(lines[3]).toEqual({ kind: "exit", text: "↳ exit 0", ok: true });
    // Sync route untouched on the streaming path.
    expect(runProjectTerminal).not.toHaveBeenCalled();
    // Stream finished — no Stop button, no running indicator.
    expect(screen.queryByRole("button", { name: "Stop command" })).toBeNull();
    expect(document.querySelector("[data-terminal-running]")).toBeNull();
  });

  it("styles a non-zero exit code as failure and renders error frames as err lines", async () => {
    vi.mocked(runProjectTerminalStream).mockImplementation(
      async (_projectId, _command, onFrame) => {
        onFrame({ type: "exit", code: 3, ms: 4 });
      },
    );

    renderWithProviders(<TerminalPanel projectId="prj_test" tab={tab} />);
    await typeAndRun("false");

    await waitFor(() => expect(screen.getByText("↳ exit 3")).toBeTruthy());
    expect(tabLines().at(-1)).toEqual({ kind: "exit", text: "↳ exit 3", ok: false });

    // Error frame (timeout/cap) → the message lands as an err line.
    vi.mocked(runProjectTerminalStream).mockImplementation(
      async (_projectId, _command, onFrame) => {
        onFrame({ type: "error", message: "timed out after 60s" });
      },
    );
    fireEvent.change(screen.getByLabelText("Terminal command input"), {
      target: { value: "sleep 120" },
    });
    fireEvent.keyDown(screen.getByLabelText("Terminal command input"), { key: "Enter" });
    await waitFor(() => expect(screen.getByText("timed out after 60s")).toBeTruthy());
    expect(tabLines().at(-1)).toEqual({ kind: "err", text: "timed out after 60s" });
  });

  it("shows a running indicator + Stop button while streaming; Stop aborts the fetch", async () => {
    const signals: AbortSignal[] = [];
    vi.mocked(runProjectTerminalStream).mockImplementation(
      (_projectId, _command, _onFrame, signal) =>
        new Promise<void>((_resolve, reject) => {
          signals.push(signal as AbortSignal);
          signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    );

    renderWithProviders(<TerminalPanel projectId="prj_test" tab={tab} />);
    await typeAndRun("sleep 60");

    // Running state: spinner row + Stop button.
    expect(document.querySelector("[data-terminal-running]")).not.toBeNull();
    expect(screen.getByText("running…")).toBeTruthy();
    const stop = screen.getByRole("button", { name: "Stop command" });
    expect(screen.getByText("Stop")).toBeTruthy();

    fireEvent.click(stop);
    await waitFor(() => expect(signals[0]?.aborted).toBe(true));
    // The aborted promise rejection lands as a deliberate stop footer.
    await waitFor(() => expect(screen.getByText("↳ stopped")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Stop command" })).toBeNull();
    expect(document.querySelector("[data-terminal-running]")).toBeNull();
    // A deliberate stop never touches the sync fallback.
    expect(runProjectTerminal).not.toHaveBeenCalled();
  });

  it("falls back to the sync terminal route when the stream endpoint fails before any frame", async () => {
    vi.mocked(runProjectTerminalStream).mockRejectedValue(
      new Error("sidecar answered HTTP 404"),
    );
    vi.mocked(runProjectTerminal).mockResolvedValue({
      ok: true,
      output: "sync output",
      exitCode: 0,
    });

    renderWithProviders(<TerminalPanel projectId="prj_test" tab={tab} />);
    await typeAndRun("echo hello");

    await waitFor(() => expect(screen.getByText("sync output")).toBeTruthy());
    expect(runProjectTerminal).toHaveBeenCalledWith("prj_test", "echo hello");
    expect(tabLines()).toEqual([
      { kind: "in", text: "echo hello" },
      { kind: "out", text: "sync output" },
    ]);

    // Non-zero sync exit codes still render the exit footer.
    vi.mocked(runProjectTerminalStream).mockRejectedValue(new Error("stream gone"));
    vi.mocked(runProjectTerminal).mockResolvedValue({
      ok: false,
      output: "boom",
      exitCode: 2,
    });
    fireEvent.change(screen.getByLabelText("Terminal command input"), {
      target: { value: "false" },
    });
    fireEvent.keyDown(screen.getByLabelText("Terminal command input"), { key: "Enter" });
    await waitFor(() => expect(screen.getByText("↳ exit 2")).toBeTruthy());
  });

  it("demo mode stays offline: no stream call, the demo notice appends", async () => {
    useConfigStore.setState({ demoData: true });

    renderWithProviders(<TerminalPanel projectId="prj_test" tab={tab} />);
    fireEvent.change(screen.getByLabelText("Terminal command input"), {
      target: { value: "echo demo" },
    });
    fireEvent.keyDown(screen.getByLabelText("Terminal command input"), { key: "Enter" });

    await waitFor(() =>
      expect(screen.getByText(/Terminal unavailable in demo mode/)).toBeTruthy(),
    );
    expect(runProjectTerminalStream).not.toHaveBeenCalled();
    expect(runProjectTerminal).not.toHaveBeenCalled();
  });

  it("recalls history with the arrow keys (ROUND-39 behavior preserved)", async () => {
    vi.mocked(runProjectTerminalStream).mockImplementation(async () => {});
    renderWithProviders(<TerminalPanel projectId="prj_test" tab={tab} />);

    const input = screen.getByLabelText("Terminal command input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "echo one" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(runProjectTerminalStream).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop command" })).toBeNull());

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("echo one");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.value).toBe("");
  });
});

describe("TerminalPanel Shell mode (ROUND-45 R45-b)", () => {
  /** A connected Shell mode: mocks resolve a pipe session + open stream. */
  async function activateShell(engine: "pty" | "pipe" = "pipe"): Promise<void> {
    vi.mocked(createTerminalSession).mockResolvedValue({
      id: "ts_1",
      projectId: "prj_test",
      engine,
      createdAt: 1,
    });
    renderWithProviders(<TerminalPanel projectId="prj_test" tab={tab} />);
    // Default mode is Run — nothing created yet.
    expect(createTerminalSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "Shell" }));
    await waitFor(() =>
      expect(createTerminalSession).toHaveBeenCalledWith("prj_test"),
    );
    await waitFor(() =>
      expect(streamTerminalSession).toHaveBeenCalledWith(
        "prj_test",
        "ts_1",
        expect.any(Function),
        expect.anything(),
      ),
    );
    // Connected: input enabled, engine badge visible.
    await waitFor(() =>
      expect((screen.getByLabelText("Terminal command input") as HTMLInputElement).disabled).toBe(
        false,
      ),
    );
  }

  it("defaults to Run mode; switching to Shell creates a session + opens the stream", async () => {
    await activateShell("pipe");

    expect(screen.getByText("engine: pipe")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Run" }).getAttribute("aria-selected")).toBe("false");
    expect(screen.getByRole("tab", { name: "Shell" }).getAttribute("aria-selected")).toBe("true");
    // Shell mode renders its own empty-state hint (Run's scrollback is a
    // separate view).
    expect(screen.getByText(/persistent shell/)).toBeTruthy();
  });

  it("renders streamed output frames in the monospace area", async () => {
    vi.mocked(createTerminalSession).mockResolvedValue({
      id: "ts_1",
      projectId: "prj_test",
      engine: "pty",
      createdAt: 1,
    });
    vi.mocked(streamTerminalSession).mockImplementation(
      async (_projectId, _sessionId, onFrame) => {
        onFrame({ type: "output", text: "\u001b[32mhello\u001b[0m from\r\n the shell" });
      },
    );
    renderWithProviders(<TerminalPanel projectId="prj_test" tab={tab} />);
    fireEvent.click(screen.getByRole("tab", { name: "Shell" }));
    await waitFor(() => expect(createTerminalSession).toHaveBeenCalled());

    // ANSI escapes stripped, CR normalized — plain readable text (the
    // testing-library matcher collapses internal whitespace).
    await waitFor(() => expect(screen.getByText("hello from the shell")).toBeTruthy());
    expect(document.body.textContent?.includes("\u001b")).toBe(false);
    expect(document.body.textContent?.includes("\r")).toBe(false);
  });

  it("Enter sends input with a newline; the pipe engine gets a dim local echo", async () => {
    await activateShell("pipe");

    const input = screen.getByLabelText("Terminal command input");
    fireEvent.change(input, { target: { value: "echo hi" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(sendTerminalSessionInput).toHaveBeenCalledWith("prj_test", "ts_1", "echo hi\n"),
    );
    // Pipe engine: the panel echoes the command as a dim $ line.
    expect(screen.getByText("$ echo hi")).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("the pty engine does NOT locally echo the command (the pty echoes itself)", async () => {
    await activateShell("pty");

    const input = screen.getByLabelText("Terminal command input");
    fireEvent.change(input, { target: { value: "echo hi" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(sendTerminalSessionInput).toHaveBeenCalledWith("prj_test", "ts_1", "echo hi\n"),
    );
    expect(screen.queryByText("$ echo hi")).toBeNull();
  });

  it("walks the shell command history with Up/Down (own history, cap-independent of Run)", async () => {
    await activateShell("pipe");

    const input = screen.getByLabelText("Terminal command input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "echo one" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(sendTerminalSessionInput).toHaveBeenCalledTimes(1));
    fireEvent.change(input, { target: { value: "echo two" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(sendTerminalSessionInput).toHaveBeenCalledTimes(2));

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("echo two");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("echo one");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.value).toBe("echo two");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.value).toBe("");
  });

  it("renders the exit frame as a footer and disables the input", async () => {
    vi.mocked(createTerminalSession).mockResolvedValue({
      id: "ts_1",
      projectId: "prj_test",
      engine: "pipe",
      createdAt: 1,
    });
    vi.mocked(streamTerminalSession).mockImplementation(
      async (_projectId, _sessionId, onFrame) => {
        onFrame({ type: "exit", code: 0 });
      },
    );
    renderWithProviders(<TerminalPanel projectId="prj_test" tab={tab} />);
    fireEvent.click(screen.getByRole("tab", { name: "Shell" }));
    await waitFor(() => expect(screen.getByText("↳ shell exited (code 0)")).toBeTruthy());
    expect(
      (screen.getByLabelText("Terminal command input") as HTMLInputElement).disabled,
    ).toBe(true);
  });

  it("Kill destroys the session and clears the output", async () => {
    vi.mocked(createTerminalSession).mockResolvedValue({
      id: "ts_1",
      projectId: "prj_test",
      engine: "pipe",
      createdAt: 1,
    });
    vi.mocked(streamTerminalSession).mockImplementation(
      async (_projectId, _sessionId, onFrame) => {
        onFrame({ type: "output", text: "session output" });
      },
    );
    renderWithProviders(<TerminalPanel projectId="prj_test" tab={tab} />);
    fireEvent.click(screen.getByRole("tab", { name: "Shell" }));
    await waitFor(() => expect(screen.getByText("session output")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Kill shell" }));
    await waitFor(() =>
      expect(killTerminalSession).toHaveBeenCalledWith("prj_test", "ts_1"),
    );
    await waitFor(() => expect(screen.queryByText("session output")).toBeNull());
    // Kill resets to idle: no session badge, Kill disabled until a new shell.
    await waitFor(() => expect(screen.getByText("no session")).toBeTruthy());
    expect(
      (screen.getByRole("button", { name: "Kill shell" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("New shell kills the old session and creates a fresh one", async () => {
    vi.mocked(createTerminalSession)
      .mockResolvedValueOnce({ id: "ts_1", projectId: "prj_test", engine: "pipe", createdAt: 1 })
      .mockResolvedValueOnce({ id: "ts_2", projectId: "prj_test", engine: "pipe", createdAt: 2 });
    renderWithProviders(<TerminalPanel projectId="prj_test" tab={tab} />);
    fireEvent.click(screen.getByRole("tab", { name: "Shell" }));
    await waitFor(() => expect(createTerminalSession).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "New shell" }));
    await waitFor(() => expect(killTerminalSession).toHaveBeenCalledWith("prj_test", "ts_1"));
    await waitFor(() => expect(createTerminalSession).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(streamTerminalSession).toHaveBeenCalledWith(
        "prj_test",
        "ts_2",
        expect.any(Function),
        expect.anything(),
      ),
    );
  });

  it("a pre-frame stream failure renders a visible error state (never a dead spinner)", async () => {
    vi.mocked(createTerminalSession).mockResolvedValue({
      id: "ts_1",
      projectId: "prj_test",
      engine: "pipe",
      createdAt: 1,
    });
    vi.mocked(streamTerminalSession).mockRejectedValue(
      new Error("sidecar answered HTTP 404"),
    );
    renderWithProviders(<TerminalPanel projectId="prj_test" tab={tab} />);
    fireEvent.click(screen.getByRole("tab", { name: "Shell" }));
    await waitFor(() => expect(screen.getByText("sidecar answered HTTP 404")).toBeTruthy());
    // Error state: input disabled until the user recovers (New shell).
    expect(
      (screen.getByLabelText("Terminal command input") as HTMLInputElement).disabled,
    ).toBe(true);
  });

  it("a failed create renders the error and never opens a stream", async () => {
    vi.mocked(createTerminalSession).mockRejectedValue(new Error("failed to start shell"));
    renderWithProviders(<TerminalPanel projectId="prj_test" tab={tab} />);
    fireEvent.click(screen.getByRole("tab", { name: "Shell" }));
    await waitFor(() => expect(screen.getByText("failed to start shell")).toBeTruthy());
    expect(streamTerminalSession).not.toHaveBeenCalled();
    expect(
      (screen.getByLabelText("Terminal command input") as HTMLInputElement).disabled,
    ).toBe(true);
  });

  it("demo mode never creates a shell session", async () => {
    useConfigStore.setState({ demoData: true });
    renderWithProviders(<TerminalPanel projectId="prj_test" tab={tab} />);
    fireEvent.click(screen.getByRole("tab", { name: "Shell" }));
    await waitFor(() => expect(screen.getByText(/Start the sidecar/)).toBeTruthy());
    expect(createTerminalSession).not.toHaveBeenCalled();
    expect(streamTerminalSession).not.toHaveBeenCalled();
  });
});
