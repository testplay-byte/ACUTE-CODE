import { useEffect, useRef } from "react";
import { AlertTriangle } from "lucide-react";
import { useThemeStyles } from "../../lib/use-theme-styles";

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
 * destructive color; `children` lets a caller append extra body
 * content (e.g. the "N agents use this provider" warning rides the provider
 * delete confirm).
 *
 * ROUND-126 (R126-3f-3): the card is the CLAY dialog (SCREENS §3 Overlay —
 * the AddProviderDialog/3f-2 spelling): rounded-xl, the 1px clay-rim
 * hairline, bg-card, .ac-clay — the 1.5px border + bentoShadow legs are
 * RETIRED (TOKENS §5: the clay rim supersedes the bento border; §9: the
 * card's depth IS the clay shadow). The §11 status grammar owns the danger
 * materials: the warning icon chip rides the badge-danger tone pair (never
 * a withAlpha hex wash), the destructive confirm keeps its §4 sanctioned
 * solid danger-deep + white (the ONE destructive-confirm fill), the neutral
 * confirm is the quiet-solid accent pair. Buttons: rounded-lg + CSS hover
 * classes (the JS onMouseEnter/onMouseLeave hover legs are gone — TOKENS §6:
 * hover is a class) + press 0.98. Type: the title rides the 13px/600
 * section tier (font-black retired with the weight law). ZERO logic
 * changes: ESC/outside-click dismissal, the cancel-takes-focus contract,
 * and every testid/aria are byte-identical. */

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
  /** Destructive confirmations paint the confirm button solid danger-deep
   * (COMPONENTS §4's one sanctioned destructive-confirm fill) instead of the
   * quiet-solid accent. */
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
        /* R126-3f-3: the clay dialog card — rounded-xl + the 1px clay-rim
         * hairline + .ac-clay (the 3f-2 dialog spelling; TOKENS §5/§9). */
        className="ac-clay w-full max-w-[420px] rounded-xl border border-clay-rim bg-card p-5 flex flex-col gap-3"
      >
        {/* Title row — the danger icon chip rides the §11 badge-danger tone. */}
        <div className="flex items-center gap-3">
          {danger && (
            <span
              /* R126-3f-3: the icon tile's radius snaps to the scale
               * (rounded-lg 8px — TOKENS §4; the pre-R126 rounded-[10px]
               * arbitrary spelling is retired). */
              className="w-9 h-9 shrink-0 rounded-lg grid place-items-center bg-badge-danger text-badge-danger-fg"
              aria-hidden
            >
              <AlertTriangle size={15} />
            </span>
          )}
          <span className="text-[13px] font-semibold text-ink">{title}</span>
        </div>
        {/* The message — the caller's exact confirm question. */}
        <p className="text-[12px] leading-relaxed" style={{ color: styles.textSecondary }}>
          {message}
        </p>
        {children}
        {/* Actions — Cancel (outlined secondary, focused) · Confirm (the
            quiet-solid accent, or the §4 solid danger-deep destructive fill).
            The confirm closes after firing; error surfaces live in the
            caller's inline surface, never here. R126: hover = CSS classes,
            press = 0.98, radius = rounded-lg. */}
        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            ref={cancelRef}
            type="button"
            onClick={onClose}
            data-testid="confirm-dialog-cancel"
            className="h-10 px-4 rounded-lg border border-line-strong text-[12px] font-semibold text-muted transition-colors duration-100 hover:bg-subtle hover:text-ink active:scale-[0.98]"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={() => onConfirm()}
            data-testid="confirm-dialog-confirm"
            /* R126-3f-3: danger = the §4 destructive-confirm solid
             * (dangerDeep fill + the mobile confirm-dialog's ink pair —
             * white on the ember-red light fill, the warm clay ink #211B16
             * on the salmon-red dark fill, the §11 pair values on the JS
             * leg); otherwise the quiet-solid accent (bg-accent-deep + the
             * accentText ink pair — TOKENS §1d; `text-accent-text` is a
             * phantom utility, so both inks ride the style leg). */
            className={`h-10 px-5 rounded-lg text-[12px] font-semibold transition-transform active:scale-[0.98] ${
              danger ? "bg-danger-deep" : "bg-accent-deep"
            }`}
            style={
              danger
                ? { color: styles.isDark ? "#211B16" : "#FFFFFF" }
                : { color: styles.accentText }
            }
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
