/**
 * HostCard — the home screen's centerpiece: the host's name, the machine
 * identity line, the LIVE status (including the calm "Host offline —
 * retrying"), and the relative last-seen. Status colors are the fixed
 * semantic hues; the wording is quiet by decree (LINKING-PROTOCOL §2).
 */

import { Pressable, StyleSheet, View } from "react-native";
import { RefreshCw } from "lucide-react-native";
import { useTheme } from "@/design/theme";
import { Badge, TypeBody, TypeCaption, TypeMono } from "@/design/primitives";
import { RADIUS_CARD, spacing, TYPE_CAPTION } from "@/design/tokens";
import { shortMachineId } from "@/link/pairing";
import type { ConnectionStatus, LiveInfo, StoredHost } from "@/link/connection";

export interface HostCardProps {
  host: StoredHost;
  live: LiveInfo | null;
  status: ConnectionStatus;
  lastSeen: number | null;
  /** The honest failure line when offline (tls = re-pair territory). */
  failureMessage: string | null;
  onRetry: () => void;
  now?: number;
}

/** The quiet relative time — "just now" … "2h ago" … "3d ago". */
export function timeAgo(then: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  // R118-review WARN 2 — the unified boundary: "just now" under a MINUTE and
  // the minutes band starts at 1 (the old <45s fork rendered "0m ago" for
  // 45–59s across two of the three spellings).
  if (seconds < 60) return "just now";
  const minutes = Math.max(1, Math.floor(seconds / 60));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function HostCard({ host, live, status, lastSeen, failureMessage, onRetry, now }: HostCardProps) {
  const { tokens } = useTheme();

  const statusTone =
    status === "connected" ? tokens.success : status === "probing" ? tokens.warning : tokens.danger;
  const statusLine =
    status === "connected"
      ? `Connected${live !== null ? ` · v${live.version}` : ""}`
      : status === "probing"
        ? "Looking for the host…"
        : failureMessage !== null && failureMessage.includes("certificate")
          ? "Certificate changed — re-pair needed"
          : "Host offline — retrying";

  return (
    <View style={[styles.card, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
      <View style={styles.headRow}>
        <View style={{ flex: 1 }}>
          <TypeBody style={{ color: tokens.text, fontWeight: "600", fontSize: 15 }}>{host.hostLabel}</TypeBody>
          <TypeMono style={{ marginTop: 2 }}>
            {`machine ${shortMachineId(host.machineId)}${host.certFP === null ? " · tunnel link" : ""}`}
          </TypeMono>
        </View>
        <Pressable
          accessibilityLabel="Retry the connection now"
          accessibilityRole="button"
          hitSlop={10}
          onPress={onRetry}
          style={[styles.retry, { backgroundColor: tokens.subtle, borderColor: tokens.borderSubtle }]}
        >
          <RefreshCw size={TYPE_CAPTION + 5} color={tokens.textSecondary} strokeWidth={2} />
        </Pressable>
      </View>

      <View style={styles.statusRow}>
        <View style={[styles.statusDot, { backgroundColor: statusTone }]} />
        <TypeCaption style={{ color: tokens.textSecondary }}>{statusLine}</TypeCaption>
        {status === "connected" && lastSeen !== null && (
          <TypeCaption style={{ color: tokens.textTertiary }}>· seen {timeAgo(lastSeen, now)}</TypeCaption>
        )}
      </View>

      {status === "offline" && failureMessage !== null && (
        <View style={styles.failureRow}>
          <Badge tone="danger">{failureMessage.includes("certificate") ? "re-pair" : "offline"}</Badge>
          <TypeCaption style={{ color: tokens.textTertiary, flex: 1 }} numberOfLines={2}>
            {failureMessage}
          </TypeCaption>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: RADIUS_CARD,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg,
    gap: spacing.md,
  },
  headRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
  },
  retry: {
    width: 36,
    height: 36,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    flexWrap: "wrap",
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  failureRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
});
