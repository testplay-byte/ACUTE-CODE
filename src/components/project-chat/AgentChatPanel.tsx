import {
  forwardRef,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { AnimatePresence, motion, type Variants } from "framer-motion";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  FolderOpen,
  GitBranch,
  ListChecks,
  Search,
  type LucideIcon,
} from "lucide-react";
import { Link, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAgents } from "../../hooks/use-agents";
import {
  useCreateSession,
  useSendMessage,
  useSession,
  useSessions,
} from "../../hooks/use-sessions";
import { CommandPalette } from "./CommandPalette";
import {
  BareWorkingEntries,
  WorkingSection,
  type ApprovalDecisionChoice,
  type ApprovalRemember,
} from "./WorkingSection";
import { AcuteLogo } from "../shell/Sidebar";
import {
  type Agent,
  type AssistantTurnItem,
  type Project,
  type ProjectChatItem,
  type StreamTurnEvent,
  type ToolUseEntry,
  type WorkingEntry,
  decideApproval,
  fetchProviderModels,
  streamSessionMessage,
  toProjectChatItems,
} from "../../lib/api";
import { useConfigStore } from "../../lib/config-store";
import { useThemeStore } from "../../lib/theme-store";
import { withAlpha } from "../dashboard/helpers";
import { ease } from "../../lib/motion";
import { useProjectChatStore } from "../../lib/project-chat-store";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { useScrollFade } from "../../lib/useScrollFade";

/**
 * ROUND-37 (owner "two states" directive): the chat renders ONE assistant
 * TURN per user message — a collapsible Working section (thoughts, interim
 * narration, one-line tool rows) followed by the FINAL ANSWER below it.
 * No avatar tiles, no name headers, no Sparkles iconography (owner: "I
 * really hate the SVG icons… AI-generated"). The live streaming view builds
 * the same shape: the Working section grows while the presumptive-final text
 * streams beneath it, and collapses to "Worked for Ns" when the turn ends.
 */

const msgVariants: Variants = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.35, ease } },
  exit: { opacity: 0, y: -8, transition: { duration: 0.2, ease } },
};

const fmtTokens = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);

/** Known context windows (tokens) for the context meter. */
const CONTEXT_LIMITS: Record<string, number> = {
  "stealth/ox-alpha": 1_048_576,
};
const DEFAULT_CONTEXT_LIMIT = 1_000_000;

/** ROUND-33 (owner: "the command + K option… I am on Windows and it should
 * not show me these kinds of things"): show Ctrl labels on Windows. */
const IS_WINDOWS =
  typeof navigator !== "undefined" && /Win/i.test(navigator.userAgent);

/** Round-30 empty-state suggestion chips (fill the composer on click). */
const SUGGESTIONS: Array<{ label: string; prompt: string; icon: LucideIcon }> = [
  {
    label: "Explore this project",
    prompt: "Explore this project: list the top-level structure, then summarize what this codebase does and its tech stack.",
    icon: FolderOpen,
  },
  {
    label: "Find a bug",
    prompt: "Search the code for likely bugs or edge cases and report the top findings with file paths.",
    icon: Search,
  },
  {
    label: "Explain the architecture",
    prompt: "Explain this project's architecture: entry points, main modules, and how data flows between them.",
    icon: GitBranch,
  },
  {
    label: "Write a plan",
    prompt: "Write a short, ordered implementation plan for adding a small feature to this project.",
    icon: ListChecks,
  },
];

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
    case "turn":
      return `turn-${item.seq}`;
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
          className="rounded-[16px] rounded-br-md px-3.5 py-2.5 text-[13px] leading-[1.5]"
          style={{ background: styles.accent, color: styles.accentText }}
        >
          {content}
        </div>
      </div>
    </motion.div>
  );
}

/** Inline code block renderer with copy button (round-24: Kilo Code parity). */
function CodeBlock({ code }: { code: string }) {
  const styles = useThemeStyles();
  const [copied, setCopied] = useState(false);
  const lines = code.split("\n");
  return (
    <div className="my-1.5 rounded-[12px] overflow-hidden border" style={{ borderColor: styles.border }}>
      <div
        className="flex items-center justify-between px-3 py-1.5 border-b"
        style={{ background: styles.subtle, borderColor: styles.border }}
      >
        <span className="font-mono text-[10px] font-bold" style={{ color: styles.textTertiary }}>
          {lines.length} {lines.length === 1 ? "line" : "lines"}
        </span>
        <button
          onClick={() => {
            void navigator.clipboard?.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
          className="flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-semibold transition-colors"
          style={{ color: styles.textTertiary }}
          aria-label="Copy code"
        >
          {copied ? <Check size={10} style={{ color: "#22c55e" }} /> : <Copy size={10} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-[11.5px] leading-[1.6]" style={{ color: styles.text }}>
        {lines.map((line, i) => (
          <div key={i} className="flex">
            <span className="w-7 shrink-0 text-right pr-3 select-none font-mono text-[10px] leading-[1.6]" style={{ color: styles.textTertiary }}>
              {i + 1}
            </span>
            <span className="flex-1 whitespace-pre-wrap break-words">{line || " "}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}

/** Original inline parser (bold + `code`) — used for non-code-block text. */
function RichTextInline({ content }: { content: string }) {
  const styles = useThemeStyles();
  const elements: ReactNode[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const parts = line.split(/\*\*(.*?)\*\*/g);
    const lineEl: ReactNode[] = [];
    for (let j = 0; j < parts.length; j++) {
      if (j % 2 === 1) {
        lineEl.push(
          <strong key={`b-${i}-${j}`} style={{ fontWeight: 700 }}>
            {parts[j]}
          </strong>,
        );
      } else if (parts[j]) {
        const codeParts = parts[j].split(/`(.*?)`/g);
        for (let k = 0; k < codeParts.length; k++) {
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
                {codeParts[k]}
              </code>,
            );
          } else if (codeParts[k]) {
            lineEl.push(<span key={`s-${i}-${j}-${k}`}>{codeParts[k]}</span>);
          }
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

function RichText({ content }: { content: string }) {
  // Detect fenced code blocks (```...```) and render them as CodeBlock
  const codeBlockRegex = /```[a-zA-Z]*\n([\s\S]*?)```/g;
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match;
  let keyIdx = 0;
  while ((match = codeBlockRegex.exec(content)) !== null) {
    // Render text before the code block
    if (match.index > lastIndex) {
      parts.push(<RichTextInline key={`rt-${keyIdx++}`} content={content.slice(lastIndex, match.index)} />);
    }
    parts.push(<CodeBlock key={`cb-${keyIdx++}`} code={match[1].trimEnd()} />);
    lastIndex = match.index + match[0].length;
  }
  // Render remaining text
  if (lastIndex < content.length) {
    parts.push(<RichTextInline key={`rt-${keyIdx++}`} content={content.slice(lastIndex)} />);
  }
  return <>{parts}</>;
}

/**
 * ROUND-37 AssistantTurn: ONE header-less assistant block per user message.
 * Tools (or multiple working entries) → collapsible WorkingSection; a
 * tools-free turn renders its thoughts bare. The final answer renders below
 * the section — collapsing the work never hides it (owner directive).
 */
function AssistantTurn({
  item,
  sessionId,
  collapseHint,
}: {
  item: AssistantTurnItem;
  sessionId: string | null;
  /** R37 review #4: true when this turn JUST finished while the user
   * watched — it mounts collapsed ("Worked for Ns" + answer). */
  collapseHint?: boolean;
}) {
  const styles = useThemeStyles();
  const hasToolWork = item.working.some((e) => e.type === "tool");
  return (
    <motion.div variants={msgVariants} initial="initial" animate="animate" className="group min-w-0">
      {hasToolWork ? (
        <WorkingSection
          entries={item.working}
          sessionId={sessionId}
          ts={item.ts}
          endTs={item.endTs}
          defaultOpen={collapseHint === true ? false : undefined}
        />
      ) : (
        <BareWorkingEntries entries={item.working} />
      )}
      {item.finalText.trim() !== "" ? (
        <div className={`text-[13px] leading-[1.65] ${hasToolWork ? "mt-2" : ""}`} style={{ color: styles.text }}>
          <RichText content={item.finalText} />
        </div>
      ) : null}
      <div className="flex items-center gap-1">
        <div className="opacity-0 group-hover:opacity-100 transition-opacity pt-0.5">
          <CopyButton text={item.finalText} />
        </div>
        <ReplyStats usage={item.usage} ms={item.ms} model={item.model} />
      </div>
    </motion.div>
  );
}

/** Direct child of AnimatePresence mode="popLayout": framer-motion attaches a
 * measurement ref to this element (React 18 requires forwardRef — the demo
 * could skip it on React 19). The wrapper div is the presence child. */
const MessageRenderer = forwardRef<
  HTMLDivElement,
  { item: ProjectChatItem; sessionId: string | null; collapseHint?: boolean }
>(function MessageRenderer({ item, sessionId, collapseHint }, ref) {
  switch (item.kind) {
    case "user":
      return (
        <div ref={ref}>
          <UserMessage content={item.content} />
        </div>
      );
    case "turn":
      return (
        <div ref={ref}>
          <AssistantTurn item={item} sessionId={sessionId} collapseHint={collapseHint} />
        </div>
      );
  }
});

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

  // ROUND-37: turn-level stats (usage lives on the turn item now).
  const lastTurn = [...items].reverse().find((it) => it.kind === "turn" && it.usage !== undefined);
  const ctxTokens =
    lastTurn && lastTurn.kind === "turn" && lastTurn.usage
      ? lastTurn.usage.inputTokens + lastTurn.usage.outputTokens
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
        <span>{IS_WINDOWS ? "Ctrl K search" : "⌘K search"} · ↵ to send</span>
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

/** ROUND-37 live turn state: the same shape the folded log produces. */
interface LiveTurn {
  startedAtMs: number;
  /** Completed working entries (thoughts done, narration flushed in, tools). */
  working: WorkingEntry[];
  /** The presumptive-FINAL text streaming below the section. */
  streamText: string;
  /** The in-flight thought (auto-expanded row in the section). */
  streamThinking: string;
  /** Terminal state after a stream error — frozen "Stopped" section. */
  stopped: boolean;
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

  // ROUND-30 FIX (owner bug: "All of the sessions are exactly the same"):
  // the ?session= URL param — written by the sidebar's session rows and the
  // New Session button — is now the AUTHORITATIVE selection. The panel used
  // to always bind the project's MOST-RECENTLY-UPDATED session, so clicking
  // a different session showed the same conversation and every message went
  // into the latest one. Now: param session wins; fallback (no param) is the
  // latest session, matching the sidebar's default navigation target.
  const [searchParams, setSearchParams] = useSearchParams();
  const sessionIdParam = searchParams.get("session");
  const sessions = useSessions().data ?? [];
  const projectSessions = useMemo(
    () =>
      sessions
        .filter((s) => s.projectId === projectId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [sessions, projectId],
  );
  const session = useMemo(() => {
    if (sessionIdParam !== null) {
      const fromParam = projectSessions.find((s) => s.id === sessionIdParam);
      // Param points at a session in ANOTHER project (or a deleted one):
      // fall through to the latest of THIS project rather than rendering
      // a foreign conversation.
      if (fromParam !== undefined) return fromParam;
    }
    return projectSessions[0] ?? null;
  }, [projectSessions, sessionIdParam]);
  const sessionDetail = useSession(session?.id ?? null);

  // Agent resolution (round-14): the SESSION's bound agent wins; for NEW
  // sessions the hamburger picker's choice (persisted) applies; else first.
  const agents = useAgents(false).data ?? [];
  const selectedAgentId = useProjectChatStore((s) => s.selectedAgentId);
  const agent =
    agents.find((a) => a.id === session?.agentId) ??
    agents.find((a) => a.id === selectedAgentId) ??
    agents[0] ??
    null;

  const [paletteOpen, setPaletteOpen] = useState(false);
  const density = useThemeStore((s) => s.density);

  // ⌘K / Ctrl+K opens the CommandPalette (WS-H).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  const createSession = useCreateSession();
  const sendMessage = useSendMessage();

  // ROUND-37: the turn fold carries stats turn-level — the old R33
  // interim-reply stat-strip pass is GONE (superseded by the fold).
  const items = useMemo(() => {
    if (!sessionDetail.data) return [];
    return toProjectChatItems(sessionDetail.data.events);
  }, [sessionDetail.data]);

  const [input, setInput] = useState("");
  const [composerFocused, setComposerFocused] = useState(false);
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [lastSent, setLastSent] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  // ── ROUND-37 live streaming state: ONE live turn building the same
  //    Working-section shape the folded log renders. The presumptive-final
  //    text streams BELOW the section; a tool-call flushes it INTO the
  //    section as narration (owner: interim commentary lives inside the
  //    working area).
  const [liveTurn, setLiveTurn] = useState<LiveTurn | null>(null);
  const [streamBusy, setStreamBusy] = useState(false);
  // R37 review #3: monotonic live entry keys (two tool-calls in the same
  // millisecond collided with -Date.now()).
  const liveSeqRef = useRef(0);
  // R37 review #4: turns that JUST finished while the user watched start
  // collapsed ("Worked for Ns" + answer); cold-loaded sessions use the
  // Detailed preference.
  const lastLiveEndRef = useRef(0);
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
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const selectProjectFile = useProjectChatStore((s) => s.selectFile);
  const setCodeVisibleForPick = useProjectChatStore((s) => s.setCodeVisible);
  // Round-28 WS-D3: AbortController for the streaming fetch — the Stop button
  // calls abortRef.current?.abort() to cancel mid-stream.
  const abortRef = useRef<AbortController | null>(null);

  useScrollFade(scrollRef);

  // Auto-scroll: new items, busy transitions, the live section's entry count,
  // and the growing streaming text (review fix #4 + R37 amendment #11).
  const liveWorkingCount = liveTurn?.working.length ?? 0;
  const liveTailText = liveTurn?.streamText ?? "";
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [items.length, busy, pendingUser, liveWorkingCount, liveTailText.length]);

  const runTurn = async (content: string) => {
    const text = content.trim();
    if (!text || busy || !agent) return;
    setInput("");
    setLastSent(text);
    setPendingUser(text);
    setSendError(null);
    setLiveTurn({ startedAtMs: Date.now(), working: [], streamText: "", streamThinking: "", stopped: false });
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
        // Round-30: the URL is the authoritative session selection — pin the
        // freshly created session so a later "New Session" elsewhere doesn't
        // steal this conversation mid-turn.
        setSearchParams(
          (prev) => {
            const next = new URLSearchParams(prev);
            next.set("session", sid as string);
            return next;
          },
          { replace: true },
        );
      }
      if (liveMode) {
        // STREAMED turn (round-16): deltas + tool calls land live; the
        // Working section builds itself (R37).
        setStreamBusy(true);
        abortRef.current = new AbortController();
        await streamSessionMessage(sid, text, (event: StreamTurnEvent) => {
          if (event.type === "text-delta") {
            setLiveTurn((prev) => {
              if (prev === null) return prev;
              // Text starting = the in-flight thought is COMPLETE (owner:
              // "when the thought has been completed then it will collapse").
              const working =
                prev.streamThinking.trim() !== ""
                  ? [
                      ...prev.working,
                      { type: "thinking" as const, text: prev.streamThinking, ts: new Date().toISOString() },
                    ]
                  : prev.working;
              return {
                ...prev,
                working,
                streamThinking: "",
                streamText: prev.streamText + event.delta,
              };
            });
          } else if (event.type === "thinking-delta") {
            setLiveTurn((prev) =>
              prev === null
                ? prev
                : { ...prev, streamThinking: prev.streamThinking + event.delta },
            );
          } else if (event.type === "tool-call") {
            setLiveTurn((prev) => {
              if (prev === null) return prev;
              // The streamed-so-far text is narration once a tool lands —
              // flush it (and any trailing thought) INTO the section.
              // R35 review fix #2 preserved: build NEW arrays/entries, never
              // mutate (StrictMode double-invoke safe).
              const entry: ToolUseEntry = {
                seq: --liveSeqRef.current,
                toolName: event.toolName,
                argsSummary: event.argsSummary,
                ok: null,
                ts: new Date().toISOString(),
              };
              const working: WorkingEntry[] = [
                ...prev.working,
                ...(prev.streamThinking.trim() !== ""
                  ? [{ type: "thinking" as const, text: prev.streamThinking, ts: new Date().toISOString() }]
                  : []),
                ...(prev.streamText.trim() !== ""
                  ? [{ type: "text" as const, content: prev.streamText, ts: new Date().toISOString() }]
                  : []),
                { type: "tool" as const, tool: entry },
              ];
              return { ...prev, working, streamThinking: "", streamText: "" };
            });
          } else if (event.type === "tool-result") {
            setLiveTurn((prev) => {
              if (prev === null) return prev;
              // Attach the result to the matching in-flight row (last null-ok
              // tool entry). R35 review fix #6 preserved: results with no
              // matching in-flight row append a completed entry instead of
              // being silently dropped.
              const flat = prev.working.flatMap((e) => (e.type === "tool" ? [e.tool] : []));
              const idx = [...flat].reverse().findIndex((x) => x.toolName === event.toolName && x.ok === null);
              if (idx === -1) {
                const entry: ToolUseEntry = {
                  seq: --liveSeqRef.current,
                  toolName: event.toolName,
                  argsSummary: event.argsSummary,
                  ok: event.ok,
                  ts: new Date().toISOString(),
                  ...(event.outputSummary ? { outputSummary: event.outputSummary } : {}),
                };
                return { ...prev, working: [...prev.working, { type: "tool", tool: entry }] };
              }
              const matched = flat.length - 1 - idx;
              let consumed = 0;
              const working = prev.working.map((entry) => {
                if (entry.type !== "tool") return entry;
                const index = consumed;
                consumed += 1;
                if (index === matched) {
                  return {
                    ...entry,
                    tool: {
                      ...entry.tool,
                      ok: event.ok,
                      ...(event.outputSummary ? { outputSummary: event.outputSummary } : {}),
                    },
                  };
                }
                return entry;
              });
              return { ...prev, working };
            });
            // LIVE VIEW (owner request): file mutations refresh the explorer
            // + open file immediately, not after the turn ends.
            if (FILE_MUTATING_TOOLS.has(event.toolName)) {
              void queryClient.invalidateQueries({ queryKey: ["project-tree"] });
              void queryClient.invalidateQueries({ queryKey: ["project-file"] });
            }
          } else if (event.type === "approval.requested") {
            setLiveTurn((prev) =>
              prev === null
                ? prev
                : {
                    ...prev,
                    working: [
                      ...prev.working,
                      {
                        type: "approval" as const,
                        approvalId: event.approvalId,
                        toolName: event.toolName,
                        argsSummary: event.argsSummary,
                        category: event.category,
                        status: "pending" as const,
                        ts: new Date().toISOString(),
                      },
                    ],
                  },
            );
          } else if (event.type === "approval.resolved") {
            setLiveTurn((prev) => {
              if (prev === null) return prev;
              const working = prev.working.map((entry) => {
                if (entry.type !== "approval" || entry.approvalId !== event.approvalId) return entry;
                return {
                  ...entry,
                  status:
                    event.decision === "approved"
                      ? ("approved" as const)
                      : event.decision === "denied"
                        ? ("denied" as const)
                        : ("expired" as const),
                  ...(event.remember ? { remember: event.remember } : {}),
                };
              });
              return { ...prev, working };
            });
          } else if (event.type === "error") {
            // SSE error event — show it but DON'T clear live state; the
            // backend may still complete the turn (invalidation on catch
            // will resolve it).
            setSendError(event.message);
          }
        }, { model: effectiveModel ?? undefined, signal: abortRef.current.signal });
        abortRef.current = null;
        setStreamBusy(false);
        await queryClient.invalidateQueries({ queryKey: ["session"] });
        await queryClient.invalidateQueries({ queryKey: ["sessions"] });
        await queryClient.invalidateQueries({ queryKey: ["usage"] });
        void queryClient.invalidateQueries({ queryKey: ["project-tree"] });
        // The canonical folded turn now renders from the event log (and the
        // live section auto-collapses to "Worked for Ns").
        lastLiveEndRef.current = Date.now();
        setLiveTurn(null);
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
      // R37 review #1: the session query key is ["session", source, id] —
      // an exact-hash lookup without the source segment never matched.
      const hasResponse = queryClient.getQueryData([
        "session",
        liveMode ? "live" : "demo",
        session?.id ?? sid,
      ]);
      if (!hasResponse) {
        setSendError(err instanceof Error ? err.message : String(err));
        // Freeze the live section in its terminal "Stopped" state (R37
        // amendment: no dead timer — the header reads "Stopped · Ns").
        setLiveTurn((prev) => (prev === null ? prev : { ...prev, stopped: true }));
      } else {
        // The response landed despite the stream error — clear the error.
        setSendError(null);
        lastLiveEndRef.current = Date.now();
        setLiveTurn(null);
      }
    } finally {
      setStreamBusy(false);
      // Both hooks invalidate their queries on settle; drop the optimistic echo.
      setPendingUser(null);
    }
  };

  const onApprovalDecision = async (
    approvalId: string,
    decision: ApprovalDecisionChoice,
    remember: ApprovalRemember,
  ) => {
    try {
      await decideApproval(approvalId, { decision, remember });
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    }
  };

  const onInputKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void runTurn(input);
    }
  };

  // ── Live-turn rendering (same shape as the folded AssistantTurn) ──────────
  const liveSection = (() => {
    if (liveTurn === null) return null;
    const entries: WorkingEntry[] = [
      ...liveTurn.working,
      ...(liveTurn.streamThinking.trim() !== ""
        ? [{ type: "thinking" as const, text: liveTurn.streamThinking, ts: new Date().toISOString() }]
        : []),
    ];
    const hasToolWork = entries.some((e) => e.type === "tool");
    if (hasToolWork) {
      return (
        <WorkingSection
          key="live-section"
          entries={entries}
          sessionId={session?.id ?? null}
          live
          startedAtMs={liveTurn.startedAtMs}
          stopped={liveTurn.stopped}
          liveEntryIndex={liveTurn.streamThinking.trim() !== "" ? entries.length - 1 : undefined}
          onApprovalDecision={(id, decision, remember) => void onApprovalDecision(id, decision, remember)}
        />
      );
    }
    return (
      <BareWorkingEntries
        key="live-bare"
        entries={entries}
        onApprovalDecision={(id, decision, remember) => void onApprovalDecision(id, decision, remember)}
      />
    );
  })();

  return (
    <div
      className="flex flex-col h-full min-w-0 rounded-[16px] overflow-hidden"
      style={{ backgroundColor: styles.card }}
    >
      {/* ⌘K / Ctrl+K CommandPalette (files/symbols/content search — WS-H) */}
      <CommandPalette
        projectId={projectId}
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onPickFile={(path) => {
          selectProjectFile(path);
          setCodeVisibleForPick(true);
          setPaletteOpen(false);
        }}
      />
      {/* Scroll body with top fade (demo structure) */}
      <div className="relative flex-1 min-h-0 overflow-hidden">
        <div
          className="absolute top-0 left-0 right-0 h-8 z-10 pointer-events-none"
          style={{ background: `linear-gradient(to bottom, ${styles.card}, transparent)` }}
        />
        <div ref={scrollRef} className="absolute inset-0 overflow-y-auto auto-scroll">
          {/* ROUND-34: density (settings appearance) drives the column padding.
              ROUND-37: the panel fills its width (owner: no dead right side). */}
          <div className={`${density === "compact" ? "px-4 py-4" : "px-5 md:px-10 py-5"} flex flex-col gap-5`}>
            {items.length === 0 && !pendingEcho ? (
              /* ROUND-30 OVERHAUL: centered greeting + suggestion chips.
                 ROUND-37: the approved AcuteLogo replaces the Sparkles tile. */
              <div className="flex flex-col items-center justify-center text-center py-14 gap-5">
                <AcuteLogo size={52} ariaLabel="Acute" />
                <div className="min-w-0 max-w-md">
                  <div className="text-[22px] font-black tracking-tight leading-tight" style={{ color: styles.text }}>
                    How can I help with {project.name}?
                  </div>
                  <div className="text-[12.5px] mt-2 leading-relaxed" style={{ color: styles.textSecondary }}>
                    {agent?.name ?? "Acute"} · {agent?.model ?? "no model"} · streaming replies with live tool calls
                  </div>
                  {agents.length === 0 ? (
                    <div className="text-[12px] mt-3" style={{ color: styles.textSecondary }}>
                      Create an agent in{" "}
                      <Link to="/settings" style={{ color: styles.accent }}>
                        Settings
                      </Link>{" "}
                      first
                    </div>
                  ) : null}
                </div>
                {agents.length > 0 ? (
                  <div className="flex flex-wrap items-center justify-center gap-2 max-w-lg">
                    {SUGGESTIONS.map((s) => (
                      <button
                        key={s.label}
                        onClick={() => {
                          setInput(s.prompt);
                          inputRef.current?.focus();
                        }}
                        className="flex items-center gap-2 h-9 px-3.5 rounded-full border text-[12px] font-medium transition-all hover:-translate-y-px"
                        style={{
                          borderColor: styles.border,
                          background: styles.bg,
                          color: styles.textSecondary,
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.borderColor = withAlpha(styles.accent, 0.5);
                          e.currentTarget.style.color = styles.text;
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.borderColor = styles.border;
                          e.currentTarget.style.color = styles.textSecondary;
                        }}
                      >
                        <s.icon size={12} style={{ color: styles.accent }} className="shrink-0" />
                        {s.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            <AnimatePresence mode="popLayout">
              {items.map((item) => (
                <MessageRenderer
                  key={itemKey(item)}
                  item={item}
                  sessionId={session?.id ?? null}
                  collapseHint={Date.now() - lastLiveEndRef.current < 5000}
                />
              ))}
              {pendingEcho !== null ? (
                <MessageRenderer
                  item={{ kind: "user", seq: -1, content: pendingEcho, ts: new Date().toISOString() }}
                  sessionId={null}
                />
              ) : null}
            </AnimatePresence>

            {/* ── ROUND-37 LIVE TURN: the Working section grows above the
                streaming presumptive-final text (which flows into the
                section as narration the moment a tool lands). ── */}
            {liveTurn !== null ? (
              <div aria-live="polite" aria-atomic="false" className="min-w-0">
                {liveSection}
                {liveTurn.streamText !== "" ? (
                  <div className={`text-[13px] leading-[1.65] ${liveTurn.working.length > 0 ? "mt-2" : ""}`} style={{ color: styles.text }}>
                    <RichText content={liveTurn.streamText} />
                    {streamBusy && !liveTurn.stopped ? (
                      <span
                        className="inline-block w-[7px] h-[14px] ml-0.5 align-middle rounded-sm ac-caret-blink"
                        style={{ background: styles.accent }}
                        aria-hidden
                      />
                    ) : null}
                  </div>
                ) : liveTurn.streamThinking.trim() === "" && liveTurn.working.length === 0 ? (
                  <span className="text-[12px] font-mono" style={{ color: styles.textSecondary }}>
                    Thinking<span className="ac-ellipsis" aria-hidden />
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* Error banner (ChatView pattern): keeps the failed text for Retry. */}
      {sendError && lastSent ? (
        <div
          role="alert"
          className="mx-3 mb-1.5 flex shrink-0 items-start gap-2 rounded-[12px] border px-3 py-2 text-[12px]"
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

      {/* Composer — ROUND-32 (design Frame 5): radius 18, warm bg, accent
          border + soft glow ring on focus. Auto-growing textarea (Enter sends,
          Shift+Enter newlines). */}
      <div className="shrink-0 p-2.5 border-t" style={{ borderColor: styles.borderSubtle }}>
        <div
          className="flex items-end gap-2 p-2 rounded-[18px] border transition-all"
          style={{
            background: styles.isDark ? "rgba(255,255,255,0.04)" : styles.bg,
            borderColor: composerFocused ? withAlpha(styles.accent, 0.4) : styles.border,
            boxShadow: composerFocused ? `0 0 0 4px ${withAlpha(styles.accent, 0.13)}` : "none",
          }}
        >
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              // Auto-grow to fit content (max 6 rows), then scroll inside.
              const el = e.currentTarget;
              el.style.height = "auto";
              el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
            }}
            onFocus={() => setComposerFocused(true)}
            onBlur={() => setComposerFocused(false)}
            onKeyDown={onInputKeyDown}
            rows={1}
            aria-label="Message composer"
            placeholder={`Message ${agent?.name ?? "Acute"}…`}
            className="flex-1 min-w-0 bg-transparent outline-none resize-none text-[13px] leading-[1.5] max-h-[132px] py-1.5 px-1"
            style={{ color: styles.text }}
          />
          {busy ? (
            <button
              // Round-28 WS-D3: abort the in-flight streaming fetch. The
              // backend sees the client close; the catch block re-fetches
              // the session so any partial response renders from the log.
              onClick={() => abortRef.current?.abort()}
              aria-label="Stop generation"
              title="Stop generation"
              className="w-9 h-9 rounded-xl grid place-items-center shrink-0 transition-transform hover:scale-105 active:scale-95"
              style={{ backgroundColor: SEMANTIC_COLORS.danger, color: "#fff" }}
            >
              <span className="w-3 h-3 rounded-sm bg-white/90" />
            </button>
          ) : null}
          <button
            onClick={() => void runTurn(input)}
            disabled={!input.trim()}
            aria-label="Send message"
            title="Send (Enter · Shift+Enter for a new line)"
            className="w-9 h-9 rounded-xl grid place-items-center shrink-0 transition-all hover:scale-105 active:scale-95 disabled:hover:scale-100"
            style={
              input.trim()
                ? {
                    backgroundColor: styles.accent,
                    color: styles.accentText,
                    boxShadow: `0 2px 10px ${withAlpha(styles.accent, 0.35)}`,
                  }
                : { backgroundColor: styles.inputBg, color: styles.textTertiary }
            }
          >
            <ArrowUp size={15} strokeWidth={2.5} />
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
