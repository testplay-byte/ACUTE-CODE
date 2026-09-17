#!/usr/bin/env node
// scripts/release/check-mermaid-chunk.mjs
//
// ROUND-101 (R101-F, DEFECT 5 — the packaged-app failure mode made a
// build-time gate): the chat's mermaid diagrams load from a LAZY vite chunk
// (MermaidDiagram's dynamic `import("mermaid")`, ADR-0030). If bundling ever
// stops emitting that chunk (a config change, a vendor regression, a
// rollupOptions tweak), NOTHING fails at build time — the packaged WebView2
// app degrades SILENTLY at runtime: every diagram falls back to the amber
// note + source (the very "not showing me the properly rendered flow
// diagrams" owner report of v0.98.0). This script closes that hole: it globs
// dist/assets/mermaid-*.js after `vite build` and fails LOUDLY when the
// chunk is missing.
//
// Usage: node scripts/release/check-mermaid-chunk.mjs   (wired into `pnpm build`)
// Exit codes: 0 the chunk shipped (file + size printed), 1 it did not.
//
// Stdlib only — the same fs+path shape as scripts/release/version.mjs.

import { readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const assetsDir = join(repoRoot, "dist", "assets");

/** Tiny glob: the mermaid lazy chunk's actual shape. Vite names a
 * dynamic-import chunk after the imported module — mermaid@11's ESM entry
 * is dist/mermaid.core.mjs, so the chunk today is `mermaid.core-<hash>.js`
 * (verified against a real `vite build`: 683.85 kB); a future rename to a
 * plain `mermaid-<hash>.js` stays covered — ANY `mermaid*`-prefixed .js in
 * dist/assets means the entry module was actually chunked (if it were
 * inlined into the main bundle, NO mermaid-prefixed chunk can exist: the
 * internal diagram sub-chunks are named after their own modules). One
 * readdir, no glob dependency, deterministic sorted order. A missing
 * dist/assets entirely (no `vite build` ran) counts as NOT found — the
 * loud failure below is the honest answer either way. */
function findMermaidChunks() {
  let entries;
  try {
    entries = readdirSync(assetsDir);
  } catch {
    return [];
  }
  return entries.filter((name) => /^mermaid[A-Za-z0-9._-]*\.js$/.test(name)).sort();
}

const chunks = findMermaidChunks();
if (chunks.length === 0) {
  console.error("");
  console.error("FAIL  check-mermaid-chunk: no dist/assets/mermaid*.js chunk found");
  console.error("      (today's shape: mermaid.core-<hash>.js — mermaid@11's ESM entry).");
  console.error("      The chat's diagram renderer lazy-imports mermaid (ADR-0030);");
  console.error("      without this chunk EVERY diagram in the packaged app silently");
  console.error("      degrades to the amber source fallback at runtime.");
  console.error("      Did `vite build` emit dist/assets? Did the dynamic import move or");
  console.error("      get inlined? (src/components/project-chat/MermaidDiagram.tsx)");
  process.exit(1);
}

for (const name of chunks) {
  const size = statSync(join(assetsDir, name)).size;
  // ~1 decimal in KiB — the megabyte-scale chunk is the point of the laziness.
  console.log(`ok    check-mermaid-chunk: ${name} (${(size / 1024).toFixed(1)} KiB)`);
}
process.exit(0);
