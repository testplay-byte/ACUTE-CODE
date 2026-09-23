/**
 * ROUND-82 (R82): the shared SECRET-SHAPE scrubber.
 *
 * History: three identical copies of the prefix-regex block lived in
 * agents/chat.ts (tool-output summaries), providers/registry.ts (connection
 * tests — new this round), and the frontend's src/lib/error-bus.ts (its own
 * package copy, unchanged — cross-package imports are not possible). This
 * module is the agent-core consolidation point: chat.ts's
 * summarizeToolOutput and registry.ts's model-test probe both call it, so a
 * future key-prefix class (the R80 nvapi- lesson: a new provider shipped and
 * its keys leaked until every copy was patched) lands in ONE place.
 *
 * What it scrubs: recognizable key PREFIX SHAPES (defense-in-depth — the
 * keyring-value scrub that replaces exact held keys runs separately at each
 * call site, because only the caller knows which literal value to redact).
 * A shape match is always replaced, even inside JSON payloads.
 */

/** Scrub recognizable secret shapes (sk-…, nvapi-…, github_pat_…, ghp_…)
 * from text. */
export function scrubSecretShapes(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "sk-***")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "github_pat_***")
    .replace(/nvapi-[A-Za-z0-9_-]{16,}/g, "nvapi-***")
    // ROUND-120 (R120-U): the CLASSIC GitHub PAT shape joins the list —
    // PUT /system/updates/token accepts ghp_… tokens (the fine-grained
    // github_pat_ spelling is not the only real one), so the updater's
    // error lines must scrub both spellings. The R80 lesson: a new
    // key-prefix class lands HERE, in the one place, the round it ships.
    .replace(/ghp_[A-Za-z0-9]{20,}/g, "ghp_***");
}
