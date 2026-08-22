import { useState } from "react";
import { motion } from "framer-motion";
import { AlertTriangle, Database, Plus } from "lucide-react";
import { ApiError } from "../../lib/api";
import { useConfigStore } from "../../lib/config-store";
import {
  useAgents,
  useCreateAgent,
  useDeleteAgent,
  useDuplicateAgent,
  useUpdateAgent,
} from "../../hooks/use-agents";
import { fadeInUp, staggerContainer } from "../../lib/motion";
import { cn } from "../../lib/utils";
import { Button } from "../ui/controls";
import { AgentCard } from "./AgentCard";
import { AgentFormDialog } from "./AgentFormDialog";
import { ConfirmDialog } from "./ConfirmDialog";

/** Template filter; "templates" is a client-side view over the full list. */
type Filter = "all" | "mine" | "templates";

const FILTERS: { id: Filter; label: string; includeTemplates: boolean }[] = [
  { id: "all", label: "All", includeTemplates: true },
  { id: "mine", label: "My agents", includeTemplates: false },
  { id: "templates", label: "Templates", includeTemplates: true },
];

export function AgentsScreen() {
  const [filter, setFilter] = useState<Filter>("all");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const cfg = FILTERS.find((f) => f.id === filter) ?? FILTERS[0];
  const demoData = useConfigStore((s) => s.demoData);
  const setDemoData = useConfigStore((s) => s.setDemoData);

  const query = useAgents(cfg.includeTemplates);
  const createAgent = useCreateAgent();
  const updateAgent = useUpdateAgent();
  const deleteAgent = useDeleteAgent();
  const duplicateAgent = useDuplicateAgent();

  const agents = (query.data ?? []).filter((a) => filter !== "templates" || a.isTemplate);
  const editingAgent = query.data?.find((a) => a.id === editing) ?? null;
  const deletingAgent = query.data?.find((a) => a.id === deleting) ?? null;
  const mutationBusy =
    createAgent.isPending || updateAgent.isPending || deleteAgent.isPending || duplicateAgent.isPending;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <motion.div
        variants={fadeInUp}
        initial="initial"
        animate="animate"
        className="flex flex-wrap items-center gap-3 border-b-[1.5px] border-line px-5 py-3.5"
      >
        <div>
          <h1 className="text-[15px] font-bold tracking-tight">Agents</h1>
          <p className="mt-0.5 text-[11px] text-muted">
            {query.data ? `${query.data.length} in registry` : "agent registry (SPEC F2)"}
            {demoData ? " · demo data" : ""}
          </p>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-0.5 rounded-lg bg-hover p-0.5" role="group" aria-label="Template filter">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                aria-pressed={filter === f.id}
                className={cn(
                  "cursor-pointer rounded-md px-2.5 py-1.5 text-[11px] font-semibold transition-all duration-200",
                  filter === f.id
                    ? "border-[1.5px] border-accent-faded bg-card text-accent"
                    : "border-[1.5px] border-transparent text-muted hover:text-ink",
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
          <Button
            variant="primary"
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            <Plus size={13} strokeWidth={2.5} />
            New agent
          </Button>
        </div>
      </motion.div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {query.isPending ? (
          <div className="flex flex-col gap-2" aria-label="Loading agents">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-[86px] animate-pulse rounded-lg border-[1.5px] border-line bg-hover/50" />
            ))}
          </div>
        ) : query.isError ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <AlertTriangle size={20} className="text-red-500" />
            <div>
              <p className="text-[13px] font-semibold">Could not load agents</p>
              <p className="mt-1 max-w-sm text-[11px] text-muted">
                {query.error instanceof ApiError
                  ? query.error.message
                  : (query.error as Error)?.message ?? "Unknown error"}
              </p>
            </div>
            {!demoData && query.error instanceof ApiError && query.error.isNetwork ? (
              <Button variant="outline" onClick={() => setDemoData(true)}>
                <Database size={13} />
                Use demo data
              </Button>
            ) : (
              <Button variant="outline" onClick={() => query.refetch()}>
                Retry
              </Button>
            )}
          </div>
        ) : agents.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <p className="text-[13px] font-semibold">No agents here yet</p>
            <p className="text-[11px] text-muted">
              Create one from scratch, or duplicate a template from the “Templates” filter.
            </p>
          </div>
        ) : (
          <motion.div
            variants={staggerContainer}
            initial="initial"
            animate="animate"
            className="flex flex-col gap-2"
          >
            {agents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                busy={mutationBusy}
                onEdit={() => {
                  setEditing(agent.id);
                  setFormOpen(true);
                }}
                onDuplicate={() => duplicateAgent.mutate({ id: agent.id })}
                onDelete={() => setDeleting(agent.id)}
              />
            ))}
          </motion.div>
        )}
      </div>

      <AgentFormDialog
        agent={editingAgent}
        open={formOpen}
        onOpenChange={setFormOpen}
        onSubmit={async (draft) => {
          if (editingAgent) await updateAgent.mutateAsync({ id: editingAgent.id, patch: draft });
          else await createAgent.mutateAsync(draft);
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={`Delete ${deletingAgent?.name ?? ""}?`}
        body="The agent definition is removed from the registry. Agents referenced by a running session cannot be deleted."
        onConfirm={async () => {
          if (deleting) await deleteAgent.mutateAsync(deleting).catch(() => undefined);
          setDeleting(null);
        }}
      />
    </div>
  );
}
