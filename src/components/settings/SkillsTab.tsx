import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Plus, Sparkles, Trash2 } from "lucide-react";
import { useTimeoutClear } from "../../hooks/use-timeout-clear";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { isTauri } from "../../lib/sidecar";
import { withAlpha } from "../dashboard/helpers";
import { ClampedText } from "../shared/ClampedText";
import {
  createSkill,
  deleteSkill,
  listSkills,
  updateSkill,
  type SkillRecord,
} from "../../lib/api";

/**
 * SkillsTab — ROUND-61 (R61-2-a): the owner's "ability to add multiple
 * skills" — the dedicated settings surface for the skills store
 * (GET/POST /skills, PATCH/DELETE /skills/:id).
 *
 * Design mirrors SubAgentsTab (R58-d): one max-w-2xl column, section card
 * with the theme system, useQuery/useMutation + queryClient invalidation,
 * useTimeoutClear toasts, and the mode-aware coreUnreachableHint for load
 * errors. The api module is the ONLY backend surface touched here.
 */
const coreUnreachableHint = isTauri()
  ? "agent-core is not responding — if the connection banner is showing, use its Restart engine button, then reopen this tab."
  : "Agent core unreachable — start the app (or pnpm dev:full).";

/** The server's stance on built-in skills, surfaced verbatim in the UI. */
const BUILTIN_DELETE_NOTE =
  "built-in skills can be disabled or edited, not deleted — they reappear if removed from the database";

/** The card's own toggle (same track/thumb markup as ModelsProvidersTab). */
function ToggleSwitch({
  checked,
  onToggle,
  label,
  title,
  disabled,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
  title?: string;
  disabled?: boolean;
}) {
  const styles = useThemeStyles();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={onToggle}
      className="relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors disabled:cursor-wait disabled:opacity-60"
      style={{
        background: checked ? styles.accent : withAlpha(styles.text, 0.18),
        border: `1.5px solid ${checked ? styles.accent : styles.border}`,
      }}
    >
      <span
        className="absolute top-1/2 block rounded-full bg-white shadow transition-all"
        style={{
          left: checked ? "calc(100% - 21px)" : "3px",
          height: 18,
          width: 18,
          transform: "translateY(-50%)",
        }}
      />
    </button>
  );
}

/* ── The expandable editor (name / description / body) ────────────────────── */

/** Draft editor for ONE skill — remounted per skill (key={id}) so the draft
 * always initializes from the CURRENT record after invalidation refetches. */
function SkillEditor({
  skill,
  onDone,
}: {
  skill: SkillRecord;
  onDone: () => void;
}) {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const resetAfter = useTimeoutClear();
  const [name, setName] = useState(skill.name);
  const [description, setDescription] = useState(skill.description);
  const [body, setBody] = useState(skill.body);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      updateSkill(skill.id, {
        name: name.trim(),
        description: description.trim(),
        body,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
      onDone();
    },
    onError: (err: Error) => {
      setError(err.message);
      resetAfter(() => setError(null), 4000);
    },
  });

  const dirty =
    name.trim() !== skill.name ||
    description.trim() !== skill.description ||
    body !== skill.body;

  const inputStyle = {
    background: styles.bg,
    borderColor: styles.border,
    color: styles.text,
  };

  return (
    <div
      className="flex flex-col gap-2.5 px-3 pb-3 pt-1 border-t"
      style={{ borderColor: styles.borderSubtle }}
      data-testid={`skill-editor-${skill.id}`}
    >
      <div>
        <label
          className="mb-1 block text-[10.5px] font-bold"
          style={{ color: styles.textSecondary }}
          htmlFor={`skill-name-${skill.id}`}
        >
          Name (lowercase slug)
        </label>
        <input
          id={`skill-name-${skill.id}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. api-testing"
          aria-label={`Edit name for skill ${skill.name}`}
          className="h-8 w-full rounded-[8px] border-[1.5px] px-2.5 font-mono text-[12px] outline-none"
          style={inputStyle}
        />
      </div>
      <div>
        <label
          className="mb-1 block text-[10.5px] font-bold"
          style={{ color: styles.textSecondary }}
          htmlFor={`skill-description-${skill.id}`}
        >
          Description (rides the system prompt)
        </label>
        <input
          id={`skill-description-${skill.id}`}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="one line — when should the agent load this skill?"
          aria-label={`Edit description for skill ${skill.name}`}
          className="h-8 w-full rounded-[8px] border-[1.5px] px-2.5 text-[12px] outline-none"
          style={inputStyle}
        />
      </div>
      <div>
        <label
          className="mb-1 block text-[10.5px] font-bold"
          style={{ color: styles.textSecondary }}
          htmlFor={`skill-body-${skill.id}`}
        >
          Body (loaded via read_skill)
        </label>
        <textarea
          id={`skill-body-${skill.id}`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="The full instructions the agent gets when it calls read_skill with this name…"
          aria-label={`Edit body for skill ${skill.name}`}
          rows={6}
          className="w-full rounded-[8px] border-[1.5px] px-2.5 py-2 font-mono text-[11px] leading-relaxed outline-none resize-y"
          style={inputStyle}
        />
      </div>
      {skill.source === "builtin" && (
        <p className="text-[10.5px]" style={{ color: styles.textTertiary }} data-testid="builtin-note">
          Built-in — the body is editable here (updateSkill works), but{" "}
          {BUILTIN_DELETE_NOTE}.
        </p>
      )}
      {error && (
        <p className="text-[11px] font-bold" style={{ color: "#ef4444" }} role="alert" data-testid="skill-editor-error">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <button
          onClick={() => save.mutate()}
          disabled={!name.trim() || !dirty || save.isPending}
          aria-label={`Save skill ${skill.name}`}
          className="h-8 px-3 rounded-[8px] text-[11px] font-bold shrink-0 disabled:opacity-50"
          style={{ background: withAlpha(styles.accent, 0.12), color: styles.accent }}
        >
          {save.isPending ? "Saving…" : "Save"}
        </button>
        <button
          onClick={onDone}
          aria-label={`Cancel editing skill ${skill.name}`}
          className="h-8 px-3 rounded-[8px] text-[11px] font-bold shrink-0"
          style={{ background: styles.subtle, color: styles.textSecondary }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ── The new-skill inline form ─────────────────────────────────────────────── */

/** The "New skill" inline form — Create posts /skills; a 400 (duplicate
 * name / bad slug) surfaces the ApiError message INLINE, under the form. */
function NewSkillForm({ onDone }: { onDone: () => void }) {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      createSkill({
        name: name.trim(),
        description: description.trim(),
        body,
        enabled: true,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
      onDone();
    },
    onError: (err: Error) => setError(err.message),
  });

  const inputStyle = {
    background: styles.bg,
    borderColor: styles.border,
    color: styles.text,
  };

  return (
    <div
      className="flex flex-col gap-2.5 px-3 py-3 border-t"
      style={{ borderColor: styles.borderSubtle, background: withAlpha(styles.accent, 0.03) }}
      data-testid="new-skill-form"
    >
      <div>
        <label
          className="mb-1 block text-[10.5px] font-bold"
          style={{ color: styles.textSecondary }}
          htmlFor="new-skill-name"
        >
          Name (lowercase slug)
        </label>
        <input
          id="new-skill-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. api-testing"
          aria-label="New skill name"
          className="h-8 w-full rounded-[8px] border-[1.5px] px-2.5 font-mono text-[12px] outline-none"
          style={inputStyle}
        />
      </div>
      <div>
        <label
          className="mb-1 block text-[10.5px] font-bold"
          style={{ color: styles.textSecondary }}
          htmlFor="new-skill-description"
        >
          Description (one line)
        </label>
        <input
          id="new-skill-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="when should the agent load this skill?"
          aria-label="New skill description"
          className="h-8 w-full rounded-[8px] border-[1.5px] px-2.5 text-[12px] outline-none"
          style={inputStyle}
        />
      </div>
      <div>
        <label
          className="mb-1 block text-[10.5px] font-bold"
          style={{ color: styles.textSecondary }}
          htmlFor="new-skill-body"
        >
          Body
        </label>
        <textarea
          id="new-skill-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="The full instructions the agent gets when it calls read_skill with this name…"
          aria-label="New skill body"
          rows={5}
          className="w-full rounded-[8px] border-[1.5px] px-2.5 py-2 font-mono text-[11px] leading-relaxed outline-none resize-y"
          style={inputStyle}
        />
      </div>
      {error && (
        <p className="text-[11px] font-bold" style={{ color: "#ef4444" }} role="alert" data-testid="new-skill-error">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <button
          onClick={() => create.mutate()}
          disabled={!name.trim() || create.isPending}
          aria-label="Create skill"
          className="h-8 px-3 rounded-[8px] text-[11px] font-bold shrink-0 disabled:opacity-50"
          style={{ background: withAlpha(styles.accent, 0.12), color: styles.accent }}
        >
          {create.isPending ? "Creating…" : "Create"}
        </button>
        <button
          onClick={onDone}
          aria-label="Cancel new skill"
          className="h-8 px-3 rounded-[8px] text-[11px] font-bold shrink-0"
          style={{ background: styles.subtle, color: styles.textSecondary }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ── The card ──────────────────────────────────────────────────────────────── */

function SkillsCard() {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const resetAfter = useTimeoutClear();
  const [msg, setMsg] = useState<string | null>(null);
  const [msgIsError, setMsgIsError] = useState(false);
  /** The expanded skill's id (one at a time). */
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /** Two-step delete: the skill id awaiting the Confirm click. */
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  /** Per-row error lines (ApiError messages from failed row actions). */
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [showNew, setShowNew] = useState(false);

  const skillsQuery = useQuery({ queryKey: ["skills"], queryFn: listSkills });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["skills"] });
  };

  const note = (text: string, isError = false) => {
    setMsg(text);
    setMsgIsError(isError);
    resetAfter(() => setMsg(null), 1500);
  };

  const setRowError = (id: string, text: string | null) => {
    setRowErrors((prev) => {
      const next = { ...prev };
      if (text === null) delete next[id];
      else next[id] = text;
      return next;
    });
  };

  const toggleEnabled = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      updateSkill(id, { enabled }),
    onSuccess: (_data, vars) => {
      note(vars.enabled ? "Skill enabled." : "Skill disabled.");
      invalidate();
    },
    onError: (err: Error) => note(err.message, true),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteSkill(id),
    onSuccess: (_data, id) => {
      note("Skill deleted.");
      setConfirmDeleteId(null);
      setRowError(id, null);
      invalidate();
    },
    onError: (err: Error, id: string) => {
      // The server's own refusal text surfaces verbatim (e.g. the 409
      // built-in note) — the row is the honest place for it. The id rides
      // the mutation VARIABLES (never a render closure that may be stale).
      setConfirmDeleteId(null);
      setRowError(id, err.message);
    },
  });

  const noteMsg = (text: string, isError: boolean) => (
    <span className="text-[11px] font-bold" style={{ color: isError ? "#ef4444" : "#22c55e" }}>
      {text}
    </span>
  );

  return (
    <section
      className="rounded-[16px] border-[1.5px] p-4 flex flex-col gap-2.5"
      style={{ background: styles.card, borderColor: styles.border }}
      aria-label="Skills"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <Sparkles size={13} style={{ color: styles.accent, opacity: 0.8 }} />
        <span className="text-[13px] font-bold" style={{ color: styles.text }}>
          Skills
        </span>
        <span className="flex-1" />
        {msg && noteMsg(msg, msgIsError)}
        <button
          onClick={() => setShowNew((v) => !v)}
          aria-label="New skill"
          title="Add a skill"
          className="h-8 px-3 rounded-[8px] text-[11px] font-bold shrink-0 flex items-center gap-1"
          style={{ background: withAlpha(styles.accent, 0.12), color: styles.accent }}
        >
          <Plus size={11} strokeWidth={2.5} /> New skill
        </button>
      </div>
      <p className="text-[11px] leading-relaxed" style={{ color: styles.textSecondary }}>
        Prompt modules the agent loads on demand (read_skill). Name + description ride the system
        prompt; the body loads when a task matches.
      </p>

      {skillsQuery.isError ? (
        <p className="text-[11px]" style={{ color: "#ef4444" }} role="alert">
          {coreUnreachableHint} to manage skills.
        </p>
      ) : skillsQuery.isLoading || skillsQuery.data === undefined ? (
        <span className="text-[12px] font-mono" style={{ color: styles.textTertiary }}>
          loading skills…
        </span>
      ) : (
        <>
          <div
            className="rounded-[10px] border-[1.5px] overflow-hidden"
            style={{ borderColor: styles.border }}
          >
            {skillsQuery.data.length === 0 && (
              <div className="px-3 py-2.5 text-[11px]" style={{ color: styles.textTertiary }}>
                No skills yet — create one below; the agent discovers it by its description.
              </div>
            )}
            {skillsQuery.data.map((s) => {
              const isOpen = expandedId === s.id;
              const confirming = confirmDeleteId === s.id;
              return (
                <div
                  key={s.id}
                  data-skill-id={s.id}
                  className="border-b last:border-b-0"
                  style={{ borderColor: styles.borderSubtle }}
                >
                  <div className="flex items-center gap-2 px-3 py-2 flex-wrap">
                    <button
                      onClick={() => setExpandedId(isOpen ? null : s.id)}
                      aria-label={`Expand skill ${s.name}`}
                      aria-expanded={isOpen}
                      title={isOpen ? "Collapse" : "Edit name, description, body"}
                      className="w-6 h-6 grid place-items-center rounded-md shrink-0"
                      style={{ color: styles.textTertiary }}
                    >
                      <ChevronDown
                        size={12}
                        style={{
                          transform: isOpen ? "rotate(180deg)" : "none",
                          transition: "transform 0.15s",
                        }}
                      />
                    </button>
                    <span
                      className="font-mono text-[12px] font-bold min-w-0 truncate"
                      style={{ color: styles.text }}
                      title={s.name}
                    >
                      {s.name}
                    </span>
                    <span
                      className="text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 shrink-0"
                      style={{
                        background:
                          s.source === "builtin"
                            ? withAlpha(styles.text, 0.08)
                            : withAlpha(styles.accent, 0.14),
                        color: s.source === "builtin" ? styles.textTertiary : styles.accent,
                      }}
                    >
                      {s.source === "builtin" ? "built-in" : "user"}
                    </span>
                    <span className="flex-1" />
                    {s.source === "user" ? (
                      <button
                        onClick={() => setConfirmDeleteId(confirming ? null : s.id)}
                        aria-label={`Delete skill ${s.name}`}
                        title="Delete skill"
                        className="w-6 h-6 grid place-items-center rounded-md shrink-0"
                        style={{ color: confirming ? "#ef4444" : styles.textTertiary }}
                        onMouseEnter={(e) =>
                          (e.currentTarget.style.background = withAlpha("#ef4444", 0.12))
                        }
                        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                      >
                        <Trash2 size={11} />
                      </button>
                    ) : (
                      <span
                        className="w-6 h-6 grid place-items-center shrink-0"
                        title={`${BUILTIN_DELETE_NOTE}.`}
                      >
                        <span
                          className="text-[9px] font-black uppercase"
                          style={{ color: styles.textTertiary }}
                        >
                          fixed
                        </span>
                      </span>
                    )}
                    <ToggleSwitch
                      checked={s.enabled}
                      onToggle={() =>
                        toggleEnabled.mutate({ id: s.id, enabled: !s.enabled })
                      }
                      label={`Toggle skill ${s.name}`}
                      title={s.enabled ? "Disable this skill" : "Enable this skill"}
                      disabled={toggleEnabled.isPending}
                    />
                  </div>
                  <div className="px-3 pb-2 pl-9 min-w-0">
                    {s.description ? (
                      <ClampedText
                        text={s.description}
                        lines={2}
                        style={{ color: styles.textSecondary, fontSize: 11, lineHeight: 1.5 }}
                      />
                    ) : (
                      <span className="text-[11px] italic" style={{ color: styles.textTertiary }}>
                        no description — the agent can't discover this skill
                      </span>
                    )}
                  </div>
                  {confirming && (
                    <div
                      className="flex items-center gap-2 px-3 pb-2 pl-9 flex-wrap"
                      data-testid={`confirm-delete-${s.id}`}
                    >
                      <span className="text-[11px] font-bold" style={{ color: "#ef4444" }}>
                        Delete “{s.name}”?
                      </span>
                      <button
                        onClick={() => remove.mutate(s.id)}
                        disabled={remove.isPending}
                        aria-label={`Confirm delete skill ${s.name}`}
                        className="h-7 px-2.5 rounded-[8px] text-[11px] font-bold shrink-0 disabled:opacity-50"
                        style={{ background: withAlpha("#ef4444", 0.12), color: "#ef4444" }}
                      >
                        {remove.isPending ? "Deleting…" : "Delete"}
                      </button>
                      <button
                        onClick={() => setConfirmDeleteId(null)}
                        aria-label={`Cancel delete skill ${s.name}`}
                        className="h-7 px-2.5 rounded-[8px] text-[11px] font-bold shrink-0"
                        style={{ background: styles.subtle, color: styles.textSecondary }}
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                  {rowErrors[s.id] && (
                    <p
                      className="px-3 pb-2 pl-9 text-[11px] font-bold"
                      style={{ color: "#ef4444" }}
                      role="alert"
                      data-testid={`row-error-${s.id}`}
                    >
                      {rowErrors[s.id]}
                    </p>
                  )}
                  {isOpen && (
                    <SkillEditor
                      key={s.id}
                      skill={s}
                      onDone={() => setExpandedId(null)}
                    />
                  )}
                </div>
              );
            })}
          </div>
          {showNew && <NewSkillForm onDone={() => setShowNew(false)} />}
        </>
      )}
      <p className="text-[10.5px]" style={{ color: styles.textTertiary }}>
        Enabled skills appear in every agent turn's system prompt; the agent loads the full body via
        read_skill when a task matches.
      </p>
    </section>
  );
}

/* ── Composition ──────────────────────────────────────────────────────────── */

/** The dedicated Skills settings tab (?tab=skills). */
export function SkillsTab() {
  const styles = useThemeStyles();
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <div className="pb-1">
        <h2 className="text-[16px] font-black" style={{ color: styles.text }}>
          Skills
        </h2>
        <p className="mt-1 text-[12px]" style={{ color: styles.textSecondary }}>
          The prompt modules your agent loads on demand — name + description ride the system
          prompt, the body arrives via read_skill.
        </p>
      </div>
      <SkillsCard />
    </div>
  );
}

export default SkillsTab;
