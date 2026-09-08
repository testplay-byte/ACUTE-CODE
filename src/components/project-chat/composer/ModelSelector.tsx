import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronRight, Cpu, Settings } from "lucide-react";
import {
  fetchProviderModelConfig,
  fetchProviders,
  type Agent,
} from "../../../lib/api";
import { filterModelsForPicker, useSettingsStore } from "../../../lib/settings-store";
import { useThemeStyles } from "../../../lib/use-theme-styles";
import { withAlpha } from "../../dashboard/helpers";
import {
  computeFlyoutGeometry,
  useDismiss,
  type FlyoutSide,
  type ModelOverride,
  type PlainRect,
} from "./composer-utils";

/** Width of the hover flyout (px) — used for the side measurement. */
const FLYOUT_WIDTH = 280;
/** Safety cap on the flyout's model rows (same spirit as the old picker's 60). */
const FLYOUT_MODEL_CAP = 200;

/**
 * ROUND-52 (R52-a): the flyout hover-bridge grace period — leaving the
 * provider row (or the flyout) starts this timer; entering the other side
 * cancels it. The fix for the owner's "When I tried to go to the models, it
 * closed the model menu very quickly": the flyout is position:fixed at
 * popoverRect.right + FLYOUT_MARGIN, so a dead zone (the popover's ~6px
 * padding + the margin) sits between the row's box and the flyout's box —
 * crossing it fired the row's mouseleave and snapped the flyout shut before
 * the pointer could ever arrive. Same bridge ContextDonut shipped (R51-c).
 */
const FLYOUT_CLOSE_DELAY_MS = 220;

/** Geometry used when the popover can't be measured / the touch path. */
const INLINE_GEO = { side: "inline" as FlyoutSide, left: null, top: 0, viewportTop: 0, maxHeight: 280 };

/** ROUND-58 (R58-d): one flyout row — a provider's models-config row
 * (display name, custom pricing). ROUND-64 (R64-d): the flyout is
 * CONFIG-ONLY (see the R64 note below) so every row IS a config row and the
 * old "configured" marker was retired — the list itself is the config. */
interface FlyoutModel {
  /** Model id sent to the API (the override value). */
  modelId: string;
  /** Config displayName when present — otherwise the raw id. */
  label: string;
  /** Config input price — null = unknown (the shared free filter falls back
   * to the `:free` id heuristic). */
  inputPricePerMtok: number | null;
}

/** DOMRect → the plain-number rect computeFlyoutGeometry takes. */
const plainRect = (el: HTMLElement): PlainRect => {
  const r = el.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
};

/**
 * ROUND-50 (R50-c2): the model selector (owner: "It would show me the model
 * provider name and the full model name… On clicking the Choose Model option
 * it will open up the providers page… When I hover on top of the provider…
 * I will be shown the actual models which I can select… at the very bottom it
 * will show me the Manage Models button").
 *
 * ROUND-51 (R51-c) polish, per the owner's fourth test round:
 *  - the BUTTON shows the MODEL ID ONLY (owner: "It should not show the name
 *    of the provider. It should only show the name of the model itself.");
 *    the full "Provider · model" stays on the title tooltip;
 *  - the hover FLYOUT is viewport-aware (computeFlyoutGeometry): side by
 *    measured space, vertically clamped with 12px margins, capped height —
 *    never cut off at the bottom or the right again. It is position:fixed
 *    (viewport coordinates) so the popover's own max-height scroll can never
 *    clip it, but it stays a DOM CHILD of the provider row — moving the
 *    pointer from the row into the flyout keeps it open (mouseleave
 *    containment works off the DOM tree, not the visual box) — R52-a
 *    CORRECTION: that only holds when the boxes are CONTIGUOUS; the fixed
 *    flyout sits one dead zone away (see ROUND-52 below) and crossing it
 *    fired the row's mouseleave — hence the hover bridge;
 *  - the popover itself scrolls internally (max-h + overflow-y-auto) so N
 *    providers never overflow the viewport, and scrolling it closes the
 *    flyout (a fixed flyout wouldn't track its row scrolling under it);
 *  - flyout polish: provider-name header chip, consistent rounded rows with
 *    hover states, check on the selected model, and the hidden-paid-models
 *    hint styled as a proper footer row.
 *
 * ROUND-52 (R52-a): the hover-bridge grace period — the provider row's
 * mouseleave no longer closes the flyout INSTANTLY. Leaving the row (or the
 * flyout) schedules the close after FLYOUT_CLOSE_DELAY_MS (220ms); entering
 * either side cancels it, so the pointer can cross the popover-padding +
 * FLYOUT_MARGIN dead zone into the flyout (and back). All other dismissal
 * paths (popover scroll, outside click, Escape, popover close) still close
 * immediately and cancel any pending timer.
 *
 * ROUND-62 (R62-2b, owner: "the changes applied [in Models & Providers]
 * don't reflect properly on the agent session page"): the popover's list
 * filters DISABLED providers (a provider turned off in Settings is no
 * longer selectable here). The same round teaches ModelsProvidersTab to
 * invalidate this component's query-key families (["composer-providers"],
 * ["provider-models", id], ["provider-models-config", id]) so edits stop
 * being held back by the 5-minute staleTimes.
 *
 * ROUND-64 (R64-d, owner: "When I hovered on the provider, it showed me the
 * list of models there but those models were not the ones which I added,
 * only the models which I had added in the models and providers Page
 * should be shown"): the flyout is now CONFIG-ONLY — exactly the provider's
 * rows from the Models & Providers page (fetchProviderModelConfig),
 * hidden rows excluded, display names applied. The LIVE-CATALOG query
 * (fetchProviderModels) was REMOVED from this component entirely: it fed
 * the flyout ids the owner never curated and is no longer consulted
 * here. The ["provider-models-config", id] query key stays THE freshness
 * source — ModelsProvidersTab's invalidateModelConfigEverywhere still
 * invalidates it, so add/rename/hide in Settings reflects on the next
 * popover open. Empty/error configs render an honest pointer row to
 * Settings instead of falling back to the catalog. The BUTTON's label is
 * untouched: it shows the effective model's raw id (config-known or not)
 * and the unfiltered providers list still resolves the provider display
 * name.
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
  // ROUND-51 (R51-c): measured flyout geometry (side + clamped viewport
  // position) — replaces the old side-only state that never clamped
  // vertically (the bottom-cutoff bug).
  const [flyoutGeo, setFlyoutGeo] = useState<{
    side: FlyoutSide;
    left: number | null;
    top: number;
    viewportTop: number;
    maxHeight: number;
  }>({ side: "right", left: null, top: 0, viewportTop: 0, maxHeight: 280 });
  // ROUND-52 (R52-a): the hover-bridge pending-close timer (see
  // FLYOUT_CLOSE_DELAY_MS above) — leaving the provider row or the flyout
  // schedules the close; entering either side cancels it. Mirrors the
  // ContextDonut (R51-c) closeTimerRef pattern.
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearCloseTimer = (): void => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };
  const scheduleClose = (): void => {
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      setHoveredProvider(null);
    }, FLYOUT_CLOSE_DELAY_MS);
  };
  // Never leak a pending close across an unmount.
  useEffect(() => clearCloseTimer, []);
  const close = (): void => {
    clearCloseTimer(); // ROUND-52 (R52-a): no pending close outlives the popover
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

  // ROUND-62 (R62-2b): disabled providers leave the popover — the Settings
  // enable/disable toggle finally reflects here. The R59-C tooltip already
  // promised "a disabled provider's models simply disappear from the
  // pickers", but this list never filtered on `enabled`, so a provider
  // turned off in Settings stayed fully selectable on the session page.
  // The BUTTON's label lookup keeps the unfiltered list (the agent's own
  // provider may be disabled and must still resolve its display name).
  const enabledProviders = useMemo(
    () => providers.filter((p) => p.enabled),
    [providers],
  );

  // ROUND-58 (R58-d): the provider's models-CONFIG (the Settings models
  // table). ROUND-64 (R64-d): this is now the flyout's ONLY source — the
  // owner curates the list on the Models & Providers page and the hover
  // flyout shows EXACTLY those rows (hidden excluded, display names
  // applied, config pricing feeding the shared free filter). The
  // live-catalog query that used to run beside it is gone (its ids were
  // the "not the ones which I added" noise). Loading and error are
  // distinguishable states with honest rows in the flyout body.
  const modelsConfigQuery = useQuery({
    queryKey: ["provider-models-config", hoveredProvider],
    queryFn: () => fetchProviderModelConfig(hoveredProvider as string),
    enabled: open && hoveredProvider !== null,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const configRows = modelsConfigQuery.data ?? [];

  // ROUND-64 (R64-d): CONFIG-ONLY list — the provider's rows from the
  // Models & Providers page: hidden rows excluded, display names applied,
  // and the shared free-only filter seeing the CONFIG's input price
  // (falling back to the id heuristic when unknown). R58-d's live+config
  // merge and R62-2b's union are both retired: the owner's directive is
  // "only the models which I had added in the models and providers Page
  // should be shown".
  const allModels: FlyoutModel[] = configRows
    .filter((row) => row.hidden !== true)
    .slice(0, FLYOUT_MODEL_CAP)
    .map((row) => ({
      modelId: row.modelId,
      label: row.displayName.trim() !== "" ? row.displayName : row.modelId,
      inputPricePerMtok: row.inputPricePerMtok,
    }));
  const models = filterModelsForPicker(allModels, modelsFreeOnly);
  const hiddenCount = allModels.length - models.length;
  // Config-hidden models are NOT reachable via "show all" — surfaced as
  // their own subtle footer note instead (they're turned off in Settings).
  const configHiddenCount = configRows.filter((row) => row.hidden === true).length;

  // Effective model = override ?? agent.model (unchanged per-send semantics).
  const effective = override?.model ?? agent?.model ?? null;
  const effectiveProviderId = override?.providerId ?? agent?.providerId ?? null;
  const providerLabel =
    providers.find((p) => p.id === effectiveProviderId)?.name ?? effectiveProviderId ?? "";
  // ROUND-51 (R51-c): the button shows the MODEL ID ONLY; "Provider · model"
  // stays on the title tooltip.
  const buttonLabel = effective !== null ? effective : "no model";
  const buttonTitle = effective !== null ? `${providerLabel || "model"} · ${effective}` : "no model";

  /** Measure row + popover + viewport and compute the flyout geometry
   * (side by space, vertical clamp, capped height — pure helper). */
  const openFlyout = (providerId: string, row: HTMLElement): void => {
    clearCloseTimer(); // ROUND-52 (R52-a): hovering cancels any pending close
    setHoveredProvider(providerId);
    const popover = row.closest("[data-model-popover]") as HTMLElement | null;
    if (popover === null) {
      setFlyoutGeo(INLINE_GEO);
      return;
    }
    setFlyoutGeo(
      computeFlyoutGeometry(
        plainRect(row),
        plainRect(popover),
        { width: window.innerWidth, height: window.innerHeight },
        FLYOUT_WIDTH,
      ),
    );
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

  // ROUND-51 (R51-c): the flyout's geometry-driven placement. Side mode is
  // position:FIXED (viewport coordinates — immune to the popover's scroll
  // clipping) while remaining a DOM child of the hovered provider row (hover
  // containment). Inline mode still REPLACES the list (narrow/touch path).
  const flyoutSide = flyoutGeo.side;
  const hoveredName =
    providers.find((p) => p.id === hoveredProvider)?.name ?? hoveredProvider ?? "";

  const flyout = hoveredProvider === null ? null : (
    <div
      role="listbox"
      aria-label={`Models of ${hoveredName}`}
      data-model-flyout
      data-flyout-side={flyoutSide}
      // ROUND-52 (R52-a): the flyout's side of the hover bridge — entering it
      // cancels the close the row's mouseleave scheduled; leaving it schedules
      // the close again. Handlers live here on the SHARED root (both render
      // sites get them); inline mode doesn't need the bridge, but a 220ms
      // leave delay there is harmless (Back + click paths are unaffected).
      onMouseEnter={clearCloseTimer}
      onMouseLeave={scheduleClose}
      className={
        flyoutSide === "inline"
          ? "flex flex-col min-w-0"
          : "fixed w-[280px] rounded-2xl border p-1.5 z-50 auto-scroll"
      }
      style={{
        ...(flyoutSide === "inline"
          ? {}
          : {
              left: `${flyoutGeo.left ?? 0}px`,
              top: `${flyoutGeo.viewportTop}px`,
              maxHeight: `${flyoutGeo.maxHeight}px`,
              overflowY: "auto",
            }),
        background: styles.card,
        borderColor: styles.border,
        boxShadow: styles.bentoShadow,
      }}
    >
      {/* Header chip — whose models you're scanning (Back only in inline
          mode, where there's no provider list visible behind it). */}
      <div
        className="flex items-center gap-2 px-1 pb-1.5 mb-1 border-b"
        style={{ borderColor: styles.borderSubtle }}
      >
        <span
          className="text-[10px] font-bold uppercase tracking-wide truncate"
          style={{ color: styles.textTertiary }}
        >
          {hoveredName}
        </span>
        {!modelsConfigQuery.isLoading && models.length > 0 ? (
          <span className="ml-auto font-mono text-[9px] shrink-0" style={{ color: styles.textTertiary }}>
            {models.length} model{models.length === 1 ? "" : "s"}
          </span>
        ) : null}
        {flyoutSide === "inline" ? (
          <button
            type="button"
            onClick={() => setHoveredProvider(null)}
            className="text-[10px] font-semibold shrink-0"
            style={{ color: styles.accent }}
          >
            Back
          </button>
        ) : null}
      </div>
      {modelsConfigQuery.isLoading ? (
        // ROUND-64 (R64-d): the config fetch is the flyout's only source —
        // loading has its own honest row (kept distinct from empty).
        <div className="text-[11px] px-2 py-1.5" style={{ color: styles.textTertiary }}>
          loading models…
        </div>
      ) : modelsConfigQuery.isError ? (
        <div className="text-[11px] px-2 py-1.5" style={{ color: styles.textTertiary }}>
          couldn't load this provider's models — check the connection and retry
        </div>
      ) : allModels.length === 0 ? (
        // ROUND-64 (R64-d): honest empty state — the config (not the catalog)
        // is the list, so nothing configured means nothing to pick; point the
        // owner at where the list is curated.
        <div className="text-[11px] px-2 py-1.5" style={{ color: styles.textTertiary }}>
          No models configured — add them in Settings → Models &amp; Providers
        </div>
      ) : models.length === 0 ? (
        // Rows exist but the free-only filter hid them all — the footer's
        // "show all" button is the way back.
        <div className="text-[11px] px-2 py-1.5" style={{ color: styles.textTertiary }}>
          no models listed
        </div>
      ) : (
        models.map((m) => {
          const isSelected = m.modelId === effective;
          return (
            <button
              key={m.modelId}
              type="button"
              role="option"
              aria-selected={isSelected}
              onClick={() => pickModel(m.modelId, hoveredProvider)}
              title={m.modelId}
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
              <span className="min-w-0 flex-1 truncate">{m.label}</span>
              {/* ROUND-58's "configured" dot was retired in ROUND-64 (R64-d):
                  the flyout is config-only now, so EVERY row is a configured
                  row and the marker carried no information. */}
            </button>
          );
        })
      )}
      {/* Footer — the hidden-paid-models hint as a proper footer row. */}
      {hiddenCount > 0 && modelsFreeOnly ? (
        <button
          type="button"
          onClick={() => setModelsFreeOnly(false)}
          className="w-full text-left px-2 pt-1.5 pb-1 mt-1 border-t rounded-none text-[10px] font-semibold transition-colors"
          style={{ color: styles.textTertiary, borderColor: styles.borderSubtle }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = styles.subtleHover;
            e.currentTarget.style.color = styles.textSecondary;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = styles.textTertiary;
          }}
        >
          {hiddenCount} paid model{hiddenCount === 1 ? "" : "s"} hidden — show all
        </button>
      ) : null}
      {/* ROUND-58 (R58-d): models hidden via Settings config — NOT reachable
          through "show all"; their own honest footer note. */}
      {configHiddenCount > 0 ? (
        <div
          className="px-2 pt-1 pb-1.5 text-[10px]"
          style={{ color: styles.textTertiary }}
          title="Hidden per model in Settings → Models & Providers"
        >
          {configHiddenCount} model{configHiddenCount === 1 ? "" : "s"} hidden in Settings
        </div>
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
        title={buttonTitle}
        className="flex items-center gap-1 h-7 px-2 rounded-[10px] text-[11px] font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed max-w-[240px]"
        style={{ color: styles.textSecondary }}
        onMouseEnter={(e) => {
          if (!disabled) e.currentTarget.style.background = styles.subtleHover;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
        }}
      >
        {/* R77 (owner: "For the model selection, there was no proper icon,
            so you might need to add a proper icon"): the Cpu badge — every
            other toolbar pill leads with an icon (Paperclip / Shield / Compass
            / Brain); the model pill was the lone icon-less text button. The
            icon STAYS visible below the 560px @container floor (only the text
            label hides), so the pill stays identifiable when icon-only. */}
        <Cpu
          size={12}
          className="shrink-0"
          style={{ color: styles.accent }}
          aria-hidden
          data-model-icon
        />
        <span className="truncate @max-[560px]:hidden" data-model-label>
          {buttonLabel}
        </span>
        <ChevronDown size={10} className="shrink-0" />
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="Choose model"
          data-model-popover
          // ROUND-51 (R51-c): the popover scrolls INTERNALLY (max-h +
          // overflow-y-auto) so N providers never overflow the viewport.
          // Scrolling it closes the side flyout — the flyout is position:fixed
          // (never clipped by this scroller) and so would not follow its row
          // scrolling underneath the pointer. (e.target check: React's
          // synthetic onScroll bubbles — the FLYOUT's own scrolling must not
          // close it.)
          onScroll={(e) => {
            // ROUND-52 (R52-a): a scroll-close also cancels any pending
            // hover-bridge close (the flyout is already going away).
            if (e.target === e.currentTarget) {
              clearCloseTimer();
              setHoveredProvider(null);
            }
          }}
          className="absolute bottom-9 right-0 w-64 max-h-[min(24rem,calc(100vh-2rem))] overflow-y-auto auto-scroll rounded-2xl border p-1.5 z-50"
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
              ) : enabledProviders.length === 0 ? (
                <div className="text-[11px] px-2 py-1.5" style={{ color: styles.textTertiary }}>
                  no providers configured
                </div>
              ) : (
                enabledProviders.map((p) => (
                  <div
                    key={p.id}
                    data-provider-row={p.id}
                    className="relative flex items-center rounded-lg transition-colors"
                    style={{
                      background: hoveredProvider === p.id ? withAlpha(styles.accent, 0.08) : "transparent",
                    }}
                    onMouseEnter={(e) => openFlyout(p.id, e.currentTarget)}
                    // ROUND-52 (R52-a): don't close instantly — start the grace
                    // timer so the pointer can cross the popover padding +
                    // FLYOUT_MARGIN gap into the flyout (entering the flyout,
                    // or this row again, cancels it).
                    onMouseLeave={scheduleClose}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      aria-label={`Models of ${p.name}`}
                      onClick={(e) => {
                        // Touch/click path: the flyout replaces the list.
                        setFlyoutGeo(INLINE_GEO);
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
