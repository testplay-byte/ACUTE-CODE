/**
 * Projects — the desktop's project registry (GET /projects): name, the
 * root-path caption, the project's own color dot, and the session count
 * (the shape doesn't carry it — one sessions fetch folds it client-side,
 * failing quiet). Tap drills into the project's sessions (the sessions tab
 * with ?projectId= — the route has no server-side filter, the list folds).
 * Empty state + pull-to-refresh; nothing is ever created or edited here
 * (the phone is view + input — LINKING-PROTOCOL §4).
 */

import { useCallback, useEffect, useState } from "react";
import { RefreshControl, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { Folder } from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { EmptyState, ErrorState, LoadingState } from "@/components/list-state";
import { PressableCard, TypeBody, TypeCaption } from "@/design/primitives";
import { useTheme } from "@/design/theme";
import { RADIUS_PILL, spacing } from "@/design/tokens";
import { useLink } from "@/link/use-link";
import { getLinkManager } from "@/link/runtime";
import { apiJson } from "@/features/api";
import { fetchSessions } from "@/features/sessions";

interface ProjectRow {
  id: string;
  name: string;
  rootPath: string;
  color: string;
  createdAt: string;
}

export default function ProjectsScreen() {
  const { tokens } = useTheme();
  const router = useRouter();
  const { status } = useLink();
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [sessionCounts, setSessionCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const link = getLinkManager();
    try {
      const outcome = await apiJson<{ projects: ProjectRow[] }>(link, "/projects");
      if (outcome.ok) {
        setProjects(Array.isArray(outcome.data.projects) ? outcome.data.projects : []);
        setError(null);
      } else {
        setError(outcome.error.message);
      }
      // The session counts — a quiet client-side fold; failure keeps quiet.
      const sessionsOutcome = await fetchSessions(link, { limit: 200 }).catch(() => null);
      if (sessionsOutcome !== null && sessionsOutcome.ok) {
        const counts: Record<string, number> = {};
        for (const session of sessionsOutcome.data.sessions) {
          if (session.projectId !== null) {
            counts[session.projectId] = (counts[session.projectId] ?? 0) + 1;
          }
        }
        setSessionCounts(counts);
      }
    } catch {
      setError("the host is offline — retrying");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (status === "connected") {
      void load();
    }
  }, [status, load]);

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
    <ScreenScaffold title="Projects" back={false} refreshControl={refreshControl}>
      {status === "unpaired" ? (
        <ErrorState title="No host linked" caption="Pair this phone to see projects." />
      ) : loading ? (
        <LoadingState caption="Loading projects…" />
      ) : error !== null && projects === null ? (
        <ErrorState title="Couldn't load projects" caption={error} />
      ) : (projects ?? []).length === 0 ? (
        <EmptyState
          Icon={Folder}
          title="No projects yet."
          caption="projects registered on the desktop appear here"
        />
      ) : (
        <View style={styles.list}>
          {(projects ?? []).map((project, index) => (
            <PressableCard
              key={project.id}
              accessibilityLabel={`Open project sessions: ${project.name}`}
              enterIndex={index}
              onPress={() =>
                router.push({ pathname: "/sessions", params: { projectId: project.id } })
              }
            >
              <View style={styles.row}>
                <View style={[styles.dot, { backgroundColor: project.color }]} />
                <View style={{ flex: 1, gap: 2 }}>
                  <TypeBody style={{ color: tokens.text, fontWeight: "600" }} numberOfLines={1}>
                    {project.name}
                  </TypeBody>
                  <TypeCaption style={{ color: tokens.textTertiary }} numberOfLines={1}>
                    {project.rootPath}
                  </TypeCaption>
                </View>
                <TypeCaption style={{ color: tokens.textSecondary }}>
                  {sessionCounts[project.id] !== undefined
                    ? `${sessionCounts[project.id]} session${sessionCounts[project.id] === 1 ? "" : "s"}`
                    : ""}
                </TypeCaption>
              </View>
            </PressableCard>
          ))}
        </View>
      )}
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  list: {
    gap: spacing.md,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  dot: {
    width: 12,
    height: 12,
    borderRadius: RADIUS_PILL,
  },
});
