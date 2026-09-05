/**
 * ROUND-61 (R61): the VISION RELAY — the owner's core directive: "for the
 * vision we are utilizing a separate model. The user can configure our
 * model for the vision itself… the provider completely separately", and
 * "if the main model supports vision then the user will be given an option
 * to configure that too".
 *
 * Modes (vision.mode — R66 moved the settings to their own section,
 * Settings → Image Analysis):
 *   · "off"      — refuse honestly (vision_disabled); screenshots still
 *                  return raster METADATA (the a11y tree remains the
 *                  observation channel — nothing breaks).
 *   · "separate" — chat-completions call to the CONFIGURED provider+model
 *                  with the image; the key rides the keyring pseudo-slot
 *                  "<providerId>-vision" (ACUTE_PROVIDER_<ID>_VISION — the
 *                  same credential-target + handoff-route pattern as every
 *                  other key; the owner pastes it in Settings → Image
 *                  Analysis and it lands in the OS credential store).
 *   · "main"     — the SAME relay, aimed at the turn's model — allowed only
 *                  when the model row has supports_vision = 1 (checked by
 *                  the caller; the relay trusts the passed provider/model
 *                  and uses the PRIMARY key slot).
 *
 * Deliberately fetch-direct (no AI SDK dependency): one POST, one
 * image-part, one text back. `fetchImpl` is injectable for tests.
 */
import type { SqliteDatabase } from "../storage/db.js";
import { resolveProvider } from "../providers/registry.js";
import type { ProviderRecord } from "../storage/providers.js";
import type { ProviderKeyring } from "../providers/registry.js";
import type { VisionRequest, VisionResult } from "./types.js";
import { visionDisabled } from "./errors.js";

export type VisionFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * ROUND-68 (R68-C, C6): the relay's retry delays for HTTP 429 / 5xx — the
 * owner's live trace had "Vision rate-limited (429)" killing observations
 * MID-FLOW (one 429 ended the whole observation; the 7-step Edge flow
 * stalled). Two retries with backoff: 1.5 s, then 3 s. Module-level
 * mutable copy + the setter below = the test hook (the private-allowlist
 * precedent pattern) so tests shrink the delays instead of sleeping.
 */
export const VISION_RETRY_DELAYS_MS: readonly number[] = [1500, 3000];
let visionRetryDelays: number[] = [...VISION_RETRY_DELAYS_MS];

/** Test-only: shrink/shape the retry delays (pass [] to disable retries). */
export function setVisionRetryDelaysForTest(delays: number[]): void {
  visionRetryDelays = [...delays];
}

/** Test-only: restore the shipped delays. */
export function resetVisionRetryDelaysForTest(): void {
  visionRetryDelays = [...VISION_RETRY_DELAYS_MS];
}

export interface VisionRelayConfig {
  mode: "separate" | "main";
  providerId: string;
  modelId: string;
}

export interface VisionRelayDeps {
  db: SqliteDatabase;
  keyring: ProviderKeyring;
  /** Override for tests; defaults to global fetch. */
  fetchImpl?: VisionFetch;
  /** Vision keyring id for "separate" mode ("<providerId>-vision"). */
  visionKeyringId?: string;
}

const RELAY_SYSTEM_PROMPT =
  "You are the vision subsystem of a desktop automation agent. Describe what is asked about the provided screenshot precisely and tersely. Prefer element names, positions, and states over prose. Never invent UI that is not visible.";

/** Resolve the key for the relay target (separate slot vs primary). */
export function resolveVisionKey(
  keyring: ProviderKeyring,
  providerId: string,
  mode: "separate" | "main",
  visionKeyringId?: string,
): string | undefined {
  if (mode === "separate") {
    const slotId = visionKeyringId ?? `${providerId}-vision`;
    const dedicated = keyring.get(slotId);
    if (dedicated !== undefined) return dedicated;
    // Honest fallback: the provider's PRIMARY key when no dedicated vision
    // key was pasted (one provider, one key — a valid configuration).
    return keyring.get(providerId);
  }
  return keyring.get(providerId);
}

/**
 * Relay one image + instruction to the configured vision model. Returns
 * either the description or a refusal-shaped error (never throws — the
 * caller shapes it into the tool output).
 */
export async function describeRaster(
  deps: VisionRelayDeps,
  config: VisionRelayConfig,
  request: VisionRequest,
): Promise<VisionResult | { error: string; code: "vision_disabled" | "vision_request_failed" | "vision_no_key" | "vision_no_provider" }> {
  const started = Date.now();
  const provider = resolveProvider(deps.db, config.providerId) as ProviderRecord | undefined;
  if (provider === undefined) {
    return { error: `vision provider '${config.providerId}' is not configured`, code: "vision_no_provider" };
  }
  const apiKey = resolveVisionKey(deps.keyring, config.providerId, config.mode, deps.visionKeyringId);
  if (apiKey === undefined) {
    return {
      error: `no API key for the vision model (provider '${config.providerId}'${config.mode === "separate" ? " — paste the dedicated vision key in Settings → Image Analysis, or the provider's primary key" : ""})`,
      code: "vision_no_key",
    };
  }
  const fetchImpl = deps.fetchImpl ?? ((url: string, init: RequestInit) => fetch(url, init));
  const baseUrl = (provider.baseUrl ?? "").replace(/\/+$/, "");
  const apiFormat = provider.apiFormat ?? "chat-completions";

  // R68-C (C6): the shared attempt body — ONE place per wire format (both
  // anthropic-messages and chat-completions ride the SAME retry loop).
  // Returns the parsed text, a TERMINAL error (no retry), or a RETRYABLE
  // marker: HTTP 429 or 5xx (the rate-limit/overload class the owner's
  // trace hit; every other non-OK — 4xx auth/shape errors — fails fast).
  const attempt = async (): Promise<
    { ok: true; text: string } | { ok: false; retryable: boolean; error: string }
  > => {
    let response: Response;
    if (apiFormat === "anthropic-messages") {
      response = await fetchImpl(`${baseUrl}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: config.modelId,
          max_tokens: 600,
          system: RELAY_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: request.instruction },
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: request.imageBase64 },
                },
              ],
            },
          ],
        }),
      });
    } else {
      // chat-completions (OpenRouter / OpenAI / Google's compat endpoint).
      response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: config.modelId,
          max_tokens: 600,
          messages: [
            {
              role: "system",
              content: RELAY_SYSTEM_PROMPT,
            },
            {
              role: "user",
              content: [
                { type: "text", text: request.instruction },
                {
                  type: "image_url",
                  image_url: { url: `data:image/png;base64,${request.imageBase64}` },
                },
              ],
            },
          ],
        }),
      });
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      const retryable = response.status === 429 || response.status >= 500;
      return {
        ok: false,
        retryable,
        error: `vision relay failed: ${response.status} ${response.statusText} — ${detail}`,
      };
    }
    let text: string;
    if (apiFormat === "anthropic-messages") {
      const body = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
      text = (body.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n").trim();
    } else {
      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
      };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content === "string") {
        text = content.trim();
      } else if (Array.isArray(content)) {
        text = content.map((c) => c.text ?? "").join("\n").trim();
      } else {
        text = "";
      }
    }
    if (text === "") {
      return { ok: false, retryable: false, error: "the vision model returned no text" };
    }
    return { ok: true, text };
  };

  let outcome = await attempt();
  for (
    let i = 0;
    i < visionRetryDelays.length && !outcome.ok && outcome.retryable;
    i++
  ) {
    await new Promise((resolve) => setTimeout(resolve, visionRetryDelays[i]!));
    outcome = await attempt();
  }
  if (!outcome.ok) {
    return { error: outcome.error, code: "vision_request_failed" };
  }
  const text = outcome.text;
  return {
    text: text.slice(0, 4000),
    model: config.modelId,
    provider: config.providerId,
    mode: config.mode,
    ms: Date.now() - started,
  };
}

/** The refusal shape when vision is OFF (mode:"off" or unconfigured). */
export function visionOffRefusal(why: string): ReturnType<typeof visionDisabled> {
  return visionDisabled(why);
}
