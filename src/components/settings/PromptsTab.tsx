import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Eye, EyeOff, FileText, RotateCcw } from "lucide-react";
import { useProjects } from "../../hooks/use-projects";
import { useTimeoutClear } from "../../hooks/use-timeout-clear";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { bdr, withAlpha } from "../dashboard/helpers";
import { ClampedText } from "../shared/ClampedText";
import { SkeletonRows } from "../shared/Skeletons";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  deletePromptOverride,
  fetchPromptPreview,
  fetchPromptSections,
  savePromptOverride,
  type PromptSectionBucket,
  type PromptSectionView,
} from "../../lib/api";

/**
 * PromptsTab — ROUND-98 (R98-E1/E3, owner: "add prompt customizability
 * functionality… handle and improve the system prompts better, customizing
 * them better in the settings, getting a proper visual experience"): the
 * Settings surface over the R59-F override ENGINE (`.acute/prompts/<id>.md` —
 * replace wholesale / empty = drop / DELETE = revert), finally exposed over
 * REST by routes/prompts.ts.
 *
 * LAYOUT CHOICE (documented per the workstream brief): EXPANDABLE ROWS, not
 * master-detail. The api tab's master-detail exists because provider forms
 * are wide and benefit from the viewport-locked two-pane; here the editor is
 * one mono textarea + a collapsed reference block, the deep-link render
 * branch follows the other form tabs' max-w column pattern, and the sibling
 * prompt-modules tab (SkillsTab) already establishes the expandable-row
 * idiom. ~30 short rows with one-at-a-time expansion stays scannable.
 *
 * State gates per R97-I: loading = the shared Skeleton primitives with ONE
 * role="status" announcement; error = role="alert" with the exact cause and
 * one Retry. The two destructive-ish levers are named honestly: an EMPTY
 * save confirms through ConfirmDialog (the DROP semantics), Revert is a
 * single click (it restores the built-in text — the safe direction).
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

/** §2 identity-chip grammar for the bucket badge (mono, subtle bg — the
 * context-meter bucket the section's lines bill to). */
const BUCKET_TITLES: Record<PromptSectionBucket, string> = {
  identity: "identity bucket — the always-present core",
  tools: "tools bucket — the tool-use disciplines",
  memory: "memory bucket — the memory/context lines",
  meta: "meta bucket — the session bookkeeping",
};

/* ── The per-section editor ────────────────────────────────────────────────── */

/** The override editor for ONE section — remounted per section (key={id},
 * the SkillEditor pattern) so the draft always initializes from the CURRENT
 * overrideContent after invalidation refetches. */
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
    <div
      className="flex flex-col gap-2.5 border-t px-3 pb-3 pt-2.5"
      style={{ borderColor: styles.borderSubtle }}
      data-testid={`prompt-editor-${section.id}`}
    >
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
            className="flex h-7 items-center gap-1.5 rounded-[8px] px-2 text-[11px] font-bold shrink-0"
            style={{ background: styles.subtle, color: styles.textSecondary }}
          >
            {showDefault ? <EyeOff size={11} /> : <Eye size={11} />}
            {showDefault ? "Hide default" : "Show default"}
          </button>
          {showDefault && (
            <pre
              data-testid={`prompt-default-${section.id}`}
              className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-[10px] p-2.5 font-mono text-[11px] leading-relaxed"
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
        <p className="text-[10.5px]" style={{ color: styles.textTertiary }}>
          Absent in this project&apos;s current composition — there is no default text to show; an
          override would still apply the moment the section composes.
        </p>
      )}

      <div>
        <label
          className="mb-1 block text-[10.5px] font-bold"
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
          className="w-full resize-y rounded-[8px] border-[1.5px] px-2.5 py-2 font-mono text-[11px] leading-relaxed outline-none"
          style={{ background: styles.bg, borderColor: styles.border, color: styles.text }}
        />
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <span
          className="font-mono text-[10.5px]"
          style={{ color: draft.length >= OVERRIDE_CHAR_CAP ? SEMANTIC_COLORS.warning : styles.textTertiary }}
          data-testid={`prompt-counter-${section.id}`}
        >
          {draft.length.toLocaleString("en-US")} / {OVERRIDE_CHAR_CAP.toLocaleString("en-US")} chars
        </span>
        <span className="flex-1" />
        {/* The standing drop hint — the confirm dialog repeats it on click. */}
        {emptySave && dirty && (
          <span
            className="text-[10.5px] font-bold"
            style={{ color: SEMANTIC_COLORS.warning }}
            data-testid={`prompt-drop-hint-${section.id}`}
          >
            Saving this empty override REMOVES the section from the prompt entirely.
          </span>
        )}
      </div>

      {capNote && (
        <p
          className="text-[11px] font-bold"
          style={{ color: SEMANTIC_COLORS.warning }}
          data-testid={`prompt-cap-note-${section.id}`}
        >
          {capNote}
        </p>
      )}
      {error && (
        <p
          className="text-[11px] font-bold"
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
          className="h-8 shrink-0 rounded-[8px] px-3 text-[11px] font-bold disabled:opacity-50"
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
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-[8px] px-3 text-[11px] font-bold disabled:opacity-50"
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

/* ── The section-list card ─────────────────────────────────────────────────── */

function SectionsCard({ root }: { root: string }) {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const resetAfter = useTimeoutClear();
  const [msg, setMsg] = useState<string | null>(null);
  const [msgIsError, setMsgIsError] = useState(false);
  /** The expanded section's id (one at a time). */
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const sectionsQuery = useQuery({
    queryKey: ["prompt-sections", root],
    queryFn: () => fetchPromptSections(root),
  });

  /** Every write (save/revert) refreshes BOTH the registry picture and the
   * live preview — the two surfaces of the same engine. */
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["prompt-sections", root] });
    void queryClient.invalidateQueries({ queryKey: ["prompt-preview", root] });
  };

  const note = (text: string, isError = false) => {
    setMsg(text);
    setMsgIsError(isError);
    resetAfter(() => setMsg(null), 2500);
  };

  /* R97-I gates — the error branch FIRST (a failed GET must never hang on
   * "loading…"), then the loading branch (the shared skeletons + ONE
   * role=status announcement). */
  if (sectionsQuery.isError && sectionsQuery.data === undefined) {
    const cause =
      sectionsQuery.error instanceof Error ? sectionsQuery.error.message : String(sectionsQuery.error);
    return (
      <section
        aria-label="Prompt sections"
        data-testid="prompt-sections-error"
        className="rounded-[16px] border-[1.5px] px-4 py-3.5"
        style={{
          borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.35),
          background: withAlpha(SEMANTIC_COLORS.danger, 0.08),
        }}
      >
        <div role="alert">
          <div className="text-[12.5px] font-bold" style={{ color: SEMANTIC_COLORS.danger }}>
            Could not load the prompt sections
          </div>
          <p className="mt-1.5 text-[12px] leading-relaxed" style={{ color: styles.textSecondary }}>
            The agent sidecar may be down or the request was rejected — {cause}. Nothing was changed.
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
    );
  }

  if (sectionsQuery.isPending && sectionsQuery.isFetching) {
    return (
      <section
        data-testid="prompt-sections-loading"
        role="status"
        aria-label="Loading prompt sections"
        className="rounded-[16px] border-[1.5px] p-4"
        style={{ background: styles.card, borderColor: styles.border }}
      >
        <SkeletonRows rows={7} rowClassName="h-[46px] rounded-[10px]" />
      </section>
    );
  }

  const report = sectionsQuery.data;
  if (report === undefined) return null;

  const overriddenCount = report.overridden.length;

  return (
    <section
      className="flex flex-col gap-2.5 rounded-[16px] border-[1.5px] p-4"
      style={{ background: styles.card, borderColor: styles.border }}
      aria-label="Prompt sections"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <FileText size={13} style={{ color: styles.accent, opacity: 0.8 }} />
        <span className="text-[13px] font-bold" style={{ color: styles.text }}>
          Prompt sections
        </span>
        <span
          className="font-mono text-[9.5px] rounded-full px-1.5 py-0.5"
          style={{ background: styles.subtle, color: styles.textTertiary }}
          title="Sections carrying a .acute/prompts override file"
        >
          {overriddenCount} overridden · {report.sections.length} sections
        </span>
        <span className="flex-1" />
        {msg && (
          <span
            className="text-[11px] font-bold"
            style={{ color: msgIsError ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.success }}
          >
            {msg}
          </span>
        )}
      </div>
      <p className="text-[11px] leading-relaxed" style={{ color: styles.textSecondary }}>
        Overrides live in this project&apos;s{" "}
        <span className="font-mono" style={{ color: styles.text }}>
          .acute/prompts/
        </span>{" "}
        — they apply to every agent turn in it. Non-empty text replaces the section wholesale
        (dynamic parts included); reverting restores the built-in composition.
      </p>

      {/* The engine's own diagnostics, rendered honestly (role=alert — they
          describe real state, e.g. an empty drop or a stray _order.txt). */}
      {report.diagnostics.length > 0 && (
        <div
          role="alert"
          data-testid="prompt-diagnostics"
          className="rounded-[10px] border-[1.5px] px-3 py-2.5"
          style={{
            borderColor: withAlpha(SEMANTIC_COLORS.warning, 0.4),
            background: withAlpha(SEMANTIC_COLORS.warning, 0.08),
          }}
        >
          <div className="text-[11px] font-bold" style={{ color: SEMANTIC_COLORS.warning }}>
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

      <div
        className="overflow-hidden rounded-[10px] border-[1.5px]"
        style={{ borderColor: styles.border }}
      >
        {report.sections.map((section) => {
          const isOpen = expandedId === section.id;
          return (
            <div
              key={section.id}
              data-section-id={section.id}
              className="border-b last:border-b-0"
              style={{ borderColor: styles.borderSubtle }}
            >
              <button
                type="button"
                onClick={() => setExpandedId(isOpen ? null : section.id)}
                aria-expanded={isOpen}
                aria-label={`Expand section ${section.id}`}
                title={isOpen ? "Collapse the editor" : "Open the override editor"}
                className="flex w-full items-center gap-2 px-3 py-2 text-left flex-wrap"
              >
                <ChevronDown
                  size={12}
                  className="shrink-0"
                  style={{
                    color: styles.textTertiary,
                    transform: isOpen ? "rotate(180deg)" : "none",
                    transition: "transform 0.15s",
                  }}
                />
                <span
                  className="min-w-0 truncate font-mono text-[12px] font-bold"
                  style={{ color: styles.text }}
                  title={section.id}
                >
                  {section.id}
                </span>
                {/* The bucket badge — §2 identity-chip grammar (mono, subtle bg). */}
                <span
                  data-testid={`prompt-bucket-${section.id}`}
                  title={BUCKET_TITLES[section.bucket]}
                  className="shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider"
                  style={{ background: styles.subtle, color: styles.textTertiary }}
                >
                  {section.bucket}
                </span>
                <span
                  className="shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wider"
                  style={{ background: "transparent", color: styles.textTertiary }}
                  title={
                    section.dynamic
                      ? "Dynamic — composed per turn from live context"
                      : "Static — the same text every turn"
                  }
                >
                  {section.dynamic ? "dynamic" : "static"}
                </span>
                <span className="flex-1" />
                {/* The status chip — ONE per row: OVERRIDDEN is accent-tinted,
                    DEFAULT neutral, ABSENT (conditional section not composed
                    here) the amber warning. */}
                <span
                  data-testid={`prompt-status-${section.id}`}
                  className="shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wider"
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
              </button>
              <div className="min-w-0 px-3 pb-2 pl-9">
                <ClampedText
                  text={section.description}
                  lines={1}
                  style={{ color: styles.textSecondary, fontSize: 11, lineHeight: 1.5 }}
                />
              </div>
              {isOpen && (
                <SectionEditor
                  key={section.id}
                  root={root}
                  section={section}
                  invalidate={invalidate}
                  onNote={note}
                />
              )}
            </div>
          );
        })}
      </div>
      <p className="text-[10.5px]" style={{ color: styles.textTertiary }}>
        Presence is honest: tool-gated and conditional sections report absent for this project&apos;s
        current composition; a real session with a narrower tool allowlist composes fewer sections.
      </p>
    </section>
  );
}

/* ── The live preview card ─────────────────────────────────────────────────── */

/** The composed effective prompt — GET /prompts/preview, fetched only while
 *  open (the collapsible pane), refreshed by every save/revert (the shared
 *  ["prompt-preview", root] invalidation). */
function PreviewCard({ root }: { root: string }) {
  const styles = useThemeStyles();
  const [open, setOpen] = useState(false);

  const previewQuery = useQuery({
    queryKey: ["prompt-preview", root],
    queryFn: () => fetchPromptPreview(root),
    enabled: open,
  });

  return (
    <section
      className="flex flex-col gap-2.5 rounded-[16px] border-[1.5px] p-4"
      style={{ background: styles.card, borderColor: styles.border }}
      aria-label="Live prompt preview"
      data-testid="prompt-preview-card"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <Eye size={13} style={{ color: styles.accent, opacity: 0.8 }} />
        <span className="text-[13px] font-bold" style={{ color: styles.text }}>
          Live preview
        </span>
        <span className="flex-1" />
        {open && previewQuery.data !== undefined && (
          <span
            className="font-mono text-[9.5px] rounded-full px-1.5 py-0.5"
            style={{ background: styles.subtle, color: styles.textTertiary }}
            title="Total characters of the composed effective sections"
            data-testid="prompt-preview-total"
          >
            {previewQuery.data.totalChars.toLocaleString("en-US")} chars
          </span>
        )}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? "Hide the composed prompt preview" : "Show the composed prompt preview"}
          className="h-7 shrink-0 rounded-[8px] px-2.5 text-[11px] font-bold"
          style={{
            background: open ? withAlpha(styles.accent, 0.12) : styles.subtle,
            color: open ? styles.accent : styles.textSecondary,
          }}
        >
          {open ? "Hide" : "Show"}
        </button>
      </div>
      <p className="text-[11px] leading-relaxed" style={{ color: styles.textSecondary }}>
        The composed effective sections in order — what the model actually receives (the
        representative composition: full tool set, this project&apos;s rules, its pinned skills).
      </p>

      {open &&
        (previewQuery.isError ? (
          <div
            role="alert"
            data-testid="prompt-preview-error"
            className="rounded-[10px] border-[1.5px] px-3 py-2.5"
            style={{
              borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.35),
              background: withAlpha(SEMANTIC_COLORS.danger, 0.08),
            }}
          >
            <div className="text-[11px] font-bold" style={{ color: SEMANTIC_COLORS.danger }}>
              Could not load the prompt preview
            </div>
            <p
              className="mt-1 text-[11px] leading-relaxed"
              style={{ color: styles.textSecondary }}
            >
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
            <SkeletonRows rows={3} rowClassName="h-[76px] rounded-[10px]" />
          </div>
        ) : previewQuery.data === undefined ? null : (
          <div className="flex flex-col gap-2" data-testid="prompt-preview-body">
            {previewQuery.data.sections.map((s) => (
              <div key={s.id} data-preview-section={s.id}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className="min-w-0 truncate font-mono text-[11px] font-bold"
                    style={{ color: styles.text }}
                  >
                    {s.id}
                  </span>
                  <span
                    className="font-mono text-[10px]"
                    style={{ color: styles.textTertiary }}
                    title={`${s.text.length.toLocaleString("en-US")} characters`}
                  >
                    {s.text.length.toLocaleString("en-US")}
                  </span>
                  <span className="flex-1" />
                  {s.overridden && (
                    <span
                      data-testid={`preview-overridden-${s.id}`}
                      className="shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wider"
                      style={{ background: withAlpha(styles.accent, 0.14), color: styles.accent }}
                    >
                      overridden
                    </span>
                  )}
                </div>
                <pre
                  className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-[10px] p-2.5 font-mono text-[10.5px] leading-relaxed"
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
    </section>
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

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4" data-testid="prompts-tab">
      <div className="pb-1">
        <h2 className="text-[16px] font-black" style={{ color: styles.text }}>
          Prompts
        </h2>
        <p className="mt-1 text-[12px]" style={{ color: styles.textSecondary }}>
          The system prompt&apos;s sections — override any of them per project, revert to the
          built-in text, or drop one entirely.
        </p>
      </div>

      {/* ── The project picker ── */}
      {projects.isError ? (
        <div
          role="alert"
          data-testid="prompts-projects-error"
          className="rounded-[16px] border-[1.5px] px-4 py-3.5"
          style={{
            borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.35),
            background: withAlpha(SEMANTIC_COLORS.danger, 0.08),
          }}
        >
          <div className="text-[12.5px] font-bold" style={{ color: SEMANTIC_COLORS.danger }}>
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
          className="rounded-[16px] border-[1.5px] p-4"
          style={{ background: styles.card, borderColor: styles.border }}
        >
          <SkeletonRows rows={1} rowClassName="h-10 rounded-[8px]" />
        </div>
      ) : root === null ? (
        <div
          className="rounded-[16px] border-[1.5px] p-4 text-[12px]"
          style={{ background: styles.card, borderColor: styles.border, color: styles.textSecondary }}
        >
          No registered projects yet — register one from the dashboard to customize its prompts.
        </div>
      ) : (
        <div
          className="flex flex-col gap-1.5 rounded-[16px] border-[1.5px] p-4"
          style={{ background: styles.card, borderColor: styles.border }}
          aria-label="Project picker"
        >
          <label
            className="text-[10.5px] font-bold"
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
            className="h-8 w-full max-w-[380px] rounded-[8px] border-[1.5px] px-2.5 font-mono text-[12px] outline-none"
            style={{ background: styles.bg, borderColor: styles.border, color: styles.text }}
          >
            {projects.data?.map((p) => (
              <option key={p.id} value={p.rootPath}>
                {p.name || p.rootPath}
              </option>
            ))}
          </select>
          <span className="font-mono text-[10.5px] break-all" style={{ color: styles.textTertiary }}>
            {root}
          </span>
        </div>
      )}

      {root !== null && <SectionsCard root={root} />}
      {root !== null && <PreviewCard root={root} />}
    </div>
  );
}

export default PromptsTab;
