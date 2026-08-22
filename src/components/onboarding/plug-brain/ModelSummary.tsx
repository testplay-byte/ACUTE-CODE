import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useOnboardingStore } from "../onboarding-store";
import { fetchProviders, isTauri, markSetupDone, storeProviderKey, withClientDefaults } from "../providers-api";
import { CONTEXT_LABELS, estimateCost, formatContext, formatCost, REASONING_LEVELS } from "../onboarding-types";
import { useThemeStyles } from "../../../lib/use-theme-styles";
import { ActionButton } from "../ActionButton";

function formatContextLabel(val: number): string {
  if (CONTEXT_LABELS[val]) return CONTEXT_LABELS[val];
  return formatContext(val);
}

/**
 * Summary rail — ported from the demo's plug-brain/ModelSummary.tsx. Save
 * hands the key to the Tauri shell (Credential Manager) before advancing;
 * in a plain browser (dev) there is no keyring, so saving proceeds WITHOUT
 * storing any secret rather than falling back to REST/localStorage.
 */
export function ModelSummary({ onBack, onSave }: { onBack: () => void; onSave: () => void }) {
  const s = useThemeStyles();
  const queryClient = useQueryClient();
  const providerId = useOnboardingStore((st) => st.providerId);
  const apiKey = useOnboardingStore((st) => st.apiKey);
  const modelId = useOnboardingStore((st) => st.modelId);
  const contextWindow = useOnboardingStore((st) => st.contextWindow);
  const maxOutput = useOnboardingStore((st) => st.maxOutput);
  const inputCost = useOnboardingStore((st) => st.inputCost);
  const outputCost = useOnboardingStore((st) => st.outputCost);
  const reasoning = useOnboardingStore((st) => st.reasoning);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const providersQuery = useQuery({
    queryKey: ["onboarding.providers"],
    queryFn: fetchProviders,
    staleTime: 30_000,
  });
  // Same merged catalog as the selector (server rows + client-side OpenRouter
  // default) so the summary tag resolves even when the sidecar list is empty.
  const provider = useMemo(
    () =>
      withClientDefaults(providersQuery.data ?? []).find(
        (o) => o.provider.id === providerId,
      )?.provider,
    [providersQuery.data, providerId],
  );
  const providerLetter = provider ? provider.name.trim().charAt(0).toUpperCase() || "?" : "?";

  const reasoningIndex = REASONING_LEVELS.findIndex((r) => r.id === reasoning);
  const activeReasoning = REASONING_LEVELS[reasoningIndex >= 0 ? reasoningIndex : 0];
  const canProceed = apiKey.length > 6 && modelId.length > 2 && !!providerId;
  const estCost = estimateCost(contextWindow, maxOutput, inputCost, outputCost);

  const handleSave = async () => {
    if (!canProceed || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      if (isTauri()) {
        await storeProviderKey(providerId, apiKey);
        // Refresh hasKey flags so the rest of the app sees the new key.
        void queryClient.invalidateQueries({ queryKey: ["onboarding.providers"] });
      }
      markSetupDone();
      onSave();
    } catch (error) {
      setSaveError(
        error instanceof Error ? error.message : "Could not store the key securely.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-3">
      {/* --- MODEL SUMMARY CARD --- */}
      <div
        className="rounded-[24px] border-[1.5px] p-4"
        style={{
          background: s.card,
          borderColor: s.borderStrong,
          boxShadow: s.bentoShadow,
        }}
      >
        <div className="flex items-center justify-between">
          <span className="font-black tracking-tight" style={{ color: s.text }}>Model Summary</span>
          <span
            className="px-2 py-1 rounded-full border text-[10px] font-bold"
            style={{
              backgroundColor: s.accent,
              color: s.accentText,
              borderColor: s.accent,
            }}
          >
            LIVE
          </span>
        </div>

        {/* Tags */}
        <div className="mt-3 flex flex-wrap gap-2">
          {provider && (
            <span
              className="px-3 py-1.5 rounded-full text-[11px] font-bold flex items-center gap-1.5"
              style={{ background: s.pillBg, color: s.pillText }}
            >
              <span
                className="w-5 h-5 rounded-full grid place-items-center text-[10px] font-bold"
                style={{ background: s.accent, color: s.accentText }}
              >
                {providerLetter}
              </span>
              {provider.name}
            </span>
          )}
          {modelId && (
            <span
              className="px-3 py-1.5 rounded-full border text-[11px] font-mono font-bold truncate max-w-[160px]"
              style={{
                background: s.card,
                borderColor: s.border,
                color: s.text,
              }}
            >
              {modelId}
            </span>
          )}
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-2 gap-2 mt-3">
          {[
            { label: "Context", value: formatContextLabel(contextWindow) },
            { label: "Max Out", value: formatContextLabel(maxOutput) },
            { label: "Input $", value: formatCost(inputCost) },
            { label: "Output $", value: formatCost(outputCost) },
          ].map((item) => (
            <div
              key={item.label}
              className="rounded-[14px] border p-3"
              style={{ background: s.subtle, borderColor: s.border }}
            >
              <div className="text-[10px] font-bold uppercase tracking-widest" style={{ color: s.textTertiary }}>
                {item.label}
              </div>
              <div className="mt-1 font-black text-[14px]" style={{ color: s.text }}>
                {item.value}
              </div>
            </div>
          ))}
        </div>

        {/* Reasoning row */}
        <div
          className="mt-3 rounded-[14px] border p-3 flex items-center justify-between"
          style={{ borderColor: s.border }}
        >
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest" style={{ color: s.textTertiary }}>
              Reasoning
            </div>
            <div className="mt-0.5 text-[13px] font-bold" style={{ color: s.text }}>
              {activeReasoning?.label ?? "None"}
              <span className="font-medium ml-1" style={{ color: s.textSecondary }}>
                — {activeReasoning?.desc ?? ""}
              </span>
            </div>
          </div>
          <div className="flex items-end gap-1">
            {REASONING_LEVELS.map((_, i) => (
              <span
                key={i}
                className="w-1.5 h-5 rounded-full"
                style={{
                  background: i <= reasoningIndex ? s.toggleActive : s.border,
                }}
              />
            ))}
          </div>
        </div>

        {/* Cost card (THEMED) */}
        <div
          className="mt-3 rounded-[14px] border-[1.5px] p-3 flex items-center justify-between"
          style={{
            backgroundColor: s.accent,
            borderColor: s.accent,
          }}
        >
          <div>
            <div
              className="text-[10px] font-bold uppercase tracking-widest"
              style={{ color: s.accentText, opacity: 0.7 }}
            >
              Est. cost / task
            </div>
            <div className="mt-0.5 font-black text-[16px]" style={{ color: s.accentText }}>
              {estCost}
            </div>
          </div>
          <div
            className="w-10 h-10 rounded-full grid place-items-center text-[12px]"
            style={{ background: s.accentText, color: s.accent }}
          >
            ✦
          </div>
        </div>

        {/* Security note */}
        <div
          className="mt-3 flex items-center gap-2 text-[11px] font-bold px-3 py-2 rounded-full border"
          style={{
            background: s.subtle,
            borderColor: s.border,
            color: s.text,
          }}
        >
          <span
            className="w-5 h-5 rounded-full bg-[#27C93F] grid place-items-center text-[10px] text-black shrink-0"
          >
            ✓
          </span>
          Credential Manager &bull; DPAPI &bull; Local
        </div>
      </div>

      {/* --- READY TO SHIP STICKER (THEMED) --- */}
      <div
        className="rounded-[18px] border-[1.5px] px-4 py-3 rotate-[1deg] flex items-center justify-between"
        style={{
          backgroundColor: s.accent,
          borderColor: s.accent,
          color: s.accentText,
          boxShadow: s.bentoShadowSm,
        }}
      >
        <span className="font-black tracking-tight text-[15px]">READY TO SHIP</span>
        <span
          className="px-2 py-1 rounded-full text-[10px] font-bold"
          style={{ background: s.accentText, color: s.accent }}
        >
          STICKER
        </span>
      </div>

      {/* Save feedback */}
      {!isTauri() && (
        <p className="text-[11px] font-medium px-1" style={{ color: s.textTertiary }}>
          Browser dev mode: the key cannot reach Credential Manager here — run the desktop app to store it.
        </p>
      )}
      {saveError && (
        <p className="text-[11px] font-medium px-1" style={{ color: "#D64545" }}>
          {saveError}
        </p>
      )}

      {/* --- BUTTONS --- */}
      <div className="mt-2 flex items-center gap-3">
        <ActionButton variant="secondary" onClick={onBack}>
          ← Back
        </ActionButton>
        <ActionButton
          variant="primary"
          onClick={handleSave}
          disabled={!canProceed || saving}
          ariaLabel={saving ? "Storing key" : "Save and continue"}
        >
          {saving ? "Storing key…" : "Save & Continue →"}
        </ActionButton>
      </div>
    </div>
  );
}
