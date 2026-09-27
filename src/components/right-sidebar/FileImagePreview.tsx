import { useEffect, useState } from "react";
import { Image as ImageIcon } from "lucide-react";
import { fetchAttachmentBytes, isDisplayableImageAttachment } from "../../lib/api";
import { useThemeStyles } from "../../lib/use-theme-styles";

/**
 * ROUND-131 (R131-TH, TH3 — the right-sidebar image viewer): one image FILE
 * rendered with pixels. The owner's v0.123.0 verdict: "it is unable to render
 * images. If I open up an image file, it is not able to open up the image
 * file properly… it renders the image as raw text." Before R131 the viewer's
 * decision tree had NO image branch — a .png fell into the raw-text <pre>
 * with line numbers.
 *
 * The pixels come from GET /projects/:id/attachments/bytes — the route that
 * resolves ANY path inside the project root (png/jpg/jpeg/gif/webp/bmp, 8MB
 * cap), the SAME door the chat's AttachmentImageThumb (R121-b) walks. The
 * lifecycle is that proven pattern, at panel scale: lazy fetch on mount,
 * object URL REVOKED on unmount/path change (no leaks across switches), the
 * frame-first shape — until the bytes land (and honestly, forever if they
 * never do — a 404, a foreign path) the SAME geometry renders the calm
 * placeholder frame (icon + name), never a fabricated photo and never a
 * layout shift when the pixels arrive.
 *
 * The backdrop is the panel's recessed surface (bg-well — TOKENS §10's THE
 * recess), the <img> fits the pane (max-w-full max-h-full object-contain):
 * big images clamp, small images center, aspect ratios never distort.
 */
export function FileImagePreview({ projectId, filePath }: { projectId: string; filePath: string }) {
  const styles = useThemeStyles();
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const fileName = filePath.split("/").pop() ?? filePath;

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    setObjectUrl(null);
    setFailed(false);
    fetchAttachmentBytes(projectId, filePath)
      .then((blob) => {
        // A 0-byte "image" is no pixels — the honest frame, not a blank <img>.
        if (cancelled || blob.size === 0) {
          if (!cancelled) setFailed(true);
          return;
        }
        url = URL.createObjectURL(blob);
        setObjectUrl(url);
      })
      .catch(() => {
        // Honest no-pixels (404 / network / over-cap) — the frame stands.
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [projectId, filePath]);

  if (objectUrl !== null) {
    return (
      <div
        data-testid="file-image-pane"
        className="flex h-full min-h-0 items-center justify-center p-3 bg-well"
      >
        <img
          data-testid="file-image-preview"
          src={objectUrl}
          alt={fileName}
          title={fileName}
          // The fit law: clamp to the pane's box (max-w-full max-h-full),
          // keep the aspect ratio (object-contain) — never distort, never
          // overflow. The quiet hairline is the thumb frame's own grammar
          // (AttachmentImageThumb's borderSubtle leg).
          className="max-w-full max-h-full object-contain rounded-lg"
          style={{ border: `1px solid ${styles.borderSubtle}` }}
        />
      </div>
    );
  }
  // The placeholder frame — AttachmentImageThumb's no-pixels leg, panel
  // scale: the recessed backdrop + the image glyph + the honest label.
  return (
    <div
      data-testid="file-image-pane"
      className="flex h-full min-h-0 items-center justify-center p-3 bg-well"
    >
      <div
        data-testid="file-image-frame"
        className="flex flex-col items-center gap-2 px-6 py-8 rounded-xl text-center"
        style={{ border: `1px dashed ${styles.borderSubtle}`, color: styles.textTertiary }}
      >
        <ImageIcon size={20} className="shrink-0" aria-hidden />
        {/* R131-TH: the label rides the ladder's 11px tier via the style leg
            (fontSize: 11) + the SCALE utility for the cap (max-w-60 = 240px) —
            zero new arbitrary-value spellings for the design audit's
            ratchet. */}
        <span
          className="font-mono max-w-60 truncate"
          style={{ fontSize: 11 }}
          title={fileName}
        >
          {failed ? `${fileName} — could not load` : "loading…"}
        </span>
      </div>
    </div>
  );
}

/**
 * R131-TH (TH3 — the honesty guard for OTHER binaries): when the TEXT
 * route's fetched content carries a NUL byte, the file is not text — the
 * raw <pre> would render mojibake. This notice is the honest equivalent in
 * the panels' empty-state grammar (tertiary ink, centered). Deliberately
 * WITHOUT a byte count: the text route's decode is lossy (invalid sequences
 * became U+FFFD long before this side), so any "N bytes" figure computed
 * from the decoded string would be a fabrication — the tree node's true
 * size never reaches the viewer tab.
 */
export function BinaryFileNotice() {
  const styles = useThemeStyles();
  return (
    <div
      data-testid="file-binary-notice"
      className="h-full grid place-items-center px-6 text-center"
    >
      {/* The 11px tier via the style leg — zero arbitrary-value spellings. */}
      <div className="font-mono" style={{ color: styles.textTertiary, fontSize: 11 }}>
        Binary file — not rendered as text.
      </div>
    </div>
  );
}

/** The shared decision helper: does this path/name deserve the image pane?
 * (isDisplayableImageAttachment re-exported for one-spelling consumption at
 * the panels' decision trees.) */
export { isDisplayableImageAttachment };
