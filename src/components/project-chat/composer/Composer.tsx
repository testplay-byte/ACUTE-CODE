import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { ArrowUp, Play } from "lucide-react";
import type { PermissionMode, ThinkingLevel } from "shared";
import {
  ingestAttachmentPath,
  readAttachmentFiles,
  uploadAttachmentBytes,
  type Agent,
} from "../../../lib/api";
import { pushLocalToast } from "../../../hooks/use-notifications";
import { SEMANTIC_COLORS } from "../../../lib/semantics";
import { useThemeStyles } from "../../../lib/use-theme-styles";
import { withAlpha } from "../../dashboard/helpers";
import { AddContextButton } from "./AddContextButton";
import { AtMentionPicker } from "./AtMentionPicker";
import { AttachmentChips } from "./AttachmentChips";
import { ContextDonut } from "./ContextDonut";
import { ModeSwitcher } from "./ModeSwitcher";
import { ModelSelector } from "./ModelSelector";
import { ThinkingLevelButton } from "./ThinkingLevelButton";
import {
  attachmentFromRead,
  CONTINUE_FROM_STOP_MESSAGE,
  detectAtToken,
  filterProjectFiles,
  isAbsoluteLikePath,
  MAX_ATTACHMENTS,
  MAX_BINARY_ATTACHMENT_BYTES,
  readClipboardImageFile,
  readDroppedFile,
  type AtToken,
  type ComposerAttachment,
  type ModelOverride,
} from "./composer-utils";
import { useProjectFilePaths } from "./useProjectFiles";

/**
 * ROUND-50 (R50-c2): the owner-spec composer — ONE rounded box (R32 visual
 * language: radius 18, warm bg, accent border + soft glow ring on focus)
 * containing the auto-growing textarea on top, the attachment chip row when
 * any, and the TOOLBAR ROW at the bottom INSIDE the box (owner: "These
 * options will not be shown below it but inside the chat section itself.
 * There will be a dedicated background and on that background area I can
 * enter the message.").
 *
 *   left group:  [Add Context] [Mode switcher]
 *   right group: [Context donut] [Model selector] [Thinking level] [Send]
 *
 * The panel (AgentChatPanel) owns the input text, the send path, the model
 * override + thinking level persistence, and the permission-mode PATCH;
 * this component owns the staged attachment chips (cleared on send), the @
 * quick-picker, and drag-and-drop.
 */
export function Composer({
  agent,
  projectId,
  sessionId,
  liveMode,
  input,
  onInputChange,
  busy,
  onSend,
  onStop,
  showContinue = false,
  permissionMode,
  onModeChange,
  thinkingLevel,
  onThinkingLevelChange,
  modelOverride,
  onModelChange,
  transcriptLength,
  liveTick = 0,
  streaming = false,
  autoFocus = false,
  inputRef,
}: {
  agent: Agent | null;
  projectId: string;
  sessionId: string | null;
  liveMode: boolean;
  /** Controlled composer text (the panel's suggestion chips fill it). */
  input: string;
  onInputChange: (value: string) => void;
  busy: boolean;
  /** Fires with the text + staged attachments; chips clear afterwards. */
  onSend: (content: string, attachments: ComposerAttachment[]) => void;
  onStop: () => void;
  /** ROUND-58 (R58-cf): the last turn on this session ended via user stop —
   * show the Continue affordance next to Send (a normal user message with
   * CONTINUE_FROM_STOP_MESSAGE; the backend history carries the partial). */
  showContinue?: boolean;
  permissionMode: PermissionMode;
  onModeChange: (mode: PermissionMode) => void;
  thinkingLevel: ThinkingLevel;
  onThinkingLevelChange: (level: ThinkingLevel) => void;
  modelOverride: ModelOverride | null;
  onModelChange: (v: ModelOverride | null) => void;
  /** Transcript item count — rides the context-donut query key. */
  transcriptLength: number;
  /** ROUND-64 (R64-c): the active live turn's working-entry count — rides
   * the context-donut query key so the report refreshes as tool calls land
   * (the owner: the context window must update live, not at turn end). */
  liveTick?: number;
  /** ROUND-64 (R64-c): a live turn is streaming — the context-donut query
   * polls every 2.5s with staleTime 0 while true. */
  streaming?: boolean;
  autoFocus?: boolean;
  inputRef?: RefObject<HTMLTextAreaElement>;
}) {
  const styles = useThemeStyles();
  const [composerFocused, setComposerFocused] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [atToken, setAtToken] = useState<AtToken | null>(null);
  const [atDismissedAt, setAtDismissedAt] = useState<number | null>(null);
  const [atHighlighted, setAtHighlighted] = useState(0);
  const localInputRef = useRef<HTMLTextAreaElement | null>(null);
  const textareaRef = inputRef ?? localInputRef;

  const { files: projectFiles } = useProjectFilePaths(projectId);
  const atMatches = atToken !== null ? filterProjectFiles(projectFiles, atToken.query) : [];

  // ROUND-50 (R50-c2): staged chips are PER-SESSION — switching sessions
  // (sidebar row click, first send creating the session) drops them so a file
  // staged for conversation A never rides into conversation B. The textarea
  // itself stays mounted (no focus loss); the panel clears its text.
  const prevSessionIdRef = useRef(sessionId);
  useEffect(() => {
    if (prevSessionIdRef.current === sessionId) return;
    prevSessionIdRef.current = sessionId;
    setAttachments([]);
    setAtToken(null);
    setAtDismissedAt(null);
  }, [sessionId]);

  // Keep the highlight valid whenever the live matches change.
  useEffect(() => {
    setAtHighlighted((i) => (atMatches.length === 0 ? 0 : Math.min(i, atMatches.length - 1)));
  }, [atMatches.length]);

  // Auto-grow reset when the text is cleared programmatically (send/chips).
  useEffect(() => {
    const el = textareaRef.current;
    if (input === "" && el !== null) {
      el.style.height = "auto";
    }
  }, [input, textareaRef]);

  /**
   * ROUND-67 (R67-A): send-time upload gate — persisting binary chips makes
   * the send path async; this ref blocks a second Enter/click from
   * double-firing during the upload window (before the panel's `busy` prop
   * flips when onSend lands).
   */
  const uploadingRef = useRef(false);

  /**
   * Stage chips from a server-side read (picker / project files / @ mention).
   *
   * ROUND-67 (R67-A): an OS-picker BINARY (text: null, ≤8MB, absolute path —
   * the picker's own images) is additionally INGESTED: the sidecar copies it
   * into <root>/attachments/ (ingestAttachmentPath) and the chip carries the
   * returned project-relative path, so the model's history can point
   * analyze_image at a real file. Project-relative reads ("@" / project
   * picker) are already inside the project — no ingestion. An ingest failure
   * keeps the old behavior (the chip keeps the picker's absolute path) and
   * surfaces as a per-file toast — never silent, never a blocked send.
   */
  const attachPaths = useCallback(
    async (paths: string[], source: ComposerAttachment["source"]): Promise<void> => {
      const capacity = MAX_ATTACHMENTS - attachments.length;
      if (capacity <= 0) {
        pushLocalToast("Attachment limit", `At most ${MAX_ATTACHMENTS} files per message.`, "task_failed");
        return;
      }
      const chosen = paths.slice(0, capacity);
      if (paths.length > capacity) {
        pushLocalToast(
          "Attachment limit",
          `Only the first ${capacity} of ${paths.length} files were added (max ${MAX_ATTACHMENTS}).`,
          "task_failed",
        );
      }
      if (chosen.length === 0) return;
      try {
        const results = await readAttachmentFiles(chosen, projectId);
        const staged = await Promise.all(
          results.map(async (r): Promise<ComposerAttachment | null> => {
            const chip = attachmentFromRead(r, source);
            if (chip === null) return null;
            if (r.text === null && r.size <= MAX_BINARY_ATTACHMENT_BYTES && isAbsoluteLikePath(r.path)) {
              try {
                const saved = await ingestAttachmentPath(projectId, r.name, r.path);
                return { ...chip, path: saved.path, size: saved.size };
              } catch (err) {
                pushLocalToast(
                  "File could not be uploaded",
                  `${r.name}: ${err instanceof Error ? err.message : String(err)}`,
                  "task_failed",
                );
              }
            }
            return chip;
          }),
        );
        const chips = staged.filter((c): c is ComposerAttachment => c !== null);
        if (chips.length > 0) {
          setAttachments((prev) => {
            const seen = new Set(prev.map((a) => a.id));
            return [...prev, ...chips.filter((c) => !seen.has(c.id))].slice(0, MAX_ATTACHMENTS);
          });
        }
        const failed = results.filter((r) => r.error !== undefined);
        if (failed.length > 0) {
          pushLocalToast(
            failed.length === 1 ? "File could not be read" : `${failed.length} files could not be read`,
            failed.map((f) => `${f.name}: ${f.error}`).join("; ").slice(0, 300),
            "task_failed",
          );
        }
      } catch (err) {
        pushLocalToast(
          "Attachments failed",
          err instanceof Error ? err.message : String(err),
          "task_failed",
        );
      }
    },
    [attachments.length, projectId],
  );

  /**
   * Drag-and-drop: File objects have no usable path — read them client-side.
   * ROUND-67 (R67-A): binary drops (images) now stage their bytes as
   * `dataBase64` (readDroppedFile) for the send-time upload.
   */
  const onDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    setDragActive(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    // No files (e.g. dragged TEXT): leave the default action alone so the
    // textarea still inserts it natively.
    if (files.length === 0) return;
    e.preventDefault();
    const capacity = MAX_ATTACHMENTS - attachments.length;
    if (capacity <= 0) {
      pushLocalToast("Attachment limit", `At most ${MAX_ATTACHMENTS} files per message.`, "task_failed");
      return;
    }
    void Promise.all(files.slice(0, capacity).map((f) => readDroppedFile(f))).then((chips) => {
      setAttachments((prev) => {
        const seen = new Set(prev.map((a) => a.id));
        return [...prev, ...chips.filter((c) => !seen.has(c.id))].slice(0, MAX_ATTACHMENTS);
      });
    });
  };

  /**
   * ROUND-67 (R67-A): pasted files (e.g. a clipboard screenshot) stage as
   * drop-style chips — binary blobs carry their bytes for the send-time
   * upload (the fix for pasted images previously doing NOTHING: no onPaste
   * handler existed anywhere in the composer). A paste with NO files is left
   * to the browser — text paste behaves exactly as before (no
   * preventDefault, the textarea inserts the text natively).
   */
  const onPaste = (e: ReactClipboardEvent<HTMLTextAreaElement>): void => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    const capacity = MAX_ATTACHMENTS - attachments.length;
    if (capacity <= 0) {
      pushLocalToast("Attachment limit", `At most ${MAX_ATTACHMENTS} files per message.`, "task_failed");
      return;
    }
    void Promise.all(files.slice(0, capacity).map((f) => readClipboardImageFile(f))).then((chips) => {
      setAttachments((prev) => {
        const seen = new Set(prev.map((a) => a.id));
        return [...prev, ...chips.filter((c) => !seen.has(c.id))].slice(0, MAX_ATTACHMENTS);
      });
    });
  };

  /** Attach the picked @-mention file and strip the @token from the text. */
  const pickAtMention = (path: string): void => {
    if (atToken === null) return;
    const value = input;
    const next = value.slice(0, atToken.at) + value.slice(atToken.end);
    onInputChange(next);
    setAtToken(null);
    setAtDismissedAt(null);
    void attachPaths([path], "at");
    // Focus back into the composer after the popup click.
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const send = (): void => {
    const text = input.trim();
    if (text === "" || busy || uploadingRef.current) return;
    void sendStaged();
  };

  /**
   * ROUND-67 (R67-A): the REAL attachment pipeline — before the message
   * leaves, every binary chip's bytes (a dropped/pasted image) are persisted
   * into the project (uploadAttachmentBytes → POST /attachments/upload) and
   * the chip's `path` becomes the returned project-relative path, which rides
   * the message.user payload; the runtime's renderAttachments then points
   * analyze_image at the real file. A failed upload keeps the OLD behavior —
   * the attachment rides path-less and the model sees the honest "no readable
   * text" placeholder — plus a per-file toast. Never a blocked send, never a
   * silent drop.
   */
  const sendStaged = async (): Promise<void> => {
    uploadingRef.current = true;
    try {
      const staged = await Promise.all(
        attachments.map(async (chip): Promise<ComposerAttachment> => {
          if (chip.dataBase64 === null || chip.dataBase64 === undefined || chip.path !== undefined) {
            return chip;
          }
          try {
            const saved = await uploadAttachmentBytes(projectId, chip.name, chip.dataBase64);
            return { ...chip, path: saved.path, size: saved.size };
          } catch (err) {
            pushLocalToast(
              "File could not be uploaded",
              `${chip.name}: ${err instanceof Error ? err.message : String(err)}`,
              "task_failed",
            );
            // Old behavior: the chip rides the message path-less.
            return { ...chip, dataBase64: null };
          }
        }),
      );
      onSend(input, staged);
      // Chips are per-composer: they cleared with the message they rode.
      setAttachments([]);
      setAtToken(null);
      setAtDismissedAt(null);
    } finally {
      uploadingRef.current = false;
    }
  };

  const onInputKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    // @ quick-picker keys first — Enter attaches, Esc closes, arrows move.
    if (atToken !== null && atMatches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setAtHighlighted((i) => (i + 1) % atMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setAtHighlighted((i) => (i - 1 + atMatches.length) % atMatches.length);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        pickAtMention(atMatches[atHighlighted] ?? atMatches[0]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setAtDismissedAt(atToken.at);
        setAtToken(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const effectiveModel = modelOverride?.model ?? agent?.model ?? null;

  return (
    <div
      data-composer
      className="relative flex flex-col rounded-[18px] border transition-all"
      style={{
        background: dragActive
          ? withAlpha(styles.accent, styles.isDark ? 0.1 : 0.07)
          : styles.isDark
            ? "rgba(255,255,255,0.04)"
            : styles.bg,
        borderColor:
          dragActive || composerFocused ? withAlpha(styles.accent, 0.4) : styles.border,
        boxShadow: composerFocused ? `0 0 0 4px ${withAlpha(styles.accent, 0.13)}` : "none",
      }}
      data-dragging={dragActive ? "true" : undefined}
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) {
          e.preventDefault();
          setDragActive(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragActive(false);
      }}
      onDrop={onDrop}
    >
      {/* @ quick-picker — a small popup above the caret line. */}
      {atToken !== null && atMatches.length > 0 ? (
        <AtMentionPicker
          query={atToken.query}
          matches={atMatches}
          highlighted={atHighlighted}
          onHighlight={setAtHighlighted}
          onPick={pickAtMention}
        />
      ) : null}

      <textarea
        ref={textareaRef}
        value={input}
        onChange={(e) => {
          onInputChange(e.target.value);
          // Auto-grow to fit content (max 6 rows), then scroll inside.
          const el = e.currentTarget;
          el.style.height = "auto";
          el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
          // Live @ token detection at the caret. Esc dismisses the CURRENT
          // @ occurrence — it stays closed until a NEW "@" is typed.
          const caret = el.selectionStart ?? el.value.length;
          const token = detectAtToken(el.value, caret);
          if (token === null) {
            setAtDismissedAt(null);
            setAtToken(null);
          } else if (token.at === atDismissedAt) {
            setAtToken(null);
          } else {
            setAtDismissedAt(null);
            setAtToken(token);
          }
        }}
        onFocus={() => setComposerFocused(true)}
        onBlur={() => setComposerFocused(false)}
        onKeyDown={onInputKeyDown}
        onPaste={onPaste}
        rows={1}
        autoFocus={autoFocus}
        aria-label="Message composer"
        placeholder={`Message ${agent?.name ?? "Acute"}…`}
        className="flex-1 min-w-0 bg-transparent outline-none resize-none text-[13px] leading-[1.5] max-h-[132px] px-3.5 pt-2.5 pb-1"
        style={{ color: styles.text }}
      />

      {/* Staged attachment chips (cleared on send). */}
      <AttachmentChips
        attachments={attachments}
        onRemove={(id) => setAttachments((prev) => prev.filter((a) => a.id !== id))}
      />

      {/* TOOLBAR — INSIDE the box (owner directive).
          ROUND-51 (R51-c, owner: "the details on the left and right should
          not overlap with each other"): both clusters are shrink-0 (never
          squashed), a flex-1 min-w-0 spacer between them absorbs free space,
          and the row WRAPS — when one row can't hold both clusters the right
          cluster moves to a second line below the left one instead of ever
          overlapping (gap-y keeps the rows apart). */}
      <div
        role="toolbar"
        aria-label="Composer tools"
        data-composer-toolbar
        className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-2 pb-2 pt-1"
      >
        <div className="flex items-center gap-1 shrink-0">
          <AddContextButton projectId={projectId} disabled={!liveMode} onAttachPaths={attachPaths} />
          <ModeSwitcher mode={permissionMode} disabled={!liveMode} onChange={onModeChange} />
        </div>
        {/* ROUND-51 (R51-c): the shrink absorber — the two clusters themselves
            never shrink (shrink-0), the spacer collapses to nothing first and
            the row wraps only when the clusters genuinely can't share it. */}
        <div className="flex-1 min-w-0" aria-hidden />
        <div className="flex items-center gap-1 shrink-0">
          <ContextDonut
            sessionId={sessionId}
            model={effectiveModel}
            transcriptLength={transcriptLength}
            liveTick={liveTick}
            streaming={streaming}
            liveMode={liveMode}
          />
          <ModelSelector
            agent={agent}
            override={modelOverride}
            onModelChange={onModelChange}
            disabled={!liveMode}
          />
          <ThinkingLevelButton level={thinkingLevel} onChange={onThinkingLevelChange} />
          {/* ROUND-58 (R58-cf): the Continue affordance — the last turn ended
              via user stop (the backend persisted the partial + tool results,
              so this normal follow-up message resumes the response). Secondary
              style (border + subtle bg), never shown while a turn runs (the
              Stop button owns that state). */}
          {showContinue && !busy ? (
            <button
              type="button"
              onClick={() => {
                onSend(CONTINUE_FROM_STOP_MESSAGE, []);
                setAtToken(null);
                setAtDismissedAt(null);
              }}
              aria-label="Continue from where you left off"
              title="Send another message to resume the stopped response"
              data-continue-button
              className="h-8 px-3 rounded-xl flex items-center gap-1.5 shrink-0 border text-[11.5px] font-semibold transition-colors"
              style={{ borderColor: styles.border, background: styles.subtle, color: styles.textSecondary }}
              onMouseEnter={(e) => (e.currentTarget.style.background = styles.subtleHover)}
              onMouseLeave={(e) => (e.currentTarget.style.background = styles.subtle)}
            >
              <Play size={11} />
              Continue
            </button>
          ) : null}
          {busy ? (
            <button
              type="button"
              // Stop routes through the stream store (works regardless of
              // which panel is mounted — ROUND-39 semantics preserved).
              onClick={onStop}
              aria-label="Stop generation"
              title="Stop generation"
              className="w-8 h-8 rounded-xl grid place-items-center shrink-0 transition-transform hover:scale-105 active:scale-95"
              style={{ backgroundColor: SEMANTIC_COLORS.danger, color: "#fff" }}
            >
              <span className="w-3 h-3 rounded-sm bg-white/90" />
            </button>
          ) : (
            <button
              type="button"
              onClick={send}
              disabled={input.trim() === ""}
              aria-label="Send message"
              title="Send (Enter · Shift+Enter for a new line)"
              className="w-8 h-8 rounded-xl grid place-items-center shrink-0 transition-all hover:scale-105 active:scale-95 disabled:hover:scale-100"
              style={
                input.trim() !== ""
                  ? {
                      backgroundColor: styles.accent,
                      color: styles.accentText,
                      boxShadow: `0 2px 10px ${withAlpha(styles.accent, 0.35)}`,
                    }
                  : { backgroundColor: styles.inputBg, color: styles.textTertiary }
              }
            >
              <ArrowUp size={14} strokeWidth={2.5} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
