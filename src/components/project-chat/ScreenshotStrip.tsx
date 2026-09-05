import { useEffect, useState } from "react";
import { Camera, ImageIcon } from "lucide-react";
import { Dialog, DialogContent, DialogHeader } from "../ui/dialog";
import { fetchComputerFrameRaster } from "../../lib/api";
import { formatTime } from "../../lib/format";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { withAlpha } from "../dashboard/helpers";

/**
 * ROUND-67 (R67/D): the live screenshot THUMBNAIL strip — the owner: "if the
 * agent takes screenshots or does some image work, then the images should be
 * shown during its thinking in the agent's chat window itself, in a small
 * view (like what screenshot was taken and such)."
 *
 * Rendered ONCE per live turn (below the WorkingSection, in AgentChatPanel's
 * live block) from `liveTurn.screenshots` — one entry per `{type:"screenshot"}`
 * SSE frame the plugins emit after a successful capture (computer-use
 * screenshot / zoom / get_app_state includeScreenshot, browser_control
 * screenshot). Each tile LAZY-FETCHES the PNG bytes from
 * GET /computer-use/frames/:frameId/raster (via api.fetchComputerFrameRaster —
 * bearer-authed, blob) and renders them through an object URL.
 *
 * HONESTY LIMITS (deliberate): the rasters are EPHEMERAL server-side (LRU 12,
 * 10-minute TTL, never persisted, never model-facing) — a tile whose fetch
 * 404s shows the quiet "expired" placeholder instead of a spinner forever,
 * and the strip itself vanishes with the live turn (the folded log owns no
 * screenshot history; the bytes are gone by then anyway).
 *
 * Props-driven, NO store imports (the DebugReportCard discipline): the auth +
 * baseUrl ride fetchComputerFrameRaster's own config-store read; clicking a
 * tile opens a Dialog with the full image + the capturing tool + timestamp.
 */

/** One strip entry (LiveScreenshot in stream-store — structural copy so the
 * component stays store-import-free). */
export interface ScreenshotStripShot {
  frameId: string;
  tool: string;
  ts: number;
}

export interface ScreenshotStripProps {
  screenshots: ScreenshotStripShot[];
}

/** The tile's fetch outcome: the object URL, the honest expired state, or
 * (briefly) nothing while the bytes are in flight. */
type TileState = { url: string; expired: false } | { url: null; expired: true } | { url: null; expired: false };

/** One thumbnail tile: lazy-fetch on mount, revoke the object URL on
 * unmount, quiet "expired" placeholder on failure, click → the dialog. */
function ScreenshotThumb({ shot }: { shot: ScreenshotStripShot }) {
  const styles = useThemeStyles();
  const [state, setState] = useState<TileState>({ url: null, expired: false });
  const [open, setOpen] = useState(false);

  // Lazy-fetch the raster once per mount. The object URL is REVOKED on
  // unmount (the turn ended / the cap-8 eviction dropped the tile) — no leak.
  useEffect(() => {
    let cancelled = false;
    fetchComputerFrameRaster(shot.frameId)
      .then((blob) => {
        if (cancelled) return;
        setState({ url: URL.createObjectURL(blob), expired: false });
      })
      .catch(() => {
        if (cancelled) return;
        // Honest 404 (TTL / LRU eviction / a restarted sidecar) — the quiet
        // placeholder tile, never a crash and never a retry loop.
        setState({ url: null, expired: true });
      });
    return () => {
      cancelled = true;
    };
  }, [shot.frameId]);

  // Revoke whenever the URL changes or the tile goes away.
  useEffect(() => {
    return () => {
      if (state.url !== null) URL.revokeObjectURL(state.url);
    };
  }, [state.url]);

  return (
    <>
      <figure className="shrink-0 m-0 flex flex-col items-stretch gap-1 max-w-[280px]">
        <button
          type="button"
          data-testid="screenshot-thumb"
          onClick={() => setOpen(true)}
          aria-label={`Open screenshot captured by ${shot.tool}`}
          title={`Screenshot captured by ${shot.tool} at ${formatTime(new Date(shot.ts).toISOString())}`}
          className="h-20 w-full min-w-[7.5rem] shrink-0 rounded-lg border overflow-hidden transition-opacity hover:opacity-80 flex items-center justify-center"
          style={{
            borderColor: styles.borderSubtle,
            background: styles.subtle,
          }}
        >
          {state.url !== null ? (
            <img
              src={state.url}
              alt={`Screenshot captured by ${shot.tool}`}
              className="h-20 w-auto max-w-full object-cover"
              draggable={false}
            />
          ) : state.expired ? (
            // The honest expired tile (rasters are in-memory only, 10-minute
            // TTL — by design, see the strip docblock).
            <span
              className="flex flex-col items-center gap-1 text-[9.5px] leading-tight px-1 text-center"
              style={{ color: styles.textTertiary }}
            >
              <ImageIcon size={14} aria-hidden />
              expired
            </span>
          ) : (
            // Bytes in flight — the quiet tile skeleton (same box, no spin).
            <span style={{ color: styles.textTertiary }}>
              <ImageIcon size={14} aria-hidden />
            </span>
          )}
        </button>
        {/* The caption — WHAT the agent captured (the owner: "like what
            screenshot was taken and such"). */}
        <figcaption
          className="text-[9.5px] text-center truncate"
          style={{ color: styles.textTertiary }}
          title={`Screenshot · ${shot.tool}`}
        >
          Screenshot · {shot.tool}
        </figcaption>
      </figure>
      {/* The full view: click a tile → the image at native size + the
          capturing tool + the timestamp. */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-testid="screenshot-dialog" className="items-center">
          <DialogHeader
            title="Screenshot"
            description={`Captured by ${shot.tool} at ${formatTime(new Date(shot.ts).toISOString())} — rasters are in-memory only (10-minute lifetime)`}
          />
          <div className="p-4 min-w-0 flex items-center justify-center overflow-auto">
            {state.url !== null ? (
              <img
                src={state.url}
                alt={`Screenshot captured by ${shot.tool}`}
                className="max-w-full max-h-[60vh] rounded-lg border"
                style={{ borderColor: styles.borderSubtle }}
                draggable={false}
              />
            ) : (
              <span className="text-xs" style={{ color: styles.textTertiary }}>
                The raster expired (in-memory only, 10-minute lifetime).
              </span>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * The strip itself: a small "Screenshots" header + the horizontal row of
 * tiles. Renders NOTHING when there are no screenshots (the owner sees the
 * section only when the agent actually captured something).
 */
export function ScreenshotStrip({ screenshots }: ScreenshotStripProps) {
  const styles = useThemeStyles();
  if (screenshots.length === 0) return null;
  return (
    <div data-testid="screenshot-strip" className="mt-2 mb-1 min-w-0">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Camera size={12} aria-hidden style={{ color: withAlpha(styles.accent, 0.9) }} />
        <span className="text-[11px] font-bold" style={{ color: styles.textSecondary }}>
          Screenshots
        </span>
        <span className="text-[10px]" style={{ color: styles.textTertiary }}>
          {screenshots.length}
        </span>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1 min-w-0">
        {screenshots.map((shot) => (
          <ScreenshotThumb key={`${shot.frameId}-${shot.ts}`} shot={shot} />
        ))}
      </div>
    </div>
  );
}
