/**
 * The prompts editor: project picker chips (every registered project one
 * tap away; the first is the default), then the project's prompt sections —
 * id in mono, the description, the "overridden" badge when an override
 * exists. Tapping a row expands it inline: the BUILT-IN default text as a
 * collapsed mono preview above the editor, the current content in a tall
 * multiline input, Save (writing the override — with the honest warning
 * that content which trims to empty DROPS the section), and "Revert to
 * built-in" (only when an override exists).
 */

import { useCallback, useEffect, useState } from "react";
import { RefreshControl, StyleSheet, View } from "react-native";
import { ChevronDown, ChevronUp } from "lucide-react-native";
import { useRouter } from "expo-router";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { EmptyState, ErrorState, LoadingState } from "@/components/list-state";
import {
  Badge,
  ChromeButton,
  Chip,
  ClayInput,
  PressableCard,
  QuietButton,
  SectionHeader,
  StatusDot,
  TypeCaption,
  TypeMicro,
  TypeMono,
} from "@/design/primitives";
import { useTheme } from "@/design/theme";
import { RADIUS_INPUT, spacing } from "@/design/tokens";
import { warningHaptic } from "@/design/haptics";
import {
  fetchProjects,
  fetchPromptSections,
  revertPromptSection,
  savePromptSection,
  type ProjectRow,
  type PromptSectionView,
} from "@/features/config";
import { getLinkManager } from "@/link/runtime";
import { useLink } from "@/link/use-link";
import { mobLog, mobWarn } from "@/lib/log";

/** One-line truth under the save row (scoped to the open section). */
interface ActionNote {
  sectionId: string;
  kind: "saved" | "error" | "dropped" | "reverted";
  text: string;
}

export default function PromptsSettingsScreen() {
  const { tokens } = useTheme();
  const { status } = useLink();
  const connected = status === "connected";

  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [selectedRoot, setSelectedRoot] = useState<string | null>(null);
  const [sections, setSections] = useState<PromptSectionView[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // The open section, the edited texts (absent = the section's current
  // effective content), the per-section note, and the busy flag.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [draftOverrides, setDraftOverrides] = useState<Record<string, string>>({});
  const [note, setNote] = useState<ActionNote | null>(null);
  const [savingSectionId, setSavingSectionId] = useState<string | null>(null);

  // ── projects (the picker) ────────────────────────────────────────────────
  const loadProjects = useCallback(async () => {
    if (!connected) return;
    try {
      const outcome = await fetchProjects(getLinkManager());
      if (outcome.ok) {
        setProjects(outcome.data.projects);
        if (outcome.data.projects.length > 0) {
          setSelectedRoot((prev) => prev ?? outcome.data.projects[0].rootPath);
        }
        mobLog("config", "projects loaded for prompts", {
          count: outcome.data.projects.length,
        });
      } else {
        setLoadError(outcome.error.message);
        mobWarn("config", "projects load failed", {
          status: outcome.error.status,
          message: outcome.error.message,
        });
      }
    } catch (err) {
      setLoadError("the host dropped while loading — pull to retry");
      mobWarn("config", "projects load transport failure", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [connected]);

  // ── the sections for the selected project ────────────────────────────────
  const loadSections = useCallback(
    async (rootPath: string) => {
      if (!connected) return;
      setLoading(true);
      try {
        const outcome = await fetchPromptSections(getLinkManager(), rootPath);
        if (outcome.ok) {
          setSections(outcome.data.sections);
          setLoadError(null);
          mobLog("config", "prompt sections loaded", {
            rootPath,
            count: outcome.data.sections.length,
            overridden: outcome.data.overridden,
          });
        } else {
          setLoadError(outcome.error.message);
          mobWarn("config", "prompt sections load failed", {
            status: outcome.error.status,
            message: outcome.error.message,
          });
        }
      } catch (err) {
        setLoadError("the host dropped while loading — pull to retry");
        mobWarn("config", "prompt sections load transport failure", {
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setLoading(false);
      }
    },
    [connected],
  );

  useEffect(() => {
    if (connected) void loadProjects();
  }, [connected, loadProjects]);

  useEffect(() => {
    if (connected && selectedRoot !== null) void loadSections(selectedRoot);
  }, [connected, selectedRoot, loadSections]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadProjects();
    if (selectedRoot !== null) await loadSections(selectedRoot);
    setRefreshing(false);
  }, [loadProjects, loadSections, selectedRoot]);

  function pickProject(rootPath: string): void {
    if (rootPath === selectedRoot) return;
    setSelectedRoot(rootPath);
    setSections(null);
    setExpandedId(null);
    setDraftOverrides({});
    setNote(null);
  }

  function toggleSection(section: PromptSectionView): void {
    setExpandedId((prev) => (prev === section.id ? null : section.id));
    setNote(null);
  }

  /** The editor's text: the user's edit, else the section's current content. */
  function draftFor(section: PromptSectionView): string {
    const edited = draftOverrides[section.id];
    if (edited !== undefined) return edited;
    return section.overrideContent ?? section.defaultText ?? "";
  }

  async function saveSection(section: PromptSectionView): Promise<void> {
    if (selectedRoot === null) return;
    const content = draftFor(section);
    setSavingSectionId(section.id);
    setNote(null);
    try {
      const outcome = await savePromptSection(getLinkManager(), section.id, selectedRoot, content);
      if (outcome.ok) {
        setNote(
          outcome.data.dropped
            ? {
                sectionId: section.id,
                kind: "dropped",
                text: "saved — the section is now DROPPED from the prompt (empty content)",
              }
            : { sectionId: section.id, kind: "saved", text: "override saved" },
        );
        mobLog("config", "prompt section saved", {
          sectionId: section.id,
          dropped: outcome.data.dropped,
        });
        await loadSections(selectedRoot);
      } else {
        setNote({ sectionId: section.id, kind: "error", text: outcome.error.message });
        mobWarn("config", "prompt section save failed", {
          sectionId: section.id,
          status: outcome.error.status,
          message: outcome.error.message,
        });
        warningHaptic();
      }
    } catch (err) {
      setNote({
        sectionId: section.id,
        kind: "error",
        text: "the host dropped while saving — nothing was written",
      });
      mobWarn("config", "prompt section save transport failure", {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSavingSectionId(null);
    }
  }

  async function revertSection(section: PromptSectionView): Promise<void> {
    if (selectedRoot === null) return;
    setSavingSectionId(section.id);
    setNote(null);
    try {
      const outcome = await revertPromptSection(getLinkManager(), section.id, selectedRoot);
      if (outcome.ok) {
        setNote({ sectionId: section.id, kind: "reverted", text: "reverted to the built-in" });
        // The editor falls back to the (restored) default text.
        setDraftOverrides((prev) => {
          const next = { ...prev };
          delete next[section.id];
          return next;
        });
        mobLog("config", "prompt section reverted", { sectionId: section.id });
        await loadSections(selectedRoot);
      } else {
        setNote({ sectionId: section.id, kind: "error", text: outcome.error.message });
        mobWarn("config", "prompt section revert failed", {
          sectionId: section.id,
          status: outcome.error.status,
          message: outcome.error.message,
        });
      }
    } catch (err) {
      setNote({
        sectionId: section.id,
        kind: "error",
        text: "the host dropped while reverting — nothing was written",
      });
      mobWarn("config", "prompt section revert transport failure", {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSavingSectionId(null);
    }
  }

  return (
    <ScreenScaffold
      title="Prompts"
      back
      subtitle="per-project section overrides"
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
      ) : projects === null ? (
        loadError !== null ? (
          <ErrorState
            title="could not load projects"
            caption={loadError}
            retryLabel="try again"
            onRetry={() => void loadProjects()}
          />
        ) : (
          <LoadingState caption="loading projects…" />
        )
      ) : projects.length === 0 ? (
        <EmptyState
          title="no projects registered"
          caption="prompt sections are per-project — register a project on the desktop to edit its prompt here."
        />
      ) : (
        <>
          {/* ── the project picker ── */}
          <View style={styles.chipRow}>
            {projects.map((project) => (
              <Chip
                key={project.id}
                selected={project.rootPath === selectedRoot}
                onPress={() => pickProject(project.rootPath)}
                testID={`project-chip-${project.id}`}
              >
                {project.name}
              </Chip>
            ))}
          </View>

          {/* ── the sections ── */}
          <SectionHeader>
            {`Sections${sections !== null ? ` (${sections.length})` : ""}`}
          </SectionHeader>
          {loading && sections === null ? (
            <LoadingState caption="loading the prompt sections…" />
          ) : sections === null ? (
            loadError !== null ? (
              <ErrorState
                title="could not load the sections"
                caption={loadError}
                retryLabel="try again"
                onRetry={() => (selectedRoot !== null ? void loadSections(selectedRoot) : undefined)}
              />
            ) : (
              <LoadingState caption="loading the prompt sections…" />
            )
          ) : sections.length === 0 ? (
            <EmptyState
              title="no sections"
              caption="this project's section registry is empty — an honest, unusual state."
            />
          ) : (
            sections.map((section, index) => (
              <SectionCard
                key={section.id}
                section={section}
                index={index}
                expanded={expandedId === section.id}
                draft={draftFor(section)}
                note={note !== null && note.sectionId === section.id ? note : null}
                busy={savingSectionId === section.id}
                onToggle={() => toggleSection(section)}
                onDraftChange={(text) =>
                  setDraftOverrides((prev) => ({ ...prev, [section.id]: text }))
                }
                onSave={() => void saveSection(section)}
                onRevert={() => void revertSection(section)}
              />
            ))
          )}

          {loadError !== null && sections !== null ? (
            <View style={styles.noteRow}>
              <StatusDot color={tokens.warning} />
              <TypeCaption style={{ flex: 1, color: tokens.warning }} numberOfLines={2}>
                {loadError}
              </TypeCaption>
            </View>
          ) : null}
        </>
      )}
    </ScreenScaffold>
  );
}

// ── the section card (row + inline expansion) ───────────────────────────────

function SectionCard({
  section,
  index,
  expanded,
  draft,
  note,
  busy,
  onToggle,
  onDraftChange,
  onSave,
  onRevert,
}: {
  section: PromptSectionView;
  index: number;
  expanded: boolean;
  draft: string;
  note: ActionNote | null;
  busy: boolean;
  onToggle: () => void;
  onDraftChange: (text: string) => void;
  onSave: () => void;
  onRevert: () => void;
}) {
  const { tokens } = useTheme();
  const overridden = section.overrideContent !== null;
  const trimsEmpty = draft.trim() === "";

  return (
    <View style={styles.sectionBlock}>
      <PressableCard
        enterIndex={Math.min(index, 12)}
        onPress={onToggle}
        accessibilityLabel={`Prompt section ${section.id}${overridden ? ", overridden" : ""}`}
      >
        <View style={styles.rowInner}>
          <View style={styles.rowText}>
            <View style={styles.rowTitleLine}>
              <TypeMono numberOfLines={1} style={styles.sectionId}>
                {section.id}
              </TypeMono>
              {overridden ? <Badge tone="accent">overridden</Badge> : null}
              {section.dynamic ? <Badge tone="neutral">dynamic</Badge> : null}
            </View>
            <TypeCaption numberOfLines={2}>{section.description}</TypeCaption>
          </View>
          {expanded ? (
            <ChevronUp size={18} color={tokens.textTertiary} strokeWidth={2.2} />
          ) : (
            <ChevronDown size={18} color={tokens.textTertiary} strokeWidth={2.2} />
          )}
        </View>
      </PressableCard>

      {expanded ? (
        <View style={styles.expandPad}>
          {/* the built-in default — the read-only reference */}
          <TypeMicro>BUILT-IN DEFAULT (READ-ONLY)</TypeMicro>
          <View
            style={[
              styles.defaultPreview,
              { backgroundColor: tokens.monoBg, borderColor: tokens.monoBorder },
            ]}
          >
            <TypeMono numberOfLines={6} style={styles.defaultText}>
              {section.defaultText ?? "(no default text — the section composes dynamically)"}
            </TypeMono>
          </View>

          {/* the editor */}
          <ClayInput
            label={overridden ? "Override content" : "New override content"}
            value={draft}
            onChangeText={onDraftChange}
            multiline
            style={styles.contentInput}
            accessibilityLabel={`Override content for section ${section.id}`}
          />
          {trimsEmpty ? (
            <View style={styles.noteRow}>
              <StatusDot color={tokens.warning} />
              <TypeCaption style={{ flex: 1, color: tokens.warning }}>
                saving empty DROPS the section from the prompt — use "revert to built-in"
                to restore the default instead.
              </TypeCaption>
            </View>
          ) : null}
          <View style={styles.actionRow}>
            <ChromeButton
              onPress={onSave}
              busy={busy}
              style={styles.saveButton}
              accessibilityLabel={`Save section ${section.id}`}
            >
              Save override
            </ChromeButton>
            {overridden ? (
              <QuietButton onPress={onRevert} disabled={busy} style={styles.revertButton}>
                Revert to built-in
              </QuietButton>
            ) : null}
          </View>
          {note !== null ? (
            <View style={styles.noteRow}>
              <StatusDot
                color={
                  note.kind === "error"
                    ? tokens.danger
                    : note.kind === "dropped"
                      ? tokens.warning
                      : tokens.success
                }
              />
              <TypeCaption
                style={{
                  flex: 1,
                  color:
                    note.kind === "error"
                      ? tokens.danger
                      : note.kind === "dropped"
                        ? tokens.warning
                        : tokens.success,
                }}
                numberOfLines={3}
              >
                {note.text}
              </TypeCaption>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

// ── the honest not-connected gate ───────────────────────────────────────────

function HostGate({ status }: { status: "unpaired" | "probing" | "offline" }) {
  const router = useRouter();
  const unpaired = status === "unpaired";
  return (
    <ErrorState
      title={unpaired ? "no host linked" : "host offline"}
      caption={
        unpaired
          ? "prompt sections live in each project on the desktop — pair one to edit them here."
          : "the sections reload the moment the link returns — nothing is lost."
      }
      retryLabel={unpaired ? "link a desktop" : "retry now"}
      onRetry={() => (unpaired ? router.push("/connect") : getLinkManager().retryNow())}
    />
  );
}

const styles = StyleSheet.create({
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  sectionBlock: { gap: spacing.sm },
  rowInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.lg,
    minHeight: 68,
  },
  rowText: { flex: 1, gap: 3 },
  rowTitleLine: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  sectionId: { fontSize: 13, lineHeight: 17 },
  expandPad: { padding: spacing.md, gap: spacing.md },
  defaultPreview: {
    borderRadius: RADIUS_INPUT,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.md,
  },
  defaultText: { fontSize: 11, lineHeight: 16 },
  contentInput: { minHeight: 140, textAlignVertical: "top" },
  actionRow: { flexDirection: "row", gap: spacing.md, alignItems: "center" },
  saveButton: { flex: 1 },
  revertButton: { flex: 1 },
  noteRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
});
