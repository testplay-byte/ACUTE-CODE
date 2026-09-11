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
