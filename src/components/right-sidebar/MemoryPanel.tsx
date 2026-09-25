import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { Brain, Globe, LoaderCircle, Pencil, Plus, RefreshCw, Trash2, Zap } from "lucide-react";
import {
  createProjectMemory,
  createWorkspaceMemory,
  deleteProjectMemory,
  deleteWorkspaceMemory,
  fetchMemorySettings,
  listProjectMemory,
  listWorkspaceMemory,
  updateProjectMemory,
  updateWorkspaceMemory,
  type CreateProjectMemoryInput,
  type ProjectMemory,
  type UpdateProjectMemoryPatch,
} from "../../lib/api";
import { formatWhen } from "../../lib/format";
import type { RightSidebarTab } from "../../lib/right-sidebar-store";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { useScrollFade } from "../../lib/useScrollFade";
import { ease } from "../../lib/motion";
import { ClampedText } from "../shared/ClampedText";

/**
 * ROUND-44 (R44-a) right-sidebar Memory tab — the visible half of the agent
 * MEMORY SYSTEM (owner directive "complete the agentic coding environment").
 * Agents forgot everything between sessions; now the agent's memory_save tool
 * persists durable per-project knowledge and this panel lets the owner READ
 * it (grouped by kind, colored chips) and PRUNE it (per-row delete).
 *
 * Data: GET /projects/:id/memory polled at 5s (the SubAgentPanel cadence —
 * memories change only when the agent saves one, so this is cheap and
 * near-live). Deletes hit DELETE /projects/:id/memory/:memoryId and
 * invalidate the listing. The newest memories are auto-injected into every
 * agent turn (the digest in agents/prompts.ts) — the footer hint says so.
 *
 * ROUND-98 (R98-F1, the owner: "it definitely does not know or remember the
 * things properly… implement our proper memory functionality"): the panel
 * gains the WRITE side — the "+ Add memory" form (kind picker + content, the
 * POST /projects/:id/memory route) and the per-row inline edit (the Pencil
 * beside the Trash — PUT /projects/:id/memory/:memoryId, a partial
 * content/kind patch). The form deliberately has NO importance field: the
 * memory table has no importance column — the KIND is the importance model
 * (decision > fact > preference > note, ranked at digest/search time
 * server-side), so the kind picker IS the importance control. Saves while
 * the master switch is OFF are allowed (like deletes — the rows sit dormant
 * and rejoin the digest when re-enabled).
 *
 * ROUND-117 (R117-b): the SCOPE LADDER — a segmented switch (Workspace |
 * This project) over the two memory tiers. The workspace tier (cross-project
 * facts: the owner's identity/preferences/environment truths, curated via
 * /memory/workspace) rides ABOVE the project tier in every main-session
 * digest; the project tier is unchanged. CRUD works for BOTH scopes through
 * the same form/row grammar — only the fetch/mutate functions switch.
 */
const KIND_ORDER: ProjectMemory["kind"][] = ["fact", "decision", "preference", "note"];

/** The two tiers the panel can browse (R117-b's segmented switch). */
type MemoryScope = "workspace" | "project";

const SCOPE_LABELS: Record<MemoryScope, string> = {
  workspace: "Workspace",
  project: "This project",
};

/** Kind chip colors — documented exceptions like SubAgentPanel's ROLE_COLORS:
 * they carry kind meaning across every theme/mode (fact = data blue,
 * decision = architecture purple, preference = taste green, note = amber). */
const KIND_COLORS: Record<ProjectMemory["kind"], string> = {
  fact: "#82aaff",
  decision: "#c792ea",
  preference: "#a5d6a7",
  note: "#f9a825",
};

export function MemoryPanel({ projectId, tab }: { projectId: string; tab: RightSidebarTab }) {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // R98-F1: the add-memory form's mount toggle (one form at the list's top).
  const [adding, setAdding] = useState(false);
  // R117-b: the active tier — "project" (this panel's project) or
  // "workspace" (the cross-project scope). Default stays the project tier
  // (the pre-R117 view); switching resets the add form.
  const [scope, setScope] = useState<MemoryScope>("project");

  // R117-b: the listing keys/functions switch with the tier; the shape and
  // the polling cadence stay identical (both tiers are the same REST
  // grammar over different scopes).
  const queryKey = scope === "project" ? ["project-memory", projectId] : ["workspace-memory"];
  const memoryQuery = useQuery({
    queryKey,
    queryFn: () => (scope === "project" ? listProjectMemory(projectId) : listWorkspaceMemory()),
    staleTime: 2_000,
    refetchInterval: 5_000,
  });
  const memories = memoryQuery.data ?? [];
  // R117-b: mutations invalidate ONLY the active tier's key (the scopes are
  // separate rows — a workspace write can never change a project listing).
  const invalidateScope = () => {
    void queryClient.invalidateQueries({ queryKey });
  };

  // ROUND-49: the memory master switch (Settings → Functionality, R98-I1's
  // rename of the advanced tab's label — the URL id stays "advanced"). While
  // OFF the panel stays browsable/deletable (pruning old memories is exactly
  // what you want while debugging the system) but carries a clear OFF notice
  // — nothing is injected into agent turns and the memory tools are gone.
  const settingsQuery = useQuery({
    queryKey: ["memory-settings"],
    queryFn: fetchMemorySettings,
    staleTime: 30_000,
  });
  const memoryOff = settingsQuery.data?.enabled === false;

  const scrollRef = useRef<HTMLDivElement>(null);
  useScrollFade(scrollRef);

  const doDelete = async (memoryId: string) => {
    if (deletingId !== null) return;
    setDeletingId(memoryId);
    setDeleteError(null);
    try {
      // R117-b: the delete routes the ACTIVE tier (same row grammar, the
      // workspace delete needs no project id).
      if (scope === "project") {
        await deleteProjectMemory(projectId, memoryId);
      } else {
        await deleteWorkspaceMemory(memoryId);
      }
      await invalidateScope();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeletingId(null);
    }
  };

  // R98-F1: the add form's save — the form owns its pending/error state (the
  // row-level grammar below); the panel owns the invalidation. R117-b: the
  // save routes the ACTIVE tier.
  const doCreate = async (input: CreateProjectMemoryInput) => {
    if (scope === "project") {
      await createProjectMemory(projectId, input);
    } else {
      await createWorkspaceMemory(input);
    }
    await invalidateScope();
  };

  // R98-F1: the per-row edit's save — same split (row owns state, panel owns
  // the invalidation). R117-b: the patch routes the ACTIVE tier.
  const doUpdate = async (memoryId: string, patch: UpdateProjectMemoryPatch) => {
    if (scope === "project") {
      await updateProjectMemory(projectId, memoryId, patch);
    } else {
      await updateWorkspaceMemory(memoryId, patch);
    }
    await invalidateScope();
  };

  return (
    <div className="h-full flex flex-col min-h-0" data-testid="memory-panel" data-tab-id={tab.id}>
      {/* ── Panel header: label + live count + the R98-F1 add toggle ── */}
      {/* R126-3e: the header strip = the in-flow chrome shade
          (bg-header-surface + the clay-rim hairline); the scope segmented
          control = the 1px clay rim + the accentTint/accentDeep active
          segment; the count = the NEUTRAL badge tone. */}
      <div
        className="shrink-0 flex items-center gap-2 px-3 h-9 border-b border-clay-rim bg-header-surface"
      >
        <Brain size={13} style={{ color: styles.accent }} className="shrink-0" />
        {/* R117-b: the SCOPE SWITCH — the panel's two tiers. The segmented
            control sits where the old "Project memory" title was (the
            switch IS the title now); the quiet-pill grammar (10px mono,
            subtle bg, the active side accented) is the session header's
            status-chip family. */}
        <div
          className="flex-1 min-w-0 flex items-center gap-0.5 rounded-lg border border-clay-rim p-0.5"
          role="tablist"
          aria-label="Memory scope"
        >
          {(Object.keys(SCOPE_LABELS) as MemoryScope[]).map((s) => (
            <button
              key={s}
              role="tab"
              aria-selected={scope === s}
              data-testid={`memory-scope-${s}`}
              onClick={() => {
                if (scope === s) return;
                setScope(s);
                setAdding(false);
                setDeleteError(null);
              }}
              className={`h-5 px-1.5 rounded-md text-[10px] font-medium truncate transition-colors ${
                scope === s ? "bg-accent-tint text-accent-deep" : "text-muted"
              }`}
            >
              {s === "workspace" ? <Globe size={9} className="inline mr-0.5 -mt-0.5" /> : null}
              {SCOPE_LABELS[s]}
            </button>
          ))}
        </div>
        <span
          // R126-3e tightening (§6 numbers discipline): tabular-nums on the
          // live count.
          className="shrink-0 text-[10px] font-mono font-medium uppercase px-1.5 py-0.5 rounded-md tabular-nums bg-badge-neutral text-badge-neutral-fg"
        >
          {memories.length} saved
        </span>
        {/* R98-F1: the add-memory toggle — the panel's one persistent action
            button (the header's quiet icon idiom; the form itself renders at
            the top of the list so the rows stay the visual center).
            R100-G: hover = the CSS wash. */}
        <button
          onClick={() => setAdding((v) => !v)}
          aria-label={adding ? "Close the add-memory form" : "Add a memory"}
          aria-expanded={adding}
          title={adding ? "Close the add-memory form" : "Add a memory"}
          data-testid="memory-add-toggle"
          className="w-5 h-5 shrink-0 grid place-items-center rounded transition-colors hover:bg-hover"
          style={{ color: adding ? styles.accent : styles.textTertiary }}
        >
          <Plus size={12} />
        </button>
      </div>

      {memoryOff ? (
        <div
          // R126-3e (§11): the OFF notice = the warning badge-tone container
          // (ink inherited) — the withAlpha(warning) wash died.
          className="shrink-0 px-3 py-2 border-b border-clay-rim flex items-center gap-2 bg-badge-warning text-badge-warning-fg"
          data-testid="memory-off-notice"
        >
          <Zap size={12} className="shrink-0" />
          <span className="text-[11px]">
            Memory is <strong>turned off</strong> — agents run on session context alone and the
            memory tools are unavailable. Saved memories are kept (you can still prune them
            below). Re-enable in Settings → Functionality.
          </span>
        </div>
      ) : null}

      {/* ── Scrollable grouped list ── */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto auto-scroll">
        {/* R98-F1: the ADD-MEMORY form — the list's top card while open
            (available in the empty state too: the owner can seed the memory
            before the agent ever saves one). */}
        {adding ? (
          <div className="px-2.5 pt-2.5">
            <AddMemoryForm
              onCancel={() => setAdding(false)}
              onSaved={() => setAdding(false)}
              save={doCreate}
            />
          </div>
        ) : null}
        {memoryQuery.isPending ? (
          <div className="py-10 flex flex-col items-center gap-2" style={{ color: styles.textTertiary }}>
            <LoaderCircle size={16} className="animate-spin" style={{ color: styles.accent }} />
            <span className="text-[11px]">Loading memory…</span>
          </div>
        ) : memoryQuery.isError ? (
          <div className="px-3 py-3">
            <div
              // R126-3e (§11): the danger badge-tone container + the
              // outlined-danger Retry (the 3a/3b/3c grammar).
              className="rounded-xl px-3 py-3 flex flex-col gap-2 bg-badge-danger text-badge-danger-fg"
            >
              <div className="flex items-center gap-1.5 text-[11px] font-semibold">
                {scope === "project" ? "Couldn't load project memory" : "Couldn't load workspace memory"}
              </div>
              <div className="text-[11px]">
                {memoryQuery.error instanceof Error ? memoryQuery.error.message : "The sidecar didn't answer."}
              </div>
              <button
                onClick={() => void memoryQuery.refetch()}
                className="self-start h-6 px-2.5 rounded-full text-[10px] font-semibold inline-flex items-center gap-1.5 border border-danger-deep text-danger-deep transition-transform duration-100 active:scale-[0.98]"
              >
                <RefreshCw size={10} /> Try again
              </button>
            </div>
          </div>
        ) : memories.length === 0 ? (
          <div
            className={adding ? "px-6 py-4 text-center" : "h-full grid place-items-center px-6 text-center"}
          >
            <div className="max-w-[240px]">
              <div
                // R126-3e tightening: the dashed tile rides the clay rim on
                // the class leg (one spelling with RightSidebar's empty tile);
                // the inline borderColor leg died.
                className="w-11 h-11 mx-auto mb-3 grid place-items-center rounded-2xl border-2 border-dashed border-clay-rim"
                style={{ color: styles.textTertiary }}
              >
                <Brain size={18} />
              </div>
              <div className="text-[12px] font-medium" style={{ color: styles.textSecondary }}>
                {scope === "project" ? "No memories yet" : "No workspace memories yet"}
              </div>
              <div className="text-[11px] mt-1.5 leading-[1.55]" style={{ color: styles.textTertiary }}>
                {scope === "project"
                  ? "The agent saves durable project knowledge here via memory_save — facts, decisions, preferences."
                  : "Cross-project facts — your identity, preferences, and environment truths. Agents see them in every project's memory digest."}
              </div>
            </div>
          </div>
        ) : (
          <div className="px-2.5 py-2.5 flex flex-col gap-2.5">
            {deleteError !== null ? (
              <div
                // R126-3e (§11): the delete-error alert = the danger
                // badge-tone container.
                className="rounded-xl px-3 py-2 text-[11px] bg-badge-danger text-badge-danger-fg"
                role="alert"
              >
                {deleteError}
              </div>
            ) : null}
            {KIND_ORDER.filter((kind) => memories.some((m) => m.kind === kind)).map((kind) => {
              const items = memories.filter((m) => m.kind === kind);
              const color = KIND_COLORS[kind];
              return (
                <section key={kind} data-kind={kind}>
                  {/* Kind group header: colored chip + count */}
                  <div className="flex items-center gap-1.5 px-1 pb-1.5">
                    <span
                      // R126-3e tightening (§11): the kind chip = the NEUTRAL
                      // badge tone + the kind color as a DOT — the exact
                      // role-chip spelling SubAgentPanel + the picker ship (the
                      // withAlpha(color,0.14) identity fill + the flat-hue text
                      // died; KIND_COLORS survive as dots-only hue-as-data).
                      className="inline-flex items-center gap-1 text-[10px] font-mono font-medium uppercase px-1.5 py-0.5 rounded-md bg-badge-neutral text-badge-neutral-fg"
                    >
                      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color }} aria-hidden />
                      {kind}
                    </span>
                    <span className="text-[10px] tabular-nums" style={{ color: styles.textTertiary }}>
                      {items.length}
                    </span>
                    {/* R126-3e: the group hairline on the class leg (bg-line). */}
                    <span className="flex-1 h-px bg-line" aria-hidden />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <AnimatePresence initial={false}>
                      {items.map((m) => (
                        <MemoryRow
                          key={m.id}
                          memory={m}
                          deleting={deletingId === m.id}
                          onDelete={() => void doDelete(m.id)}
                          onUpdate={(patch) => doUpdate(m.id, patch)}
                        />
                      ))}
                    </AnimatePresence>
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Footer hint: why this panel matters (scope-honest since R117-b) ── */}
      <div
        // R126-3e: the footer strip = the in-flow chrome shade.
        className="shrink-0 flex items-center gap-1.5 px-3 h-7 border-t border-clay-rim bg-header-surface text-[10px]"
        style={{ color: styles.textTertiary }}
      >
        <Zap size={10} style={{ color: styles.accent }} className="shrink-0" />
        <span className="truncate">
          {scope === "project"
            ? "Auto-loaded into every agent turn"
            : "Injected into every project's agent turns"}
        </span>
      </div>
    </div>
  );
}

/* ── R98-F1: the add-memory form — the panel's card grammar (rounded-[12px],
 * 1px border, the row input idioms) at the list's top. The kind picker is a
 * native styled <select> (the PromptsTab project-picker precedent — no select
 * primitive exists in the catalog); the content textarea is the row's own
 * 11.5px reading size. Client-side gate: non-empty after trim (the server
 * 400s it otherwise — surfaced verbatim in the form's role=alert line, the
 * honest R97-I posture). The 4000-char table cap shows as a counter only
 * when the draft is past 3,500 chars; an over-cap save surfaces the
 * server's exact message the same way. */
function AddMemoryForm({
  save,
  onCancel,
  onSaved,
}: {
  save: (input: CreateProjectMemoryInput) => Promise<unknown>;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const styles = useThemeStyles();
  const [kind, setKind] = useState<ProjectMemory["kind"]>("note");
  const [content, setContent] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = content.trim();
  const canSave = !pending && trimmed !== "";

  const submit = async () => {
    if (!canSave) return;
    setPending(true);
    setError(null);
    try {
      await save({ kind, content: trimmed });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
      setPending(false);
    }
  };

  // R126-3e (TOKENS §10): the form's fields = THE WELL (the recessed input
  // fill + the clay-rim hairline, one spelling on the class leg).
  const inputClass = "bg-well border border-clay-rim";

  return (
    <div
      data-testid="memory-add-form"
      // R126-3e: the form card = a quiet clay surface (bg-card + the 1px
      // rim) so the well-filled fields read one rung down.
      className="rounded-xl px-2.5 py-2.5 flex flex-col gap-2 border border-clay-rim bg-card"
    >
      <div className="flex items-center gap-2">
        <select
          aria-label="Kind of the new memory"
          data-testid="memory-add-kind"
          value={kind}
          disabled={pending}
          onChange={(e) => setKind(e.target.value as ProjectMemory["kind"])}
          className={`h-7 rounded-lg px-1.5 text-[11px] font-medium font-mono uppercase outline-none cursor-pointer ${inputClass}`}
          style={{ color: styles.text }}
        >
          {KIND_ORDER.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <span className="text-[10px]" style={{ color: styles.textTertiary }}>
          kind = importance (decision &gt; fact &gt; preference &gt; note)
        </span>
      </div>
      <textarea
        rows={3}
        aria-label="Content of the new memory"
        data-testid="memory-add-content"
        placeholder="What should be remembered?"
        value={content}
        disabled={pending}
        onChange={(e) => setContent(e.target.value)}
        className={`w-full rounded-lg px-2.5 py-2 text-[12px] leading-[1.55] outline-none resize-y disabled:opacity-60 ${inputClass}`}
        style={{ color: styles.text }}
      />
      {content.length > 3_500 ? (
        <div
          // R126-3e (§11): the over-cap counter = warning status TEXT (the
          // deep pair, class leg).
          className={`text-[10px] font-mono ${content.length > 4_000 ? "text-warning-deep" : ""}`}
          style={content.length > 4_000 ? undefined : { color: styles.textTertiary }}
        >
          {content.length} / 4,000 chars{content.length > 4_000 ? " — over the cap; the save will be refused" : ""}
        </div>
      ) : null}
      {error !== null ? (
        <div
          // R126-3e (§11): the form's alert = the danger badge-tone container.
          className="text-[11px] rounded-lg px-2 py-1 bg-badge-danger text-badge-danger-fg"
          role="alert"
          data-testid="memory-add-error"
        >
          {error}
        </div>
      ) : null}
      <div className="flex items-center gap-1.5 self-end">
        <button
          onClick={onCancel}
          disabled={pending}
          // R126-3e (§4): Cancel = the outlined secondary.
          className="h-6 px-2.5 rounded-full text-[10px] font-semibold inline-flex items-center gap-1.5 border border-line-strong text-muted transition-colors hover:bg-hover disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={() => void submit()}
          disabled={!canSave}
          data-testid="memory-add-save"
          // R126-3e (§4): Save = the quiet-solid accentDeep fill + the
          // accentText ink on the JS leg (text-accent-text is a PHANTOM
          // utility) + the 0.98 press — the withAlpha accent species died.
          className="h-6 px-2.5 rounded-full text-[10px] font-semibold inline-flex items-center gap-1.5 bg-accent-deep transition-transform duration-100 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ color: styles.accentText }}
        >
          {pending ? <LoaderCircle size={10} className="animate-spin" /> : <Plus size={10} />}
          Save memory
        </button>
      </div>
    </div>
  );
}

/** One memory card: content (clamped) + meta row (when · source) + delete.
 * ROUND-48 (R48-a): the per-kind left accent bar (borderLeft 2.5px) is GONE
 * (owner: the colored left border "looks way too bad") — every card now
 * carries the same clean uniform 1px border; kind identity stays in the
 * group-header chips above.
 * ROUND-98 (R98-F1): the per-row EDIT — a Pencil beside the Trash (the same
 * hover-revealed 5×5 icon grammar) expands the card into an inline editor
 * (content textarea + kind select + Save/Cancel). Save PUTs the PARTIAL
 * patch {content, kind}; the honest error line + the pending state live in
 * the row (the panel owns only the invalidation). */
function MemoryRow({
  memory,
  deleting,
  onDelete,
  onUpdate,
}: {
  memory: ProjectMemory;
  deleting: boolean;
  onDelete: () => void;
  onUpdate: (patch: UpdateProjectMemoryPatch) => Promise<unknown>;
}) {
  const styles = useThemeStyles();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(memory.content);
  const [draftKind, setDraftKind] = useState<ProjectMemory["kind"]>(memory.kind);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = draft.trim();
  const dirty = trimmed !== memory.content.trim() || draftKind !== memory.kind;

  const startEdit = () => {
    setDraft(memory.content);
    setDraftKind(memory.kind);
    setError(null);
    setEditing(true);
  };

  const submit = async () => {
    if (pending || !dirty) return;
    setPending(true);
    setError(null);
    try {
      await onUpdate({ content: trimmed, kind: draftKind });
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setPending(false);
    }
  };

  // R126-3e (TOKENS §10): the editor's fields = THE WELL (same spelling as
  // the add form).
  const inputClass = "bg-well border border-clay-rim";

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -3 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ duration: 0.14, ease }}
      // R126-3e (TOKENS §10): the memory row = THE WELL ROW (.ac-well — the
      // recessed rung + the rim hairline); the JS isDark/card + border legs
      // died.
      className="rounded-xl ac-well px-2.5 py-2 group relative"
    >
      {editing ? (
        /* R98-F1: the inline editor — the AddMemoryForm's grammar, prefilled
         * with the row's own values. */
        <div className="flex flex-col gap-2" data-testid="memory-edit-form">
          <div className="flex items-center gap-2">
            <select
              aria-label="Kind of the memory"
              data-testid="memory-edit-kind"
              value={draftKind}
              disabled={pending}
              onChange={(e) => setDraftKind(e.target.value as ProjectMemory["kind"])}
              className={`h-7 rounded-lg px-1.5 text-[11px] font-medium font-mono uppercase outline-none cursor-pointer ${inputClass}`}
              style={{ color: styles.text }}
            >
              {KIND_ORDER.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
          <textarea
            rows={3}
            aria-label="Content of the memory"
            data-testid="memory-edit-content"
            value={draft}
            disabled={pending}
            onChange={(e) => setDraft(e.target.value)}
            className={`w-full rounded-lg px-2.5 py-2 text-[12px] leading-[1.55] outline-none resize-y disabled:opacity-60 ${inputClass}`}
            style={{ color: styles.text }}
          />
          {draft.length > 4_000 ? (
            <div
              // R126-3e (§11): the over-cap counter = warning status TEXT.
              className="text-[10px] font-mono text-warning-deep"
            >
              {draft.length} / 4,000 chars — over the cap; the save will be refused
            </div>
          ) : null}
          {error !== null ? (
            <div
              // R126-3e (§11): the editor's alert = the danger badge-tone
              // container.
              className="text-[11px] rounded-lg px-2 py-1 bg-badge-danger text-badge-danger-fg"
              role="alert"
              data-testid="memory-edit-error"
            >
              {error}
            </div>
          ) : null}
          <div className="flex items-center gap-1.5 self-end">
            <button
              onClick={() => setEditing(false)}
              disabled={pending}
              // R126-3e (§4): Cancel = the outlined secondary.
              className="h-6 px-2.5 rounded-full text-[10px] font-semibold inline-flex items-center gap-1.5 border border-line-strong text-muted transition-colors hover:bg-hover disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={() => void submit()}
              disabled={pending || !dirty}
              data-testid="memory-edit-save"
              // R126-3e (§4): Save = the quiet-solid accentDeep fill + the
              // accentText ink on the JS leg + the 0.98 press.
              className="h-6 px-2.5 rounded-full text-[10px] font-semibold inline-flex items-center gap-1.5 bg-accent-deep transition-transform duration-100 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ color: styles.accentText }}
            >
              {pending ? <LoaderCircle size={10} className="animate-spin" /> : <Pencil size={10} />}
              Save changes
            </button>
          </div>
        </div>
      ) : (
        <>
          <ClampedText
            text={memory.content}
            lines={6}
            className="text-[12px] leading-[1.55] whitespace-pre-wrap break-words pr-10"
            style={{ color: styles.text }}
          />
          <div className="flex items-center gap-2 mt-1">
            <span className="text-[10px] shrink-0" style={{ color: styles.textTertiary }} title={memory.updatedAt}>
              {formatWhen(memory.updatedAt)}
            </span>
            {memory.source !== "agent" ? (
              <span className="text-[10px] shrink-0" style={{ color: styles.textTertiary }}>
                · {memory.source}
              </span>
            ) : null}
            <span className="flex-1" />
            {/* R98-F1: the edit affordance — Pencil beside the Trash, the
             * same hover/focus-revealed quiet-icon grammar. R100-G: the
             * hover wash is the CSS class. */}
            <button
              onClick={startEdit}
              aria-label={`Edit memory: ${memory.content.slice(0, 60)}`}
              title="Edit this memory"
              className="w-5 h-5 grid place-items-center rounded-lg shrink-0 transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-hover"
              style={{ color: styles.textTertiary }}
            >
              <Pencil size={11} />
            </button>
            <button
              onClick={onDelete}
              disabled={deleting}
              aria-label={`Delete memory: ${memory.content.slice(0, 60)}`}
              title="Delete this memory"
              // R126-3e (§4 — the brief's mandate): the prune action = the
              // OUTLINED danger species (1px border-danger-deep +
              // text-danger-deep) — the quiet tertiary glyph died.
              className="w-5 h-5 grid place-items-center rounded-lg shrink-0 border border-danger-deep text-danger-deep transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100 disabled:opacity-50 hover:bg-hover active:scale-95"
            >
              {deleting ? <LoaderCircle size={11} className="animate-spin" /> : <Trash2 size={11} />}
            </button>
          </div>
        </>
      )}
    </motion.div>
  );
}
