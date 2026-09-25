import { motion } from "framer-motion";
import { KeyRound } from "lucide-react";
import type { DetailedUsageKey, KeyPoolSlot, ProviderView } from "../../lib/api";
import type { ThemeStyles } from "../../lib/themes";
import { formatWhen } from "../../lib/format";
import { staggerContainer, staggerItem } from "../../lib/motion";
import { Kicker } from "../ui/Kicker";
import { UsageMiniStat } from "./UsageStatRow";
import { CLAY_CARD_SM, formatCompactTokens, formatCost } from "./usage-helpers";
import { cn } from "../../lib/utils";

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
 * ROUND-126 (R126-3b, the Clay Companion redesign): the card is the compact
 * clay tile (rim + `.ac-clay-sm`); removal/absence states ride the STATUS
 * GRAMMAR's badge tone containers (TOKENS §11 — `bg-badge-danger` +
 * `text-badge-danger-fg`, never flat red text); the share bar fills the DEEP
 * accent leg over the recessed well track; the stats render as the ONE mini
 * stat row with hairline dividers.
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
  const { text, textSecondary, textTertiary, accentDeep, dangerDeep } = styles;
  const usage = card.usage;
  const share = maxCost > 0 && usage ? Math.max(4, Math.round((usage.costUsd / maxCost) * 100)) : 4;
  const shareOfTotal = totalCost > 0 && usage ? (usage.costUsd / totalCost) * 100 : 0;

  return (
    <motion.article
      variants={staggerItem}
      className={cn(CLAY_CARD_SM, "p-4")}
      aria-label={`API key ${card.providerName} ${card.slotLabel}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[13px] font-semibold" style={{ color: text }} title={card.providerName}>
            {card.providerName}
          </span>
          <span
            className={cn(
              "shrink-0 font-mono text-[10px] font-medium uppercase tracking-[0.08em]",
              card.slot === 0 ? "text-accent-deep" : "",
            )}
            style={card.slot === 0 ? undefined : { color: textSecondary }}
          >
            {card.slotLabel}
          </span>
        </div>
        {/* R126-3b: removal states ride the badge TONE containers (TOKENS
            §11) — tinted container + deep-on-tint ink, never flat red. */}
        {card.removedKey || card.removedProvider ? (
          <span className="shrink-0 rounded-full bg-badge-danger px-2 py-0.5 text-[10px] font-medium text-badge-danger-fg">
            {card.removedKey ? "removed key" : "removed provider"}
          </span>
        ) : (
          <span className="shrink-0 font-mono text-[10px] font-semibold tracking-wide" style={{ color: textTertiary }}>
            {card.masked ?? "—"}
          </span>
        )}
      </div>

      {/* Share-of-total: cost relative to the priciest key in the section. */}
      <div
        className="mt-2 h-[5px] overflow-hidden rounded-full bg-well"
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
            backgroundColor: card.removedKey ? dangerDeep : accentDeep,
          }}
        />
      </div>

      {/* R126-3b: the mini stat row — hairline dividers, tabular values. */}
      <div className="mt-3 grid grid-cols-2 gap-y-2 sm:grid-cols-4 sm:gap-y-0">
        <UsageMiniStat
          divider="none"
          label="Turns"
          value={(usage?.requests ?? 0).toLocaleString()}
          title={`${(usage?.requests ?? 0).toLocaleString()} turns on this key (one usage row per turn — the ROUND-83 honest relabel)`}
          styles={styles}
        />
        <UsageMiniStat
          divider="always"
          label="Sent / Recv"
          value={`↑ ${formatCompactTokens(usage?.inputTokens ?? 0)} ↓ ${formatCompactTokens(usage?.outputTokens ?? 0)}`}
          title={`${(usage?.inputTokens ?? 0).toLocaleString()} sent · ${(usage?.outputTokens ?? 0).toLocaleString()} received`}
          styles={styles}
        />
        <UsageMiniStat
          divider="sm"
          label="Cost"
          value={formatCost(usage?.costUsd ?? 0)}
          title={`${formatCost(usage?.costUsd ?? 0)} on this key`}
          styles={styles}
        />
        <UsageMiniStat
          divider="always"
          label="Last used"
          value={usage ? formatWhen(usage.lastUsedAt) : "—"}
          styles={styles}
        />
      </div>

      {usage === null && (
        <p className="mt-2 truncate text-[11px]" style={{ color: textTertiary }}>
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
  const { textSecondary } = styles;
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
        <Kicker as="h2" icon={KeyRound}>
          API keys
        </Kicker>
        <span className="text-[11px] font-medium leading-none tabular-nums" style={{ color: textSecondary }}>
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
