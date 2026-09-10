// ─────────────────────────────────────────────────────────────────────────────
// R84 (Wave 2-a): the routes' shared response-envelope helper, extracted
// verbatim from server.ts — behavior-identical, test-guarded.
// ─────────────────────────────────────────────────────────────────────────────

/** API.md §1.3: every non-2xx response carries this single shape. */
export function errorBody(code: string, message: string, details?: Record<string, unknown>): unknown {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}
