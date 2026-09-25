import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronRight, Cpu, Settings } from "lucide-react";
import {
  fetchProviderModelConfig,
  fetchProviders,
  type Agent,
} from "../../../lib/api";
import { filterConfiguredProviders, filterModelsForPicker, useSettingsStore } from "../../../lib/settings-store";
import { useThemeStyles } from "../../../lib/use-theme-styles";
import {
  computeFlyoutGeometry,
  flyoutRetargetIntent,
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

/** R87-A1: how long the pointer must REST on a provider row whose hover was
 * held back by the trajectory gate (a vertical scan of the list) before the
 * flyout promotes it — the “stationary-ish” dwell. Same 220ms beat as the
 * close grace period, so the two feel like one clock. */
const RETARGET_DWELL_MS = 220;

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
  // R87-A1: the held-back hover's dwell timer (see flyoutRetargetIntent) —
  // fires only while the pointer stays on the entered row.
  const retargetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelRetarget = (): void => {
    if (retargetTimerRef.current !== null) {
      clearTimeout(retargetTimerRef.current);
      retargetTimerRef.current = null;
    }
  };
  // Never leak a pending close (or dwell) across an unmount.
  useEffect(
    () => () => {
      clearCloseTimer();
      cancelRetarget();
    },
    [],
  );
  const close = (): void => {
    clearCloseTimer(); // ROUND-52 (R52-a): no pending close outlives the popover
    cancelRetarget(); // R87-A1: …and no pending dwell either
    setOpen(false);
    setHoveredProvider(null);
  };
  const popoverRef = useDismiss(open, close);

  // ── R93-A1: the popover's viewport-clamped geometry ─────────────────────
  // The owner (fifth walkthrough): "the model selection window opened… the
  // providers were cut off… showing outside the available space… on the left
  // side, outside of the window area." The old anchor (absolute, right-0,
  // w-64) extends 256px LEFT of the trigger's right edge — at the 240px chat
  // floor that lands past the window's left edge. The popover now measures
  // the trigger and places itself in VIEWPORT coordinates: right-aligned to
  // the trigger by default, then clamped to [8px, innerWidth - 264px] so it
  // can never leave the window. Recomputed on window resize while open.
  const [popGeo, setPopGeo] = useState<{ left: number; bottom: number } | null>(null);
  useEffect(() => {
    if (!open) {
      setPopGeo(null);
      return;
    }
    const measure = (): void => {
      const el = popoverRef.current;
      if (el === null) {
        setPopGeo(null);
        return;
      }
      const r = el.getBoundingClientRect();
      const POPOVER_W = 256; // w-64
      const MARGIN = 8;
      let left = r.right - POPOVER_W;
      if (left < MARGIN) left = MARGIN;
      const maxLeft = window.innerWidth - POPOVER_W - MARGIN;
      if (left > maxLeft) left = Math.max(MARGIN, maxLeft);
      // bottom-9 semantics preserved: the popover's BOTTOM sits 36px above
      // the trigger's TOP edge (the composer sits at the screen bottom, the
      // list grows upward). Clamped so a trigger at the very top still fits.
      const bottom = Math.max(window.innerHeight - r.top + 36, 36);
      setPopGeo({ left, bottom });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("resize", measure);
    };
    // popoverRef is a stable ref from useDismiss; reading it inside measure
    // always sees the current node.
  }, [open, popoverRef]);

  // ── R87-A1: trajectory-intent state ─────────────────────────────────────
  // The open flyout's viewport rect (captured by the flyout's ref callback)
  // feeds the corridor check; the double-buffered pointer trail yields the
  // movement VECTOR of the crossing (a single buffer would only ever see
  // the sample that ALSO triggered the row's mouseenter — a zero delta).
  const flyoutRectRef = useRef<PlainRect | null>(null);
  const pointerPrevRef = useRef<{ x: number; y: number } | null>(null);
  const pointerCurRef = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!open) return;
    const onMove = (e: PointerEvent): void => {
      pointerPrevRef.current = pointerCurRef.current;
      pointerCurRef.current = { x: e.clientX, y: e.clientY };
    };
    // capture: pointermove must land BEFORE the row's mouseenter of the
    // same physical movement, so the delta reflects the crossing itself.
    document.addEventListener("pointermove", onMove, { capture: true, passive: true });
    return () => {
      document.removeEventListener("pointermove", onMove);
      pointerPrevRef.current = null;
      pointerCurRef.current = null;
    };
  }, [open]);

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
  //
  // ROUND-89 (R89-B3, the owner's verdict): keyless providers leave the
  // popover too — the seeded built-ins (Anthropic/OpenAI/Google/NVIDIA…)
  // render "no models configured" dead rows when the owner never added
  // them. `hasKey` is the configured signal (same filter the Settings
  // provider list uses); the BUTTON's label lookup stays unfiltered so an
  // agent wired to a since-de-keyed provider still resolves its name.
  //
  // R114-e (the ModelSelector audit): the rule moved into settings-store's
  // filterConfiguredProviders (stated + tested once); this is now a pure
  // call — behavior byte-identical.
  const enabledProviders = useMemo(
    () => filterConfiguredProviders(providers),
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
   * (side by space, vertical clamp, capped height — pure helper). R87-A1:
   * extracted from openFlyout so the trajectory gate can call it on a
   * dwell without re-measuring anything else. */
  const applyFlyout = (providerId: string, row: HTMLElement): void => {
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

  /**
   * R87-A1: the trajectory-gated hover entry (the owner's mid-transit
   * re-target bug — see flyoutRetargetIntent for the full rules). Same-row
   * re-enters and un-gated intents behave exactly like the old instant
   * open; a corridor crossing holds the CURRENT provider (no dwell — the
   * pointer is heading INTO the flyout, whose enter cancels everything); a
   * vertical scan holds it for RETARGET_DWELL_MS and then promotes the
   * rested-on row. In every held case the pending close stays cancelled
   * (the pointer is still inside the provider list — menu semantics), and
   * the row's mouseleave / the flyout's enter cancel the dwell again. */
  const openFlyout = (providerId: string, row: HTMLElement, ev: ReactMouseEvent<HTMLElement>): void => {
    clearCloseTimer(); // ROUND-52 (R52-a): hovering cancels any pending close
    if (providerId === hoveredProvider) {
      cancelRetarget();
      applyFlyout(providerId, row);
      return;
    }
    const prev = pointerPrevRef.current;
    const cur = pointerCurRef.current;
    const delta =
      prev !== null && cur !== null ? { dx: cur.x - prev.x, dy: cur.y - prev.y } : null;
    const intent = flyoutRetargetIntent(delta, ev.clientX, flyoutRectRef.current);
    if (intent === "retarget") {
      cancelRetarget();
      applyFlyout(providerId, row);
      return;
    }
    cancelRetarget();
    if (intent === "scan") {
      retargetTimerRef.current = setTimeout(() => {
        retargetTimerRef.current = null;
        if (row.isConnected) applyFlyout(providerId, row);
      }, RETARGET_DWELL_MS);
    }
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
      ref={(el) => {
        // R87-A1: remember the open flyout's viewport rect for the
        // trajectory gate (cleared when it unmounts). Inline mode never
        // positions itself beside the rows — no rect, no gating.
        flyoutRectRef.current =
          el !== null && flyoutSide !== "inline" ? plainRect(el) : null;
      }}
      // ROUND-52 (R52-a): the flyout's side of the hover bridge — entering it
      // cancels the close the row's mouseleave scheduled (and, R87-A1, any
      // pending dwell promotion — the pointer arrived where it was headed);
      // leaving it schedules the close again. Handlers live here on the
      // SHARED root (both render sites get them); inline mode doesn't need
      // the bridge, but a 220ms leave delay there is harmless (Back + click
      // paths are unaffected).
      onMouseEnter={() => {
        clearCloseTimer();
        cancelRetarget();
      }}
      onMouseLeave={scheduleClose}
      className={
        flyoutSide === "inline"
          ? "flex flex-col min-w-0"
          : "fixed w-[280px] rounded-2xl border border-clay-rim bg-card p-1.5 z-50 auto-scroll ac-clay-sm"
      }
      style={
        flyoutSide === "inline"
          ? {}
          : {
              left: `${flyoutGeo.left ?? 0}px`,
              top: `${flyoutGeo.viewportTop}px`,
              maxHeight: `${flyoutGeo.maxHeight}px`,
              overflowY: "auto",
            }
      }
    >
      {/* Header chip — whose models you're scanning (Back only in inline
          mode, where there's no provider list visible behind it). */}
      <div
        className="flex items-center gap-2 px-1 pb-1.5 mb-1 border-b"
        style={{ borderColor: styles.borderSubtle }}
      >
        <span
          className="text-[10px] font-medium uppercase tracking-[0.08em] truncate"
          style={{ color: styles.textTertiary }}
        >
          {hoveredName}
        </span>
        {!modelsConfigQuery.isLoading && models.length > 0 ? (
          <span className="ml-auto font-mono text-[10px] tabular-nums shrink-0" style={{ color: styles.textTertiary }}>
            {models.length} model{models.length === 1 ? "" : "s"}
          </span>
        ) : null}
        {flyoutSide === "inline" ? (
          <button
            type="button"
            onClick={() => setHoveredProvider(null)}
            // R126-3d-4: accent-as-TEXT rides the DEEP tier (TOKENS §1d).
            className="text-[10px] font-medium shrink-0 text-accent-deep"
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
              className={`w-full flex items-center gap-1.5 text-left px-2 py-1.5 rounded-lg font-mono text-[10px] truncate transition-colors ${
                // R126-3d-4: the selected row = accentTint + accentDeep ink.
                isSelected ? "bg-accent-tint text-accent-deep" : "hover:bg-hover text-muted"
              }`}
            >
              {isSelected ? (
                <Check size={11} className="shrink-0 text-accent-deep" />
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
          // R100-D: the hover (bg + color) is now the CSS wash (hover:bg-hover
          // + hover:text-muted — the CSS-var leg; no JS painting).
          className="w-full text-left px-2 pt-1.5 pb-1 mt-1 border-t rounded-none text-[10px] font-medium transition-colors hover:bg-hover hover:text-muted"
          style={{ color: styles.textTertiary, borderColor: styles.borderSubtle }}
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
      {/* R87-A1 (owner: "When the option is opened up, the background will be
          slightly darkened and a slight frosted glass effect will be applied
          to it"): a fixed scrim BEHIND the popover (z-40 vs the popover's
          z-50), fading in over 150ms via the shared overlay-in keyframes.
          Clicking it dismisses (the useDismiss mousedown path fires too —
          both land on the same close).
          R92-A (owner: opening the model menu "cleared out" the embedded
          browser): data-webview-backdrop marks this as a PURE DIM LAYER —
          it renders BELOW the OS-level browser webview, so the overlay
          guard no longer records its full-viewport rect as covering the
          browser (which blanked the page for a dim the webview never
          showed). The popover CONTENT below is untouched — it still hides
          the webview whenever it geometrically covers it.
          R93-A2 (owner: "it should become slightly blurred only. This blur
          effect should apply to the browser window itself too"): the blur
          drops to a SLIGHT 1.5px (was 3px — the stronger frost read as a
          heavy dim), the tint lightens with it, and the marker now carries
          the radius — data-webview-backdrop="1.5" — which the webview
          guard mirrors INTO the browser page itself (BrowserPanel's
          nativeTabEval filter), so the browser window frosts together
          with the rest of the app instead of staying oddly crisp. */}
      {open ? (
        <div
          aria-hidden
          data-model-backdrop
          data-webview-backdrop="1.5"
          className="fixed inset-0 z-40"
          style={{
            background: "rgba(0,0,0,0.16)",
            backdropFilter: "blur(1.5px)",
            WebkitBackdropFilter: "blur(1.5px)",
            animation: "overlay-in 0.15s ease",
          }}
          onClick={close}
        />
      ) : null}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Choose model"
        title={buttonTitle}
        className="flex items-center gap-1 h-7 px-2 rounded-lg bg-badge-neutral text-badge-neutral-fg text-[12px] font-semibold transition-colors duration-100 hover:bg-accent-tint disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-badge-neutral max-w-[240px]"
      >
        {/* R77 (owner: "For the model selection, there was no proper icon,
            so you might need to add a proper icon"): the Cpu badge — every
            other toolbar pill leads with an icon (Paperclip / Shield / Compass
            / Brain); the model pill was the lone icon-less text button.
            R87-A1 (owner: "The first thing which should be shrunk in its
            width (meaning the name of the model, the model sector)"): the
            label NEVER hides — it SHRINKS FIRST, in graduated @container
            tiers (240 → 170px below 520 → 90px below 420), animated via
            max-width so the model name stays identifiable (truncated) while
            the mode/thinking pills still show their full labels. The icon
            stays visible at every width.
            R89-D2 (owner: "the full model name was not showing, the half
            model name was showing instead of being shrunk down to the only
            logo"): below 350px the label collapses to NOTHING — the pill
            becomes LOGO-ONLY (icon + chevron), never a half-cut name; the
            title tooltip still carries the full label. */}
        <Cpu
          size={12}
          className="shrink-0 text-accent"
          aria-hidden
          data-model-icon
        />
        <span
          className="max-w-[240px] @max-[520px]:max-w-[170px] @max-[420px]:max-w-[90px] @max-[350px]:max-w-0 @max-[350px]:opacity-0 @max-[350px]:-ml-1 truncate transition-all duration-200"
          data-model-label
        >
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
          // R93-A1: VIEWPORT-CLAMPED placement (see the popGeo effect above)
          // — position:fixed with a measured left/bottom replaces the old
          // absolute/right-0 anchor whose 256px box could leave the window's
          // left edge at the 240px chat floor (the owner's "providers were
          // cut off… outside of the window area"). Unmeasured fallback (the
          // first paint frame, or a test DOM without layout): the old
          // right-aligned absolute anchor, so behavior degrades to exactly
          // the pre-R93 placement instead of vanishing.
          className={
            popGeo === null
              ? "absolute bottom-9 right-0 w-64 max-h-[min(24rem,calc(100vh-2rem))] overflow-y-auto auto-scroll rounded-2xl border border-clay-rim bg-card p-1.5 z-50 ac-clay-sm"
              : "fixed w-64 max-h-[min(24rem,calc(100vh-2rem))] overflow-y-auto auto-scroll rounded-2xl border border-clay-rim bg-card p-1.5 z-50 ac-clay-sm"
          }
          style={
            popGeo === null ? {} : { left: `${popGeo.left}px`, bottom: `${popGeo.bottom}px` }
          }
        >
          {/* Free only / All — the SHARED persisted preference (same store the
              Settings → Providers list uses), accessible right in the popover. */}
          <div
            role="group"
            aria-label="Model filter"
            className="flex items-center justify-between gap-2 px-1 pb-1.5 mb-1 border-b"
            style={{ borderColor: styles.borderSubtle }}
          >
            <span className="text-[10px] font-medium uppercase tracking-[0.08em]" style={{ color: styles.textTertiary }}>
              Providers
            </span>
            <div
              // R126-3d-4: the segmented control's rim → the 1px clay
              // hairline (the 1.5px bento border retired, TOKENS §5).
              className="flex items-center rounded-lg border border-clay-rim overflow-hidden"
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
                  // R126-3d-4: the ACTIVE segment = accentTint + accentDeep
                  // ink (the selection grammar).
                  className={`h-5 px-2 text-[10px] font-medium transition-colors ${
                    seg.active ? "bg-accent-tint text-accent-deep" : ""
                  }`}
                  style={seg.active ? undefined : { color: styles.textTertiary }}
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
                      // R126-3d-4: the hover-lit provider row = accentTint
                      // (TOKENS §10's tinted container; withAlpha retired).
                      background: hoveredProvider === p.id ? styles.accentTint : "transparent",
                    }}
                    onMouseEnter={(e) => openFlyout(p.id, e.currentTarget, e)}
                    // ROUND-52 (R52-a): don't close instantly — start the grace
                    // timer so the pointer can cross the popover padding +
                    // FLYOUT_MARGIN gap into the flyout (entering the flyout,
                    // or this row again, cancels it). R87-A1: leaving also
                    // cancels any dwell promotion pending for this row (the
                    // pointer moved on — the dwell only fires while it rests).
                    onMouseLeave={() => {
                      cancelRetarget();
                      scheduleClose();
                    }}
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
                      className="flex-1 min-w-0 flex items-center gap-1.5 text-left px-2 py-1.5 rounded-lg text-muted"
                    >
                      <span className="text-[12px] font-semibold truncate">{p.name}</span>
                      {effectiveProviderId === p.id ? (
                        <span className="font-mono text-[10px] shrink-0 text-accent-deep">
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
                      className="w-7 h-7 mr-0.5 grid place-items-center rounded-lg shrink-0 transition-colors hover:bg-hover"
                      style={{ color: styles.textTertiary }}
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
            className="w-full flex items-center justify-center gap-1.5 mt-1 pt-1.5 border-t text-[11px] font-medium transition-colors hover:bg-hover text-accent-deep"
            style={{ borderColor: styles.borderSubtle }}
          >
            <Settings size={11} />
            Manage Models
          </button>
        </div>
      ) : null}
    </div>
  );
}
