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

  useEffect(() => {
    // R98-D: the cancelled-flag race guard — React 18 StrictMode mounts
    // effects twice in dev, and a theme flip re-runs this effect while the
    // previous render is still in flight; only the LAST run may commit.
    // R101-F: the guard now spans BOTH import attempts and BOTH render
    // attempts — an abort between them skips the pointless retry.
    let cancelled = false;
    setSvg(null);
    setFailed(false);
    setErrorDetail(null);
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
