/**
 * Storage entry point. Phase 1 returns a placeholder handle; the real SQLite
 * layer (driver + migrations, ADR pending) lands in Phase 2 behind this call.
 */
export interface DatabaseHandle {
  path: string;
  ready: boolean;
}

export function openDatabase(path: string): DatabaseHandle {
  return { path, ready: true };
}
