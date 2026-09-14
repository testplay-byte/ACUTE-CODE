import { useThemeStyles } from "../../lib/use-theme-styles";

/**
 * ROUND-97 (R97-I, owner: "I want the UI to be aware of its states"): the
 * shared skeleton primitives. Until now every surface rolled its own ad-hoc
 * `animate-pulse` block (UsageScreen cards, ChatView bubbles, explorer
 * TreeSkeleton rows…) — consistent values, five spellings. These two
 * components are the one spelling: the DESIGN-SYSTEM §6 "loading: skeleton
 * rows, spinners, NEVER blank flashes" rule, prepackaged.
 *
 * Deliberately DECORATIVE (aria-hidden) — a loading REGION announces itself
 * once on its container (`role="status" aria-label="Loading …"`), not per
 * block; the call sites own that label. Colors flow from the theme bridge
 * (styles.subtle) so skeletons adapt to every theme/mode like real surfaces.
 */

/** One pulsing block — a card, a tile, a bubble, a chart slab. */
export function SkeletonBlock({
  className = "",
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  const styles = useThemeStyles();
  return (
    <div
      aria-hidden
      className={`animate-pulse rounded-xl ${className}`}
      style={{ background: styles.subtle, ...style }}
    />
  );
}

/** A stack of N skeleton rows — a list that is still fetching. */
export function SkeletonRows({
  rows = 4,
  rowClassName = "h-[30px] rounded-md",
  className = "",
  gap = 1.5,
}: {
  rows?: number;
  /** Per-row height/shape classes (the caller matches its real row shape). */
  rowClassName?: string;
  className?: string;
  gap?: number;
}) {
  return (
    <div className={`flex flex-col ${className}`} style={{ gap: `${gap * 4}px` }} aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <SkeletonBlock key={i} className={rowClassName} />
      ))}
    </div>
  );
}
