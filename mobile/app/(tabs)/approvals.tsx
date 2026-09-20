/**
 * Approvals v3 (R109-c; R113-e — the compact header; R114-c — the header-free
 * root; R115-M — the minimal-center empty state) — THE killer feature
 * (ANDROID-R1 §4), a tab root in the clay language (the rows are the
 * screen's top). Every permission gate the desktop agent hits lands here as
 * the EXISTING approval row (toolCall, category, risk line, session/project,
 * expiry) — one tap wakes the waiting tool call on the desktop. The phone
 * renders + taps; NOTHING is processed here (LINKING-PROTOCOL §4's ceiling).
 *
 * Cadence: load on mount + every (re)connect, a calm 20-second poll while
 * connected (the live notification stream covers the rest — approvals are
 * also notifications), and pull-to-refresh. The expiry clock ticks every
 * 10s so "expires in Ns" stays true without per-frame renders.
 *
 * R115-M — the states' honest grammar (screen-archetypes §2): loading and
 * probing render skeleton cards (donts #14 — never a spinner on a list
 * screen), offline keeps the one-line retry card, and the EMPTY state is
 * the Archetype-1-style centered message: the ShieldCheck chip in quiet
 * clay, the PINNED copy (copy.md: "Nothing needs your approval") + the
 * one-line caption, vertically centered in the available space with the
 * fade-in-up entrance. A refresh that fails while the list is empty keeps
 * the honest warning strip above the centered message — the pinned copy
 * never swallows the failure.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshControl, StyleSheet, View, useWindowDimensions } from "react-native";
import { ShieldCheck } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ScreenScaffold, useTabBarInset } from "@/components/screen-scaffold";
import { ApprovalCard } from "@/components/approval-card";
import { ErrorState, SkeletonList } from "@/components/list-state";
import { FadeInUp, TypeBodyStrong, TypeCaption } from "@/design/primitives";
import { useTheme } from "@/design/theme";
import { RADIUS_CHIP, TILE_OPTION, spacing } from "@/design/tokens";
import { useLink } from "@/link/use-link";
import { getLinkManager } from "@/link/runtime";
import {
  fetchPendingApprovals,
  postApprovalDecision,
  toApprovalCards,
  type ApprovalDecision,
  type ApprovalRow,
} from "@/features/approvals";
import { fetchProjects } from "@/features/config";
import { mobLog, mobWarn } from "@/lib/log";

/** The calm poll cadence while connected (the stream covers the rest). */
const POLL_MS = 20_000;

export default function ApprovalsScreen() {
  const { tokens } = useTheme();
  const { status } = useLink();
  const connected = status === "connected";

  const [rows, setRows] = useState<ApprovalRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [projectNames, setProjectNames] = useState<Record<string, string>>({});
  const [now, setNow] = useState(Date.now());

  // The honest expiry clock — a calm 10s tick keeps "expires in Ns" true
  // without re-rendering on every frame.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);

  const load = useCallback(async () => {
    try {
      const outcome = await fetchPendingApprovals(getLinkManager());
      if (outcome.ok) {
        setRows(outcome.data);
        setError(null);
        mobLog("approvals", "pending loaded", { count: outcome.data.length });
      } else {
        setError(outcome.error.message);
        mobWarn("approvals", "load failed", { status: outcome.error.status, code: outcome.error.code });
      }
    } catch {
      setError("the host is offline — retrying");
      mobWarn("approvals", "load threw");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Load on mount, on link (re)connect.
  useEffect(() => {
    if (status === "connected") {
      void load();
    } else if (status === "unpaired") {
      setLoading(false);
    }
  }, [status, load]);

  // The calm 20s poll while connected.
  useEffect(() => {
    if (!connected) return;
    const timer = setInterval(() => {
      void load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [connected, load]);

  // Project names for the captions (one quiet fetch; failures stay caption-less).
  useEffect(() => {
    if (status !== "connected") return;
    void fetchProjects(getLinkManager())
      .then((outcome) => {
        if (!outcome.ok) return;
        const map: Record<string, string> = {};
        for (const project of outcome.data.projects) map[project.id] = project.name;
        setProjectNames(map);
      })
      .catch(() => {
        // captions fall back to the honest ids — never a failure state
      });
  }, [status]);

  const cards = useMemo(() => (rows === null ? [] : toApprovalCards(rows, now)), [rows, now]);

  const decide = useCallback(
    async (id: string, decision: ApprovalDecision): Promise<string | null> => {
      try {
        const outcome = await postApprovalDecision(getLinkManager(), id, decision);
        if (outcome.ok) {
          mobLog("approvals", "decision delivered", { id, decision });
          // The optimistic card settled; the refresh lands the truth.
          void load();
          return null;
        }
        // 409 (already decided — the desktop or another phone won the race)
        // resolves honestly: refresh, the row is gone.
        void load();
        if (outcome.error.status === 409) {
          mobLog("approvals", "already decided elsewhere", { id });
          return null;
        }
        mobWarn("approvals", "decision failed", { id, status: outcome.error.status, code: outcome.error.code });
        return outcome.error.message;
      } catch {
        mobWarn("approvals", "decision threw", { id });
        return "the host is offline — the decision was not delivered";
      }
    },
    [load],
  );

  const captionFor = (row: ApprovalRow): string => {
    const session = `session ${row.sessionId.slice(0, 12)}`;
    const project =
      row.projectId !== null
        ? projectNames[row.projectId] !== undefined
          ? projectNames[row.projectId]
          : row.projectId.slice(0, 24)
        : "no project";
    return `${session} · ${project}`;
  };

  const refreshControl = (
    <RefreshControl
      refreshing={refreshing}
      onRefresh={() => {
        setRefreshing(true);
        void load();
      }}
      tintColor={tokens.accent}
      colors={[tokens.accent]}
      progressBackgroundColor={tokens.card}
    />
  );

  // The minimal-center fill — the chromeless scaffold's OWN arithmetic
  // (ScreenScaffold: the scroll viewport is the window minus the top inset;
  // the content pads spacing.xxl above and max(tabBarInset, insets.bottom) +
  // spacing.lg below), so the empty cluster centers in exactly the space the
  // rows would occupy. Pull-to-refresh stays live (the fill lives inside the
  // scroll body).
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const tabBarInset = useTabBarInset();
  const emptyFill =
    windowHeight - insets.top - spacing.xxl - Math.max(tabBarInset, insets.bottom) - spacing.lg;

  return (
    <ScreenScaffold title="Approvals" refreshControl={refreshControl} chrome={false}>
      {status === "unpaired" ? (
        <ErrorState title="No host linked" caption="Pair this phone to see approvals." />
      ) : rows === null && !connected ? (
        status === "probing" ? (
          <SkeletonList rows={3} rowHeight={132} />
        ) : (
          <ErrorState
            title="host offline"
            caption="approvals reload the moment the link returns."
            retryLabel="retry now"
            onRetry={() => getLinkManager().retryNow()}
          />
        )
      ) : loading ? (
        <SkeletonList rows={3} rowHeight={132} />
      ) : error !== null && rows === null ? (
        <ErrorState
          title="Couldn't load approvals"
          caption={error}
          retryLabel="try again"
          onRetry={() => void load()}
        />
      ) : cards.length === 0 ? (
        <View style={{ minHeight: emptyFill }}>
          {error !== null ? (
            <TypeCaption numberOfLines={1} style={{ color: tokens.warning }}>
              {`last update failed — ${error}`}
            </TypeCaption>
          ) : null}
          <View style={styles.emptyCenter}>
            {/* The minimal-center message (Archetype-1 DNA): chip + the
                pinned title + one caption line, slightly above the middle. */}
            <FadeInUp index={0} style={styles.emptyCluster}>
              <View
                style={[
                  styles.emptyChip,
                  {
                    backgroundColor: tokens.card,
                    borderTopColor: tokens.clayTopEdge,
                    boxShadow: tokens.clayShadowSm,
                  },
                ]}
              >
                <ShieldCheck size={24} color={tokens.textSecondary} strokeWidth={1.8} />
              </View>
              <TypeBodyStrong style={styles.emptyTitle}>Nothing needs your approval</TypeBodyStrong>
              <TypeCaption style={{ color: tokens.textTertiary, textAlign: "center" }}>
                Permission requests the agent raises appear here.
              </TypeCaption>
            </FadeInUp>
          </View>
        </View>
      ) : (
        <>
          {error !== null ? (
            <TypeCaption numberOfLines={1} style={{ color: tokens.warning }}>
              {`last update failed — ${error}`}
            </TypeCaption>
          ) : null}
          {cards.map((card, index) => (
            <ApprovalCard
              key={card.row.id}
              card={card}
              enterIndex={index}
              caption={captionFor(card.row)}
              onDecide={decide}
            />
          ))}
        </>
      )}
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  emptyCenter: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    // Archetype-1 DNA — the cluster rides slightly ABOVE the vertical middle.
    paddingBottom: spacing.huge,
  },
  emptyCluster: {
    alignItems: "center",
    gap: spacing.md,
  },
  emptyChip: {
    width: TILE_OPTION,
    height: TILE_OPTION,
    borderRadius: RADIUS_CHIP,
    borderTopWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.xs,
  },
  emptyTitle: { textAlign: "center" },
});
