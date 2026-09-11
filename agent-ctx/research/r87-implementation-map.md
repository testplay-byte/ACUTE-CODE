# R87 Research — Consolidated Fix Map (6 parallel sweeps)

Session R87 (owner directive: big UI/UX + capability round). Repo @ 38ffc83 (v0.84.0, post-R86).
All six research sweeps completed 2026-09-11. Full reports inline in session worklog; this file is the implementation map.

## 1. credentials.txt removal (launcher)
- ONLY the Python launcher reads it: `launcher/acute_launcher.py` — `CRED_PATH` :103, `read_credentials()` :457-521, `ensure_subagent_keys()` :524-571, `distribute_key()` :957-1006, `_desktop_seed_keys()` :1863-1886, env seeding :2367-2376, main() read :2478.
- Backend agent-core NEVER reads it (keyring = `ACUTE_PROVIDER_*` env vars, providers/registry.ts:39-48).
- Frontend mentions are copy only: ModelsProvidersTab.tsx:126, SubAgentsTab.tsx:252, McpTab.tsx:577.
- Also: `launcher/credentials.example.txt` (whole file), ACUTE.bat:31-32 + acute.sh:12-13 header comments, launcher/README.md setup section, docs/runbooks (SETUP, SECURITY, MAINTENANCE, AGENT-MEMORY, COMPUTER-USE, LOCAL-PC-RUNNER, PUBLIC-DASHBOARD, SANDBOX-RESTORE), docs/architecture, AGENTS.md, HANDOFF.md, dashboard denylist scripts/dashboard/build-dashboard.mjs:206.
- Keys flow in-app instead: Settings → PUT /providers/:id/key → Tauri keys.rs → Credential Manager.

## 2. NVIDIA phantom-add
- Root cause: `BUILTIN_PROVIDER_SEEDS` (storage/providers.ts:40-56, nvidia :55 seeded R80, no tombstone) inserts nvidia row at EVERY openDatabase unless tombstoned.
- Left list filters keyless presets: ModelsProvidersTab.tsx:319-321 `configuredProviders = providers.filter(p => p.hasKey || !PRESET_PROVIDER_IDS.has(p.id))`.
- AddProviderDialog gets UNFILTERED `existingIds={new Set(providers.map(p => p.id))}` :484-485 → "already added" pill :1530-1542 (disabled).
- FIX: pass configuredProviders-derived existingIds (hasKey-aware) so un-added keyless presets remain addable.

## 3. Settings About tab
- SettingsPage.tsx: TABS :34-56 (9 tabs), render chain :123-135, tab from ?tab= :68-70; Sidebar SETTINGS_SECTIONS :236-259; AdvancedTab pattern :387-412 (max-w-2xl, SectionTitle :347-357, useThemeStyles cards).
- Version: src/lib/version.ts APP_VERSION (__APP_VERSION__ vite-define); backend GET /health → {version} (server.ts:384-388).
- Update check: none in-app today; GitHub api.github.com allows CORS → frontend fetch releases/latest directly.

## 4. Model data shape (storage/models.ts:11-40)
- Today: contextWindow, maxOutputTokens, inputPricePerMtok, inputPriceCachedPerMtok, outputPricePerMtok, supportsThinking, supportsVision (bools), supportsTools/supportsAudio/supportsVideo (tri-state null), hidden, sortOrder.
- NEW (R87): supportsPdf (input), supportsTextOutput (default true), supportsImageOutput, supportsVideoOutput, supportsAudioOutput, sizeLabel (nullable string, e.g. "70B"). Migration 0032.
- UI removes tool-use + reasoning toggles (app auto-detects); input caps: text locked-on + image/video/pdf chips; output caps: text/image/video/audio chips.

## 5. Reset application
- No app-wide reset exists. Must clear: (1) all DB tables (~25, migrations 0001-0031) + reseed, VACUUM; (2) ~/.acute key files + custom-providers.txt + vision-providers.txt + plugins/ (node-safe); (3) Credential Manager targets via Tauri command (keys.rs:27-31,71-110 — agent-core can't); (4) frontend localStorage: acute-code.theme/.config/.settings/.rightSidebar/.projectChat + queryClient.clear(); (5) close live turns first via turn-registry.
- Do NOT touch user project dirs on disk (rows only).
- Route: new routes/system.ts (registerSystemRoutes) — POST /system/reset.

## 6. Models & Providers UI map (ModelsProvidersTab.tsx 3,304L)
- Main :295-496 (left col :368-439 w-280, right :442-480); ProviderListRow :514-577; ProviderDetailPane :585-1387 (header :822-950, connection :952-1296, key pool :1298-1311, ModelListSection :1313-1334, danger :1336-1384).
- AddProviderDialog :1391-1682 (PRESETS :169-223, nvidia :211-222).
- ModelTestButton :1768-1898 (result line wraps below row today; no animation/auto-dismiss).
- ModelListSection :1900-2132 (rows :1990-2101; 3 buttons :2064-2098 h-7 px-2 — Zap/Pencil/Trash, window.confirm :2087).
- AddModelsDialog :2136-2524 (catalog = live GET /providers/:id/models + static GET /models/catalog; click = checkbox toggle :2202-2209; bulk add :2214-2266 fires upsert per id, NO config dialog; manual :2269-2282).
- ModelConfigDialog :2571-3023 (EDIT only — pencil :2071; draft :2530-2569; Toggle :2645-2690, TriStateToggle :2698-2747; capabilities :2839-2881 incl. reasoning+tools to REMOVE; sizing :2887-2917; pricing :2919-2976).
- Onboarding bento recipe: SetupWizard.tsx:47-65 (glows, dot grid), PlugBrainScreen.tsx:34/62-79 (headings, cards rounded-24 border-1.5 softShadow), ConnectionCard.tsx:147-155/298-306/373-405 (inputs, dropdowns, test pill), ActionButton.tsx:48-85 (buttons), themes.ts:372-406 tokens (bentoShadow 4px 4px 0 0 black).
- Queries: ["settings-providers"] :306, ["settings-provider-models"] :638, ["key-pool"] :659, catalog :676-691; mutations deleteModel :1937, addSelected :2214, config save :2587. Fan-out: invalidateProvidersEverywhere :143-147, invalidateModelConfigEverywhere :152-158.

## 7. Browser frontend
- BrowserPanel.tsx 1,492L: native = OS WebView2 child above ALL HTML (overlay-feel root cause; popover-webview-guard.ts:6-12, browser.rs:99); placeholder inset-4px :1444-1450; bounds sync rAF + 500ms poll (:553-579, :738-760). Proxy = sandboxed iframe keyed navSeq :1466-1484 (remounts every nav).
- Viewport default 1280×800 (browser-store.ts:57-63; presets :48-55 incl 1440×900 desktop). FIX: default → 1440×900.
- New-tab hides browser: RightSidebar.tsx:285-309 (QuickMenu open → nativeTabSetVisible(false), R60-D z-order necessity; restore guarded :300-308 — misses when picking another tab; blank-tab null-URL dedupe bug :164-172 / right-sidebar-store.ts:232).
- Tab switch = full unmount/remount (RightSidebar.tsx:590-616 conditional chain) → webview recreate + iframe reload + blank frame. FIX: keep-alive browser panels (render hidden, display:none).
- Right sidebar widths: 360-760 default 460 (right-sidebar-store.ts:122-124); ChatFocusLayout: CHAT_MIN_WIDTH=480 :53 (halve → 240), container query cliff Composer @max-[560px] (sized to 480 floor — needs graduated tiers).
- Scrollbars: index.css:156-188 fixed 10px gutter/4px pill — FIX: clamp() adaptive.

## 8. Agent browser tools
- browser_control (plugins/browser.ts:385-391) has 15 actions; `read` :774-814 (server-side webFetch text); `read_dom` :817-839 + script :289-359 (interactive elements w/ selector + rect w/h but NO x/y — ADD x/y); click :864-884 (selector/text); screenshot :1069-1176 (panel region via screenshot_meta bridge :1094 BUT falls back to FULL DISPLAY :1088-1091, :1122-1125 — REMOVE fallback, fail instead).
- computer-use screenshot = full display by design (computer-use.ts:394-401, backends/windows.ts:1228-1262). NOT in TOOL_NAMES (agents.ts:57-61). Prompts already forbid (prompts.ts:698, :711).
- Bridge: browser-command.ts sendBrowserCommand (eval + screenshot_meta only); stream-store.ts:1281-1288 → agent-browser-bridge.ts:89-114 → BrowserPanel handler :701-735.

## 9. Chat area / composer / selector
- ChatFocusLayout.tsx: CHAT_MIN_WIDTH 480 :53 → 240; content col AgentChatPanel.tsx:135 max-w-[1080px] + :2397 px-5 md:px-10 (raise padding at wide sizes); composer dock :2745-2753.
- Composer.tsx container @max-[560px] cliff (:472, tests :465-505) — add graduated tiers; ModelSelector.tsx:449/:471 max-w-240 truncate (make shrink first).
- ModelSelector flyout: FLYOUT_CLOSE_DELAY_MS 220 :36; openFlyout :250-266 instant re-target (the diagonal-path bug); computeFlyoutGeometry composer-utils.ts:313-340. FIX: trajectory intent + safe corridor; add frosted-glass backdrop when open.
- Sidebar.tsx: rail project tiles :663 click → navigate only (ADD setAppSidebarMinimized(false)); ProjectRow :1006 onToggle only. SETTINGS_SECTIONS :236-259.
- TodoPanel exists: project-chat/panels/TodoPanel.tsx (LeftSidebar — NOT visible in ChatFocusLayout default mode!); todo.update events persisted; WorkingEntry union api.ts:1222-1272; fold toProjectChatItems api.ts:1401+; render AgentChatPanel :1389-1437 + WorkingSection.

## 10. Agent runtime (for ask_user tool)
- Tool pattern: plugins/todo.ts (52L shape); registry.ts BUILT_IN_PLUGINS :110-135; TOOL_NAMES storage/agents.ts:17-77 (26) + TOOL_CATALOG api.ts:49-92 + drift test tool-catalog-drift.test.ts.
- Interactive template: browser-checkpoint.ts:193-263 (emit frame → pending map → POST /browser-checkpoints/:id/resolve :477-501 → resolved frame). Approvals pattern: approvals.ts:544-691 (DB row + 120s timeout + resolvePendingApproval).
- StreamTurnEvent union api.ts:2944-3227 (37 members); handleStreamEvent stream-store.ts:1229-1915 (42 comparisons); persistence via appendSessionEvent (any type string, sessions.ts:1107); replay assembleHistory reads only message.*/tool.use (unknown types skipped — harmless).
- ask_user design: questions[] {question, options?[], allowCustom?, placeholder?}; SSE `agent-question` + `agent-question.resolved`; route POST /agent-questions/:id/resolve; session events agent-question.requested/resolved; WorkingEntry "question" card; gate on interactiveApprovals; timeout 10 min; fail-closed without emit channel.
- TODO visibility: render todo.update as a checklist card in WorkingSection (live + folded).

## Implementation order (backend-first, then frontend, then docs/release)
1. Baseline: pnpm install + full suite green
2. Migration 0032 + storage/models.ts + routes validation (new capability fields)
3. routes/system.ts: POST /system/reset (+ turn shutdown + ~/.acute purge + reseed + VACUUM)
4. ask_user plugin + bridge + resolve route + SSE events + session events
5. browser.ts: read_dom x/y + screenshot fallback removal
6. Launcher: credentials.txt removal (+ docs/copy)
7. Frontend: About tab, reset flow, models/providers redesign, dialogs, test button, browser embedding (1440×900 + keep-alive + menu placeholder + restore fixes), scrollbars, chat widths, composer tiers, selector hover+glass, sidebar expand, question/todo cards
8. Tests: update/add; full pipeline verify
9. Docs + version 0.85.0 + release + dashboard + final notification
