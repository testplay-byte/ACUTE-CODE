'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useOnboardingStore } from '@/lib/onboarding-store';
import { PROVIDERS } from '@/lib/onboarding-types';
import { useThemeStyles } from '@/lib/use-theme-styles';

export default function ProviderSelector() {
  const s = useThemeStyles();
  const providerId = useOnboardingStore((st) => st.providerId);
  const setProvider = useOnboardingStore((st) => st.setProvider);
  const setBaseUrl = useOnboardingStore((st) => st.setBaseUrl);
  const setModelId = useOnboardingStore((st) => st.setModelId);

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const provider = useMemo(() => PROVIDERS.find((p) => p.id === providerId), [providerId]);

  const filtered = useMemo(() => {
    if (!search.trim()) return PROVIDERS;
    const q = search.toLowerCase();
    return PROVIDERS.filter((p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q) || p.baseUrl.toLowerCase().includes(q));
  }, [search]);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch('');
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  const handleSelect = useCallback((p: (typeof PROVIDERS)[number]) => {
    setProvider(p.id);
    setBaseUrl(p.baseUrl);
    if (p.models.length > 0) setModelId(p.models[0]);
    setOpen(false);
    setSearch('');
  }, [setProvider, setBaseUrl, setModelId]);

  const handleTriggerClick = () => {
    if (open) {
      setOpen(false);
      setSearch('');
    } else {
      setOpen(true);
      setSearch('');
    }
  };

  const displayValue = open ? search : (provider?.name ?? 'Select provider');

  return (
    <div ref={containerRef} className="relative mt-4">
      <div
        className="h-[56px] rounded-[16px] border-[1.5px] flex items-center gap-3 px-4 transition-colors"
        style={{ background: s.card, borderColor: open ? s.borderStrong : s.border, boxShadow: open ? s.bentoShadowSm : 'none' }}
      >
        {provider && (
          <span className="w-9 h-9 rounded-full grid place-items-center text-[13px] font-bold shrink-0" style={{ background: s.accent, color: s.accentText }}>
            {provider.letter}
          </span>
        )}
        <input
          ref={inputRef}
          type="text"
          className="flex-1 bg-transparent outline-none text-[14px] font-medium"
          style={{ color: s.text }}
          placeholder="Search providers..."
          value={displayValue}
          onChange={(e) => setSearch(e.target.value)}
          onFocus={() => { if (!open) { setOpen(true); setSearch(''); } }}
        />
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className={`shrink-0 transition-transform cursor-pointer ${open ? 'rotate-180' : ''}`} style={{ color: s.textSecondary }} onClick={handleTriggerClick}>
          <path d="M4 6L8 10L12 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      {open && (
        <div className="absolute z-20 top-[64px] left-0 right-0 rounded-[16px] border-[1.5px] p-1.5 max-h-[320px] overflow-y-auto animate-slideDown" style={{ background: s.card, borderColor: s.borderStrong, boxShadow: s.bentoShadow }}>
          {filtered.length === 0 && (
            <div className="py-6 text-center text-[13px] font-medium" style={{ color: s.textTertiary }}>No providers found</div>
          )}
          {filtered.map((p) => {
            const isSelected = p.id === providerId;
            return (
              <button
                key={p.id}
                type="button"
                className="h-[48px] rounded-[14px] flex items-center gap-3 px-3 cursor-pointer transition-colors w-full text-left"
                style={{ background: isSelected ? s.subtleHover : 'transparent' }}
                onClick={() => handleSelect(p)}
                onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = s.subtle; }}
                onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
              >
                <span className="w-9 h-9 rounded-full grid place-items-center text-[13px] font-bold shrink-0" style={{ background: s.pillBg, color: s.pillText }}>
                  {p.letter}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[13px] font-bold truncate" style={{ color: s.text }}>{p.name}</span>
                  <span className="block text-[11px] truncate" style={{ color: s.textTertiary }}>{p.baseUrl}</span>
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
