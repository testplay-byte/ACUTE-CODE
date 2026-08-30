import { useState } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronRight, Settings } from "lucide-react";
import { fetchProviderModels, fetchProviders, type Agent } from "../../../lib/api";
import { filterModelsForPicker, useSettingsStore } from "../../../lib/settings-store";
import { useThemeStyles } from "../../../lib/use-theme-styles";
import { withAlpha } from "../../dashboard/helpers";
import { useDismiss, type ModelOverride } from "./composer-utils";

/** Width of the hover flyout (px) — used for the side measurement. */
const FLYOUT_WIDTH = 280;
/** Safety cap on the flyout's model rows (same spirit as the old picker's 60). */
const FLYOUT_MODEL_CAP = 200;

/**
 * ROUND-50 (R50-c2): the model selector (owner: "It would show me the model
 * provider name and the full model name… On clicking the Choose Model option
 * it will open up the providers page… When I hover on top of the provider…
 * I will be shown the actual models which I can select… at the very bottom it
 * will show me the Manage Models button").
 *
 * The BUTTON shows `ProviderLabel · full-model-id` (provider display name
 * from GET /providers, fallback providerId), truncated with the full text on
 * the title. The POPOVER (not a flat model list): one row per provider at
 * the top, each with a Configure gear → /settings?tab=api; HOVERING a row
 * opens that provider's model FLYOUT on the right or left (chosen by
 * available viewport space — measured; on narrow screens the flyout replaces
 * the list content); the current model carries a check; clicking selects it
 * as the per-send override (persisted per session by the panel). A full-width
 * "Manage Models" footer row navigates to the Models & Providers page.
 */
export function ModelSelector({
  agent,
  override,
  onModelChange,
  disabled,
}: {
  agent: Agent | null;
  override: ModelOverride | null;
  onModelChange: (v: ModelOverride | null) => void;
  disabled: boolean;
}) {
  const styles = useThemeStyles();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [hoveredProvider, setHoveredProvider] = useState<string | null>(null);
  const [flyoutSide, setFlyoutSide] = useState<"right" | "left" | "inline">("right");
  const close = (): void => {
    setOpen(false);
    setHoveredProvider(null);
  };
  const popoverRef = useDismiss(open, close);

  // Providers (added list) — fetched up-front so the BUTTON's label can show
  // the provider display name before the popover is ever opened.
  const providersQuery = useQuery({
    queryKey: ["composer-providers"],
    queryFn: () => fetchProviders(),
    enabled: !disabled,
    staleTime: 60_000,
  });
  const providers = providersQuery.data ?? [];

  // Shared, persisted Free-only/All preference (same store Settings uses).
  const modelsFreeOnly = useSettingsStore((s) => s.modelsFreeOnly);
  const setModelsFreeOnly = useSettingsStore((s) => s.setModelsFreeOnly);

  // The hovered provider's models (same query key the old picker used).
  const modelsQuery = useQuery({
    queryKey: ["provider-models", hoveredProvider],
    queryFn: () => fetchProviderModels(hoveredProvider as string),
    enabled: open && hoveredProvider !== null,
    staleTime: 5 * 60_000,
  });
  const allModels = (modelsQuery.data ?? []).slice(0, FLYOUT_MODEL_CAP);
  const models = filterModelsForPicker(
    allModels.map((m) => ({ modelId: m })),
    modelsFreeOnly,
  ).map((e) => e.modelId);
  const hiddenCount = allModels.length - models.length;

  // Effective model = override ?? agent.model (unchanged per-send semantics).
  const effective = override?.model ?? agent?.model ?? null;
  const effectiveProviderId = override?.providerId ?? agent?.providerId ?? null;
  const providerLabel =
    providers.find((p) => p.id === effectiveProviderId)?.name ?? effectiveProviderId ?? "";
  const buttonLabel =
    effective !== null ? `${providerLabel || "model"} · ${effective}` : "no model";

  /** Measure which side has room for the flyout; inline when neither does. */
  const openFlyout = (providerId: string, row: HTMLElement): void => {
    setHoveredProvider(providerId);
    const popover = row.closest("[data-model-popover]") as HTMLElement | null;
    if (popover === null) {
      setFlyoutSide("inline");
      return;
    }
    const rect = popover.getBoundingClientRect();
    const spaceRight = window.innerWidth - rect.right;
    if (spaceRight >= FLYOUT_WIDTH + 8) setFlyoutSide("right");
    else if (rect.left >= FLYOUT_WIDTH + 8) setFlyoutSide("left");
    else setFlyoutSide("inline");
  };

  const pickModel = (model: string, providerId: string): void => {
    // Clicking the agent's own model clears the override (old picker rule).
    onModelChange(model === agent?.model ? null : { model, providerId });
    close();
  };

  const goManageModels = (): void => {
    close();
    navigate("/settings?tab=api");
  };

  const flyout = hoveredProvider === null ? null : (
    <div
      role="listbox"
      aria-label={`Models of ${providers.find((p) => p.id === hoveredProvider)?.name ?? hoveredProvider}`}
      data-model-flyout
      className={
        flyoutSide === "inline"
          ? "flex flex-col min-w-0"
          : `absolute top-0 w-[280px] max-h-64 overflow-y-auto auto-scroll rounded-2xl border p-1.5 z-50 ${
              flyoutSide === "right" ? "left-full ml-1.5" : "right-full mr-1.5"
            }`
      }
      style={{ background: styles.card, borderColor: styles.border, boxShadow: styles.bentoShadow }}
    >
      {flyoutSide === "inline" ? (
        <div className="flex items-center justify-between gap-2 px-1 pb-1.5 mb-1 border-b" style={{ borderColor: styles.borderSubtle }}>
          <span className="text-[10px] font-bold uppercase tracking-wide truncate" style={{ color: styles.textTertiary }}>
            {providers.find((p) => p.id === hoveredProvider)?.name ?? hoveredProvider}
          </span>
          <button
            type="button"
            onClick={() => setHoveredProvider(null)}
            className="text-[10px] font-semibold shrink-0"
            style={{ color: styles.accent }}
          >
            Back
          </button>
        </div>
      ) : null}
      {models.length === 0 ? (
        <div className="text-[11px] px-2 py-1.5" style={{ color: styles.textTertiary }}>
          {modelsQuery.isLoading ? "loading models…" : "no models listed"}
        </div>
      ) : (
        models.map((m) => {
          const isSelected = m === effective;
          return (
            <button
              key={m}
              type="button"
              role="option"
              aria-selected={isSelected}
              onClick={() => pickModel(m, hoveredProvider)}
              title={m}
              className="w-full flex items-center gap-1.5 text-left px-2 py-1.5 rounded-lg font-mono text-[10.5px] truncate transition-colors"
              style={{
                color: styles.textSecondary,
                background: isSelected ? withAlpha(styles.accent, 0.09) : "transparent",
              }}
              onMouseEnter={(e) => {
                if (!isSelected) e.currentTarget.style.background = styles.subtleHover;
              }}
              onMouseLeave={(e) => {
                if (!isSelected) e.currentTarget.style.background = "transparent";
              }}
            >
              {isSelected ? (
                <Check size={11} className="shrink-0" style={{ color: styles.accent }} />
              ) : (
                <span className="w-[11px] shrink-0" />
              )}
              <span className="min-w-0 flex-1 truncate">{m}</span>
            </button>
          );
        })
      )}
      {hiddenCount > 0 && modelsFreeOnly ? (
        <button
          type="button"
          onClick={() => setModelsFreeOnly(false)}
          className="w-full text-left px-2 py-1.5 mt-1 rounded-lg text-[10.5px] font-semibold border-t"
          style={{ color: styles.accent, borderColor: styles.borderSubtle }}
        >
          {hiddenCount} paid model{hiddenCount === 1 ? "" : "s"} hidden — show all
        </button>
      ) : null}
    </div>
  );

  return (
    <div className="relative shrink-0" ref={popoverRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Choose model"
        title={buttonLabel}
        className="flex items-center gap-1 h-7 px-2 rounded-[10px] text-[11px] font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed max-w-[240px]"
        style={{ color: styles.textSecondary }}
        onMouseEnter={(e) => {
          if (!disabled) e.currentTarget.style.background = styles.subtleHover;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
        }}
      >
        <span className="truncate" data-model-label>
          {buttonLabel}
        </span>
        <ChevronDown size={10} className="shrink-0" />
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="Choose model"
          data-model-popover
          className="absolute bottom-9 right-0 w-64 rounded-2xl border p-1.5 z-50"
          style={{ background: styles.card, borderColor: styles.border, boxShadow: styles.bentoShadow }}
        >
          {/* Free only / All — the SHARED persisted preference (same store the
              Settings → Providers list uses), accessible right in the popover. */}
          <div
            role="group"
            aria-label="Model filter"
            className="flex items-center justify-between gap-2 px-1 pb-1.5 mb-1 border-b"
            style={{ borderColor: styles.borderSubtle }}
          >
            <span className="text-[10px] font-bold uppercase tracking-wide" style={{ color: styles.textTertiary }}>
              Providers
            </span>
            <div
              className="flex items-center rounded-[10px] border-[1.5px] overflow-hidden"
              style={{ borderColor: styles.border }}
            >
              {([
                { id: "free", label: "Free only", active: modelsFreeOnly, pick: () => setModelsFreeOnly(true) },
                { id: "all", label: "All", active: !modelsFreeOnly, pick: () => setModelsFreeOnly(false) },
              ] as const).map((seg) => (
                <button
                  key={seg.id}
                  type="button"
                  onClick={seg.pick}
                  aria-pressed={seg.active}
                  className="h-5 px-2 text-[9.5px] font-bold transition-colors"
                  style={{
                    background: seg.active ? withAlpha(styles.accent, 0.12) : "transparent",
                    color: seg.active ? styles.accent : styles.textTertiary,
                  }}
                >
                  {seg.label}
                </button>
              ))}
            </div>
          </div>
          {flyoutSide === "inline" && hoveredProvider !== null ? (
            flyout
          ) : (
            <>
              {providersQuery.isLoading ? (
                <div className="text-[11px] px-2 py-1.5" style={{ color: styles.textTertiary }}>
                  loading providers…
                </div>
              ) : providers.length === 0 ? (
                <div className="text-[11px] px-2 py-1.5" style={{ color: styles.textTertiary }}>
                  no providers configured
                </div>
              ) : (
                providers.map((p) => (
                  <div
                    key={p.id}
                    className="relative flex items-center rounded-lg transition-colors"
                    style={{
                      background: hoveredProvider === p.id ? withAlpha(styles.accent, 0.08) : "transparent",
                    }}
                    onMouseEnter={(e) => openFlyout(p.id, e.currentTarget)}
                    onMouseLeave={() => setHoveredProvider(null)}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      aria-label={`Models of ${p.name}`}
                      onClick={(e) => {
                        // Touch/click path: the flyout replaces the list.
                        setFlyoutSide("inline");
                        setHoveredProvider((cur) => (cur === p.id ? null : p.id));
                        e.currentTarget.blur();
                      }}
                      className="flex-1 min-w-0 flex items-center gap-1.5 text-left px-2 py-1.5 rounded-lg"
                      style={{ color: styles.textSecondary }}
                    >
                      <span className="text-[11.5px] font-semibold truncate">{p.name}</span>
                      {effectiveProviderId === p.id ? (
                        <span className="font-mono text-[9px] shrink-0" style={{ color: styles.accent }}>
                          current
                        </span>
                      ) : null}
                      <ChevronRight size={11} className="shrink-0 ml-auto" style={{ color: styles.textTertiary }} />
                    </button>
                    <button
                      type="button"
                      aria-label={`Configure ${p.name}`}
                      title={`Model settings for ${p.name}`}
                      onClick={goManageModels}
                      className="w-7 h-7 mr-0.5 grid place-items-center rounded-md shrink-0 transition-colors"
                      style={{ color: styles.textTertiary }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = styles.subtleHover;
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = "transparent";
                      }}
                    >
                      <Settings size={11} />
                    </button>
                    {/* Hover flyout — right or left of the list by space. */}
                    {hoveredProvider === p.id && flyoutSide !== "inline" ? flyout : null}
                  </div>
                ))
              )}
            </>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={goManageModels}
            className="w-full flex items-center justify-center gap-1.5 mt-1 pt-1.5 border-t text-[11px] font-bold transition-colors"
            style={{ borderColor: styles.borderSubtle, color: styles.accent }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = styles.subtleHover;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
            }}
          >
            <Settings size={11} />
            Manage Models
          </button>
        </div>
      ) : null}
    </div>
  );
}
