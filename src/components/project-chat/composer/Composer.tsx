import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUp, ListPlus, Play } from "lucide-react";
import type { ModelReasoningSupport, PermissionMode, ThinkingLevel } from "shared";
import {
  fetchProviderModelConfig,
  ingestAttachmentPath,
  readAttachmentFiles,
  uploadAttachmentBytes,
  type Agent,
} from "../../../lib/api";
import { pushLocalToast } from "../../../hooks/use-notifications";
import { prewarmMenuOverlay } from "../../../lib/menu-overlay";
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
  type ReasoningAwareModelRow,
} from "./composer-utils";
import { useProjectFilePaths } from "./useProjectFiles";

/**
 * ROUND-50 (R50-c2): the owner-spec composer — ONE rounded box (R102-E:
 * rounded-xl, 1px hairline, warm bg; focus paints NOTHING — the caret is
 * the indicator, see the .composer-shell rule in index.css) containing the auto-growing
 * textarea on top, the attachment chip row when any, and the TOOLBAR ROW
 * at the bottom INSIDE the box (owner: "These
 * options will not be shown below it but inside the chat section itself.
 * There will be a dedicated background and on that background area I can
 * enter the message.").
 *
 *   ONE row (R75, owner: "the following should be shown in one single row:
 *   attach file, the access level, the behavior, the context window, the
 *   model, the reasoning, and the send button"):
 *   [Add Context] [Access] [Task mode] [Context donut] [Model] [Thinking] [Continue/Send]
 *
 *   ROUND-78 (R78-B): the toolbar's ACTION group (Continue + Send/Stop [+
 *   Queue-send]) is a NON-WRAPPING anchor pinned right by justify-between —
 *   a sibling of the wrapping selectors area — so the action button's
 *   position is stable at every width and state (the R78 fix for the
 *   owner's drifting action buttons). See the toolbar comment below.
 *
 *   The box is a CSS CONTAINER (@container) whose selector pills collapse
 *   in STAGGERED tiers (R87-A1 — see the toolbar comment below): the model
 *   label shrinks first (graduated max-width), the mode label folds at the
 *   560px floor, the thinking label at 500px; all animated. flex-wrap stays
 *   as the never-overlap emergency fallback (R51-c) for absurd widths (the
 *   freeform mini windows).
 *
 * The panel (AgentChatPanel) owns the input text, the send path, the model
 * override + thinking level persistence, and the permission-mode PATCH;
 * this component owns the staged attachment chips (cleared on send), the @
 * quick-picker, and drag-and-drop.
 */

/** R75 (owner): the textarea shows AT MOST 5 lines, then scrolls inside —
 * the height is derived from the live computed line-height (see the
 * useLayoutEffect below), never a hardcoded pixel cap. */
const MAX_VISIBLE_LINES = 5;

export function Composer({
  agent,
  projectId,
  sessionId,
  liveMode,
  input,
  onInputChange,
  busy,
  onSend,
  // ROUND-78 (R78-D): the queue-send handler — see the prop type above.
  onQueue,
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
  /** ROUND-78 (R78-D, owner: "工作中发送消息（排队）" — send while the agent
   * works): when provided AND busy, the composer's action group grows the
   * QUEUE-SEND button and Enter routes here instead of being a no-op — the
   * message queues and auto-delivers right after the agent finishes the
   * current step. The SAME staged-attachment pipeline as send() (binary
   * chips upload identically). Wired only in live mode by the panel;
   * absent → the legacy behavior stands exactly (busy → Stop only, Enter
   * does nothing). */
  onQueue?: (content: string, attachments: ComposerAttachment[]) => void;
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
  const [dragActive, setDragActive] = useState(false);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [atToken, setAtToken] = useState<AtToken | null>(null);
  const [atDismissedAt, setAtDismissedAt] = useState<number | null>(null);
  const [atHighlighted, setAtHighlighted] = useState(0);
  const localInputRef = useRef<HTMLTextAreaElement | null>(null);
  const textareaRef = inputRef ?? localInputRef;

  // ROUND-95 (R95-E): the EFFECTIVE model pair, hoisted above the hooks —
  // the thinking button's capability query keys on the provider that will
  // serve the next send (the override's when present, the agent's otherwise
  // — the same pair prepareTurn resolves server-side).
  const effectiveModel = modelOverride?.model ?? agent?.model ?? null;
  // ROUND-82 (R82): the override's provider — the donut's meter keys its
  // window/pricing lookups on the provider that will serve the next send
  // (override ?? the agent's).
  const effectiveProviderId = modelOverride?.providerId ?? agent?.providerId ?? null;

  // ROUND-95 (R95-E, the owner: "The thinking level was supposed to be
  // model-specific"): the CURRENT effective model's DETECTED reasoning
  // capability, resolved CLIENT-SIDE from the provider's configured model
  // rows (the ["provider-models-config", id] family — the SAME key the
  // ModelSelector's flyout and the Models & Providers page use, so the cache
  // is shared and their invalidations keep this fresh). Live mode only:
  // fixture mode keeps the classic four (no sidecar to ask). A missing row,
  // a failed fetch, or a null field all read as UNKNOWN — never blocked on
  // (the R95-B contract). The wire carries the field additively (R95-B);
  // ReasoningAwareModelRow is the local widening (src/lib/api.ts's mirror
  // type hasn't caught up — see composer-utils).
  const { data: modelConfigRows } = useQuery({
    queryKey: ["provider-models-config", effectiveProviderId],
    queryFn: () => fetchProviderModelConfig(effectiveProviderId as string),
    enabled: liveMode && effectiveProviderId !== null,
    staleTime: 60_000, // the family's cached-listing convention
  });
  const reasoningSupport = useMemo<ModelReasoningSupport | null>(() => {
    if (effectiveModel === null || effectiveProviderId === null) return null;
    const rows = (modelConfigRows ?? []) as readonly ReasoningAwareModelRow[];
    const row = rows.find((r) => r.providerId === effectiveProviderId && r.modelId === effectiveModel);
    return row?.reasoningSupport ?? null;
  }, [modelConfigRows, effectiveModel, effectiveProviderId]);

  const { files: projectFiles } = useProjectFilePaths(projectId);
  const atMatches = atToken !== null ? filterProjectFiles(projectFiles, atToken.query) : [];

  // R92-A: prewarm the MENU OVERLAY WINDOW once at the composer's mount —
  // the mode / thinking / add-context menus (useNativeOptionsMenu) open in
  // it inside the Tauri shell, so the FIRST open must be an instant
  // reposition, not a webview spawn. Idempotent by design (the RightSidebar
  // prewarms the same window too; the Rust side no-ops when it exists) and
  // a silent no-op in web mode.
  useEffect(() => {
    prewarmMenuOverlay();
  }, []);

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

  // ROUND-75 (R75, owner: long messages "get cut off to only two lines at
  // max and the user has to scroll"): the auto-grow used to set height from
  // onChange — but the textarea's `flex-1` (flex-basis: 0%) made the flex
  // algorithm IGNORE the height style entirely (the box rendered at its
  // intrinsic ~1-line height and scrolled internally — the owner saw "two
  // lines"; proven live: style.height=132px while clientHeight=34px). THE
  // FIX, in two parts: (a) `flex-1` is GONE from the textarea — the height
  // style now governs; (b) the growth lives in a useLayoutEffect keyed on
  // `input`, so it runs on EVERY value change — user typing AND programmatic
  // fills (the suggestion chips) — and caps at exactly MAX_VISIBLE_LINES
  // (5) lines derived from the REAL computed line-height + paddings
  // (self-maintaining against font/theme changes), after which the box
  // scrolls internally. The empty case collapses back to one line
  // (scrollHeight of empty = one line + paddings).
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (el === null) return;
    const cs = window.getComputedStyle(el);
    const parsedLh = parseFloat(cs.lineHeight);
    const parsedPadTop = parseFloat(cs.paddingTop);
    const parsedPadBottom = parseFloat(cs.paddingBottom);
    // Defensive fallbacks (test DOMs may not resolve computed styles): the
    // classes are text-[13px] leading-[1.5] px-3.5 pt-2.5 pb-1.
    const lineHeight = Number.isFinite(parsedLh) && parsedLh > 0 ? parsedLh : 13 * 1.5;
    const pads =
      (Number.isFinite(parsedPadTop) ? parsedPadTop : 10) +
      (Number.isFinite(parsedPadBottom) ? parsedPadBottom : 4);
    const cap = Math.ceil(MAX_VISIBLE_LINES * lineHeight + pads);
    el.style.maxHeight = `${cap}px`;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, cap)}px`;
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
    if (text === "" || uploadingRef.current) return;
    // ROUND-78 (R78-D, owner: "工作中发送消息（排队）"): while a turn runs,
    // Enter routes to the QUEUE when the owner wired onQueue (live mode) —
    // the message sends without interrupting the in-flight flow. Without
    // the handler the R75 legacy behavior stands exactly: busy → no-op.
    if (busy) {
      if (onQueue !== undefined) void sendStaged("queue");
      return;
    }
    void sendStaged("send");
  };

  /** R78: the queue-send button's click path — identical staging, only a
   * busy turn with the queue handler wired can ever fire it (the button
   * itself renders only in that state). */
  const queueSend = (): void => {
    const text = input.trim();
    if (text === "" || !busy || uploadingRef.current || onQueue === undefined) return;
    void sendStaged("queue");
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
  const sendStaged = async (target: "send" | "queue" = "send"): Promise<void> => {
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
      // R78: the queue path routes to onQueue (the panel POSTs
      // /sessions/:id/queue); every other step of the pipeline is identical.
      if (target === "queue" && onQueue !== undefined) {
        onQueue(input, staged);
      } else {
        onSend(input, staged);
      }
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

  // R95-E: effectiveModel/effectiveProviderId live above the hooks now (the
  // capability query keys on them — see the R95-E block near the top).

  return (
    <div
      data-composer
      // R105-B (owner v0.101.0 — the refined directive: "the whole
      // section, which is for the input of the text and to configure the
      // settings and such, should be highlighted when it is in
      // selection"): this shell IS the whole bottom section (textarea +
      // attachments + the toolbar row with the settings pills), and
      // index.css's .composer-shell:focus-within pair now highlights it as
      // ONE cohesive unit — the accent border edge + a soft accent-soft
      // halo ring, smoothly faded via this element's transition. The stray
      // "border around where the message was supposed to be entered" the
      // owner still saw was the TEXTAREA's own ring from the global
      // :focus-visible rule (unlayered, so outline-none could never beat
      // it; text-entry elements match :focus-visible even on mouse click,
      // and clicking a non-focusable message never blurs the textarea) —
      // that rule now lives in @layer base and the textarea paints nothing
      // (the caret is its own indicator). dragActive keeps its inline
      // accent border + tint (a REAL state).
      // The transition covers border-color + background (the dragActive
      // inline swaps) AND box-shadow (the R105-B focus halo) — one smooth
      // ease for every leg the CSS/inline styles can flip.
      // R126-3d-4 (the material spec): the box is a CLAY CARD — bg-card fill
      // + the 1px clay rim hairline (border-clay-rim; the resting
      // border-color declaration in .composer-shell was retired so this
      // class owns the rest, index.css) — while the :focus-within accent
      // edge + halo stay the CSS pair's alone (unlayered, they still win).
      // The resting fill moved to the class leg too (bg-card — the old
      // dark rgba / light bg JS legs are gone); dragActive keeps its inline
      // accent tint (a REAL state) and now paints BOTH legs inline.
      className="@container relative flex flex-col rounded-xl border border-clay-rim bg-card transition-[border-color,background-color,box-shadow] duration-200 composer-shell"
      style={{
        background: dragActive ? withAlpha(styles.accent, styles.isDark ? 0.1 : 0.07) : undefined,
        // Only the DRAG state paints the border inline (it must beat the
        // composer-shell class); undefined lets the CSS leg own the resting
        // color AND the R105-B focus-within accent swap.
        borderColor: dragActive ? withAlpha(styles.accent, 0.4) : undefined,
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
          // R75: the auto-grow lives in the useLayoutEffect above (keyed on
          // `input` — it fires here AND on programmatic fills; the height
          // style actually applies now that flex-1 is gone).
          // Live @ token detection at the caret. Esc dismisses the CURRENT
          // @ occurrence — it stays closed until a NEW "@" is typed.
          const el = e.currentTarget;
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
        onKeyDown={onInputKeyDown}
        onPaste={onPaste}
        rows={1}
        autoFocus={autoFocus}
        aria-label="Message composer"
        placeholder={`Message ${agent?.name ?? "Acute"}…`}
        // R89-D2: the input's horizontal padding shrinks with the box (the
        // 240px chat floor gets 12px instead of 16 — every pixel of typing
        // room counts down there). R100-D (§C4.6): px-4 pt-3 pb-1 per the
        // composer spec (13px/1.5 body).
        className="w-full min-w-0 bg-transparent outline-none resize-none text-[13px] leading-[1.5] px-4 pt-3 pb-1 @max-[420px]:px-2.5"
        style={{ color: styles.text }}
      />

      {/* Staged attachment chips (cleared on send). */}
      <AttachmentChips
        attachments={attachments}
        onRemove={(id) => setAttachments((prev) => prev.filter((a) => a.id !== id))}
      />

      {/* TOOLBAR — INSIDE the box (owner directive).
          ROUND-78 (R78-B, owner: "Continue 按钮等选项有时位置异常" — the
          action buttons occasionally render in a wrong position): the R77
          left/right CLUSTER split kept the action button glued to its
          right-side siblings, but the whole-cluster wrap made positions
          UNSTABLE — at tight widths the right cluster (selectors AND the
          action together) jumped to a second line, so Send/Stop/Continue
          drifted to different spots at different widths and states. THE
          ANCHOR: the toolbar is now justify-between with TWO siblings —
          (1) a WRAPPING area (flex-1 min-w-0) holding the left cluster
          (attach/access/mode) + the right-side selectors (donut/model/
          thinking, ml-auto shrink-0) — when the row is too tight the
          SELECTORS wrap as a unit under the left cluster, INSIDE this area;
          (2) THE ACTION GROUP (data-composer-actions, shrink-0, NEVER
          wraps — it is not inside the wrapping area at all): Continue +
          Send/Stop [+ Queue-send while busy, R78-D]. justify-between pins
          the actions to the right edge and items-end aligns them to the
          toolbar's LAST line, so the action button's position is STABLE at
          every width and every state — exactly the owner's ask.
          The box is a CSS @container and R87-A1 (owner: "when I make it
          smaller, at a point every single thing becomes minimized… it should
          smoothly be handled") made the collapse STAGGERED instead of the old
          single 560px cliff where every label vanished at once: the MODEL
          label shrinks FIRST (graduated max-width 240 → 170 → 90px, animated
          — it never hides), the MODE label collapses at the 560px floor, the
          THINKING label at 500px (both animate max-width + opacity rather
          than hard-hiding). The pills' title tooltips carry the full labels.
          flex-wrap on the wrapping area stays as the R51-c never-overlap
          emergency fallback (absurd widths — the freeform mini windows).
          R130 (owner: the shrink must stay SMOOTH — "the whole section
          moves up… which is not what should happen"): past the tiers the
          right cluster now SHRINKS (the model pill is the flex sponge —
          its label ellipsizes continuously) instead of wrapping; see the
          data-composer-right comment below. */}
      <div
        role="toolbar"
        aria-label="Composer tools"
        data-composer-toolbar
        // R100-D (research §C4.6): the toolbar row is 36px (28px pills + the
        // 8px bottom padding — pt-1 retired) at px-2 pb-2.
        className="flex items-end justify-between gap-1 px-2 pb-2"
      >
        {/* R78: the WRAPPING area — selectors only; the actions are a
            sibling pinned right by the toolbar's justify-between. */}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {/* R77/R81: the LEFT cluster — attach + THE unified operating-mode
            picker (the owner's left-side pair; the R73 task-mode picker was
            folded into the single selector — postures are agent-selected
            via switch_mode now). */}
        <div className="flex items-center gap-1 min-w-0" data-composer-left>
          <AddContextButton projectId={projectId} disabled={!liveMode} onAttachPaths={attachPaths} />
          <ModeSwitcher mode={permissionMode} disabled={!liveMode} onChange={onModeChange} />
        </div>
        {/* R77: the right-side SELECTORS — context donut, model, reasoning
            (ml-auto pins them right on their line). R78: the ACTION button NO
            LONGER lives here — it moved to the anchor sibling
            (data-composer-actions) so its position never moves (the owner's
            R78 ask).
            R130 (owner: "after a point, instead of doing anything, the whole
            section moves up… which is not what should happen. So handle it
            properly and manage it better"): the cluster DROPS shrink-0 and
            takes min-w-0 — it is now SHRINKABLE, with the model pill as the
            flex sponge (its wrapper's min-w-0 + the label's truncate make
            the name ellipsize CONTINUOUSLY past the tier ladder, so the row
            keeps shrinking smoothly instead of wrapping the whole cluster
            onto a second line). The donut + thinking pills keep their own
            shrink-0 (fixed small pills); the R51-c flex-wrap on the wrapping
            area stays as the absurd-width emergency fallback only. */}
        <div className="ml-auto flex min-w-0 items-center gap-1" data-composer-right>
          <ContextDonut
            sessionId={sessionId}
            model={effectiveModel}
            providerId={effectiveProviderId}
            transcriptLength={transcriptLength}
            liveTick={liveTick}
            streaming={streaming}
            liveMode={liveMode}
          />
          <ModelSelector agent={agent} override={modelOverride} onModelChange={onModelChange} disabled={!liveMode} />
          <ThinkingLevelButton
            level={thinkingLevel}
            onChange={onThinkingLevelChange}
            reasoningSupport={reasoningSupport}
          />
        </div>
        </div>
        {/* R78: THE ACTION ANCHOR — a sibling of the wrapping area (never
            inside it), pinned right by justify-between; it never wraps, so
            the action button's position is identical at every width/state. */}
        <div className="flex items-center gap-1 shrink-0 pb-0.5" data-composer-actions>
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
              // R91-F (the owner: "The continue button could be minimized
              // too. It could be made smaller to adjust for the screen
              // size"): at narrow container widths the LABEL collapses
              // (max-width + opacity, animated like the model pill's tiers)
              // and the button becomes ICON-ONLY — the tooltip keeps the
              // full meaning; below that even the horizontal padding
              // shrinks a notch so the actions row never crowds the
              // selectors.
              // R126-3d-4: the SECONDARY species, class leg (COMPONENTS §4 —
              // outlined: transparent fill + 1px border-strong + secondary
              // ink, hover bg-subtle; the old bg-subtle-resting + JS
              // border/color legs are gone).
              className="h-7 px-3 @max-[460px]:px-2 rounded-lg flex items-center gap-1.5 shrink-0 border border-line-strong bg-transparent text-muted text-[12px] font-semibold transition-colors duration-100 hover:bg-subtle"
            >
              <Play size={11} className="shrink-0" />
              <span className="max-w-[120px] @max-[460px]:max-w-0 @max-[460px]:opacity-0 @max-[460px]:-ml-0.5 overflow-hidden whitespace-nowrap transition-all duration-200">
                Continue
              </span>
            </button>
          ) : null}
          {busy ? (
            <>
              <button
                type="button"
                // Stop routes through the stream store (works regardless of
                // which panel is mounted — ROUND-39 semantics preserved).
                // R126-3d-4: Stop = the OUTLINED DANGER circle (COMPONENTS
                // §4's co-primary danger — 1px danger-deep border + the
                // danger-deep stop glyph on a transparent fill; the old
                // danger FILL + white glyph retired) — pressed scale 0.96,
                // NO hover-scale (the press stays).
                onClick={onStop}
                aria-label="Stop generation"
                title="Stop generation"
                className="w-7 h-7 rounded-full grid place-items-center shrink-0 border border-danger-deep bg-transparent text-danger-deep transition-transform active:scale-[0.96]"
              >
                <span className="w-3 h-3 rounded-sm bg-danger-deep" />
              </button>
              {/* ROUND-78 (R78-D, owner: "工作中发送消息（排队）" — while the
                  agent works the user can still send): the QUEUE-SEND button
                  rides the anchor NEXT TO Stop. Accent style like Send (the
                  action reads "your message goes OUT"), sized like Continue
                  (px-3 — it carries two glyphs). Enter routes here too (send()
                  above); the message POSTs to /sessions/:id/queue and
                  auto-delivers right after the current step. Only rendered
                  when the panel wired onQueue (live mode) — fixture mode
                  keeps the busy composer Stop-only exactly as before.
                  R91-F (the owner: "That send message button should only
                  appear when I have typed some message in the search bar"):
                  the button is GONE until there is text — the pre-R91
                  disabled-but-visible ghost next to Stop read as a second
                  send button doing nothing. */}
              {onQueue !== undefined && input.trim() !== "" ? (
                <button
                  type="button"
                  onClick={queueSend}
                  disabled={input.trim() === ""}
                  aria-label="Queue message"
                  title="Queues right after the agent finishes the current step"
                  data-queue-send-button
                  // R126-3d-4: Queue = the OUTLINED SECONDARY circle (the
                  // brief's material spec — COMPONENTS §4's secondary species
                  // on the 28px circle: 1px border-strong + secondary ink on
                  // a transparent fill; the old accent fill + withAlpha
                  // accent borders retired), pressed scale 0.96. The TWO
                  // GLYPHS stay (ArrowUp + ListPlus — the queue reads "your
                  // message goes OUT").
                  className="w-7 h-7 rounded-full grid place-items-center shrink-0 border border-line-strong bg-transparent text-muted transition-[background-color,color,transform] active:scale-[0.96] disabled:cursor-not-allowed"
                >
                  <ArrowUp size={12} strokeWidth={2.5} />
                  <ListPlus size={11} aria-hidden />
                </button>
              ) : null}
            </>
          ) : (
            <button
              type="button"
              onClick={send}
              disabled={input.trim() === ""}
              aria-label="Send message"
              title="Send (Enter · Shift+Enter for a new line)"
              // R126-3d-4 (the mobile recipe, the brief's material spec):
              // Send = the 28px CIRCLE, bg-accent-deep fill (the class leg —
              // TOKENS §1d's CTA tier) + the accentText INK on the JS leg
              // (text-accent-text is a PHANTOM utility — no @theme mapping,
              // it would silently paint no ink); pressed = scale 0.96, no
              // hover ring, no glow (resting UI never fidgets). Disabled =
              // bg-subtle + text-tertiary, opacity intact (COMPONENTS §4).
              className="w-7 h-7 rounded-full grid place-items-center shrink-0 bg-accent-deep disabled:bg-subtle transition-[background-color,color,transform] active:scale-[0.96] disabled:cursor-not-allowed"
              style={{ color: input.trim() !== "" ? styles.accentText : styles.textTertiary }}
            >
              <ArrowUp size={14} strokeWidth={2.5} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
