<!-- last-reviewed: 2026-09-23 round-120 -->
# Round 120 — the v0.113.0 device report: the updater token resilience, the providers/models UX overhaul, the composer law completed, and the center-section redo on BOTH platforms

Open: 2026-09-23. Baseline: v0.113.0 (5e8c154). Target release: v0.114.0.

The owner's verdict on v0.113.0: the R119 center work "still not managed as well as it needs to be" — the center-section redo is now the round's core, on BOTH PC and mobile, plus the agent harness itself (midway stops, the "continue" regression). Around it: the PC updater's 401 (the PAT rotation exposed a real fragility), a full providers/models UX pass on Android, the composer/attachment experience, and the projects/sessions list polish.

## §1 The owner's report — itemized

### A. The PC updater (the PAT rotation fallout)
1. "Check for updates" answers **HTTP 401** — the sidecar presented the launcher's saved PAT, the owner had rotated it in GitHub, and GitHub rejects dead credentials **even on public repos**; the code never drops the header and retries anonymously (the repo is public — anonymous works; the sandbox's own anonymous 403 is THIS IP's rate limit, verified by the HTML 200).
2. The **"Releases" button does nothing** (only "Open the Releases page" works).
3. "Releases" opens in the **app's embedded browser** — "that is not a good experience"; external links must open in the SYSTEM browser.

### B. Android — Settings/Appearance
4. The charts settings have "a lot of empty area on the right sides and the left sides" — stretch to fill the full width.

### C. Android — the providers LIST
5. The "Add a Provider" button has a **glowing effect around the text** — "ugly and bad", remove.
6. Tapping "Add a Provider" shows the options at the bottom **without a dedicated background** — they must sit in their own section, visually separated from the page.
7. Tapping a provider option (OpenAI, NVIDIA, Anthropic, Google, OpenRouter) **must NOT navigate directly** to the provider page — the same **bottom-up sheet** experience as the custom-providers option (pick → sheet → configure).
8. The bottom-up sheet **animations are still bad** — "stuttering, and they do not play in the proper time".
9. The "Create Provider" button needs the same improvement.

### D. Android — the provider DETAIL page
10. Below the provider name it says "Chat Completion API" — replace with the **base URL directly**, no heading.
11. The on/off toggle belongs **on the right of the title row** (the provider name), not beside the base URL.
12. "Rename" becomes **"Edit"**.
13. The "Test Connection" / "Add Provider" / "Save Key" buttons have a **weird effect** — same family as the glow: fix the button styling.

### E. Android — the API keys section
14. The inline "Test" / "Replace" options on each key row are rejected — **tapping a key opens a bottom-up menu** (Test / Edit / Replace / …).

### F. Android — the MODELS
15. The model-actions bottom sheet's **animations are broken**.
16. A failed model test and a Hide-model action show their details **at the bottom of the sheet** — they must be a **toast that auto-dismisses in ~2s**.
17. Edit Model: the context window / max-output fields show the **simplified form on blur** ("1M" for 1000000, "26K" for 26000) and the full digits **on focus**.
18. The input/output capabilities: **actual color-coded SVG icons** (not text), laid out on a **single line**.
19. Add-custom-model search: tapping a result **does nothing** — it must open the **Edit Model screen** for that model.
20. **Smart model data fetching**: opening a model's configure page runs a small loading animation while the app fetches the model's real info from the provider (size, capabilities, context window, max output, input/output/cache-read prices) and **auto-populates** the form. (PC: same behavior on the Configure Model dialog.)
21. **Reasoning levels editor**: the levels list lowest→highest with a **+ button on the right of the highest**; add/delete levels.
22. The "Add" button **commits the model to the list before "Save Configuration"** — the model must only appear after an explicit save.

### G. Android — Projects & sessions lists
23. The New Project pop-up/bottom-sheet **animations** (same sheet-motion family).
24. "Type a path instead" reads like plain dead text — **highlight it as a real option**.
25. Each session row gets an **icon on the left**.
26. The New Session button needs **more separation** from the session list.
27. Each session row gets a **slight shade/tint** so consecutive sessions are distinguishable.

### H. Android — the session composer & attachments
28. **No bottom spacing** — the composer rides the device edge; add proper inset.
29. The Add Context control sits OUTSIDE the "Message the Agent" area — move it **inside, at the far right** of the input row.
30. The text must **adapt around the Add Context control**: text above it may occupy the space above; text on its line flows to its LEFT; **never overlap**.
31. Typing **@** opens a results menu ABOVE the input, filtering as the query continues; tapping inserts the file reference.
32. **Attachments**: images get a real preview chip in the composer; tapping ANY attachment opens a **pop-up viewer** (image → large preview; text → scrollable content).
33. The kebab menu gains a **separator + "Task list"** option at the bottom; tapping shows the task list in the same menu family.

### I. The session CENTER — PC (the §N redo, PC side)
34. **The timeline is replaced**: remove the current left timeline entirely. The new one is a **message timeline** — one bar per user message; hovering grows the bars (the nearest to the pointer largest, falloff with distance); the CURRENT message's bar is highlighted; hovering a bar shows a **2-line preview of the user's message + 2 lines of the agent's response**; clicking scrolls to that exchange.
35. **File edits, created files, and streaming are not shown** — the center never renders them (both platforms; see §J).
36. The "how long this work session ran" blocks — 8-9 separate right-side blocks — **combine into one**.
37. **Backend/frontend sync**: the frontend claims completion while the backend still works; the stop button disappears mid-processing; a refresh makes everything look finished until the next agent frame arrives.
38. After the auto-recover, **the session splits in two halves**; another refresh recombines it — then the layout is off.
39. **Formatting**: no proper headings, no color highlighting, "the overall experience is ugly" — the response rendering needs the full treatment.

### J. The session CENTER — mobile
40. Mirror the PC center work: **file edits, created files, tool/command hints** must render on mobile too.
41. The AI responses are **badly formatted** on mobile — "some randomness", text appearing in the wrong order, no hint of the tools that ran.
42. Check **fonts loading/bundling** (a possible root cause of the mobile rendering feel).

### K. The harness (agent-core)
43. **The agent stops midway** — mid-command, mid-file-read, mid-write — with no model error and no visible cause. The completion/stop logic must be sound: a turn may only end when the model actually yields a final answer or a real error occurs.
44. **"Continue" re-reads every file from scratch** — the resume path must hand the model its working context, not reset it into re-discovery.

### L. Process mandates
- The owner named the **full-stack dev subagent** for the center-section work.
- **Live in-sandbox testing on a real project with tasks** — TokenHarbor is region-blocked from this sandbox (verified again this round: `region_blocked` on /models), so the live battery runs on the provided **OpenRouter/NVIDIA keys**; the TokenHarbor verdict stays device-side (the R119 tools probe).
- Update the design-language docs along the way; no rushing; release v0.114.0 (Android APK + PC).
- **Send a notification after completing.**

## §2 The wave plan

Seven tracks in three waves, then gates + docs + review + live test + release.

### Wave 1 — four parallel worktree tracks (disjoint file families)

**Track U — the PC updater resilience (agent-core/src/routes/system.ts, src/components/settings/AboutTab.tsx, src/lib/update-checker.ts)**
- The 401 fix at the root: when the PAT-bearing request answers **401, retry once ANONYMOUSLY** (drop the Authorization header) — the repo is public; a dead token must never gate the check. The honest error copy distinguishes "token rejected (401) — the saved GitHub token is stale" from reachability failures.
- The **token re-pairing path**: `PUT /system/updates/token {pat}` validates the new PAT against `/repos/testplay-byte/ACUTE-CODE` (200 + full_name check) before persisting to `~/.acute/github.pat` (the R90-B1 home location, never the env var); the About tab gains a quiet "Update GitHub token" affordance in the update card's error state (and a generic path in the card footer). Secret-shape scrubbing applies to every log/audit line.
- The **Releases buttons**: both the "Releases" secondary button and every release-page link route through the EXTERNAL system browser — the Tauri `open_external_url` shell open (web-mode `window.open` fallback) — never the embedded browser. Diagnose why the plain "Releases" button does nothing (the R99-A central link router's forceExternal=false path) and fix.
- Tests: the 401→anonymous retry (fetch mock), the token persist+validate route, the Releases external-open routing.

**Track S — mobile Settings/Appearance/Providers-list + the sheet motion (mobile/app/settings/appearance.tsx, mobile/app/settings/providers/index.tsx, mobile/src/components/sheet.tsx, usage-cards)**
- Charts stretch full-width (the settings' chart settings section).
- The Add-Provider button: **glow removed**, the quiet-solid button family.
- The Add-Provider options render in a **dedicated section with its own background** (the sheet's content surface), separated from the page.
- The five preset providers route through the **bottom-up sheet** (the custom-providers grammar) instead of direct navigation — pick in the sheet, then configure.
- The sheet motion retune #2: the R119 {180,24} tuning still reads as stutter — investigate the ACTUAL frame timing (the first-frame law, the JS-driven spring on the UI thread?) and land a smooth, correctly-timed open/close: measured, with the reduced-motion path intact. This is the round's sheet-motion authority — all sheets inherit.
- The Create Provider button joins the same family.

**Track M — mobile provider detail + the models overhaul (mobile/app/settings/providers/[id].tsx + new model components + mobile/src/lib/api.ts)**
- The provider hero: **base URL directly under the name** (no "Chat Completion API" heading), the **toggle in the title row's right**, "Rename" → "Edit".
- The button family cleanup (Test Connection / Save Key / Add Provider effects).
- The API-key rows: tap → **bottom-up menu** (Test / Edit / Replace) — the inline right-side options removed.
- The model-actions sheet: animations + the **toast law** (test-failure details and hide confirmations are toasts, ~2s auto-dismiss).
- The **model editor**: simplified number display on blur (1M/26K), full digits on focus; the **SVG color-coded capability icons** on one line; the reasoning-levels editor (ordered, + on the highest, add/delete); **save-before-add** (the list only grows on Save Configuration).
- The add-custom-model flow: tapping a search result **opens the edit screen**.
- The **smart fetch**: on opening a model's configure page, a bounded provider call populates size/capabilities/context/prices with a loading animation (the /models or /models/{id} surface per format; graceful no-op when the provider doesn't serve it).

**Track P — mobile projects/sessions lists + the composer & attachments (mobile/app/project/[id].tsx, mobile/app/session/[id].tsx, mobile/src/components/composer.tsx)**
- The projects list: sheet animations (inherits track S's sheet motion if merged after; coordinates via the sheet component), the **"Type a path instead"** affordance as a real highlighted option.
- The sessions list: **icon per session**, the New Session button **separated**, each session row a **slight alternating tint**.
- The composer: **bottom inset** (safe-area-aware), the **Add Context control inside the input row at the far right**, the **text-wraps-around-the-control law** (never overlap — the R119 single-tier law's completion), the **@-mention menu above the input** with live filtering.
- The attachments: **image preview chips** in the composer; tapping any attachment opens the **viewer pop-up** (image large / text scrollable).
- The kebab: **separator + Task list** entry; the task list renders in the same menu family (a sheet or an in-menu panel per the design language).

### Wave 2 — three parallel tracks on the merged tree

**Track C-PC — the PC center redo (src/components/project-chat/*, src/lib/stream-store.ts, src/lib/api.ts; the full-stack dev agent per the owner's directive)**
- The **message timeline** (item 34): one bar per user exchange, hover-proximity scaling (nearest bar largest, smooth falloff), the current exchange highlighted, the hover preview (2 lines user + 2 lines agent, no tool cards), click-to-scroll. The old timeline is REMOVED.
- The center's **file-edit/file-create/streaming rendering** (item 35): the tool/entry renderers must show every write/edit/create as it streams — the honest live center.
- The **duration consolidation** (item 36): one combined "session ran X" block.
- The **sync/state law** (items 37-38): the frontend's live-turn state must derive from the BACKEND's turn registry (a lightweight GET or the SSE heartbeat), not from "no frames lately" — the stop button stays while the backend turn is live; a refresh rehydrates the live turn instead of showing a finished transcript; the session-split (the folded/live seam) is fixed at the fold.
- The **response formatting** (item 39): headings, code blocks, colors, the works — the PC markdown center.

**Track C-M — the mobile center + formatting (mobile/src/components/transcript.tsx, markdown-text.tsx)**
- The mobile mirror of the center work (items 40-41): the TurnBlock's tool rows must carry the file-edit/create/streaming verbs with the same honesty as PC; the response formatting (headings, code, spacing) gets the mobile treatment.
- The **fonts audit** (item 42): verify the font assets are bundled and loaded (the RN text stack), fix what's missing.
- The processing indicators ride here (transcript-owned): the pulsing line → gray separator, the sent-message pulse/glow, the avatar ring (the session screen's avatar ring may live in session/[id].tsx — track P's file; coordinate at merge).

**Track H — the harness (agent-core/src/agents/*, lib/*)**
- The **midway-stop root cause** (item 43): audit the turn loop's every exit path — the blank-output guard, the retry ladder's give-up conditions, tool-error escalation, the stall watchdog — and close the silent exits; a turn ends ONLY on a real final answer, a user abort, or an surfaced error. Add the regression tests that reproduce the mid-tool silent stop.
- The **"continue" regression** (item 44): the resume/compaction path must preserve the working context (the prior tool results stay in-history; no re-read-everything) — audit compaction.ts's triggers and the continue-prompt assembly.
- The live battery harness prep: a script/procedure to run a real project task end-to-end (used by Wave 4).

### Wave 3 — gates, docs, review
Full gate ladder on the merged tree (mobile tsc + jest; agent-core tsc + vitest; root tsc + eslint + vitest; docs:check). The design-language amendments for everything shipped (the sheet motion's final spelling, the composer law's completion, the timeline grammar, the toast law, the capability-icon vocabulary, the token-re-pairing flow). The flaw-finding review.

### Wave 4 — the live battery + the release
The in-sandbox live test: sidecar + PC web build running a REAL project with REAL tasks on an OpenRouter model (the provided keys) — the center section, file edits, streaming, timeline, stop/resume verified end-to-end in the browser (agent-browser). Then v0.114.0 per the §g runbook (tag → both workflows → 7/7 assets → publish → end-state) and the closing notification to the owner.

## §3 Verification
(filled at close-out)

## §4 The release
(filled at close-out)
