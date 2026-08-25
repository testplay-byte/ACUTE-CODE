import type { QueryClient } from "@tanstack/react-query";

/**
 * ROUND-39: a module-level accessor for the app's QueryClient singleton. The
 * stream store (and other non-component code) needs to invalidate queries
 * (file-tree refresh after a write_file, session list refresh when a stream
 * ends) even when no React panel is mounted. main.tsx calls setQueryClient
 * once at boot; everyone else reads via getQueryClient().
 *
 * Why not import directly? The QueryClient is created in main.tsx (where the
 * React tree mounts); a circular-import hazard if anything in the lib/* tree
 * tried to import main.tsx. This indirection sidesteps it.
 */
let instance: QueryClient | null = null;

export function setQueryClient(qc: QueryClient): void {
  instance = qc;
}

export function getQueryClient(): QueryClient | null {
  return instance;
}
