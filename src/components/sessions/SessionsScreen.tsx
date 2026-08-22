import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { AlertTriangle, Database, MessagesSquare, Plus } from "lucide-react";
import type { SessionStatus } from "shared";
import { ApiError } from "../../lib/api";
import { useConfigStore } from "../../lib/config-store";
import { useAgents } from "../../hooks/use-agents";
import { useCreateSession, useSessions } from "../../hooks/use-sessions";
import { formatWhen } from "../../lib/format";
import { fadeInUp, staggerContainer, staggerItem } from "../../lib/motion";
import { cn } from "../../lib/utils";
import { Button } from "../ui/controls";
import { ChatView } from "./ChatView";
import { NewSessionDialog } from "./NewSessionDialog";

const STATUS_DOT: Record<SessionStatus, string> = {
  running: "bg-accent animate-pulse",
  queued: "bg-muted/60",
  completed: "bg-muted/60",
  failed: "bg-red-500",
  cancelled: "bg-muted/60",
};

/**
 * Sessions screen (SPEC F3, single-agent Phase 2): session list on the left,
 * chat on the right. Below `md` the list degrades to a horizontal strip above
 * the chat so narrow windows stay usable.
 */
export function SessionsScreen() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const demoData = useConfigStore((s) => s.demoData);
  const setDemoData = useConfigStore((s) => s.setDemoData);

  const sessionsQuery = useSessions();
  const agentsQuery = useAgents(false); // sessions bind real agents, not templates
  const createSession = useCreateSession();

  const sessions = sessionsQuery.data ?? [];
  const agentById = new Map((agentsQuery.data ?? []).map((a) => [a.id, a]));

  // Follow the newest session until the user picks one.
  useEffect(() => {
    if (selectedId === null && sessions.length > 0) setSelectedId(sessions[0].id);
  }, [sessions, selectedId]);

  const selected = sessions.find((s) => s.id === selectedId) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <motion.div
        variants={fadeInUp}
        initial="initial"
        animate="animate"
        className="flex flex-wrap items-center gap-3 border-b-[1.5px] border-line px-5 py-3.5"
      >
        <div>
          <h1 className="text-[15px] font-bold tracking-tight">Sessions</h1>
          <p className="mt-0.5 text-[11px] text-muted">
            {sessionsQuery.data
              ? `${sessionsQuery.data.length} recent · single-agent mode`
              : "session list + chat (SPEC F3)"}
            {demoData ? " · demo data" : ""}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="primary" onClick={() => setPickerOpen(true)}>
            <Plus size={13} strokeWidth={2.5} />
            New session
          </Button>
        </div>
      </motion.div>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside
          aria-label="Session list"
          className="flex shrink-0 gap-1.5 overflow-x-auto border-b-[1.5px] border-line p-2 md:w-[250px] md:flex-col md:overflow-x-visible md:overflow-y-auto md:border-b-0 md:border-r-[1.5px]"
        >
          {sessionsQuery.isPending ? (
            <div className="flex w-full flex-col gap-1.5" aria-label="Loading sessions">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-[54px] w-full shrink-0 animate-pulse rounded-lg bg-hover/50 md:h-[58px]" />
              ))}
            </div>
          ) : sessionsQuery.isError ? (
            <div className="flex w-full flex-col items-center gap-3 px-3 py-10 text-center">
              <AlertTriangle size={20} className="text-red-500" />
              <div>
                <p className="text-[13px] font-semibold">Could not load sessions</p>
                <p className="mt-1 text-[11px] text-muted">
                  {sessionsQuery.error instanceof ApiError
                    ? sessionsQuery.error.message
                    : (sessionsQuery.error as Error)?.message ?? "Unknown error"}
                </p>
              </div>
              {!demoData && sessionsQuery.error instanceof ApiError && sessionsQuery.error.isNetwork ? (
                <Button variant="outline" onClick={() => setDemoData(true)}>
                  <Database size={13} />
                  Use demo data
                </Button>
              ) : (
                <Button variant="outline" onClick={() => sessionsQuery.refetch()}>
                  Retry
                </Button>
              )}
            </div>
          ) : sessions.length === 0 ? (
            <div className="flex w-full flex-col items-center gap-2 px-3 py-10 text-center">
              <p className="text-[13px] font-semibold">No sessions yet</p>
              <p className="text-[11px] text-muted">
                Start one with “New session” — it runs a single agent from the registry.
              </p>
            </div>
          ) : (
            <motion.div
              variants={staggerContainer}
              initial="initial"
              animate="animate"
              className="flex gap-1.5 md:flex md:flex-col"
            >
              {sessions.map((session) => {
                const agent = agentById.get(session.agentId ?? "");
                const label = session.title ?? agent?.name ?? "Untitled session";
                const active = session.id === selectedId;
                return (
                  <motion.button
                    key={session.id}
                    variants={staggerItem}
                    onClick={() => setSelectedId(session.id)}
                    aria-pressed={active}
                    aria-label={`Open session ${label}`}
                    className={cn(
                      "flex min-w-[200px] shrink-0 cursor-pointer flex-col items-start gap-1 rounded-lg border-[1.5px] px-3 py-2.5 text-left transition-colors duration-200 md:min-w-0 md:w-full",
                      active
                        ? "border-accent-faded bg-accent-soft"
                        : "border-transparent hover:bg-hover",
                    )}
                  >
                    <span
                      className={cn(
                        "max-w-full truncate text-[12px] font-bold tracking-tight",
                        active ? "text-accent" : "text-ink",
                      )}
                    >
                      {label}
                    </span>
                    <span className="flex w-full items-center gap-1.5 text-[10px] text-muted">
                      <span
                        aria-hidden
                        className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATUS_DOT[session.status])}
                        title={session.status}
                      />
                      <span className="truncate">{agent?.name ?? session.agentId ?? "no agent"}</span>
                      <span aria-hidden>·</span>
                      <span className="shrink-0 whitespace-nowrap">{formatWhen(session.updatedAt)}</span>
                    </span>
                  </motion.button>
                );
              })}
            </motion.div>
          )}
        </aside>

        <section aria-label="Chat" className="min-h-0 min-w-0 flex-1">
          {selected ? (
            <ChatView
              key={selected.id}
              session={selected}
              agent={agentById.get(selected.agentId ?? "")}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <MessagesSquare size={22} className="text-muted" />
              <div>
                <p className="text-[13px] font-semibold">No session selected</p>
                <p className="mt-1 max-w-xs text-[11px] text-muted">
                  Pick a session from the list, or start a new one to chat with an agent.
                </p>
              </div>
            </div>
          )}
        </section>
      </div>

      <NewSessionDialog
        agents={agentsQuery.data ?? []}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        creating={createSession.isPending}
        onCreate={(agentId) => {
          void createSession.mutate(
            { agentId, mode: "single" },
            {
              onSuccess: (session) => {
                setSelectedId(session.id);
                setPickerOpen(false);
              },
            },
          );
        }}
      />
    </div>
  );
}
