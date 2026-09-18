/**
 * Approvals — THE killer feature (ANDROID-R1 §4): every permission gate the
 * desktop agent hits lands here as the EXISTING approval row (toolCall,
 * category, risk line, session/project, expiry) — one tap wakes the waiting
 * tool call on the desktop. The phone renders + taps; NOTHING is processed
 * here (LINKING-PROTOCOL §4's ceiling). Pull-to-refresh is theme-matched;
 * the empty state is the honest "Nothing is waiting on you."
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshControl } from "react-native";
import { ShieldCheck } from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { ApprovalCard } from "@/components/approval-card";
import { EmptyState, ErrorState, LoadingState } from "@/components/list-state";
import { useTheme } from "@/design/theme";
import { useLink } from "@/link/use-link";
import { getLinkManager } from "@/link/runtime";
import {
  fetchPendingApprovals,
  postApprovalDecision,
  toApprovalCards,
  type ApprovalDecision,
  type ApprovalRow,
} from "@/features/approvals";
import { apiJson } from "@/features/api";

interface ProjectsEnvelope {
  projects: Array<{ id: string; name: string }>;
}

export default function ApprovalsScreen() {
  const { tokens } = useTheme();
  const { status } = useLink();
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
    const link = getLinkManager();
    try {
      const outcome = await fetchPendingApprovals(link);
      if (outcome.ok) {
        setRows(outcome.data);
        setError(null);
      } else {
        setError(outcome.error.message);
      }
    } catch {
      setError("the host is offline — retrying");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Load on mount, on link reconnect, and on manual refresh.
  useEffect(() => {
    if (status === "connected") {
      void load();
    } else if (status === "unpaired") {
      setLoading(false);
    }
  }, [status, load]);

  // Project names for the captions (one quiet fetch; failures stay caption-less).
  useEffect(() => {
    if (status !== "connected") return;
    void apiJson<ProjectsEnvelope>(getLinkManager(), "/projects")
      .then((outcome) => {
        if (!outcome.ok) return;
        const map: Record<string, string> = {};
        for (const project of outcome.data.projects ?? []) map[project.id] = project.name;
        setProjectNames(map);
      })
      .catch(() => {
        // captions fall back to the honest ids — never a failure state
      });
  }, [status]);

  const cards = useMemo(() => (rows === null ? [] : toApprovalCards(rows, now)), [rows, now]);

  const decide = useCallback(
    async (id: string, decision: ApprovalDecision): Promise<string | null> => {
      const link = getLinkManager();
      try {
        const outcome = await postApprovalDecision(link, id, decision);
        if (outcome.ok) {
          // The optimistic card settled; the refresh lands the truth.
          void load();
          return null;
        }
        // 409 (already decided — the desktop or another phone won the race)
        // resolves honestly: refresh, the row is gone.
        void load();
        if (outcome.error.status === 409) return null;
        return outcome.error.message;
      } catch {
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
      tintColor={tokens.textTertiary}
      colors={[tokens.accent]}
      progressBackgroundColor={tokens.card}
    />
  );

  return (
    <ScreenScaffold title="Approvals" back={false} refreshControl={refreshControl}>
      {status === "unpaired" ? (
        <ErrorState title="No host linked" caption="Pair this phone to see approvals." />
      ) : loading ? (
        <LoadingState caption="Loading pending approvals…" />
      ) : error !== null && rows === null ? (
        <ErrorState title="Couldn't load approvals" caption={error} />
      ) : cards.length === 0 ? (
        <EmptyState
          Icon={ShieldCheck}
          title="Nothing is waiting on you."
          caption={
            error !== null
              ? `${error} — pull to retry`
              : "permission requests the agent raises will appear here"
          }
        />
      ) : (
        <>
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
