/**
 * ApprovalCard v2 (R109-c) — the killer feature's row in the CLAY language
 * (LINKING-PROTOCOL §4 / R3 §1.5): a ClayCard shell (bordered in the danger
 * hue ONLY for destructive categories), the category Badge + risk line, the
 * mono tool headline (≤3 lines) + detail (≤4 lines), the session/project
 * caption, honest expiry, and Approve (ChromeButton — the sanctioned CTA
 * chrome, compact 44) / Deny (QuietButton, danger tone).
 *
 * The decision stays OPTIMISTIC: the card plays the house-spring settle
 * (fade + rise + slight shrink) the moment the tap lands, the POST
 * /approvals/:id/decision rides behind it, and a failure un-settles with
 * the host's own message. Expired rows dim + disable (the route 409s dead
 * rows — the phone never pretends otherwise). Destructive rows never offer
 * "always allow" — v1's by-construction rule: `canAlways` stays un-rendered.
 */

import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withSpring } from "react-native-reanimated";
import { useTheme } from "@/design/theme";
import { Badge, ChromeButton, ClayCard, QuietButton, TypeCaption, TypeMono } from "@/design/primitives";
import { ENTRANCE_DELTA, SPRING, staggerDelay } from "@/design/motion";
import { decisionHaptic } from "@/design/haptics";
import { fontFamily, mixHex, spacing, TYPE_BODY } from "@/design/tokens";
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
        <View style={styles.headRow}>
          <Badge tone={destructive ? "danger" : card.tone === "warning" ? "warning" : "neutral"}>
            {card.row.category}
          </Badge>
          <View style={styles.headSpacer} />
          {card.expired ? (
            <Badge tone="danger">expired</Badge>
          ) : card.expiresInMs !== null ? (
            <TypeCaption style={{ color: tokens.textTertiary }}>
              {expiryCaption(card.expiresInMs)}
            </TypeCaption>
          ) : null}
        </View>

        <TypeMono numberOfLines={3} style={styles.headline}>
          {card.headline}
        </TypeMono>
        {card.detail !== "" ? (
          <TypeMono numberOfLines={4} style={{ color: tokens.textTertiary }}>
            {card.detail}
          </TypeMono>
        ) : null}

        <TypeCaption style={{ color: tokens.textSecondary }}>{card.riskLine}</TypeCaption>
        <TypeCaption numberOfLines={2} style={{ color: tokens.textTertiary }}>
          {caption}
        </TypeCaption>

        {failure !== null ? (
          <TypeCaption numberOfLines={3} style={{ color: tokens.danger }}>
            {failure}
          </TypeCaption>
        ) : null}

        <View style={styles.buttonRow}>
          <ChromeButton
            onPress={() => decide("approved")}
            disabled={inert}
            busy={settling === "approved"}
            style={styles.approveButton}
            accessibilityLabel="Approve this request"
          >
            Approve
          </ChromeButton>
          <QuietButton
            tone="danger"
            onPress={() => decide("denied")}
            disabled={inert}
            style={styles.denyButton}
          >
            Deny
          </QuietButton>
        </View>
      </ClayCard>
    </Animated.View>
  );
}

/** "expires in 45s" — honest seconds; dims into the tertiary tone. */
function expiryCaption(expiresInMs: number): string {
  const seconds = Math.max(0, Math.round(expiresInMs / 1000));
  if (seconds <= 1) return "expiring…";
  if (seconds < 90) return `expires in ${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return `expires in ${minutes}m`;
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
  headline: {
    fontSize: TYPE_BODY,
    fontFamily: fontFamily.monoMedium,
    lineHeight: 21,
  },
  buttonRow: {
    flexDirection: "row",
    gap: spacing.md,
    paddingTop: spacing.xs,
  },
  approveButton: {
    flex: 1,
    minHeight: 44,
  },
  denyButton: {
    flex: 1,
  },
});
