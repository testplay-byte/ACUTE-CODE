import { useThemeStyles } from "../../lib/use-theme-styles";
import { withAlpha } from "../dashboard/helpers";

/**
 * R93-A4 — the ONE shared toggle switch (the owner's theming verdict:
 * "When the toggles are enabled the UI looks bad. The toggle's highlighting
 * circle is apparently white while it should clearly be black so that it is
 * clearly visible.").
 *
 * Before R93 the knob was hardcoded `bg-white` in SEVEN copy-pasted
 * implementations — fine for dark accents, but the Mono Stone theme's dark
 * mode paints the checked track #E0E0E0 (near-white), and a white knob on a
 * near-white track vanishes. The knob is now CONTRAST-AWARE:
 *
 *  · CHECKED  → `styles.accentText` = getContrastText(accent) — black on
 *    light accents (Mono Stone dark's #E0E0E0 → #111111), white on dark ones.
 *  · UNCHECKED → `styles.toggleActive` (the pre-existing theme token:
 *    dark-mode white / light-mode black) against the neutral translucent
 *    track.
 *
 * The track, borders, sizes, and aria contract are byte-identical to the
 * copies it replaces (h-6 w-11, or h-7 w-[52px] with `big`; knob 18px, 21px
 * when big; `role="switch"` + `aria-checked` + `aria-label`).
 */
export function ToggleSwitch({
  checked,
  onToggle,
  label,
  title,
  disabled,
  big,
  testId,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
  title?: string;
  disabled?: boolean;
  /** The ComputerUseTab posture/enable rows use the larger pill. */
  big?: boolean;
  testId?: string;
}) {
  const styles = useThemeStyles();
  const knob = checked ? styles.accentText : styles.toggleActive;
  const knobSize = big ? 21 : 18;
  // Byte-identical geometry to the copies this replaces: the small pill's
  // checked knob sits 21px from the right (18 + 3px inset), the big pill's
  // 25px (21 + 4px) — the originals' own insets, preserved so no layout
  // shifts in the migration.
  const checkedLeft = `calc(100% - ${big ? 25 : 21}px)`;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      data-testid={testId}
      disabled={disabled}
      onClick={onToggle}
      className={`${
        big ? "h-7 w-[52px]" : "h-6 w-11"
      } relative shrink-0 cursor-pointer rounded-full transition-colors disabled:cursor-wait disabled:opacity-60`}
      style={{
        background: checked ? styles.accent : withAlpha(styles.text, 0.18),
        border: `1.5px solid ${checked ? styles.accent : styles.border}`,
      }}
    >
      <span
        className="absolute top-1/2 block rounded-full shadow transition-all"
        style={{
          left: checked ? checkedLeft : "3px",
          height: knobSize,
          width: knobSize,
          transform: "translateY(-50%)",
          background: knob,
        }}
      />
    </button>
  );
}
