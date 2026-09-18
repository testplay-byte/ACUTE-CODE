<!-- last-reviewed: 2026-09-18 round-104 -->
<!-- round: 100 -->
# Round 100 — the honest browser + the UI that stops looking generated + the Linux release (v0.97.0 → v0.98.0)

The owner's eleventh walkthrough report (v0.97.0): the browser "is still
utilizing the Microsoft Edge browser under the hood" and "the size is 4x
what the previous one was" (the fixedRuntime installer measured 258 MB vs
the 36.9 MB evergreen one); the UI "looks way too bad. It looks
AI-generated" with only the startup page + setup wizard spared ("every
single one of them needs to be handled better, with proper spacing, proper
highlighting, proper fonts, proper layout management"); "do a complete UI
overhaul for the chat window for the agent"; "make sure that the agent is
improved in various ways, like testing it in your own environment too";
and "do a proper Linux release". The round's method: research first again
(two dedicated passes — the browser/Linux trilemma and the UI design
language, both saved as research docs and quoted throughout), then nine
workstreams, then a LIVE-FIRE agent battery on real OpenRouter turns.

## §0 The owner's report, itemized (the round's contract)

1. **The browser's identity + size**: "I don't feel like you have
   implemented the correct version… I feel like it is still utilizing the
   Microsoft Edge browser under the hood. I also feel like the size is way
   too much… 4x what the previous one was." — R100-A: the fixedRuntime
   bundle RETIRED (installer ~258 MB → ~37–40 MB — the bootstrapper
   contract), the panel DE-BRANDED (`PANEL_USER_AGENT` on every content
   webview: no `Edg/` token, `AcuteBrowser/1.0` identity, platform-honest
   on Linux), the honest ENGINE LINE (Settings → Browser + About), the
   trilemma on record in the research doc. — closed (the Windows leg; the
   genuinely-not-Edge engine arrives via the Linux release below).
2. **The full UI redo**: "The UI currently looks way too bad. It looks
   AI-generated… The only UI that is good is the startup page and the
   setup wizard." — R100-C/D/E/F/G: the design foundation (TOKENS revised
   to the measured ladder + the DESIGN-AUDIT GATE + the Kicker/SectionCard/
   SettingsRow primitives), then every working screen swept: the chat
   window (§C4's deep spec end to end), settings (the VS Code
   nav-with-search shell + all nine tabs), the sidebar/shell density
   (32px rows, 400-weight chrome), the dashboard/usage heroes
   de-costumed, the right sidebar's one toolbar grammar. The measured
   clean-up, app-wide: sub-10px type 101 → **0**, heavy font weights
   474 → 19, JS hovers 243 → 33, inline hex 254 → 103 — and the audit
   gate makes regression impossible. — closed.
3. **The chat window**: "do a complete UI overhaul for the chat window for
   the agent" — R100-D: the type ladder snapped, lucide status glyphs
   (aria-labels preserved), radii 4/8/12/16/999, the user message
   redesigned to the input-row idiom, Send de-glued (28px solid-accent
   circle, no glow, no hover-scale), SEAM_GAP 3→4, the global
   :focus-visible rule, tabular-nums. — closed.
4. **The agent, tested in our own environment**: R100-H — the live-fire
   battery, 7 legs on REAL OpenRouter turns (z-ai/glm-5.2:free): turn
   loop sync+streaming, tool use with disk-truth verification, memory
   save + auto-load recall, web_fetch through the full approval chain,
   browser_control's honest-refusal discipline, confidence tags (🟢)
   landing, the ctx meter + usage ledger accurate — and the bug it
   caught: "Invalid JSON response" dead-ended turns with NO retry
   (classified `unknown`, attempts:1); now `malformed_response`/
   transient (the R94-D1 ruling extended), pinned + re-verified live. —
   closed.
5. **The Linux release**: "work on the Linux release too… a proper Linux
   release… Everything should work properly: all the commands, the
   functionality. The agent should be aware of the things too." —
   R100-B: ADR-0031 the Secret Service key store (the `keyring` crate,
   target-gated — the Windows FFI untouched, the honest headless fallback
   to env vars), the `rust-linux` CI cargo-check job (the compile class
   gated forever), the `linux-bundles` release job (deb + AppImage: the
   pinned linux-x64 sidecar + Node runtime + the bash boot gate — the
   R57 gate ported), the GitHub release carries the Linux assets, the
   README's Linux + troubleshooting sections (the NVIDIA env ladder).
   The agent's platform awareness was verified already-live: the R70-c
   ENVIRONMENT section grounds the real OS + shell per turn (Linux →
   WebKitGTK + /bin/sh honestly), and the browser engine facts are in
   the honest engine line. — closed (pending the tag run's live proof).

## §1 The research chapter

Two reports, both committed at 1a7ba1c and normative for the round:

- `docs/research/browser-engine-and-linux-round-100.md` — the browser
  trilemma MEASURED (on Windows 2026 pick two of: not-Chromium-lineage /
  production web compat / installer ≤ ~100 MB — Servo 66.4% WPT, CEF
  +165 MB, headless-shell 114 MB, the fixed runtime 258 MB) + the Linux
  plan (targets, the keys.rs port as the one new subsystem, the CI job
  sketch, WebKitGTK's NVIDIA bug ladder).
- `docs/research/ui-design-language-round-100.md` — the AI-generated look
  MEASURED on our own tree (34 distinct text sizes, 2,567 arbitrary
  Tailwind values, 284 hex literals, 130 hand-rolled JS hovers, no
  focus-visible rule) + the external study (Linear/Vercel's type ladders,
  VS Code's collapse grammar + settings search, GitHub's danger-zone
  placement, Geist empty states, the anti-slop checklist) + the full
  redesign spec (§C: the token layer, the per-screen plans P0–P5, the
  chat deep spec with exact measurements, the wizard-DNA boundary).

## §2 The workstreams

| id | delivered | commit |
|---|---|---|
| A | the honest browser (evergreen + de-branded UA + the engine line) | e9a67fa |
| C | the design foundation (TOKENS revised + the audit gate + the primitives) | 7eb73d0 |
| D | the chat window overhaul (the §C4 deep spec, 37 files) | 2134194 |
| E1 | the settings shell (nav column + search + primitives adoption) | 412466e |
| E2 | the settings tab sweep (nine tabs, ModelsProvidersTab de-offendered) | 9f68fbc + 56db304 |
| F+G | the shell density + the working-screen de-costume | ea1217f |
| B | the Linux release (ADR-0031 + CI jobs + the bundle pipeline + docs) | 11806a1 |
| H | the live-fire agent battery + the Invalid-JSON retry fix | 602d0dd |
| I | this close-out | this commit |

## §3 The verification numbers

- Frontend + agent-core root suite: **3,785 passed / 12 env-skipped / 0
  failed** (the R99 baseline was 3,754 — the round added 31 net pins).
- The design audit (new gate, wired into verify + CI): baseline ratcheted
  DOWN across the round — R1 hex 254→103 · R2 arbitrary-px 1935→1521 ·
  R3 sub-10px 101→0 · R4 heavy weights 474→19 · R5 JS hovers 243→133→33.
  Wait — the final re-pin after F+G: R1 103 / R2 1521 / R3 0 / R4 19 /
  R5 33.
- eslint clean; root tsc clean; agent-core tsc clean; docs:check
  218/0/0 (ADR-0031 added); the license audit unchanged (no new runtime
  deps in the shipped tree — `keyring` is a Linux-only Rust dep, audit
  scope is npm).
- cargo check cannot run in this sandbox — the NEW `rust-linux` CI job +
  the Windows CI job gate the Rust side; the release tag run is the
  end-to-end proof (including the first Linux bundles).
- The live-fire battery (R100-H): 7 legs, real OpenRouter turns, disk
  truth as ground truth — all green post-fix.
- **The release runs (final): CI 35202716106 + Release 35202722327 both
  SUCCESS; v0.98.0 PUBLISHED (release 390567270, latest).** The asset
  numbers that answer the owner's complaint: setup.exe **38,724,392 B
  (36.9 MB)** — byte-comparable to v0.96.0's evergreen installer, down
  from v0.97.0's 270,884,416 B; the FIRST Linux bundles:
  ACUTE-CODE_0.98.0_amd64.deb 67,231,760 B + ACUTE-CODE_0.98.0_amd64.
  AppImage 134,937,080 B; the launcher kit 122,907 B. Four CI-caught
  hotfixes landed on the way (the unbalanced cfg paren in browser.rs, the
  RGBA icon ladder the AppImage leg requires, the rust-linux dist stub,
  the flat artifact staging for upload-artifact's LCA path rule) — each
  one a lesson the sandbox could not have taught locally (it cannot
  compile Rust); CI earned its keep as the only Rust gate.

## §4 The round's lessons (also AGENT-MEMORY #101)

- The research-first discipline paid twice: both reports drove the
  workstreams AND became the durable record (the trilemma doc answers
  "why not a different engine" forever; the UI spec's measurements made
  "AI-generated" falsifiable and fixable).
- The subagent final-report death pattern: 6 of 8 implementation agents
  died at their LAST LLM call (context deadline) — every one AFTER
  landing its diff. The completion protocol (orchestrator verifies the
  tail + re-pins + commits) is routine now; smaller contracts (E2-part2,
  B, C) survived whole. Lesson: size agent contracts to ONE screen or
  ONE subsystem, not "a wave".
- The audit-gate ratchet is the round's structural gift: cleanup that
  cannot regress (counts may only go DOWN, enforced in verify + CI).
- Sandbox reaping: background processes do not survive between tool
  calls in this environment — the live battery ran each leg as one
  self-contained boot→exercise call with the SQLite DB persisting state.

## §5 The owner's TEST CHECKLIST (v0.98.0)

1. **The installer**: back to ~37–40 MB (from ~258 MB). On a machine
   without any WebView2 runtime the tiny bootstrapper downloads it at
   install; everywhere else the install is instant.
2. **The browser's identity**: open any page in the embedded panel and
   ask a site (or the agent) what browser it is — the answer carries
   ACUTE's identity (`AcuteBrowser/1.0`), never "Microsoft Edge".
   Settings → Browser states the engine plainly at the top (and the
   About tab's Engine row).
3. **The chat window**: turns open with the model header; tool rows lead
   with proper icons; your messages sit in the tighter input-row style;
   the Send button is a clean circle with no glow; everything tabulates.
4. **Settings**: the left nav column + the search box (type "provider" —
   it finds the Models & Providers tab; type "zzz" — the honest no-match
   note); the tabs themselves: one card idiom, regular-weight labels,
   no inline-red errors (semantic colors), 28px rows.
5. **The Linux build**: from the release page grab `ACUTE-CODE_0.98.0_amd64.deb`
   (Debian/Ubuntu) or the `.AppImage` (any distro) — the app + the
   browser panel (WebKitGTK — genuinely not Edge on this platform) + the
   same agent, same tools; keys go to the Secret Service keyring
   (gnome-keyring), or env vars on headless boxes. If the window blanks
   on NVIDIA, the README troubleshooting ladder fixes it.
6. **The agent**: mid-task transient provider hiccups no longer kill a
   turn instantly — "Invalid JSON response" now retries (the live-fire
   battery's catch, re-verified live).

## §6 Round-cumulative design audit (the before/after)

| Rule | R99 end | R100 end |
|---|---|---|
| R1 inline hex literals | 254 | 103 |
| R2 arbitrary Tailwind px | 1,935* | 1,521 |
| R3 sub-10px text | 101 | **0** |
| R4 font-bold/black/extrabold | 474 | 19 |
| R5 onMouseEnter/Leave | 243 | 33 |

\* the gate was built at 1,935 (post-primitives); the research measured
2,567 app-wide including pages before the scan scope settled.
