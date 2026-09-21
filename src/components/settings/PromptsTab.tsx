import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Eye, EyeOff, RotateCcw, Search } from "lucide-react";
import { useProjects } from "../../hooks/use-projects";
import { useTimeoutClear } from "../../hooks/use-timeout-clear";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { bdr, withAlpha } from "../dashboard/helpers";
import { ClampedText } from "../shared/ClampedText";
import { SkeletonBlock, SkeletonRows } from "../shared/Skeletons";
import { ConfirmDialog } from "./ConfirmDialog";
// R100-E2: the round-100 primitives — SectionCard for the two big cards,
// Kicker for the list's group labels (USAGE.md §3; TOKENS.md §2 + §4). The
// R99-F layout and information architecture are unchanged — visual tiers only.
import { Kicker } from "../ui/Kicker";
import { SectionCard } from "../ui/SectionCard";
import {
  deletePromptOverride,
  fetchPromptPreview,
  fetchPromptSections,
  savePromptOverride,
  type PromptSectionBucket,
  type PromptSectionView,
  type PromptSectionsReport,
} from "../../lib/api";

/**
 * PromptsTab — ROUND-99 (R99-F, owner: "It should be used for the whole
 * project: this will be the whole project system-wide default prompt not
 * just the one. I do not like the UI. It is quite bad, looks ugly… I would
 * prefer for you to learn from the best of the best"): the REDO of the
 * R98-E surface over the R59-F override ENGINE (`.acute/prompts/<id>.md` —
 * replace wholesale / empty = drop / DELETE = revert), REST-exposed by
 * routes/prompts.ts. The research pass (AI_IDE_UX §4 — Cursor Rules'
 * scope-grouped list + status badges + per-rule token counts + preview;
 * Claude Projects' single "project instructions" framing) sets the shape:
 *
 * THE FRAMING — the tab opens with what this IS: the PROJECT-WIDE system
 * prompt ("every agent turn in <project name> starts from this prompt"),
 * sized honestly (~tokens estimated, sections · overridden).
 *
 * THE LAYOUT — MASTER-DETAIL-LITE (the R98 expandable-rows choice retired):
 * on ≥768px a bucket-grouped master list (~300px, its own max-h scroll per
 * the long-list discipline) beside the selected section's editor; below md
 * the panes stack (list above, editor below, the selected row hidden while
 * its editor is open + a "← All sections" back affordance). Lighter than
 * the api tab's viewport-locked master-detail: the tab keeps the standard
 * scrolling column — only the LIST scrolls internally.
 *
 * THE AFFORDANCES — search filter (id/title, honest empty state), per-row
 * ~token estimates (tabular-nums, tilde — never false precision), ONE
 * "Revert all…" guard (ConfirmDialog enumerating every override that
 * reverts, Promise.allSettled, honest per-section failure report), and the
 * composed-prompt preview promoted to a proper card below the panes.
 *
 * State gates per R97-I: loading = the shared Skeleton primitives (mirroring
 * the two-pane geometry) with ONE role="status" announcement; error =
 * role="alert" with the exact cause and one Retry — the framing header
 * survives both gates (the scope line says WHAT failed to load). The two
 * destructive-ish levers stay named honestly: an EMPTY save confirms through
 * ConfirmDialog (the DROP semantics), Revert is a single click (it restores
 * the built-in text — the safe direction).
 */

/** The override cap (agent-core prompt-registry's PROMPT_OVERRIDE_CHAR_CAP —
 * the server refuses over-cap writes with a 400; the UI refuses the input
 * first so the honest message is local, not a round-trip). */
const OVERRIDE_CHAR_CAP = 8_000;

/** The empty-save warning — the exact destructive truth the engine enforces. */
const EMPTY_SAVE_WARNING =
  "Saving an empty override REMOVES this section from the prompt entirely — the agent will not see it on any turn. (To restore the built-in text later, use Revert.)";

/** The cap refusal — why the textarea refused the input. */
function capRefusalNote(next: string): string {
  const extra = next.length - OVERRIDE_CHAR_CAP;
  return `Overrides are capped at ${OVERRIDE_CHAR_CAP.toLocaleString("en-US")} characters — the extra ${
    extra === 1 ? "character was" : `${extra.toLocaleString("en-US")} characters were`
  } refused. Trim the text to save it.`;
}

/** §2 identity-chip grammar for the detail header's bucket badge (mono,
 * subtle bg — the context-meter bucket the section's lines bill to). */
const BUCKET_TITLES: Record<PromptSectionBucket, string> = {
  identity: "identity bucket — the always-present core",
  tools: "tools bucket — the tool-use disciplines",
  memory: "memory bucket — the memory/context lines",
  meta: "meta bucket — the session bookkeeping",
};

/** The four list groups (Cursor Rules' scope-grouped list, adapted to this
 * registry's buckets): identity IS the system-prompt core, so its group
 * carries the framing name. */
const BUCKET_GROUP_LABELS: Record<PromptSectionBucket, string> = {
  identity: "System prompt",
  tools: "Tools",
  memory: "Memory",
  meta: "Meta",
};

/** The registry's buckets in display order. */
const BUCKET_ORDER: PromptSectionBucket[] = ["identity", "tools", "memory", "meta"];

/** The human title for a section id — sentence case (`tool-use` → "Tool
 * use", `project-memory` → "Project memory"), with MCP kept uppercase: the
 * list's primary label; the mono id stays visible as the override file's
 * name in the detail header. */
function sectionTitle(id: string): string {
  const ACRONYMS = new Set(["mcp"]);
  const words = id.split("-").map((word) => (ACRONYMS.has(word) ? word.toUpperCase() : word));
  const head = words[0] === undefined ? "" : words[0].charAt(0).toUpperCase() + words[0].slice(1);
  return [head, ...words.slice(1)].join(" ");
}

/** The ~token estimate every count rides (chars ÷ 4, the honest heuristic —
 * the tilde is load-bearing: never a false-precision claim). */
function estimateTokens(chars: number): number {
  return Math.round(chars / 4);
}

/** ~token estimates at display width: plain below 10k, `4.1k` above. */
function fmtTokenEstimate(tokens: number): string {
  return tokens >= 10_000 ? `${(tokens / 1_000).toFixed(1)}k` : tokens.toLocaleString("en-US");
}

/** The section's effective size in characters — the override when present,
 * else the built-in composition; absent sections compose nothing (0). */
function effectiveChars(section: PromptSectionView): number {
  if (section.overridden) return section.overrideContent?.length ?? 0;
  if (section.present) return section.defaultText?.length ?? 0;
  return 0;
}

/* ── The per-section editor (the detail pane's body) ───────────────────────── */

/** The override editor for ONE section — remounted per section (keyed by
 * id + the CURRENT override text, the SkillEditor pattern) so the draft
 * always initializes from the overrideContent that is actually on disk,
 * including after revert-all's out-of-band DELETEs. */
function SectionEditor({
  root,
  section,
  invalidate,
  onNote,
}: {
  root: string;
  section: PromptSectionView;
  invalidate: () => void;
  onNote: (text: string, isError?: boolean) => void;
}) {
  const styles = useThemeStyles();
  const [draft, setDraft] = useState(section.overrideContent ?? "");
  const [capNote, setCapNote] = useState<string | null>(null);
  const [showDefault, setShowDefault] = useState(false);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (content: string) => savePromptOverride(root, section.id, content),
    onSuccess: (result) => {
      setError(null);
      onNote(
        result.dropped
          ? `“${section.id}” dropped — the section is out of the prompt.`
          : `“${section.id}” override saved.`,
      );
      invalidate();
    },
    onError: (err: Error) => setError(err.message),
  });

  const revert = useMutation({
    mutationFn: () => deletePromptOverride(root, section.id),
    onSuccess: () => {
      setError(null);
      setDraft("");
      onNote(`“${section.id}” reverted — the built-in text is back.`);
      invalidate();
    },
    onError: (err: Error) => setError(err.message),
  });

  /** The cap is enforced at the INPUT: over-cap changes are refused outright
   * (the draft never crosses 8,000) and the honest note says what happened. */
  const onDraftChange = (next: string) => {
    if (next.length > OVERRIDE_CHAR_CAP) {
      setCapNote(capRefusalNote(next));
      return;
    }
    setCapNote(null);
    setDraft(next);
  };

  const dirty = draft !== (section.overrideContent ?? "");
  const emptySave = draft.trim() === "";

  const onSaveClick = () => {
    if (emptySave) {
      setConfirmEmpty(true);
      return;
    }
    save.mutate(draft);
  };

  return (
    <div className="flex flex-col gap-2.5" data-testid={`prompt-editor-${section.id}`}>
      {/* The built-in text — the read-only reference (mono, subtle bg),
          collapsed by default: the override is the thing being edited. */}
      {section.defaultText !== null ? (
        <div>
          <button
            type="button"
            onClick={() => setShowDefault((v) => !v)}
            aria-expanded={showDefault}
            aria-label={`Show the default text for ${section.id}`}
            title={showDefault ? "Hide the built-in text" : "Show the built-in text this override replaces"}
            className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11px] font-semibold shrink-0"
            style={{ background: styles.subtle, color: styles.textSecondary }}
          >
            {showDefault ? <EyeOff size={11} /> : <Eye size={11} />}
            {showDefault ? "Hide default" : "Show default"}
          </button>
          {showDefault && (
            <pre
              data-testid={`prompt-default-${section.id}`}
              className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-xl p-2.5 font-mono text-[11px] leading-relaxed"
              style={{
                background: styles.subtle,
                border: bdr("1.5px", styles.borderSubtle),
                color: styles.textSecondary,
              }}
            >
              {section.defaultText}
            </pre>
          )}
        </div>
      ) : (
        <p className="text-[11px]" style={{ color: styles.textTertiary }}>
          Absent in this project&apos;s current composition — there is no default text to show; an
          override would still apply the moment the section composes.
        </p>
      )}

      <div>
        <label
          className="mb-1 block text-[11px] font-medium"
          style={{ color: styles.textSecondary }}
          htmlFor={`prompt-override-${section.id}`}
        >
          Override (replaces the section wholesale — an empty save drops it)
        </label>
        <textarea
          id={`prompt-override-${section.id}`}
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          placeholder="Write the replacement text the model should receive for this section…"
          aria-label={`Edit the override for ${section.id}`}
          rows={8}
          data-testid={`prompt-override-input-${section.id}`}
          className="w-full resize-y rounded-lg border-[1.5px] px-2.5 py-2 font-mono text-[11px] leading-relaxed outline-none"
          style={{ background: styles.bg, borderColor: styles.border, color: styles.text }}
        />
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <span
          className="font-mono text-[11px] tabular-nums"
          style={{ color: draft.length >= OVERRIDE_CHAR_CAP ? SEMANTIC_COLORS.warning : styles.textTertiary }}
          data-testid={`prompt-counter-${section.id}`}
        >
          {draft.length.toLocaleString("en-US")} / {OVERRIDE_CHAR_CAP.toLocaleString("en-US")} chars
        </span>
        <span className="flex-1" />
        {/* The standing drop hint — the confirm dialog repeats it on click. */}
        {emptySave && dirty && (
          <span
            className="text-[11px] font-medium"
            style={{ color: SEMANTIC_COLORS.warning }}
            data-testid={`prompt-drop-hint-${section.id}`}
          >
            Saving this empty override REMOVES the section from the prompt entirely.
          </span>
        )}
      </div>

      {capNote && (
        <p
          className="text-[11px] font-medium"
          style={{ color: SEMANTIC_COLORS.warning }}
          data-testid={`prompt-cap-note-${section.id}`}
        >
          {capNote}
        </p>
      )}
      {error && (
        <p
          className="text-[11px] font-medium"
          style={{ color: SEMANTIC_COLORS.danger }}
          role="alert"
          data-testid={`prompt-editor-error-${section.id}`}
        >
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onSaveClick}
          disabled={!dirty || save.isPending}
          aria-label={`Save the override for ${section.id}`}
          className="h-8 shrink-0 rounded-lg px-3 text-[11px] font-semibold disabled:opacity-50"
          style={{ background: withAlpha(styles.accent, 0.12), color: styles.accent }}
        >
          {save.isPending ? "Saving…" : "Save"}
        </button>
        {/* Revert only exists when there IS an override to remove. */}
        {section.overridden && (
          <button
            type="button"
            onClick={() => revert.mutate()}
            disabled={revert.isPending}
            aria-label={`Revert ${section.id} to the default text`}
            title="Remove the override file — the built-in text composes again"
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-[11px] font-semibold disabled:opacity-50"
            style={{ background: styles.subtle, color: styles.textSecondary }}
          >
            <RotateCcw size={11} /> {revert.isPending ? "Reverting…" : "Revert"}
          </button>
        )}
      </div>

      {/* The DROP confirm — the destructive ask rides the shared styled
          dialog (the R95-A window.confirm ban), with the exact warning. */}
      {confirmEmpty && (
        <ConfirmDialog
          title="Drop this section?"
          message={EMPTY_SAVE_WARNING}
          confirmLabel="Save empty (drop)"
          danger
          onConfirm={() => {
            setConfirmEmpty(false);
            save.mutate(draft);
          }}
          onClose={() => setConfirmEmpty(false)}
        />
      )}
    </div>
  );
}

/* ── One master-list row ──────────────────────────────────────────────────── */

/** A section row: the human TITLE + the status chip + the right-aligned
 * ~token estimate. Active-row grammar = the api tab's provider list
 * (aria-current, accent-soft wash on the CSS-var leg, 2.5px accent bar) —
 * hover rides `hover:bg-hover`, never a JS handler (TOKENS §1 rule 4). */
function SectionRow({
  section,
  active,
  hiddenOnMobile,
  onSelect,
}: {
  section: PromptSectionView;
  active: boolean;
  /** True while the row's own editor is open below md (the selected row
   * hides from the stacked list — the editor right under it says it all). */
  hiddenOnMobile: boolean;
  onSelect: () => void;
}) {
  const styles = useThemeStyles();
  const chars = effectiveChars(section);
  const tokens = estimateTokens(chars);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "true" : undefined}
      aria-label={`Select section ${section.id}`}
      data-section-id={section.id}
      title={section.id}
      className={`relative w-full items-center gap-2 rounded-lg px-2.5 py-1.5 md:py-2 text-left transition-colors ${
        hiddenOnMobile ? "hidden md:flex" : "flex"
      } ${active ? "bg-accent-soft" : "hover:bg-hover"}`}
    >
      {active && (
        <span
          className="absolute left-0 top-1.5 bottom-1.5 w-[2.5px] rounded-full"
          style={{ background: styles.accent }}
          aria-hidden
        />
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span
          className="w-full truncate text-[12px] font-medium"
          style={{ color: active ? styles.text : styles.textSecondary }}
        >
          {sectionTitle(section.id)}
        </span>
        {/* The status chip — ONE per row: OVERRIDDEN is accent-tinted,
            DEFAULT neutral, ABSENT (conditional section not composed
            here) the amber warning. */}
        <span
          data-testid={`prompt-status-${section.id}`}
          className="w-fit shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider"
          style={
            section.overridden
              ? { background: withAlpha(styles.accent, 0.14), color: styles.accent }
              : section.present
                ? { background: styles.subtle, color: styles.textTertiary }
                : {
                    background: withAlpha(SEMANTIC_COLORS.warning, 0.1),
                    color: SEMANTIC_COLORS.warning,
                  }
          }
        >
          {section.overridden ? "overridden" : section.present ? "default" : "absent"}
        </span>
      </span>
      <span
        className="shrink-0 font-mono text-[10px] tabular-nums"
        style={{ color: styles.textTertiary }}
        title={`${chars.toLocaleString("en-US")} characters ≈ ${tokens.toLocaleString("en-US")} tokens (chars ÷ 4)`}
        data-testid={`prompt-row-tokens-${section.id}`}
      >
        ~{fmtTokenEstimate(tokens)}
      </span>
    </button>
  );
}

/* ── The ready work area (the two panes + the revert-all guard) ───────────── */

/** The master-detail-lite panes over a LOADED report — owns the selection,
 * the filter, and the revert-all flow. */
function PromptWorkArea({
  root,
  report,
  invalidate,
  note,
}: {
  root: string;
  report: PromptSectionsReport;
  invalidate: () => void;
  note: (text: string, isError?: boolean) => void;
}) {
  const styles = useThemeStyles();
  /** The selected section (the R98 one-at-a-time `expandedId`, promoted to
   * a persistent selection — the detail pane always renders on ≥md). */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** The <md editor-open flag: rows open the editor below the stacked list;
   * the "← All sections" back affordance closes it (≥md ignores it — the
   * pane is always rendered there). */
  const [mobileEditorOpen, setMobileEditorOpen] = useState(false);
  /** The client-side filter (id + human title). */
  const [filter, setFilter] = useState("");
  const [confirmRevertAll, setConfirmRevertAll] = useState(false);
  const [revertAllBusy, setRevertAllBusy] = useState(false);

  const overriddenSections = report.sections.filter((s) => s.overridden);

  /** The default selection: the FIRST overridden row (the interesting one)
   * — else the registry's `identity` anchor, else the first row. */
  const fallbackId =
    overriddenSections[0]?.id ??
    report.sections.find((s) => s.id === "identity")?.id ??
    report.sections[0]?.id ??
    null;
  /** The sticky last selection — after a revert flips a row back to
   * default, the fallback alone would yank the editor away from the
   * section the user is looking at; remembering the last resolved id
   * keeps it in place (the write side of the render below, same value
   * every render — idempotent under StrictMode). */
  const lastSelectionRef = useRef<string | null>(null);
  const idSet = new Set(report.sections.map((s) => s.id));
  const resolvedSelected = selectedId !== null && idSet.has(selectedId) ? selectedId : null;
  const selection =
    resolvedSelected ??
    (lastSelectionRef.current !== null && idSet.has(lastSelectionRef.current)
      ? lastSelectionRef.current
      : fallbackId);
  lastSelectionRef.current = selection;
  const selected = report.sections.find((s) => s.id === selection) ?? null;

  const selectSection = (id: string) => {
    setSelectedId(id);
    setMobileEditorOpen(true);
  };

  /** The client-side filter — matches the mono id AND the human title. */
  const query = filter.trim().toLowerCase();
  const matches = (s: PromptSectionView): boolean =>
    query === "" ||
    s.id.toLowerCase().includes(query) ||
    sectionTitle(s.id).toLowerCase().includes(query);
  const visibleGroups = BUCKET_ORDER.map((bucket) => ({
    bucket,
    rows: report.sections.filter((s) => s.bucket === bucket && matches(s)),
  })).filter((group) => group.rows.length > 0);

  /** THE "manage it properly" affordance — every override reverts in ONE
   * guarded action: DELETE per section via Promise.allSettled, the honest
   * per-section failure report, the shared invalidation. */
  const revertAll = async (): Promise<void> => {
    const ids = overriddenSections.map((s) => s.id);
    if (ids.length === 0) {
      setConfirmRevertAll(false);
      return;
    }
    setRevertAllBusy(true);
    const results = await Promise.allSettled(ids.map((id) => deletePromptOverride(root, id)));
    const failures = results
      .map((result, i) =>
        result.status === "rejected"
          ? {
              id: ids[i],
              reason: result.reason instanceof Error ? result.reason.message : String(result.reason),
            }
          : null,
      )
      .filter((f): f is { id: string; reason: string } => f !== null);
    if (failures.length === 0) {
      note(
        `Reverted ${ids.length.toLocaleString("en-US")} section${ids.length === 1 ? "" : "s"} — the built-in composition is back.`,
      );
    } else {
      const kept = ids.length - failures.length;
      const detail = failures.map((f) => `${f.id} (${f.reason})`).join("; ");
      note(
        `Reverted ${kept.toLocaleString("en-US")} of ${ids.length.toLocaleString("en-US")} — could not revert: ${detail}`,
        true,
      );
    }
    invalidate();
    setRevertAllBusy(false);
    setConfirmRevertAll(false);
  };

  return (
    <>
      {/* The engine's own diagnostics, rendered honestly (role=alert — they
          describe real state, e.g. an empty drop or a stray _order.txt). */}
      {report.diagnostics.length > 0 && (
        <div
          role="alert"
          data-testid="prompt-diagnostics"
          className="rounded-xl border-[1.5px] px-3 py-2.5"
          style={{
            borderColor: withAlpha(SEMANTIC_COLORS.warning, 0.4),
            background: withAlpha(SEMANTIC_COLORS.warning, 0.08),
          }}
        >
          <div className="text-[11px] font-semibold" style={{ color: SEMANTIC_COLORS.warning }}>
            Override diagnostics
          </div>
          <ul className="mt-1 flex flex-col gap-0.5">
            {report.diagnostics.map((line) => (
              <li
                key={line}
                className="text-[11px] leading-relaxed"
                style={{ color: styles.textSecondary }}
              >
                {line}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── THE TWO PANES (master-detail-lite): ≥md the grouped list beside
              the editor; <md the list stacks above the editor (the selected
              row hidden while its editor is open, the back affordance on
              the editor header). */}
      <div className="flex flex-col gap-4 md:flex-row md:items-stretch">
        {/* LEFT — the master list: search + bucket groups + the revert-all
                footer. The list owns its scroll (max-h + the app's thin
                pill scrollbar — the long-list discipline). */}
        <div
          className="flex w-full flex-col overflow-hidden rounded-xl border-[1.5px] md:w-[300px] md:shrink-0 md:max-h-[560px]"
          style={{ background: styles.bg, borderColor: styles.border }}
          aria-label="Prompt sections list"
        >
          <div className="relative shrink-0 border-b p-2" style={{ borderColor: styles.border }}>
            <Search
              size={11}
              className="pointer-events-none absolute left-[18px] top-1/2 -translate-y-1/2"
              style={{ color: styles.textTertiary }}
              aria-hidden
            />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter sections…"
              aria-label="Filter the prompt sections"
              data-testid="prompt-search-input"
              className="h-8 w-full rounded-lg border-[1.5px] pl-[26px] pr-2.5 text-[12px] outline-none"
              style={{ background: styles.bg, borderColor: styles.border, color: styles.text }}
            />
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-1.5">
            {visibleGroups.map((group) => (
              <div key={group.bucket} className="flex flex-col gap-0.5">
                <div
                  className="flex items-center gap-1.5 px-1.5 pb-0.5 pt-1"
                  data-testid={`prompt-bucket-group-${group.bucket}`}
                >
                  {/* R100-E2: the group label is the label tier — the ONE
                      Kicker spelling (11px/500/0.08em), TOKENS.md §2. */}
                  <Kicker>{BUCKET_GROUP_LABELS[group.bucket]}</Kicker>
                  {" "}
                  <span className="font-mono text-[10px] tabular-nums" style={{ color: styles.textTertiary }}>
                    {group.rows.length}
                  </span>
                </div>
                {group.rows.map((section) => (
                  <SectionRow
                    key={section.id}
                    section={section}
                    active={section.id === selection}
                    hiddenOnMobile={mobileEditorOpen && section.id === selection}
                    onSelect={() => selectSection(section.id)}
                  />
                ))}
              </div>
            ))}
            {query !== "" && visibleGroups.length === 0 && (
              <p
                className="px-2 py-3 text-[11px]"
                style={{ color: styles.textTertiary }}
                data-testid="prompt-search-empty"
              >
                No section matches &ldquo;{filter.trim()}&rdquo;
              </p>
            )}
          </div>
          {/* The quiet list footer — the one-place "manage it properly"
                  affordance. */}
          {overriddenSections.length > 0 && (
            <div
              className="flex shrink-0 items-center gap-2 border-t px-2.5 py-1.5"
              style={{ borderColor: styles.border }}
            >
              <span
                className="text-[11px] tabular-nums"
                style={{ color: styles.textTertiary }}
                data-testid="prompt-overridden-count"
              >
                {overriddenSections.length.toLocaleString("en-US")} overridden
              </span>
              <span className="flex-1" />
              <button
                type="button"
                onClick={() => setConfirmRevertAll(true)}
                disabled={revertAllBusy}
                data-testid="prompt-revert-all"
                title="Remove every override file — each section returns to its built-in composition"
                className="h-7 shrink-0 rounded-lg px-2.5 text-[11px] font-semibold disabled:opacity-50"
                style={{ color: SEMANTIC_COLORS.danger }}
              >
                {revertAllBusy ? "Reverting…" : "Revert all…"}
              </button>
            </div>
          )}
        </div>

        {/* RIGHT — the detail pane: the selected section's header + editor.
                Below md it renders only while the mobile editor is open
                (`hidden md:flex`); ≥md it is always present. */}
        <div
          className={`min-w-0 flex-1 flex-col overflow-hidden rounded-xl border-[1.5px] ${
            mobileEditorOpen ? "flex" : "hidden md:flex"
          }`}
          style={{ background: styles.bg, borderColor: styles.border }}
          aria-label="Selected prompt section"
          data-testid="prompt-detail-pane"
        >
          {selected === null ? (
            <p className="px-4 py-6 text-[12px]" style={{ color: styles.textTertiary }}>
              Select a section from the list to edit its override.
            </p>
          ) : (
            <>
              <div
                className="flex flex-col gap-1.5 border-b px-3.5 py-3"
                style={{ borderColor: styles.border }}
              >
                <button
                  type="button"
                  onClick={() => setMobileEditorOpen(false)}
                  aria-label="Back to all sections"
                  className="flex h-7 w-fit items-center gap-1 rounded-lg px-1.5 text-[11px] font-semibold md:hidden"
                  style={{ color: styles.textSecondary }}
                >
                  <ArrowLeft size={11} /> All sections
                </button>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[13px] font-semibold" style={{ color: styles.text }}>
                    {sectionTitle(selected.id)}
                  </span>
                  {/* The bucket badge — §2 identity-chip grammar (mono, subtle bg). */}
                  <span
                    data-testid={`prompt-bucket-${selected.id}`}
                    title={BUCKET_TITLES[selected.bucket]}
                    className="shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider"
                    style={{ background: styles.subtle, color: styles.textTertiary }}
                  >
                    {selected.bucket}
                  </span>
                  <span
                    data-testid={`prompt-detail-kind-${selected.id}`}
                    className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider"
                    style={{ background: "transparent", color: styles.textTertiary }}
                    title={
                      selected.dynamic
                        ? "Dynamic — composed per turn from live context"
                        : "Static — the same text every turn"
                    }
                  >
                    {selected.dynamic ? "dynamic" : "static"}
                  </span>
                  <span className="flex-1" />
                  <span
                    data-testid={`prompt-detail-status-${selected.id}`}
                    className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider"
                    style={
                      selected.overridden
                        ? { background: withAlpha(styles.accent, 0.14), color: styles.accent }
                        : selected.present
                          ? { background: styles.subtle, color: styles.textTertiary }
                          : {
                              background: withAlpha(SEMANTIC_COLORS.warning, 0.1),
                              color: SEMANTIC_COLORS.warning,
                            }
                    }
                  >
                    {selected.overridden ? "overridden" : selected.present ? "default" : "absent"}
                  </span>
                </div>
                {/* The override file this section's edit writes — the mono
                        anchor the R98 rows carried, kept precise. */}
                <span className="w-fit font-mono text-[10px] break-all" style={{ color: styles.textTertiary }}>
                  .acute/prompts/{selected.id}.md
                </span>
                {/* The one-line description — the registry's own text, served
                        by the GET (no second source of truth in-file). */}
                <ClampedText
                  text={selected.description}
                  lines={2}
                  style={{ color: styles.textSecondary, fontSize: 11, lineHeight: 1.5 }}
                />
                {/* R117-b: the LIVE-MEMORY warning — the project-memory
                        section is the one whose built-in text carries the
                        live memory digest every turn; an override replaces
                        that injection wholesale (the owner taking
                        responsibility, the R59-F engine's rule). One line,
                        warning-tinted, only when an override exists. */}
                {selected.id === "project-memory" && selected.overridden ? (
                  <p
                    data-testid="prompt-memory-override-warning"
                    className="w-fit rounded-full px-2 py-0.5 text-[10px] font-medium"
                    style={{
                      background: withAlpha(SEMANTIC_COLORS.warning, 0.1),
                      color: SEMANTIC_COLORS.warning,
                    }}
                  >
                    An override replaces the live memory injection
                  </p>
                ) : null}
              </div>
              <div className="p-3.5">
                <SectionEditor
                  key={`${selected.id}:${selected.overrideContent ?? ""}`}
                  root={root}
                  section={selected}
                  invalidate={invalidate}
                  onNote={note}
                />
              </div>
            </>
          )}
        </div>
      </div>

      <p className="text-[11px]" style={{ color: styles.textTertiary }}>
        Presence is honest: tool-gated and conditional sections report absent for this project&apos;s
        current composition; a real session with a narrower tool allowlist composes fewer sections.
        Overrides live in this project&apos;s{" "}
        <span className="font-mono" style={{ color: styles.textSecondary }}>
          .acute/prompts/
        </span>
        .
      </p>

      {/* The revert-all confirm — the shared dialog owns the exact
          enumeration of what reverts. */}
      {confirmRevertAll && (
        <ConfirmDialog
          title="Revert every override?"
          message={`This removes the ${overriddenSections.length.toLocaleString("en-US")} override file${
            overriddenSections.length === 1 ? "" : "s"
          } — each section returns to its built-in composition.`}
          confirmLabel="Revert all"
          danger
          onConfirm={() => void revertAll()}
          onClose={() => setConfirmRevertAll(false)}
        >
          <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
            {overriddenSections.map((s) => (
              <li
                key={s.id}
                className="font-mono text-[11px]"
                style={{ color: styles.textSecondary }}
                data-testid={`prompt-revert-all-item-${s.id}`}
              >
                {s.id}
              </li>
            ))}
          </ul>
        </ConfirmDialog>
      )}
    </>
  );
}

/* ── The system-prompt card (framing + master-detail-lite) ────────────────── */

/** The framing + the gated work area — ONE bento card so the scope line and
 * the work surface read as one story. The framing header survives the
 * loading/error gates (the scope line says WHAT failed to load). */
function SystemPromptCard({ root, projectName }: { root: string; projectName: string }) {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const resetAfter = useTimeoutClear();
  const [msg, setMsg] = useState<string | null>(null);
  const [msgIsError, setMsgIsError] = useState(false);

  const sectionsQuery = useQuery({
    queryKey: ["prompt-sections", root],
    queryFn: () => fetchPromptSections(root),
  });

  /** Every write (save/revert/revert-all) refreshes BOTH the registry
   * picture and the live preview — the two surfaces of the same engine. */
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["prompt-sections", root] });
    void queryClient.invalidateQueries({ queryKey: ["prompt-preview", root] });
  };

  const note = (text: string, isError = false) => {
    setMsg(text);
    setMsgIsError(isError);
    resetAfter(() => setMsg(null), 2500);
  };

  const report = sectionsQuery.data;
  const gate: "error" | "loading" | "ready" =
    sectionsQuery.isError && report === undefined
      ? "error"
      : sectionsQuery.isPending && sectionsQuery.isFetching
        ? "loading"
        : "ready";

  const overriddenCount = report?.sections.filter((s) => s.overridden).length ?? 0;
  const totalEstChars = report?.sections.reduce((sum, s) => sum + effectiveChars(s), 0) ?? 0;
  const totalEstTokens = estimateTokens(totalEstChars);

  return (
    /* R100-E2: the SectionCard primitive (rounded-2xl / 1.5px border-line /
       bg-card) — the testid + aria-label passthrough keeps the card's
       accessible name. */
    <SectionCard
      className="flex flex-col gap-4 p-4 md:p-5"
      ariaLabel="System prompt"
      testId="prompt-manager-card"
    >
      {/* ── THE FRAMING — what this surface IS (the owner's project-wide
              verdict, said out loud): the scope line + the honest chips. */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          {/* R100-E2: the framing title snapped 16px/font-black → 13px/600
              (the ladder's section tier, TOKENS.md §2). */}
          <h2 className="text-[13px] font-semibold" style={{ color: styles.text }} data-testid="prompt-framing-title">
            System prompt
          </h2>
          <span className="flex-1" />
          {msg && (
            <span
              className="text-[11px] font-medium"
              style={{ color: msgIsError ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.success }}
              role={msgIsError ? "alert" : undefined}
            >
              {msg}
            </span>
          )}
        </div>
        <p
          className="text-[12px] leading-relaxed"
          style={{ color: styles.textSecondary }}
          data-testid="prompt-scope-line"
        >
          The project-wide default instructions — every agent turn in{" "}
          <span className="font-medium" style={{ color: styles.text }}>
            {projectName}
          </span>{" "}
          starts from this prompt.
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          {report !== undefined ? (
            <>
              <span
                className="rounded-full px-2 py-0.5 font-mono text-[10px] tabular-nums"
                style={{ background: styles.subtle, color: styles.textTertiary }}
                title={`Rough estimate — the ${totalEstChars.toLocaleString("en-US")} composed characters ÷ 4. The live preview below shows the exact composition.`}
                data-testid="prompt-scope-tokens"
              >
                ~{fmtTokenEstimate(totalEstTokens)} tokens estimated
              </span>
              <span
                className="rounded-full px-2 py-0.5 font-mono text-[10px] tabular-nums"
                style={{ background: styles.subtle, color: styles.textTertiary }}
                title="Registry sections · sections carrying a .acute/prompts override file"
                data-testid="prompt-scope-counts"
              >
                {report.sections.length.toLocaleString("en-US")} sections ·{" "}
                {overriddenCount.toLocaleString("en-US")} overridden
              </span>
            </>
          ) : gate === "loading" ? (
            /* The chip-shaped pills — the loading skeleton mirrors the
                 framing geometry (the anti-jitter discipline). */
            <>
              <SkeletonBlock className="h-[18px] w-[140px] rounded-full" />
              <SkeletonBlock className="h-[18px] w-[160px] rounded-full" />
            </>
          ) : null}
        </div>
      </div>

      {/* ── The R97-I gates (the data region only — the framing stays). */}
      {gate === "error" && (
        <section
          aria-label="Prompt sections"
          data-testid="prompt-sections-error"
          className="rounded-2xl border-[1.5px] px-4 py-3.5"
          style={{
            borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.35),
            background: withAlpha(SEMANTIC_COLORS.danger, 0.08),
          }}
        >
          <div role="alert">
            <div className="text-[13px] font-semibold" style={{ color: SEMANTIC_COLORS.danger }}>
              Could not load the prompt sections
            </div>
            <p className="mt-1.5 text-[12px] leading-relaxed" style={{ color: styles.textSecondary }}>
              The agent sidecar may be down or the request was rejected —{" "}
              {sectionsQuery.error instanceof Error
                ? sectionsQuery.error.message
                : String(sectionsQuery.error)}
              . Nothing was changed.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void sectionsQuery.refetch()}
            aria-label="Retry loading the prompt sections"
            className="mt-3 h-8 cursor-pointer rounded-lg border px-3.5 text-[12px] font-semibold transition-opacity hover:opacity-85"
            style={{ borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.45), color: SEMANTIC_COLORS.danger }}
          >
            Retry
          </button>
        </section>
      )}

      {gate === "loading" && (
        <section
          data-testid="prompt-sections-loading"
          role="status"
          aria-label="Loading prompt sections"
          className="flex flex-col gap-4"
        >
          {/* The two panes — the ~300px master beside the detail column
              (the skeleton mirrors the READY geometry). */}
          <div className="flex flex-col gap-4 md:flex-row">
            <div className="w-full md:w-[300px] md:shrink-0">
              <SkeletonRows rows={6} rowClassName="h-[52px] rounded-lg" />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-3">
              <SkeletonBlock className="h-[44px] rounded-lg" />
              <SkeletonBlock className="h-[150px] rounded-lg" />
            </div>
          </div>
        </section>
      )}

      {gate === "ready" && report !== undefined && (
        <PromptWorkArea root={root} report={report} invalidate={invalidate} note={note} />
      )}
    </SectionCard>
  );
}

/* ── The composed-prompt card (the promoted preview) ──────────────────────── */

/** The composed effective prompt — GET /prompts/preview, fetched only while
 *  open (the collapsible pane), refreshed by every save/revert/revert-all
 *  (the shared ["prompt-preview", root] invalidation). */
function PreviewCard({ root }: { root: string }) {
  const styles = useThemeStyles();
  const [open, setOpen] = useState(false);

  const previewQuery = useQuery({
    queryKey: ["prompt-preview", root],
    queryFn: () => fetchPromptPreview(root),
    enabled: open,
  });

  return (
    /* R100-E2: the SectionCard primitive (rounded-2xl / 1.5px border-line /
       bg-card) — the testid + aria-label passthrough keeps the card's
       accessible name. */
    <SectionCard
      className="flex flex-col gap-2.5 p-4"
      ariaLabel="Composed prompt preview"
      testId="prompt-preview-card"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <Eye size={13} style={{ color: styles.accent, opacity: 0.8 }} />
        <span className="text-[13px] font-semibold" style={{ color: styles.text }}>
          Composed prompt
        </span>
        <span className="text-[12px]" style={{ color: styles.textSecondary }}>
          — what the agent actually receives
        </span>
        <span className="flex-1" />
        {open && previewQuery.data !== undefined && (
          <span
            className="rounded-full px-1.5 py-0.5 font-mono text-[10px] tabular-nums"
            style={{ background: styles.subtle, color: styles.textTertiary }}
            title="Total characters of the composed effective sections · the ~token estimate (chars ÷ 4)"
            data-testid="prompt-preview-total"
          >
            {previewQuery.data.totalChars.toLocaleString("en-US")} chars · ~
            {fmtTokenEstimate(estimateTokens(previewQuery.data.totalChars))} tokens
          </span>
        )}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? "Hide the composed prompt preview" : "Show the composed prompt preview"}
          className="h-7 shrink-0 rounded-lg px-2.5 text-[11px] font-semibold"
          style={{
            background: open ? withAlpha(styles.accent, 0.12) : styles.subtle,
            color: open ? styles.accent : styles.textSecondary,
          }}
        >
          {open ? "Hide" : "Show"}
        </button>
      </div>
      <p className="text-[11px] leading-relaxed" style={{ color: styles.textSecondary }}>
        The composed effective sections in order — the representative composition (full tool set,
        this project&apos;s rules, its pinned skills), refreshed after every save or revert.
      </p>

      {open &&
        (previewQuery.isError ? (
          <div
            role="alert"
            data-testid="prompt-preview-error"
            className="rounded-xl border-[1.5px] px-3 py-2.5"
            style={{
              borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.35),
              background: withAlpha(SEMANTIC_COLORS.danger, 0.08),
            }}
          >
            <div className="text-[11px] font-semibold" style={{ color: SEMANTIC_COLORS.danger }}>
              Could not load the prompt preview
            </div>
            <p className="mt-1 text-[11px] leading-relaxed" style={{ color: styles.textSecondary }}>
              {previewQuery.error instanceof Error
                ? previewQuery.error.message
                : String(previewQuery.error)}
            </p>
            <button
              type="button"
              onClick={() => void previewQuery.refetch()}
              aria-label="Retry loading the prompt preview"
              className="mt-2 h-7 cursor-pointer rounded-lg border px-3 text-[11px] font-semibold transition-opacity hover:opacity-85"
              style={{
                borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.45),
                color: SEMANTIC_COLORS.danger,
              }}
            >
              Retry
            </button>
          </div>
        ) : previewQuery.isPending && previewQuery.isFetching ? (
          <div role="status" aria-label="Loading the prompt preview">
            <SkeletonRows rows={3} rowClassName="h-[76px] rounded-lg" />
          </div>
        ) : previewQuery.data === undefined ? null : (
          <div className="flex flex-col gap-2" data-testid="prompt-preview-body">
            {previewQuery.data.sections.map((s) => (
              <div key={s.id} data-preview-section={s.id}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className="min-w-0 truncate font-mono text-[11px] font-medium"
                    style={{ color: styles.text }}
                  >
                    {s.id}
                  </span>
                  <span
                    className="font-mono text-[10px] tabular-nums"
                    style={{ color: styles.textTertiary }}
                    title={`${s.text.length.toLocaleString("en-US")} characters ≈ ${estimateTokens(s.text.length).toLocaleString("en-US")} tokens (chars ÷ 4)`}
                    data-testid={`prompt-preview-metrics-${s.id}`}
                  >
                    {s.text.length.toLocaleString("en-US")} chars · ~
                    {fmtTokenEstimate(estimateTokens(s.text.length))} tokens
                  </span>
                  <span className="flex-1" />
                  {s.overridden && (
                    <span
                      data-testid={`preview-overridden-${s.id}`}
                      className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider"
                      style={{ background: withAlpha(styles.accent, 0.14), color: styles.accent }}
                    >
                      overridden
                    </span>
                  )}
                </div>
                <pre
                  className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-xl p-2.5 font-mono text-[11px] leading-relaxed"
                  style={{
                    background: styles.subtle,
                    border: bdr("1.5px", styles.borderSubtle),
                    color: s.overridden ? styles.text : styles.textSecondary,
                  }}
                >
                  {s.text}
                </pre>
              </div>
            ))}
          </div>
        ))}
    </SectionCard>
  );
}

/* ── Composition ──────────────────────────────────────────────────────────── */

/** The dedicated Prompts settings tab (?tab=prompts). */
export function PromptsTab() {
  const styles = useThemeStyles();
  // No settings-tab precedent tracks a "current project" (the chat store's
  // activeProjectId is session-scoped) — the overrides are per-project, so
  // the tab owns a picker over the canonical useProjects() query, defaulting
  // to the first registered project.
  const projects = useProjects();
  const [selectedRoot, setSelectedRoot] = useState<string | null>(null);
  // The honest fallback: a selection that vanished from the list (deleted
  // project) settles back to the first row instead of a dead root.
  const root =
    selectedRoot !== null && projects.data?.some((p) => p.rootPath === selectedRoot)
      ? selectedRoot
      : (projects.data?.[0]?.rootPath ?? null);
  // The framing's scope line interpolates the project's NAME (its root
  // path as the honest fallback).
  const projectName = projects.data?.find((p) => p.rootPath === root)?.name || root || "";

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4" data-testid="prompts-tab">
      {/* ── The project picker — ABOVE the framing card (the scope line
              describes whatever this selects). */}
      {projects.isError ? (
        <div
          role="alert"
          data-testid="prompts-projects-error"
          className="rounded-2xl border-[1.5px] px-4 py-3.5"
          style={{
            borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.35),
            background: withAlpha(SEMANTIC_COLORS.danger, 0.08),
          }}
        >
          <div className="text-[13px] font-semibold" style={{ color: SEMANTIC_COLORS.danger }}>
            Could not load the projects
          </div>
          <p className="mt-1.5 text-[12px] leading-relaxed" style={{ color: styles.textSecondary }}>
            The agent sidecar may be down or the request was rejected —{" "}
            {projects.error instanceof Error ? projects.error.message : String(projects.error)}.
          </p>
          <button
            type="button"
            onClick={() => void projects.refetch()}
            aria-label="Retry loading the projects"
            className="mt-3 h-8 cursor-pointer rounded-lg border px-3.5 text-[12px] font-semibold transition-opacity hover:opacity-85"
            style={{
              borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.45),
              color: SEMANTIC_COLORS.danger,
            }}
          >
            Retry
          </button>
        </div>
      ) : projects.isPending && projects.isFetching ? (
        <div
          role="status"
          aria-label="Loading the projects"
          className="rounded-2xl border-[1.5px] p-4"
          style={{ background: styles.card, borderColor: styles.border }}
        >
          <SkeletonRows rows={1} rowClassName="h-10 rounded-lg" />
        </div>
      ) : root === null ? (
        <div
          className="rounded-2xl border-[1.5px] p-4 text-[12px]"
          style={{ background: styles.card, borderColor: styles.border, color: styles.textSecondary }}
        >
          No registered projects yet — register one from the dashboard to customize its prompts.
        </div>
      ) : (
        <div
          className="flex flex-col gap-1.5 rounded-2xl border-[1.5px] p-4"
          style={{ background: styles.card, borderColor: styles.border }}
          aria-label="Project picker"
        >
          <label
            className="text-[11px] font-medium"
            style={{ color: styles.textSecondary }}
            htmlFor="prompts-project"
          >
            Project
          </label>
          <select
            id="prompts-project"
            value={root}
            onChange={(e) => setSelectedRoot(e.target.value)}
            aria-label="Project whose prompt sections are customized"
            data-testid="prompts-project-select"
            className="h-8 w-full max-w-[380px] rounded-lg border-[1.5px] px-2.5 font-mono text-[12px] outline-none"
            style={{ background: styles.bg, borderColor: styles.border, color: styles.text }}
          >
            {projects.data?.map((p) => (
              <option key={p.id} value={p.rootPath}>
                {p.name || p.rootPath}
              </option>
            ))}
          </select>
          <span className="font-mono text-[11px] break-all" style={{ color: styles.textTertiary }}>
            {root}
          </span>
        </div>
      )}

      {root !== null && <SystemPromptCard root={root} projectName={projectName} />}
      {root !== null && <PreviewCard root={root} />}
    </div>
  );
}

export default PromptsTab;
