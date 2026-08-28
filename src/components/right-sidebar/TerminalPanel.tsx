import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { LoaderCircle, Square, Trash2, RefreshCw } from "lucide-react";
import {
  createTerminalSession,
  killTerminalSession,
  runProjectTerminal,
  runProjectTerminalStream,
  sendTerminalSessionInput,
  streamTerminalSession,
  type TerminalSessionDescriptor,
  type TerminalSessionFrame,
  type TerminalStreamFrame,
} from "../../lib/api";
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
 * appends to this tab's scrollback. Arrow-up/down recalls history.
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
 * ROUND-45 (R45-b): MODE TOGGLE — "Run" (the one-shot behavior above,
 * unchanged) | "Shell" (PERSISTENT interactive session). Shell mode creates
 * a terminal session (POST /projects/:id/terminal-sessions), opens its SSE
 * stream and renders output in the same monospace area. The session
 * SURVIVES tab switches and stream disconnects (state is the SHELL's, kept
 * server-side; the ring-buffer backlog replays the transcript on every
 * (re)connect). Enter sends input (+newline); Up/Down walk the shell's own
 * command history (cap 100). The engine badge in the footer shows "pty"
 * (real pty — it echoes input itself) or "pipe" (no echo — the panel
 * prepends a dim `$ command` line so the transcript stays readable). Kill
 * destroys the session + clears the output; New shell kills + recreates. A
 * pre-frame stream/create failure renders a visible error state (ROUND-43
 * silent-death lesson — never a dead spinner).
 *
 * Both modes bypass the agent approvals engine because the HUMAN is the
 * approver for commands they type themselves (the sidecar enforces the
 * project root, env allowlist, caps and idle reaping).
 */

/** One line of SHELL-mode output (local panel state — deliberately NOT the
 * right-sidebar store: the session's transcript lives server-side; only the
 * rendered projection is local). */
interface ShellLine {
  kind: "cmd" | "out" | "err" | "exit";
  text: string;
  ok?: boolean;
}

type TerminalMode = "run" | "shell";
type ShellStatus = "idle" | "connecting" | "live" | "dead" | "error";

/** Rendered scrollback cap (~200 KB) — trim the HEAD when exceeded. */
const SHELL_RENDER_CAP_BYTES = 200 * 1024;
/** Local command history cap for Shell mode. */
const SHELL_HISTORY_CAP = 100;

/**
 * Strip ANSI escape sequences (CSI + the common single-char escapes) and
 * normalize CR — a real pty emits colors/cursor codes that would otherwise
 * render as raw `ESC[32m` garbage in the plain-text output area. Run mode
 * never needs this (FORCE_COLOR=0/CI=1), so it is applied to shell output
 * only.
 */
const ANSI_ESCAPE_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
function cleanShellText(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "").replace(/\r/g, "");
}

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

  // ── ROUND-45 (R45-b): Shell mode state (local, per panel) ──────────────
  const [mode, setMode] = useState<TerminalMode>("run");
  const [shellSession, setShellSession] = useState<TerminalSessionDescriptor | null>(null);
  const [shellStatus, setShellStatus] = useState<ShellStatus>("idle");
  const [shellLines, setShellLines] = useState<ShellLine[]>([]);
  const [shellHistory, setShellHistory] = useState<string[]>([]);
  const [shellHistoryIdx, setShellHistoryIdx] = useState(-1);
  // Latest values for stable effect/handler closures.
  const shellStatusRef = useRef<ShellStatus>(shellStatus);
  shellStatusRef.current = shellStatus;
  const shellSessionRef = useRef<TerminalSessionDescriptor | null>(shellSession);
  shellSessionRef.current = shellSession;
  const streamAbortRef = useRef<AbortController | null>(null);
  // Bumped by kill/new: invalidates any in-flight create (see startShell).
  const shellGenerationRef = useRef(0);

  /** Append one shell line, trimming the rendered head past the byte cap. */
  const appendShellLine = (line: ShellLine) => {
    setShellLines((prev) => {
      const merged = [...prev, line];
      let bytes = 0;
      for (const l of merged) bytes += l.text.length;
      const out = [...merged];
      let kept = bytes;
      while (out.length > 1 && kept > SHELL_RENDER_CAP_BYTES) {
        kept -= out[0].text.length;
        out.shift();
      }
      return out;
    });
  };
  const appendShellOutput = (text: string) => {
    const cleaned = cleanShellText(text);
    if (cleaned !== "") appendShellLine({ kind: "out", text: cleaned });
  };
  const resetShellLocal = () => {
    setShellLines([]);
    setShellHistory([]);
    setShellHistoryIdx(-1);
  };

  /** Create a session + attach the viewer. No-op in demo mode. Guarded by
   * a GENERATION counter (not a status ref): refs only refresh on render,
   * and the create promise can resolve before React re-renders — the counter
   * bumps synchronously in kill/new so an invalidated create is discarded
   * deterministically. */
  const startShell = async () => {
    if (!liveMode) return;
    const generation = shellGenerationRef.current;
    setShellStatus("connecting");
    try {
      const session = await createTerminalSession(projectId);
      if (shellGenerationRef.current !== generation) {
        // The user hit Kill/New while we were creating — don't leak the
        // fresh session; destroy it immediately.
        try {
          await killTerminalSession(projectId, session.id);
        } catch {
          /* best-effort */
        }
        return;
      }
      setShellSession(session);
      setShellStatus("live");
    } catch (err) {
      // Visible error state — never a dead "connecting…" spinner (ROUND-43).
      setShellStatus("error");
      setShellSession(null);
      setShellLines([]);
      appendShellLine({
        kind: "err",
        text: err instanceof Error ? err.message : "failed to start shell session",
      });
    }
  };

  /** Activate Shell mode: create on first use; a LIVE session just
   * re-attaches (the stream effect below replays the backlog). */
  const activateShell = () => {
    if (!liveMode) return;
    if (shellStatusRef.current === "idle" || shellStatusRef.current === "error") {
      void startShell();
    }
    // "live"/"dead": keep the existing session — the effect re-opens the
    // viewer for live sessions; a dead one shows its exit footer + New shell.
  };

  // The SSE viewer: (re)opens whenever Shell mode is active with a LIVE
  // session. Each open CLEARS the local transcript first — the first output
  // frame carries the full server-side backlog, so re-attaching never
  // duplicates lines. Aborting only detaches the viewer; the session itself
  // survives server-side (idle reaping cleans up abandoned ones).
  useEffect(() => {
    if (mode !== "shell" || shellSession === null || shellStatus === "dead") return;
    const controller = new AbortController();
    streamAbortRef.current = controller;
    let disposed = false;
    setShellLines([]);
    streamTerminalSession(projectId, shellSession.id, (frame: TerminalSessionFrame) => {
      if (disposed) return;
      if (frame.type === "output") {
        appendShellOutput(frame.text);
      } else if (frame.type === "exit") {
        appendShellLine({
          kind: "exit",
          text: `↳ shell exited${frame.code === null ? "" : ` (code ${frame.code})`}`,
          ok: frame.code === 0,
        });
        setShellStatus("dead");
      } else {
        appendShellLine({ kind: "err", text: frame.message });
        setShellStatus("error");
      }
    }, controller.signal).catch((err: unknown) => {
      if (disposed || controller.signal.aborted) return; // deliberate detach
      setShellStatus("error");
      appendShellLine({
        kind: "err",
        text: err instanceof Error ? err.message : "shell stream failed",
      });
    });
    return () => {
      disposed = true;
      controller.abort();
      if (streamAbortRef.current === controller) streamAbortRef.current = null;
    };
  }, [mode, shellSession, projectId]);

  /** Kill the shell (if alive) + clear local output. A 404 just means it
   * already died — treat as success. */
  const killShell = async () => {
    shellGenerationRef.current++;
    streamAbortRef.current?.abort();
    const session = shellSessionRef.current;
    if (session !== null && shellStatusRef.current !== "dead") {
      try {
        await killTerminalSession(projectId, session.id);
      } catch {
        /* already gone server-side (exited/reaped) — same end state */
      }
    }
    setShellSession(null);
    setShellStatus("idle");
    resetShellLocal();
    inputRef.current?.focus();
  };

  /** New shell = kill + start a fresh one. */
  const newShell = async () => {
    shellGenerationRef.current++;
    const session = shellSessionRef.current;
    if (session !== null && shellStatusRef.current !== "dead") {
      try {
        await killTerminalSession(projectId, session.id);
      } catch {
        /* already gone */
      }
    }
    streamAbortRef.current?.abort();
    setShellSession(null);
    setShellStatus("idle");
    await startShell();
    inputRef.current?.focus();
  };

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

  /** Shell mode: send the line + newline. On the pipe engine (no echo of
   * its own) prepend a dim `$ command` line so the transcript reads. */
  const runShellInput = async (raw: string) => {
    const text = raw.trim();
    const session = shellSessionRef.current;
    if (text === "" || session === null || shellStatusRef.current !== "live") return;
    setInput("");
    setShellHistory((h) => [...h, text].slice(-SHELL_HISTORY_CAP));
    setShellHistoryIdx(-1);
    if (session.engine === "pipe") {
      appendShellLine({ kind: "cmd", text });
    }
    try {
      await sendTerminalSessionInput(projectId, session.id, text + "\n");
    } catch (err) {
      appendShellLine({
        kind: "err",
        text: err instanceof Error ? err.message : "failed to send input",
      });
    }
  };

  const stop = () => {
    abortRef.current?.abort();
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const activeHistory = mode === "shell" ? shellHistory : history;
    if (e.key === "Enter") {
      e.preventDefault();
      if (mode === "shell") void runShellInput(input);
      else void run(input);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (activeHistory.length === 0) return;
      const idx = mode === "shell" ? shellHistoryIdx : historyIdx;
      const next = idx === -1 ? activeHistory.length - 1 : Math.max(0, idx - 1);
      if (mode === "shell") {
        setShellHistoryIdx(next);
      } else {
        setHistoryIdx(next);
      }
      setInput(activeHistory[next]);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const idx = mode === "shell" ? shellHistoryIdx : historyIdx;
      if (idx === -1) return;
      const next = idx + 1;
      if (next >= activeHistory.length) {
        if (mode === "shell") {
          setShellHistoryIdx(-1);
        } else {
          setHistoryIdx(-1);
        }
        setInput("");
      } else {
        if (mode === "shell") {
          setShellHistoryIdx(next);
        } else {
          setHistoryIdx(next);
        }
        setInput(activeHistory[next]);
      }
    } else if (e.key === "l" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (mode === "shell") setShellLines([]);
      else clearTerminal(projectId, tabId);
    }
  };

  // Auto-scroll to bottom on new output.
  const renderedLineCount = mode === "shell" ? shellLines.length : lines.length;
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [renderedLineCount, running, shellStatus]);

  const shellInputEnabled = mode === "shell" && shellStatus === "live";

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* ROUND-45 (R45-b): mode toggle — Run (one-shot, unchanged) vs Shell
          (persistent interactive session). */}
      <div
        className="shrink-0 flex items-center gap-1.5 px-2 py-1 border-b"
        style={{ borderColor: styles.border }}
      >
        <div
          role="tablist"
          aria-label="Terminal mode"
          className="flex items-center rounded-md border overflow-hidden"
          style={{ borderColor: styles.border }}
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === "run"}
            onClick={() => setMode("run")}
            className="px-2 py-0.5 text-[10.5px] font-medium transition-colors"
            style={{
              background: mode === "run" ? styles.accent : "transparent",
              color: mode === "run" ? "#fff" : styles.textTertiary,
            }}
          >
            Run
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "shell"}
            onClick={() => {
              setMode("shell");
              activateShell();
            }}
            className="px-2 py-0.5 text-[10.5px] font-medium transition-colors"
            style={{
              background: mode === "shell" ? styles.accent : "transparent",
              color: mode === "shell" ? "#fff" : styles.textTertiary,
            }}
          >
            Shell
          </button>
        </div>
        {mode === "shell" ? (
          <span
            className="ml-auto font-mono text-[10px] px-1.5 py-0.5 rounded border"
            style={{ color: styles.textTertiary, borderColor: styles.border }}
            data-terminal-engine={shellSession?.engine ?? "none"}
          >
            {shellSession ? `engine: ${shellSession.engine}` : "no session"}
          </span>
        ) : null}
      </div>
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto auto-scroll px-3 py-2 font-mono text-[11.5px] leading-[1.55]"
        style={{ background: styles.isDark ? "rgba(0,0,0,0.25)" : styles.bg }}
        onClick={() => inputRef.current?.focus()}
      >
        {mode === "run" ? (
          lines.length === 0 ? (
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
          )
        ) : shellLines.length === 0 && shellStatus !== "connecting" ? (
          <div style={{ color: styles.textTertiary }}>
            <span style={{ color: styles.accent }}>$</span> persistent shell — state survives across commands (cd, env, venv).{" "}
            {liveMode ? "Enter starts… Ctrl+L clears." : "Start the sidecar to use it."}
          </div>
        ) : (
          shellLines.map((line, i) => (
            <div
              key={i}
              data-terminal-line={line.kind === "cmd" ? "in" : line.kind}
              className="whitespace-pre-wrap break-words"
              style={{
                color:
                  line.kind === "cmd"
                    ? styles.textTertiary
                    : line.kind === "err"
                      ? SEMANTIC_COLORS.danger
                      : line.kind === "exit"
                        ? line.ok
                          ? SEMANTIC_COLORS.success
                          : SEMANTIC_COLORS.danger
                        : styles.text,
                ...(line.kind === "cmd" ? { paddingLeft: "0.9em", textIndent: "-0.9em" } : {}),
              }}
            >
              {line.kind === "cmd" ? `$ ${line.text}` : line.text}
            </div>
          ))
        )}
        {mode === "run" && running ? (
          <div className="flex items-center gap-1.5" style={{ color: styles.textTertiary }} data-terminal-running="true">
            <LoaderCircle size={11} className="animate-spin" style={{ color: styles.accent }} />
            <span>running…</span>
          </div>
        ) : null}
        {mode === "shell" && shellStatus === "connecting" ? (
          <div className="flex items-center gap-1.5" style={{ color: styles.textTertiary }} data-terminal-connecting="true">
            <LoaderCircle size={11} className="animate-spin" style={{ color: styles.accent }} />
            <span>starting shell…</span>
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
          placeholder={mode === "shell" ? "type a command in the persistent shell…" : "run a command…"}
          disabled={mode === "shell" && !shellInputEnabled}
          className="flex-1 min-w-0 bg-transparent outline-none font-mono text-[12px] disabled:opacity-50"
          style={{ color: styles.text }}
        />
        {mode === "run" && running ? (
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
        {mode === "shell" ? (
          <>
            <button
              type="button"
              onClick={() => void killShell()}
              aria-label="Kill shell"
              title="Kill the shell session and clear the output"
              disabled={shellSession === null && shellLines.length === 0}
              className="shrink-0 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium border transition-colors disabled:opacity-40"
              style={{ color: SEMANTIC_COLORS.danger, borderColor: styles.border }}
            >
              <Trash2 size={10} aria-hidden />
              Kill
            </button>
            <button
              type="button"
              onClick={() => void newShell()}
              aria-label="New shell"
              title="Kill this shell and start a fresh one"
              className="shrink-0 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium border transition-colors"
              style={{ color: styles.textSecondary, borderColor: styles.border }}
            >
              <RefreshCw size={10} aria-hidden />
              New
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
