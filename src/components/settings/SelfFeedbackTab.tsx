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
import { Check, Copy, FileText, ListCollapse, NotebookPen, RefreshCw, Trash2 } from "lucide-react";
import {
  clearFeedbackLedger,
  deleteFeedbackEntry,
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

export interface ParsedFeedbackSection {
  title: string;
  body: string;
}

export interface ParsedFeedbackEntry {
  /** The 0-based top-down index — the DELETE route's coordinate. */
  index: number;
  /** The header line's own timestamp text (the ISO string, verbatim). */
  timestamp: string;
  session: string | null;
  project: string | null;
  agent: string | null;
  outcome: string | null;
  transcript: string | null;
  sections: ParsedFeedbackSection[];
}

/* ROUND-123 (R123): the ledger PARSER — pure, exported for the tests.
 * The ledger's own byte grammar (feedback-ledger.ts): the file header, then
 * one "\n---\n\n## Entry — <timestamp>" separator per entry; the entry's
 * machine header lines ("- **Session**: …") and its "### " sections follow.
 * The parser is TOLERANT: a malformed/absent field reads null, a body with
 * no sections renders as no sections — the raw file always remains the
 * truth (the Raw toggle), the parse is a VIEW. */
export function parseFeedbackEntries(content: string): ParsedFeedbackEntry[] {
  if (content.trim() === "") return [];
  const parts = content.split("\n---\n\n## Entry — ");
  const entries: ParsedFeedbackEntry[] = [];
  for (let i = 1; i < parts.length; i += 1) {
    const body = parts[i] ?? "";
    const lines = body.split("\n");
    // The first line carries the timestamp (the separator ate the prefix).
    const timestamp = (lines[0] ?? "").trim();
    const headerFields: Record<string, string | null> = {};
    let cursor = 1;
    for (; cursor < lines.length; cursor += 1) {
      const line = lines[cursor] ?? "";
      if (line.startsWith("### ")) break;
      const match = /^- \*\*(.+?)\*\*: (.*)$/.exec(line);
      if (match !== null) {
        headerFields[match[1] ?? ""] = match[2] ?? "";
      }
    }
    // The sections: each "### Title" owns the lines until the next one.
    const sections: ParsedFeedbackSection[] = [];
    let current: ParsedFeedbackSection | null = null;
    for (; cursor < lines.length; cursor += 1) {
      const line = lines[cursor] ?? "";
      if (line.startsWith("### ")) {
        if (current !== null) sections.push(current);
        current = { title: line.slice(4).trim(), body: "" };
      } else if (current !== null) {
        current.body = current.body === "" ? line : `${current.body}\n${line}`;
      }
    }
    if (current !== null) sections.push(current);
    entries.push({
      index: entries.length,
      timestamp,
      session: headerFields["Session"] ?? null,
      project: headerFields["Project"] ?? null,
      agent: headerFields["Agent"] ?? null,
      outcome: headerFields["Turn outcome"] ?? null,
      transcript: headerFields["Transcript"] ?? null,
      sections: sections.map((s) => ({ title: s.title, body: s.body.trim() })),
    });
  }
  return entries;
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

/* ── The ledger viewer — ROUND-123 (R123): the parsed view (the default)
 * + the raw view (the R122 file-as-is block, behind a toggle) + per-entry
 * Delete + the ALWAYS-PRESENT Clear. ────────────────────────────────────────────────── */

/** The entry card's outcome chip color — "ok" reads success, anything with
 * "fail"/"error" reads danger, the rest (unknown shapes) stays neutral. */
function outcomeTone(outcome: string | null): "success" | "danger" | "neutral" {
  const value = (outcome ?? "").toLowerCase();
  if (value === "ok" || value === "success") return "success";
  if (value.includes("fail") || value.includes("error")) return "danger";
  return "neutral";
}

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
  // R123: the VIEW toggle — "parsed" (the structured cards, the default) or
  // "raw" (the R122 file-as-is block). The owner's "see the raw file"
  // contract stands; the parse is the readable default.
  const [view, setView] = useState<"parsed" | "raw">("parsed");
  // R123: the PER-ENTRY delete's confirm target (the entry's index).
  const [entryConfirm, setEntryConfirm] = useState<number | null>(null);
  const [entryDeleteError, setEntryDeleteError] = useState<string | null>(null);

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

  // R123: the per-entry delete — DELETE /feedback/file/entry/:index, then the
  // invalidated query re-reads the file (the surviving entries re-render;
  // the honest "removed:false" no-op for a stale index simply refetches).
  const deleteEntry = useMutation({
    mutationFn: (index: number) => deleteFeedbackEntry(index),
    onSuccess: () => {
      setEntryDeleteError(null);
      void queryClient.invalidateQueries({ queryKey: ["feedback-file"] });
      setEntryConfirm(null);
    },
    onError: (err: Error) => {
      setEntryDeleteError(err.message);
      setEntryConfirm(null);
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
  const parsed = ledger !== undefined ? parseFeedbackEntries(ledger.content) : [];

  return (
    <SectionCard ariaLabel="Feedback ledger" testId="self-feedback-ledger-card">
      <div className="mb-3 flex items-center gap-2">
        <NotebookPen size={13} style={{ color: styles.accent, opacity: 0.7 }} />
        <span className="text-[13px] font-semibold text-ink">Feedback ledger</span>
        {/* R123: the VIEW TOGGLE — the parsed cards (the default) / the raw
            file. Two quiet segmented buttons; the raw view keeps the owner's
            R122 "see the raw file" contract one click away. */}
        {ledger !== undefined && ledger.exists && ledger.entries > 0 ? (
          <div
            className="ml-auto flex items-center rounded-full border p-0.5"
            style={{ borderColor: bdr("1.5px", styles.border) }}
            role="tablist"
            aria-label="Ledger view"
          >
            <button
              type="button"
              role="tab"
              aria-selected={view === "parsed"}
              onClick={() => setView("parsed")}
              className="flex h-6 items-center gap-1 rounded-full px-2.5 text-[11px] font-medium transition-colors"
              style={{
                background: view === "parsed" ? withAlpha(styles.accent, 0.14) : "transparent",
                color: view === "parsed" ? styles.accent : styles.textTertiary,
              }}
              data-testid="feedback-view-parsed"
            >
              <ListCollapse size={11} /> Parsed
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "raw"}
              onClick={() => setView("raw")}
              className="flex h-6 items-center gap-1 rounded-full px-2.5 text-[11px] font-medium transition-colors"
              style={{
                background: view === "raw" ? withAlpha(styles.accent, 0.14) : "transparent",
                color: view === "raw" ? styles.accent : styles.textTertiary,
              }}
              data-testid="feedback-view-raw"
            >
              <FileText size={11} /> Raw
            </button>
          </div>
        ) : null}
      </div>
      <p className="mb-3 text-[12px] leading-relaxed" style={{ color: styles.textSecondary }}>
        The feedback.md the agents have been writing — newest entries at the bottom. This is exactly the file to hand
        the developers when something went wrong: every entry places itself (session, project, agent, model, outcome)
        before it reports. Delete a single entry with its card’s trash button, or the whole ledger with Clear.
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
      ) : view === "raw" ? (
        <>
          {/* The honest meta line — the file’s own numbers, straight from
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
      ) : (
        <>
          {/* R123: the PARSED view — one structured card per entry (the meta
              line + the file’s own numbers ride above the list; the
              long-list discipline caps the scroll). */}
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
          <div className="feedback-entry-list flex max-h-96 flex-col gap-2.5 overflow-y-auto pr-1" data-testid="feedback-parsed-list">
            {parsed.map((entry) => {
              const tone = outcomeTone(entry.outcome);
              return (
                <div
                  key={`entry-${entry.index}`}
                  data-testid="feedback-entry-card"
                  data-entry-index={entry.index}
                  className="rounded-xl border p-3"
                  style={{
                    borderColor: withAlpha(styles.text, 0.12),
                    background: withAlpha(styles.text, 0.02),
                  }}
                >
                  {/* The entry header — the machine-written placement line. */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-[11px] tabular-nums" style={{ color: styles.textTertiary }}>
                      #{entry.index + 1}
                    </span>
                    <span className="font-mono text-[10px]" style={{ color: styles.textTertiary }}>
                      {formatUpdatedAt(entry.timestamp)}
                    </span>
                    {entry.outcome !== null ? (
                      <span
                        className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                        style={{
                          background:
                            tone === "success"
                              ? withAlpha(SEMANTIC_COLORS.success, 0.12)
                              : tone === "danger"
                                ? withAlpha(SEMANTIC_COLORS.danger, 0.12)
                                : withAlpha(styles.text, 0.08),
                          color:
                            tone === "success"
                              ? SEMANTIC_COLORS.success
                              : tone === "danger"
                                ? SEMANTIC_COLORS.danger
                                : styles.textSecondary,
                        }}
                        data-testid="feedback-entry-outcome"
                      >
                        {entry.outcome}
                      </span>
                    ) : null}
                    {/* R123: the PER-ENTRY DELETE — the owner’s “delete it
                        completely” refinement: one entry out, the rest stay. */}
                    <button
                      type="button"
                      data-testid="feedback-entry-delete"
                      onClick={() => setEntryConfirm(entry.index)}
                      disabled={deleteEntry.isPending}
                      aria-label={`Delete entry ${entry.index + 1}`}
                      title="Deletes this one entry from the ledger — the others stay"
                      className="ml-auto flex h-6 items-center gap-1 rounded-lg border px-2 text-[10px] font-medium transition-opacity hover:opacity-85 disabled:cursor-wait disabled:opacity-60"
                      style={{ borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.4), color: SEMANTIC_COLORS.danger }}
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                  {/* The placement meta — session · project · agent (mono,
                      one line, ellipsized; the transcript size rides the
                      title attribute for the cold read). */}
                  <div
                    className="mt-1.5 truncate font-mono text-[10px]"
                    style={{ color: styles.textTertiary }}
                    title={[
                      entry.session !== null ? `session ${entry.session}` : null,
                      entry.project !== null ? `project ${entry.project}` : null,
                      entry.agent !== null ? `agent ${entry.agent}` : null,
                      entry.transcript !== null ? `transcript ${entry.transcript}` : null,
                    ]
                      .filter((part) => part !== null)
                      .join(" \u00b7 ")}
                  >
                    {[
                      entry.session,
                      entry.project,
                      entry.agent,
                    ]
                      .filter((part) => part !== null)
                      .join(" · ")}
                  </div>
                  {/* The six sections — labeled blocks, the bodies verbatim. */}
                  <div className="mt-2 flex flex-col gap-2">
                    {entry.sections.map((section) => (
                      <div key={`${entry.index}-${section.title}`}>
                        <div
                          className="text-[10px] font-semibold uppercase tracking-[0.08em]"
                          style={{ color: styles.textTertiary }}
                        >
                          {section.title}
                        </div>
                        <div
                          className="mt-0.5 whitespace-pre-wrap break-words text-[12px] leading-relaxed"
                          style={{ color: styles.textSecondary }}
                        >
                          {section.body}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* The actions row — visible whenever the file state is known. R123:
          the CLEAR is ALWAYS PRESENT (disabled with the honest empty
          tooltip when there is nothing to clear — the affordance never
          appears/vanishes with the data, the owner’s first-sight
          complaint). */}
      {ledger !== undefined && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {clearError ? (
            <span className="w-full text-[11px]" style={{ color: SEMANTIC_COLORS.danger }} role="alert">
              {clearError}
            </span>
          ) : null}
          {entryDeleteError ? (
            <span className="w-full text-[11px]" style={{ color: SEMANTIC_COLORS.danger }} role="alert" data-testid="feedback-entry-delete-error">
              {entryDeleteError}
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
          <button
            type="button"
            data-testid="feedback-clear-button"
            onClick={() => setConfirmOpen(true)}
            disabled={clear.isPending || !ledger.exists || ledger.entries === 0}
            aria-label="Clear the feedback ledger"
            title={
              !ledger.exists || ledger.entries === 0
                ? "Nothing to clear yet — entries appear after completed turns while self-feedback generation is on"
                : "Deletes the whole ledger file and every entry in it"
            }
            className="ml-auto flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border px-3 text-[12px] font-medium transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-50"
            style={{ borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.45), color: SEMANTIC_COLORS.danger }}
          >
            <Trash2 size={12} />
            Clear
          </button>
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

      {/* R123: the PER-ENTRY delete confirm — the same styled-dialog law for
          the smaller destructive ask. */}
      {entryConfirm !== null && ledger !== undefined && (
        <ConfirmDialog
          title="Delete this entry"
          message={`Delete entry #${entryConfirm + 1} from the feedback ledger? The other entries stay.`}
          confirmLabel="Delete entry"
          danger
          onConfirm={() => deleteEntry.mutate(entryConfirm)}
          onClose={() => setEntryConfirm(null)}
        >
          <p className="text-[11px] leading-relaxed" style={{ color: styles.textTertiary }}>
            This removes the one entry from the file — everything else is kept byte-identical. This cannot be undone.
          </p>
        </ConfirmDialog>
      )}
    </SectionCard>
  );
}
