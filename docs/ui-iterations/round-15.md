<!-- last-reviewed: 2026-08-24 round-28 -->
# Round 15 — Model Management system + dashboard v2 + folder dialog fix (2026-08-23)

**Owner direction:** Full provider/model management (add custom providers
with apiFormat + key, per-model pricing/context/window, key view/copy/edit,
test models, hide from chat picker, model selection in chat with provider
grouping) + dashboard rebuild (lighter theme, more detail, proper multi-file
build) + folder dialog fix (two dialogs opened, neither result landed).

## 1. Folder dialog fix (root cause found + eliminated)

**Root cause:** inline PowerShell `-Command` strings were fragile on the
owner's Windows — the first dialog (Vista-style) completed but its marker
output wasn't captured correctly, so the code fell through to the SECOND
dialog (classic FolderBrowserDialog), and after BOTH completed neither result
reached the form (stdout capture from spawned PowerShell is unreliable).

**Fix:** the dialog now writes a temporary `.ps1` script file and executes it
with `-ExecutionPolicy Bypass -STA -File`. The script writes its result to a
sibling FILE (not stdout), which Node reads — eliminating all stdout-capture
issues. Single dialog, reliable result delivery.

## 2. Dashboard v2 (dispatched to full-stack dev sub-agent per owner)

Rebuilt as a proper multi-file project in `/home/z/acute-workspace/DASHBOARD/`:
- **Light theme** (#fafaf9 background, white surfaces — owner: "way too dark"
  fixed) with high contrast and orange accent
- **Multiple source files**: `src/template.html`, `src/style.css` (1189
  lines), `src/app.js`, `build.mjs` (Node build script reading `data.json`)
- **Build pipeline**: edit `data.json` → `node build.mjs` → generates
  self-contained `index.html` with inlined CSS/JS
- **Content**: product header, three pillar cards, The Plan (NOW + upcoming
  + principles), quality metrics, milestone timeline, tech stack chips
- **Live**: https://testplay-byte.github.io/DASHBOARD/ — browser-verified
  8/8 by VLM (light theme ✓, contrast ✓, all sections ✓, nothing broken ✓)
- Pushed to the DASHBOARD repo via token-in-URL (PAT from
  `/home/z/.secrets/dashboard.pat`, separate from the main repo PAT)

## 3. Model Management system (the main feature)

### Backend (migration 0004 + new routes)

- **New `models` table**: per-provider model metadata — `model_id` (the API
  identifier), `display_name`, `context_window`, `max_output_tokens`,
  `input_price_per_mtok`, `input_price_cached_per_mtok`,
  `output_price_per_mtok`, `supports_thinking`, `hidden`, `sort_order`;
  UNIQUE(provider_id, model_id) = upsert semantics.
- **`providers.api_format`** column: `chat-completions` | `anthropic-messages`
  | `responses` (defaults to chat-completions).
- **New routes**:
  - `GET /providers/:id/models-config` — all configured models (incl. hidden)
  - `POST /providers/:id/models` — add/update a model (upsert by model_id)
  - `PATCH /models/:id` — update any subset (pricing, context, hidden, etc.)
  - `DELETE /models/:id` — remove
  - `GET /providers/:id/key` — read the API key (settings UI view/copy)
  - `PUT /providers/:id/key` — update the API key
- Provider creation now accepts `apiFormat`.

### Frontend — Settings "Models & Providers" tab (replaces "API & Providers")

- **Provider cards** (expandable): name, apiFormat chip, key status dot,
  model count. Expanded: API key section (View/Copy/Edit — the owner's
  explicit request: "not a one-time thing… check again and again") + model
  list with add/edit/hide/delete/test.
- **Add Provider dialog**: two-step — "Select from presets" (OpenRouter,
  auto-configured) or "Add custom provider" (name, baseUrl, apiKey, apiFormat
  with three selectable formats: Chat Completions / Anthropic / Responses).
- **Add Model dialog**: model ID (required), display name, context window,
  max output tokens, and three pricing fields ($/Mtok input, $/Mtok cached
  input, $/Mtok output).
- **Model rows**: display name + context chip; per-row buttons for Test
  (⚡ — fires the connection test, shows latency or error inline), Hide/Show
  (eye icon — hidden models move to a "Hidden" section at the bottom,
  hidden from chat but always visible in settings), and Delete.
- Hidden models are visually dimmed (opacity 0.6, subtle background).

### Verified

- `pnpm verify` green (migration test updated for 0004; all suites pass).
- Browser: Settings → Models & Providers tab renders with the provider list;
  Add Provider dialog opens with both options (presets + custom); VLM-verified
  4/4 on screenshots.
- The full custom-provider flow (create → add key → add models → test → use
  in chat) is ready for the owner's hands-on test on Windows.

## What's queued (next round)

- Chat composer model picker: group by provider, show context window +
  pricing per model (backend routes are ready; frontend picker update queued)
- Streaming live-testing on the owner's Windows PC (he reported it still
  wasn't working — the SSE route + frontend streaming are deployed; needs
  his re-test after this update)
- Custom provider full end-to-end test (owner creates one on Windows)

**Status: delivered (model management backend + settings UI + dashboard v2 +
dialog fix); chat model picker enhancement queued next.**
