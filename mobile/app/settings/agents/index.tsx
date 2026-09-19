/**
 * Agents — the roster: every agent row (name, role, the model line —
 * provider/model or the honest "desktop default" — and the template badge)
 * pushes to the editor. Templates are read-only there; this list shows them
 * because they are the roster's honest half.
 */

import { useCallback, useEffect, useState } from "react";
import { RefreshControl, StyleSheet, View } from "react-native";
import { Bot, ChevronRight } from "lucide-react-native";
import { useRouter } from "expo-router";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { EmptyState, ErrorState, LoadingState } from "@/components/list-state";
import {
  Badge,
  PressableCard,
  TypeBodyStrong,
  TypeCaption,
  TypeMicro,
} from "@/design/primitives";
import { useTheme } from "@/design/theme";
import { spacing } from "@/design/tokens";
import { fetchAgents, type AgentRow } from "@/features/config";
import { getLinkManager } from "@/link/runtime";
import { useLink } from "@/link/use-link";
import { mobLog, mobWarn } from "@/lib/log";

export default function AgentsScreen() {
  const { tokens } = useTheme();
  const { status } = useLink();
  const connected = status === "connected";

  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!connected) return;
    try {
      const outcome = await fetchAgents(getLinkManager());
      if (outcome.ok) {
        setAgents(outcome.data.agents);
        setLoadError(null);
        mobLog("config", "agents loaded", { count: outcome.data.agents.length });
      } else {
        setLoadError(outcome.error.message);
        mobWarn("config", "agents load failed", {
          status: outcome.error.status,
          message: outcome.error.message,
        });
      }
    } catch (err) {
      setLoadError("the host dropped while loading — pull to retry");
      mobWarn("config", "agents load transport failure", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [connected]);

  useEffect(() => {
    if (connected) void load();
  }, [connected, load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  return (
    <ScreenScaffold
      title="Agents"
      back
      subtitle="the worker roster"
      refreshControl={
        connected ? (
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            tintColor={tokens.accent}
            colors={[tokens.accent]}
            progressBackgroundColor={tokens.card}
          />
        ) : undefined
      }
    >
      {!connected ? (
        <HostGate status={status} />
      ) : agents === null ? (
        loadError !== null ? (
          <ErrorState
            title="could not load agents"
            caption={loadError}
            retryLabel="try again"
            onRetry={() => void load()}
          />
        ) : (
          <LoadingState caption="loading agents…" />
        )
      ) : agents.length === 0 ? (
        <EmptyState
          title="no agents yet"
          caption="create one on the desktop — it appears here the moment it exists."
        />
      ) : (
        agents.map((agent, index) => (
          <AgentRowCard key={agent.id} agent={agent} index={index} />
        ))
      )}
    </ScreenScaffold>
  );
}

function AgentRowCard({ agent, index }: { agent: AgentRow; index: number }) {
  const { tokens } = useTheme();
  const router = useRouter();
  const modelLine =
    agent.providerId !== null && agent.model !== null
      ? `${agent.providerId}/${agent.model}`
      : "desktop default";
  return (
    <PressableCard
      enterIndex={Math.min(index, 12)}
      onPress={() => router.push(`/settings/agents/${encodeURIComponent(agent.id)}`)}
      accessibilityLabel={`Agent ${agent.name}`}
    >
      <View style={styles.rowInner}>
        <View style={[styles.rowIcon, { backgroundColor: tokens.subtleHover }]}>
          <Bot size={20} color={tokens.accent} strokeWidth={2.2} />
        </View>
        <View style={styles.rowText}>
          <View style={styles.rowTitleLine}>
            <TypeBodyStrong numberOfLines={1} style={styles.rowTitle}>
              {agent.name}
            </TypeBodyStrong>
            {agent.isTemplate ? <Badge tone="accent">template</Badge> : null}
          </View>
          <TypeCaption numberOfLines={1}>{agent.role}</TypeCaption>
          <TypeMicro numberOfLines={1}>{modelLine}</TypeMicro>
        </View>
        <ChevronRight size={18} color={tokens.textTertiary} strokeWidth={2.2} />
      </View>
    </PressableCard>
  );
}

/** The honest not-connected gate (shared spelling across the settings pages). */
function HostGate({ status }: { status: "unpaired" | "probing" | "offline" }) {
  const router = useRouter();
  const unpaired = status === "unpaired";
  return (
    <ErrorState
      title={unpaired ? "no host linked" : "host offline"}
      caption={
        unpaired
          ? "agents live on the desktop — pair one to manage them from here."
          : "the roster reloads the moment the link returns — nothing is lost."
      }
      retryLabel={unpaired ? "link a desktop" : "retry now"}
      onRetry={() => (unpaired ? router.push("/connect") : getLinkManager().retryNow())}
    />
  );
}

const styles = StyleSheet.create({
  rowInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.lg,
    minHeight: 72,
  },
  rowIcon: {
    width: 44,
    height: 44,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  rowText: { flex: 1, gap: 3 },
  rowTitleLine: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  rowTitle: { flexShrink: 1 },
});
