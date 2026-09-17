import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
// R98-D (ADR-0030): the mermaid renderer — LAZY by design. NOTE: mermaid is
// imported ONLY inside the render effect below (dynamic import), never at
// module scope, so the ~megabyte diagram chunk loads exclusively when a
// COMPLETE mermaid fence actually mounts; ordinary chat traffic never pays
// for it (the vi.mock("mermaid") factory-run counter in ChatMarkdown.test
// is the laziness observable).
import { Code2, Eye, Minus, Plus, RotateCcw } from "lucide-react";
import { useThemeStore } from "../../lib/theme-store";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { SkeletonBlock } from "../shared/Skeletons";
import { withAlpha } from "../dashboard/helpers";
import { CodeBlock } from "./ChatMarkdown";

/**
 * ROUND-98 (R98-D, owner: "adding options to see Mermaid flow diagrams and
 * other key things in the chat properly"; ADR-0030): a COMPLETE ```mermaid
 * fence in a chat answer renders as a real diagram instead of source text.
 *
 * ROUND-101 (R101-F, owner v0.98.0: "it was not showing me the properly
 * rendered flow diagrams"; see the round-101 addendum in ADR-0030): the
 * rendering pipeline got honest about failure — the four defects fixed:
 *   · DEFECT 1 — errors SURFACE: the amber note carries the reason (a mono
 *     sub-line, first line of the error message, capped at 140 chars) and
 *     every failure logs `console.warn("[mermaid] render failed:", err)`.
 *   · DEFECT 2 — the lazy chunk import gets ONE bounded retry (400ms gap):
 *     a single asset-protocol/AV hiccup in the packaged app no longer
 *     degrades every diagram silently forever.
 *   · DEFECT 3 — mermaid.render gets ONE bounded retry with a FRESH id
 *     (transient font/theme timing on a freshly-mounted webview).
 *   · DEFECT 4 lives in WorkingSection: thinking-area mermaid fences mount
 *     this component too (the answer-text-only scope was the defect).
 *
 * ROUND-102 (R102-D, owner v0.99.0: "the mermaid flow diagram shows
 * properly now … but apparently I don't have any editing options for it. I
 * cannot zoom in on it, move it right or left, or see the raw code of it"):
 * the rendered diagram is now an INTERACTIVE VIEWER, dependency-free —
 *   · ZOOM: the toolbar's − / % / + buttons (25% steps), ctrl/cmd+wheel
 *     (the trackpad pinch gesture), clamped to 50–300%;
 *   · PAN: pointer drag (grab cursors) + arrow keys on the focused
 *     viewport — the diagram moves with the pointer 1:1 (MOTION §5: no
 *     transition on the transform — manipulation must track, not animate);
 *   · SOURCE: the View source / View diagram toggle swaps the rendered
 *     card for the raw fence in a CodeBlock (and back) — the owner's
 *     "see the raw code" ask;
 *   · RESET: the reset button (and double-click) restores 100% + center.
 * A `code`/theme re-render resets the view (a fresh diagram starts at
 * 100%, centered, diagram-side).
 *
 * Contracts (ADR-0030 + the design language):
 * - LAZY — `import("mermaid")` runs only when this component mounts, and the
 *   component only mounts for a CLOSED mermaid fence (ChatMarkdown's scanner
 *   passes `terminated`; a mid-stream unclosed fence stays a plain CodeBlock,
 *   so the renderer never pops in/out while a diagram source streams in).
 * - SAFE — `securityLevel: "strict"` ALWAYS (mermaid's sanitizer wraps the
 *   model-provided source; the SVG lands via dangerouslySetInnerHTML only
 *   after that sanitization), `startOnLoad: false` (we drive rendering
 *   ourselves), and the theme follows the app theme store (dark → "dark",
 *   light → "default") so diagrams match the active mode.
 * - HONEST — a render failure (invalid syntax, a mermaid internals change,
 *   a load failure) NEVER crashes or blanks the message: an amber one-line
 *   note (SEMANTIC_COLORS.warning, role="status") plus the source as an
 *   ordinary CodeBlock with lang="mermaid" — the pre-R98 rendering, kept as
 *   the fallback — and, since R101-F, the failure's REASON in a mono
 *   sub-line under the note (never a silent catch).
 * - STILL — no added animation on content: diagrams are static content
 *   (MOTION §5 — nothing animates that the user didn't act on; the
 *   skeleton's breathing is the shared primitive's own, reduced-motion-safe).
 *
 * Visual: the fence-family card — the same outer shape as CodeBlock (1.5px
 * border, rounded-xl, subtle-bg header) with the header carrying the badge
 * in the EXACT CodeBlock spelling (`data-code-lang="mermaid"`) on the left
 * and the VIEWER TOOLBAR (R102-D) on the right, over a body that clips
 * (max-h-[480px], overflow-hidden) around the transformed diagram.
 */

/** The lazy chunk's public surface (mermaid's default export). */
type MermaidApi = typeof import("mermaid")["default"];

/** Monotonic id sequence for mermaid.render — every call gets a unique DOM
 * id (mermaid keys its scratch element off it; reusing one across renders
 * can leak stale SVG). R101-F: the render RETRY bumps the seq too — the
 * second attempt never reuses an id mermaid may have registered. */
let mermaidRenderSeq = 0;

/** R101-F (DEFECT 2): the gap before the ONE bounded import retry — long
 * enough for a transient WebView2 asset-protocol hiccup to clear, short
 * enough that the fallback never feels stuck. */
const MERMAID_IMPORT_RETRY_DELAY_MS = 400;

/** R102-D: the viewer's zoom bounds + step. 50–300% covers the "cannot zoom
 * in on it" ask with headroom for dense graphs; the 25% button step keeps
 * the % label readable. */
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.25;

const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** R101-F (DEFECT 1): the honest error line for the amber note. Walks the
 * error's `cause` chain (bounded, 5 hops) preferring the DEEPEST non-empty
 * message — wrappers bury the actual reason ("Failed to fetch dynamically
 * imported module" can arrive wrapped by the loader; test runners wrap
 * factory throws) — then takes the FIRST line and caps it at 140 characters
 * so a mermaid stack novel cannot flood the transcript. null when there is
 * nothing printable (the note alone renders). */
function describeMermaidError(err: unknown): string | null {
  let message = "";
  let current: unknown = err;
  for (let hop = 0; hop < 5 && current instanceof Error; hop += 1) {
    if (current.message.trim() !== "") message = current.message;
    current = (current as { cause?: unknown }).cause;
  }
  if (message === "" && typeof err === "string") message = err;
  if (message === "") return null;
  const firstLine = message.split("\n")[0] ?? "";
  return firstLine.length > 140 ? `${firstLine.slice(0, 139)}…` : firstLine;
}

export function MermaidDiagram({ code }: { code: string }) {
  const styles = useThemeStyles();
  const mode = useThemeStore((s) => s.mode);
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // R101-F (DEFECT 1): the failure's REASON (describeMermaidError's capped
  // line) — null until a failure actually lands, rendered as the mono
  // sub-line under the amber note.
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  // ── R102-D: the viewer state ─────────────────────────────────────────────
  // zoom/pan ride a transform on the diagram wrapper; showSource swaps the
  // rendered card for the raw CodeBlock. A `code`/theme change resets the
  // view (inside the render effect below — one reset point).
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [showSource, setShowSource] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragLast = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  /** The viewport element — hosts the NON-passive ctrl+wheel listener
   * (React's synthetic onWheel is passive-rooted; preventDefault inside it
   * would warn AND let the browser page-zoom fight the diagram zoom). */
  const viewportRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // R98-D: the cancelled-flag race guard — React 18 StrictMode mounts
    // effects twice in dev, and a theme flip re-runs this effect while the
    // previous render is still in flight; only the LAST run may commit.
    // R101-F: the guard now spans BOTH import attempts and BOTH render
    // attempts — an abort between them skips the pointless retry.
    // R102-D: a re-render also RESETS THE VIEW — a fresh diagram starts at
    // 100%, centered, diagram-side (the owner's manipulation state never
    // leaks across diagrams).
    let cancelled = false;
    setSvg(null);
    setFailed(false);
    setErrorDetail(null);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setShowSource(false);
    void (async () => {
      try {
        // R101-F (DEFECT 2): ONE bounded retry of the dynamic import. A lazy
        // chunk that fails to fetch ONCE in the packaged app (asset-protocol
        // hiccup, AV interference) used to silently degrade every diagram
        // forever; now it gets one immediate second chance, and only a
        // SECOND failure flows to the honest note — with its message, so
        // "Failed to fetch dynamically imported module" is diagnosable.
        let mermaid: MermaidApi;
        try {
          mermaid = (await import("mermaid")).default;
        } catch (firstImportError) {
          console.warn(
            "[mermaid] chunk import failed once — one bounded retry:",
            firstImportError,
          );
          await new Promise((resolve) => setTimeout(resolve, MERMAID_IMPORT_RETRY_DELAY_MS));
          // The race guard covers both attempts: if the component went away
          // during the gap, skip the retry entirely.
          if (cancelled) return;
          mermaid = (await import("mermaid")).default;
        }
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: mode === "dark" ? "dark" : "default",
        });
        // R101-F (DEFECT 3): ONE bounded retry of mermaid.render with a
        // FRESH id — render can fail transiently (font/theme timing on the
        // first paint in a freshly-mounted webview) even with valid syntax;
        // a syntax error simply fails twice identically, which is the honest
        // price of covering the transient case (the retry is synchronous
        // and cheap). The seq bumps per attempt — an id mermaid may have
        // registered is never reused.
        let rendered: string;
        try {
          rendered = (
            await mermaid.render(`acute-mermaid-${(mermaidRenderSeq += 1)}`, code)
          ).svg;
        } catch (firstRenderError) {
          console.warn(
            "[mermaid] render failed once — one bounded retry with a fresh id:",
            firstRenderError,
          );
          rendered = (
            await mermaid.render(`acute-mermaid-${(mermaidRenderSeq += 1)}`, code)
          ).svg;
        }
        if (!cancelled) setSvg(rendered);
      } catch (err) {
        // Never a crash, never a blank — the honest fallback below. R101-F
        // (DEFECT 1): the failure is no longer SILENT — the reason goes to
        // the console and, capped, into the amber note itself.
        console.warn("[mermaid] render failed:", err);
        if (!cancelled) {
          setFailed(true);
          setErrorDetail(describeMermaidError(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, mode]);

  // R102-D: the NON-passive ctrl/cmd+wheel zoom listener. ctrl+wheel is the
  // browser's page-zoom + the trackpad PINCH gesture — both must zoom the
  // DIAGRAM, not the app: preventDefault is the whole point, so the listener
  // is attached natively with { passive: false } (React's synthetic wheel
  // events are passive at the root — preventDefault there only warns).
  // Plain wheel (two-finger scroll) deliberately does NOTHING here: the
  // page's transcript keeps scrolling through the card (a hijacked wheel
  // over every diagram would be a scroll trap).
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom((z) => clampZoom(z * (1 - e.deltaY * 0.0015)));
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, []);

  // ── R102-D: the pointer-drag pan (screen-space, 1:1 with the pointer) ────
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    dragLast.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const last = dragLast.current;
    if (last === null || last.pointerId !== e.pointerId) return;
    const dx = e.clientX - last.x;
    const dy = e.clientY - last.y;
    dragLast.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
    setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
  };
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragLast.current?.pointerId !== e.pointerId) return;
    dragLast.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  /** R102-D: keyboard pan — the focused viewport moves the diagram with the
   * arrow keys (48px per press; shift jumps 4×). The viewport is a real
   * tab-stop (tabIndex 0) with an honest label, so the viewer is fully
   * operable without a pointer. */
  const onViewportKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 192 : 48;
    const map: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const delta = map[e.key];
    if (delta === undefined) return;
    e.preventDefault();
    setPan((p) => ({ x: p.x + delta[0], y: p.y + delta[1] }));
  };

  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  /** The toolbar's small-button idiom (R102-D): the settings-card icon
   * button grammar — 28px, rounded-lg, muted icon, the CSS hover wash. */
  const toolBtn = (
    label: string,
    icon: ReactNode,
    onClick: () => void,
    testId: string,
    pressed = false,
  ) => (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={pressed || undefined}
      data-testid={testId}
      className="h-7 w-7 grid place-items-center rounded-lg transition-colors hover:bg-hover"
      style={{ color: pressed ? styles.accent : styles.textTertiary }}
    >
      {icon}
    </button>
  );

  // ── FAILED: the amber note + the reason + the source as a CodeBlock ───────
  if (failed) {
    return (
      <div className="my-1.5">
        <p role="status" className="mb-1 text-[11px] font-medium" style={{ color: SEMANTIC_COLORS.warning }}>
          Diagram could not be rendered — showing source
        </p>
        {/* R101-F (DEFECT 1): the reason, mono + capped at 140 chars — the
            silent amber catch was the defect. Inline fontSize (the computed
            ladder's idiom — see ChatMarkdown's HEADING_SIZES) so the audit's
            arbitrary-px ratchet stays untouched. */}
        {errorDetail !== null && (
          <p
            data-testid="mermaid-error-detail"
            className="mb-1 font-mono break-all"
            style={{ color: SEMANTIC_COLORS.warning, fontSize: "10px" }}
          >
            {errorDetail}
          </p>
        )}
        <CodeBlock code={code} lang="mermaid" />
      </div>
    );
  }

  // ── LOADING / RENDERED: the fence-family card ─────────────────────────────
  return (
    <div className="my-1.5 rounded-xl overflow-hidden border-[1.5px]" style={{ borderColor: styles.border }}>
      <div
        className="flex items-center justify-between gap-2 px-3 py-1.5 border-b"
        style={{ background: styles.subtle, borderColor: styles.border }}
      >
        <span className="flex min-w-0 items-center gap-2">
          {/* The EXACT CodeBlock badge spelling (ChatMarkdown's data-code-lang
              chip) so the diagram card reads as one of the fence family.
              R100-D: snapped with its CodeBlock twin — rounded-sm (the 4px
              step) + 10px/medium (the type floor + weight law). */}
          <span
            data-code-lang="mermaid"
            className="shrink-0 rounded-sm px-1.5 py-px font-mono text-[10px] font-medium uppercase tracking-wide"
            style={{
              background: withAlpha(styles.accent, styles.isDark ? 0.16 : 0.1),
              color: styles.accent,
            }}
          >
            mermaid
          </span>
          {/* R102-D: the source-view indicator — while the raw fence shows,
              the badge row says so (the toggle below flips back). */}
          {showSource && (
            <span className="text-[10px] uppercase tracking-wide" style={{ color: styles.textTertiary }}>
              source
            </span>
          )}
        </span>
        {/* R102-D: THE VIEWER TOOLBAR — zoom out / the live % / zoom in /
            reset / source toggle. Only rendered once a diagram (or the
            source view) exists — never over the loading skeleton. */}
        {(svg !== null || showSource) && (
          <span className="flex shrink-0 items-center gap-0.5">
            {toolBtn("Zoom out", <Minus size={13} />, () => setZoom((z) => clampZoom(z - ZOOM_STEP)), "mermaid-zoom-out")}
            <span
              data-testid="mermaid-zoom-level"
              className="w-10 text-center text-[11px] tabular-nums"
              style={{ color: styles.textTertiary }}
            >
              {Math.round(zoom * 100)}%
            </span>
            {toolBtn("Zoom in", <Plus size={13} />, () => setZoom((z) => clampZoom(z + ZOOM_STEP)), "mermaid-zoom-in")}
            {toolBtn(
              "Reset view",
              <RotateCcw size={13} />,
              resetView,
              "mermaid-zoom-reset",
            )}
            {toolBtn(
              showSource ? "View diagram" : "View source",
              showSource ? <Eye size={13} /> : <Code2 size={13} />,
              () => setShowSource((s) => !s),
              "mermaid-toggle-source",
              showSource,
            )}
          </span>
        )}
      </div>
      {showSource ? (
        /* R102-D: the raw fence — the SAME CodeBlock the pre-R98 rendering
           used, minus its own outer margin (it lives inside the card). */
        <div className="p-1">
          <CodeBlock code={code} lang="mermaid" />
        </div>
      ) : svg === null ? (
        <div role="status" aria-label="Rendering diagram" className="p-3">
          {/* The shared loading primitive (COMPONENTS §1): decorative
              SkeletonBlock; the single announcement lives HERE on the
              container, exactly per the primitive's contract. */}
          <SkeletonBlock className="h-[120px] w-full" />
        </div>
      ) : (
        /* R102-D: THE VIEWPORT — clips (max-h-[480px], overflow-hidden)
           around the transformed diagram. The transform is translate (screen
           px) THEN scale (origin center): zoom grows from the center, pan
           tracks the pointer 1:1, and NO transition rides the transform
           (MOTION §5 — manipulation must track, not animate). */
        <div
          ref={viewportRef}
          data-testid="mermaid-viewport"
          role="img"
          aria-label="Diagram — drag or use the arrow keys to pan; ctrl+scroll or the toolbar buttons to zoom"
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={resetView}
          onKeyDown={onViewportKeyDown}
          className="max-h-[480px] overflow-hidden flex items-center justify-center p-3 outline-none"
          style={{
            cursor: dragging ? "grabbing" : zoom !== 1 ? "grab" : "default",
            // touch-action: while zoomed/panned, the viewport owns the
            // gesture (touch drag pans the diagram); at rest, touch scroll
            // falls through to the transcript.
            touchAction: zoom !== 1 ? "none" : undefined,
          }}
        >
          <div
            data-testid="mermaid-stage"
            className="min-w-0"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: "center center",
            }}
          >
            {/* mermaid's strict-securityLevel SVG (sanitized source — never
                raw model HTML passthrough; ADR-0030's rendering contract). */}
            <div dangerouslySetInnerHTML={{ __html: svg }} />
          </div>
        </div>
      )}
    </div>
  );
}
