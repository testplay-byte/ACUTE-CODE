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

export function AgentsScreen({ embedded = false }: { embedded?: boolean }) {
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
    <div className={embedded ? "flex h-full min-h-0 flex-col" : "flex h-full min-h-0 flex-col"}>
      {/* R113-d (owner: the page headers are "unnecessary, unneeded, and not
          required"): the h1 "Agents" + registry-count subtitle row is DELETED
          — the settings tab (?tab=agents) already identifies the screen. The
          FUNCTIONAL controls that shared the row (the template filter + New
          agent) survive as the toolbar; the row keeps its branch padding so
          the embedded spacing rhythm is unchanged. */}
      <motion.div
        variants={fadeInUp}
        initial="initial"
        animate="animate"
        className={
          embedded
            ? "flex flex-wrap items-center gap-3 pb-3"
            : "flex flex-wrap items-center gap-3 border-b border-line px-5 py-3.5"
        }
      >
        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-0.5 rounded-lg bg-hover p-0.5" role="group" aria-label="Template filter">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                aria-pressed={filter === f.id}
                // R126-3h: the segmented control's active segment = the
                // selection grammar (bg-accent-tint + text-accent-deep,
                // TOKENS §10/§1d — the border-accent-faded + text-accent
                // bento-era spelling dies; the inactive segment stays the
                // quiet muted/ink pair).
                className={cn(
                  "cursor-pointer rounded-md px-2.5 py-1.5 text-[11px] font-semibold transition-all duration-100",
                  filter === f.id
                    ? "bg-accent-tint text-accent-deep"
                    : "text-muted hover:text-ink",
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
              // R126-3h: the skeleton rides the clay card's rim hairline (the
              // 1.5px border-line spelling dies); the h-[86px] skeleton
              // contract is unchanged.
              <div key={i} className="h-[86px] animate-pulse rounded-xl border border-clay-rim bg-hover/50" />
            ))}
          </div>
        ) : query.isError ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <AlertTriangle size={20} className="text-danger-deep" />
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
