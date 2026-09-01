import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useThemeStyles } from "../lib/use-theme-styles";
import { nativeTabScrollState, nativeTabScrollTo, type TabScrollState } from "../lib/native-browser";

/**
 * ROUND-60 (R60-A) — the pop-out window's GUTTER scrollbar.
 *
 * The owner's R60 verdict on the R59 pop-out chrome: "The scroll bar should
 * be custom themed on every single page. It should not show inside the
 * section but on the right side outside it, like outside the empty section
 * itself." This component IS that scrollbar: a themed pill that lives in the
 * window chrome's right gutter, NEXT TO (never inside) the content card.
 *
 * The page's own VIEWPORT scrollbar is hidden document-start by the Rust
 * init script (browser_tab_create's hide_viewport_scrollbar — see
 * popout-tab.ts); this bar becomes the one scrollbar. Its geometry comes
 * from `browser_tab_scroll_state` (the eval_with_callback probe: {y, vh, ch,
 * css}) polled every 250ms, and its position is driven back into the page
 * with `browser_tab_scroll_to` (rAF-throttled, fire-and-forget).
 *
 * Honesty rules (the R59 language — the chrome never lies, never crashes):
 *   - `css === false` (a CSP-strict page blocked the init script's style)
 *     → the page keeps its OWN native viewport bar, so this bar HIDES —
 *     there must never be two scrollbars.
 *   - no state (webview gone / probe timed out / payload invalid) → hidden.
 *   - `ch <= vh + 2` (page does not overflow) → hidden.
 *   - while hidden the COLUMN stays (stable layout — the card never
 *     reflows when a page starts or stops scrolling), it just renders
 *     nothing visible.
 *   - while a drag is ACTIVE the poll pauses — the drag owns the position
 *     optimistically until pointerup, then the poll re-syncs.
 *   - `nativeTabScrollTo` rejections are console.warn'd, never surfaced —
 *     a scrollbar that fails one frame is no reason to break the window.
 *
 * The visual is the R59-A floating pill (the exact index.css scrollbar-thumb
 * trick): a 4px painted pill in a 10px slot — 3px transparent borders all
 * around + background-clip: padding-box — at 22% text color, deepening on
 * hover/focus/drag; the track is fully transparent until the gutter is
 * hovered, and even then only a barely-there 6% tint.
 */

/** How often the scroll state is re-probed (ms) — the poll cadence. */
const POLL_MS = 250;

/** The thumb never gets smaller than this (px) — a pill you can actually grab. */
const MIN_THUMB_PX = 24;

/** Keyboard scroll step for ArrowUp/ArrowDown (px) — the browser default. */
const ARROW_KEY_PX = 40;

/** Clamp into [min, max]; non-finite input maps to min (never NaN to Rust). */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** One in-progress drag session — captured at pointerdown, used until pointerup. */
interface DragSession {
  pointerId: number;
  /** px from the track top to the grabbed point on the thumb. */
  grabOffset: number;
  /** The track's rect top at drag start (client px). */
  trackTop: number;
  /** Track height frozen at drag start (stable math through the drag). */
  trackH: number;
  /** Thumb height frozen at drag start. */
  thumbH: number;
  /** Max scroll frozen at drag start. */
  maxScroll: number;
  /** The element that holds the pointer capture (null where unsupported). */
  captured: HTMLElement | null;
}

export function GutterScrollbar({ tabId }: { tabId: string }) {
  const styles = useThemeStyles();

  // The gutter COLUMN is always mounted (stable layout) — its rect IS the
  // track's rect (the track overlays it with absolute inset-0), so the
  // column's height can be measured even while the bar is hidden.
  const rootRef = useRef<HTMLDivElement | null>(null);
  /** The active drag session, or null (a ref: pointermove must not re-render). */
  const dragRef = useRef<DragSession | null>(null);
  /** The scroll_to target awaiting its rAF turn (coalesces rapid moves). */
  const pendingYRef = useRef<number | null>(null);
  /** rAF handle of the scheduled scroll_to (0 = idle). */
  const rafRef = useRef(0);
  /** Poll results are DISCARDED while a drag owns the position. */
  const draggingRef = useRef(false);
  /** One probe at a time — a wedged page's 2s timeout must not pile up. */
  const pollInFlightRef = useRef(false);

  /** The track height (px) — 0 until measured (a 0-height track hides the bar). */
  const [trackH, setTrackH] = useState(0);
  /** The last probed geometry, or null (hidden — no data / no webview). */
  const [state, setState] = useState<TabScrollState | null>(null);
  /** The effective scroll offset — probed, or optimistic during a drag. */
  const [y, setY] = useState(0);
  /** Interaction states that deepen the pill: hover / keyboard focus / drag. */
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dragging, setDragging] = useState(false);

  // ── geometry: the column's height IS the track height ───────────────────
  // Measured on mount and re-measured through a ResizeObserver (the pop-out
  // window resizing resizes the row, which stretches this column) + a window
  // resize listener as belt-and-suspenders (the test environment's inert RO
  // rides it — the PopoutApp bounds-sync pattern). Functional setState keeps
  // `measure` identity-stable, so the observer is wired exactly once.
  const measure = useCallback(() => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect === undefined || rect.height <= 0) return;
    setTrackH((prev) => (prev === rect.height ? prev : rect.height));
  }, []);

  useEffect(() => {
    measure();
    const observer = new ResizeObserver(measure);
    if (rootRef.current !== null) observer.observe(rootRef.current);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  // ── the poll: browser_tab_scroll_state every 250ms ──────────────────────
  // Immediate on mount, then on the interval. While a drag is active the
  // tick is skipped entirely (the drag owns the position until pointerup →
  // the next tick re-syncs). nativeTabScrollState never throws — null is
  // "no data" and simply hides the bar.
  useEffect(() => {
    let disposed = false;
    const poll = async () => {
      if (draggingRef.current || pollInFlightRef.current) return;
      pollInFlightRef.current = true;
      const next = await nativeTabScrollState(tabId);
      pollInFlightRef.current = false;
      if (disposed) return;
      if (next === null) {
        // No webview / probe timeout / invalid payload — hidden, not broken.
        setState(null);
        return;
      }
      // Not dragging here (checked above) — the probe's offset is the truth.
      setState(next);
      setY(next.y);
    };
    void poll();
    const id = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      disposed = true;
      window.clearInterval(id);
      pollInFlightRef.current = false;
    };
  }, [tabId]);

  // ── scrolling: rAF-throttled, fire-and-forget, never an error UI ────────
  const scrollTo = useCallback(
    (target: number) => {
      pendingYRef.current = target;
      if (rafRef.current !== 0) return;
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = 0;
        const pending = pendingYRef.current;
        pendingYRef.current = null;
        if (pending === null) return;
        nativeTabScrollTo(tabId, pending).catch((err) => {
          // The page may have navigated away mid-drag — warn and move on.
          console.warn("[popout] gutter scroll_to failed", err);
        });
      });
    },
    [tabId],
  );

  // Cancel any rAF that never fired (unmounted mid-drag).
  useEffect(() => {
    return () => {
      if (rafRef.current !== 0) window.cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, []);

  // ── derived geometry ─────────────────────────────────────────────────────
  const maxScroll = state === null ? 0 : Math.max(0, state.ch - state.vh);
  const thumbH = state !== null && trackH > 0 && state.ch > 0
    ? Math.max(MIN_THUMB_PX, (trackH * state.vh) / state.ch)
    : 0;
  const thumbTop = maxScroll > 0 && thumbH > 0
    ? (trackH - thumbH) * (clamp(y, 0, maxScroll) / maxScroll)
    : 0;
  // Visible only with real overflow AND the page's viewport bar actually
  // hidden by our CSS (css:true) — never two scrollbars at once.
  const visible = state !== null && state.css && state.ch > state.vh + 2 && trackH > 0;

  // ── drag: pointerdown → capture → move → pointerup ──────────────────────
  // The move/up/cancel handlers live on the TRACK (thumb events bubble into
  // it, and a pointer captured on the THUMB retargets its moves there —
  // both paths reach the track), while the thumb's pointerdown stops
  // propagation so the track's page-jump handler never double-fires.
  const applyDragTarget = useCallback(
    (pointerY: number) => {
      const drag = dragRef.current;
      if (drag === null) return;
      const denom = drag.trackH - drag.thumbH;
      if (denom <= 0 || drag.maxScroll <= 0) return;
      const target = clamp(
        ((pointerY - drag.trackTop - drag.grabOffset) / denom) * drag.maxScroll,
        0,
        drag.maxScroll,
      );
      // Optimistic: the thumb tracks the pointer NOW; the paused poll
      // re-syncs after release.
      setY(target);
      scrollTo(target);
    },
    [scrollTo],
  );

  const beginDrag = useCallback(
    (e: ReactPointerEvent, grabOffset: number) => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (rect === undefined || thumbH <= 0) return;
      // Capture so moves OUTSIDE the thumb (and outside the window) keep
      // coming to the captured element. The try/catch + null default keep
      // DOMs without pointer capture (the test environment) fully working.
      const el = e.currentTarget as HTMLElement;
      let captured: HTMLElement | null = null;
      if (typeof el.setPointerCapture === "function") {
        try {
          el.setPointerCapture(e.pointerId);
          captured = el;
        } catch {
          // Capture refused — bubbling still delivers the moves.
        }
      }
      dragRef.current = {
        pointerId: e.pointerId,
        grabOffset,
        trackTop: rect.top,
        trackH,
        thumbH,
        maxScroll,
        captured,
      };
      draggingRef.current = true;
      setDragging(true);
    },
    [maxScroll, thumbH, trackH],
  );

  const endDrag = useCallback((e: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (drag === null) return;
    dragRef.current = null;
    draggingRef.current = false;
    setDragging(false);
    const el = drag.captured;
    if (el !== null && typeof el.releasePointerCapture === "function") {
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        // Already released by the browser — nothing to do.
      }
    }
    // The interval is still ticking — the next tick re-syncs (no immediate
    // poll call: the page is still settling into scrollTo's position).
  }, []);

  const onThumbPointerDown = (e: ReactPointerEvent) => {
    e.stopPropagation();
    // Grab the thumb where the pointer sits on it (client-space honest:
    // thumbTop is track-relative, the pointer is client-relative).
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    beginDrag(e, clamp(e.clientY - rect.top - thumbTop, 0, thumbH));
  };

  const onTrackPointerMove = (e: ReactPointerEvent) => {
    if (dragRef.current === null || dragRef.current.pointerId !== e.pointerId) return;
    applyDragTarget(e.clientY);
  };

  // ── track click: jump one page toward the click, then drag from there ───
  const onTrackPointerDown = (e: ReactPointerEvent) => {
    if (!visible || state === null) return;
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect === undefined || thumbH <= 0 || maxScroll <= 0) return;
    const pointerY = e.clientY - rect.top;
    // A page toward the click (the browser track-click behavior)…
    const target = clamp(pointerY < thumbTop ? y - state.vh : y + state.vh, 0, maxScroll);
    setY(target);
    scrollTo(target);
    // …then the drag continues with the thumb CENTERED on the pointer.
    beginDrag(e, thumbH / 2);
  };

  // ── keyboard: the full scrollbar contract on the focused track ──────────
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (state === null || maxScroll <= 0) return;
    let target: number;
    switch (e.key) {
      case "ArrowDown":
        target = y + ARROW_KEY_PX;
        break;
      case "ArrowUp":
        target = y - ARROW_KEY_PX;
        break;
      case "PageDown":
        target = y + state.vh;
        break;
      case "PageUp":
        target = y - state.vh;
        break;
      case "Home":
        target = 0;
        break;
      case "End":
        target = maxScroll;
        break;
      default:
        return;
    }
    e.preventDefault();
    target = clamp(target, 0, maxScroll);
    // Optimistic + immediate — the next poll confirms what the page did.
    setY(target);
    scrollTo(target);
  };

  // ── the pill's color: 22% text, deepening to 40% while interacted with ──
  const active = dragging || hovered || focused;
  const thumbBackground = `color-mix(in srgb, ${styles.text} ${active ? 40 : 22}%, transparent)`;
  const trackBackground = visible && hovered
    ? `color-mix(in srgb, ${styles.text} 6%, transparent)`
    : "transparent";

  return (
    <div
      ref={rootRef}
      data-testid="popout-gutter-scrollbar"
      className="relative w-[12px] shrink-0"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      {visible ? (
        // The track fills the column exactly (inset-0) — its rect IS the
        // measured rect, so the thumb math has one coordinate system.
        <div
          role="scrollbar"
          aria-label="Page scroll position"
          aria-orientation="vertical"
          aria-valuemin={0}
          aria-valuemax={Math.round(maxScroll)}
          aria-valuenow={Math.round(clamp(y, 0, maxScroll))}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onPointerDown={onTrackPointerDown}
          onPointerMove={onTrackPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          data-testid="popout-gutter-track"
          className="absolute inset-0 rounded-full outline-none"
          style={{ background: trackBackground }}
        >
          {/* The R59-A floating pill: a 10px slot, 3px transparent borders,
              background-clip padding-box → a 4px painted pill that never
              touches the slot's edges. Purely visual (aria-hidden) — the
              track above carries the scrollbar semantics. */}
          <div
            data-testid="popout-gutter-thumb"
            onPointerDown={onThumbPointerDown}
            className="absolute left-1/2 w-[10px] -translate-x-1/2 cursor-grab rounded-full border-[3px] border-transparent bg-clip-padding"
            style={{
              height: thumbH,
              top: thumbTop,
              background: thumbBackground,
              transition: "background 150ms ease",
            }}
            aria-hidden
          />
        </div>
      ) : null}
    </div>
  );
}
