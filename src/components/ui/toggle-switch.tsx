import { useThemeStyles } from "../../lib/use-theme-styles";

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
 *  · CHECKED  → `styles.accentText` — the explicit accent pair (white on
 *    the ember light, warm ink on the salmon dark) — R126 re-tiered from
 *    getContrastText(accent) onto the §1d pair.
 *  · UNCHECKED → `styles.toggleActive` (the pre-existing theme token:
 *    dark-mode white / light-mode black) against the neutral translucent
 *    track.
 *
 * ROUND-126 (R126-3f-1): the track re-tiered onto the clay ladder (TOKENS
 * §1d/§10) — the ON state is the quiet-solid pair (`styles.accentDeep`
 * fill + the accentText knob ink); the RESTING track is THE WELL
 * (`styles.surfaceWell` fill + the 1px `styles.clayRim` hairline) — the
 * recess the whole app sinks inactive controls into, replacing the old
 * withAlpha(text, 0.18) wash. The 1.5px border is retired with the bento
 * grammar (TOKENS §5).
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
        // R126: ON = the quiet-solid pair (accentDeep fill + accentText
        // knob); REST = the well (surfaceWell + the 1px clay rim).
        background: checked ? styles.accentDeep : styles.surfaceWell,
        border: `1px solid ${checked ? styles.accentDeep : styles.clayRim}`,
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
