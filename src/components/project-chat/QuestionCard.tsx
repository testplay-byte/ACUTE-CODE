/**
 * ROUND-87 (R87, owner: "giving it the ability to ask the user questions
 * midway through. It will ask questions and the user can select from the
 * options or maybe he can type in a custom response and such. He can answer
 * multiple questions this way.") — the ask_user chat card.
 *
 * PENDING: a bordered card (the ApprovalRow visual family) with one block
 * per question — option pills (single-select, accent when picked) + a
 * custom-text input when allowCustom !== false — and a Send-answers button
 * that resolves the whole ask in one POST (multiple questions, one card).
 * ANSWERED: a compact per-question "Q → A" list with the pick highlighted.
 * TIMEOUT / CANCELLED: the honest one-line note.
 */
import { useMemo, useState } from "react";
import { Check, Clock, X } from "lucide-react";
import type { WorkingEntry } from "../../lib/api";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { withAlpha } from "../dashboard/helpers";

export type QuestionEntry = Extract<WorkingEntry, { type: "question" }>;

export function QuestionCard({
  entry,
  onAnswer,
}: {
  entry: QuestionEntry;
  /** Resolves the whole ask — answers aligned per question, sources record
   * option-pick vs custom-typed (display fidelity on reload). */
  onAnswer?: (questionId: string, answers: string[], sources: Array<"option" | "custom">) => void;
}) {
  const styles = useThemeStyles();
  const pending = entry.status === "pending";
  // Draft answers: index → {value, source}. Option picks set both; the
  // custom input sets source "custom" on submit.
  const [drafts, setDrafts] = useState<Record<number, { value: string; source: "option" | "custom" }>>({});
  const [customOpen, setCustomOpen] = useState<Record<number, boolean>>({});

  const questions = useMemo(
    () => (entry.questions.length > 0 ? entry.questions : []),
    [entry.questions],
  );
  const allAnswered = questions.length > 0 && questions.every((_, i) => drafts[i] !== undefined);

  if (!pending) {
    if (entry.status === "answered") {
      return (
        <div
          className="rounded-xl border-[1.5px] px-3 py-2.5 my-1"
          style={{
            borderColor: withAlpha(SEMANTIC_COLORS.success, 0.45),
            background: withAlpha(SEMANTIC_COLORS.success, styles.isDark ? 0.07 : 0.04),
          }}
          data-testid="question-card-answered"
        >
          <div className="flex items-center gap-2 mb-1.5">
            <span
              className="flex items-center justify-center w-4 h-4 rounded-full shrink-0"
              style={{ background: withAlpha(SEMANTIC_COLORS.success, 0.15), color: SEMANTIC_COLORS.success }}
              aria-hidden
            >
              <Check size={11} strokeWidth={3} />
            </span>
            <span className="text-[12px] font-semibold" style={{ color: styles.text }}>
              Answered
            </span>
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full" style={{ background: styles.subtle, color: styles.textTertiary }}>
              {entry.questions.length} question{entry.questions.length === 1 ? "" : "s"}
            </span>
          </div>
          {entry.questions.map((q, i) => (
            <div key={i} className="mb-1 last:mb-0 min-w-0">
              <div className="text-[11px] truncate" style={{ color: styles.textTertiary }}>
                {q.question}
              </div>
              <div
                className="text-[12px] font-semibold font-mono break-words"
                style={{ color: styles.text }}
              >
                → {entry.answers?.[i] ?? "(no answer)"}
              </div>
            </div>
          ))}
        </div>
      );
    }
    // timeout | cancelled — the honest note.
    const note =
      entry.status === "timeout"
        ? "Question unanswered (10-minute wait elapsed) — the agent proceeded on a stated assumption"
        : "Question cancelled (the turn was stopped before you answered)";
    return (
      <div className="flex items-center gap-2 h-7 px-1 -ml-1 text-[11px] min-w-0" data-testid="question-card-unresolved">
        <span className="shrink-0" style={{ color: styles.textTertiary }}>
          {entry.status === "timeout" ? <Clock size={12} /> : <X size={12} />}
        </span>
        <span className="min-w-0 flex-1 truncate" style={{ color: styles.textTertiary }}>
          {note}
        </span>
      </div>
    );
  }

  if (onAnswer === undefined) {
    // No resolver wired (shouldn't happen on live turns) — show the questions
    // read-only rather than dead buttons.
    return (
      <div
        className="rounded-xl border-[1.5px] px-3 py-2.5 my-1"
        style={{ borderColor: withAlpha(styles.accent, 0.5), background: withAlpha(styles.accent, 0.06) }}
      >
        {questions.map((q, i) => (
          <div key={i} className="text-[12px] font-semibold mb-1 last:mb-0" style={{ color: styles.text }}>
            {q.question}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div
      className="rounded-xl border-[1.5px] px-3 py-2.5 my-1"
      style={{
        borderColor: withAlpha(styles.accent, 0.55),
        background: withAlpha(styles.accent, styles.isDark ? 0.08 : 0.05),
      }}
      data-testid="question-card-pending"
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="w-1.5 h-1.5 rounded-full ac-pulse shrink-0" style={{ background: styles.accent }} aria-hidden />
        <span className="text-[12px] font-semibold" style={{ color: styles.text }}>
          The agent needs your answer{questions.length > 1 ? `s (${questions.length})` : ""}
        </span>
      </div>
      {questions.map((q, i) => (
        <div key={i} className="mb-2.5 last:mb-0">
          <div className="text-[12px] font-semibold mb-1.5" style={{ color: styles.text }}>
            {q.question}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {(q.options ?? []).map((option) => {
              const picked = drafts[i]?.source === "option" && drafts[i]?.value === option;
              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => setDrafts((d) => ({ ...d, [i]: { value: option, source: "option" } }))}
                  // R100-D (TOKENS §6): the hover:scale is gone (resting UI
                  // never fidgets); the press stays.
                  className="h-7 px-3 rounded-full text-[11px] font-semibold border-[1.5px] transition-colors active:scale-95"
                  style={{
                    borderColor: picked ? styles.accent : withAlpha(styles.accent, 0.35),
                    background: picked ? styles.accent : "transparent",
                    color: picked ? styles.accentText : styles.text,
                  }}
                >
                  {option}
                </button>
              );
            })}
            {q.allowCustom !== false ? (
              customOpen[i] ? (
                <input
                  autoFocus
                  className="h-7 min-w-[160px] flex-1 rounded-full border-[1.5px] px-3 text-[11px] outline-none"
                  style={{
                    borderColor: withAlpha(styles.accent, 0.5),
                    background: styles.isDark ? "rgba(0,0,0,0.3)" : "rgba(0,0,0,0.03)",
                    color: styles.text,
                  }}
                  placeholder={q.placeholder ?? "Type your answer…"}
                  value={drafts[i]?.source === "custom" ? drafts[i].value : ""}
                  onChange={(e) =>
                    setDrafts((d) => ({ ...d, [i]: { value: e.target.value, source: "custom" } }))
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && drafts[i]?.value.trim() !== "") {
                      setCustomOpen((c) => ({ ...c, [i]: false }));
                    }
                  }}
                  aria-label={`Custom answer for: ${q.question}`}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setCustomOpen((c) => ({ ...c, [i]: true }))}
                  className="h-7 px-3 rounded-full text-[11px] font-semibold border-[1.5px] border-dashed transition-colors"
                  style={{ borderColor: withAlpha(styles.accent, 0.4), color: styles.textTertiary }}
                >
                  {drafts[i]?.source === "custom" && drafts[i]?.value.trim() !== ""
                    ? `“${drafts[i].value.trim().slice(0, 24)}${drafts[i].value.trim().length > 24 ? "…" : ""}”`
                    : "Type instead…"}
                </button>
              )
            ) : null}
          </div>
        </div>
      ))}
      <button
        type="button"
        disabled={!allAnswered}
        onClick={() => {
          const answers: string[] = [];
          const sources: Array<"option" | "custom"> = [];
          questions.forEach((_, i) => {
            const draft = drafts[i];
            answers.push(draft?.value.trim() ?? "");
            sources.push(draft?.source === "custom" ? "custom" : "option");
          });
          onAnswer(entry.questionId, answers, sources);
        }}
        className="h-8 px-4 rounded-full text-[12px] font-semibold transition-transform active:scale-95 disabled:opacity-50"
        style={{ background: styles.accent, color: styles.accentText }}
      >
        Send answer{questions.length > 1 ? "s" : ""}
      </button>
    </div>
  );
}
