import {
  forwardRef,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { AnimatePresence, motion, type Variants } from "framer-motion";
import {
  ArrowUp,
  Edit3,
  FileCode2,
  Paperclip,
  Search,
  Sparkles,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import { Link } from "react-router";
import { useAgents } from "../../hooks/use-agents";
import {
  useCreateSession,
  useSendMessage,
  useSession,
  useSessions,
} from "../../hooks/use-sessions";
import {
  type Agent,
  type DiffEntry,
  type Project,
  type ProjectChatItem,
  type ToolUseEntry,
  toProjectChatItems,
} from "../../lib/api";
import { withAlpha } from "../dashboard/helpers";
import { ease } from "../../lib/motion";
import { useProjectChatStore } from "../../lib/project-chat-store";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { useScrollFade } from "../../lib/useScrollFade";

/**
 * Live-data port of the demo AgentChatPanel: the session event log folded by
 * toProjectChatItems() renders as user bubbles, grouped tool pills, diff cards
 * and RichText assistant bubbles, with optimistic send (create-session on first
 * turn) and the ChatView error/retry banner. Demo-only pieces (thought blocks,
 * suggestion banner, MODEL_OPTIONS picker) have no backend source and are not
 * ported.
 */

const msgVariants: Variants = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.35, ease } },
  exit: { opacity: 0, y: -8, transition: { duration: 0.2, ease } },
};

/** Backend tool names (M2) → demo action-pill icons; unknown tools get Terminal. */
const TOOL_ICONS: Record<string, LucideIcon> = {
  list_dir: Search,
  read_file: FileCode2,
  write_file: Edit3,
  edit_file: Edit3,
  web_search: Search,
};

const basename = (p: string): string => p.split("/").pop() ?? p;

const itemKey = (item: ProjectChatItem): string => {
  switch (item.kind) {
    case "user":
      return `u-${item.seq}`;
    case "ai":
      return `a-${item.seq}`;
    case "tools":
      return `t-${item.seqStart}-${item.seqEnd}`;
    case "diff":
      return `d-${item.entry.seq}`;
  }
};

function UserMessage({ content }: { content: string }) {
  const styles = useThemeStyles();
  return (
    <motion.div
      className="flex justify-end"
      variants={msgVariants}
      initial="initial"
      animate="animate"
    >
      <div
        className="max-w-[85%] rounded-2xl rounded-br-md px-3.5 py-2.5 text-[13px] leading-[1.5]"
        style={{ background: styles.accent, color: styles.accentText }}
      >
        {content}
      </div>
    </motion.div>
  );
}

/** Demo inline-markup parser, verbatim: **bold** and `code` per line. */
function RichText({ content }: { content: string }) {
  const styles = useThemeStyles();
  const lines = content.split("\n");
  const elements: ReactNode[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const parts = line.split(/\*\*(.*?)\*\*/g);
    const lineEl: ReactNode[] = [];

    for (let j = 0; j < parts.length; j++) {
      const part = parts[j];
      if (j % 2 === 1) {
        lineEl.push(
          <strong key={`b-${i}-${j}`} style={{ fontWeight: 600 }}>
            {part}
          </strong>,
        );
        continue;
      }
      const codeParts = part.split(/`(.*?)`/g);
      for (let k = 0; k < codeParts.length; k++) {
        const cp = codeParts[k];
        if (k % 2 === 1) {
          lineEl.push(
            <code
              key={`c-${i}-${j}-${k}`}
              className="px-1.5 py-0.5 rounded-md text-[11.5px] font-mono"
              style={{
                background: withAlpha(styles.accent, styles.isDark ? 0.13 : 0.08),
                color: styles.text,
              }}
            >
              {cp}
            </code>,
          );
        } else if (cp) {
          lineEl.push(<span key={`s-${i}-${j}-${k}`}>{cp}</span>);
        }
      }
    }

    if (i > 0) {
      elements.push(<div key={`br-${i}`} className="mt-1.5" />);
    }
    elements.push(<span key={`l-${i}`}>{lineEl}</span>);
  }

  return <>{elements}</>;
}

function AiMessage({ content }: { content: string }) {
  const styles = useThemeStyles();
  return (
    <motion.div variants={msgVariants} initial="initial" animate="animate">
      <div
        className="rounded-2xl px-3.5 py-3 text-[13px] leading-[1.6] border"
        style={{ background: styles.card, borderColor: styles.border, color: styles.text }}
      >
        <RichText content={content} />
      </div>
    </motion.div>
  );
}

/** One row of action pills — one pill per executed tool call in the run. */
function ToolsRow({ tools }: { tools: ToolUseEntry[] }) {
  const styles = useThemeStyles();
  return (
    <motion.div
      className="flex flex-wrap gap-1.5"
      variants={msgVariants}
      initial="initial"
      animate="animate"
    >
      {tools.map((tool) => {
        const Icon = TOOL_ICONS[tool.toolName] ?? Terminal;
        const full = `${tool.toolName} ${tool.argsSummary}`.trim();
        const label = full.length > 48 ? `${full.slice(0, 48)}…` : full;
        return (
          <div
            key={tool.seq}
            title={full}
            className="inline-flex items-center gap-1.5 h-7 px-3 rounded-full border font-mono text-[11px] max-w-full"
            style={{
              background: styles.isDark ? styles.bg : styles.card,
              borderColor: styles.border,
              color: styles.textSecondary,
            }}
          >
            <Icon size={11} className="shrink-0" />
            <span className="truncate">{label}</span>
            <span
              className="opacity-50 shrink-0"
              style={{ color: tool.ok ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.danger }}
            >
              {tool.ok ? "✓" : "✗"}
            </span>
          </div>
        );
      })}
    </motion.div>
  );
}

/**
 * Diff card for a write_file/edit_file call. Clicking a diff with a parsed
 * path reveals the code pane at that file. Real +/- diff bodies land with git
 * integration in Phase 3 — until then the card shows path + size + status.
 */
function DiffCard({ entry }: { entry: DiffEntry }) {
  const styles = useThemeStyles();
  const selectFile = useProjectChatStore((s) => s.selectFile);
  const setCodeVisible = useProjectChatStore((s) => s.setCodeVisible);

  return (
    <motion.div variants={msgVariants} initial="initial" animate="animate">
      <button
        type="button"
        onClick={() => {
          if (entry.path) {
            selectFile(entry.path);
            setCodeVisible(true);
          }
        }}
        className="block w-full text-left rounded-2xl border overflow-hidden"
        style={{ background: styles.bg, borderColor: styles.border }}
      >
        <div
          className="h-8 px-3 border-b flex items-center justify-between font-mono text-[11px]"
          style={{ borderColor: styles.border, color: styles.textSecondary }}
        >
          <span className="truncate">
            {entry.path ? basename(entry.path) : entry.toolName}{" "}
            {`+${entry.chars ?? "?"} chars`}
          </span>
          <span className="flex items-center gap-1.5 shrink-0">
            <span
              className="w-2 h-2 rounded-full"
              style={{ background: entry.ok ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.danger }}
            />
            <span className="text-[10px]">{entry.ok ? "applied" : "failed"}</span>
          </span>
        </div>
        <div
          className="px-3 py-2 font-mono text-[11px] truncate"
          style={{ color: styles.textSecondary }}
        >
          {entry.path ?? entry.toolName}
        </div>
      </button>
    </motion.div>
  );
}

/** Direct child of AnimatePresence mode="popLayout": framer-motion attaches a
 * measurement ref to this element (React 18 requires forwardRef — the demo
 * could skip it on React 19). The wrapper div is the presence child. */
const MessageRenderer = forwardRef<HTMLDivElement, { item: ProjectChatItem }>(
  function MessageRenderer({ item }, ref) {
    switch (item.kind) {
      case "user":
        return (
          <div ref={ref}>
            <UserMessage content={item.content} />
          </div>
        );
      case "ai":
        return (
          <div ref={ref}>
            <AiMessage content={item.content} />
          </div>
        );
      case "tools":
        return (
          <div ref={ref}>
            <ToolsRow tools={item.tools} />
          </div>
        );
      case "diff":
        return (
          <div ref={ref}>
            <DiffCard entry={item.entry} />
          </div>
        );
    }
  },
);

/** Demo AgentThinking row: avatar chip, name/model, "Working…" + bounceDot dots. */
function AgentThinking({ agent }: { agent: Agent | null }) {
  const styles = useThemeStyles();
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className="flex items-center gap-3 px-1"
    >
      <div
        className="w-7 h-7 rounded-xl grid place-items-center border shrink-0"
        style={{ borderColor: styles.border, background: styles.inputBg }}
      >
        <Sparkles size={13} style={{ color: styles.accent }} />
      </div>
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-[13px] font-semibold" style={{ color: styles.text }}>
          {agent?.name ?? "Agent"}
        </span>
        <span
          className="text-[10px] px-1.5 py-0.5 rounded-lg border font-mono"
          style={{ background: styles.inputBg, borderColor: styles.border, color: styles.textSecondary }}
        >
          {agent?.model ?? "no model"}
        </span>
      </div>
      <div
        className="flex items-center gap-1.5 text-[11px] font-mono ml-auto"
        style={{ color: styles.textSecondary }}
      >
        <span>Working…</span>
        <span className="flex gap-0.5">
          {[0, 0.15, 0.3].map((delay, i) => (
            <span
              key={i}
              className="w-1 h-1 rounded-full"
              style={{
                background: styles.textSecondary,
                animation: `bounceDot 1s infinite ${delay}s`,
              }}
            />
          ))}
        </span>
      </div>
    </motion.div>
  );
}

export function AgentChatPanel({ projectId, project }: { projectId: string; project: Project }) {
  const styles = useThemeStyles();

  // Latest session bound to this project (list has no server-side project
  // filter — client-side, per API.md §5).
  const sessions = useSessions().data ?? [];
  const session = useMemo(
    () =>
      sessions
        .filter((s) => s.projectId === projectId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null,
    [sessions, projectId],
  );
  const sessionDetail = useSession(session?.id ?? null);

  // Agent: first non-template agent by default; a picker lands with the
  // session-header menu.
  const agents = useAgents(false).data ?? [];
  const [agentId] = useState<string | null>(null);
  const agent = agents.find((a) => a.id === agentId) ?? agents[0] ?? null;

  const createSession = useCreateSession();
  const sendMessage = useSendMessage();

  const items = useMemo(
    () => (sessionDetail.data ? toProjectChatItems(sessionDetail.data.events) : []),
    [sessionDetail.data],
  );

  const [input, setInput] = useState("");
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [lastSent, setLastSent] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  const busy = createSession.isPending || sendMessage.isPending || pendingUser !== null;

  // Optimistic echo lives only until the refetched log contains it (ChatView pattern).
  const pendingEcho =
    pendingUser !== null && !items.some((it) => it.kind === "user" && it.content === pendingUser)
      ? pendingUser
      : null;

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useScrollFade(scrollRef);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [items.length, busy, pendingUser]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const runTurn = async (content: string) => {
    const text = content.trim();
    if (!text || busy || !agent) return;
    setInput("");
    setLastSent(text);
    setPendingUser(text);
    setSendError(null);
    try {
      let sid = session?.id;
      if (!sid) {
        const created = await createSession.mutateAsync({
          mode: "single" as const,
          agentId: agent.id,
          projectId,
          title: project.name,
        });
        sid = created.id;
      }
      await sendMessage.mutateAsync({ sessionId: sid, content: text });
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    } finally {
      // Both hooks invalidate their queries on settle; drop the optimistic echo.
      setPendingUser(null);
    }
  };

  const onInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void runTurn(input);
    }
  };

  const noop = (_e: ReactMouseEvent<HTMLButtonElement>) => undefined;

  return (
    <div
      className="flex flex-col h-full min-w-0 rounded-2xl border overflow-hidden"
      style={{ backgroundColor: styles.card, borderColor: styles.border }}
    >
      {/* Panel header: accent chip · agent name · model chip · status chip */}
      <div
        className="shrink-0 h-11 px-3 border-b flex items-center gap-2"
        style={{ borderColor: styles.border }}
      >
        <div
          className="w-6 h-6 rounded-lg grid place-items-center shrink-0"
          style={{ backgroundColor: withAlpha(styles.accent, 0.13), color: styles.accent }}
        >
          <Sparkles size={12} />
        </div>
        <span className="text-[13px] font-semibold truncate" style={{ color: styles.text }}>
          {agent?.name ?? "No agent"}
        </span>
        <span
          className="text-[10px] px-1.5 py-0.5 rounded-lg border font-mono shrink-0"
          style={{
            backgroundColor: styles.inputBg,
            borderColor: styles.inputBorder,
            color: styles.textTertiary,
          }}
        >
          {agent?.model ?? "no model"}
        </span>
        <span
          className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full shrink-0"
          style={
            busy
              ? {
                  color: SEMANTIC_COLORS.success,
                  backgroundColor: withAlpha(SEMANTIC_COLORS.success, 0.08),
                }
              : { color: styles.textTertiary, backgroundColor: styles.subtle }
          }
        >
          {busy ? "running" : "idle"}
        </span>
      </div>

      {/* Scroll body with top fade (demo structure) */}
      <div className="relative flex-1 min-h-0 overflow-hidden">
        <div
          className="absolute top-0 left-0 right-0 h-8 z-10 pointer-events-none"
          style={{ background: `linear-gradient(to bottom, ${styles.card}, transparent)` }}
        />
        <div ref={scrollRef} className="absolute inset-0 overflow-y-auto auto-scroll">
          <div className="px-3 py-4 flex flex-col gap-3">
            {items.length === 0 && !pendingEcho ? (
              <div className="flex items-center gap-3">
                <div
                  className="w-9 h-9 rounded-xl grid place-items-center border shrink-0"
                  style={{ borderColor: styles.border, backgroundColor: styles.inputBg }}
                >
                  <Sparkles size={16} style={{ color: styles.accent }} />
                </div>
                <div className="min-w-0">
                  <div className="text-[14px] font-semibold" style={{ color: styles.text }}>
                    {agent?.name ?? "Acute Agent"}
                  </div>
                  <div className="text-[11px] font-mono" style={{ color: styles.textSecondary }}>
                    {`Acute Agent · ${agent?.model ?? "no model"}`}
                  </div>
                  {agents.length === 0 ? (
                    <div className="text-[12px] mt-1.5" style={{ color: styles.textSecondary }}>
                      Create an agent in{" "}
                      <Link to="/settings" style={{ color: styles.accent }}>
                        Settings
                      </Link>{" "}
                      first
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            <AnimatePresence mode="popLayout">
              {items.map((item) => (
                <MessageRenderer key={itemKey(item)} item={item} />
              ))}
              {pendingEcho !== null ? <UserMessage content={pendingEcho} /> : null}
            </AnimatePresence>

            <AnimatePresence>
              {busy ? <AgentThinking agent={agent} /> : null}
            </AnimatePresence>
          </div>
        </div>
      </div>

      {/* Error banner (ChatView pattern): keeps the failed text for Retry. */}
      {sendError && lastSent ? (
        <div
          role="alert"
          className="mx-3 mb-2 flex shrink-0 items-start gap-2 rounded-xl border px-3 py-2 text-[12px]"
          style={{
            borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.4),
            color: SEMANTIC_COLORS.danger,
          }}
        >
          <span className="min-w-0 flex-1 break-words">{sendError}</span>
          <button
            onClick={() => void runTurn(lastSent)}
            className="shrink-0 underline font-medium"
            style={{ color: styles.accent }}
          >
            Retry
          </button>
        </div>
      ) : null}

      {/* Composer */}
      <div className="shrink-0 p-3 border-t" style={{ borderColor: styles.border }}>
        <div
          className="flex items-center gap-2 p-1.5 rounded-2xl border"
          style={{ background: styles.bg, borderColor: styles.border }}
        >
          <button
            onClick={noop}
            aria-label="Attach file"
            className="w-8 h-8 rounded-xl grid place-items-center shrink-0 transition-colors"
            style={{ backgroundColor: styles.inputBg, color: styles.textSecondary }}
          >
            <Paperclip size={13} />
          </button>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Message…"
            className="flex-1 min-w-0 bg-transparent outline-none text-[13px]"
            style={{ color: styles.text }}
          />
          <button
            onClick={() => void runTurn(input)}
            aria-label="Send message"
            className="w-8 h-8 rounded-xl grid place-items-center shrink-0 transition-transform hover:scale-105 active:scale-95"
            style={
              input.trim()
                ? { backgroundColor: styles.accent, color: styles.accentText }
                : { backgroundColor: styles.inputBg, color: styles.textTertiary }
            }
          >
            <ArrowUp size={14} strokeWidth={2.5} />
          </button>
        </div>
        <div className="px-1 pt-1.5 flex justify-between font-mono text-[10px]" style={{ color: styles.textTertiary }}>
          <span>⌘K to focus · ↵ to send</span>
        </div>
      </div>
    </div>
  );
}
