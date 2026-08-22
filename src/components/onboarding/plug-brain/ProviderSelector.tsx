import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useOnboardingStore } from "../onboarding-store";
import {
  fetchProviders,
  OPENROUTER_FALLBACK,
  withClientDefaults,
  type ProviderView,
} from "../providers-api";
import { useThemeStyles } from "../../../lib/use-theme-styles";

/** First letter avatar chip — derived, never a hard-coded brand letter. */
function providerLetter(p: ProviderView): string {
  const ch = p.name.trim().charAt(0).toUpperCase();
  return ch === "" ? "?" : ch;
}

/**
 * Provider dropdown — demo anatomy (components/plug-brain/ProviderSelector.tsx)
 * with the catalog fetched LIVE from GET /api/v1/providers.
 *
 * Owner directive: the selector ALWAYS includes "OpenRouter" (label
 * "OpenRouter", hint "recommended · your keys stay local") as the default
 * selected option, resolved client-side — the UI never gates on the server
 * list containing it. Server rows merge in additionally; a user-picked
 * provider is never overridden by the auto-selection.
 */
export function ProviderSelector() {
  const s = useThemeStyles();
  const providerId = useOnboardingStore((st) => st.providerId);
  const setProvider = useOnboardingStore((st) => st.setProvider);
  const setBaseUrl = useOnboardingStore((st) => st.setBaseUrl);
  const setModelId = useOnboardingStore((st) => st.setModelId);

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Set once the user explicitly picks a row; stops all auto-selection.
  const userChosenRef = useRef(false);

  const providersQuery = useQuery({
    queryKey: ["onboarding.providers"],
    queryFn: fetchProviders,
    staleTime: 30_000,
  });

  // Server rows first, then the client-side OpenRouter default — non-empty
  // even while pending or when the sidecar is unreachable.
  const options = useMemo(
    () => withClientDefaults(providersQuery.data ?? []),
    [providersQuery.data],
  );

  // Default selection: OpenRouter, applied exactly once client-side. A
  // server-provided openrouter row wins over the synthesized constant.
  useEffect(() => {
    if (userChosenRef.current) return;
    const preferred =
      options.find((o) => o.provider.id === OPENROUTER_FALLBACK.id)?.provider ??
      OPENROUTER_FALLBACK;
    if (providerId !== preferred.id) {
      setProvider(preferred.id);
      setBaseUrl(preferred.baseUrl ?? "");
    }
  }, [options, providerId, setProvider, setBaseUrl]);

  const provider = useMemo(
    () => options.find((o) => o.provider.id === providerId)?.provider,
    [options, providerId],
  );

  const filtered = useMemo(() => {
    if (!search.trim()) return options;
    const q = search.toLowerCase();
    return options.filter(
      (o) =>
        o.provider.name.toLowerCase().includes(q) ||
        o.provider.id.toLowerCase().includes(q) ||
        (o.provider.baseUrl ?? "").toLowerCase().includes(q),
    );
  }, [options, search]);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  const handleSelect = useCallback(
    (p: ProviderView) => {
      userChosenRef.current = true;
      setProvider(p.id);
      setBaseUrl(p.baseUrl ?? "");
      setModelId("");
      setOpen(false);
      setSearch("");
    },
    [setProvider, setBaseUrl, setModelId],
  );

  const handleTriggerClick = () => {
    if (open) {
      setOpen(false);
      setSearch("");
    } else {
      setOpen(true);
      setSearch("");
    }
  };

  const displayValue = open ? search : (provider?.name ?? "Select provider");

  return (
    <div ref={containerRef} className="relative mt-4">
      <div
        className="h-[56px] rounded-[16px] border-[1.5px] flex items-center gap-3 px-4 transition-colors"
        style={{ background: s.card, borderColor: open ? s.borderStrong : s.border, boxShadow: open ? s.bentoShadowSm : "none" }}
      >
        {provider && (
          <span className="w-9 h-9 rounded-full grid place-items-center text-[13px] font-bold shrink-0" style={{ background: s.accent, color: s.accentText }}>
            {providerLetter(provider)}
          </span>
        )}
        <input
          ref={inputRef}
          type="text"
          className="flex-1 bg-transparent outline-none text-[14px] font-medium"
          style={{ color: s.text }}
          placeholder={providersQuery.isError ? "Agent core offline…" : "Search providers..."}
          value={displayValue}
          onChange={(e) => setSearch(e.target.value)}
          onFocus={() => { if (!open) { setOpen(true); setSearch(""); } }}
        />
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className={`shrink-0 transition-transform cursor-pointer ${open ? "rotate-180" : ""}`} style={{ color: s.textSecondary }} onClick={handleTriggerClick}>
          <path d="M4 6L8 10L12 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      {open && (
        <div className="absolute z-20 top-[64px] left-0 right-0 rounded-[16px] border-[1.5px] p-1.5 max-h-[320px] overflow-y-auto animate-slideDown" style={{ background: s.card, borderColor: s.borderStrong, boxShadow: s.bentoShadow }}>
          {filtered.length === 0 && providersQuery.isPending && (
            <div className="py-6 text-center text-[13px] font-medium" style={{ color: s.textTertiary }}>Loading providers…</div>
          )}
          {filtered.length === 0 && !providersQuery.isPending && (
            <div className="py-6 text-center text-[13px] font-medium" style={{ color: s.textTertiary }}>
              {providersQuery.isError ? "No matches — agent core unreachable." : "No providers found"}
            </div>
          )}
          {filtered.map(({ provider: p, clientDefault }) => {
            const isSelected = p.id === providerId;
            return (
              <button
                key={p.id}
                type="button"
                className="h-[48px] rounded-[14px] flex items-center gap-3 px-3 cursor-pointer transition-colors w-full text-left"
                style={{ background: isSelected ? s.subtleHover : "transparent" }}
                onClick={() => handleSelect(p)}
                onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = s.subtle; }}
                onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}
              >
                <span className="w-9 h-9 rounded-full grid place-items-center text-[13px] font-bold shrink-0" style={{ background: s.pillBg, color: s.pillText }}>
                  {providerLetter(p)}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[13px] font-bold truncate" style={{ color: s.text }}>{p.name}</span>
                  <span className="block text-[11px] truncate" style={{ color: s.textTertiary }}>
                    {clientDefault
                      ? "recommended · your keys stay local"
                      : (p.baseUrl ?? `${p.kind} • built-in`)}
                    {p.hasKey ? " • ✓ key" : ""}
                  </span>
                </span>
                {isSelected && (
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="shrink-0" style={{ color: s.text }}>
                    <path d="M3 8.5L6.5 12L13 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
