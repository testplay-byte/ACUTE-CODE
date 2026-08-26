import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useThemeStyles } from "../../lib/use-theme-styles";

/**
 * ROUND-42: text clamped to N lines with a manual expand toggle.
 *
 * Owner directive (round-42): "There is a long prompt which was given to the
 * sub-agent or even my normal agent, which is the main one. It should not be
 * showing the whole prompt which was given to it. It should be minimized to
 * about 10 lines or so. If it is more than those then it will be minimized
 * automatically and the user has to manually click the expand button to see
 * the full one."
 *
 * ROUND-43 (owner): the minimized height is now 6 lines, not 10 — "Currently
 * it shows ten lines but what I think is that six lines would be a better
 * option to keep it in minimized mode." The default covers every call site
 * that doesn't pass an explicit clamp (the main-chat user prompt should rely
 * on this default — call sites must NOT hard-code 10 anymore).
 *
 * Used by the chat user bubbles (AgentChatPanel), the sub-agent panel's task
 * + final report cards (SubAgentPanel). The toggle only renders when the
 * content actually overflows (measured post-mount) — short messages render
 * exactly as before.
 */
export function ClampedText({
  text,
  lines = 6,
  expandLabel = "Show more",
  collapseLabel = "Show less",
  style,
  className,
}: {
  text: string;
  /** The clamp (lines) before the expand toggle appears. */
  lines?: number;
  expandLabel?: string;
  collapseLabel?: string;
  /** Applied to the text element itself. */
  style?: React.CSSProperties;
  className?: string;
}) {
  const styles = useThemeStyles();
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    setOverflows(el.scrollHeight > el.clientHeight + 2);
  }, [text, lines]);

  return (
    <>
      <div
        ref={ref}
        className={className}
        style={{
          ...style,
          display: "-webkit-box",
          WebkitLineClamp: expanded ? undefined : lines,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}
      >
        {text}
      </div>
      {overflows ? (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          className="mt-1.5 inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider transition-colors"
          style={{ color: styles.accent }}
        >
          <ChevronDown
            size={11}
            style={{
              transform: expanded ? "rotate(180deg)" : "none",
              transition: "transform 0.15s",
            }}
          />
          {expanded ? collapseLabel : expandLabel}
        </button>
      ) : null}
    </>
  );
}
