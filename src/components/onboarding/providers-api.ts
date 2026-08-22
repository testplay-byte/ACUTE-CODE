import { useConfigStore } from "../../lib/config-store";

/**
 * Live backend access for the setup wizard (API.md §8 Providers).
 *
 * SECURITY (SPEC hard rule): API keys NEVER travel through this module's REST
 * calls or localStorage. `storeProviderKey` invokes the Tauri shell command
 * which writes Windows Credential Manager (`ACUTE-CODE/provider/<providerId>`)
 * and pushes to the sidecar's internal handoff route from the Rust side.
 */

/** Provider row as served by GET /api/v1/providers — never carries key material. */
export interface ProviderView {
  id: string;
  name: string;
  kind: string;
  baseUrl: string | null;
  enabled: boolean;
  createdAt: string;
  hasKey: boolean;
}

export interface ProviderModel {
  id: string;
  name?: string;
  contextWindow?: number;
  vision?: boolean;
}

export interface ConnectionTestResult {
  ok: boolean;
  latencyMs?: number;
  model?: string;
  message?: string;
}

type TauriGlobal = {
  core: {
    invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
};

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI__" in window;
}

async function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const tauri = (window as { __TAURI__?: TauriGlobal }).__TAURI__;
  if (!tauri) throw new Error("Tauri shell unavailable");
  return tauri.core.invoke(command, args) as Promise<T>;
}

function request<T>(path: string, init?: { method?: string; json?: unknown }): Promise<T> {
  const { baseUrl, token } = useConfigStore.getState();
  const headers: Record<string, string> = {};
  if (init?.json !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;

  return fetch(`${baseUrl}/api/v1${path}`, {
    method: init?.method ?? "GET",
    headers,
    body: init?.json !== undefined ? JSON.stringify(init.json) : undefined,
  }).then(async (res) => {
    const text = await res.text();
    let body: unknown = undefined;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    if (!res.ok) {
      const envelope =
        body && typeof body === "object" && "error" in body
          ? (body as { error: { code?: string; message?: string } }).error
          : undefined;
      const err = new Error(
        envelope?.message ?? `Request failed with HTTP ${res.status}`,
      ) as Error & { status?: number; code?: string };
      err.status = res.status;
      err.code = envelope?.code ?? "UNKNOWN";
      throw err;
    }
    return body as T;
  });
}

export async function fetchProviders(): Promise<ProviderView[]> {
  const body = await request<{ providers: ProviderView[] }>("/providers");
  return body.providers;
}

export async function fetchModels(providerId: string): Promise<ProviderModel[]> {
  const body = await request<{ models: ProviderModel[] }>(`/providers/${encodeURIComponent(providerId)}/models`);
  return body.models;
}

/**
 * POST /providers/{id}/test — one-token completion through the sidecar. When
 * the route is not implemented yet (404), fall back to a models fetch, which
 * proves the same two things that matter: sidecar reachable + key accepted
 * upstream enough to list the catalog.
 */
export async function testConnection(providerId: string, model?: string): Promise<ConnectionTestResult> {
  try {
    const body = await request<{ ok: boolean; latencyMs?: number; model?: string }>(
      `/providers/${encodeURIComponent(providerId)}/test`,
      { method: "POST", json: model ? { model } : {} },
    );
    return { ok: body.ok, latencyMs: body.latencyMs, model: body.model };
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 404) {
      await fetchModels(providerId);
      return { ok: true, message: "Catalog fetched — provider reachable." };
    }
    if (status === 409) {
      return { ok: false, message: "No key stored for this provider yet." };
    }
    if (status === 429) {
      return { ok: false, message: "Provider rate-limited the test call." };
    }
    const message = error instanceof Error ? error.message : "Connection test failed.";
    return { ok: false, message };
  }
}

/**
 * Store the key via the Tauri shell → Credential Manager. Browser dev (no
 * shell) resolves to false; callers show a "run the desktop app" note instead
 * of ever falling back to REST/localStorage.
 */
export async function storeProviderKey(providerId: string, key: string): Promise<boolean> {
  if (!isTauri()) return false;
  await tauriInvoke<void>("store_provider_key", { providerId, key });
  return true;
}

export async function providerKeyStatus(providerId: string): Promise<boolean> {
  if (!isTauri()) return false;
  return tauriInvoke<boolean>("provider_key_status", { providerId });
}

// ---------------------------------------------------------------------------
// First-run flag (plan-ui-fidelity.md wave 1 §2)
// ---------------------------------------------------------------------------

const SETUP_DONE_KEY = "acute.setupDone";

export function isSetupDone(): boolean {
  return typeof localStorage !== "undefined" && localStorage.getItem(SETUP_DONE_KEY) === "1";
}

/** Called on wizard completion AND on dismissal ("skip for now"). */
export function markSetupDone(): void {
  if (typeof localStorage !== "undefined") localStorage.setItem(SETUP_DONE_KEY, "1");
}

/**
 * Tri-state first-run answer:
 * - true  → flag absent AND live providers all lack keys (definitive first run)
 * - false → flag set, or at least one provider has a key
 * - null  → inconclusive (sidecar unreachable — browser dev, tests, slow boot)
 */
export async function shouldRunSetup(): Promise<boolean | null> {
  if (isSetupDone()) return false;
  try {
    const providers = await fetchProviders();
    return providers.every((p) => !p.hasKey);
  } catch {
    return null;
  }
}
