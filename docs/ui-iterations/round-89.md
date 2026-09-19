<!-- last-reviewed: 2026-09-19 round-108 -->
# Round 89 — The owner's hands-on verdict round: About/Reset, provider identity, model UI, layout honesty, and the agent's HUMAN browser hands

Date: 2026-09-11 · Version: 0.86.0 → 0.87.0 · Scope: UX + capability (the
owner's full app walkthrough verdicts — 30+ items)

## 0. The owner's directive (verbatim → implementation map)

The owner ran v0.86.0 end-to-end and reported, in order:

| # | Verdict (condensed, faithful) | Fix |
|---|---|---|
| 1 | Check-for-updates says "HTTP 404" — the repo is PRIVATE, the browser fetch has no token | `GET /system/updates` in agent-core reads the launcher's saved `~/.acute/github.pat` and queries GitHub server-side; the frontend calls the sidecar |
| 2 | The Releases button did nothing | `open_external_url` (the R58-b Rust command) inside Tauri; `window.open` fallback on the web |
| 3 | After "Reset everything" the app restarted on the DASHBOARD, not the setup wizard — even after a full close+reopen | The reset list missed `acute.setupDone` (the first-run gate key). It is now cleared with the rest |
| 4 | Add Provider asked for the API format for NVIDIA — it should be preset | Presets hide the API-format field entirely (it rides the preset); only custom providers pick it |
| 5 | "provider NVIDIA already exists" on a FRESH reset — and OpenRouter too | Root cause: `reseedFactoryData` re-seeds the 5 built-in rows; the R58 list hides keyless presets so they LOOK absent, but the POST 409s on the seeded id. Fix: name-keyed uniqueness + preset ADOPTION (a keyless built-in is configured in place) + auto-unique ids for same-type adds |
| 6 | "the user can add as many providers as needed… only the provider name should be different" | Name is the uniqueness key (409 field `body.name`); ids auto-suffix (`openrouter-2`…) for same-type adds |
| 7 | Add Model list shows the full model ID twice (title + subtitle) and a "Configure" label | Title = the clean model NAME (last ID segment, humanized); subtitle = the full ID; the Configure chip is gone |
| 8 | The Add-Model default display name was the full model ID | Default = the last ID segment (humanized) |
| 9 | Input/output capability toggles could be cleaner | Distinct theme colors + SVG icons per capability (text/image/video/pdf/audio in; text/image/video/audio out) |
| 10 | "Price not set" / "1 million context" summary is unformatted | `1M` / `100K`-style token formatting everywhere (also the add-model summary) |
| 11 | The models list tags ("image input"…) should be colored SVG icons | Capability icon chips (colored) replace text tags; details reorganized into dedicated sections (context / input price / output price / cache read / capabilities; left/right separation) |
| 12 | Test-model result "took too much space, ugly, layout broke" | The model card EXPANDS: top stays; results render in a dedicated section below the card (response time, tokens, the full reply behind Show reply) |
| 13 | Chat area lists providers never added (Anthropic…) that then say "no models configured" | The picker filters to `hasKey` providers only — the seeded keyless presets are gone from chat |
| 14 | GLM 5.2 was selected by default via OpenRouter | The last-used model is persisted globally and becomes the default for new chats |
| 15 | Shrinking the chat breaks the UI; padding must reduce; model name must collapse to logo-only; the message area overflows at min | Composer/pill @container tiers hardened; logo-only collapse tier; padding tiers |
| 16 | With the left sidebar HIDDEN the chat could NOT shrink as much as before | `RIGHT_SIDEBAR_MAX_WIDTH=760` was ABSOLUTE — the stored width clamps against the LIVE container cap now (drag-time + render-time), so the chat floor is reachable at any window width |
| 17 | The agent "did not follow the rules" (direct URL instead of search-engine first) | The browser tool's prompt rules sharpened: search-engine-first when the task says search, type into fields, submit properly |
| 18 | Full-fledged mouse control: a custom pointer, visible movement with smooth randomness, accurate left/right click, scroll | The agent-cursor system: a page-injected branded cursor that moves along human-bezier paths, then REAL events dispatched at exact coordinates (mouse + scroll + drag) |
| 19 | Typing must be word-by-word (~150 WPM), not a paste; Shift+Enter for newlines; Enter reserved for submit | The typing engine: per-word chunks, per-char cadence with jitter, `\n` → newline insertion (never submit), explicit submit stays a separate param |
| 20 | The browser feels like an OVERLAY; menus make it "paused" | The overlay guard is now GEOMETRIC: the webview hides only when the open menu/dialog actually intersects the panel's screen rect |
| 21 | 1440×900 shows as default but is not applied | Natural mode is no longer the silent default: the stored viewport preset applies on mount (persisted per tab), the readout stays honest |
| 22 | Anti-automation detection "make it seem like a person" | Human-like cursor paths (bezier + micro-jitter + ease), typing cadence variance, full event properties; the webview itself has no webdriver flag |
| 23 | The task list (top-right) should have blurred corners around it | `backdrop-filter: blur` + rounded halo on the TodoFloat |
| 24 | Remember the last used model for next chats | = #14 |

## 1. Plan (phases, each ends in a commit + push)

- **A. About/Reset/Updates** — the setup-gate key, the server-side update
  check, the Releases button.
- **B. Providers** — identity rules (name-unique, adopt-on-preset,
  auto-suffix ids), the dialog rework (preset = no API-format field), the
  chat picker filter, last-used-model persistence.
- **C. Models UI** — catalog list, add-model page (display name, colored
  capability icons, token formatting, summary), models list sections +
  icon chips, the test-model expansion section.
- **D. Layout honesty** — dynamic sidebar cap, composer tiers (logo-only
  model, padding reduction, no overflow at the floor).
- **E. Browser (the big one)** — the agent cursor + typing engine, the
  viewport default fix, the geometric overlay guard, prompt rules.
- **F. TodoFloat blur** + the owner test checklist (§9).
- **G. Close-out** — verify pipeline, docs (this file + CHANGELOG +
  status.json + HANDOFF), v0.87.0 tag + release, dashboard sync, the final
  ntfy.

(Sections 1-8 are filled as the work lands; §9 is the owner test checklist.)

## 2. What shipped (the commit map)

| Phase | Commit | The verdicts answered |
|---|---|---|
| A — About/Reset/Updates | `f7e00a4` | #1 #2 #3 (the 404 update check, the Releases button, the setup-gate key) |
| B — Provider identity + picker | `5f47b3d` | #4–#8, #13–#14 (the "already exists" bug, same-type adds, the preset format, the chat picker, the last-used model) |
| C — Models UI overhaul | `e4f5376` | #7–#12 (the clean names, the colored icon toggles, the token formatting, the dedicated sections, the test expansion) |
| D — Layout honesty | `7f28ea3` | #15–#16 (the dynamic sidebar cap, the logo-only pill, the padding tiers, the overflow guards) |
| E — The agent hands | `09efdfd` | #17–#22 (the cursor, the typing, the scroll, the viewport default, the geometric overlay guard, the search-first prompt) |
| F — The TodoFloat frost | `5342917` | #23 (the backdrop blur) |

## 3. Backend

- **`routes/system.ts`**: `GET /system/updates` — the server-side update
  check (reads `~/.acute/github.pat`; 8s abort budget; reason-coded honest
  failures). The PAT never crosses REST.
- **`routes/providers.ts`**: `POST /providers` — NAME-keyed uniqueness (409
  `body.name`), keyless-row ADOPTION (200 `adopted:true`), same-type
  derivation (`prv_<name-slug>`, `-2 -3…` suffixes). `PATCH /providers/:id`
  enforces the same name rule on renames.
- **`tools/plugins/browser-hands.ts` (NEW)**: the in-page agent-hands
  runtime + the five drivers (click/type/press_key/mouse), the job
  protocol (`window.__acuteJob`), all CSP-tolerant, all ≤ 20KB.
- **`tools/plugins/browser.ts`**: the `mouse` action, the reworked
  click/type/press_key on the hands engine, the 600-char human-pace cap,
  the search-first + read_dom-first description.

## 4. Frontend

- `AboutTab` — the sidecar update check + `open_external_url` +
  `acute.setupDone` in the reset sweep.
- `ModelsProvidersTab` — `cleanModelName`/`formatTokenCount`/`CAPABILITY_META`
  helpers, the reworked picker/config-dialog/model-card/test-section.
- `ModelSelector` — the `hasKey` filter + the logo-only tier.
- `composer-utils` — `loadLastUsedModel`/`saveLastUsedModel`; the send path
  remembers the EFFECTIVE pair.
- `ChatFocusLayout` + `right-sidebar-store` — the dynamic width cap.
- `AgentChatPanel`/`Composer` — the `@container` squish tiers.
- `BrowserPanel` — the `evalJob` handler (start + 120ms polling + ≤25s),
  the geometric overlay subscription, the store-backed `natural` flag.
- `browser-store` — the per-tab `natural` field (default FALSE: the stored
  1440×900 preset applies on mount).
- `popover-webview-guard` — rect-recorded overlays + `overlayCoversRect`
  (unmeasurable overlays conservatively count as covering).
- `TodoFloat` — the frosted-glass treatment.

## 5. Verification

| Gate | Result |
|---|---|
| `eslint .` (root, full) | CLEAN |
| `tsc --noEmit` (root + agent-core) | CLEAN |
| Frontend vitest (full) | **2,885 / 2,885 GREEN** |
| agent-core vitest (full) | **1,892 / 1,892 GREEN** |
| `vite build` + `tsc agent-core build` | GREEN (the dist boots) |
| Sidecar E2E (12 black-box) | **12 / 12 GREEN** |
| License audit (134 prod deps) | CLEAN |

New/rewritten test surface: AboutTab (5), r89-updates (4), providers.test
(4 rewritten), ModelsProvidersTab (7), Composer (2 + 1 updated),
right-sidebar-store (3), popover-webview-guard (2 new + rewritten),
BrowserPanel (2 + 3 updated), browser-tool (3 + 2 rewritten), r80-nvidia
(1 rewritten for adoption).

## 6. The owner's TEST CHECKLIST (§9 promised)

**A. About / updates / reset**
1. Settings → About → *Check for updates* — expect "Up to date — v0.87.0 is
   the latest published release" (run via ACUTE.bat once so the launcher
   has saved the GitHub token; before that the honest "token not saved"
   error shows).
2. *Releases* — your default browser opens the releases page.
3. Type RESET → *Reset everything* — the app must land on the SETUP WIZARD
   (not the dashboard), and stay there across a full close + reopen.

**B. Providers**
4. After a reset: Add Provider → NVIDIA → paste the key → Add — it must
   SUCCEED (no "already exists"). Same for OpenRouter.
5. Add a SECOND NVIDIA (rename to "NVIDIA 2" when the red hint appears) —
   both live in the list side by side. Try a third.
6. The preset flow never asks for the API format (a read-only chip shows
   it). The CUSTOM flow still picks one.

**C. Models & Providers UI**
7. Add models — every row shows a clean NAME (e.g. "Llama 3.3 70b
   Instruct") + the full id below; no "CONFIGURE" label anywhere.
8. Click a model — the config dialog's Display name is pre-filled with
   that clean name; the capability chips are colored and carry icons.
9. Type 1000000 in Context window — a "≈ 1M" hint appears under the
   input and the summary line reads `ctx 1M`.
10. Every model card shows the details strip (Context | Input | Output |
    Cache read). The capability chips are colored icons.
11. Press TEST on a model — the card itself does NOT change shape; a
    bordered section appears BELOW it with the response time; *Show
    reply* reveals the full reply; it collapses after 5s (stays while you
    read it).

**D. Layout**
12. Open both sidebars and drag the chat/sidebar divider LEFT as far as
    it goes — the chat reaches its minimum; the model pill becomes
    logo-only; nothing overflows.
13. Hide the left sidebar completely — the chat must STILL shrink to the
    same floor.

**E. The browser hands**
14. Give the agent a task that says "search the web for X, then open the
    first result and look for Y" — the agent must go to a SEARCH ENGINE
    first, and you must SEE the orange agent cursor travel to the search
    box and the query typed word by word (~150 WPM), then submitted.
15. Watch a click: the cursor visibly moves (with natural wobble) and
    lands exactly on the element.
16. Ask for a multi-line text typed into a textarea — newlines stay
    newlines (no accidental submit).
17. The viewport readout says desktop 1440×900 by default and the page
    ACTUALLY renders at that size (aspect-fitted); "Natural (fill panel)"
    is one click away.
18. Open any top-bar menu — the browser KEEPS SHOWING the page (it only
    pauses if the menu actually covers it, e.g. a centered dialog).

**F. Misc**
19. The chat's model picker lists ONLY the providers you added (with
    keys) — no Anthropic/OpenAI dead rows.
20. Pick a model, send a message, open a NEW chat — the model is
    remembered as the default.
21. The to-do list (top-right) now frosts/blurs the chat behind its
    corners; everything else works as before (expand, edit, statuses).
