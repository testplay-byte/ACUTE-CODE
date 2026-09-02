import { motion } from "framer-motion";
import { KeyRound } from "lucide-react";
import type { DetailedUsageKey, KeyPoolSlot, ProviderView } from "../../lib/api";
import type { ThemeStyles } from "../../lib/themes";
import { formatWhen } from "../../lib/format";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { staggerContainer, staggerItem } from "../../lib/motion";
import { withAlpha } from "../dashboard/helpers";
import { formatCompactTokens, formatCost } from "./usage-helpers";

/**
 * ROUND-64 (R64-e, owner: "I want the ability to track each individual API
 * key's stats, like the total usage of that API key, total tokens used on
 * that API key, and all other stuff like that… in the usage section"):
 * the /usage screen's "API keys" section — ONE CARD PER KEY.
 *
 * The join: `usageKeys` (GET /usage/detailed's keys rollup, provider × pool
 * slot, cost-desc) × the live keyring's masked poolInfo (GET
 * /providers/:id/keys via useUsageKeyPools). Both sides matter —
 *   · a configured key with NO usage still gets a card (zeros + "not used
 *     yet") so the owner sees every key he configured;
 *   · usage on a slot the keyring no longer holds renders honestly as a
 *     "removed key" (the spend was real, the key is gone);
 *   · usage on an unknown PROVIDER renders the raw id with a "removed
 *     provider" note (tombstoned rows, migration 0010).
 *
 * Design: the neighboring cards' DNA (ModelCards/ProjectsDrilldown) —
 * useThemeStyles colors, rounded-[12px] cards with subtle borders, mono
 * masked previews, tabular-nums numerics, a share-of-total bar relative to
 * the priciest key, and the semantic danger color only for removals.
 */

/** One rendered card: the join of a pool slot with its usage rollup. */
interface KeyCardView {
  /** React key + tooltip identity. */
  id: string;
  providerId: string;
  /** Display name — the provider row's name, or the raw id when gone. */
  providerName: string;
  slot: number;
  slotLabel: string;
  /** Masked preview from poolInfo (null when the keyring no longer holds it). */
  masked: string | null;
  usage: DetailedUsageKey | null;
  /** Usage exists but the keyring no longer holds this slot. */
  removedKey: boolean;
  /** Usage exists but the provider row is gone (tombstone). */
  removedProvider: boolean;
}

function slotLabel(slot: number): string {
  return slot === 0 ? "Primary key" : `Pool slot ${slot}`;
}

/**
 * Builds the card list: every CONFIGURED slot (poolInfo hasKey) plus every
 * slot with recorded usage — cost-desc for the spenders (the aggregate's
 * order), then the not-used-yet keys by provider name and slot number so
 * the section is deterministic. `settledPoolIds`/`providersSettled` gate
 * the removal flags: an in-flight or failed fetch never reads as removal.
 */
function buildCards(
  usageKeys: DetailedUsageKey[],
  providers: ProviderView[],
  poolsById: Map<string, KeyPoolSlot[]>,
  settledPoolIds: Set<string>,
  providersSettled: boolean,
): KeyCardView[] {
  const providerById = new Map(providers.map((p) => [p.id, p]));
  const usageBySlot = new Map(usageKeys.map((k) => [`${k.providerId}:${k.keySlot}`, k]));

  const cards: KeyCardView[] = [];
  const seen = new Set<string>();
  const push = (providerId: string, providerName: string, slot: number, masked: string | null): void => {
    const id = `${providerId}:${slot}`;
    if (seen.has(id)) return;
    seen.add(id);
    const held = masked !== null;
    const usage = usageBySlot.get(id) ?? null;
    const poolKnown = settledPoolIds.has(providerId);
    cards.push({
      id,
      providerId,
      providerName,
      slot,
      slotLabel: slotLabel(slot),
      masked,
      usage,
      // A removal is only claimed when the source of truth actually
      // answered: the pool listing succeeded (key gone) / the providers
      // list settled (row gone). In-flight or failed fetches stay silent.
      removedKey: usage !== null && !held && poolKnown,
      removedProvider: usage !== null && !providerById.has(providerId) && providersSettled,
    });
  };

  // Configured keys (the keyring's masked view) — every held slot shows,
  // used or not. Slot 0 without a key stays hidden (nothing to show).
  for (const provider of providers) {
    for (const slotInfo of poolsById.get(provider.id) ?? []) {
      if (slotInfo.hasKey) push(provider.id, provider.name, slotInfo.slot, slotInfo.masked);
    }
  }
  // Usage-only rows: slots (or whole providers) that spent but are no
  // longer configured — rendered with the raw ids, flagged honestly.
  for (const usage of usageKeys) {
    const provider = providerById.get(usage.providerId);
    const pool = poolsById.get(usage.providerId) ?? [];
    const slotInfo = pool.find((s) => s.slot === usage.keySlot);
    const masked = slotInfo?.hasKey ? slotInfo.masked : null;
    push(usage.providerId, provider?.name ?? usage.providerId, usage.keySlot, masked);
  }

  // Cost-desc for keys with spend (the aggregate order), then unused keys
  // by provider name + slot; removed rows keep their cost position.
  const cost = (card: KeyCardView): number => card.usage?.costUsd ?? -1;
  return cards.sort(
    (a, b) =>
      cost(b) - cost(a) ||
      a.providerName.localeCompare(b.providerName) ||
      a.slot - b.slot,
  );
}

function KeyCard({
  card,
  maxCost,
  totalCost,
  styles,
}: {
  card: KeyCardView;
  maxCost: number;
  totalCost: number;
  styles: ThemeStyles;
}) {
  const { card: bg, border, text, textSecondary, textTertiary, accent, softShadow } = styles;
  const usage = card.usage;
  const share = maxCost > 0 && usage ? Math.max(4, Math.round((usage.costUsd / maxCost) * 100)) : 4;
  const shareOfTotal = totalCost > 0 && usage ? (usage.costUsd / totalCost) * 100 : 0;

  return (
    <motion.article
      variants={staggerItem}
      className="rounded-[12px] border-[1.5px] p-4"
      style={{ backgroundColor: bg, borderColor: border, boxShadow: softShadow }}
      aria-label={`API key ${card.providerName} ${card.slotLabel}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[13px] font-bold" style={{ color: text }} title={card.providerName}>
            {card.providerName}
          </span>
          <span
            className="shrink-0 font-mono text-[10px] font-bold uppercase tracking-wide"
            style={{ color: card.slot === 0 ? accent : textSecondary }}
          >
            {card.slotLabel}
          </span>
        </div>
        <span
          className="shrink-0 font-mono text-[10px] font-semibold tracking-wide"
          style={{ color: card.removedKey ? SEMANTIC_COLORS.danger : textTertiary }}
        >
          {card.removedKey
            ? "removed key"
            : card.removedProvider
              ? "removed provider"
              : (card.masked ?? "—")}
        </span>
      </div>

      {/* Share-of-total: cost relative to the priciest key in the section. */}
      <div
        className="mt-2 h-[5px] overflow-hidden rounded-full"
        style={{ backgroundColor: withAlpha(accent, 0.12) }}
        role="progressbar"
        aria-valuenow={usage ? usage.costUsd : 0}
        aria-valuemin={0}
        aria-valuemax={maxCost}
        aria-label={`${card.providerName} ${card.slotLabel} cost share of the priciest key`}
        title={usage ? `${formatCost(usage.costUsd)} — ${shareOfTotal.toFixed(1)}% of all-time key spend` : "no usage recorded yet"}
      >
        <div
          className="h-full rounded-full"
          style={{
            width: `${share}%`,
            backgroundColor: card.removedKey ? withAlpha(SEMANTIC_COLORS.danger, 0.7) : accent,
          }}
        />
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="min-w-0">
          <dt className="text-[10px] font-bold uppercase tracking-widest" style={{ color: textTertiary }}>
            Requests
          </dt>
          <dd
            className="mt-0.5 truncate text-[12px] font-bold tabular-nums"
            style={{ color: text }}
            title={`${(usage?.requests ?? 0).toLocaleString()} requests on this key`}
          >
            {(usage?.requests ?? 0).toLocaleString()}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[10px] font-bold uppercase tracking-widest" style={{ color: textTertiary }}>
            Sent / Recv
          </dt>
          <dd
            className="mt-0.5 truncate text-[12px] font-bold tabular-nums"
            style={{ color: text }}
            title={`${(usage?.inputTokens ?? 0).toLocaleString()} sent · ${(usage?.outputTokens ?? 0).toLocaleString()} received`}
          >
            ↑ {formatCompactTokens(usage?.inputTokens ?? 0)} ↓ {formatCompactTokens(usage?.outputTokens ?? 0)}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[10px] font-bold uppercase tracking-widest" style={{ color: textTertiary }}>
            Cost
          </dt>
          <dd
            className="mt-0.5 truncate text-[12px] font-bold tabular-nums"
            style={{ color: text }}
            title={`${formatCost(usage?.costUsd ?? 0)} on this key`}
          >
            {formatCost(usage?.costUsd ?? 0)}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[10px] font-bold uppercase tracking-widest" style={{ color: textTertiary }}>
            Last used
          </dt>
          <dd className="mt-0.5 truncate text-[12px] font-bold" style={{ color: text }}>
            {usage ? formatWhen(usage.lastUsedAt) : <span style={{ color: textTertiary }}>—</span>}
          </dd>
        </div>
      </dl>

      {usage === null && (
        <p className="mt-2 text-[11px] font-medium" style={{ color: textTertiary }}>
          Not used yet — requests, tokens and cost land here the moment a turn runs on this key.
        </p>
      )}
    </motion.article>
  );
}

export function KeyCards({
  usageKeys,
  providers,
  poolsById,
  settledPoolIds,
  providersSettled,
  isPending,
  styles,
}: {
  /** GET /usage/detailed's keys rollup (provider × slot, cost-desc). */
  usageKeys: DetailedUsageKey[];
  providers: ProviderView[];
  poolsById: Map<string, KeyPoolSlot[]>;
  /** Provider ids whose pool listing SUCCEEDED (gates "removed key"). */
  settledPoolIds: Set<string>;
  /** True once the providers list settled (gates "removed provider"). */
  providersSettled: boolean;
  isPending: boolean;
  styles: ThemeStyles;
}) {
  const { textSecondary, textTertiary, accent } = styles;
  const cards = buildCards(usageKeys, providers, poolsById, settledPoolIds, providersSettled);
  const maxCost = Math.max(0, ...cards.map((c) => c.usage?.costUsd ?? 0));
  const totalCost = cards.reduce((sum, c) => sum + (c.usage?.costUsd ?? 0), 0);

  // While any source is still in flight the section stays hidden — the
  // join needs both sides settled before cards are stable (no raw-id →
  // display-name flash). Demo mode keeps the queries idle (isPending) and
  // the section hidden, same as the rest of the screen. Nothing configured
  // and nothing spent → hidden too (the empty state owns the blank canvas).
  if (isPending || cards.length === 0) return null;

  return (
    <section aria-label="API keys" className="mb-4 md:mb-6">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <KeyRound size={13} style={{ color: accent, opacity: 0.7 }} />
          <h2 className="text-[11px] font-bold uppercase tracking-widest" style={{ color: textTertiary }}>
            API keys
          </h2>
        </div>
        <span className="text-[11px] font-medium" style={{ color: textSecondary }}>
          {cards.length === 1 ? "1 key" : `${cards.length} keys`} · {formatCost(totalCost)} all-time
        </span>
      </div>
      <motion.div
        variants={staggerContainer}
        initial="initial"
        animate="animate"
        className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 md:gap-4"
      >
        {cards.map((card) => (
          <KeyCard key={card.id} card={card} maxCost={maxCost} totalCost={totalCost} styles={styles} />
        ))}
      </motion.div>
    </section>
  );
}
