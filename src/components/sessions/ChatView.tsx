import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { motion } from "framer-motion";
import { AlertTriangle, RotateCcw, Send, X } from "lucide-react";
import type { UsageRecord } from "shared";
import { type Agent, type ChatEntry, type Session, ApiError, toChatEntries } from "../../lib/api";
import { formatTime } from "../../lib/format";
import { useSendMessage, useSession } from "../../hooks/use-sessions";
import { ease, fadeInUp } from "../../lib/motion";
import { cn } from "../../lib/utils";
import { Button, inputClass } from "../ui/controls";

/**
 * Chat pane for one session: event-log history as bubbles, a composer with
 * synchronous turns, and per-turn error/usage affordances. Mounted keyed by
 * session id so switching sessions resets composer + usage state.
 */
export function ChatView({ session, agent }: { session: Session; agent: Agent | undefined }) {
  const detail = useSession(session.id);
  const send = useSendMessage();

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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2.5 border-b-[1.5px] border-line px-4 py-3">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <Send size={12} />
        </div>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-bold tracking-tight">
            {session.title ?? agentName}
          </div>
          <div className="truncate text-[11px] text-muted">
            {agent ? `${agent.name} · ${agent.model}` : (session.agentId ?? "no agent")}
            {" · "}
            <span>{session.status}</span>
          </div>
        </div>
      </div>

      <div ref={scrollRef} aria-label="Message history" className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex max-w-[720px] flex-col gap-3">
          {detail.isPending ? (
            <div className="flex flex-col gap-3" aria-label="Loading messages">
              {[0, 1].map((i) => (
                <div
                  key={i}
                  className={`h-12 w-2/3 animate-pulse rounded-xl border-[1.5px] border-line bg-hover/50 ${i % 2 ? "self-end" : ""}`}
                />
              ))}
            </div>
          ) : entries.length === 0 && !pendingEcho ? (
            <div className="flex flex-col items-center gap-1.5 py-12 text-center">
              <p className="text-[13px] font-semibold">Empty session</p>
              <p className="text-[11px] text-muted">
                Send the first message to start the turn — {agentName} answers synchronously.
              </p>
            </div>
          ) : (
            <>
              {entries.map((entry) => (
                <Bubble
                  key={entry.seq}
                  entry={entry}
                  agentName={agentName}
                  usage={usageBySeq[entry.seq]}
                />
              ))}
              {pendingEcho ? (
                <Bubble
                  entry={{ seq: -1, role: "user", content: pendingEcho, agentId: null, ts: "" }}
                  agentName={agentName}
                />
              ) : null}
            </>
          )}

          {send.isPending ? (
            <motion.div
              variants={fadeInUp}
              initial="initial"
              animate="animate"
              className="flex items-center gap-2 px-1"
            >
              <span className="flex gap-1" aria-hidden>
                {[0, 1, 2].map((i) => (
                  <motion.span
                    key={i}
                    className="h-1.5 w-1.5 rounded-full bg-muted"
                    animate={{ opacity: [0.25, 1, 0.25] }}
                    transition={{ duration: 1.1, repeat: Infinity, delay: i * 0.18, ease }}
                  />
                ))}
              </span>
              <span className="text-[11px] text-muted">{agentName} is thinking…</span>
            </motion.div>
          ) : null}
        </div>
      </div>

      {send.isError && lastSent ? (
        <div
          role="alert"
          className="mx-4 mb-2 flex shrink-0 items-start gap-2 rounded-lg border-[1.5px] border-red-500/30 bg-red-500/10 px-3 py-2"
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
              <p className="mt-0.5 font-mono text-[10px] break-words text-red-500/70">
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

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void runTurn(draft);
        }}
        className="shrink-0 border-t-[1.5px] border-line px-4 py-3"
      >
        <div className="mx-auto flex w-full max-w-[720px] items-end gap-2">
          <textarea
            aria-label="Message"
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onComposerKeyDown}
            disabled={send.isPending}
            placeholder={
              send.isPending
                ? "Waiting for the reply…"
                : `Message ${agentName}… (Enter to send, Shift+Enter for a newline)`
            }
            className={cn(inputClass, "min-h-[46px] flex-1 resize-none")}
          />
          <Button
            type="submit"
            variant="primary"
            disabled={send.isPending || !draft.trim()}
            aria-label="Send message"
          >
            {send.isPending ? "Sending…" : "Send"}
            <Send size={12} strokeWidth={2.5} />
          </Button>
        </div>
      </form>
    </div>
  );
}

function Bubble({ entry, agentName, usage }: { entry: ChatEntry; agentName: string; usage?: UsageRecord }) {
  const mine = entry.role === "user";
  return (
    <motion.div
      variants={fadeInUp}
      initial="initial"
      animate="animate"
      data-role={entry.role}
      className={cn("flex w-full flex-col", mine ? "items-end" : "items-start")}
    >
      <div
        className={cn(
          "max-w-[85%] rounded-xl border-[1.5px] px-3.5 py-2.5 text-[13px] leading-relaxed break-words whitespace-pre-wrap",
          mine ? "border-accent-faded bg-accent-soft" : "border-line bg-hover",
        )}
      >
        {entry.content}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 px-1 text-[10px] text-muted">
        <span>{mine ? "you" : agentName}</span>
        <span aria-hidden>·</span>
        <span>{formatTime(entry.ts)}</span>
        {usage ? (
          <span className="whitespace-nowrap" title="Tokens in → out for this turn">
            · {usage.inputTokens} → {usage.outputTokens} tok
          </span>
        ) : null}
      </div>
    </motion.div>
  );
}
