import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { motion } from "framer-motion";
import { AlertTriangle, ArrowUp, Bot, RotateCcw, X } from "lucide-react";
import type { UsageRecord } from "shared";
import { type Agent, type ChatEntry, type Session, ApiError, toChatEntries } from "../../lib/api";
import { formatTime } from "../../lib/format";
import { useSendMessage, useSession } from "../../hooks/use-sessions";
import { ease, fadeInUp } from "../../lib/motion";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { cn } from "../../lib/utils";
import { Button } from "../ui/controls";

/**
 * Chat pane for one session: event-log history as bubbles, a composer with
 * synchronous turns, and per-turn error/usage affordances. Mounted keyed by
 * session id so switching sessions resets composer + usage state.
 *
 * Visual layer follows the project-chat demo (AgentChatPanel.tsx): a
 * rounded-2xl bordered panel, user bubbles right with a squared bottom-right
 * corner, assistant bubbles as bordered cards left, w-7 h-7 avatar chips,
 * mono chips for model/token info, thinking dots, and a pill composer with an
 * arrow-up send affordance. All data logic (event log, optimistic echo,
 * retry/error banner) is unchanged.
 */
export function ChatView({ session, agent }: { session: Session; agent: Agent | undefined }) {
  const detail = useSession(session.id);
  const send = useSendMessage();
  const styles = useThemeStyles();

  const [draft, setDraft] = useState("");
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [lastSent, setLastSent] = useState<string | null>(null);
  /** Usage lines keyed by the assistant event seq from each turn's response. */
  const [usageBySeq, setUsageBySeq] = useState<Record<number, UsageRecord>>({});

  const entries = useMemo(() => toChatEntries(detail.data?.events ?? []), [detail.data]);
  const agentName = agent?.name ?? "Agent";

  // The optimistic user bubble lives only until the refetched log contains it.
  const pendingEcho =
    pendingUser !== null && !entries.some((e) => e.role === "user" && e.content === pendingUser)
      ? pendingUser
      : null;

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries.length, pendingEcho, send.isPending]);

  const runTurn = async (content: string) => {
    if (!content.trim() || send.isPending) return;
    setDraft("");
    setPendingUser(content);
    setLastSent(content);
    try {
      const result = await send.mutateAsync({ sessionId: session.id, content });
      setUsageBySeq((prev) => ({ ...prev, [result.assistantMessage.seq]: result.usage }));
    } catch {
      // The error banner keeps the content for Retry; pendingUser stays — a
      // failed provider call still persists the user event (ADR-0010), so the
      // refetched log replaces the optimistic bubble.
    }
  };

  const onComposerKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void runTurn(draft);
    }
  };

  const err = send.error;
  const providerDetail =
    err instanceof ApiError && typeof err.details?.providerError === "string"
      ? err.details.providerError
      : null;

  const canSend = !send.isPending && draft.trim().length > 0;

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border-[1.5px]"
      style={{ backgroundColor: styles.card, borderColor: styles.border }}
    >
      {/* Panel header: avatar tile · name · mono model chip · status chip */}
      <div
        className="flex shrink-0 items-center gap-2.5 px-3 py-2.5"
        style={{ borderBottom: `1.5px solid ${styles.border}` }}
      >
        <div
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg"
          style={{ backgroundColor: styles.accent, color: styles.accentText }}
        >
          <Bot size={13} />
        </div>
        <span className="truncate text-[13px] font-semibold" style={{ color: styles.text }}>
          {session.title ?? agentName}
        </span>
        {agent ? (
          <span
            className="shrink-0 rounded-lg border px-1.5 py-0.5 font-mono text-[10px]"
            style={{
              backgroundColor: styles.inputBg,
              borderColor: styles.border,
              color: styles.textSecondary,
            }}
          >
            {agent.model}
          </span>
        ) : null}
        <span
          className="ml-auto shrink-0 rounded-lg px-1.5 py-0.5 font-mono text-[10px]"
          style={
            session.status === "failed"
              ? { color: "#ef4444", backgroundColor: "#ef44441a" }
              : session.status === "running"
                ? { color: "#22c55e", backgroundColor: "#22c55e14" }
                : { color: styles.textSecondary, backgroundColor: styles.inputBg }
          }
        >
          {session.status}
        </span>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div ref={scrollRef} aria-label="Message history" className="absolute inset-0 overflow-y-auto px-4 py-4">
          <div className="flex flex-col gap-3">
            {detail.isPending ? (
              <div className="flex flex-col gap-3" aria-label="Loading messages">
                {[0, 1].map((i) => (
                  <motion.div
                    key={i}
                    variants={fadeInUp}
                    initial="initial"
                    animate="animate"
                    className={cn("h-12 w-2/3 animate-pulse rounded-2xl", i % 2 ? "self-end" : "")}
                    style={{ backgroundColor: styles.subtle, border: `1.5px solid ${styles.border}` }}
                  />
                ))}
              </div>
            ) : entries.length === 0 && !pendingEcho ? (
              <div className="flex items-center gap-3 py-8">
                <div
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border-[1.5px]"
                  style={{ borderColor: styles.border, backgroundColor: styles.inputBg }}
                >
                  <Bot size={16} style={{ color: styles.accent }} />
                </div>
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold" style={{ color: styles.text }}>
                    Empty session
                  </p>
                  <p className="font-mono text-[11px]" style={{ color: styles.textSecondary }}>
                    Send the first message to start the turn — {agentName} answers synchronously.
                  </p>
                </div>
              </div>
            ) : (
              <>
                {entries.map((entry) => (
                  <Bubble
                    key={entry.seq}
                    entry={entry}
                    agentName={agentName}
                    usage={usageBySeq[entry.seq]}
                    styles={styles}
                  />
                ))}
                {pendingEcho ? (
                  <Bubble
                    entry={{ seq: -1, role: "user", content: pendingEcho, agentId: null, ts: "" }}
                    agentName={agentName}
                    styles={styles}
                  />
                ) : null}
              </>
            )}

            {send.isPending ? (
              <ThinkingRow agentName={agentName} model={agent?.model} styles={styles} />
            ) : null}
          </div>
        </div>
      </div>

      {send.isError && lastSent ? (
        <div
          role="alert"
          className="mx-3 mb-2 flex shrink-0 items-start gap-2 rounded-xl border-[1.5px] border-red-500/30 bg-red-500/10 px-3 py-2"
        >
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-red-500" />
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-semibold text-red-500">
              {err instanceof ApiError ? err.code : "ERROR"} — message failed
            </p>
            <p className="mt-0.5 text-[11px] text-red-500/90">
              {err instanceof Error ? err.message : String(err)}
            </p>
            {providerDetail ? (
              <p className="mt-0.5 break-words font-mono text-[10px] text-red-500/70">
                {providerDetail}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button onClick={() => void runTurn(lastSent)}>
              <RotateCcw size={12} />
              Retry
            </Button>
            <button
              aria-label="Dismiss error"
              onClick={() => send.reset()}
              className="cursor-pointer rounded-md p-1.5 text-red-500/70 transition-colors hover:bg-red-500/10 hover:text-red-500"
            >
              <X size={12} />
            </button>
          </div>
        </div>
      ) : null}

      {/* Composer: pill strip on the page background, arrow-up send affordance */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void runTurn(draft);
        }}
        className="shrink-0 p-3"
      >
        <div
          className="flex items-end gap-2 rounded-2xl border-[1.5px] p-1.5"
          style={{ backgroundColor: styles.inputBg, borderColor: styles.border }}
        >
          <textarea
            aria-label="Message"
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onComposerKeyDown}
            disabled={send.isPending}
            placeholder={
              send.isPending
                ? "Waiting for the reply…"
                : `Ask ${agentName} to build, explain, test…`
            }
            className="max-h-32 min-h-[34px] flex-1 resize-none bg-transparent px-2 py-1.5 text-[13px] outline-none placeholder:text-muted/70"
            style={{ color: styles.text }}
          />
          <button
            type="submit"
            disabled={!canSend}
            aria-label="Send message"
            className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-xl transition-all duration-200 enabled:hover:scale-105 enabled:active:scale-95 disabled:cursor-not-allowed"
            style={{
              backgroundColor: canSend ? styles.accent : styles.inputBg,
              color: canSend ? styles.accentText : styles.textSecondary,
              border: `1px solid ${canSend ? styles.accent : styles.border}`,
              opacity: canSend ? 1 : 0.6,
            }}
          >
            {send.isPending ? (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />
            ) : (
              <ArrowUp size={14} strokeWidth={2.5} />
            )}
          </button>
        </div>
        <div className="mt-1.5 flex items-center justify-between px-1">
          <span className="font-mono text-[10px]" style={{ color: styles.textSecondary }}>
            Enter to send · Shift+Enter for a newline
          </span>
          <span className="font-mono text-[10px]" style={{ color: styles.textSecondary }}>
            {agent ? agent.model : "no agent"}
          </span>
        </div>
      </form>
    </div>
  );
}

/** Assistant-in-flight indicator: avatar chip + name/model chips + dots (demo AgentThinking). */
function ThinkingRow({
  agentName,
  model,
  styles,
}: {
  agentName: string;
  model?: string;
  styles: ReturnType<typeof useThemeStyles>;
}) {
  return (
    <motion.div
      variants={fadeInUp}
      initial="initial"
      animate="animate"
      exit={{ opacity: 0, y: -8, transition: { duration: 0.2, ease } }}
      className="flex items-center gap-3 px-1 py-1"
      aria-label={`${agentName} is thinking`}
    >
      <div
        className="grid h-7 w-7 shrink-0 place-items-center rounded-xl border-[1.5px]"
        style={{ borderColor: styles.border, backgroundColor: styles.inputBg }}
      >
        <Bot size={13} style={{ color: styles.accent }} />
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-[13px] font-semibold" style={{ color: styles.text }}>
          {agentName}
        </span>
        {model ? (
          <span
            className="rounded-lg border px-1.5 py-0.5 font-mono text-[10px]"
            style={{
              backgroundColor: styles.inputBg,
              borderColor: styles.border,
              color: styles.textSecondary,
            }}
          >
            {model}
          </span>
        ) : null}
      </div>
      <div className="ml-auto flex items-center gap-1" aria-hidden>
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="h-1 w-1 rounded-full"
            style={{ backgroundColor: styles.textSecondary }}
            animate={{ opacity: [0.25, 1, 0.25] }}
            transition={{ duration: 1.1, repeat: Infinity, delay: i * 0.15, ease }}
          />
        ))}
      </div>
    </motion.div>
  );
}

function Bubble({
  entry,
  agentName,
  usage,
  styles,
}: {
  entry: ChatEntry;
  agentName: string;
  usage?: UsageRecord;
  styles: ReturnType<typeof useThemeStyles>;
}) {
  const mine = entry.role === "user";
  return (
    <motion.div
      variants={fadeInUp}
      initial="initial"
      animate="animate"
      data-role={entry.role}
      className={cn("flex w-full flex-col", mine ? "items-end" : "items-start")}
    >
      {/* Bubble anatomy from AgentChatPanel: user right rounded-br-md on accent,
          assistant left as a bordered card. */}
      <div
        className={cn(
          "max-w-[85%] whitespace-pre-wrap break-words px-3.5 py-2.5 text-[13px]",
          mine ? "rounded-2xl rounded-br-md" : "rounded-2xl border-[1.5px] leading-[1.6]",
        )}
        style={
          mine
            ? { backgroundColor: styles.accent, color: styles.accentText, lineHeight: 1.5 }
            : { backgroundColor: styles.card, borderColor: styles.border, color: styles.text }
        }
      >
        {entry.content}
      </div>
      <div
        className="mt-1 flex flex-wrap items-center gap-1.5 px-1 font-mono text-[10px]"
        style={{ color: styles.textSecondary }}
      >
        <span>{mine ? "you" : agentName}</span>
        <span aria-hidden>·</span>
        <span>{formatTime(entry.ts)}</span>
        {usage ? (
          <span
            className="whitespace-nowrap rounded-lg border px-1.5 py-px"
            title="Tokens in → out per model call"
            style={{ borderColor: styles.border, backgroundColor: styles.inputBg }}
          >
            {usage.inputTokens} → {usage.outputTokens} tok
          </span>
        ) : null}
      </div>
    </motion.div>
  );
}
