import { FileText, X } from "lucide-react";
import { fmtBytes } from "../../../lib/format";
import { useThemeStyles } from "../../../lib/use-theme-styles";
import { withAlpha } from "../../dashboard/helpers";
import type { ComposerAttachment } from "./composer-utils";

/** The staged image MIME by extension (the display set — the bytes route's
 * allowlist mirrored; null = not a displayable image). */
const STAGED_IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

/**
 * ROUND-121 (R121-b — the pixels round): the staged chip's pixel preview —
 * a 20px rounded thumbnail riding the chip's head when the staged bytes are
 * a display image (the `dataBase64` the picker staged is ALREADY in hand —
 * no fetch, no route: the same bytes the send-time upload will persist).
 * Non-images and path-only chips keep the plain glyph — never a fabricated
 * photo.
 */
function stagedImagePreview(a: ComposerAttachment): string | null {
  if (typeof a.dataBase64 !== "string" || a.dataBase64 === "") return null;
  const candidate = a.path ?? a.name;
  const dot = candidate.lastIndexOf(".");
  if (dot < 0) return null;
  const mime = STAGED_IMAGE_MIME[candidate.slice(dot + 1).toLowerCase()];
  return mime !== undefined ? `data:${mime};base64,${a.dataBase64}` : null;
}

/**
 * ROUND-50 (R50-c2): the composer's staged-attachment chip row — name +
 * human size, remove ✕, a "truncated" badge when only the 128KB head was
 * read, and "no readable text" for binary/unreadable drops. Chips are
 * per-composer: they clear on send.
 */
export function AttachmentChips({
  attachments,
  onRemove,
}: {
  attachments: readonly ComposerAttachment[];
  onRemove: (id: string) => void;
}) {
  const styles = useThemeStyles();
  if (attachments.length === 0) return null;
  return (
    <div
      role="group"
      aria-label="Attached files"
      className="flex flex-wrap items-center gap-1.5 px-2.5 pb-1"
    >
      {attachments.map((a) => {
        const preview = stagedImagePreview(a);
        return (
        <span
          key={a.id}
          data-attachment-name={a.name}
          title={
            a.path !== undefined
              ? `${a.path} · ${fmtBytes(a.size)}${a.text === null ? " · no readable text" : ""}`
              : `${a.name} · ${fmtBytes(a.size)}${a.text === null ? " · no readable text" : ""}`
          }
          className="inline-flex items-center gap-1.5 h-7 pl-2 pr-1 rounded-lg border max-w-full"
          style={{
            borderColor: withAlpha(styles.accent, styles.isDark ? 0.28 : 0.2),
            background: withAlpha(styles.accent, styles.isDark ? 0.1 : 0.06),
          }}
        >
          {preview !== null ? (
            <img
              data-testid="staged-attachment-preview"
              src={preview}
              alt={a.name}
              className="w-5 h-5 rounded object-cover shrink-0"
              style={{ border: `1px solid ${withAlpha(styles.accent, 0.18)}` }}
            />
          ) : (
            <FileText size={11} className="shrink-0" style={{ color: styles.accent }} />
          )}
          <span
            className="text-[11px] font-medium truncate max-w-[180px]"
            style={{ color: styles.text }}
          >
            {a.name}
          </span>
          <span className="font-mono text-[10px] shrink-0" style={{ color: styles.textTertiary }}>
            {fmtBytes(a.size)}
          </span>
          {a.truncated ? (
            <span
              className="font-mono text-[10px] font-medium px-1 rounded-md shrink-0"
              style={{ background: styles.subtle, color: styles.textTertiary }}
              title="Only the first 128KB was read"
            >
              truncated
            </span>
          ) : null}
          {a.text === null ? (
            <span
              className="font-mono text-[10px] font-medium px-1 rounded-md shrink-0"
              style={{ background: styles.subtle, color: styles.textTertiary }}
              title="Binary or unreadable — the model sees a placeholder note"
            >
              no text
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => onRemove(a.id)}
            aria-label={`Remove attachment ${a.name}`}
            title={`Remove ${a.name}`}
            className="w-5 h-5 rounded-md grid place-items-center shrink-0 transition-colors hover:bg-hover"
            style={{ color: styles.textTertiary }}
          >
            <X size={10} />
          </button>
        </span>
        );
      })}
    </div>
  );
}
