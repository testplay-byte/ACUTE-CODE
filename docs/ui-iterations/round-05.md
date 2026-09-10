<!-- last-reviewed: 2026-09-10 round-83 -->
# Round 05 — Button polish + PlugBrain full pass + live-key verification (2026-08-22)

Owner go-ahead: "continue and handle all three of the things properly…
without confirming after each one."

## 1. Primary-button polish ("dialed out" Continue)

New shared `src/components/onboarding/ActionButton.tsx` used by PickFlavor,
NeedBrain, and ModelSummary:

- Primary: subtle `accent → accent2` gradient fill, heavier label weight,
  bolder hover scale, and the `↵` hint restyled as a **key-cap chip**
  (bordered, mono) instead of 60%-opacity text. Disabled state keeps the
  quiet subtle fill.
- Secondary (Back): unchanged quiet card pill.

## 2. Plug in your brain — full pass

- **Padding**: step-3 wrapper now uses `WIZARD_EDGE` horizontal padding +
  centered `WIZARD_CONTAINER` (previously NONE); bottom padding added to the
  screen root.
- **Right rail width**: `clamp(360px, 30vw, 540px)` (was 320–430px).
- **Key-gated model search**: the models query is enabled only when
  `providerId` is set **and** an API key has been entered
  (`apiKey.length > 6`) — matching the owner's directive that searching
  starts only after the key is in. Dropdown empty state explains this
  ("Enter your API key above to load this provider's model list.").
- **Steppers hover-reveal**: NumberField's ▲/▼ buttons are hidden until the
  field is hovered or focused (like native browser spinners).
- **Context window AUTO vs MANUAL**: AUTO → preset chips only; MANUAL → the
  exact-token NumberField only. The modes are now genuinely different.

## 3. Live verification with the owner's OpenRouter key

Method (no secrets in repo/logs — key lives only in Windows Credential
Manager under `ACUTE-CODE/provider/openrouter`):

1. `scripts/credential.ps1 Write` stores the owner-provided key.
2. Sidecar booted: `node agent-core/dist/main.js` with `ACUTE_TOKEN`,
   `ACUTE_DB_PATH` (temp), `ACUTE_PROVIDER_OPENROUTER` read from Credential
   Manager into env (never echoed; length-only logging).
3. Vite dev server restarted with `VITE_ACUTE_BASE_URL=http://127.0.0.1:<port>`
   + `VITE_ACUTE_TOKEN` so the browser UI talks to the real sidecar
   (`src/lib/config-store.ts` dev fallback path).
4. Results, all observed live:
   - API level: `GET /providers` → openrouter `hasKey:true`;
     `GET /providers/openrouter/models` → real catalog incl.
     `stealth/ox-alpha` ("Ox Alpha"); `POST /providers/openrouter/test` →
     `{"ok":true,"latencyMs":58,"model":"stealth/ox-alpha"}`.
   - UI level (browser against the wired dev server): dropdown shows the
     gated "Enter your API key above…" state before any key; typing the key
     fires the fetch; the real catalog then renders in the dropdown
     (verified with `stealth/ox-alpha` selected + 1M ctx tag, Auto enabled).

### Real bugs found & fixed during this verification

1. **Disabled-query state bug**: a disabled TanStack query stays `isPending`
   forever, so the gated dropdown rendered "Loading models…" instead of the
   enter-your-key state. Switched the dropdown's states to
   `isFetching`-based conditions (ConnectionCard).
2. **Sidecar had no CORS headers**: the Tauri webview origin never surfaced
   it, but the dev vite origin (localhost:5173) got "Failed to fetch" on
   every call. Added a strict loopback/webview origin allowlist hook in
   `agent-core/src/server.ts` (preflight 204 + ACAO headers; hand-rolled,
   no new dependency).
3. **config-store ignored env overrides**: persisted localStorage
   (`acute-code.config`) from earlier sessions overrode explicit
   `VITE_ACUTE_BASE_URL`/`VITE_ACUTE_TOKEN` wiring. The persist `merge` now
   lets explicit env vars win and disables demo data when a base URL is
   provided.

**Status: awaiting owner review of the PlugBrain screen + Continue button.**
