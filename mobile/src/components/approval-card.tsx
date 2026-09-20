/**
 * ApprovalCard v3 (R109-c; R115-M — the round-115 rebuild) — the killer
 * feature's row in the CLAY language (LINKING-PROTOCOL §4 / R3 §1.5), one
 * visual idea per region:
 *
 *   meta row     [category Badge — danger ONLY for destructive, warning for
 *                 confirm] + [the expiry CHIP, right-aligned: "expires in
 *                 {n}s"/"{n}m", warning tint under 30s, dim "expired"]
 *   content      the toolCall's first line as TypeBodyStrong (≤2 lines — the
 *                 mono headline retired: it was cramped) + the remaining
 *                 lines as a TERTIARY caption (≤3, only when they exist)
 *   captions     the honest risk line (warning-tinted icon + caption, one
 *                 line) + the session/project context line (one line)
 *   actions      Approve (ChromeButton — the sanctioned CTA chrome) / Deny
 *                 (QuietButton, danger tone), 50px, side by side, full width
 *
 * The decision stays OPTIMISTIC: the card plays the house-spring settle
 * (fade + rise + slight shrink) the moment the tap lands, the POST
 * /approvals/:id/decision rides behind it, and a failure un-settles with the
 * host's own message (the 409 race resolves through the screen's refresh).
 * Expired rows dim + disable (the route 409s dead rows — the phone never
 * pretends otherwise). Destructive rows keep the danger hairline border and
 * never offer "always allow" — v1's by-construction rule: `canAlways` stays
 * un-rendered.
 */

import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withSpring } from "react-native-reanimated";
import { CircleAlert } from "lucide-react-native";
import { useTheme } from "@/design/theme";
import { Badge, ChromeButton, ClayCard, QuietButton, TypeBodyStrong, TypeCaption } from "@/design/primitives";
import { ENTRANCE_DELTA, SPRING, staggerDelay } from "@/design/motion";
import { decisionHaptic } from "@/design/haptics";
import { RADIUS_PILL, TYPE_MICRO, fontFamily, mixHex, spacing } from "@/design/tokens";
import type { ApprovalCardModel, ApprovalDecision } from "@/features/approvals";

export interface ApprovalCardProps {
  card: ApprovalCardModel;
  /** List index — the fade-in-up entrance with the 30ms stagger. */
  enterIndex?: number;
  /** The session/project caption line (the screen resolves the names). */
  caption: string;
  /** POST the decision; resolves null on success, the failure line otherwise. */
  onDecide: (id: string, decision: ApprovalDecision) => Promise<string | null>;
}

/** The countdown's pressure threshold — components.md's countdown chip tints
 *  warning under 30s (motion.md §3: gentle pressure, never a seizure). */
const EXPIRY_URGENT_MS = 30_000;

/** "expires in 45s" — honest seconds, numerals never prose (copy.md). */
function expiryCaption(expiresInMs: number): string {
  const seconds = Math.max(0, Math.round(expiresInMs / 1000));
  if (seconds <= 1) return "expiring…";
  if (seconds < 90) return `expires in ${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return `expires in ${minutes}m`;
}

/** The expiry chip's honest read — the label (null = no chip) + tint tier:
 *  "dead" dims (expired), "urgent" warns (<30s), "calm" stays neutral. */
function expiryChip(
  expiresInMs: number | null,
  expired: boolean,
): { label: string | null; tier: "calm" | "urgent" | "dead" } {
  if (expired) return { label: "expired", tier: "dead" };
  if (expiresInMs === null) return { label: null, tier: "calm" };
  return {
    label: expiryCaption(expiresInMs),
    tier: expiresInMs < EXPIRY_URGENT_MS ? "urgent" : "calm",
  };
}

export function ApprovalCard({ card, enterIndex, caption, onDecide }: ApprovalCardProps) {
  const { tokens } = useTheme();
  const [settling, setSettling] = useState<ApprovalDecision | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const entered = useSharedValue(enterIndex === undefined ? 1 : 0);
  const settled = useSharedValue(0);

  useEffect(() => {
    if (enterIndex === undefined) return;
    entered.value = withDelay(staggerDelay(enterIndex), withSpring(1, SPRING));
  }, [enterIndex, entered]);

  const animated = useAnimatedStyle(() => {
    const rise = (1 - entered.value) * ENTRANCE_DELTA;
    // The settle: fade + rise + slight shrink, one spring.
    const settleRise = settled.value * -12;
    return {
      opacity: entered.value * (1 - settled.value * 0.9),
      transform: [{ translateY: rise + settleRise }, { scale: 1 - settled.value * 0.05 }],
    };
  });

  const decide = (decision: ApprovalDecision): void => {
    if (settling !== null || card.expired) return;
    setFailure(null);
    setSettling(decision);
    settled.value = withSpring(1, SPRING);
    void decisionHaptic();
    void onDecide(card.row.id, decision).then((failureMessage) => {
      if (failureMessage !== null) {
        // Un-settle: the row stays, the host's own message shows honestly.
        settled.value = withSpring(0, SPRING);
        setSettling(null);
        setFailure(failureMessage);
      }
    });
  };

  const destructive = card.tone === "danger";
  const inert = settling !== null || card.expired;
  const expiry = expiryChip(card.expiresInMs, card.expired);

  return (
    <Animated.View
      accessibilityLabel={`Permission request: ${card.headline}`}
      style={animated}
    >
      <ClayCard
        testID="approval-card"
        bordered={destructive}
        style={[
          styles.card,
          destructive
            ? {
                // The danger edge — the border itself carries the risk tier,
                // with the molded lighter cap grammar on top.
                borderColor: tokens.danger,
                borderTopColor: mixHex(tokens.danger, tokens.card, 0.45),
              }
            : null,
          card.expired ? styles.expired : null,
        ]}
      >
        {/* The meta row — what kind of ask this is + how long it lives. */}
        <View style={styles.headRow}>
          <Badge tone={destructive ? "danger" : card.tone === "warning" ? "warning" : "neutral"}>
            {card.row.category}
          </Badge>
          <View style={styles.headSpacer} />
          {expiry.label !== null ? (
            <View
              style={[
                styles.expiryChip,
                {
                  backgroundColor:
                    expiry.tier === "urgent"
                      ? mixHex(tokens.warning, tokens.card, 0.86)
                      : tokens.pillBg,
                },
              ]}
            >
              <Text
                style={[
                  styles.expiryText,
                  {
                    color:
                      expiry.tier === "urgent"
                        ? tokens.warning
                        : expiry.tier === "dead"
                          ? tokens.textTertiary
                          : tokens.textSecondary,
                  },
                ]}
              >
                {expiry.label}
              </Text>
            </View>
          ) : null}
        </View>

        {/* The content block — the ask itself. */}
        <View style={styles.contentBlock}>
          <TypeBodyStrong numberOfLines={2}>{card.headline}</TypeBodyStrong>
          {card.detail !== "" ? (
            <TypeCaption numberOfLines={3} style={{ color: tokens.textTertiary }}>
              {card.detail}
            </TypeCaption>
          ) : null}
        </View>

        {/* The caption block — the honest risk line + where it came from. */}
        <View style={styles.captionBlock}>
          <View style={styles.riskRow}>
            <CircleAlert size={13} color={tokens.warning} strokeWidth={2} />
            <TypeCaption numberOfLines={1} style={{ flex: 1, color: tokens.textSecondary }}>
              {card.riskLine}
            </TypeCaption>
          </View>
          <TypeCaption numberOfLines={1} style={{ color: tokens.textTertiary }}>
            {caption}
          </TypeCaption>
        </View>

        {failure !== null ? (
          <TypeCaption numberOfLines={2} style={{ color: tokens.danger }}>
            {failure}
          </TypeCaption>
        ) : null}

        {/* The action row — 50px, side by side, full width. */}
        <View style={styles.buttonRow}>
          <ChromeButton
            onPress={() => decide("approved")}
            disabled={inert}
            busy={settling === "approved"}
            style={styles.approveButton}
            accessibilityLabel={`Approve ${card.headline}`}
            testID="approve"
          >
            Approve
          </ChromeButton>
          <QuietButton
            tone="danger"
            onPress={() => decide("denied")}
            disabled={inert}
            style={styles.denyButton}
            testID="deny"
          >
            Deny
          </QuietButton>
        </View>
      </ClayCard>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  expired: {
    opacity: 0.65,
  },
  headRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  headSpacer: { flex: 1 },
  expiryChip: {
    borderRadius: RADIUS_PILL,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  expiryText: {
    fontSize: TYPE_MICRO,
    fontFamily: fontFamily.mono,
    letterSpacing: 0.2,
  },
  contentBlock: {
    gap: spacing.xs,
  },
  captionBlock: {
    gap: spacing.xs,
  },
  riskRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  buttonRow: {
    flexDirection: "row",
    gap: spacing.md,
    paddingTop: spacing.xs,
  },
  approveButton: {
    flex: 1,
  },
  denyButton: {
    flex: 1,
    minHeight: 50,
  },
});
