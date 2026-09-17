<!-- last-reviewed: 2026-09-17 round-101 -->
# ADR-0030: Mermaid diagram rendering in the chat (mermaid v11 + two ADR-classified license pins)

- **Status:** ACCEPTED
- **Date:** 2026-09-15 (round 98; owner-directed)
- **Tags:** chat, rendering, licenses, compliance

## Context

The owner's round-98 ask: "adding options to see Mermaid flow diagrams and
other key things in the chat properly" — the chat currently renders every
```mermaid fence as a plain code block (the model's diagram source, never a
diagram). Mermaid itself is MIT-licensed, but installing it drags a dependency
tree that must survive `scripts/license-audit.mjs` (SPEC section 6:
closed-source distribution — GPL/AGPL/LGPL and unclassifiable licenses are
forbidden; every exception needs an ADR).

Measured evidence (`pnpm licenses ls --json --prod`, 2026-09-15):

- **mermaid@12 is REJECTED**: it depends DIRECTLY on elkjs, whose license is
  EPL-2.0 — a copyleft license (the same exclusion class as GPL; EPL-2.0's
  weaker copyleft does not matter, the audit draws the line at copyleft).
  This is the absolute exclusion; no ADR exception was considered.
- **mermaid@11.17.2** (root `mermaid@^11`) brings 247 audited production
  dependencies with exactly TWO failures, both spelling classifications
  rather than license-class problems:
  - `khroma@2.1.0` — pnpm reports "Unknown" because the package.json ships
    NO license field; the project is MIT in fact
    (github.com/fabiospampinato/khroma — MIT, just unpublished in the
    manifest).
  - `robust-predicates@3.0.3` — pnpm reports "Unlicense", which is not on
    the audit's ALLOWED SPDX list but IS public-domain-equivalent: MORE
    permissive than MIT. The audit already admits the
    public-domain-dedication class via 0BSD and CC0-1.0.

## Options considered

- **Option A — mermaid@12 + an EPL-2.0 exception.** Rejected without
  discussion: EPL-2.0 is copyleft, the absolute exclusion for a closed-source
  distribution. A weaker copyleft is still copyleft.
- **Option B — mermaid@11.17.2 + two exact license pins** (a
  `package@version → {license, adr}` override map in the audit script).
  Pros: mermaid v11 is a mature, MIT-licensed renderer that covers flowcharts,
  sequence/state/ER/gantt and the rest of the diagram vocabulary the chat
  needs; the two pins document measured spelling gaps, not policy changes.
  Cons: the pins are load-bearing — any version bump of khroma or
  robust-predicates re-fails the audit until the pin is re-verified.
- **Option C — no mermaid; hand-rolled diagram rendering.** Rejected: the
  owner asked for Mermaid specifically; a hand-rolled subset of the diagram
  grammar is weeks of slop for a worse result.

## Decision

**Option B.** Ship `mermaid@^11` (11.17.2) and add
`PACKAGE_LICENSE_OVERRIDES` to `scripts/license-audit.mjs` — the narrowest
mechanism that can classify the two rows: an exact `package@version →
{license, adr}` map (`khroma@2.1.0 → MIT, ADR-0030`;
`robust-predicates@3.0.3 → Unlicense, ADR-0030`). The ALLOWED set is NOT
touched; the GPL/AGPL/LGPL exclusion runs BEFORE any override can apply (an
override can never whitelist copyleft — the map is for spelling gaps only);
the generated report shows the ADR-classified license alongside the raw pnpm
value so every override stays visible in `docs/compliance/`.

Rendering contract (src/components/project-chat/MermaidDiagram.tsx): the
module is imported LAZILY (dynamic `import("mermaid")`) only when a COMPLETE
mermaid fence mounts — mid-stream unclosed fences stay plain CodeBlocks;
`securityLevel: "strict"` always; the theme follows the app theme store
(dark → "dark", light → "default"); a failed render degrades to the source
in an ordinary CodeBlock under an amber one-line note — never a crash, never
a blank. (Round 101 hardened this contract — see the addendum below.)

## Consequences

- The chat renders mermaid flow (and sequence, state, ER, gantt…) diagrams
  inline; everything else keeps the exact pre-R98 CodeBlock behavior — every
  non-mermaid fence and unclosed fences. (Thinking blocks originally stayed
  CodeBlocks too; round 101 reversed that for mermaid fences — see the
  addendum below.)
- The two pins are load-bearing: a version bump of either pinned package
  re-fails the audit until the pin is re-verified against the new version
  (this is intentional — the audit must stay honest about what ships).
- Reversal cost is LOW: remove the dependency, the component, and the two
  override rows — no data, no wire format, no migration involved.
- Bundle impact stays lazy: the mermaid chunk loads only when a completed
  mermaid fence actually renders, never for ordinary chat traffic.

---

## Round-101 addendum (R101-F — the owner's v0.98.0 report)

> "I want you to handle the mermaid flow diagrams properly too, because in
> the chat area it was not showing me the properly rendered flow diagrams as
> I hoped for it to be."

The report traced to four verified defects, all fixed in round 101
(2026-09-17) without changing this ADR's decision (mermaid@11.17.2 + the two
license pins stand):

- **Thinking/work sections render diagrams too (the old answer-text-only
  scope was the defect).** A ```mermaid fence the model emitted inside a
  thinking block showed as SOURCE forever: WorkingSection's fence-split
  rendered every closed fence through the plain CodeBlock. A closed
  mermaid fence there now mounts the SAME MermaidDiagram (mounted exactly
  as ChatMarkdown mounts it — `code` only; the theme rides the app store).
  The thinking-note container design is untouched.
- **Errors surface.** The silent `catch {}` is gone: every failure logs
  `console.warn("[mermaid] render failed:", err)` and the amber note carries
  the reason in a mono sub-line (`data-testid="mermaid-error-detail"`) —
  the message's first line, capped at 140 characters, with the `cause` chain
  walked so wrapped loader errors ("Failed to fetch dynamically imported
  module") stay diagnosable.
- **One bounded retry on both legs.** The lazy-chunk import retries once
  (400ms gap): a single WebView2 asset-protocol/AV hiccup no longer silently
  degrades every diagram forever. `mermaid.render` retries once with a
  FRESH `acute-mermaid-<seq>` id (transient font/theme timing on a freshly
  mounted webview); the cancelled-flag race guard spans both attempts on
  both legs. A second failure flows into the honest note, message and all.
- **The chunk ships or the build fails.**
  `scripts/release/check-mermaid-chunk.mjs` (wired into `pnpm build`) globs
  `dist/assets/mermaid*.js` (today's shape: `mermaid.core-<hash>.js`, ~668
  KiB — mermaid@11's ESM entry) and exits 1 with a loud message when the lazy
  chunk is missing — the packaged-app failure mode is now a build-time gate
  instead of a silent runtime degradation.
