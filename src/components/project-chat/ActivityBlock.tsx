import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  ChevronDown,
  FileCode2,
  Globe,
  Search,
  Settings2,
  Sparkles,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import {
  DIFF_TOOLS,
  TERMINAL_TOOLS,
  WEB_TOOLS,
  parseDiffArgs,
  resolveSnapshotForTool,
  type DiffLine,
  type ToolUseEntry,
  computeUnifiedDiff,
  fetchSessionCheckpoints,
  fetchSnapshot,
} from "../../lib/api";
import { useProjectChatStore } from "../../lib/project-chat-store";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { withAlpha } from "../dashboard/helpers";

/**
 * ActivityBlock (Round 32 — the owner-approved "money screen" design):
 * ONE collapsible card per agentic turn visualizing EVERYTHING the agent did —
 * rounds timeline, tool rows, file-change diff cards, command terminal cards,
 * web-action rows — replacing the old flat tool-pill rows. Directly answers
 * the owner's complaint: "The actions which it performs do not get shown
 * properly if it writes a file or creates a file. I do not get proper
 * customization."
 *
 * Customization (persisted): Detailed (full timeline) · Compact (header
 * one-liner only) · Hidden (block not rendered).
 *
 * The LIVE variant (streaming) takes in-progress entries with ok === null
 * and a "Working…" header with a pulsing avatar.
 */

export type ActivityMode = "detailed" | "compact" | "hidden";
const MODE_KEY = "acute-code.activityMode";

function readMode(): ActivityMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return v === "compact" || v === "hidden" ? v : "detailed";
  } catch {
    return "detailed";
  }
}

const TOOL_ICONS: Record<string, LucideIcon> = {
  list_dir: Search,
  read_file: FileCode2,
  write_file: FileCode2,
  edit_file: FileCode2,
  create_dir: FileCode2,
  delete_file: FileCode2,
  web_search: Globe,
  web_fetch: Globe,
  search_code: Search,
  search_files: Search,
  git_status: FileCode2,
  git_diff: FileCode2,
  git_log: FileCode2,
  run_command: Terminal,
  todo_write: Settings2,
};

const basename = (p: string): string => p.split("/").pop() ?? p;

/** Elapsed seconds between two ISO stamps (0 when unparseable). */
function elapsedSeconds(start: string, end: string): number {
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 1000));
}

// ─── Customization popover (Detailed · Compact · Hidden) ─────────────────────

function ModePopover({ mode, onMode }: { mode: ActivityMode; onMode: (m: ActivityMode) => void }) {
  const styles = useThemeStyles();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const options: Array<{ id: ActivityMode; label: string }> = [
    { id: "detailed", label: "Detailed" },
    { id: "compact", label: "Compact" },
    { id: "hidden", label: "Hidden" },
  ];

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-label="Activity display options"
        aria-haspopup="listbox"
        aria-expanded={open}
        title="How to show agent activity"
        className="w-6 h-6 rounded-md grid place-items-center transition-colors"
        style={{ color: styles.textTertiary }}
        onMouseEnter={(e) => (e.currentTarget.style.background = styles.subtleHover)}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      >
        <Settings2 size={11} />
      </button>
      {open && (
        <div
          role="listbox"
          aria-label="Activity display mode"
          className="absolute right-0 top-7 z-50 rounded-[12px] border-[1.5px] p-1 flex gap-1"
          style={{ background: styles.card, borderColor: styles.border, boxShadow: styles.softShadow }}
          onClick={(e) => e.stopPropagation()}
        >
          {options.map((o) => (
            <button
              key={o.id}
              role="option"
              aria-selected={mode === o.id}
              onClick={() => {
                onMode(o.id);
                setOpen(false);
              }}
              className="h-6 px-2.5 rounded-full text-[10px] font-bold transition-colors"
              style={
                mode === o.id
                  ? { background: styles.accent, color: styles.accentText }
                  : { background: styles.card, color: styles.text, border: `1px solid ${styles.border}` }
              }
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Tool row (one executed tool call) ────────────────────────────────────────

function ToolRow({ tool }: { tool: ToolUseEntry }) {
  const styles = useThemeStyles();
  const Icon = TOOL_ICONS[tool.toolName] ?? Terminal;
  const full = `${tool.toolName} ${tool.argsSummary}`.trim();
  return (
    <div className="flex items-center gap-2.5 h-8 px-1" title={full}>
      <span
        className="w-[22px] h-[22px] shrink-0 rounded-[7px] grid place-items-center"
        style={{ background: styles.inputBg, color: styles.textSecondary }}
      >
        <Icon size={11} />
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px]" style={{ color: styles.textSecondary }}>
        <span style={{ color: styles.text, fontWeight: 600 }}>{tool.toolName}</span>
        {tool.argsSummary ? ` ${tool.argsSummary}` : ""}
      </span>
      <span className="shrink-0 w-4 text-center text-[11px]" style={{ color: tool.ok ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.danger }}>
        {tool.ok ? "✓" : "✗"}
      </span>
    </div>
  );
}

// ─── File-change diff card (write_file / edit_file) ──────────────────────────

function FileChangeCard({ tool, sessionId, writing }: { tool: ToolUseEntry; sessionId: string | null; writing?: boolean }) {
  const styles = useThemeStyles();
  const selectFile = useProjectChatStore((s) => s.selectFile);
  const setCodeVisible = useProjectChatStore((s) => s.setCodeVisible);
  const [expanded, setExpanded] = useState(false);
  const [diffLines, setDiffLines] = useState<DiffLine[] | null>(null);
  const [loading, setLoading] = useState(false);

  const { path, chars } = parseDiffArgs(tool.argsSummary);

  // Round-32: resolve which snapshot belongs to this tool event. The runtime
  // stamps snapshots with the TURN's starting seq, not the tool event's seq —
  // the checkpoint list + path matching finds the right one.
  const checkpointsQuery = useQuery({
    queryKey: ["session-checkpoints", sessionId],
    queryFn: () => fetchSessionCheckpoints(sessionId as string),
    enabled: sessionId !== null,
    staleTime: 30_000,
  });

  const loadDiff = async () => {
    if (diffLines !== null || !sessionId) return;
    setLoading(true);
    try {
      const snapMeta = resolveSnapshotForTool(checkpointsQuery.data ?? [], path, tool.seq);
      const snap = snapMeta ? await fetchSnapshot(sessionId, snapMeta.seq) : null;
      setDiffLines(snap ? computeUnifiedDiff(snap.beforeContent, snap.afterContent) : []);
    } catch {
      setDiffLines([]);
    } finally {
      setLoading(false);
    }
  };

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next) void loadDiff();
  };

  // Diff-stat chips: real +/- counts once loaded, else chars.
  const added = diffLines?.filter((l) => l.type === "add").length;
  const removed = diffLines?.filter((l) => l.type === "del").length;

  return (
    <div
      className="rounded-[12px] border overflow-hidden"
      style={{
        // In-flight writes get the warm tint + accent border (design Frame 5).
        background: writing ? styles.sidebarBg : styles.isDark ? "rgba(255,255,255,0.02)" : "rgba(0,0,0,0.015)",
        borderColor: writing ? withAlpha(styles.accent, 0.35) : styles.border,
      }}
    >
      {/* Header row */}
      <div className="flex items-center gap-2 px-2.5 h-9">
        <button
          onClick={toggle}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} diff for ${path ?? tool.toolName}`}
          className="flex items-center gap-1.5 min-w-0 flex-1 text-left"
          title={path ?? tool.argsSummary}
        >
          <ChevronDown
            size={11}
            style={{ color: styles.textTertiary, transform: expanded ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 0.2s" }}
          />
          <span className="truncate font-mono text-[11px] font-semibold" style={{ color: styles.text }}>
            {path ? basename(path) : tool.toolName}
          </span>
        </button>
        {/* Diff-stat chips */}
        {writing ? (
          <span className="shrink-0 text-[10px] font-mono" style={{ color: styles.accent }}>
            writing<span className="ac-ellipsis" aria-hidden />
          </span>
        ) : (
          <span className="shrink-0 flex items-center gap-1 font-mono text-[10px] font-bold">
            {diffLines !== null && added !== undefined && removed !== undefined ? (
              <>
                <span className="px-1.5 py-0.5 rounded-full" style={{ background: withAlpha(SEMANTIC_COLORS.success, 0.12), color: SEMANTIC_COLORS.success }}>
                  +{added}
                </span>
                <span className="px-1.5 py-0.5 rounded-full" style={{ background: withAlpha(SEMANTIC_COLORS.danger, 0.1), color: SEMANTIC_COLORS.danger }}>
                  −{removed}
                </span>
              </>
            ) : (
              <span className="px-1.5 py-0.5 rounded-full" style={{ background: styles.subtle, color: styles.textTertiary }}>
                {chars !== null ? `+${chars}` : "diff"}
              </span>
            )}
            <span style={{ color: tool.ok ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.danger }}>{tool.ok ? "✓" : "✗"}</span>
          </span>
        )}
        {/* Open file pill */}
        {path && !writing && (
          <button
            onClick={() => {
              selectFile(path);
              setCodeVisible(true);
            }}
            className="shrink-0 h-6 px-2 rounded-full text-[10px] font-bold transition-colors"
            style={{ background: styles.subtle, color: styles.textSecondary }}
            onMouseEnter={(e) => (e.currentTarget.style.background = styles.subtleHover)}
            onMouseLeave={(e) => (e.currentTarget.style.background = styles.subtle)}
            title={`Open ${path}`}
          >
            Open
          </button>
        )}
      </div>
      {/* Full path strip */}
      {path && (
        <div className="px-2.5 pb-1.5 -mt-0.5 truncate font-mono text-[10px]" style={{ color: styles.textTertiary }} title={path}>
          {path}
        </div>
      )}
      {/* Diff body */}
      {expanded && (
        <div
          className="border-t max-h-80 overflow-y-auto auto-scroll font-mono text-[11px] leading-[1.55]"
          style={{ borderColor: styles.border, background: styles.isDark ? "rgba(0,0,0,0.25)" : styles.bg }}
        >
          <div className="px-3 py-1 text-[10px] font-mono border-b" style={{ color: styles.textTertiary, borderColor: styles.border }}>
            {path ? basename(path) : "file"} · Diff
          </div>
          {loading ? (
            <div className="px-3 py-3 text-[11px] font-mono" style={{ color: styles.textTertiary }}>
              loading diff…
            </div>
          ) : diffLines === null ? null : diffLines.length === 0 ? (
            <div className="px-3 py-3 text-[11px] font-mono" style={{ color: styles.textTertiary }}>
              no snapshot recorded for this change
            </div>
          ) : (
            diffLines.map((line, i) => (
              <div
                key={i}
                className="flex"
                style={{
                  background:
                    line.type === "add"
                      ? withAlpha(SEMANTIC_COLORS.success, 0.07)
                      : line.type === "del"
                        ? withAlpha(SEMANTIC_COLORS.danger, 0.07)
                        : "transparent",
                }}
              >
                <span
                  className="w-3 shrink-0 select-none text-center"
                  style={{
                    color:
                      line.type === "add"
                        ? SEMANTIC_COLORS.success
                        : line.type === "del"
                          ? SEMANTIC_COLORS.danger
                          : styles.textTertiary,
                  }}
                >
                  {line.type === "add" ? "+" : line.type === "del" ? "−" : " "}
                </span>
                <span className="flex-1 whitespace-pre-wrap break-words pr-3" style={{ color: styles.text }}>
                  {line.text || " "}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ─── Command terminal card (run_command) ─────────────────────────────────────

function TerminalCard({ tool }: { tool: ToolUseEntry }) {
  const styles = useThemeStyles();
  // argsSummary carries the command; ok doubles as the exit status.
  const command = tool.argsSummary || tool.toolName;
  return (
    <div className="rounded-[12px] border overflow-hidden" style={{ borderColor: styles.border }}>
      {/* Title bar — traffic lights + command */}
      <div
        className="flex items-center gap-2 h-7 px-2.5"
        style={{ background: styles.isDark ? "#1A1A1A" : "#262626" }}
      >
        <span className="flex gap-1.5 shrink-0" aria-hidden>
          <span className="w-2 h-2 rounded-full" style={{ background: "#FF5F56" }} />
          <span className="w-2 h-2 rounded-full" style={{ background: "#FFBD2E" }} />
          <span className="w-2 h-2 rounded-full" style={{ background: "#28C840" }} />
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px]" style={{ color: "rgba(255,255,255,0.75)" }}>
          {command}
        </span>
        <span
          className="shrink-0 px-1.5 py-0.5 rounded-full font-mono text-[9px] font-bold"
          style={{
            background: tool.ok ? withAlpha(SEMANTIC_COLORS.success, 0.18) : withAlpha(SEMANTIC_COLORS.danger, 0.18),
            color: tool.ok ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.danger,
          }}
        >
          {tool.ok === null ? "running" : tool.ok ? "exit 0" : "failed"}
        </span>
      </div>
    </div>
  );
}

// ─── Web-action row (web_search / web_fetch) ─────────────────────────────────

function WebRow({ tool }: { tool: ToolUseEntry }) {
  const styles = useThemeStyles();
  return (
    <div
      className="flex items-center gap-2.5 h-8 px-2.5 rounded-[10px]"
      style={{ background: styles.isDark ? "rgba(255,255,255,0.03)" : styles.sidebarBg }}
    >
      <Globe size={11} className="shrink-0" style={{ color: styles.accent }} />
      <span className="min-w-0 flex-1 truncate font-mono text-[11px]" style={{ color: styles.textSecondary }}>
        {tool.argsSummary || tool.toolName}
      </span>
      <span className="shrink-0 w-4 text-center text-[11px]" style={{ color: tool.ok ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.danger }}>
        {tool.ok === null ? "…" : tool.ok ? "✓" : "✗"}
      </span>
    </div>
  );
}

// ─── The block itself ─────────────────────────────────────────────────────────

export function ActivityBlock({
  rounds,
  ts,
  endTs,
  sessionId,
  live = false,
}: {
  rounds: ToolUseEntry[][];
  ts?: string;
  endTs?: string;
  sessionId: string | null;
  live?: boolean;
}) {
  const styles = useThemeStyles();
  const [mode, setMode] = useState<ActivityMode>(readMode);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      /* private mode */
    }
  }, [mode]);

  const totalActions = useMemo(() => rounds.reduce((a, r) => a + r.length, 0), [rounds]);
  const roundCount = rounds.length;
  const elapsed = ts && endTs ? elapsedSeconds(ts, endTs) : 0;

  if (mode === "hidden" && !live) return null;

  const headerLabel = live
    ? "Working…"
    : `Completed ${totalActions} ${totalActions === 1 ? "action" : "actions"}${roundCount > 1 ? ` · ${roundCount} rounds` : ""}`;

  const header = (
    <div
      className="flex items-center gap-2.5 h-10 px-3 cursor-pointer select-none"
      onClick={() => setExpanded((v) => !v)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter") setExpanded((v) => !v);
      }}
      aria-expanded={expanded}
      aria-label={`${headerLabel}${elapsed ? ` · ${elapsed}s` : ""}. ${expanded ? "Collapse" : "Expand"} activity.`}
    >
      {/* Avatar — pulses while live */}
      <span
        className={`w-6 h-6 shrink-0 rounded-[8px] grid place-items-center ${live ? "ac-pulse" : ""}`}
        style={{ background: withAlpha(styles.accent, styles.isDark ? 0.16 : 0.11), color: styles.accent }}
        aria-hidden
      >
        <Sparkles size={12} />
      </span>
      <span className="text-[12px] font-bold truncate" style={{ color: styles.text }}>
        {headerLabel}
      </span>
      {elapsed > 0 && (
        <span
          className="shrink-0 px-1.5 py-0.5 rounded-full font-mono text-[10px]"
          style={{ background: styles.subtle, color: styles.textTertiary }}
        >
          {elapsed}s
        </span>
      )}
      <span className="flex-1" />
      {!live && <ModePopover mode={mode} onMode={setMode} />}
      <motion.span animate={{ rotate: expanded ? 0 : -90 }} transition={{ duration: 0.15 }} className="shrink-0">
        <ChevronDown size={13} style={{ color: styles.textTertiary }} />
      </motion.span>
    </div>
  );

  // Compact mode = header only.
  if (mode === "compact" && !live) {
    return (
      <motion.div
        className="rounded-[16px] border-[1.5px] overflow-hidden"
        style={{ background: styles.card, borderColor: styles.border, boxShadow: styles.softShadow }}
      >
        {header}
      </motion.div>
    );
  }

  return (
    <motion.div
      className="rounded-[16px] border-[1.5px] overflow-hidden"
      style={{ background: styles.card, borderColor: styles.border, boxShadow: styles.softShadow }}
    >
      {header}
      {expanded && (
        <div className="px-3 pb-3">
          {/* Timeline body — one group per round */}
          {rounds.map((round, roundIndex) => {
            const last = roundIndex === rounds.length - 1;
            return (
              <div key={roundIndex} className="relative ml-[11px] pl-4 border-l-2" style={{ borderColor: withAlpha(styles.accent, 0.25) }}>
                {/* ROUND pill */}
                {roundCount > 1 && (
                  <div className="flex items-center h-7">
                    <span
                      className="px-2 py-0.5 rounded-full font-mono text-[9px] font-bold tracking-wide"
                      style={{ background: styles.subtle, color: styles.textTertiary }}
                    >
                      ROUND {roundIndex + 1}
                    </span>
                  </div>
                )}
                {round.map((tool) => {
                  if (DIFF_TOOLS.has(tool.toolName)) {
                    return (
                      <div key={tool.seq} className="py-1">
                        <FileChangeCard tool={tool} sessionId={sessionId} writing={tool.ok === null} />
                      </div>
                    );
                  }
                  if (TERMINAL_TOOLS.has(tool.toolName)) {
                    return (
                      <div key={tool.seq} className="py-1">
                        <TerminalCard tool={tool} />
                      </div>
                    );
                  }
                  if (WEB_TOOLS.has(tool.toolName)) {
                    return (
                      <div key={tool.seq} className="py-0.5">
                        <WebRow tool={tool} />
                      </div>
                    );
                  }
                  return <ToolRow key={tool.seq} tool={tool} />;
                })}
                {/* Between rounds: the planning divider */}
                {!last && (
                  <div className="flex items-center gap-2 h-8">
                    <span className="text-[11px] font-mono" style={{ color: styles.textTertiary }}>
                      planning next round<span className="ac-ellipsis" aria-hidden />
                    </span>
                  </div>
                )}
              </div>
            );
          })}
          {/* Live tail: nothing after the last round yet */}
          {live && rounds.length === 0 && (
            <div className="flex items-center gap-2 h-8 ml-[11px] pl-4 border-l-2" style={{ borderColor: withAlpha(styles.accent, 0.25) }}>
              <span className="text-[11px] font-mono" style={{ color: styles.textTertiary }}>
                starting<span className="ac-ellipsis" aria-hidden />
              </span>
            </div>
          )}
        </div>
      )}
    </motion.div>
  );
}
