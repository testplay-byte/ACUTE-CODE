import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useOnboardingStore } from "../onboarding-store";
import { fetchProviders, isTauri, markSetupDone, storeProviderKey, withClientDefaults } from "../providers-api";
import { getAgentsBackend, upsertProviderModelConfig } from "../../../lib/api";
// R90-A3: the wizard's choices now outlive the wizard — the model row + the
// global last-used default + the default agent's provider/model.
import { saveLastUsedModel } from "../../project-chat/composer/composer-utils";
import {
  cleanModelName,
  invalidateModelConfigEverywhere,
  invalidateProvidersEverywhere,
} from "../../settings/ModelsProvidersTab";
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
 *
 * ROUND-90 (R90-A3, the owner: after the wizard "the model was apparently
 * not selected there… [I] selected the model manually"): "Save & Continue"
 * now persists the WHOLE choice, not just the key. Pre-R90 handleSave wrote
 * the key + the setup-done flag and nothing else — the picked provider/model,
 * the tuning card's context/max-output/pricing values, all of it died with
 * the wizard's memory store. Three persistence legs, each best-effort so a
 * single failure never blocks completing setup:
 *  1. the model row — POST /providers/:id/models (upsert): Settings → Models
 *     shows it configured, the chat picker lists it, the tuning values land.
 *  2. the global last-used model — the next chats default to the wizard's
 *     pick (the R89-B4 localStorage key, same one a manual pick writes).
 *  3. the default agent — PATCH agt_default_nova to the picked provider +
 *     model, so the seeded "Acute" agent stops pointing at openrouter
 *     (the owner: "the provider was OpenRouter, even though I did not have
 *     OpenRouter added to it").
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
      }
      // ── R90-A3: persist the CHOICE, not just the key ─────────────────────
      // (each leg is best-effort — a failure logs to the console and setup
      // still completes; the key was the only critical secret.)
      try {
        await upsertProviderModelConfig(providerId, {
          modelId,
          displayName: cleanModelName(modelId),
          contextWindow,
          maxOutputTokens: maxOutput,
          inputPricePerMtok: inputCost,
          outputPricePerMtok: outputCost,
          // The reasoning pick translates to the row's thinking flag.
          supportsThinking: reasoning !== "none",
        });
      } catch (err) {
        console.warn("[setup] model row upsert failed (setup continues)", err);
      }
      try {
        // The next chats' default = the wizard's pick (R89-B4's key, written
        // by every manual pick since — the wizard is just the FIRST pick).
        saveLastUsedModel({ model: modelId, providerId });
      } catch (err) {
        console.warn("[setup] last-used-model save failed (setup continues)", err);
      }
      try {
        // The seeded default agent ("Acute", agt_default_nova — the id the
        // sidecar's migrations seed) points at openrouter/z-ai/glm-5.2:free.
        // Point it at the wizard's choice so the agent-side default matches
        // what the owner just configured.
        const backend = getAgentsBackend();
        const agents = await backend.list(false);
        const seeded = agents.find((a) => a.id === "agt_default_nova");
        if (seeded !== undefined) {
          await backend.update(seeded.id, { providerId, model: modelId });
        }
      } catch (err) {
        console.warn("[setup] default-agent update failed (setup continues)", err);
      }
      // Everything the rest of the app reads must see the new state NOW.
      invalidateProvidersEverywhere(queryClient);
      invalidateModelConfigEverywhere(queryClient, providerId);
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
      if (isTauri()) {
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
      {/* --- MODEL SUMMARY CARD — R126-3g: the clay card. --- */}
      <div
        className="rounded-[24px] border p-4 border-clay-rim ac-clay bg-card"
      >
        <div className="flex items-center justify-between">
          <span className="font-black tracking-tight" style={{ color: s.text }}>Model Summary</span>
          <span
            className="px-2 py-1 rounded-full text-[10px] font-bold bg-badge-success text-badge-success-fg"
          >
            LIVE
          </span>
        </div>

        {/* Tags */}
        <div className="mt-3 flex flex-wrap gap-2">
          {provider && (
            <span
              className="px-3 py-1.5 rounded-full text-[11px] font-bold flex items-center gap-1.5 bg-badge-neutral text-badge-neutral-fg"
            >
              <span
                className="w-5 h-5 rounded-full grid place-items-center text-[10px] font-bold"
                style={{ background: s.accentDeep, color: s.accentText }}
              >
                {providerLetter}
              </span>
              {provider.name}
            </span>
          )}
          {modelId && (
            <span
              className="px-3 py-1.5 rounded-full border text-[11px] font-mono font-bold truncate max-w-[160px] border-clay-rim bg-well"
              style={{ color: s.text }}
            >
              {modelId}
            </span>
          )}
        </div>

        {/* Stats grid — R126-3g: recessed wells. */}
        <div className="grid grid-cols-2 gap-2 mt-3">
          {[
            { label: "Context", value: formatContextLabel(contextWindow) },
            { label: "Max Out", value: formatContextLabel(maxOutput) },
            { label: "Input $", value: formatCost(inputCost) },
            { label: "Output $", value: formatCost(outputCost) },
          ].map((item) => (
            <div
              key={item.label}
              className="ac-well rounded-[14px] p-3"
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

        {/* Reasoning row — R126-3g: the well + the accent meter bars. */}
        <div
          className="ac-well mt-3 rounded-[14px] p-3 flex items-center justify-between"
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
                  background: i <= reasoningIndex ? s.accent : s.border,
                }}
              />
            ))}
          </div>
        </div>

        {/* Cost card — R126-3g: the accentTint fill + accentDeep ink (hue
            without loudness — the full-accent fill retired). */}
        <div
          className="mt-3 rounded-[14px] border p-3 flex items-center justify-between bg-accent-tint border-clay-rim"
        >
          <div>
            <div
              className="text-[10px] font-bold uppercase tracking-widest text-accent-deep"
              style={{ opacity: 0.75 }}
            >
              Est. cost / task
            </div>
            <div className="mt-0.5 font-black text-[16px] text-accent-deep">
              {estCost}
            </div>
          </div>
          <div
            className="w-10 h-10 rounded-full grid place-items-center text-[12px]"
            style={{ background: s.accentDeep, color: s.accentText }}
          >
            ✦
          </div>
        </div>

        {/* Security note — R126-3g: the well + the success badge ✓. */}
        <div
          className="ac-well mt-3 flex items-center gap-2 text-[11px] font-bold px-3 py-2 rounded-full"
          style={{ color: s.textSecondary }}
        >
          <span
            className="w-5 h-5 rounded-full grid place-items-center text-[10px] shrink-0 bg-badge-success text-badge-success-fg"
          >
            ✓
          </span>
          Credential Manager &bull; DPAPI &bull; Local
        </div>
      </div>

      {/* --- READY TO SHIP STICKER — R126-3g: the accentDeep fill +
          accentText ink (the §11 accent pair); the rotation stays. --- */}
      <div
        className="rounded-[18px] px-4 py-3 rotate-[1deg] flex items-center justify-between ac-clay-sm"
        style={{
          backgroundColor: s.accentDeep,
          color: s.accentText,
        }}
      >
        <span className="font-black tracking-tight text-[15px]">READY TO SHIP</span>
        <span
          className="px-2 py-1 rounded-full text-[10px] font-bold"
          style={{ background: s.accentText, color: s.accentDeep }}
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
        <p className="text-[11px] font-medium px-1 text-danger-deep">
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
