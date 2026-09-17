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
  /** ROUND-37: wire format (chat-completions | anthropic-messages | responses). */
  apiFormat?: string;
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

/**
 * R98-H (owner: "Adding other providers: I am unable to select
 * OpenAI-compatible providers there… currently there are only options to
 * select Anthropic, Google, NVIDIA, OpenAI, and OpenRouter"): create a custom
 * OpenAI-compatible provider row from the wizard via POST /api/v1/providers.
 *
 * The body is EXACTLY {name, baseUrl, apiFormat} — no id (the sidecar derives
 * it via slugifyProviderId → prv_…), no kind (stamped "openai-compatible"),
 * no enabled (stamped true), and NO KEY EVER (the key lands via the Tauri
 * keyring command, never a REST body). Returns the created row (201) as a
 * ProviderView; a 409 name-conflict rejects with the server's message.
 */
export interface CreateCustomProviderInput {
  name: string;
  baseUrl: string;
  apiFormat?: string;
}

export async function createCustomProvider(input: CreateCustomProviderInput): Promise<ProviderView> {
  return request<ProviderView>("/providers", { method: "POST", json: input });
}

/**
 * Client-side OpenRouter default (owner directive): the wizard must render
 * fully EVEN IF GET /providers returns [] or fails — so OpenRouter is always
 * available as the DEFAULT SELECTED provider, chosen entirely client-side.
 * Server rows are merged in additionally when present; a server-provided
 * openrouter row supersedes this synthesized one.
 */
export const OPENROUTER_FALLBACK: ProviderView = {
  id: "openrouter",
  name: "OpenRouter",
  kind: "openai-compatible",
  baseUrl: "https://openrouter.ai/api/v1",
  enabled: true,
  createdAt: "",
  hasKey: false,
};

export interface ProviderOption {
  provider: ProviderView;
  /** True when the row was synthesized client-side (not served by the API). */
  clientDefault?: boolean;
}

/** Server rows (in order), plus the client-side OpenRouter default when the
 *  catalog does not already contain it. Never empty — always ≥1 option. */
export function withClientDefaults(server: ProviderView[]): ProviderOption[] {
  const options: ProviderOption[] = server.map((provider) => ({ provider }));
  if (!server.some((p) => p.id === OPENROUTER_FALLBACK.id)) {
    options.push({ provider: OPENROUTER_FALLBACK, clientDefault: true });
  }
  return options;
}

export async function fetchModels(providerId: string): Promise<ProviderModel[]> {
  const body = await request<{ models: ProviderModel[] }>(`/providers/${encodeURIComponent(providerId)}/models`);
  return body.models;
}

/**
 * POST /providers/{id}/test — a real one-token completion through the sidecar
 * (validates the stored key AND the model). Failures are honest: a missing
 * route, a rejected key, or an unknown model all come back ok:false with the
 * reason; nothing is masked as a success.
 */
export async function testConnection(providerId: string, model?: string): Promise<ConnectionTestResult> {
  try {
    const body = await request<{ ok: boolean; latencyMs?: number; model?: string; message?: string }>(
      `/providers/${encodeURIComponent(providerId)}/test`,
      { method: "POST", json: model ? { model } : {} },
    );
    return { ok: body.ok, latencyMs: body.latencyMs, model: body.model, message: body.message };
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 404) {
      return { ok: false, message: "Provider or test route not found on this sidecar." };
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
 * shell) resolves to null; callers show a "run the desktop app" note instead
 * of ever falling back to REST/localStorage.
 *
 * R102-A: the shell command now returns a KeyStoreReport — WHERE the key
 * landed ("credential-manager" on Windows, "secret-service" or
 * "key-file" on Linux) + the disclosure note for key-file saves (the
 * ADR-0031-addendum fallback: no reachable Secret Service →
 * ~/.acute/provider-keys.json, 0600). The Settings surfaces render the
 * note amber so the owner always knows which store holds the key.
 */
export interface KeyStoreReport {
  store: "credential-manager" | "secret-service" | "key-file";
  note?: string | null;
}

export async function storeProviderKey(
  providerId: string,
  key: string,
): Promise<KeyStoreReport | null> {
  if (!isTauri()) return null;
  return tauriInvoke<KeyStoreReport>("store_provider_key", { providerId, key });
}

/**
 * ROUND-92 (R92-D3): store ONE POOL SLOT's key via the slot-aware shell
 * command — Credential Manager target `ACUTE-CODE/provider/<providerId>-slot<N>`
 * (slot 1–31; slot 0 is the primary and belongs to storeProviderKey), the
 * provider-pool-slots note line so it survives restarts, and the hot handoff
 * POST to the sidecar's internal route from the Rust side. This is THE fix
 * for the R47 bug where the pool UI's add invoked the slot-less
 * store_provider_key and OVERWROTE the primary key. Browser dev (no shell)
 * resolves to null — the REST pool routes (PUT /providers/:id/keys/:slot)
 * are the browser path. R102-A: returns the KeyStoreReport (see
 * storeProviderKey above) so the pool add-row can disclose key-file saves.
 */
export async function storeProviderKeySlot(
  providerId: string,
  slot: number,
  key: string,
): Promise<KeyStoreReport | null> {
  if (!isTauri()) return null;
  return tauriInvoke<KeyStoreReport>("store_provider_key_slot", { providerId, slot, key });
}

/**
 * ROUND-92 (R92-D3): remove ONE POOL SLOT's durable credential via the
 * slot-aware shell command (canonical + legacy Credential Manager targets +
 * the note line). Unlike the store command there is no Rust-side handoff,
 * so the caller follows up with the REST pool DELETE to clear the RUNNING
 * sidecar's in-memory keyring (the listing refetch then shows the truth
 * without a restart). Browser dev (no shell) resolves to false — the REST
 * DELETE alone is the browser path.
 */
export async function removeProviderKeySlot(providerId: string, slot: number): Promise<boolean> {
  if (!isTauri()) return false;
  await tauriInvoke<void>("remove_provider_key_slot", { providerId, slot });
  return true;
}

export async function providerKeyStatus(providerId: string): Promise<boolean> {
  if (!isTauri()) return false;
  return tauriInvoke<boolean>("provider_key_status", { providerId });
}

/**
 * ROUND-90 (R90-A5): purge the provider's key from the OS secure store
 * (Windows Credential Manager, canonical + legacy targets) and drop its
 * custom-provider note line. Called by Settings after a SUCCESSFUL
 * DELETE /providers/:id — the sidecar's route only clears its in-memory
 * keyring, so without this the stored key survived the delete and a
 * re-added provider showed "key stored" on the OLD key after the next
 * sidecar spawn. Best-effort by design: the row is already gone
 * server-side, so a failure here is logged by the caller, never fatal.
 * Browser dev (no shell) resolves to true — nothing to purge.
 */
export async function removeProviderKey(providerId: string): Promise<boolean> {
  if (!isTauri()) return true;
  try {
    await tauriInvoke<void>("remove_provider_key", { providerId });
    return true;
  } catch {
    return false;
  }
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
 * - true  → the completion flag is absent (true first run for this profile).
 *           Key state does NOT gate the wizard — it already having a key is
 *           surfaced as connection status inside PlugBrain instead (owner
 *           directive: the wizard must actually show on first run).
 * - false → flag set (completed or skipped)
 * - null  → never returned today; kept for callers that treat it as
 *           "inconclusive, retry" (slow boot window).
 */
export async function shouldRunSetup(): Promise<boolean | null> {
  if (isSetupDone()) return false;
  return true;
}
