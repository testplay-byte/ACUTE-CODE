import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { AlertTriangle, Database, GitFork, MessagesSquare, Plus, Search, X } from "lucide-react";
import type { SessionStatus } from "shared";
import { ApiError } from "../../lib/api";
import { useConfigStore } from "../../lib/config-store";
import { useAgents } from "../../hooks/use-agents";
import { pushLocalToast } from "../../hooks/use-notifications";
import {
  useCreateSession,
  useForkSession,
  useSessionSearch,
  useSessions,
} from "../../hooks/use-sessions";
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
 * ROUND-45 (R45-c): the search input, extracted so the top bar (desktop) and
 * the full-width mobile row below it share the exact same component logic.
 * Both instances bind the SAME state — typing in either drives the one
 * debounced query (useSessionSearch in SessionsScreen).
 */
function SessionSearchInput({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  className?: string;
}) {
  return (
    <div className={cn("relative w-full", className)}>
      <Search
        size={12}
        aria-hidden
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
      />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search sessions"
        aria-label="Search sessions"
        className="h-8 w-full rounded-lg border-[1.5px] border-line bg-card pl-7 pr-7 text-[12px] font-medium text-ink outline-none transition-colors placeholder:text-muted focus:border-accent-faded"
      />
      {value !== "" ? (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          title="Clear search"
          className="absolute right-1.5 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded-md text-muted transition-colors hover:bg-hover hover:text-ink"
        >
          <X size={11} />
        </button>
      ) : null}
    </div>
  );
}

/**
 * Sessions screen (SPEC F3, single-agent Phase 2): session list on the left,
 * chat on the right. Below `md` the list degrades to a horizontal strip above
 * the chat so narrow windows stay usable.
 *
 * ROUND-44 (R44-c, owner directive: "complete the whole agentic coding
 * environment" — search/fork/revert were audited as missing): the header
 * carries a debounced (300 ms) search box over session titles + event text
 * (GET /sessions?q=), and every row grows a hover "Fork" action that copies
 * the whole conversation under a new top-level session. (Revert lives in the
 * chat panel — AgentChatPanel — next to the message it rewinds to.)
 *
 * ROUND-45 (R45-c, the R44-c mobile deferral): on phones the 170px top-bar
 * input truncated typed queries, so the search now ALSO has a full-width row
 * directly under the top bar (the top-bar input stays for md+), and while a
 * search is active the horizontal session rail is replaced by a vertical
 * results list (desktop semantics — horizontal scrolling through filtered
 * results was confusing). Clearing the search restores the rail.
 */
export function SessionsScreen() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const demoData = useConfigStore((s) => s.demoData);
  const setDemoData = useConfigStore((s) => s.setDemoData);

  const sessionsQuery = useSessions();
  const agentsQuery = useAgents(false); // sessions bind real agents, not templates
  const createSession = useCreateSession();
  const forkSession = useForkSession();

  // ── ROUND-44 (R44-c): debounced search. The input updates instantly; the
  // query term lands 300 ms later so typing "acceptance" fires ONE request,
  // not one per keystroke. An empty term returns the normal list.
  const [searchInput, setSearchInput] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSearchTerm(searchInput), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);
  const searching = searchTerm.trim().length > 0;
  const searchQuery = useSessionSearch(searchTerm);

  const sessions = sessionsQuery.data ?? [];
  // The sidebar renders search RESULTS while searching; selection + the chat
  // pane keep working off the unfiltered list (search never switches the
  // open conversation).
  const visibleSessions = searching ? (searchQuery.data ?? []) : sessions;
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
          {/* ROUND-44 (R44-c): search box — titles + event text (GET /sessions?q=).
              ROUND-45 (R45-c): md+ only — on phones the search moved to a
              full-width row under this bar (the 170px input truncated typed
              queries). */}
          <div className="hidden md:block">
            <SessionSearchInput value={searchInput} onChange={setSearchInput} className="w-[200px]" />
          </div>
          <Button variant="primary" onClick={() => setPickerOpen(true)}>
            <Plus size={13} strokeWidth={2.5} />
            New session
          </Button>
        </div>
      </motion.div>

      {/* ROUND-45 (R45-c): full-width mobile search row — same input logic as
          the top bar, responsive placement. */}
      <div role="search" aria-label="Session search" className="border-b-[1.5px] border-line px-4 py-2 md:hidden">
        <SessionSearchInput value={searchInput} onChange={setSearchInput} />
      </div>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside
          aria-label="Session list"
          data-searching={searching ? "true" : "false"}
          className={cn(
            "flex shrink-0 gap-1.5 border-b-[1.5px] border-line p-2 md:w-[250px] md:flex-col md:overflow-x-visible md:overflow-y-auto md:border-b-0 md:border-r-[1.5px]",
            // ROUND-45 (R45-c): while a search is active the mobile rail
            // becomes a vertical results list (capped so a long hit list
            // can't squeeze the chat pane off-screen).
            searching
              ? "flex-col overflow-x-visible overflow-y-auto max-md:max-h-[60vh]"
              : "overflow-x-auto",
          )}
        >
          {/* ROUND-44 (R44-c): subtle search-meta line — result count for the
              active term + a one-click clear back to the normal list. */}
          {searching ? (
            <div className="flex w-full shrink-0 items-center gap-1.5 px-1 pb-1 text-[10.5px] font-semibold text-muted md:w-auto">
              <span className="min-w-0 truncate">
                {searchQuery.isPending
                  ? `Searching for “${searchTerm.trim()}”…`
                  : `${visibleSessions.length} result${visibleSessions.length === 1 ? "" : "s"} for “${searchTerm.trim()}”`}
              </span>
              <button
                type="button"
                onClick={() => setSearchInput("")}
                aria-label="Clear search"
                title="Clear search"
                className="grid h-5 w-5 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-hover hover:text-ink"
              >
                <X size={11} />
              </button>
            </div>
          ) : null}
          {sessionsQuery.isPending || (searching && searchQuery.isPending) ? (
            <div className="flex w-full flex-col gap-1.5" aria-label="Loading sessions">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-[54px] w-full shrink-0 animate-pulse rounded-lg bg-hover/50 md:h-[58px]" />
              ))}
            </div>
          ) : searching && searchQuery.isError ? (
            <div className="flex w-full flex-col items-center gap-3 px-3 py-10 text-center">
              <AlertTriangle size={20} className="text-red-500" />
              <div>
                <p className="text-[13px] font-semibold">Search failed</p>
                <p className="mt-1 text-[11px] text-muted">
                  {searchQuery.error instanceof ApiError
                    ? searchQuery.error.message
                    : (searchQuery.error as Error)?.message ?? "Unknown error"}
                </p>
              </div>
              <Button variant="outline" onClick={() => searchQuery.refetch()}>
                Retry
              </Button>
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
          ) : searching && visibleSessions.length === 0 ? (
            <div className="flex w-full flex-col items-center gap-2 px-3 py-10 text-center">
              <Search size={18} className="text-muted" aria-hidden />
              <p className="text-[13px] font-semibold">No sessions match “{searchTerm.trim()}”</p>
              <p className="text-[11px] text-muted">Titles and message text are both searched.</p>
            </div>
          ) : visibleSessions.length === 0 ? (
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
              className={cn("flex gap-1.5 md:flex md:flex-col", searching && "w-full flex-col")}
            >
              {visibleSessions.map((session) => {
                const agent = agentById.get(session.agentId ?? "");
                const label = session.title ?? agent?.name ?? "Untitled session";
                const active = session.id === selectedId;
                return (
                  // ROUND-44 (R44-c): the row is now a relative WRAPPER so the
                  // Fork action can sit as a hover-revealed SIBLING of the
                  // selectable button (a <button> cannot nest another button).
                  <motion.div
                    key={session.id}
                    variants={staggerItem}
                    className={cn(
                      "group/row relative flex shrink-0 md:min-w-0 md:w-full",
                      // ROUND-45 (R45-c): full-width rows while the mobile
                      // search results render as a vertical list.
                      searching ? "w-full min-w-0" : "min-w-[200px]",
                    )}
                  >
                    <motion.button
                      onClick={() => setSelectedId(session.id)}
                      aria-pressed={active}
                      aria-label={`Open session ${label}`}
                      className={cn(
                        "flex w-full cursor-pointer flex-col items-start gap-1 rounded-lg border-[1.5px] py-2.5 pl-3 pr-12 text-left transition-colors duration-200",
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
                    {/* ROUND-44 (R44-c): Fork — copies the session + its full
                        event log under a new top-level session. Visible on row
                        hover (always on touch, where hover doesn't exist). */}
                    <button
                      type="button"
                      onClick={() => {
                        forkSession.mutate(session.id, {
                          onSuccess: (fork) => {
                            pushLocalToast(`Forked: ${label}`, fork.title ?? undefined);
                          },
                          onError: (err) => {
                            pushLocalToast(
                              "Fork failed",
                              err instanceof Error ? err.message : String(err),
                              "task_failed",
                            );
                          },
                        });
                      }}
                      disabled={forkSession.isPending}
                      aria-label={`Fork session ${label}`}
                      title="Fork this session (copy the full conversation)"
                      className="absolute right-1.5 top-1.5 z-10 flex h-6 items-center gap-1 rounded-md border-[1.5px] border-line bg-card px-1.5 text-[10px] font-bold text-muted shadow-sm transition-all duration-150 hover:border-accent-faded hover:bg-accent-soft hover:text-accent focus-visible:opacity-100 group-hover/row:opacity-100 max-md:opacity-100 md:opacity-0"
                    >
                      <GitFork size={11} aria-hidden />
                      Fork
                    </button>
                  </motion.div>
                );
              })}
            </motion.div>
          )}
        </aside>

        <section aria-label="Chat" className="min-h-0 min-w-0 flex-1 p-1.5 md:p-2">
          {selected ? (
            <ChatView
              key={selected.id}
              session={selected}
              agent={agentById.get(selected.agentId ?? "")}
            />
          ) : (
            <div
              className="flex h-full flex-col items-center justify-center gap-3 rounded-2xl border-[1.5px] text-center"
              style={{ borderColor: "var(--ac-border)", backgroundColor: "var(--ac-card)" }}
            >
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
