import { useEffect, useState } from "react";
import { ImageIcon } from "lucide-react";
import { Dialog, DialogContent, DialogHeader } from "../ui/dialog";
import { fetchComputerFrameRaster } from "../../lib/api";
import { formatTime } from "../../lib/format";
import { useThemeStyles } from "../../lib/use-theme-styles";

/**
 * ROUND-68 (R68-A, owner: "The screenshots were supposed to be shown properly
 * when they were actually taken, not at the bottom in a dedicated section.
 * When the screenshots were taken they should be shown at that specific
 * time."): the INLINE screenshot row — one row per `screenshot`
 * WorkingEntry, rendered by WorkingSection at the entry's position in the
 * working stream (the R67-D bottom strip is gone). The stream-store pushes
 * the entry onto liveTurn.working the instant the `{type:"screenshot"}`
 * sideband frame arrives — which fires DURING tool execution, right after
 * the in-flight tool row — so this row lands at exactly the capture moment,
 * interleaved with the tool rows above/below it.
 *
 * The row is a compact horizontal tile (~300px wide, ~120px image area,
 * object-cover) that LAZY-FETCHES the PNG bytes from
 * GET /computer-use/frames/:frameId/raster (via api.fetchComputerFrameRaster
 * — bearer-authed, blob) and renders them through an object URL.
 *
 * HONESTY LIMITS (deliberate, inherited from R67-D): the rasters are
 * EPHEMERAL server-side (LRU 12, 10-minute TTL, never persisted, never
 * model-facing) — a row whose fetch 404s shows the quiet "expired"
 * placeholder instead of a spinner forever, and the rows are LIVE-ONLY (the
 * server event log never persists rasters, so the folded log carries no
 * screenshot entries by design; the bytes are gone by then anyway).
 *
 * Props-driven, NO store imports (the DebugReportCard discipline): the auth +
 * baseUrl ride fetchComputerFrameRaster's own config-store read; clicking the
 * row opens a Dialog with the full image + the capturing tool + timestamp.
 */

/** The inline entry's shape (the `screenshot` WorkingEntry in api.ts — a
 * structural copy so the component stays store/import-free). */
export interface ScreenshotRowShot {
  frameId: string;
  tool: string;
  ts: string;
}

export interface ScreenshotRowProps {
  shot: ScreenshotRowShot;
}

/** The row's fetch outcome: the object URL, the honest expired state, or
 * (briefly) nothing while the bytes are in flight. */
type TileState = { url: string; expired: false } | { url: null; expired: true } | { url: null; expired: false };

/** One inline capture row: lazy-fetch on mount, revoke the object URL on
 * unmount, quiet "expired" placeholder on failure, click → the dialog. */
export function ScreenshotRow({ shot }: ScreenshotRowProps) {
  const styles = useThemeStyles();
  const [state, setState] = useState<TileState>({ url: null, expired: false });
  const [open, setOpen] = useState(false);

  // Lazy-fetch the raster once per mount. The object URL is REVOKED on
  // unmount (the turn ended / the section collapsed) — no leak.
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
        // expired placeholder, never a crash and never a retry loop.
        setState({ url: null, expired: true });
      });
    return () => {
      cancelled = true;
    };
  }, [shot.frameId]);

  // Revoke whenever the URL changes or the row goes away.
  useEffect(() => {
    return () => {
      if (state.url !== null) URL.revokeObjectURL(state.url);
    };
  }, [state.url]);

  return (
    <>
      {/* ROUND-68 (R68-A): the row sits in the WorkingSection's column flow
          (my-1, max-w-[300px]) — NOT a horizontal strip at the bottom. The
          ~120px image area with object-cover crops the capture to a tile;
          the click target opens the full-size view. */}
      <figure data-testid="screenshot-row" className="my-1 m-0 flex flex-col items-stretch gap-1 max-w-[300px] min-w-0">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`Open screenshot captured by ${shot.tool}`}
          title={`Screenshot captured by ${shot.tool} at ${formatTime(shot.ts)}`}
          className="h-[120px] w-full rounded-lg border overflow-hidden transition-opacity hover:opacity-80 flex items-center justify-center min-w-0"
          style={{
            borderColor: styles.borderSubtle,
            background: styles.subtle,
          }}
        >
          {state.url !== null ? (
            <img
              src={state.url}
              alt={`Screenshot captured by ${shot.tool}`}
              className="h-[120px] w-full object-cover"
              draggable={false}
            />
          ) : state.expired ? (
            // The honest expired row (rasters are in-memory only, 10-minute
            // TTL — by design, see the docblock). R100-D: 9.5→10px (the
            // type floor).
            <span
              className="flex flex-col items-center gap-1 text-[10px] leading-tight px-1 text-center"
              style={{ color: styles.textTertiary }}
            >
              <ImageIcon size={14} aria-hidden />
              expired
            </span>
          ) : (
            // Bytes in flight — the quiet skeleton (same box, no spin).
            <span style={{ color: styles.textTertiary }}>
              <ImageIcon size={14} aria-hidden />
            </span>
          )}
        </button>
        {/* The caption — WHAT the agent captured and WHEN (the entry's ts is
            the capture moment; the row's position already tells the story).
            R100-D: 9.5→10px (the type floor). */}
        <figcaption
          className="text-[10px] text-center truncate"
          style={{ color: styles.textTertiary }}
          title={`Screenshot · ${shot.tool}`}
        >
          Screenshot · {shot.tool}
        </figcaption>
      </figure>
      {/* The full view: click the row → the image at native size + the
          capturing tool + the timestamp. */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-testid="screenshot-dialog" className="items-center">
          <DialogHeader
            title="Screenshot"
            description={`Captured by ${shot.tool} at ${formatTime(shot.ts)} — rasters are in-memory only (10-minute lifetime)`}
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
