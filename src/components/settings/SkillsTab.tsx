import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Eye, Plus, Sparkles, Trash2 } from "lucide-react";
import { useTimeoutClear } from "../../hooks/use-timeout-clear";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { withAlpha } from "../dashboard/helpers";
import { ClampedText } from "../shared/ClampedText";
import { SkeletonRows } from "../shared/Skeletons";
import { ToggleSwitch } from "../ui/toggle-switch"; // R93-A4: the shared contrast-aware switch
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
 * useTimeoutClear toasts. The api module is the ONLY backend surface
 * touched here.
 *
 * ROUND-98 (R98-E3): the ALWAYS-LOAD upgrades — the per-row "Always load"
 * switch (PATCH {alwaysLoad}; file rows read the SKILL.md frontmatter and
 * are read-only), the pinned-budget readout (24,000-char always-on budget,
 * amber past 80%), the ALWAYS-ON marker on pinned rows, and the composed
 * SKILLS-section preview. State gates upgraded to the R97-I grammar:
 * loading = the shared Skeleton primitives + ONE role="status"; error =
 * role="alert" with the exact cause + one Retry.
 */

/** The always-on tier's total budget (agent-core prompts.ts
 * ALWAYS_ON_SKILLS_CHAR_BUDGET — the readout rides it). */
const ALWAYS_ON_CHAR_BUDGET = 24_000;

/** The honest pin description — the switch's own title. */
const ALWAYS_LOAD_HINT =
  "the skill's full body rides every turn — pin sparingly, it spends tokens";

/** The server's stance on built-in skills, surfaced verbatim in the UI. */
const BUILTIN_DELETE_NOTE =
  "built-in skills can be disabled or edited, not deleted — they reappear if removed from the database";

/** File-defined rows (project .acute/skills/ or user-global) are read-only in
 * the app — the SKILL.md on disk is their editable source of truth (PATCH
 * /skills/:id refuses their synthetic ids with a 409). */
function isFileSkill(skill: SkillRecord): boolean {
  return skill.source === "project-file" || skill.source === "global-file";
}

/** §2 identity-chip label per provenance (one spelling for the source chip). */
const SOURCE_LABELS: Record<SkillRecord["source"], string> = {
  builtin: "built-in",
  user: "user",
  "project-file": "project file",
  "global-file": "global file",
};

/**
 * R98-E3: the composed SKILLS-section preview — the same shape the backend
 * composes per turn (agents/prompts.ts's "skills" + "always-on-skills"
 * blocks): the read_skill index over ENABLED skills (pinned entries marked,
 * both caps mirrored — 32 listed / 12,000 index chars), then the pinned FULL
 * bodies inside the 24,000-char always-on budget with the honest truncation
 * markers. Representative, not byte-exact: a session's tool allowlist or the
 * computer-use gate can narrow the real set, and the per-turn task-hint line
 * is not previewed here.
 */
function composeSkillsSectionPreview(rows: SkillRecord[]): string {
  const lines: string[] = ["## SKILLS (load with read_skill, search with search_skills)"];
  let listed = 0;
  let hidden = 0;
  let remaining = 12_000; // SKILLS_SECTION_CHAR_BUDGET
  for (const skill of rows) {
    if (!skill.enabled) continue;
    const line =
      `- **${skill.name}** — ${skill.description}` +
      (skill.alwaysLoad === true
        ? " (ALWAYS-ON — full body in the ALWAYS-ON SKILLS section below)"
        : "");
    // The first skill always lists (the backend's degenerate guard).
    if (listed > 0 && (listed >= 32 || remaining - line.length < 0)) {
      hidden = rows.filter((s) => s.enabled).length - listed;
      break;
    }
    remaining -= line.length;
    listed += 1;
    lines.push(line);
  }
  if (hidden > 0) lines.push(`- …and ${hidden} more — search_skills to discover them`);
  lines.push("- A skill body that appears truncated after context compaction can be RELOADED: call read_skill again.");

  const pinned = rows.filter((s) => s.enabled && s.alwaysLoad === true);
  if (pinned.length > 0) {
    lines.push("");
    lines.push("## ALWAYS-ON SKILLS (pinned — full bodies ride every turn)");
    lines.push(
      "The owner pinned these skills: their FULL bodies are already below — no read_skill needed.",
    );
    let budget = ALWAYS_ON_CHAR_BUDGET;
    for (const skill of pinned) {
      if (budget <= 0) {
        lines.push(
          `- **${skill.name}** — omitted: the 24,000-char always-on budget is exhausted (load it with read_skill).`,
        );
        continue;
      }
      lines.push(`### Skill: ${skill.name}`);
      if (skill.body.length <= budget) {
        budget -= skill.body.length;
        if (skill.body !== "") lines.push(skill.body);
      } else {
        const shown = skill.body.slice(0, budget);
        budget = 0;
        lines.push(shown);
        lines.push(
          `…[always-on budget: ${skill.name} truncated at ${shown.length.toLocaleString("en-US")} of ${skill.body.length.toLocaleString("en-US")} chars — the 24,000-char always-on budget is exhausted; read_skill loads the full body]`,
        );
      }
      lines.push("");
    }
  }
  return lines.join("\n");
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
      )}      {isFileSkill(skill) && (
        <p className="text-[10.5px]" style={{ color: styles.textTertiary }} data-testid={`file-editor-note-${skill.id}`}>
          File-defined — edits are refused here (409); edit{" "}
          <span className="font-mono" title={skill.filePath}>
            the SKILL.md
          </span>{" "}
          on disk instead.
        </p>
      )}
      {error && (
        <p className="text-[11px] font-bold" style={{ color: SEMANTIC_COLORS.danger }} role="alert" data-testid="skill-editor-error">
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
        <p className="text-[11px] font-bold" style={{ color: SEMANTIC_COLORS.danger }} role="alert" data-testid="new-skill-error">
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
  /** R98-E3: the composed SKILLS-section preview's open state. */
  const [showPreview, setShowPreview] = useState(false);
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

  // R98-E3: the ALWAYS-LOAD tier — the per-row "Always load" switch's PATCH.
  const toggleAlwaysLoad = useMutation({
    mutationFn: ({ id, alwaysLoad }: { id: string; alwaysLoad: boolean }) =>
      updateSkill(id, { alwaysLoad }),
    onSuccess: (_data, vars) => {
      note(vars.alwaysLoad ? "Skill pinned — its body rides every turn." : "Skill unpinned.");
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
    onError: (err: Error, id) => {
      // The server's own refusal text surfaces verbatim (e.g. the 409
      // built-in note) — the row is the honest place for it. The id rides
      // the mutation VARIABLES (never a render closure that may be stale).
      setConfirmDeleteId(null);
      setRowError(id, err.message);
    },
  });

  const noteMsg = (text: string, isError: boolean) => (
    <span
      className="text-[11px] font-bold"
      style={{ color: isError ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.success }}
    >
      {text}
    </span>
  );

  // R98-E3: the pinned-budget readout — the sum of the PINNED ENABLED rows'
  // body lengths (the resolver's effective set: a disabled pin rides nothing,
  // and the merged listing has already applied the DB>file shadow rule).
  const skills = skillsQuery.data;
  const pinnedChars =
    skills === undefined
      ? 0
      : skills
          .filter((s) => s.alwaysLoad === true && s.enabled)
          .reduce((sum, s) => sum + s.body.length, 0);
  const budgetAmber = pinnedChars > ALWAYS_ON_CHAR_BUDGET * 0.8;

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
          onClick={() => setShowPreview((v) => !v)}
          aria-expanded={showPreview}
          aria-label={showPreview ? "Hide the composed skills section preview" : "Show the composed skills section preview"}
          title="Preview the SKILLS prompt section as the model receives it"
          className="h-8 px-2.5 rounded-[8px] text-[11px] font-bold shrink-0 flex items-center gap-1"
          style={{
            background: showPreview ? withAlpha(styles.accent, 0.12) : styles.subtle,
            color: showPreview ? styles.accent : styles.textSecondary,
          }}
        >
          <Eye size={11} /> Preview
        </button>
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
        prompt; the body loads when a task matches. Pin one with Always load and{" "}
        {ALWAYS_LOAD_HINT}.
      </p>

      {/* R97-I gates — the error branch FIRST (the exact cause + one Retry),
          then the shared skeletons + ONE role=status announcement. */}
      {skillsQuery.isError ? (
        <div
          role="alert"
          data-testid="skills-load-error"
          className="rounded-[14px] border-[1.5px] px-4 py-3.5"
          style={{
            borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.35),
            background: withAlpha(SEMANTIC_COLORS.danger, 0.08),
          }}
        >
          <div className="text-[12.5px] font-bold" style={{ color: SEMANTIC_COLORS.danger }}>
            Could not load the skills
          </div>
          <p className="mt-1.5 text-[12px] leading-relaxed" style={{ color: styles.textSecondary }}>
            The agent sidecar may be down or the request was rejected —{" "}
            {skillsQuery.error instanceof Error
              ? skillsQuery.error.message
              : String(skillsQuery.error)}
            . Nothing was changed.
          </p>
          <button
            type="button"
            onClick={() => void skillsQuery.refetch()}
            aria-label="Retry loading the skills"
            className="mt-3 h-8 cursor-pointer rounded-lg border px-3.5 text-[12px] font-semibold transition-opacity hover:opacity-85"
            style={{
              borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.45),
              color: SEMANTIC_COLORS.danger,
            }}
          >
            Retry
          </button>
        </div>
      ) : skillsQuery.isPending && skillsQuery.isFetching ? (
        <div role="status" aria-label="Loading skills" data-testid="skills-loading">
          <SkeletonRows rows={5} rowClassName="h-[46px] rounded-[10px]" />
        </div>
      ) : skills !== undefined && (
        <>
          {/* R98-E3: the pinned-budget readout — amber past 80% of the
              always-on budget (the compose truncates honestly past 24,000). */}
          <p
            className="font-mono text-[10.5px]"
            style={{ color: budgetAmber ? SEMANTIC_COLORS.warning : styles.textTertiary }}
            title="The always-on tier composes every pinned enabled skill's full body, capped at 24,000 chars in total"
            data-testid="pinned-budget"
          >
            pinned bodies ≈ {pinnedChars.toLocaleString("en-US")} chars of the{" "}
            {ALWAYS_ON_CHAR_BUDGET.toLocaleString("en-US")} budget
            {budgetAmber ? " — past 80%, the compose will truncate" : ""}
          </p>

          <div
            className="rounded-[10px] border-[1.5px] overflow-hidden"
            style={{ borderColor: styles.border }}
          >
            {skills.length === 0 && (
              <div className="px-3 py-2.5 text-[11px]" style={{ color: styles.textTertiary }}>
                No skills yet — create one below; the agent discovers it by its description.
              </div>
            )}
            {skills.map((s) => {
              const isOpen = expandedId === s.id;
              const confirming = confirmDeleteId === s.id;
              const fileSkill = isFileSkill(s);
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
                      title={
                        fileSkill
                          ? `${s.source} skill${s.projectName !== undefined ? ` (${s.projectName})` : ""} — read-only; edit the SKILL.md on disk`
                          : s.source === "builtin"
                            ? "seeded by the engine — editable, not deletable"
                            : "created in this app"
                      }
                      style={{
                        background:
                          s.source === "builtin" || fileSkill
                            ? withAlpha(styles.text, 0.08)
                            : withAlpha(styles.accent, 0.14),
                        color:
                          s.source === "builtin" || fileSkill ? styles.textTertiary : styles.accent,
                      }}
                    >
                      {SOURCE_LABELS[s.source]}
                    </span>
                    {/* R98-E3: the ALWAYS-ON marker — the pinned rows' accent
                        badge (the index line the model sees carries the same
                        word). */}
                    {s.alwaysLoad === true && (
                      <span
                        className="text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 shrink-0"
                        title={ALWAYS_LOAD_HINT}
                        data-testid={`always-on-marker-${s.id}`}
                        style={{ background: withAlpha(styles.accent, 0.14), color: styles.accent }}
                      >
                        always-on
                      </span>
                    )}
                    <span className="flex-1" />
                    {s.source === "user" ? (
                      <button
                        onClick={() => setConfirmDeleteId(confirming ? null : s.id)}
                        aria-label={`Delete skill ${s.name}`}
                        title="Delete skill"
                        className="w-6 h-6 grid place-items-center rounded-md shrink-0"
                        style={{ color: confirming ? SEMANTIC_COLORS.danger : styles.textTertiary }}
                        onMouseEnter={(e) =>
                          (e.currentTarget.style.background = withAlpha(SEMANTIC_COLORS.danger, 0.12))
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
                      onToggle={() => {
                        if (fileSkill) return; // read-only: visibility follows the file
                        toggleEnabled.mutate({ id: s.id, enabled: !s.enabled });
                      }}
                      label={`Toggle skill ${s.name}`}
                      title={
                        fileSkill
                          ? "file skills are always visible — visibility follows the file's existence (edit the SKILL.md)"
                          : s.enabled
                            ? "Disable this skill"
                            : "Enable this skill"
                      }
                      disabled={fileSkill || toggleEnabled.isPending}
                    />
                    {/* R98-E3: the ALWAYS-LOAD switch — the pin. DB rows
                        PATCH it; file rows are READ-ONLY (the frontmatter on
                        disk owns the flag). */}
                    <ToggleSwitch
                      checked={s.alwaysLoad === true}
                      onToggle={() => {
                        if (fileSkill) return; // read-only: the frontmatter owns the flag
                        toggleAlwaysLoad.mutate({ id: s.id, alwaysLoad: !(s.alwaysLoad === true) });
                      }}
                      label={`Always load skill ${s.name}`}
                      title={
                        fileSkill
                          ? `always-load: ${s.alwaysLoad === true ? "true" : "false"} rides the SKILL.md frontmatter — edit the file`
                          : ALWAYS_LOAD_HINT
                      }
                      disabled={fileSkill || toggleAlwaysLoad.isPending}
                      testId={`always-load-switch-${s.id}`}
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
                    {fileSkill && (
                      <p
                        className="mt-1 text-[10.5px]"
                        style={{ color: styles.textTertiary }}
                        data-testid={`file-skill-note-${s.id}`}
                        title={s.filePath}
                      >
                        read-only here — edit the SKILL.md (always-load:{" "}
                        {s.alwaysLoad === true ? "true" : "false"} rides its frontmatter)
                      </p>
                    )}
                  </div>
                  {confirming && (
                    <div
                      className="flex items-center gap-2 px-3 pb-2 pl-9 flex-wrap"
                      data-testid={`confirm-delete-${s.id}`}
                    >
                      <span
                        className="text-[11px] font-bold"
                        style={{ color: SEMANTIC_COLORS.danger }}
                      >
                        Delete “{s.name}”?
                      </span>
                      <button
                        onClick={() => remove.mutate(s.id)}
                        disabled={remove.isPending}
                        aria-label={`Confirm delete skill ${s.name}`}
                        className="h-7 px-2.5 rounded-[8px] text-[11px] font-bold shrink-0 disabled:opacity-50"
                        style={{
                          background: withAlpha(SEMANTIC_COLORS.danger, 0.12),
                          color: SEMANTIC_COLORS.danger,
                        }}
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
                      style={{ color: SEMANTIC_COLORS.danger }}
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

          {/* R98-E3: the composed SKILLS-section preview — the same shape the
              backend composes (index + ALWAYS-ON bodies), from the current
              listing. Collapsible; refreshes with every refetch. */}
          {showPreview && (
            <div
              className="rounded-[10px] border-[1.5px] p-2.5"
              style={{ borderColor: styles.border }}
              data-testid="skills-section-preview"
            >
              <div
                className="mb-1.5 text-[10.5px] font-bold uppercase tracking-wider"
                style={{ color: styles.textTertiary }}
              >
                The composed SKILLS section
              </div>
              <pre
                className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[10.5px] leading-relaxed"
                style={{ background: styles.subtle, color: styles.textSecondary }}
              >
                {composeSkillsSectionPreview(skills)}
              </pre>
              <p className="mt-1.5 text-[10px]" style={{ color: styles.textTertiary }}>
                Representative — a session&apos;s tool allowlist or the computer-use gate can narrow
                the real set; the per-turn task-hint line is not previewed.
              </p>
            </div>
          )}

          {showNew && <NewSkillForm onDone={() => setShowNew(false)} />}
        </>
      )}
      <p className="text-[10.5px]" style={{ color: styles.textTertiary }}>
        Enabled skills appear in every agent turn&apos;s system prompt; the agent loads the full body
        via read_skill when a task matches. Pinned skills skip the loading step — their bodies ride
        the ALWAYS-ON SKILLS section every turn.
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
