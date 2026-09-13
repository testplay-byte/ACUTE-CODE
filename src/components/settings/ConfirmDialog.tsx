import { useEffect, useRef } from "react";
import { AlertTriangle } from "lucide-react";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { withAlpha } from "../dashboard/helpers";

/* ── ROUND-95 (R95-A): the shared styled confirmation dialog ──────────────────
 * The owner's directive (the R95 walkthrough): destructive confirmations must
 * NEVER ride the browser's window.confirm — "it shows me the browser's delete
 * confirmation. What I was hoping to see was the properly formatted one…
 * showing a proper UI popup". This component is the ONE styled replacement
 * for every destructive ask in the settings surface (pool-key removal, model
 * deletion, provider deletion), built on the same visual language as the
 * tab's other dialogs (fixed inset-0 blurred backdrop, centered bordered
 * card, ESC + outside-click dismissal) with real focus management — the
 * cancel button takes focus on open so Enter never arms a destructive
 * default. `danger` paints the confirm button in the app's established
 * #ef4444 destructive color; `children` lets a caller append extra body
 * content (e.g. the "N agents use this provider" warning rides the provider
 * delete confirm). */

export function ConfirmDialog({
  title,
  message,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  danger = false,
  onConfirm,
  onClose,
  children,
}: {
  title: string;
  /** The main line the user is confirming — kept short by the callers. */
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive confirmations paint the confirm button red (#ef4444 — the
   * app's established danger exception, not a theme token). */
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  /** Optional extra body (warnings that ride the confirm, not the title). */
  children?: React.ReactNode;
}) {
  const styles = useThemeStyles();
  // Focus management: the CANCEL button takes focus on open — a stray Enter
  // never confirms a destructive action by accident.
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  // ESC closes (the same dismissal contract as the tab's other dialogs).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: "rgba(0,0,0,0.35)", backdropFilter: "blur(4px)" }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid="confirm-dialog-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        data-testid="confirm-dialog"
        className="w-full max-w-[420px] rounded-[16px] border-[1.5px] p-5 flex flex-col gap-3"
        style={{ background: styles.card, borderColor: styles.border, boxShadow: styles.bentoShadow }}
      >
        {/* Title row — the danger icon chip rides destructive confirms. */}
        <div className="flex items-center gap-3">
          {danger && (
            <span
              className="w-9 h-9 shrink-0 rounded-[10px] grid place-items-center"
              style={{ background: withAlpha("#ef4444", 0.1), color: "#ef4444" }}
              aria-hidden
            >
              <AlertTriangle size={15} />
            </span>
          )}
          <span className="text-[15px] font-black" style={{ color: styles.text }}>
            {title}
          </span>
        </div>
        {/* The message — the caller's exact confirm question. */}
        <p className="text-[12px] leading-relaxed" style={{ color: styles.textSecondary }}>
          {message}
        </p>
        {children}
        {/* Actions — Cancel (bordered, focused) · Confirm (danger red or the
            accent). The confirm closes after firing; error surfaces live in
            the caller's inline surface, never here. */}
        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            ref={cancelRef}
            type="button"
            onClick={onClose}
            data-testid="confirm-dialog-cancel"
            className="h-10 px-4 rounded-full border-[1.5px] text-[12px] font-bold transition-colors"
            style={{ borderColor: styles.border, color: styles.textSecondary }}
            onMouseEnter={(e) => (e.currentTarget.style.background = styles.subtleHover)}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={() => onConfirm()}
            data-testid="confirm-dialog-confirm"
            className="h-10 px-5 rounded-full text-[12px] font-bold transition-transform active:scale-[0.98]"
            style={
              danger
                ? { background: "#ef4444", color: "#fff" }
                : { background: styles.accent, color: styles.accentText }
            }
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
