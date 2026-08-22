'use client';

import { useCallback, useMemo, useRef, useEffect, useState } from 'react';
import { useOnboardingStore } from '@/lib/onboarding-store';
import { PROVIDERS } from '@/lib/onboarding-types';
import { useThemeStyles } from '@/lib/use-theme-styles';

export default function ConnectionCard() {
  const s = useThemeStyles();
  const store = useOnboardingStore();

  const provider = useMemo(
    () => PROVIDERS.find((p) => p.id === store.providerId),
    [store.providerId],
  );

  const [modelOpen, setModelOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const modelRef = useRef<HTMLDivElement>(null);

  // Close model dropdown on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) {
        setModelOpen(false);
        setModelSearch('');
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const filteredModels = useMemo(() => {
    if (!provider) return [];
    if (!modelSearch.trim()) return provider.models;
    const q = modelSearch.toLowerCase();
    return provider.models.filter((m) => m.toLowerCase().includes(q));
  }, [provider, modelSearch]);

  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) store.setApiKey(text);
    } catch {
      /* clipboard not available */
    }
  }, [store]);

  const handleAutoDetect = useCallback(() => {
    if (provider && provider.models.length > 0) {
      store.setModelId(provider.models[0]);
    }
  }, [provider, store]);

  return (
    <div
      className="rounded-[24px] border-[1.5px] p-4 md:p-5"
      style={{
        background: s.card,
        borderColor: s.border,
        boxShadow: s.softShadow,
      }}
    >
      <div className="flex items-center justify-between">
        <span className="font-bold tracking-tight" style={{ color: s.text }}>Connection</span>
        <span
          className="text-[10px] font-bold px-2 py-1 rounded-full border"
          style={{
            backgroundColor: s.accent,
            color: s.accentText,
            borderColor: s.accent,
          }}
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
              style={{
                background: s.inputBg,
                borderColor: s.inputBorder,
                color: s.text,
              }}
              onFocus={(e) => (e.target.style.borderColor = s.inputFocusBorder)}
              onBlur={(e) => (e.target.style.borderColor = s.inputBorder)}
              placeholder="https://api.openai.com/v1"
              value={store.baseUrl}
              onChange={(e) => store.setBaseUrl(e.target.value)}
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
              type={store.showApiKey ? 'text' : 'password'}
              className="w-full h-12 rounded-[14px] border-[1.5px] px-4 pr-[132px] text-[13px] font-mono outline-none transition-colors"
              style={{
                background: s.inputBg,
                borderColor: s.inputBorder,
                color: s.text,
              }}
              onFocus={(e) => (e.target.style.borderColor = s.inputFocusBorder)}
              onBlur={(e) => (e.target.style.borderColor = s.inputBorder)}
              placeholder="sk-..."
              value={store.apiKey}
              onChange={(e) => store.setApiKey(e.target.value)}
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
                className="h-9 px-3 rounded-[10px] text-[11px] font-bold cursor-pointer transition-colors"
                style={{
                  background: s.pillBg,
                  color: s.pillText,
                }}
                onClick={store.toggleShowApiKey}
              >
                {store.showApiKey ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>
        </div>

        {/* Model ID */}
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
              className="w-full h-12 rounded-[14px] border-[1.5px] px-4 pr-[120px] text-[13px] font-mono outline-none transition-colors"
              style={{
                background: s.inputBg,
                borderColor: modelOpen ? s.borderStrong : s.inputBorder,
                color: s.text,
              }}
              onFocus={() => {
                setModelOpen(true);
                setModelSearch('');
              }}
              placeholder="e.g. gpt-4o"
              value={modelOpen ? modelSearch : store.modelId}
              onChange={(e) => setModelSearch(e.target.value)}
            />
            <button
              type="button"
              className="absolute right-1.5 top-1.5 bottom-1.5 px-3 rounded-[10px] border-[1.5px] text-[11px] font-bold flex items-center gap-1 cursor-pointer transition-colors"
              style={{
                background: s.card,
                borderColor: s.borderStrong,
                color: s.text,
              }}
              onClick={handleAutoDetect}
            >
              ◍ Auto-detect
            </button>

            {/* Model dropdown */}
            {modelOpen && filteredModels.length > 0 && (
              <div
                className="absolute z-20 top-[56px] left-0 right-0 rounded-[16px] border-[1.5px] p-1.5 animate-slideDown"
                style={{
                  background: s.card,
                  borderColor: s.borderStrong,
                  boxShadow: s.bentoShadow,
                }}
              >
                {filteredModels.map((m) => (
                  <button
                    key={m}
                    type="button"
                    className="h-[42px] w-full rounded-[14px] flex items-center gap-2 px-3 cursor-pointer transition-colors text-left text-[13px] font-mono"
                    style={{
                      background: m === store.modelId ? s.subtleHover : 'transparent',
                      color: s.text,
                    }}
                    onClick={() => {
                      store.setModelId(m);
                      setModelOpen(false);
                      setModelSearch('');
                    }}
                    onMouseEnter={(e) => {
                      if (m !== store.modelId) e.currentTarget.style.background = s.subtle;
                    }}
                    onMouseLeave={(e) => {
                      if (m !== store.modelId) e.currentTarget.style.background = 'transparent';
                    }}
                  >
                    {m}
                    {m === store.modelId && (
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="ml-auto shrink-0">
                        <path d="M3 8.5L6.5 12L13 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
