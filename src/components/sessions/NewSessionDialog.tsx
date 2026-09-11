import { Link } from "react-router";
import { Bot, MessagesSquare } from "lucide-react";
import type { Agent } from "../../lib/api";
import { Dialog, DialogContent, DialogHeader } from "../ui/dialog";
import { Badge } from "../ui/controls";

/**
 * Agent picker for "New session" (single-agent Phase 2 scope — the mode is
 * fixed to "single"). Picking an agent creates the session immediately; with
 * no non-template agents the dialog links to the Agents screen instead.
 */
export function NewSessionDialog({
  agents,
  open,
  onOpenChange,
  onCreate,
  creating,
}: {
  /** Non-template agents from the registry; sessions bind real agents only. */
  agents: Agent[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (agentId: string) => void;
  creating?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(460px,92vw)]" aria-describedby={undefined}>
        <DialogHeader
          title="New session"
          description="Pick an agent to start a single-agent session (team modes arrive in a later wave)."
        />
        {agents.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-5 py-8 text-center">
            <Bot size={20} className="text-muted" />
            <div>
              <p className="text-[13px] font-semibold">No agents yet</p>
              <p className="mt-1 max-w-[300px] text-[11px] text-muted">
                Sessions run against an agent from the registry. Create one first — templates get
                you started in seconds.
              </p>
            </div>
            <Link
              to="/agents"
              onClick={() => onOpenChange(false)}
              className="rounded-lg border-[1.5px] border-line bg-card px-3 py-2 text-xs font-semibold text-ink transition-colors hover:bg-hover"
            >
              Go to Agents
            </Link>
          </div>
        ) : (
          <div className="flex max-h-[50vh] flex-col gap-1.5 overflow-y-auto px-4 py-3.5">
            {agents.map((agent) => (
              <button
                key={agent.id}
                onClick={() => onCreate(agent.id)}
                disabled={creating}
                aria-label={`Start session with ${agent.name}`}
                className="group flex cursor-pointer items-center gap-3 rounded-lg border-[1.5px] border-line bg-card px-3 py-2.5 text-left transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                  <MessagesSquare size={13} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-bold tracking-tight">{agent.name}</span>
                    <Badge>{agent.role}</Badge>
                  </div>
                  {/* ROUND-92 (R92-C): null-safe display — an unconfigured
                      agent (R91-A's reset state / a fresh template) gets the
                      honest pick-in-chat note, not a dangling " · ". */}
                  <div className="mt-0.5 truncate font-mono text-[11px] text-muted">
                    {agent.providerId !== null && agent.model !== null
                      ? `${agent.providerId} · ${agent.model}`
                      : "not configured — pick the model in chat"}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
