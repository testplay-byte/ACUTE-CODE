import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useOnboardingStore } from "../onboarding-store";
import { DEFAULT_MODEL_ID } from "../onboarding-types";
import {
  createCustomProvider,
  fetchProviders,
  OPENROUTER_FALLBACK,
  withClientDefaults,
  type ProviderView,
} from "../providers-api";
import { useThemeStyles } from "../../../lib/use-theme-styles";
import { withAlpha } from "../../dashboard/helpers";

/** First letter avatar chip — derived, never a hard-coded brand letter. */
function providerLetter(p: ProviderView): string {
  const ch = p.name.trim().charAt(0).toUpperCase();
  return ch === "" ? "?" : ch;
}

/**
 * R98-H: the three wire formats, RESTATED locally — ModelsProvidersTab owns
 * the canonical list but deliberately does not export it (it is a private
 * const there); this copy must KEEP IN STEP with it: if that list ever
 * changes, this one follows in the same round.
 */
const API_FORMATS: Array<{ id: string; label: string; hint: string }> = [
  { id: "chat-completions", label: "Chat completions", hint: "OpenAI-compatible /v1/chat/completions — works with OpenRouter, vLLM, Ollama, gateways" },
  { id: "anthropic-messages", label: "Anthropic messages", hint: "/v1/messages — Anthropic and Anthropic-compatible endpoints" },
  { id: "responses", label: "Responses", hint: "OpenAI /v1/responses — the Responses API" },
];

/**
 * Provider dropdown — demo anatomy (components/plug-brain/ProviderSelector.tsx)
 * with the catalog fetched LIVE from GET /api/v1/providers.
 *
 * Owner directive: the selector ALWAYS includes "OpenRouter" (label
 * "OpenRouter", hint "recommended · your keys stay local") as the default
 * selected option, resolved client-side — the UI never gates on the server
 * list containing it. Server rows merge in additionally; a user-picked
 * provider is never overridden by the auto-selection.
 *
 * ROUND-98 (R98-H, owner: "Adding other providers: I am unable to select
 * OpenAI-compatible providers there… currently there are only options to
 * select Anthropic, Google, NVIDIA, OpenAI, and OpenRouter"): the dropdown
 * ALSO always offers "+ Custom OpenAI-compatible…" at the TOP — visually
 * distinct (Plus icon in a pill chip, accent label, hairline separator) and
 * surviving the loading/empty/error list states. Selecting it does NOT
 * select a provider: it closes the dropdown and expands an inline
 * three-field form card beneath the trigger (Display name / Base URL / API
 * format) that POSTs the row through providers-api.createCustomProvider —
 * the backend already fully supports it (the sidecar derives the id, stamps
 * kind "openai-compatible", 201s the row; a 409 renders the server's
 * message verbatim inline and keeps the form).
 */
export function ProviderSelector() {
  const s = useThemeStyles();
  const queryClient = useQueryClient();
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

  // ── R98-H: the inline custom-provider form's state ──────────────────────
  const [customFormOpen, setCustomFormOpen] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [customApiFormat, setCustomApiFormat] = useState("chat-completions");
  const [customError, setCustomError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // Locally-created rows merge into the options (dedupe by id) so the
  // trigger shows the fresh row's name even if the invalidated
  // ["onboarding.providers"] refetch fails (sidecar flaked mid-wizard).
  const [localProviders, setLocalProviders] = useState<ProviderView[]>([]);

  const providersQuery = useQuery({
    queryKey: ["onboarding.providers"],
    queryFn: fetchProviders,
    staleTime: 30_000,
  });

  // Server rows first, then the client-side OpenRouter default — non-empty
  // even while pending or when the sidecar is unreachable. R98-H: rows
  // created locally THIS wizard session join at the front (dedupe by id — a
  // server row for the same id always wins once the refetch lands).
  const options = useMemo(() => {
    const server = providersQuery.data ?? [];
    const locals = localProviders.filter((lp) => !server.some((sp) => sp.id === lp.id));
    return withClientDefaults([...locals, ...server]);
  }, [providersQuery.data, localProviders]);

  // Default selection: OpenRouter, applied exactly once client-side. A
  // server-provided openrouter row wins over the synthesized constant. The
  // model field prefills with the owner's default model for OpenRouter
  // (read from the store, not subscribed — typing in the model field must
  // never re-trigger this effect).
  useEffect(() => {
    if (userChosenRef.current) return;
    const preferred =
      options.find((o) => o.provider.id === OPENROUTER_FALLBACK.id)?.provider ??
      OPENROUTER_FALLBACK;
    if (providerId !== preferred.id) {
      setProvider(preferred.id);
      setBaseUrl(preferred.baseUrl ?? "");
      if (preferred.id === OPENROUTER_FALLBACK.id && !useOnboardingStore.getState().modelId) {
        setModelId(DEFAULT_MODEL_ID);
      }
    }
  }, [options, providerId, setProvider, setBaseUrl, setModelId]);

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

  // R98-H (the pre-existing focus-timer bug, fixed in passing): the 50ms
  // auto-focus timer survived the dropdown's close — the stale focus() then
  // re-opened the dropdown (the input's onFocus opens it when closed) OVER
  // the freshly expanded custom-provider form. The timer is now tracked in
  // a ref and cleared on EVERY close/unmount.
  const focusTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (open) {
      focusTimerRef.current = window.setTimeout(() => inputRef.current?.focus(), 50);
    }
    return () => {
      if (focusTimerRef.current !== null) {
        window.clearTimeout(focusTimerRef.current);
        focusTimerRef.current = null;
      }
    };
  }, [open]);

  const handleSelect = useCallback(
    (p: ProviderView) => {
      userChosenRef.current = true;
      setProvider(p.id);
      setBaseUrl(p.baseUrl ?? "");
      // OpenRouter keeps the owner's default model; other providers start
      // empty so the user picks from THEIR catalog.
      setModelId(p.id === OPENROUTER_FALLBACK.id ? DEFAULT_MODEL_ID : "");
      setOpen(false);
      setSearch("");
    },
    [setProvider, setBaseUrl, setModelId],
  );

  // R98-H: selecting the custom entry does NOT select a provider — it
  // closes the dropdown and expands the inline form beneath the trigger.
  const handleCustomEntryClick = () => {
    setOpen(false);
    setSearch("");
    setCustomError(null);
    setCustomFormOpen(true);
  };

  const handleCancelCustom = () => {
    setCustomError(null);
    setCustomFormOpen(false);
  };

  const handleCreateCustom = async () => {
    if (creating) return;
    const name = customName.trim();
    const baseUrl = customBaseUrl.trim();
    // Client-side validation — the honest refusal, and NEVER a POST.
    if (name === "") {
      setCustomError("Display name is required.");
      return;
    }
    if (!/^https?:\/\//.test(baseUrl)) {
      setCustomError("Base URL must start with http:// or https://.");
      return;
    }
    setCreating(true);
    setCustomError(null);
    try {
      const created = await createCustomProvider({ name, baseUrl, apiFormat: customApiFormat });
      // Success: the fresh row is selected EXACTLY like a normal pick
      // (userChosenRef stop + provider + baseUrl + modelId "" for a
      // non-OpenRouter row)…
      handleSelect(created);
      // …merged locally into the options (dedupe by id) so the trigger shows
      // the name even if the invalidated refetch fails…
      setLocalProviders((prev) => [created, ...prev.filter((p) => p.id !== created.id)]);
      // …the form collapses…
      setCustomFormOpen(false);
      setCustomName("");
      setCustomBaseUrl("");
      setCustomApiFormat("chat-completions");
      // …and the shared query is invalidated so ModelSummary's provider
      // tag resolves against the fresh catalog.
      void queryClient.invalidateQueries({ queryKey: ["onboarding.providers"] });
    } catch (error) {
      // 409 / failure: the server's EXACT message renders inline, verbatim;
      // the form stays so the user can fix the name and retry.
      setCustomError(error instanceof Error ? error.message : "Creating the provider failed.");
    } finally {
      setCreating(false);
    }
  };

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

  // ConnectionCard's input styling (the wizard's one spelling for fields).
  const inputStyle = {
    background: s.inputBg,
    borderColor: s.inputBorder,
    color: s.text,
  } as const;

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
          {/* R98-H: "+ Custom OpenAI-compatible…" — ALWAYS offered at the TOP,
              visually distinct (Plus icon in a pill chip, accent label,
              hairline separator); it survives the loading/empty/error list
              states below because it renders before them. */}
          <button
            type="button"
            className="h-[48px] rounded-[14px] flex items-center gap-3 px-3 cursor-pointer transition-colors w-full text-left"
            style={{ background: "transparent" }}
            onClick={handleCustomEntryClick}
            onMouseEnter={(e) => { e.currentTarget.style.background = s.subtle; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
          >
            <span
              className="w-9 h-9 rounded-full grid place-items-center shrink-0"
              style={{ background: withAlpha(s.accent, s.isDark ? 0.16 : 0.1), color: s.accent }}
            >
              <Plus size={16} strokeWidth={2.5} />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-[13px] font-bold truncate" style={{ color: s.accent }}>
                Custom OpenAI-compatible…
              </span>
              <span className="block text-[11px] truncate" style={{ color: s.textTertiary }}>
                Any /v1 endpoint — vLLM, Ollama, gateways
              </span>
            </span>
          </button>
          <div className="my-1.5 border-t" style={{ borderColor: s.borderSubtle }} aria-hidden />

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

      {/* R98-H: the inline custom-provider form — the wizard idiom card
          (rounded-[16px], 1.5px border, bentoShadowSm, subtle inset bg on the
          Provider card's surface) with ConnectionCard input styling and the
          action row in ActionButton's grammar (h-10 for the inline context). */}
      {customFormOpen && (
        <div
          className="mt-3 rounded-[16px] border-[1.5px] p-4 grid gap-4 text-left"
          style={{ background: s.subtle, borderColor: s.border, boxShadow: s.bentoShadowSm }}
        >
          <div>
            <span className="block text-[11px] font-bold uppercase tracking-widest mb-1.5" style={{ color: s.textTertiary }}>
              Custom provider
            </span>
            <span className="block text-[12px] font-medium" style={{ color: s.textSecondary }}>
              Any OpenAI-compatible endpoint — the id, kind, and enabled flag are derived server-side; the API key lands in Credential Manager on save, never in this form.
            </span>
          </div>

          <div>
            <label className="block text-[11px] font-bold uppercase tracking-widest mb-1.5" style={{ color: s.textTertiary }}>
              Display name
            </label>
            <input
              type="text"
              aria-label="Display name"
              placeholder="My Gateway"
              className="w-full h-10 rounded-[14px] border-[1.5px] px-4 text-[13px] font-medium outline-none transition-colors"
              style={inputStyle}
              onFocus={(e) => (e.target.style.borderColor = s.inputFocusBorder)}
              onBlur={(e) => (e.target.style.borderColor = s.inputBorder)}
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
            />
          </div>

          <div>
            <label className="block text-[11px] font-bold uppercase tracking-widest mb-1.5" style={{ color: s.textTertiary }}>
              Base URL
            </label>
            <input
              type="text"
              aria-label="Base URL"
              placeholder="https://gateway.example.com/v1"
              className="w-full h-10 rounded-[14px] border-[1.5px] px-4 text-[13px] font-mono outline-none transition-colors"
              style={inputStyle}
              onFocus={(e) => (e.target.style.borderColor = s.inputFocusBorder)}
              onBlur={(e) => (e.target.style.borderColor = s.inputBorder)}
              value={customBaseUrl}
              onChange={(e) => setCustomBaseUrl(e.target.value)}
            />
          </div>

          <div>
            <label className="block text-[11px] font-bold uppercase tracking-widest mb-1.5" style={{ color: s.textTertiary }}>
              API format
            </label>
            <div className="grid grid-cols-3 gap-2">
              {API_FORMATS.map((f) => {
                const active = customApiFormat === f.id;
                return (
                  <button
                    key={f.id}
                    type="button"
                    aria-pressed={active}
                    title={f.hint}
                    className="h-10 rounded-[10px] border-[1.5px] text-[12px] font-bold transition-colors cursor-pointer"
                    style={{
                      borderColor: active ? withAlpha(s.accent, 0.55) : s.border,
                      background: active ? withAlpha(s.accent, 0.09) : s.card,
                      color: active ? s.accent : s.textSecondary,
                    }}
                    onClick={() => setCustomApiFormat(f.id)}
                  >
                    {f.label}
                  </button>
                );
              })}
            </div>
            <p className="mt-1.5 text-[10.5px]" style={{ color: s.textTertiary }}>
              {API_FORMATS.find((f) => f.id === customApiFormat)?.hint}
            </p>
          </div>

          {customError !== null && (
            <p role="alert" className="text-[11.5px] font-medium" style={{ color: "#D64545" }}>
              {customError}
            </p>
          )}

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              disabled={creating}
              onClick={() => { void handleCreateCustom(); }}
              className="h-10 px-5 rounded-full font-bold text-[13px] flex items-center gap-2 cursor-pointer border-[1.5px] hover:scale-[1.03] active:scale-[0.98] transition-transform disabled:cursor-not-allowed disabled:hover:scale-100"
              style={
                creating
                  ? { background: s.subtle, color: s.textTertiary, borderColor: s.border, boxShadow: "none" }
                  : {
                      background: `linear-gradient(135deg, ${s.accent}, ${s.theme.accent2})`,
                      color: s.accentText,
                      borderColor: s.accent,
                      boxShadow: s.bentoShadow,
                    }
              }
            >
              {creating ? "Creating…" : "Create provider"}
            </button>
            <button
              type="button"
              onClick={handleCancelCustom}
              className="h-10 px-4 rounded-full border-[1.5px] font-bold text-[12px] hover:opacity-80 transition-opacity cursor-pointer"
              style={{ background: s.card, borderColor: s.border, color: s.text, boxShadow: s.softShadow }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
