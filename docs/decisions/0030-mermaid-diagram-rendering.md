<!-- last-reviewed: 2026-09-15 round-98 -->
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
a blank.

## Consequences

- The chat renders mermaid flow (and sequence, state, ER, gantt…) diagrams
  inline; everything else (every non-mermaid fence, unclosed fences,
  thinking blocks) keeps the exact pre-R98 CodeBlock behavior.
- The two pins are load-bearing: a version bump of either pinned package
  re-fails the audit until the pin is re-verified against the new version
  (this is intentional — the audit must stay honest about what ships).
- Reversal cost is LOW: remove the dependency, the component, and the two
  override rows — no data, no wire format, no migration involved.
- Bundle impact stays lazy: the mermaid chunk loads only when a completed
  mermaid fence actually renders, never for ordinary chat traffic.
