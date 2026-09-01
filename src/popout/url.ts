/**
 * ROUND-59 (R59-b) — the URL-or-search heuristic for the pop-out address bar.
 *
 * The same decision chain as the BrowserPanel's `normalizeUrl`
 * (src/components/right-sidebar/BrowserPanel.tsx): explicit http(s) passes
 * through, any other scheme-with-`://` passes through, a bare domain gets
 * `https://` prefixed, everything else becomes a DuckDuckGo search. Re
 * -implemented here rather than imported because the pop-out is a STANDALONE
 * vite entry — importing the panel component would drag its whole dependency
 * tree into the pop-out's bundle; the chain is five lines and pinned
 * character-for-character by popout.test.tsx, so the two can't drift.
 */

/** Normalize a raw address-bar input into the URL to navigate. "" → no-op. */
export function normalizeAddressInput(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  // Looks like a domain (has a dot, no spaces)?
  if (/^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(trimmed)) return `https://${trimmed}`;
  // Otherwise treat as a search query.
  return `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`;
}
