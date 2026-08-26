import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { runProjectTerminal } from "../../lib/api";
import { useConfigStore } from "../../lib/config-store";
import { useRightSidebarStore, stateKey, type RightSidebarTab } from "../../lib/right-sidebar-store";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { useScrollFade } from "../../lib/useScrollFade";

/**
 * ROUND-38/39 right-sidebar Terminal tab (owner: "I can see the terminal on
 * the right sidebar"). ROUND-39: each terminal tab has its OWN scrollback
 * (keyed by tab id in right-sidebar-store.terminalLinesByTab). A user-driven
 * command runner: type a command, Enter runs it in the PROJECT ROOT via POST
 * /projects/:id/terminal, output appends to this tab's scrollback. Arrow-up/
 * down recalls history. NOT a full PTY (no cd persistence, no pipes) — that
 * requires a native PTY channel; this is the feasible, honest command-runner
 * that satisfies the "see the terminal" need.
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
    try {
      const res = await runProjectTerminal(projectId, text);
      appendTerminal(projectId, tabId, {
        kind: res.ok ? "out" : "err",
        text: res.output || "(no output)",
      });
      if (res.exitCode !== null && res.exitCode !== 0) {
        appendTerminal(projectId, tabId, { kind: "err", text: `[exit ${res.exitCode}]` });
      }
    } catch (err) {
      appendTerminal(projectId, tabId, {
        kind: "err",
        text: err instanceof Error ? err.message : "command failed",
      });
    } finally {
      setRunning(false);
      inputRef.current?.focus();
    }
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
            <div key={i} className="whitespace-pre-wrap break-words" style={{ color: line.kind === "in" ? styles.accent : line.kind === "err" ? SEMANTIC_COLORS.danger : styles.text }}>
              {line.kind === "in" ? `$ ${line.text}` : line.text}
            </div>
          ))
        )}
        {running ? (
          <div style={{ color: styles.textTertiary }}>
            <span className="ac-ellipsis" aria-hidden />
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
      </div>
    </div>
  );
}
