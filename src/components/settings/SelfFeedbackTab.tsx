/**
 * ROUND-122 (the owner's self-feedback directive): the dedicated
 * SELF-FEEDBACK section — the owner's words: "in the settings there will
 * be a dedicated section for it, and in that section I will be able to
 * see the raw file there too, which the agent has been creating."
 *
 * Cards:
 *  · THE MASTER SWITCH — while ON, after each completed session turn a
 *    separate context-free agent reviews the whole main conversation and
 *    appends one structured entry (what it was trying to do, what
 *    actually happened, every issue and glitch — tools, browser,
 *    approvals — expectations vs reality, suggested improvements) to the
 *    ONE shared ledger file every agent on this machine writes to. The
 *    entries are diagnostics for the app's developers, read weeks or
 *    months later; they are NEVER injected into any conversation — a
 *    follow-up message sees a byte-identical history. Default OFF (the
 *    feature costs one extra model call per completed turn). The
 *    DebugModeCard pattern exactly (one query, one mutation, honest
 *    error-first gates, the shared switch spelling).
 *  · THE LEDGER VIEWER — the raw file, as-is: the read-only markdown in
 *    a monospace block (max-h + overflow with the custom scrollbar, the
 *    long-list discipline), the honest meta line (entries · size · last
 *    update), Refresh + Copy actions, and the Clear confirm (the shared
 *    ConfirmDialog — destructive asks never ride window.confirm, R95-A).
 *    Live refresh: every ledger append/clear broadcasts a settings-domain
 *    frame (the R113 invalidation pattern), so an open tab converges
 *    without a manual Refresh; the button stays for the pull path.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, NotebookPen, RefreshCw, Trash2 } from "lucide-react";
import {
  clearFeedbackLedger,
  fetchFeedbackLedger,
  fetchFeedbackSettings,
  updateFeedbackSettings,
} from "../../lib/api";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { bdr, withAlpha } from "../dashboard/helpers";
import { Kicker } from "../ui/Kicker";
import { SectionCard } from "../ui/SectionCard";
import { SettingsRow } from "../ui/SettingsRow";
import { ConfirmDialog } from "./ConfirmDialog";

/** Bytes → the honest human line ("4.1 KB", "1.2 MB") — one decimal,
 * never a fabricated precision. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** ISO → the honest local line ("Sep 23, 4:05 PM") — the viewer's "last
 * update" hint, never a wall of timestamp. */
function formatUpdatedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function SelfFeedbackTab() {
  const styles = useThemeStyles();
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      {/* The tab-intro header — the label tier rides THE ONE Kicker
          primitive (TOKENS §2's "label = THE ONE kicker idiom") + a
          13px/600 section title (a TAB, not a page; the page header above
          already carries the 24px/600 title — the R100-E1 header grammar,
          the AdvancedTab shape). */}
      <div className="pb-1">
        <Kicker className="mb-1">System</Kicker>
        <h2 className="text-[13px] font-semibold text-ink">Self-Feedback</h2>
        <p className="mt-1 text-[12px]" style={{ color: styles.textSecondary }}>
          The agent&apos;s own feedback ledger — one shared file every completed session turn appends to while the
          switch is on. Entries are diagnostics for ACUTE-CODE&apos;s developers; they never enter any conversation.
        </p>
      </div>
      <SelfFeedbackToggleCard />
      <FeedbackLedgerCard />
    </div>
  );
}

/* ── The master switch — the DebugModeCard pattern exactly. ───────────────── */

function SelfFeedbackToggleCard() {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: ["feedback-settings"],
    queryFn: fetchFeedbackSettings,
  });
  const [error, setError] = useState<string | null>(null);

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => updateFeedbackSettings({ enabled }),
    onSuccess: () => {
      setError(null);
      // The very next completed turn reads this setting server-side
      // (per-turn, like the permission mode) — only the switch state
      // itself refetches.
      void queryClient.invalidateQueries({ queryKey: ["feedback-settings"] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const current = settingsQuery.data;
  // The ERROR branch comes FIRST — a failed GET must not hang on
  // "loading…" forever (the R97-I honest-gate sweep).
  if (settingsQuery.isError && current === undefined) {
    return (
      <SectionCard ariaLabel="Self-feedback generation">
        <div
          role="alert"
          data-settings-load-error
          className="rounded-2xl border px-4 py-3.5"
          style={{
            borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.35),
            background: withAlpha(SEMANTIC_COLORS.danger, 0.08),
          }}
        >
          <div className="text-[13px] font-semibold" style={{ color: SEMANTIC_COLORS.danger }}>
            Could not load self-feedback settings
          </div>
          <p className="mt-1.5 text-[12px] leading-relaxed" style={{ color: styles.textSecondary }}>
            The agent sidecar may be down or the request was rejected —{" "}
            {settingsQuery.error instanceof Error ? settingsQuery.error.message : String(settingsQuery.error)}.
            Nothing was changed; Retry re-reads the saved value.
          </p>
          <button
            type="button"
            onClick={() => void settingsQuery.refetch()}
            aria-label="Retry loading self-feedback settings"
            className="mt-3 h-8 cursor-pointer rounded-lg border px-3.5 text-[12px] font-semibold transition-opacity hover:opacity-85"
            style={{ borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.45), color: SEMANTIC_COLORS.danger }}
          >
            Retry
          </button>
        </div>
      </SectionCard>
    );
  }
  if (settingsQuery.isLoading || current === undefined) {
    return (
      <SectionCard ariaLabel="Self-feedback generation">
        <span className="text-[12px] font-mono" style={{ color: styles.textTertiary }}>
          loading self-feedback settings…
        </span>
      </SectionCard>
    );
  }

  const busy = toggle.isPending;

  return (
    <SectionCard ariaLabel="Self-feedback generation" testId="self-feedback-toggle-card">
      <div className="mb-3 flex items-center gap-2">
        <NotebookPen size={13} style={{ color: styles.accent, opacity: 0.7 }} />
        <span className="text-[13px] font-semibold text-ink">Self-feedback generation</span>
      </div>
      <SettingsRow
        label={
          <>
            Write the feedback ledger after each completed turn
            {error ? (
              <div className="mt-1.5 text-[11px]" style={{ color: SEMANTIC_COLORS.danger }} role="alert">
                {error}
              </div>
            ) : null}
          </>
        }
        description="While ON, the agent answers normally — then a separate, context-free reviewer reads the whole conversation and appends one structured entry to the shared ledger file below: what it was trying to do, what actually happened, every issue and glitch it ran into (tools, browser, approvals), where reality fell short, and the improvements it would suggest. The entry never feeds back into the conversation, so follow-up messages stay clean. Applies to the next message you send, and costs one extra model call per completed turn."
      >
        <button
          type="button"
          role="switch"
          aria-checked={current.enabled}
          aria-label="Toggle self-feedback generation"
          disabled={busy}
          onClick={() => toggle.mutate(!current.enabled)}
          className="relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors disabled:cursor-wait disabled:opacity-60"
          style={{
            background: current.enabled ? styles.accent : withAlpha(styles.text, 0.18),
            border: bdr("1.5px", current.enabled ? styles.accent : styles.border),
          }}
        >
          <span
            className="absolute top-1/2 block -translate-y-1/2 rounded-full shadow transition-all"
            style={{
              left: current.enabled ? "calc(100% - 21px)" : "3px",
              height: 18,
              width: 18,
              background: current.enabled ? styles.accentText : styles.toggleActive,
            }}
          />
        </button>
      </SettingsRow>
    </SectionCard>
  );
}

/* ── The ledger viewer — the raw file, as-is. ──────────────────────────────── */

function FeedbackLedgerCard() {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const ledgerQuery = useQuery({
    queryKey: ["feedback-file"],
    queryFn: fetchFeedbackLedger,
  });
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");
  const [clearError, setClearError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const clear = useMutation({
    mutationFn: () => clearFeedbackLedger(),
    onSuccess: () => {
      setClearError(null);
      void queryClient.invalidateQueries({ queryKey: ["feedback-file"] });
      setConfirmOpen(false);
    },
    onError: (err: Error) => {
      setClearError(err.message);
      setConfirmOpen(false);
    },
  });

  const onCopy = (): void => {
    const content = ledgerQuery.data?.content ?? "";
    if (content === "") return;
    void navigator.clipboard?.writeText(content).then(() => {
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1500);
    });
  };

  const ledger = ledgerQuery.data;

  return (
    <SectionCard ariaLabel="Feedback ledger" testId="self-feedback-ledger-card">
      <div className="mb-3 flex items-center gap-2">
        <NotebookPen size={13} style={{ color: styles.accent, opacity: 0.7 }} />
        <span className="text-[13px] font-semibold text-ink">Feedback ledger</span>
      </div>
      <p className="mb-3 text-[12px] leading-relaxed" style={{ color: styles.textSecondary }}>
        The raw feedback.md the agents have been writing — newest entries at the bottom. This is exactly the file to
        hand the developers when something went wrong: every entry places itself (session, project, agent, model,
        outcome) before it reports.
      </p>

      {ledgerQuery.isError && ledger === undefined ? (
        <div
          role="alert"
          data-settings-load-error
          className="rounded-2xl border px-4 py-3.5"
          style={{
            borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.35),
            background: withAlpha(SEMANTIC_COLORS.danger, 0.08),
          }}
        >
          <div className="text-[13px] font-semibold" style={{ color: SEMANTIC_COLORS.danger }}>
            Could not load the feedback ledger
          </div>
          <p className="mt-1.5 text-[12px] leading-relaxed" style={{ color: styles.textSecondary }}>
            {ledgerQuery.error instanceof Error ? ledgerQuery.error.message : String(ledgerQuery.error)}. Retry
            re-reads the file; the ledger itself is untouched.
          </p>
          <button
            type="button"
            onClick={() => void ledgerQuery.refetch()}
            aria-label="Retry loading the feedback ledger"
            className="mt-3 h-8 cursor-pointer rounded-lg border px-3.5 text-[12px] font-semibold transition-opacity hover:opacity-85"
            style={{ borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.45), color: SEMANTIC_COLORS.danger }}
          >
            Retry
          </button>
        </div>
      ) : ledgerQuery.isLoading || ledger === undefined ? (
        <span className="text-[12px] font-mono" style={{ color: styles.textTertiary }}>
          loading the feedback ledger…
        </span>
      ) : !ledger.exists || ledger.entries === 0 ? (
        /* The honest empty state — the never-written ledger (or a wiped one
            with no entries yet) says so instead of faking content. */
        <div
          data-testid="feedback-empty-state"
          className="rounded-xl border border-dashed px-4 py-6 text-center"
          style={{ borderColor: withAlpha(styles.text, 0.16) }}
        >
          <div className="text-[12px] font-medium" style={{ color: styles.textSecondary }}>
            No feedback yet
          </div>
          <p className="mx-auto mt-1 max-w-md text-[11px] leading-relaxed" style={{ color: styles.textTertiary }}>
            Entries appear here after session turns complete while self-feedback generation is on. Each one records
            what the agent was trying to do, what actually happened, and every issue it ran into.
          </p>
        </div>
      ) : (
        <>
          {/* The honest meta line — the file's own numbers, straight from
              GET /feedback/file (never a client-side recount). */}
          <div
            data-testid="feedback-ledger-meta"
            className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]"
            style={{ color: styles.textTertiary }}
          >
            <span>
              {ledger.entries} {ledger.entries === 1 ? "entry" : "entries"}
            </span>
            <span aria-hidden>·</span>
            <span>{formatBytes(ledger.bytes)}</span>
            {ledger.updatedAt !== null ? (
              <>
                <span aria-hidden>·</span>
                <span>updated {formatUpdatedAt(ledger.updatedAt)}</span>
              </>
            ) : null}
          </div>
          {/* The raw file, read-only — mono, wrapped, capped height with the
              custom scrollbar (the long-list discipline; newest content is
              at the bottom, scroll position starts at the top like any file
              view). */}
          <pre
            data-testid="feedback-ledger-content"
            aria-label="The raw feedback ledger file"
            aria-read-only="true"
            tabIndex={0}
            className="feedback-ledger-pre max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded-xl border p-3.5 font-mono text-[12px] leading-relaxed"
            style={{
              borderColor: withAlpha(styles.text, 0.14),
              background: withAlpha(styles.text, 0.03),
              color: styles.text,
            }}
          >
            {ledger.content}
          </pre>
        </>
      )}

      {/* The actions row — visible whenever the file state is known. */}
      {ledger !== undefined && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {clearError ? (
            <span className="w-full text-[11px]" style={{ color: SEMANTIC_COLORS.danger }} role="alert">
              {clearError}
            </span>
          ) : null}
          <button
            type="button"
            data-testid="feedback-refresh-button"
            onClick={() => void ledgerQuery.refetch()}
            disabled={ledgerQuery.isFetching}
            aria-label="Refresh the feedback ledger"
            className="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border px-3 text-[12px] font-medium transition-opacity hover:opacity-85 disabled:cursor-wait disabled:opacity-60"
            style={{ borderColor: styles.border, color: styles.textSecondary }}
          >
            <RefreshCw size={12} className={ledgerQuery.isFetching ? "animate-spin" : undefined} />
            Refresh
          </button>
          <button
            type="button"
            data-testid="feedback-copy-button"
            onClick={onCopy}
            disabled={ledger.exists !== true || ledger.content === ""}
            aria-label="Copy the feedback ledger to the clipboard"
            className="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border px-3 text-[12px] font-medium transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-50"
            style={{ borderColor: styles.border, color: styles.textSecondary }}
          >
            {copyState === "copied" ? <Check size={12} style={{ color: styles.accent }} /> : <Copy size={12} />}
            {copyState === "copied" ? "Copied" : "Copy"}
          </button>
          {ledger.exists && ledger.entries > 0 ? (
            <button
              type="button"
              data-testid="feedback-clear-button"
              onClick={() => setConfirmOpen(true)}
              disabled={clear.isPending}
              aria-label="Clear the feedback ledger"
              className="ml-auto flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border px-3 text-[12px] font-medium transition-opacity hover:opacity-85 disabled:cursor-wait disabled:opacity-60"
              style={{ borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.45), color: SEMANTIC_COLORS.danger }}
            >
              <Trash2 size={12} />
              Clear
            </button>
          ) : null}
        </div>
      )}

      {/* The Clear confirm — the shared styled dialog (R95-A: destructive
          asks never ride window.confirm). The message carries the honest
          entry count from the loaded state. */}
      {confirmOpen && ledger !== undefined && (
        <ConfirmDialog
          title="Clear the feedback ledger"
          message={`Delete all ${ledger.entries} ${ledger.entries === 1 ? "entry" : "entries"} from the feedback file?`}
          confirmLabel="Clear ledger"
          danger
          onConfirm={() => clear.mutate()}
          onClose={() => setConfirmOpen(false)}
        >
          <p className="text-[11px] leading-relaxed" style={{ color: styles.textTertiary }}>
            The file is rebuilt from scratch by the next completed turn while self-feedback generation is on. This
            cannot be undone.
          </p>
        </ConfirmDialog>
      )}
    </SectionCard>
  );
}
