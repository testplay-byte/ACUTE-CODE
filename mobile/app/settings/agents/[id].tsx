/**
 * The agent editor: name, role, model (provider id + model id as honest
 * plain text fields with captions explaining the format), maxTurns stepper,
 * temperature stepper (0.1 steps across 0–2), and the system prompt in a
 * tall multiline input. Save PATCHes ONLY the changed subset. Templates are
 * read-only — the honest "templates are the desktop's" caption (duplicate
 * one on the desktop to edit a copy).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshControl, StyleSheet, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Bot, Minus, Plus } from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { ErrorState, LoadingState } from "@/components/list-state";
import {
  Badge,
  ChromeButton,
  ClayCard,
  ClayInput,
  Hairline,
  PressableCard,
  SectionHeader,
  StatusDot,
  TypeBody,
  TypeBodyStrong,
  TypeCaption,
  TypeMicro,
} from "@/design/primitives";
import { useTheme } from "@/design/theme";
import { spacing } from "@/design/tokens";
import { updateAgent, fetchAgents, type AgentRow } from "@/features/config";
import { getLinkManager } from "@/link/runtime";
import { useLink } from "@/link/use-link";
import { mobLog, mobWarn } from "@/lib/log";

/** One-line truth under the save button. */
interface ActionNote {
  kind: "saved" | "error";
  text: string;
}

// Stepper bounds — the desktop's own PATCH validation edges.
const MAX_TURNS = { min: 0, max: 100 };
const TEMPERATURE_TENTHS = { min: 0, max: 20 };

export default function AgentDetailScreen() {
  const { tokens } = useTheme();
  const { status } = useLink();
  const connected = status === "connected";
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [agent, setAgent] = useState<AgentRow | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // The edit form (hydrated once, on the first agent read).
  const formHydrated = useRef(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [providerIdText, setProviderIdText] = useState("");
  const [modelText, setModelText] = useState("");
  const [maxTurns, setMaxTurns] = useState(0);
  const [temperatureTenths, setTemperatureTenths] = useState(7);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<ActionNote | null>(null);

  const load = useCallback(async () => {
    if (!connected || typeof id !== "string") return;
    setLoading(true);
    try {
      const outcome = await fetchAgents(getLinkManager());
      if (outcome.ok) {
        const row = outcome.data.agents.find((a) => a.id === id) ?? null;
        setAgent(row);
        setNotFound(row === null);
        if (row !== null && !formHydrated.current) {
          formHydrated.current = true;
          setName(row.name);
          setRole(row.role);
          setProviderIdText(row.providerId ?? "");
          setModelText(row.model ?? "");
          setMaxTurns(row.maxTurns);
          setTemperatureTenths(Math.round(row.temperature * 10));
          setSystemPrompt(row.systemPrompt);
        }
        mobLog("config", "agent detail loaded", { id });
      } else {
        mobWarn("config", "agent detail load failed", {
          status: outcome.error.status,
          message: outcome.error.message,
        });
      }
    } catch (err) {
      mobWarn("config", "agent detail load transport failure", {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading(false);
    }
  }, [connected, id]);

  useEffect(() => {
    if (connected) void load();
  }, [connected, load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  // The changed-subset PATCH body (blank provider/model = inherit = null).
  function buildBody(): Partial<
    Pick<
      AgentRow,
      | "name"
      | "role"
      | "systemPrompt"
      | "providerId"
      | "model"
      | "maxTurns"
      | "temperature"
    >
  > | null {
    if (agent === null) return null;
    const nextName = name.trim();
    const nextProviderId = providerIdText.trim() === "" ? null : providerIdText.trim();
    const nextModel = modelText.trim() === "" ? null : modelText.trim();
    const nextTemperature = temperatureTenths / 10;
    const body: Partial<
      Pick<
        AgentRow,
        | "name"
        | "role"
        | "systemPrompt"
        | "providerId"
        | "model"
        | "maxTurns"
        | "temperature"
      >
    > = {};
    if (nextName !== agent.name) body.name = nextName;
    if (role !== agent.role) body.role = role;
    if (nextProviderId !== agent.providerId) body.providerId = nextProviderId;
    if (nextModel !== agent.model) body.model = nextModel;
    if (maxTurns !== agent.maxTurns) body.maxTurns = maxTurns;
    if (temperatureTenths !== Math.round(agent.temperature * 10)) {
      body.temperature = nextTemperature;
    }
    if (systemPrompt !== agent.systemPrompt) body.systemPrompt = systemPrompt;
    return Object.keys(body).length === 0 ? null : body;
  }

  const dirty = buildBody() !== null;

  async function save(): Promise<void> {
    const body = buildBody();
    if (agent === null || body === null) return;
    if (name.trim() === "") {
      setNote({ kind: "error", text: "name cannot be empty" });
      return;
    }
    setSaving(true);
    setNote(null);
    try {
      const outcome = await updateAgent(getLinkManager(), agent.id, body);
      if (outcome.ok) {
        setAgent(outcome.data);
        hydrateFrom(outcome.data);
        setNote({ kind: "saved", text: "saved on the desktop" });
        mobLog("config", "agent updated", { id: agent.id, keys: Object.keys(body) });
      } else {
        setNote({ kind: "error", text: outcome.error.message });
        mobWarn("config", "agent PATCH failed", {
          id: agent.id,
          status: outcome.error.status,
          message: outcome.error.message,
        });
      }
    } catch (err) {
      setNote({ kind: "error", text: "the host dropped while saving — nothing was changed" });
      mobWarn("config", "agent PATCH transport failure", {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  }

  function hydrateFrom(row: AgentRow): void {
    setName(row.name);
    setRole(row.role);
    setProviderIdText(row.providerId ?? "");
    setModelText(row.model ?? "");
    setMaxTurns(row.maxTurns);
    setTemperatureTenths(Math.round(row.temperature * 10));
    setSystemPrompt(row.systemPrompt);
  }

  const title = agent?.name ?? "Agent";

  return (
    <ScreenScaffold
      title={title}
      back
      subtitle={agent !== null ? agent.role : undefined}
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
      ) : loading && agent === null && !notFound ? (
        <LoadingState caption="loading the agent…" />
      ) : notFound ? (
        <ErrorState
          title="agent not found"
          caption="it may have been deleted on the desktop — the roster is one back tap away."
          retryLabel="back to the roster"
          onRetry={() => router.back()}
        />
      ) : agent === null ? (
        <LoadingState caption="loading the agent…" />
      ) : agent.isTemplate ? (
        // ── the read-only template view ──
        <>
          <ClayCard elevated>
            <View style={styles.identityPad}>
              <View style={styles.identityHead}>
                <View style={[styles.identityIcon, { backgroundColor: tokens.subtleHover }]}>
                  <Bot size={22} color={tokens.accent} strokeWidth={2.2} />
                </View>
                <View style={styles.identityText}>
                  <TypeBodyStrong>{agent.name}</TypeBodyStrong>
                  <TypeCaption numberOfLines={2}>{agent.role}</TypeCaption>
                </View>
                <Badge tone="accent">template</Badge>
              </View>
              <TypeCaption style={styles.templateNote}>
                templates are the desktop's — duplicate one there to edit a copy.
              </TypeCaption>
            </View>
          </ClayCard>

          <SectionHeader>The values</SectionHeader>
          <ClayCard>
            <View style={styles.factsPad}>
              <FactRow label="MODEL" value={modelLineOf(agent)} />
              <Hairline inset={spacing.lg} />
              <FactRow label="MAX TURNS" value={String(agent.maxTurns)} />
              <Hairline inset={spacing.lg} />
              <FactRow label="TEMPERATURE" value={agent.temperature.toFixed(1)} />
            </View>
          </ClayCard>

          <SectionHeader>System prompt</SectionHeader>
          <ClayCard>
            <View style={styles.promptPad}>
              <TypeBody style={styles.promptBody}>{agent.systemPrompt}</TypeBody>
            </View>
          </ClayCard>
        </>
      ) : (
        // ── the editor ──
        <>
          <SectionHeader>Identity</SectionHeader>
          <ClayCard>
            <View style={styles.formPad}>
              <ClayInput
                label="Name"
                value={name}
                onChangeText={setName}
                accessibilityLabel="Agent name"
              />
              <ClayInput
                label="Role"
                value={role}
                onChangeText={setRole}
                accessibilityLabel="Agent role"
                caption="the one-line job shown under the name"
              />
            </View>
          </ClayCard>

          <SectionHeader>Model</SectionHeader>
          <ClayCard>
            <View style={styles.formPad}>
              <ClayInput
                label="Provider id"
                mono
                value={providerIdText}
                onChangeText={setProviderIdText}
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel="Agent provider id"
                caption="a provider id from the Providers page (e.g. openrouter) — blank inherits the desktop default"
              />
              <ClayInput
                label="Model id"
                mono
                value={modelText}
                onChangeText={setModelText}
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel="Agent model id"
                caption="the provider's model id (e.g. claude-sonnet-4-5) — blank inherits the desktop default"
              />
            </View>
          </ClayCard>

          <SectionHeader>Limits</SectionHeader>
          <ClayCard>
            <StepperRow
              label="Max turns"
              caption="turns before the agent must stop and report"
              value={maxTurns}
              min={MAX_TURNS.min}
              max={MAX_TURNS.max}
              format={(v) => String(v)}
              onStep={setMaxTurns}
            />
            <Hairline inset={spacing.lg} />
            <StepperRow
              label="Temperature"
              caption="0 focused · 2 loose"
              value={temperatureTenths}
              min={TEMPERATURE_TENTHS.min}
              max={TEMPERATURE_TENTHS.max}
              format={(v) => (v / 10).toFixed(1)}
              onStep={setTemperatureTenths}
            />
          </ClayCard>

          <SectionHeader>System prompt</SectionHeader>
          <ClayCard>
            <View style={styles.formPad}>
              <ClayInput
                label="System prompt"
                value={systemPrompt}
                onChangeText={setSystemPrompt}
                multiline
                style={styles.promptInput}
                accessibilityLabel="Agent system prompt"
                caption="the agent's standing instructions — the whole prompt is sent every turn"
              />
            </View>
          </ClayCard>

          <ChromeButton
            onPress={() => void save()}
            busy={saving}
            disabled={!dirty}
            accessibilityLabel="Save agent changes"
          >
            {dirty ? "Save changes" : "No changes yet"}
          </ChromeButton>
          {note !== null ? <NoteLine note={note} /> : null}
        </>
      )}
    </ScreenScaffold>
  );
}

function modelLineOf(agent: AgentRow): string {
  return agent.providerId !== null && agent.model !== null
    ? `${agent.providerId}/${agent.model}`
    : "desktop default";
}

// ── small shared pieces ─────────────────────────────────────────────────────

function NoteLine({ note }: { note: ActionNote }) {
  const { tokens } = useTheme();
  const isError = note.kind === "error";
  return (
    <View style={styles.noteRow}>
      <StatusDot color={isError ? tokens.danger : tokens.success} />
      <TypeCaption
        style={{ flex: 1, color: isError ? tokens.danger : tokens.success }}
        numberOfLines={3}
      >
        {note.text}
      </TypeCaption>
    </View>
  );
}

function FactRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.factRow}>
      <TypeMicro>{label}</TypeMicro>
      <TypeBodyStrong>{value}</TypeBodyStrong>
    </View>
  );
}

/** The stepper row: label + caption left, the clay − / value / + triplet right. */
function StepperRow({
  label,
  caption,
  value,
  min,
  max,
  format,
  onStep,
}: {
  label: string;
  caption: string;
  value: number;
  min: number;
  max: number;
  format: (value: number) => string;
  onStep: (next: number) => void;
}) {
  const { tokens } = useTheme();
  const decDisabled = value <= min;
  const incDisabled = value >= max;
  return (
    <View style={styles.rowInner}>
      <View style={styles.rowText}>
        <TypeBodyStrong>{label}</TypeBodyStrong>
        <TypeCaption numberOfLines={2}>{caption}</TypeCaption>
      </View>
      <View style={styles.stepperRow}>
        <PressableCard
          onPress={() => onStep(Math.max(min, value - 1))}
          disabled={decDisabled}
          accessibilityLabel={`Decrease ${label}`}
          style={styles.stepButton}
        >
          <Minus size={18} color={decDisabled ? tokens.textTertiary : tokens.text} strokeWidth={2.4} />
        </PressableCard>
        <TypeBodyStrong style={styles.stepValue} accessibilityLabel={`${label}: ${format(value)}`}>
          {format(value)}
        </TypeBodyStrong>
        <PressableCard
          onPress={() => onStep(Math.min(max, value + 1))}
          disabled={incDisabled}
          accessibilityLabel={`Increase ${label}`}
          style={styles.stepButton}
        >
          <Plus size={18} color={incDisabled ? tokens.textTertiary : tokens.text} strokeWidth={2.4} />
        </PressableCard>
      </View>
    </View>
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
          ? "this agent lives on the desktop — pair one to edit it here."
          : "the agent reloads the moment the link returns."
      }
      retryLabel={unpaired ? "link a desktop" : "retry now"}
      onRetry={() => (unpaired ? router.push("/connect") : getLinkManager().retryNow())}
    />
  );
}

const styles = StyleSheet.create({
  identityPad: { padding: spacing.lg, gap: spacing.md },
  identityHead: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  identityIcon: {
    width: 48,
    height: 48,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  identityText: { flex: 1, gap: 3 },
  templateNote: { lineHeight: 18 },
  factsPad: { padding: spacing.lg },
  factRow: { gap: spacing.xs, paddingVertical: spacing.md },
  promptPad: { padding: spacing.lg },
  promptBody: { lineHeight: 21 },
  formPad: { padding: spacing.lg, gap: spacing.md },
  promptInput: { minHeight: 160, textAlignVertical: "top" },
  rowInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.lg,
    minHeight: 64,
  },
  rowText: { flex: 1, gap: 3 },
  stepperRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  stepButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  stepValue: { minWidth: 40, textAlign: "center", fontSize: 16 },
  noteRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
});
