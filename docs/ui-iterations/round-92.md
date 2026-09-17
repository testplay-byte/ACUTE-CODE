<!-- last-reviewed: 2026-09-17 round-100 -->
<!-- stamp refresh 2026-09-14 round-96: paths + links re-verified by docs:check; content unchanged — the R92 record is historical -->
# Round 92 — the fourth-walkthrough round (v0.90.0)

The owner's fourth end-to-end walkthrough of v0.89.0 confirmed the R91 wins
(the OpenRouter force-delete works, the model card renders exactly as
specified, the browser renders with menus on top) and filed this round's
list. Every item below is the direct answer to a filed verdict, in the
owner's order.

## 1. The verdicts this round answers

| Verdict (the owner's words, compressed) | Where it landed |
|---|---|
| "When I tapped on any of the options (the model option selection, plan mode, full access, ask mode), the right-side browser window would get cleared out and disappear" / "I still don't feel like the browser is an embedded part of the application itself" | §2 |
| "After adding another provider and selecting the new provider and the new model… still showing the same exact issue: 'Generation failed: agent acute has no provider ID/model configured.'" | §3 |
| "I tried to edit the models but the agents were not editable" | §4 |
| "Completely remove the separate API keys for the subagents… the user can add more than one API key for a specific provider. Those API keys will be juggled between each other. If one fails, automatically try the next key in line" / "These API keys will be used for the subagents too" / "The subagents' settings will stay there but the only change will be the subagent model selection" | §5 |

## 2. The browser as part of the application (the "overlay" verdict, third and final)

The confirmed-good parts (the R90-C2/R91 overlay window for the sidebar's
menus, the watchdog, the async commands) stay untouched. The new failures
were the COMPOSER's selector family — never migrated to the overlay window:

- **The ModelSelector scrim** — a `fixed inset-0` dim layer covering the
  whole viewport — matched the webview guard's `.fixed.inset-0` selector, so
  every model-picker open recorded a full-viewport covering rect and hid
  the native webview with NO caption (the caption only ever rendered on
  the sidebar-popover fallback leg). The browser "got cleared out."
- **The mode/thinking/add-context dropdowns** (`w-64` anchored at the
  composer's left) genuinely cross into the browser panel at the owner's
  squeezed geometry (the chat column at its 240px floor beside a wide
  sidebar) — a real geometric hide, again captionless.
- Two latent guard hazards made it worse: an unmeasurable (0×0) overlay was
  conservatively recorded as the FULL viewport, and rects only refreshed on
  structural DOM mutations — a stale covering rect could pin the browser
  hidden forever (the R91 watchdog deliberately skips while covered).

**The R92 contract**:

1. **The composer's three simple menus now ride the menu-overlay window**
   (`useNativeOptionsMenu` — the R90-C2 RightSidebar ladder generalized).
   Inside the Tauri shell the mode/thinking/add-context menus open in the
   owned transparent OS window above the browser; the DOM dropdown is the
   web/e2e/command-failure fallback, byte-identical to before. While the
   overlay is up the DOM duplicate does not render at all.
2. **Pure backdrops are exempt from the guard** (`data-webview-backdrop`):
   a translucent dim renders BELOW the OS webview — it can never visually
   cover the browser, so it must never hide it. The ModelSelector scrim and
   every pure dim layer are tagged; dialog CONTENT panels still hide the
   webview when they truly cover it (DOM cannot paint above it).
3. **The guard self-heals**: unmeasurable overlays are skipped with a
   3-frame rAF retry (the full-viewport fallback deleted); a 600ms periodic
   re-sweep runs while anything is open; identical sweeps don't re-render
   the panels; the watchdog forces a fresh sweep before its geometric skip.
4. **Caption honesty**: the "browser paused while the menu is open" caption
   now renders on BOTH hide legs — any residual hide reads as a deliberate
   pause, never a blank cleared-out card.

## 3. The "no provider ID/model configured" dead end (closed at both ends)

The chain: R91-A's force-delete resets referencing agents to
`provider_id = NULL, model = NULL` (the owner's own OpenRouter delete test
did this to the seeded "Acute"). `prepareTurn`'s null gate then ran BEFORE
the per-send `{model, providerId}` override was consulted — a send carrying
a perfectly valid pair could never satisfy it. And the chat picker only
wrote localStorage, so no UI path could ever re-arm the agent row. Dead end.

**The R92 contract**:

- **The override-first gate**: `prepareTurn` normalizes the send's override
  FIRST and 409s only when the EFFECTIVE pair is incomplete. A send
  carrying `{model, providerId}` works on an unconfigured agent — the
  exact scenario from the walkthrough. The context meter + compact routes
  mirror the gate with their existing query params.
- **The picker's self-heal**: when the session's agent is unconfigured, the
  first chat pick PATCHes the agent row itself (the wizard's precedent) —
  the agent arms permanently, the Agents screen shows the real pair, and
  the 409 cannot re-appear. Configured agents keep the per-send override
  semantics exactly.

## 4. Editable agents (the render crash)

Every seeded template carries `providerId/model = NULL` — and the Agents
form copied that null into a `string`-typed field, then called
`.trim()` on it during render. The app-level ErrorBoundary replaced the
screen: "the agents were not editable."

**The R92 contract**: the form is null-safe end to end (null ↔ the empty
form), the model/provider fields are optional with the "leave empty to pick
the model in chat" hint, the provider select gains a "— none —" option, and
`PATCH /agents/:id` gains explicit-null semantics (undefined = keep, null
= set NULL). The shared `AgentRecord` type now tells the backend's truth
(`string | null`) with the compile fallout handled honestly — the next
null-handling miss is a typecheck error, not a runtime crash. A "Blank
Slate" NULL/NULL template fixture covers every fixture-driven surface.

## 5. THE MULTI-KEY POOL with automatic juggling (the headline)

The owner's spec, verbatim: sub-agents do NOT have separate keys; the user
adds more than one API key per provider; the keys are juggled — one fails,
the next is tried; the same keys serve the sub-agents; the sub-agent
settings keep the model selection + options.

**The four halves:**

- **The engine** (`runtime.ts`, both turn runners): the provider's DEDUPED
  key pool (slot 0 = primary, then `_SLOT<N>`; same-value slots collapse)
  resolves in `prepareTurn` — a turn is keyless only when the pool is
  EMPTY. On a key-attributable failure — **auth** (the key was rejected)
  or **rate_limit** (that key's quota is spent) — with an UNTRIED key
  left, the runner swaps the key and retries the SAME call IMMEDIATELY (no
  ladder wait; a fresh key has fresh quota). The streamed runner flushes
  the in-flight partial segment first. Pool exhausted on rate-limit hands
  to the existing R75 ladder from the original key; exhausted on auth it
  fails fast. Usage rows always attribute to the key actually serving the
  attempt. A `meta.key` SSE frame (indexes + reason, never key values)
  renders in the live chat as "switching to API key 2 of 3…".
- **The shell** (`keys.rs`): `store_provider_key_slot` /
  `remove_provider_key_slot` (slots 1–31) write the OS secure store at the
  generalized `<id>-slot<N>` targets, ride a `~/.acute/provider-pool-slots.txt`
  note file (ids + slot numbers, never secrets) so EVERY provider's pool
  keys survive restarts (previously only the launcher-seeded openrouter
  2/3/4 did), and hot-handoff the running sidecar (the internal route now
  takes the slot). **This also fixes the R47 bug**: the old Tauri add-slot
  invoked the slot-less store and silently OVERWROTE the primary key.
- **The UI** (Models & Providers): the primary editor + the old pool
  section are ONE "API keys" card — Key 1 (primary) then Key 2..N as
  ordinals, masked with reveal/copy, per-key test, the 31-key cap with the
  honest "pool is full" note, and the juggling contract stated plainly.
  The provider rows carry the key-count chip. Add-key always targets the
  first free slot ≥ 1 (a gap is filled; a held slot is never overwritten).
- **The sub-agents tab**: the separate "Sub-agent OpenRouter keys"
  paste-slot card is DELETED. In its place, the informational note + the
  deep link — keys live in exactly ONE place. The model picker
  (inherit / catalog / your configured models), the parallelism card, and
  the supervision card stay unchanged. The orchestrator no longer builds
  single-key child views: children receive the parent's full keyring and
  start from their reserved slot's key (load-spreading), juggling on
  failure exactly like the main agent.

## 6. The verification table

| Gate | Result |
|---|---|
| `pnpm lint` | clean |
| `pnpm typecheck` (root) + agent-core `tsc --noEmit` | clean |
| `pnpm test` | **2,953 / 2,953** (165 files) |
| `pnpm test:e2e` | 12 / 12 |
| `pnpm build` | green (4 pages + menu-overlay/popout/mini entries) |
| `pnpm license:audit` | 134 production dependencies, clean |
| `cargo check --target x86_64-pc-windows-msvc` | green |
| `pnpm docs:check` | 197 docs, 0 failures, 0 warnings |
| GitHub CI (run 34659188740) | **SUCCESS on the first try** |
| Release (run 34659190170) | **SUCCESS** — v0.90.0 PUBLISHED (release 387395517, latest, zero drafts; ACUTE-CODE_0.90.0_x64-setup.exe 37,550,238 B sha256 59bba825… + acute-launcher-kit-v0.90.0.zip 105,863 B sha256 7e03fcc2…) |

## 7. Files this round

- Browser: `src/components/project-chat/composer/{ModeSwitcher,ThinkingLevelButton,AddContextButton,ModelSelector,Composer,composer-utils,useNativeOptionsMenu}.tsx/ts`,
  `src/components/right-sidebar/{popover-webview-guard,BrowserPanel,RightSidebar}.tsx`,
  `src/lib/menu-overlay.ts`, `src/menu-overlay/MenuOverlayApp.tsx`, `src/components/ui/dialog.tsx`.
- Resolution/editing: `agent-core/src/agents/runtime.ts`, `agent-core/src/routes/sessions.ts`,
  `agent-core/src/storage/agents.ts`, `shared/src/index.ts`,
  `src/components/agents/*`, `src/components/project-chat/AgentChatPanel.tsx`.
- Key pool: `agent-core/src/{agents/{runtime,orchestrator},providers/registry,routes/providers,server}.ts`,
  `src-tauri/src/{keys,lib}.rs`, `src/components/settings/{ModelsProvidersTab,SubAgentsTab}.tsx`,
  `src/lib/{api,key-pool,stream-store}.ts`, `src/components/onboarding/providers-api.ts`.
- Tests: `agent-core/tests/r92-{override-gate,key-pool}.test.ts` (new) + the re-pinned
  r43/r82/providers/sessions/orchestrator suites; frontend — the guard, BrowserPanel,
  Composer, useNativeOptionsMenu (new), AgentsScreen edit flow, AgentFormDialog NULL-model,
  stream-store meta.key, SubAgentsTab note contract, ModelsProvidersTab ProviderKeysCard
  (incl. the R47-fix pins), key-pool floor.

## 8. Test checklist for the owner (the fourth walkthrough, v0.90.0)

1. **The browser while chatting**: open a browser tab in the right sidebar,
   then tap the model selector, the mode pill (plan / full access / ask),
   the thinking-level pill, and the add-context pill. The browser must
   STAY LIVE — the model picker's dim no longer clears it, and the mode /
   thinking / context menus float ON TOP of it (the same overlay the
   sidebar's + menu uses). Any menu that would ever cover the browser
   shows the honest "paused" caption instead of a blank.
2. **The generation dead end**: delete a provider that the default agent
   uses (the R91 reset flow), add a NEW provider, pick its model in the
   chat, send a task — the turn must run (the pick also arms the agent
   row: Settings → Agents shows the pair).
3. **Agents editing**: Settings → Agents → Edit on any template (e.g.
   "Blank Slate") — the dialog opens, the model/provider fields may stay
   empty ("pick the model in chat"), and Save works.
4. **The key pool**: Models & Providers → a provider → the "API keys"
   card: add Key 2, Key 3 (each lands as its own row, masked, reveal/copy
   + test). Restart the app — the keys survive. Remove one — it's gone.
   Adding a key never touches Key 1.
5. **The juggling**: send a task; if a key hits a rate limit or is
   rejected, the chat shows "switching to API key 2 of 3…" and the turn
   continues on the next key without waiting.
6. **Sub-agents**: Settings → Sub-agents — the keys card is now the note
   with the "Manage keys" link; the model picker, parallelism, and
   supervision cards work as before. A delegated sub-agent uses the same
   pool (Usage rows attribute per key).
