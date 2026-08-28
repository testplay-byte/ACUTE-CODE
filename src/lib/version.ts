export const APP_NAME = "ACUTE-CODE";

/** Delivery phase this codebase is currently in; bump per phase plan. */
export const PHASE = 2;

/** ROUND-45: from package.json via the vite `define` injection — the same
 *  single source scripts/release/version.mjs enforces across the workspace. */
export const APP_VERSION: string = __APP_VERSION__;
