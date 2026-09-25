import { motion } from "framer-motion";
import { Bot, Copy, Pencil, Trash2 } from "lucide-react";
import type { Agent } from "../../lib/api";
import { staggerItem } from "../../lib/motion";
import { Badge } from "../ui/controls";

/**
 * One registry row: identity (name, role, template badge), wiring
 * (provider/model/vision), tuning summary, row actions.
 *
 * R126-3h: the row is the CLAY card (TOKENS §5/§9 — rounded-xl + the 1px
 * clay-rim hairline + bg-card + `.ac-clay-sm`, the compact-tile shadow
 * step; the 1.5px border-line bento spelling dies) and the hover wash is
 * the CSS class it already rode. The tuning meta chips ride the §11 neutral
 * badge tone (the bg-hover containers die); the skills chips ride the §11
 * accent-tint pair (bg-accent-tint + text-accent-deep — TOKENS §10/§1d; the
 * accent-soft/accent flat pair dies); the delete action's hover rides the
 * badge-danger tone (the red-500/10 wash dies). Badges ride controls.tsx's
 * converted §11 pairs.
 */
export function AgentCard({
  agent,
  onEdit,
  onDuplicate,
  onDelete,
  busy,
}: {
  agent: Agent;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  busy?: boolean;
}) {
  return (
    <motion.div
      variants={staggerItem}
      className="group rounded-xl border border-clay-rim bg-card p-3.5 transition-colors duration-100 hover:bg-hover ac-clay-sm"
      aria-label={`Agent ${agent.name}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-bold tracking-tight">{agent.name}</span>
            <Badge>{agent.role}</Badge>
            {agent.isTemplate ? (
              <Badge tone="accent">
                <Bot size={9} />
                template
              </Badge>
            ) : null}
          </div>
          {/* ROUND-92 (R92-C): an unconfigured agent (the R91-A force-delete
              reset state, or a template that never had a pair) renders an
              honest note instead of a dangling " · " — the agent arms itself
              from the first chat pick. */}
          <div className="mt-1 truncate font-mono text-[11px] text-muted">
            {agent.providerId !== null && agent.model !== null
              ? `${agent.providerId} · ${agent.model}`
              : "not configured — the first chat pick arms it"}
            {agent.visionModel ? ` · vision: ${agent.visionModel}` : ""}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px]">
            <span className="rounded-md bg-badge-neutral px-1.5 py-0.5 text-badge-neutral-fg">temp {agent.temperature}</span>
            <span className="rounded-md bg-badge-neutral px-1.5 py-0.5 text-badge-neutral-fg">{agent.maxTurns} turns</span>
            <span className="rounded-md bg-badge-neutral px-1.5 py-0.5 text-badge-neutral-fg">memory: {agent.memoryPolicy}</span>
            <span className="rounded-md bg-badge-neutral px-1.5 py-0.5 text-badge-neutral-fg">
              {agent.allowedTools.length} tools
            </span>
            {agent.skills.map((s) => (
              <span key={s} className="rounded-md bg-accent-tint px-1.5 py-0.5 text-accent-deep">
                {s}
              </span>
            ))}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1 opacity-60 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <button
            onClick={onDuplicate}
            disabled={busy}
            title="Duplicate"
            aria-label={`Duplicate ${agent.name}`}
            className="cursor-pointer rounded-md p-1.5 text-muted transition-colors hover:bg-hover hover:text-ink disabled:opacity-40"
          >
            <Copy size={13} />
          </button>
          <button
            onClick={onEdit}
            disabled={busy}
            title="Edit"
            aria-label={`Edit ${agent.name}`}
            className="cursor-pointer rounded-md p-1.5 text-muted transition-colors hover:bg-hover hover:text-ink disabled:opacity-40"
          >
            <Pencil size={13} />
          </button>
          {/* Templates are undeletable server-side (409 CONFLICT, API.md §4.5). */}
          <button
            onClick={onDelete}
            disabled={busy || agent.isTemplate}
            title={agent.isTemplate ? "Templates cannot be deleted" : "Delete"}
            aria-label={`Delete ${agent.name}`}
            className="cursor-pointer rounded-md p-1.5 text-muted transition-colors hover:bg-badge-danger hover:text-danger-deep disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
    </motion.div>
  );
}
