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
