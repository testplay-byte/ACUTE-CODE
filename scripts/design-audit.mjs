#!/usr/bin/env node
/**
 * Design-language audit gate (ROUND-100 R100-C — research §C1.6,
 * docs/design-language/TOKENS.md + USAGE.md §2).
 *
 * Counts per-rule violations in the TS/TSX source under src/components/** and
 * src/pages/** (excluding *.test.* files, src/components/onboarding/** — the
 * wizard keeps its sanctioned DNA — and src/components/demos/** — reference
 * mockups, not shipped code):
 *
 *   R1  hex color literals in className/style strings   #[0-9a-fA-F]{3,8}\b
 *   R2  arbitrary Tailwind px values                    (text|w|h|rounded|p|m|gap|max-w|min-w|leading|tracking)-[<number>[unit]]
 *   R3  sub-10px text                                   text-[8|9[.N]px]
 *   R4  heavy weights                                   font-bold / font-extrabold / font-black
 *   R5  JS hover handlers                               onMouseEnter / onMouseLeave
 *
 * Ratchet: scripts/design-audit-baseline.json pins the per-rule counts.
 * Exit 0 when every count is <= its baseline; exit 1 with a per-rule diff
 * table when any count EXCEEDS its baseline. Re-pin deliberately with
 * `--update-baseline` (or UPDATE_BASELINE=1) — that is how a finished wave
 * lowers the bar for everyone after it.
 *
 * Known limitations (deliberate — simple and honest beats a half-parser):
 *  - Comments are stripped by a NON-NESTED line/block comment remover that
 *    does not understand string literals: a "//" inside a string (a URL)
 *    truncates the rest of that LINE, and an unmatched block-comment opener
 *    inside a string truncates to the next closer or EOF. Both effects can
 *    only UNDERCOUNT (they delete source text, never add it), they are
 *    deterministic, and they are rare — documented rather than solved.
 *  - Template-literal CSS is scanned as raw text on purpose: a hex literal
 *    inside a template block is a real hex literal in the shipped source.
 *  - R2's prefix alternation matches substrings the way plain regexes do:
 *    `min-h-[36px]` is counted via its `h-[36px]` interior (h-family), while
 *    `pt-`/`mt-`/`pb-` style shorthands are NOT counted (not in the rule).
 *  - The sanctioned palettes that live inside the scanned tree (usage-helpers'
 *    MODEL_PALETTE, highlight.ts syntax colors, SEMANTIC_COLORS re-stated in
 *    components) ARE counted and pinned in the baseline: the ratchet guards
 *    against GROWTH, not existence; cleanups lower the pin.
 *
 * Usage:
 *   node scripts/design-audit.mjs                  audit against the baseline
 *   node scripts/design-audit.mjs --update-baseline   re-pin (or UPDATE_BASELINE=1)
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = resolve(repoRoot, "scripts", "design-audit-baseline.json");

// The scan surface: working-UI source only. src/lib (themes.ts, semantics.ts,
// the token pipeline itself) and src/index.css are NOT scanned — they are the
// sanctioned source of the values this script polices the APPLICATION of.
const SCAN_ROOTS = ["src/components", "src/pages"];
// Whole-directory exclusions, relative to src/components (research §C1.6: the
// wizard's font-black heroes + demo DNA are exempt by design).
const EXCLUDED_DIRS = new Set(
  ["onboarding", "demos"].map((d) => resolve(repoRoot, "src", "components", d)),
);

const RULES = [
  {
    id: "R1",
    label: "hex color literals (className/style strings)",
    hint: "use the token pipeline (TOKENS §1) — extend themes.ts if it can't express it",
    regex: /#[0-9a-fA-F]{3,8}\b/g,
  },
  {
    id: "R2",
    label: "arbitrary Tailwind px values",
    hint: "snap to the token scales (TOKENS §2–4): scale utilities or documented steps",
    regex: /(?:text|w|h|rounded|p|m|gap|max-w|min-w|leading|tracking)-\[\d+(?:\.\d+)?(?:px|rem|em|%)?\]/g,
  },
  {
    id: "R3",
    label: "sub-10px text",
    hint: "hard floor 10px (TOKENS §2) — snap 8/8.5/9/9.5px to 10 or 11",
    regex: /text-\[[89](?:\.\d+)?px\]/g,
  },
  {
    id: "R4",
    label: "font-bold / font-extrabold / font-black",
    hint: "the weight law (TOKENS §2): 400 chrome, 500 active, 600 headers/titles/buttons",
    regex: /\bfont-(?:bold|black|extrabold)\b/g,
  },
  {
    id: "R5",
    label: "JS hover handlers (onMouseEnter/onMouseLeave)",
    hint: "hover is a CSS class — hover:bg-hover on the CSS-var leg (TOKENS §6)",
    regex: /\bonMouse(?:Enter|Leave)\b/g,
  },
];

/** Deterministic recursive walk (sorted entries => reproducible counts). */
function collectFiles(dir) {
  const out = [];
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(abs)) continue;
      out.push(...collectFiles(abs));
    } else if (entry.isFile()) {
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (/\.test\./.test(entry.name)) continue;
      out.push(abs);
    }
  }
  return out;
}

/**
 * Strip // line comments (newline kept, so tokens never splice across lines)
 * and non-nested block comments (replaced with one space, so adjacent tokens
 * never splice). String-literal-blind — see the header's limitations note.
 */
function stripComments(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    if (source[i] === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
    } else if (source[i] === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i = i < source.length ? i + 2 : source.length;
      out += " ";
    } else {
      out += source[i];
      i++;
    }
  }
  return out;
}

function audit() {
  const files = SCAN_ROOTS.flatMap((root) => collectFiles(resolve(repoRoot, root))).sort();
  const counts = Object.fromEntries(RULES.map((r) => [r.id, 0]));
  const hotspots = Object.fromEntries(RULES.map((r) => [r.id, []])); // top files per rule
  for (const file of files) {
    const text = stripComments(readFileSync(file, "utf8"));
    for (const rule of RULES) {
      const hits = text.match(rule.regex);
      if (hits && hits.length > 0) {
        counts[rule.id] += hits.length;
        hotspots[rule.id].push([relative(repoRoot, file).split("\\").join("/"), hits.length]);
      }
    }
  }
  for (const rule of RULES) {
    hotspots[rule.id].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }
  return { files: files.length, counts, hotspots };
}

const updateBaseline =
  process.argv.includes("--update-baseline") || process.env.UPDATE_BASELINE === "1";

const { files, counts, hotspots } = audit();

if (updateBaseline) {
  const baseline = {
    generated: new Date().toISOString().slice(0, 10),
    note:
      "Pinned by scripts/design-audit.mjs --update-baseline. The ratchet: counts may only go DOWN. A wave that finishes a cleanup re-pins (USAGE §2).",
    files,
    rules: counts,
  };
  writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  const summary = RULES.map((r) => `${r.id} ${counts[r.id]}`).join(", ");
  console.log(`design-audit: baseline re-pinned (${files} files; ${summary}) -> ${baselinePath}`);
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  console.error("design-audit: no baseline found — run `node scripts/design-audit.mjs --update-baseline` to pin today's counts first.");
  process.exit(1);
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const rows = RULES.map((rule) => {
  const base = baseline.rules?.[rule.id] ?? 0;
  return { rule, base, current: counts[rule.id], delta: counts[rule.id] - base };
});
const failures = rows.filter((r) => r.current > r.base);

if (failures.length > 0) {
  console.error("design-audit: FAILED — counts exceed the pinned baseline:");
  console.error("  rule  baseline  current  delta");
  for (const { rule, base, current, delta } of rows) {
    const mark = current > base ? "  <-- OVER" : "";
    console.error(`  ${rule.id}    ${String(base).padStart(6)}  ${String(current).padStart(6)}  ${delta >= 0 ? "+" : ""}${delta}${mark}`);
  }
  for (const { rule } of failures) {
    const top = hotspots[rule.id].slice(0, 5).map(([f, n]) => `${f} (${n})`).join(", ");
    console.error(`  ${rule.id} hotspots: ${top || "(none)"}`);
    console.error(`  ${rule.id} fix: ${rule.hint}`);
  }
  console.error("If the growth is intended (a sanctioned exception), document it and re-pin: node scripts/design-audit.mjs --update-baseline");
  process.exit(1);
}

const summary = RULES.map((r) => `${r.id} ${counts[r.id]}/${baseline.rules?.[r.id] ?? 0}`).join(", ");
console.log(`design-audit: clean (${files} files scanned; ${summary} — all at or below baseline)`);
