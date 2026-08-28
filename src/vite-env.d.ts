/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Dev bearer token for the sidecar REST API (never set in packaged builds). */
  readonly VITE_ACUTE_TOKEN?: string;
  /** Dev override for the sidecar base URL (default http://127.0.0.1:5178). */
  readonly VITE_ACUTE_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** ROUND-45: injected by vite.config.ts `define` from package.json "version"
 *  (single source — scripts/release/version.mjs syncs the other files). */
declare const __APP_VERSION__: string;
