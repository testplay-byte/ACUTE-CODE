import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { LoaderCircle, Square } from "lucide-react";
import { runProjectTerminal, runProjectTerminalStream, type TerminalStreamFrame } from "../../lib/api";
import { useConfigStore } from "../../lib/config-store";
import { useRightSidebarStore, stateKey, type RightSidebarTab } from "../../lib/right-sidebar-store";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { useScrollFade } from "../../lib/useScrollFade";

/**
 * ROUND-38/39 right-sidebar Terminal tab (owner: "I can see the terminal on
 * the right sidebar"). ROUND-39: each terminal tab has its OWN scrollback
 * (keyed by tab id in right-sidebar-store.terminalLinesByTab). A user-driven
 * command runner: type a command, Enter runs it in the PROJECT ROOT, output
 * appends to this tab's scrollback. Arrow-up/down recalls history. NOT a
 * full PTY (no cd persistence, no pipes) — that requires a native PTY
 * channel; this is the feasible, honest command-runner that satisfies the
 * "see the terminal" need.
 *
 * ROUND-44 (R44-e, owner directive "complete the agentic coding
 * environment"): live mode now runs on the STREAMING endpoint
 * (POST /projects/:id/terminal/stream, SSE) — stdout/stderr chunks append to
 * the scrollback AS THEY ARRIVE (long commands no longer look frozen), a
 * spinner row shows while running, a Stop button aborts the stream (the
 * sidecar kills the child on disconnect), and the exit frame lands as a
 * compact `↳ exit N` footer (success green / danger red). If the stream
 * endpoint is unavailable (old sidecar, non-200, network failure before any
 * frame) the panel FALLS BACK to the sync POST /projects/:id/terminal so it
 * never regresses. Demo mode is unchanged.
 *
 * Bypasses the agent approvals engine because the HUMAN is the approver for
 * commands they type themselves (the sidecar endpoint enforces the project
 * root + timeout + output cap).
 */
export function TerminalPanel({ projectId, tab }: { projectId: string; tab: RightSidebarTab }) {
  const styles = useThemeStyles();
  // ROUND-41: read the slice via the active session's state key so each
  // session has its own terminal scrollback.
  const activeSessionId = useRightSidebarStore(
    (s) => s.activeSessionByProject[projectId] ?? null,
  );
  const slice = useRightSidebarStore(
    (s) => s.byProject[stateKey(projectId, activeSessionId)],
  );
  const appendTerminal = useRightSidebarStore((s) => s.appendTerminal);
  const clearTerminal = useRightSidebarStore((s) => s.clearTerminal);
  const tabId = tab.id;
  const lines = slice?.terminalLinesByTab[tabId] ?? [];
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const liveMode = useConfigStore((s) => !s.demoData);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // ROUND-44 (R44-e): abort controller for the in-flight stream — the Stop
  // button aborts the fetch; the sidecar sees the socket close and kills the
  // child process (an interactive command has no value once its reader is
  // gone — unlike agent turns, which complete in the background).
  const abortRef = useRef<AbortController | null>(null);
  useScrollFade(scrollRef);

  // Auto-scroll to bottom on new output.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length, running]);

  const run = async (cmd: string) => {
    const text = cmd.trim();
    if (text === "" || running) return;
    setRunning(true);
    setInput("");
    setHistory((h) => [...h, text]);
    setHistoryIdx(-1);
    appendTerminal(projectId, tabId, { kind: "in", text });
    if (!liveMode) {
      appendTerminal(projectId, tabId, { kind: "err", text: "Terminal unavailable in demo mode (start the sidecar)." });
      setRunning(false);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    let sawAnyFrame = false;
    const onFrame = (frame: TerminalStreamFrame) => {
      sawAnyFrame = true;
      if (frame.type === "stdout") {
        appendTerminal(projectId, tabId, { kind: "out", text: frame.text });
      } else if (frame.type === "stderr") {
        appendTerminal(projectId, tabId, { kind: "err", text: frame.text });
      } else if (frame.type === "exit") {
        appendTerminal(projectId, tabId, {
          kind: "exit",
          // null code = killed by a signal (output cap / external kill).
          text: `↳ exit ${frame.code ?? "killed"}`,
          ok: frame.code === 0,
        });
      } else {
        appendTerminal(projectId, tabId, { kind: "err", text: frame.message });
      }
    };
    try {
      await runProjectTerminalStream(projectId, text, onFrame, controller.signal);
    } catch (err) {
      if (controller.signal.aborted) {
        // The user pressed Stop — a deliberate stop, not a failure.
        appendTerminal(projectId, tabId, { kind: "exit", text: "↳ stopped", ok: false });
      } else if (!sawAnyFrame) {
        // FALLBACK (ROUND-44 R44-e): the stream endpoint never produced a
        // frame — old sidecar without the route, non-200, or the fetch died
        // before the first chunk. Re-run through the sync terminal route so
        // the panel keeps working exactly as before the streaming upgrade.
        try {
          const res = await runProjectTerminal(projectId, text);
          appendTerminal(projectId, tabId, {
            kind: res.ok ? "out" : "err",
            text: res.output || "(no output)",
          });
          if (res.exitCode !== null && res.exitCode !== 0) {
            appendTerminal(projectId, tabId, { kind: "exit", text: `↳ exit ${res.exitCode}`, ok: false });
          }
        } catch (fallbackErr) {
          appendTerminal(projectId, tabId, {
            kind: "err",
            text: fallbackErr instanceof Error ? fallbackErr.message : "command failed",
          });
        }
      } else {
        // Frames already streamed, then the transport threw mid-command —
        // show the transport failure (the partial output stays).
        appendTerminal(projectId, tabId, {
          kind: "err",
          text: err instanceof Error ? err.message : "command failed",
        });
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
      inputRef.current?.focus();
    }
  };

  const stop = () => {
    abortRef.current?.abort();
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void run(input);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (history.length === 0) return;
      const next = historyIdx === -1 ? history.length - 1 : Math.max(0, historyIdx - 1);
      setHistoryIdx(next);
      setInput(history[next]);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIdx === -1) return;
      const next = historyIdx + 1;
      if (next >= history.length) {
        setHistoryIdx(-1);
        setInput("");
      } else {
        setHistoryIdx(next);
        setInput(history[next]);
      }
    } else if (e.key === "l" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      clearTerminal(projectId, tabId);
    }
  };

  return (
    <div className="h-full flex flex-col min-h-0">
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto auto-scroll px-3 py-2 font-mono text-[11.5px] leading-[1.55]"
        style={{ background: styles.isDark ? "rgba(0,0,0,0.25)" : styles.bg }}
        onClick={() => inputRef.current?.focus()}
      >
        {lines.length === 0 ? (
          <div style={{ color: styles.textTertiary }}>
            <span style={{ color: styles.accent }}>$</span> type a command (runs in the project root). Ctrl+L clears.
          </div>
        ) : (
          lines.map((line, i) => (
            <div
              key={i}
              data-terminal-line={line.kind}
              // ROUND-44 (VLM pass): commands wrap on narrow panels — give the
              // "$ " prompt lines a hanging indent so wrapped continuation
              // text aligns under the command instead of under the prompt.
              className="whitespace-pre-wrap break-words"
              style={{
                color:
                  line.kind === "in"
                    ? styles.accent
                    : line.kind === "err"
                      ? SEMANTIC_COLORS.danger
                      : line.kind === "exit"
                        ? line.ok
                          ? SEMANTIC_COLORS.success
                          : SEMANTIC_COLORS.danger
                        : styles.text,
                ...(line.kind === "in" ? { paddingLeft: "0.9em", textIndent: "-0.9em" } : {}),
              }}
            >
              {line.kind === "in" ? `$ ${line.text}` : line.text}
            </div>
          ))
        )}
        {running ? (
          <div className="flex items-center gap-1.5" style={{ color: styles.textTertiary }} data-terminal-running="true">
            <LoaderCircle size={11} className="animate-spin" style={{ color: styles.accent }} />
            <span>running…</span>
          </div>
        ) : null}
      </div>
      <div className="shrink-0 flex items-center gap-2 px-2 py-1.5 border-t" style={{ borderColor: styles.border }}>
        <span className="font-mono text-[12px] shrink-0" style={{ color: styles.accent }}>$</span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          autoFocus
          spellCheck={false}
          autoComplete="off"
          aria-label="Terminal command input"
          placeholder="run a command…"
          className="flex-1 min-w-0 bg-transparent outline-none font-mono text-[12px]"
          style={{ color: styles.text }}
        />
        {running ? (
          <button
            type="button"
            onClick={stop}
            aria-label="Stop command"
            title="Stop the running command"
            className="shrink-0 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium border transition-colors"
            style={{ color: SEMANTIC_COLORS.danger, borderColor: styles.border }}
          >
            <Square size={10} fill="currentColor" strokeWidth={0} aria-hidden />
            Stop
          </button>
        ) : null}
      </div>
    </div>
  );
}
