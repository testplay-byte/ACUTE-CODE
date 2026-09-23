/**
 * provider-display.ts — the provider detail page's pure display derivations
 * (R118-E, §2B): every line the rebuilt hero card, the key pool rows, and
 * the NAME-only model rows render is computed HERE so the screen renders
 * and the jest suite pins the same truth:
 *
 *   · modelRowLabel   — displayName ?? cleanModelName — NEVER the raw id
 *                       (the owner: "It should not show the model ID. It
 *                       should only show the model name.")
 *   · modelFactsLine  — the quiet sizing/pricing mono line (hoisted from
 *                       [id].tsx's private helper, byte-identical)
 *   · keySlotMetaLine — the key pool row's ONE mono meta line: the mask,
 *                       plus " · used {timeAgoShort}" when the sidecar
 *                       reports a last use
 *   · apiFormatLabel  — the hero card's context line ("Chat completions
 *                       API" / "Anthropic messages API" / "Responses API";
 *                       "" when the row carries nothing — the caller
 *                       omits the line)
 *
 * PURE MODULE — no React Native import (the pure-logic convention), typed
 * off config.ts's wire shapes only.
 */

import { cleanModelName, type ModelRecord, type ProviderKeySlot } from "./config";
import { formatTokens } from "./context-meter";
import { timeAgoShort } from "@/lib/time-ago";

/**
 * The saved-model row's line 1 (and every surface that names a saved model):
 * the display name when one is set (non-blank), else the HUMANIZED model id
 * — never the raw id itself. Pure.
 */
export function modelRowLabel(model: Pick<ModelRecord, "modelId" | "displayName">): string {
  const displayName = model.displayName;
  if (displayName !== null && displayName.trim() !== "") return displayName;
  return cleanModelName(model.modelId);
}

/**
 * The model row's facts line: "131k ctx · $0.14 in · $0.60 out · 8k max
 * out" — context always (unknown → "—"), prices and max output only when
 * set (the PC's honest-omission discipline — never a fabricated 0). Pure.
 */
export function modelFactsLine(
  model: Pick<ModelRecord, "contextWindow" | "inputPricePerMtok" | "outputPricePerMtok" | "maxOutputTokens">,
): string {
  const parts: string[] = [
    `${model.contextWindow === null ? "—" : formatTokens(model.contextWindow)} ctx`,
  ];
  if (model.inputPricePerMtok !== null) parts.push(`$${model.inputPricePerMtok} in`);
  if (model.outputPricePerMtok !== null) parts.push(`$${model.outputPricePerMtok} out`);
  if (model.maxOutputTokens !== null) parts.push(`${formatTokens(model.maxOutputTokens)} max out`);
  return parts.join(" · ");
}

/**
 * The key pool row's ONE mono meta line (TypeMono 12/18 — KEY_SLOT_MONO
 * below): a held key renders its mask (the pool's `abcd…wxyz`, the honest
 * fallback dots when the sidecar sent none) plus " · used {short}" when
 * the OPTIONAL lastUsedAt field rides the slot (an older sidecar omits it
 * — the line degrades to the mask only); an empty slot renders the honest
 * em dash. An unparseable timestamp is OMITTED, never rendered as a
 * garbage age. Pure; `now` is injectable for the tests.
 */
export function keySlotMetaLine(
  slot: Pick<ProviderKeySlot, "hasKey" | "masked" | "lastUsedAt"> & { slot?: number },
  now: number = Date.now(),
): string {
  if (!slot.hasKey) return "—";
  const mask = slot.masked ?? "••••••••";
  const used =
    slot.lastUsedAt !== undefined && slot.lastUsedAt !== null
      ? new Date(slot.lastUsedAt).getTime()
      : NaN;
  if (!Number.isFinite(used)) return mask;
  return `${mask} · used ${timeAgoShort(used, now)}`;
}

/**
 * The key-pool row's mono type cut — 12/18, ONE step below TypeMono's own
 * 13/19 recipe (the mono ladder's caption size; the spec's §5.5 rhythm
 * pin). The screen composes these into `slotMasked`; the jest suite pins
 * them so the cut cannot drift back to the old 11/15 whisper.
 */
export const KEY_SLOT_MONO_SIZE = 12;
export const KEY_SLOT_MONO_LINE = 18;

/**
 * R120-M (round-120 §1 item 17 — the model editor's numeric fields: "show
 * the simplified form on blur … 1000000 → '1M', 26000 → '26K', 1000 →
 * '1K'"; the full digits return on focus): the BLURRED display form of a
 * numeric field's raw text — K/M/B for the large counts (≥ 1,000), the
 * raw digits below, and a NON-NUMERIC / blank value passes through
 * untouched (the save's per-field validation owns that honesty; the blur
 * display never invents). Lossy by design — the draft keeps the exact
 * string internally; this is the at-a-glance read. Pure.
 */
export function formatCompactCount(raw: string): string {
  const trimmed = raw.trim();
  const value = Number(trimmed);
  if (trimmed === "" || !Number.isFinite(value) || value < 0) return raw;
  if (value < 1_000) return trimmed;
  const units: Array<[number, string]> = [
    [1_000_000_000, "B"],
    [1_000_000, "M"],
    [1_000, "K"],
  ];
  for (const [unit, suffix] of units) {
    if (value >= unit) {
      const scaled = value / unit;
      // ≤ 2 decimals, trailing zeros stripped ("26K", "1.05M", "1M").
      const text = `${Math.round(scaled * 100) / 100}`.replace(/\.0+$/, "");
      return `${text}${suffix}`;
    }
  }
  return trimmed;
}

/**
 * R120-M (round-120 §1 item 14 — the key row's bottom-up menu, "other
 * sensible options (e.g. Copy key id)"): the COPYABLE key reference — the
 * key's identity as the phone knows it (the provider id + the slot + the
 * mask), shareable in a bug report or matched against the provider's own
 * dashboard WITHOUT ever exposing the value (the reveal route is
 * device-token blocklisted by design — config.ts's security note). A
 * missing mask degrades to the slot reference alone. Pure.
 */
export function keyReferenceText(
  slot: Pick<ProviderKeySlot, "slot" | "masked">,
  providerId: string,
): string {
  const base = slot.slot === 0 ? `${providerId} primary key` : `${providerId} key ${slot.slot}`;
  return slot.masked !== null && slot.masked !== "" ? `${base} · ${slot.masked}` : base;
}

/**
 * The hero card's context line under the provider name: the API format's
 * human name. "" for an absent format AND for an unknown enum value (an
 * older/newer sidecar's field the phone does not know degrades to the
 * omitted line — the honest-omission discipline, never the raw machine
 * token on the identity card). Pure.
 *
 * R120-M (§1 item 10 — "Below the provider name it says 'Chat Completion
 * API' — replace with the base URL directly, no heading"): DEAD on the
 * provider hero (the base URL itself renders under the name now); zero
 * production callers remain. Tombstoned, not deleted — the wire vocabulary
 * + its jest pins survive for whatever next reads apiFormat (a future
 * wave's deletion is safe).
 */
export function apiFormatLabel(apiFormat: string | null | undefined): string {
  const format = apiFormat?.trim() ?? "";
  const labels: Record<string, string> = {
    "chat-completions": "Chat completions API",
    "anthropic-messages": "Anthropic messages API",
    responses: "Responses API",
  };
  return labels[format] ?? "";
}
