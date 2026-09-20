/**
 * Preferences — the desktop preferences editor: orchestration (maxParallel
 * + perKeyLimit steppers), retry (the three auto-retry toggles + the
 * maxAttempts stepper), memory, debug, thinking-loop, and
 * desktop-notifications (enabled toggles). Every change saves IMMEDIATELY
 * (optimistic PUT /settings/:domain) and reverts with an honest inline
 * caption when the desktop refuses or the link drops — nothing pretends to
 * be saved. The toggles are the house ClaySwitch (accent pill + sliding
 * dot, the house spring — never the react-native Switch), the steppers are
 * clay − / value / + triplets.
 *
 * R113-e — LIVE: every settings PUT broadcasts on the events bus, so a
 * change made on the PC (or another phone) lands here while the screen is
 * open: the events store's settings epoch moves → this screen reloads its
 * domains (the owner's "the settings do not appear to be changing in live
 * view" — the phone's half of the fix).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { Minus, Plus } from "lucide-react-native";
import { useRouter } from "expo-router";
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { ErrorState, LoadingState } from "@/components/list-state";
import {
  ClayCard,
  Hairline,
  PressableCard,
  SectionHeader,
  StatusDot,
  TypeBodyStrong,
  TypeCaption,
} from "@/design/primitives";
import { useTheme } from "@/design/theme";
import { spacing } from "@/design/tokens";
import { SPRING } from "@/design/motion";
import { warningHaptic } from "@/design/haptics";
import {
  fetchSettings,
  saveSettings,
  type OrchestrationSettings,
  type RetrySettings,
  type ThinkingLoopSettings,
} from "@/features/config";
import type { ApiOutcome } from "@/features/api";
import { useEventsEpoch } from "@/features/events";
import { getLinkManager } from "@/link/runtime";
import { useLink } from "@/link/use-link";
import { mobLog, mobWarn } from "@/lib/log";

// The one-field domains config.ts has no interface for (the desktop's
// storage/settings.ts shapes, 1:1 — GET returns {enabled}).
interface MemorySettings {
  enabled: boolean;
}
interface DebugSettings {
  enabled: boolean;
}
interface DesktopNotificationsSettings {
  enabled: boolean;
}

/** The toast-style truth line under the header (saved / not saved). */
interface SaveNote {
  kind: "saved" | "error";
  text: string;
}

// Stepper bounds — the desktop's own validation edges (settings.ts route).
const MAX_PARALLEL = { min: 1, max: 50 };
const PER_KEY_LIMIT = { min: 1, max: 10 };
const MAX_ATTEMPTS = { min: 2, max: 10 };

export default function PreferencesSettingsScreen() {
  const { tokens } = useTheme();
  const { status } = useLink();
  const connected = status === "connected";

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [note, setNote] = useState<SaveNote | null>(null);

  const [orchestration, setOrchestration] = useState<OrchestrationSettings | null>(null);
  const [retry, setRetry] = useState<RetrySettings | null>(null);
  const [memory, setMemory] = useState<MemorySettings | null>(null);
  const [debug, setDebug] = useState<DebugSettings | null>(null);
  const [thinkingLoop, setThinkingLoop] = useState<ThinkingLoopSettings | null>(null);
  const [notifications, setNotifications] = useState<DesktopNotificationsSettings | null>(null);

  // R113-e: the live settings epoch — a settings frame (another device's
  // PUT, or the hello resync) moves it while this screen is open.
  const settingsEpoch = useEventsEpoch("settings");
  // The MOUNT value — the refetch fires only when the epoch moves PAST it
  // (the mount load above owns the first fetch; the finisher's fix — the
  // epoch-0 check double-fetched whenever frames had landed pre-open).
  const mountEpoch = useRef(settingsEpoch);

  // ── load: every domain in one round, connected only ──────────────────────
  const load = useCallback(async () => {
    if (!connected) return;
    setLoading(true);
    const sender = getLinkManager();
    try {
      const [orch, retr, mem, dbg, loop, notif] = await Promise.all([
        fetchSettings<OrchestrationSettings>(sender, "orchestration"),
        fetchSettings<RetrySettings>(sender, "retry"),
        fetchSettings<MemorySettings>(sender, "memory"),
        fetchSettings<DebugSettings>(sender, "debug"),
        fetchSettings<ThinkingLoopSettings>(sender, "thinking-loop"),
        fetchSettings<DesktopNotificationsSettings>(sender, "desktop-notifications"),
      ]);
      let firstError: string | null = null;
      const fail = (label: string, outcome: ApiOutcome<unknown>): void => {
        if (!outcome.ok && firstError === null) {
          firstError = `${label}: ${outcome.error.message}`;
        }
      };
      fail("orchestration", orch);
      fail("retry", retr);
      fail("memory", mem);
      fail("debug", dbg);
      fail("thinking-loop", loop);
      fail("desktop-notifications", notif);
      if (orch.ok) setOrchestration(orch.data);
      if (retr.ok) setRetry(retr.data);
      if (mem.ok) setMemory(mem.data);
      if (dbg.ok) setDebug(dbg.data);
      if (loop.ok) setThinkingLoop(loop.data);
      if (notif.ok) setNotifications(notif.data);
      setLoadError(firstError);
      if (firstError !== null) {
        mobWarn("config", "settings load partially failed", { firstError });
        warningHaptic();
      } else {
        mobLog("config", "settings loaded (6 domains)");
      }
    } catch (err) {
      setLoadError("the host dropped while loading — pull to retry");
      mobWarn("config", "settings load transport failure", {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading(false);
    }
  }, [connected]);

  useEffect(() => {
    if (connected) void load();
  }, [connected, load]);

  // R113-e: the live refetch — the settings world changed under us (a PUT
  // from the PC, a reconnect's hello). The MOUNT value is skipped — the mount
  // load above owns the first fetch; our OWN saves also echo back as frames —
  // a reload that re-confirms what the optimistic state already shows
  // (harmless, honest).
  useEffect(() => {
    if (settingsEpoch === mountEpoch.current) return;
    if (connected) void load();
  }, [settingsEpoch, connected, load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  // ── save: optimistic PUT, honest revert ──────────────────────────────────
  async function commit<T extends object>(
    domain: string,
    body: Partial<T>,
    restore: () => void,
  ): Promise<void> {
    try {
      const outcome = await saveSettings<T>(getLinkManager(), domain, body);
      if (outcome.ok) {
        setNote({ kind: "saved", text: "saved on the desktop" });
        mobLog("config", `settings ${domain} saved`, { keys: Object.keys(body) });
      } else {
        restore();
        setNote({ kind: "error", text: `not saved — ${outcome.error.message}` });
        mobWarn("config", `settings PUT ${domain} failed`, {
          status: outcome.error.status,
          message: outcome.error.message,
        });
        warningHaptic();
      }
    } catch (err) {
      restore();
      setNote({ kind: "error", text: "the host dropped while saving — the change was reverted" });
      mobWarn("config", `settings PUT ${domain} transport failure`, {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function stepOrchestration<K extends "maxParallel" | "perKeyLimit">(
    key: K,
    next: number,
  ): void {
    if (orchestration === null) return;
    const prev = orchestration;
    setOrchestration({ ...prev, [key]: next });
    void commit<OrchestrationSettings>("orchestration", { [key]: next } as Partial<OrchestrationSettings>, () =>
      setOrchestration(prev),
    );
  }

  function stepRetry(key: "maxAttempts", next: number): void {
    if (retry === null) return;
    const prev = retry;
    setRetry({ ...prev, [key]: next });
    void commit<RetrySettings>("retry", { [key]: next }, () => setRetry(prev));
  }

  function toggleRetry(key: "autoRetryRateLimit" | "autoRetryTimeout" | "autoRetryNetwork"): void {
    if (retry === null) return;
    const prev = retry;
    const next = !prev[key];
    setRetry({ ...prev, [key]: next });
    void commit<RetrySettings>("retry", { [key]: next }, () => setRetry(prev));
  }

  function toggleMemory(): void {
    if (memory === null) return;
    const prev = memory;
    const next = !prev.enabled;
    setMemory({ enabled: next });
    void commit<MemorySettings>("memory", { enabled: next }, () => setMemory(prev));
  }

  function toggleDebug(): void {
    if (debug === null) return;
    const prev = debug;
    const next = !prev.enabled;
    setDebug({ enabled: next });
    void commit<DebugSettings>("debug", { enabled: next }, () => setDebug(prev));
  }

  function toggleThinkingLoop(): void {
    if (thinkingLoop === null) return;
    const prev = thinkingLoop;
    const next = !prev.enabled;
    setThinkingLoop({ ...prev, enabled: next });
    void commit<ThinkingLoopSettings>("thinking-loop", { enabled: next }, () =>
      setThinkingLoop(prev),
    );
  }

  function toggleNotifications(): void {
    if (notifications === null) return;
    const prev = notifications;
    const next = !prev.enabled;
    setNotifications({ enabled: next });
    void commit<DesktopNotificationsSettings>("desktop-notifications", { enabled: next }, () =>
      setNotifications(prev),
    );
  }

  return (
    <ScreenScaffold
      title="Preferences"
      back
      subtitle="the desktop's runtime behavior"
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
      ) : loading && orchestration === null ? (
        <LoadingState caption="loading the desktop's settings…" />
      ) : (
        <>
          <NoteLine note={note} />
          {loadError !== null ? (
            <View style={styles.loadErrorRow}>
              <StatusDot color={tokens.warning} />
              <TypeCaption style={{ color: tokens.warning, flex: 1 }}>{loadError}</TypeCaption>
            </View>
          ) : null}

          <SectionHeader>Orchestration</SectionHeader>
          <ClayCard>
            {orchestration !== null ? (
              <>
                <StepperRow
                  label="Max parallel"
                  caption="parallel sub-agent turns the desktop will run at once"
                  value={orchestration.maxParallel}
                  min={MAX_PARALLEL.min}
                  max={MAX_PARALLEL.max}
                  format={(v) => String(v)}
                  onStep={(next) => stepOrchestration("maxParallel", next)}
                />
                <Hairline inset={spacing.lg} />
                <StepperRow
                  label="Per-key limit"
                  caption="requests each API key may carry per window"
                  value={orchestration.perKeyLimit}
                  min={PER_KEY_LIMIT.min}
                  max={PER_KEY_LIMIT.max}
                  format={(v) => String(v)}
                  onStep={(next) => stepOrchestration("perKeyLimit", next)}
                />
              </>
            ) : (
              <UnloadedRow />
            )}
          </ClayCard>

          <SectionHeader>Retry</SectionHeader>
          <ClayCard>
            {retry !== null ? (
              <>
                <ToggleRow
                  label="Rate limits"
                  caption="retry 429s automatically"
                  value={retry.autoRetryRateLimit}
                  onValueChange={() => toggleRetry("autoRetryRateLimit")}
                />
                <Hairline inset={spacing.lg} />
                <ToggleRow
                  label="Timeouts"
                  caption="retry provider timeouts automatically"
                  value={retry.autoRetryTimeout}
                  onValueChange={() => toggleRetry("autoRetryTimeout")}
                />
                <Hairline inset={spacing.lg} />
                <ToggleRow
                  label="Network"
                  caption="retry dropped connections automatically"
                  value={retry.autoRetryNetwork}
                  onValueChange={() => toggleRetry("autoRetryNetwork")}
                />
                <Hairline inset={spacing.lg} />
                <StepperRow
                  label="Max attempts"
                  caption="total attempts per turn, initial try included (2–10)"
                  value={retry.maxAttempts}
                  min={MAX_ATTEMPTS.min}
                  max={MAX_ATTEMPTS.max}
                  format={(v) => String(v)}
                  onStep={(next) => stepRetry("maxAttempts", next)}
                />
              </>
            ) : (
              <UnloadedRow />
            )}
          </ClayCard>

          <SectionHeader>Memory</SectionHeader>
          <ClayCard>
            {memory !== null ? (
              <ToggleRow
                label="Memory system"
                caption="long-run context — the desktop's recall across sessions"
                value={memory.enabled}
                onValueChange={toggleMemory}
              />
            ) : (
              <UnloadedRow />
            )}
          </ClayCard>

          <SectionHeader>Debug</SectionHeader>
          <ClayCard>
            {debug !== null ? (
              <ToggleRow
                label="Agent self-report"
                caption="the agent reports on its own turn at the end"
                value={debug.enabled}
                onValueChange={toggleDebug}
              />
            ) : (
              <UnloadedRow />
            )}
          </ClayCard>

          <SectionHeader>Thinking loop</SectionHeader>
          <ClayCard>
            {thinkingLoop !== null ? (
              <ToggleRow
                label="Runaway-thinking guard"
                caption="stops reasoning that stalls or never ends"
                value={thinkingLoop.enabled}
                onValueChange={toggleThinkingLoop}
              />
            ) : (
              <UnloadedRow />
            )}
          </ClayCard>

          <SectionHeader>Desktop notifications</SectionHeader>
          <ClayCard>
            {notifications !== null ? (
              <ToggleRow
                label="Task events"
                caption="task finished / failed / needs you — shown on the desktop"
                value={notifications.enabled}
                onValueChange={toggleNotifications}
              />
            ) : (
              <UnloadedRow />
            )}
          </ClayCard>
        </>
      )}
    </ScreenScaffold>
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
          ? "the desktop's preferences live on the desktop — pair one to edit them here."
          : "the preferences reload the moment the link returns — nothing is lost."
      }
      retryLabel={unpaired ? "link a desktop" : "retry now"}
      onRetry={() => (unpaired ? router.push("/connect") : getLinkManager().retryNow())}
    />
  );
}

// ── small shared pieces ─────────────────────────────────────────────────────

function NoteLine({ note }: { note: SaveNote | null }) {
  const { tokens } = useTheme();
  if (note === null) return null;
  const isError = note.kind === "error";
  return (
    <View style={styles.noteRow}>
      <StatusDot color={isError ? tokens.danger : tokens.success} />
      <TypeCaption
        style={{ color: isError ? tokens.danger : tokens.success, flex: 1 }}
        numberOfLines={2}
      >
        {note.text}
      </TypeCaption>
    </View>
  );
}

function UnloadedRow() {
  return (
    <View style={styles.rowInner}>
      <TypeCaption>not loaded — pull to retry</TypeCaption>
    </View>
  );
}

/** The toggle row: label + caption left, the clay switch right. */
function ToggleRow({
  label,
  caption,
  value,
  onValueChange,
}: {
  label: string;
  caption: string;
  value: boolean;
  onValueChange: (next: boolean) => void;
}) {
  return (
    <View style={styles.rowInner}>
      <View style={styles.rowText}>
        <TypeBodyStrong>{label}</TypeBodyStrong>
        <TypeCaption numberOfLines={2}>{caption}</TypeCaption>
      </View>
      <ClaySwitch value={value} onValueChange={onValueChange} label={`${label} toggle`} />
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
  step = 1,
  format,
  onStep,
}: {
  label: string;
  caption: string;
  value: number;
  min: number;
  max: number;
  step?: number;
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
          onPress={() => onStep(Math.max(min, value - step))}
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
          onPress={() => onStep(Math.min(max, value + step))}
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

// ── ClaySwitch — the house switch (accent pill + sliding dot, one spring) ──

const SWITCH_TRACK_W = 52;
const SWITCH_TRACK_H = 32;
const SWITCH_DOT = 24;
const SWITCH_PAD = 3;
const SWITCH_TRAVEL = SWITCH_TRACK_W - SWITCH_DOT - SWITCH_PAD * 2;

function ClaySwitch({
  value,
  onValueChange,
  disabled = false,
  label,
}: {
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  const { tokens } = useTheme();
  const progress = useSharedValue(value ? 1 : 0);

  useEffect(() => {
    progress.value = withSpring(value ? 1 : 0, SPRING);
  }, [value, progress]);

  const trackStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(progress.value, [0, 1], [
      tokens.pillBg as string,
      tokens.accent as string,
    ]),
  }));
  const dotStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: progress.value * SWITCH_TRAVEL }],
  }));

  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={() => onValueChange(!value)}
      hitSlop={6}
      style={styles.switchTarget}
    >
      <Animated.View
        style={[styles.switchTrack, trackStyle, disabled ? styles.switchDisabled : null]}
      >
        <Animated.View
          style={[
            styles.switchDot,
            { backgroundColor: value ? tokens.accentText : tokens.textSecondary },
            dotStyle,
          ]}
        />
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  noteRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  loadErrorRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
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
  switchTarget: { minWidth: 44, minHeight: 44, alignItems: "flex-end", justifyContent: "center" },
  switchTrack: {
    width: SWITCH_TRACK_W,
    height: SWITCH_TRACK_H,
    borderRadius: SWITCH_TRACK_H / 2,
    padding: SWITCH_PAD,
    justifyContent: "center",
  },
  switchDisabled: { opacity: 0.5 },
  switchDot: {
    width: SWITCH_DOT,
    height: SWITCH_DOT,
    borderRadius: SWITCH_DOT / 2,
  },
});
