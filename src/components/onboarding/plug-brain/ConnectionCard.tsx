import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useOnboardingStore } from "../onboarding-store";
import {
  fetchModels,
  isTauri,
  storeProviderKey,
  testConnection,
  type ConnectionTestResult,
} from "../providers-api";
import { useThemeStyles } from "../../../lib/use-theme-styles";
import { SEMANTIC_COLORS } from "../../../lib/semantics";

/**
 * Connection card — demo anatomy (components/plug-brain/ConnectionCard.tsx)
 * wired LIVE: the model dropdown is fed by GET /providers/{id}/models and the
 * test pill runs POST /providers/{id}/test. The key field is memory-only; it
 * reaches Credential Manager exclusively via the Tauri command on Save.
 */
export function ConnectionCard() {
  const s = useThemeStyles();
  const providerId = useOnboardingStore((st) => st.providerId);
  const baseUrl = useOnboardingStore((st) => st.baseUrl);
  const setBaseUrl = useOnboardingStore((st) => st.setBaseUrl);
  const apiKey = useOnboardingStore((st) => st.apiKey);
  const setApiKey = useOnboardingStore((st) => st.setApiKey);
  const showApiKey = useOnboardingStore((st) => st.showApiKey);
  const toggleShowApiKey = useOnboardingStore((st) => st.toggleShowApiKey);
  const modelId = useOnboardingStore((st) => st.modelId);
  const setModelId = useOnboardingStore((st) => st.setModelId);

  const [modelOpen, setModelOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const modelRef = useRef<HTMLDivElement>(null);

  const modelsQuery = useQuery({
    queryKey: ["onboarding.models", providerId],
    queryFn: () => fetchModels(providerId),
    // Owner directive: the catalog search starts ONLY once the user has
    // entered an API key — never on provider selection alone (it just failed
    // with "Failed to fetch" before).
    enabled: providerId !== "" && apiKey.length > 6,
    staleTime: 60_000,
    retry: 1,
  });
  const models = useMemo(() => modelsQuery.data ?? [], [modelsQuery.data]);

  // Close model dropdown on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) {
        setModelOpen(false);
        setModelSearch("");
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const filteredModels = useMemo(() => {
    if (!modelSearch.trim()) return models;
    const q = modelSearch.toLowerCase();
    return models.filter((m) => m.id.toLowerCase().includes(q));
  }, [models, modelSearch]);

  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setApiKey(text.trim());
    } catch {
      /* clipboard not available */
    }
  }, [setApiKey]);

  /** Auto-detect: pick the first model of the live catalog. */
  const handleAutoDetect = useCallback(() => {
    if (models.length > 0) setModelId(models[0].id);
  }, [models, setModelId]);

  /**
   * Test what the user actually typed: in the desktop app the typed key is
   * stored first (Credential Manager + live push to the sidecar keyring), so
   * the probe validates the CURRENT inputs. In a plain browser the sidecar's
   * server-side key is tested (and the result says so).
   */
  const handleTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      if (isTauri() && apiKey.length > 6) {
        await storeProviderKey(providerId, apiKey);
      }
      const result = await testConnection(providerId, modelId || undefined);
      setTestResult(result);
    } finally {
      setTesting(false);
    }
  }, [providerId, modelId, apiKey]);

  const inputStyle = {
    background: s.inputBg,
    borderColor: s.inputBorder,
    color: s.text,
  } as const;

  const focusHandlers = {
    onFocus: (e: React.FocusEvent<HTMLInputElement>) =>
      (e.target.style.borderColor = s.inputFocusBorder),
    onBlur: (e: React.FocusEvent<HTMLInputElement>) =>
      (e.target.style.borderColor = s.inputBorder),
  } as const;

  return (
    <div
      className="rounded-[24px] border p-4 md:p-5 border-clay-rim ac-clay bg-card"
    >
      <div className="flex items-center justify-between">
        <span className="font-bold tracking-tight" style={{ color: s.text }}>Connection</span>
        <span
          className="text-[10px] font-bold px-2 py-1 rounded-full bg-badge-neutral text-badge-neutral-fg"
        >
          STEP 2
        </span>
      </div>

      <div className="mt-4 grid gap-4">
        {/* Base URL */}
        <div>
          <label
            className="block text-[11px] font-bold uppercase tracking-widest mb-1.5"
            style={{ color: s.textTertiary }}
          >
            Base URL
          </label>
          <div className="relative">
            <input
              type="text"
              className="w-full h-12 rounded-[14px] border-[1.5px] px-4 pr-20 text-[13px] font-medium outline-none transition-colors"
              style={inputStyle}
              {...focusHandlers}
              placeholder="https://api.openai.com/v1"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
            <span
              className="absolute right-1.5 top-1.5 bottom-1.5 px-3 grid place-items-center rounded-[10px] border text-[11px] font-bold"
              style={{
                background: s.card,
                borderColor: s.border,
                color: s.textSecondary,
              }}
            >
              auto
            </span>
          </div>
        </div>

        {/* API Key */}
        <div>
          <label
            className="block text-[11px] font-bold uppercase tracking-widest mb-1.5"
            style={{ color: s.textTertiary }}
          >
            API Key
          </label>
          <div className="relative">
            <input
              type={showApiKey ? "text" : "password"}
              autoComplete="off"
              className="w-full h-12 rounded-[14px] border-[1.5px] px-4 pr-[132px] text-[13px] font-mono outline-none transition-colors"
              style={inputStyle}
              {...focusHandlers}
              placeholder="sk-..."
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <div className="absolute right-1.5 top-1.5 bottom-1.5 flex items-center gap-1">
              <button
                type="button"
                className="h-9 px-3 rounded-[10px] border text-[11px] font-bold cursor-pointer transition-colors"
                style={{
                  background: s.subtle,
                  borderColor: s.border,
                  color: s.text,
                }}
                onClick={handlePaste}
              >
                Paste
              </button>
              <button
                type="button"
                className="h-9 px-3 rounded-[10px] text-[11px] font-bold cursor-pointer transition-colors bg-badge-neutral text-badge-neutral-fg"
                onClick={toggleShowApiKey}
              >
                {showApiKey ? "Hide" : "Show"}
              </button>
            </div>
          </div>
          <p className="mt-1.5 text-[11px] font-medium" style={{ color: s.textTertiary }}>
            Stored in Windows Credential Manager on save — never in the app, browser storage, or REST calls.
          </p>
        </div>

        {/* Model ID — a proper picker: typing commits LIVE (manual entry),
            the chevron always opens the catalog list, and the list degrades
            gracefully when the catalog is loading/unavailable */}
        <div ref={modelRef}>
          <label
            className="block text-[11px] font-bold uppercase tracking-widest mb-1.5"
            style={{ color: s.textTertiary }}
          >
            Model ID
          </label>
          <div className="relative">
            <input
              type="text"
              className="w-full h-12 rounded-[14px] border-[1.5px] px-4 pr-[128px] text-[13px] font-mono outline-none transition-colors"
              style={{ ...inputStyle, borderColor: modelOpen ? s.borderStrong : s.inputBorder }}
              onFocus={(e) => {
                setModelOpen(true);
                setModelSearch(modelId);
                setTimeout(() => e.target.select(), 0);
              }}
              placeholder={providerId ? "e.g. gpt-4o" : "Pick a provider first"}
              value={modelOpen ? modelSearch : modelId}
              onChange={(e) => {
                // Live commit: what you type IS the model id; the dropdown
                // simultaneously filters the catalog around it.
                setModelSearch(e.target.value);
                setModelId(e.target.value);
              }}
            />
            <div className="absolute right-1.5 top-1.5 bottom-1.5 flex items-center gap-1">
              <button
                type="button"
                aria-label={modelOpen ? "Close model list" : "Open model list"}
                className="h-9 w-9 rounded-[10px] border grid place-items-center cursor-pointer transition-colors"
                style={{
                  background: s.card,
                  borderColor: s.border,
                  color: s.textSecondary,
                }}
                onClick={() => {
                  if (modelOpen) {
                    setModelOpen(false);
                    setModelSearch("");
                  } else {
                    // Expand = show the WHOLE catalog (owner round-7: the
                    // list must not arrive pre-filtered by the current id).
                    setModelOpen(true);
                    setModelSearch("");
                  }
                }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="none"
                  className={`transition-transform ${modelOpen ? "rotate-180" : ""}`}
                >
                  <path d="M4 6L8 10L12 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button
                type="button"
                className="h-9 px-3 rounded-[10px] border-[1.5px] text-[11px] font-bold flex items-center gap-1 cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                style={{
                  background: s.card,
                  borderColor: s.borderStrong,
                  color: s.text,
                }}
                onClick={handleAutoDetect}
                disabled={models.length === 0}
                title={modelsQuery.isError ? "Model catalog unavailable" : "Pick first model from the live catalog"}
              >
                ◍ Auto
              </button>
            </div>

            {/* Model dropdown — always rendered while open, with explicit
                empty states so manual entry is never blocked. R126-3g: clay
                popover + the selection grammar rows (CSS hover wash; the JS
                handlers retired). */}
            {modelOpen && (
              <div
                className="absolute z-20 top-[56px] left-0 right-0 rounded-[16px] border p-1.5 animate-slideDown max-h-[260px] overflow-y-auto custom-scrollbar border-clay-rim ac-clay bg-card"
              >
                {modelsQuery.isFetching && (
                  <div className="py-5 text-center text-[12px] font-medium" style={{ color: s.textTertiary }}>
                    Loading models…
                  </div>
                )}
                {!modelsQuery.isFetching && models.length === 0 && (
                  <div className="py-5 text-center text-[12px] font-medium px-3" style={{ color: s.textTertiary }}>
                    {apiKey.length <= 6
                      ? "Enter your API key above to load this provider's model list."
                      : modelsQuery.isError
                        ? "Catalog unavailable — type any model id by hand."
                        : providerId
                          ? "No catalog for this provider yet — type any model id."
                          : "Pick a provider first."}
                  </div>
                )}
                {!modelsQuery.isFetching && models.length > 0 && filteredModels.length === 0 && (
                  <div className="py-5 text-center text-[12px] font-medium" style={{ color: s.textTertiary }}>
                    No catalog matches “{modelSearch}” — press Enter to keep it.
                  </div>
                )}
                {filteredModels.map((m) => {
                  const isSelected = m.id === modelId;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      aria-current={isSelected ? "true" : undefined}
                      className={`relative h-[42px] w-full rounded-[14px] flex items-center gap-2 px-3 cursor-pointer transition-colors text-left text-[13px] font-mono ${
                        isSelected ? "bg-accent-tint text-accent-deep" : "hover:bg-hover"
                      }`}
                      onClick={() => {
                        setModelId(m.id);
                        setModelOpen(false);
                        setModelSearch("");
                      }}
                    >
                      {isSelected && (
                        <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-accent-deep" aria-hidden />
                      )}
                      <span className="truncate">{m.id}</span>
                      {m.contextWindow ? (
                        <span className="ml-auto shrink-0 text-[10px]" style={{ color: s.textTertiary }}>
                          {Math.round(m.contextWindow / 1000)}K ctx
                        </span>
                      ) : null}
                      {isSelected && (
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="shrink-0">
                          <path d="M3 8.5L6.5 12L13 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          {modelsQuery.isError && (
            <p className="mt-1.5 text-[11px] font-medium text-warning-deep">
              {(modelsQuery.error as Error).message} — you can still type a model id by hand.
            </p>
          )}
        </div>

        {/* Connection test — R126-3g: the test pill rides the §11 badge
            tones + the pipeline's flat status hues (dots only); the quiet
            button is a clay secondary. */}
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            className="h-10 px-4 rounded-full border text-[12px] font-bold flex items-center gap-2 cursor-pointer transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed border-clay-rim ac-clay-sm bg-card"
            style={{ color: s.text }}
            onClick={handleTest}
            disabled={!providerId || testing}
          >
            <span
              className="w-2 h-2 rounded-full"
              style={{
                background: testResult?.ok
                  ? SEMANTIC_COLORS.success
                  : testResult && !testResult.ok
                    ? SEMANTIC_COLORS.danger
                    : s.borderStrong,
              }}
            />
            {testing ? "Testing…" : "Test connection"}
          </button>
          {testResult && (
            <span
              className={`text-[11px] font-medium truncate min-w-0 ${
                testResult.ok ? "text-success-deep" : "text-danger-deep"
              }`}
              title={testResult.message}
            >
              {testResult.ok
                ? `Connected${testResult.latencyMs ? ` • ${testResult.latencyMs}ms` : ""}${testResult.model ? ` • ${testResult.model}` : ""}${!isTauri() ? " • server key" : ""}`
                : (testResult.message ?? "Test failed.")}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
