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
  Check,
  ChevronDown,
  Copy,
  Edit3,
  FileCode2,
  Paperclip,
  Search,
  Sparkles,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
  type StreamTurnEvent,
  type ToolUseEntry,
  fetchProviderModels,
  streamSessionMessage,
  toProjectChatItems,
} from "../../lib/api";
import { useConfigStore } from "../../lib/config-store";
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

const fmtTokens = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);

/** Known context windows (tokens) for the context meter. */
const CONTEXT_LIMITS: Record<string, number> = {
  "stealth/ox-alpha": 1_048_576,
};
const DEFAULT_CONTEXT_LIMIT = 1_000_000;

/** Hover copy button with a "Copied" flash (round-16 owner request). */
function CopyButton({ text }: { text: string }) {
  const styles = useThemeStyles();
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      aria-label="Copy message"
      title="Copy"
      className="w-6 h-6 rounded-md grid place-items-center transition-colors"
      style={{ color: styles.textTertiary }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = styles.subtleHover;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      {copied ? <Check size={11} style={{ color: SEMANTIC_COLORS.success }} /> : <Copy size={11} />}
    </button>
  );
}

/** Per-reply stats chips (owner spec: time · in · out · tok/s). */
function ReplyStats({
  usage,
  ms,
  model,
}: {
  usage?: { inputTokens: number; outputTokens: number };
  ms?: number;
  model?: string;
}) {
  const styles = useThemeStyles();
  if (usage === undefined && ms === undefined) return null;
  const seconds = ms !== undefined ? ms / 1000 : undefined;
  const tps =
    usage && seconds && seconds > 0 ? usage.outputTokens / seconds : undefined;
  const chips: string[] = [];
  if (seconds !== undefined) chips.push(`${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`);
  if (usage) {
    chips.push(`↑ ${fmtTokens(usage.inputTokens)}`);
    chips.push(`↓ ${fmtTokens(usage.outputTokens)}`);
  }
  if (tps !== undefined) chips.push(`${tps < 10 ? tps.toFixed(1) : Math.round(tps)} tok/s`);
  if (model) chips.push(model);
  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-1.5">
      {chips.map((c) => (
        <span
          key={c}
          className="text-[9.5px] font-mono px-1.5 py-0.5 rounded-md"
          style={{ color: styles.textTertiary, background: styles.subtle }}
        >
          {c}
        </span>
      ))}
    </div>
  );
}

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
      className="flex justify-end group"
      variants={msgVariants}
      initial="initial"
      animate="animate"
    >
      <div className="flex items-end gap-1 max-w-[85%]">
        <div className="opacity-0 group-hover:opacity-100 transition-opacity">
          <CopyButton text={content} />
        </div>
        <div
          className="rounded-2xl rounded-br-md px-3.5 py-2.5 text-[13px] leading-[1.5]"
          style={{ background: styles.accent, color: styles.accentText }}
        >
          {content}
        </div>
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

function AiMessage({
  content,
  usage,
  ms,
  model,
}: {
  content: string;
  usage?: { inputTokens: number; outputTokens: number };
  ms?: number;
  model?: string;
}) {
  const styles = useThemeStyles();
  return (
    <motion.div variants={msgVariants} initial="initial" animate="animate" className="group">
      <div
        className="rounded-2xl px-3.5 py-3 text-[13px] leading-[1.6]"
        style={{ background: styles.card, color: styles.text }}
      >
        <RichText content={content} />
      </div>
      <div className="flex items-start gap-1">
        <div className="opacity-0 group-hover:opacity-100 transition-opacity pt-1">
          <CopyButton text={content} />
        </div>
        <ReplyStats usage={usage} ms={ms} model={model} />
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
            <AiMessage content={item.content} usage={item.usage} ms={item.ms} model={item.model} />
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


/**
 * Composer footer (round-16): context-window meter (approx from the last
 * reply's usage), model picker (per-send override; the agent's model is the
 * default), and the keyboard hint.
 */
function ComposerFooter({
  agent,
  modelOverride,
  onModelChange,
  items,
  disabled,
}: {
  agent: Agent | null;
  modelOverride: string | null;
  onModelChange: (model: string | null) => void;
  items: ProjectChatItem[];
  disabled: boolean;
}) {
  const styles = useThemeStyles();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const effective = modelOverride ?? agent?.model ?? null;

  const providerId = agent?.providerId ?? null;
  const modelsQuery = useQuery({
    queryKey: ["provider-models", providerId],
    queryFn: () => fetchProviderModels(providerId as string),
    enabled: providerId !== null && !disabled,
    staleTime: 5 * 60 * 1000,
  });
  const models = (modelsQuery.data ?? []).slice(0, 60);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Approximate current context = last reply's in+out tokens (good enough
  // for a meter; exact per-model accounting is a later refinement).
  const lastUsage = [...items].reverse().find((it) => it.kind === "ai" && it.usage);
  const ctxTokens =
    lastUsage && lastUsage.kind === "ai" && lastUsage.usage
      ? lastUsage.usage.inputTokens + lastUsage.usage.outputTokens
      : 0;
  const limit = (effective !== null ? CONTEXT_LIMITS[effective] : undefined) ?? DEFAULT_CONTEXT_LIMIT;
  const pct = Math.min(100, (ctxTokens / limit) * 100);

  return (
    <div className="px-1 pt-1.5 flex items-center justify-between gap-2 font-mono text-[10px]" style={{ color: styles.textTertiary }}>
      <div className="flex items-center gap-2 min-w-0" title="Approximate context window usage (from the last reply)">
        <span className="shrink-0">ctx</span>
        <div className="w-16 h-1 rounded-full overflow-hidden shrink-0" style={{ background: styles.subtle }}>
          <div className="h-full rounded-full" style={{ width: `${Math.max(2, pct)}%`, background: styles.accent }} />
        </div>
        <span className="shrink-0">{fmtTokens(ctxTokens)} / {fmtTokens(limit)}</span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span>⌘K search · ↵ to send</span>
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setOpen((v) => !v)}
            disabled={disabled}
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-label="Choose model"
            title="Model for the next message"
            className="flex items-center gap-1 px-1.5 py-0.5 rounded-md transition-colors disabled:opacity-50 max-w-[180px]"
            style={{ color: styles.textSecondary }}
            onMouseEnter={(e) => {
              if (!disabled) e.currentTarget.style.background = styles.subtleHover;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
            }}
          >
            <span className="truncate">{effective ?? "no model"}</span>
            <ChevronDown size={10} />
          </button>
          {open ? (
            <div
              role="listbox"
              className="absolute bottom-7 right-0 w-64 max-h-64 overflow-y-auto auto-scroll rounded-2xl border p-1.5 z-50"
              style={{ background: styles.card, borderColor: styles.border, boxShadow: styles.bentoShadow }}
            >
              {models.length === 0 ? (
                <div className="text-[11px] px-2 py-1.5" style={{ color: styles.textTertiary }}>
                  {modelsQuery.isLoading ? "loading models…" : "no models listed"}
                </div>
              ) : (
                models.map((m) => (
                  <button
                    key={m}
                    role="option"
                    aria-selected={m === effective}
                    onClick={() => {
                      onModelChange(m === agent?.model ? null : m);
                      setOpen(false);
                    }}
                    className="w-full text-left px-2.5 py-1.5 rounded-lg font-mono text-[10.5px] truncate"
                    style={{
                      color: styles.textSecondary,
                      background: m === effective ? withAlpha(styles.accent, 0.09) : "transparent",
                    }}
                    onMouseEnter={(e) => {
                      if (m !== effective) e.currentTarget.style.background = styles.subtleHover;
                    }}
                    onMouseLeave={(e) => {
                      if (m !== effective) e.currentTarget.style.background = "transparent";
                    }}
                    title={m}
                  >
                    {m}
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function AgentChatPanel({
  projectId,
  project,
  compact = false,
}: {
  projectId: string;
  project: Project;
  /** Freeform (experimental) windows host a denser variant. */
  compact?: boolean;
}) {
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

  // Agent resolution (round-14): the SESSION's bound agent wins; for NEW
  // sessions the hamburger picker's choice (persisted) applies; else first.
  const agents = useAgents(false).data ?? [];
  const selectedAgentId = useProjectChatStore((s) => s.selectedAgentId);
  const setSelectedAgentId = useProjectChatStore((s) => s.setSelectedAgentId);
  const agent =
    agents.find((a) => a.id === session?.agentId) ??
    agents.find((a) => a.id === selectedAgentId) ??
    agents[0] ??
    null;

  // Agent picker popover (round-15: moved here from the removed TopBar menu).
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const agentMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!agentMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (agentMenuRef.current && !agentMenuRef.current.contains(e.target as Node)) {
        setAgentMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [agentMenuOpen]);

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

  // ── Round-16 live streaming state ────────────────────────────────────────
  const [liveText, setLiveText] = useState("");
  const [liveTools, setLiveTools] = useState<Array<{ toolName: string; argsSummary: string; ok: boolean | null }>>([]);
  const [streamBusy, setStreamBusy] = useState(false);
  const queryClient = useQueryClient();
  const liveMode = useConfigStore((s) => !s.demoData);
  // Per-send model override (composer picker); null = the agent's own model.
  const [modelOverride, setModelOverride] = useState<string | null>(null);
  const effectiveModel = modelOverride ?? agent?.model ?? null;

  const FILE_MUTATING_TOOLS = new Set(["write_file", "edit_file", "create_dir", "delete_file"]);

  const busy = createSession.isPending || sendMessage.isPending || pendingUser !== null || streamBusy;

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
  }, [items.length, busy, pendingUser, liveText, liveTools.length]);

  // NOTE: ⌘K now focuses the TopBar file search (demo behavior); the composer
  // keeps Enter-to-send and gets focus after sending.

  const runTurn = async (content: string) => {
    const text = content.trim();
    if (!text || busy || !agent) return;
    setInput("");
    setLastSent(text);
    setPendingUser(text);
    setSendError(null);
    setLiveText("");
    setLiveTools([]);
    let sid = session?.id;
    try {
      if (!sid) {
        const created = await createSession.mutateAsync({
          mode: "single" as const,
          agentId: agent.id,
          projectId,
          title: project.name,
        });
        sid = created.id;
      }
      if (liveMode) {
        // STREAMED turn: text deltas + tool calls land live (owner round-16).
        setStreamBusy(true);
        await streamSessionMessage(sid, text, (event: StreamTurnEvent) => {
          if (event.type === "text-delta") {
            setLiveText((prev) => prev + event.delta);
          } else if (event.type === "tool-call") {
            setLiveTools((prev) => [...prev, { toolName: event.toolName, argsSummary: event.argsSummary, ok: null }]);
          } else if (event.type === "tool-result") {
            setLiveTools((prev) => {
              // Attach the result to the matching in-flight pill (last null-ok).
              const idx = [...prev].reverse().findIndex((x) => x.toolName === event.toolName && x.ok === null);
              if (idx === -1) return [...prev, { toolName: event.toolName, argsSummary: event.argsSummary, ok: event.ok }];
              const real = prev.length - 1 - idx;
              const next = [...prev];
              next[real] = { ...next[real], ok: event.ok };
              return next;
            });
            // LIVE VIEW (owner request): file mutations refresh the explorer
            // + open file immediately, not after the turn ends.
            if (FILE_MUTATING_TOOLS.has(event.toolName)) {
              void queryClient.invalidateQueries({ queryKey: ["project-tree"] });
              void queryClient.invalidateQueries({ queryKey: ["project-file"] });
            }
          } else if (event.type === "error") {
            // SSE error event — show it but DON'T clear live text; the
            // backend may still complete the turn (invalidation on catch
            // will resolve it).
            setSendError(event.message);
          }
        }, { model: effectiveModel ?? undefined });
        setStreamBusy(false);
        await queryClient.invalidateQueries({ queryKey: ["session"] });
        await queryClient.invalidateQueries({ queryKey: ["sessions"] });
        await queryClient.invalidateQueries({ queryKey: ["usage"] });
        void queryClient.invalidateQueries({ queryKey: ["project-tree"] });
        // Canonical assistant item now renders from the event log.
        setLiveText("");
        setLiveTools([]);
      } else {
        // Fixture/demo mode: no sidecar → sync hook (canned reply).
        await sendMessage.mutateAsync({ sessionId: sid, content: text });
      }
    } catch (err) {
      // The stream may have errored client-side (network, CORS, abort) while
      // the backend actually completed the turn. Always re-fetch the session
      // so the canonical response appears even after a stream failure.
      await queryClient.invalidateQueries({ queryKey: ["session"] });
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      void queryClient.invalidateQueries({ queryKey: ["project-tree"] });
      const hasResponse = queryClient.getQueryData(["session", session?.id ?? sid]);
      if (!hasResponse) {
        setSendError(err instanceof Error ? err.message : String(err));
      } else {
        // The response landed despite the stream error — clear the error.
        setSendError(null);
        setLiveText("");
        setLiveTools([]);
      }
    } finally {
      setStreamBusy(false);
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
      className="flex flex-col h-full min-w-0 rounded-2xl overflow-hidden"
      style={{ backgroundColor: styles.card }}
    >
      {/* Panel header: accent chip · agent picker (round-15) · status chip */}
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
        <div className="relative min-w-0">
          <button
            onClick={() => setAgentMenuOpen((v) => !v)}
            className="flex items-center gap-1.5 rounded-lg px-1.5 py-1 transition-colors"
            style={{ color: styles.text }}
            aria-haspopup="listbox"
            aria-expanded={agentMenuOpen}
            aria-label="Choose agent"
            title="Choose the agent for new sessions"
            onMouseEnter={(e) => {
              e.currentTarget.style.background = styles.subtleHover;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
            }}
          >
            <span className="text-[13px] font-semibold truncate">{agent?.name ?? "No agent"}</span>
            <ChevronDown size={12} style={{ color: styles.textSecondary }} />
          </button>
          <span
            className="text-[10px] px-1.5 py-0.5 rounded-lg border font-mono shrink-0 ml-1"
            style={{
              backgroundColor: styles.inputBg,
              borderColor: styles.inputBorder,
              color: styles.textTertiary,
            }}
          >
            {agent?.model ?? "no model"}
          </span>
          {agentMenuOpen && (
            <div
              ref={agentMenuRef}
              className="absolute top-10 left-0 w-64 rounded-2xl border overflow-hidden z-50 p-1.5"
              style={{ background: styles.card, borderColor: styles.border, boxShadow: styles.bentoShadow }}
              role="listbox"
            >
              {agents.length === 0 ? (
                <div className="text-[12px] px-2.5 py-2" style={{ color: styles.textSecondary }}>
                  No agents yet — create one in Settings → Agents.
                </div>
              ) : (
                agents.map((a) => (
                  <button
                    key={a.id}
                    role="option"
                    aria-selected={a.id === (selectedAgentId ?? agents[0]?.id)}
                    onClick={() => {
                      setSelectedAgentId(a.id);
                      setAgentMenuOpen(false);
                    }}
                    className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-left"
                    style={{
                      background: a.id === (selectedAgentId ?? agents[0]?.id) ? withAlpha(styles.accent, 0.09) : "transparent",
                    }}
                    onMouseEnter={(e) => {
                      if (a.id !== (selectedAgentId ?? agents[0]?.id))
                        e.currentTarget.style.background = styles.subtleHover;
                    }}
                    onMouseLeave={(e) => {
                      if (a.id !== (selectedAgentId ?? agents[0]?.id))
                        e.currentTarget.style.background = "transparent";
                    }}
                  >
                    <div
                      className="w-7 h-7 rounded-lg grid place-items-center text-[11px] font-bold shrink-0"
                      style={{
                        background: a.id === (selectedAgentId ?? agents[0]?.id) ? styles.accent : styles.inputBg,
                        color: a.id === (selectedAgentId ?? agents[0]?.id) ? styles.accentText : styles.textSecondary,
                      }}
                    >
                      {a.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[12px] font-semibold truncate" style={{ color: styles.text }}>
                        {a.name}
                      </div>
                      <div className="text-[10px] font-mono truncate" style={{ color: styles.textSecondary }}>
                        {a.providerId ?? "—"} · {a.model ?? "—"}
                      </div>
                    </div>
                    {a.id === (selectedAgentId ?? agents[0]?.id) && (
                      <Check size={12} style={{ color: styles.accent, flexShrink: 0 }} />
                    )}
                  </button>
                ))
              )}
              <div className="px-2.5 pt-1.5 pb-1 text-[10px] font-mono" style={{ color: styles.textTertiary }}>
                applies to new sessions
              </div>
            </div>
          )}
        </div>
        <span className="flex-1" />
        <span
          className="text-[10px] font-mono px-1.5 py-0.5 rounded-full shrink-0"
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

            {/* ── LIVE STREAM (round-16): tool pills + streaming text ─────── */}
            {liveTools.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {liveTools.map((tool, i) => {
                  const Icon = TOOL_ICONS[tool.toolName] ?? Terminal;
                  const full = `${tool.toolName} ${tool.argsSummary}`.trim();
                  const label = full.length > 48 ? `${full.slice(0, 48)}…` : full;
                  return (
                    <div
                      key={`${tool.toolName}-${i}`}
                      title={full}
                      className="inline-flex items-center gap-1.5 h-7 px-3 rounded-full border font-mono text-[11px] max-w-full"
                      style={{
                        background: styles.isDark ? styles.bg : styles.card,
                        borderColor: tool.ok === false ? withAlpha(SEMANTIC_COLORS.danger, 0.5) : styles.border,
                        color: styles.textSecondary,
                      }}
                    >
                      <Icon size={11} className="shrink-0" />
                      <span className="truncate">{label}</span>
                      {tool.ok === null ? (
                        <span className="flex gap-0.5 shrink-0">
                          {[0, 0.15, 0.3].map((d, j) => (
                            <span
                              key={j}
                              className="w-1 h-1 rounded-full"
                              style={{
                                background: styles.textSecondary,
                                animation: `bounceDot 1s infinite ${d}s`,
                              }}
                            />
                          ))}
                        </span>
                      ) : (
                        <span
                          className="opacity-50 shrink-0"
                          style={{ color: tool.ok ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.danger }}
                        >
                          {tool.ok ? "✓" : "✗"}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : null}

            {streamBusy || liveText !== "" ? (
              <div
                className="rounded-2xl px-3.5 py-3 text-[13px] leading-[1.6]"
                style={{ background: styles.card, color: styles.text }}
              >
                {liveText === "" ? (
                  <span className="text-[12px] font-mono" style={{ color: styles.textSecondary }}>
                    thinking…
                  </span>
                ) : (
                  <>
                    <RichText content={liveText} />
                    <span
                      className="inline-block w-[7px] h-[14px] ml-0.5 align-middle rounded-sm"
                      style={{ background: styles.accent, animation: "bounceDot 1s infinite" }}
                    />
                  </>
                )}
              </div>
            ) : null}

            <AnimatePresence>
              {busy && !streamBusy && liveText === "" ? <AgentThinking agent={agent} /> : null}
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
        {!compact ? (
          <ComposerFooter
            agent={agent}
            modelOverride={modelOverride}
            onModelChange={setModelOverride}
            items={items}
            disabled={!liveMode}
          />
        ) : null}
      </div>
    </div>
  );
}
