/**
 * ROUND-107 (R107-c-impl, F4): the did-you-mean helper — a bounded
 * Levenshtein distance over the CLI's own name tables (COMMANDS,
 * GLOBAL_FLAGS + the per-command rows, the subcommand lists). Zero deps
 * (Node built-ins only, like everything under cli/src); deliberately tiny —
 * a two-row DP with an early-exit cap, no fancy weighting.
 */

/** Classic two-row Levenshtein with an early exit: once every cell of the
 * current row exceeds `cap`, the final distance can only be larger (rows
 * never shrink), so the candidate is hopeless and we stop. */
function editDistance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row: number[] = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      row.push(value);
      if (value < best) best = value;
    }
    if (best > cap) return cap + 1;
    prev = row;
  }
  return prev[b.length];
}

/** Ranked candidates for a typo'd name: closest-first, at most 3. A prefix
 * hit (≥ 2 chars) outranks everything — `acute ses` means `sessions` — and
 * the distance bound tightens for short inputs (a 3-char needle matching
 * something 2 edits away is noise, not a hint). */
export function suggest(input: string, pool: readonly string[]): string[] {
  const needle = input.toLowerCase();
  if (needle === "") return [];
  const cap = needle.length <= 4 ? 1 : 2;
  const scored: Array<{ name: string; score: number }> = [];
  for (const candidate of pool) {
    if (candidate === input) continue;
    const haystack = candidate.toLowerCase();
    let score: number;
    if (needle.length >= 2 && haystack.startsWith(needle)) score = 0;
    else score = editDistance(needle, haystack, cap);
    if (score <= cap) scored.push({ name: candidate, score });
  }
  scored.sort((x, y) => x.score - y.score || x.name.localeCompare(y.name));
  return scored.slice(0, 3).map((s) => s.name);
}

/** The ready-made clause: ` — did you mean 'x'?` (or `… one of: 'x', 'y'?`),
 * "" when there is nothing close enough. `render` shapes each candidate
 * (commands stay bare, flags get their `--`). */
export function didYouMean(
  input: string,
  pool: readonly string[],
  render: (name: string) => string = (name) => `'${name}'`,
): string {
  const hits = suggest(input, pool);
  if (hits.length === 0) return "";
  if (hits.length === 1) return ` — did you mean ${render(hits[0])}?`;
  return ` — did you mean one of: ${hits.map(render).join(", ")}?`;
}
