// @vitest-environment happy-dom
/**
 * ROUND-44 (R44-e) — streaming Terminal panel tests. The panel is a VIEW
 * over the streaming terminal surface: live mode runs commands through
 * runProjectTerminalStream (SSE frames append to the tab scrollback as they
 * arrive, exit code renders as a `↳ exit N` footer), the Stop button aborts
 * the in-flight stream, a non-200/unreachable stream endpoint falls back to
 * the sync runProjectTerminal, and demo mode stays on the offline notice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { runProjectTerminal, runProjectTerminalStream } from "../../lib/api";
import { useConfigStore } from "../../lib/config-store";
import { useRightSidebarStore, type RightSidebarTab } from "../../lib/right-sidebar-store";
import { renderWithProviders, resetTestState } from "../../test-utils";
import { TerminalPanel } from "./TerminalPanel";

vi.mock("../../lib/api", () => ({
  runProjectTerminal: vi.fn(),
  runProjectTerminalStream: vi.fn(),
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
