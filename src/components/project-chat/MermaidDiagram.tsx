import { useEffect, useState } from "react";
// R98-D (ADR-0030): the mermaid renderer — LAZY by design. NOTE: mermaid is
// imported ONLY inside the render effect below (dynamic import), never at
// module scope, so the ~megabyte diagram chunk loads exclusively when a
// COMPLETE mermaid fence actually mounts; ordinary chat traffic never pays
// for it (the vi.mock("mermaid") factory-run counter in ChatMarkdown.test
// is the laziness observable).
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
 *   the fallback.
 * - STILL — no added animation: diagrams are static content (MOTION §5 —
 *   nothing animates that the user didn't act on; the skeleton's breathing
 *   is the shared primitive's own, reduced-motion-safe).
 *
 * Visual: the fence-family card — the same outer shape as CodeBlock (1.5px
 * border, rounded-xl, subtle-bg header) with the header carrying the badge
 * in the EXACT CodeBlock spelling (`data-code-lang="mermaid"`), and a body
 * that scrolls (max-h-[480px]) around the natural-size, horizontally
 * centered SVG.
 */

/** Monotonic id sequence for mermaid.render — every call gets a unique DOM
 * id (mermaid keys its scratch element off it; reusing one across renders
 * can leak stale SVG). */
let mermaidRenderSeq = 0;

export function MermaidDiagram({ code }: { code: string }) {
  const styles = useThemeStyles();
  const mode = useThemeStore((s) => s.mode);
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // R98-D: the cancelled-flag race guard — React 18 StrictMode mounts
    // effects twice in dev, and a theme flip re-runs this effect while the
    // previous render is still in flight; only the LAST run may commit.
    let cancelled = false;
    setSvg(null);
    setFailed(false);
    const id = `acute-mermaid-${(mermaidRenderSeq += 1)}`;
    void (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: mode === "dark" ? "dark" : "default",
        });
        const { svg: rendered } = await mermaid.render(id, code);
        if (!cancelled) setSvg(rendered);
      } catch {
        // Never a crash, never a blank — the honest fallback below.
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, mode]);

  // ── FAILED: the amber note + the source as an ordinary CodeBlock ──────────
  if (failed) {
    return (
      <div className="my-1.5">
        <p role="status" className="mb-1 text-[11px] font-medium" style={{ color: SEMANTIC_COLORS.warning }}>
          Diagram could not be rendered — showing source
        </p>
        <CodeBlock code={code} lang="mermaid" />
      </div>
    );
  }

  // ── LOADING / RENDERED: the fence-family card ─────────────────────────────
  return (
    <div className="my-1.5 rounded-xl overflow-hidden border-[1.5px]" style={{ borderColor: styles.border }}>
      <div
        className="flex items-center justify-between px-3 py-1.5 border-b"
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
        </span>
      </div>
      {svg === null ? (
        <div role="status" aria-label="Rendering diagram" className="p-3">
          {/* The shared loading primitive (COMPONENTS §1): decorative
              SkeletonBlock; the single announcement lives HERE on the
              container, exactly per the primitive's contract. */}
          <SkeletonBlock className="h-[120px] w-full" />
        </div>
      ) : (
        <div className="max-w-full max-h-[480px] overflow-auto flex justify-center p-3">
          {/* mermaid's strict-securityLevel SVG (sanitized source — never
              raw model HTML passthrough; ADR-0030's rendering contract). */}
          <div className="min-w-0" dangerouslySetInnerHTML={{ __html: svg }} />
        </div>
      )}
    </div>
  );
}
