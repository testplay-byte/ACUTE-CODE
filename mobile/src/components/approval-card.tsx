/**
 * ApprovalCard — the killer feature's row (LINKING-PROTOCOL §4 / R3 §1.5):
 * the EXISTING approval shape rendered quiet — mono tool headline, category
 * badge, risk line, session/project caption, honest expiry; Approve (accent)
 * and Deny (danger) as two quiet buttons. The decision is optimistic: the
 * card plays the spring settle (fade + rise, the one spring) the moment the
 * tap lands, the POST /approvals/:id/decision rides behind it, and a failure
 * un-settles with the host's own message. Destructive rows never offer
 * "always allow" — v1 mobile sends decision only, by construction.
 */

import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withSpring } from "react-native-reanimated";
import { useTheme } from "@/design/theme";
import { Badge, TypeCaption, TypeMono } from "@/design/primitives";
import { ENTRANCE_DELTA, SPRING, staggerDelay } from "@/design/motion";
import { pressTint, RADIUS_CARD, RADIUS_PILL, spacing, TYPE_BODY, fontStack } from "@/design/tokens";
import { decisionHaptic } from "@/design/haptics";
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

  const approveColor = tokens.accent;
  const denyColor = tokens.danger;

  return (
    <Animated.View style={animated}>
      <View
        accessibilityLabel={`Permission request: ${card.headline}`}
        style={[
          styles.card,
          {
            backgroundColor: tokens.card,
            borderColor: card.tone === "danger" ? tokens.danger : tokens.border,
          },
          card.expired ? styles.expired : null,
        ]}
      >
        <View style={styles.headRow}>
          <Badge tone={card.tone === "danger" ? "danger" : card.tone === "warning" ? "accent" : "neutral"}>
            {card.row.category}
          </Badge>
          <View style={{ flex: 1 }} />
          {card.expired ? (
            <Badge tone="danger">expired</Badge>
          ) : card.expiresInMs !== null ? (
            <TypeCaption style={{ color: tokens.textTertiary }}>
              {expiryCaption(card.expiresInMs)}
            </TypeCaption>
          ) : null}
        </View>

        <TypeMono
          style={{ color: tokens.text, fontSize: TYPE_BODY, fontWeight: "600" }}
          numberOfLines={3}
        >
          {card.headline}
        </TypeMono>
        {card.detail !== "" && (
          <TypeMono style={{ color: tokens.textTertiary }} numberOfLines={4}>
            {card.detail}
          </TypeMono>
        )}

        <TypeCaption style={{ color: tokens.textSecondary }}>{card.riskLine}</TypeCaption>
        <TypeCaption style={{ color: tokens.textTertiary }} numberOfLines={2}>
          {caption}
        </TypeCaption>

        {failure !== null && (
          <TypeCaption style={{ color: tokens.danger }} numberOfLines={3}>
            {failure}
          </TypeCaption>
        )}

        <View style={styles.buttonRow}>
          <DecisionButton
            label="Approve"
            color={approveColor}
            disabled={settling !== null || card.expired}
            busy={settling === "approved"}
            onPress={() => decide("approved")}
          />
          <DecisionButton
            label="Deny"
            color={denyColor}
            disabled={settling !== null || card.expired}
            busy={settling === "denied"}
            onPress={() => decide("denied")}
          />
        </View>
      </View>
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

// ── the quiet decision button ───────────────────────────────────────────────

function DecisionButton({
  label,
  color,
  disabled,
  busy,
  onPress,
}: {
  label: string;
  color: string;
  disabled: boolean;
  busy: boolean;
  onPress: () => void;
}) {
  const { tokens } = useTheme();
  return (
    <Pressable
      accessibilityLabel={label === "Approve" ? "Approve this request" : "Deny this request"}
      accessibilityRole="button"
      accessibilityState={disabled ? { disabled: true } : undefined}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          borderColor: color,
          backgroundColor: pressed ? pressTint(tokens.card, tokens.isDark) : "transparent",
          opacity: disabled ? 0.45 : 1,
        },
      ]}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.xs }}>
        {busy && <View style={[styles.busyDot, { backgroundColor: color }]} />}
        <Text
          style={{
            color,
            fontSize: TYPE_BODY,
            fontFamily: fontStack.sans,
            fontWeight: "600",
            textAlign: "center",
          }}
        >
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: RADIUS_CARD,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg,
    gap: spacing.md,
  },
  expired: {
    opacity: 0.7,
  },
  headRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  buttonRow: {
    flexDirection: "row",
    gap: spacing.md,
    paddingTop: spacing.xs,
  },
  button: {
    flex: 1,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: RADIUS_PILL,
    borderWidth: 1,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  busyDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
});
