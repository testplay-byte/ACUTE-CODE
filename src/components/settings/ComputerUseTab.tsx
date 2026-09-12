import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Monitor, ScanEye, ShieldAlert } from "lucide-react";
import { useTimeoutClear } from "../../hooks/use-timeout-clear";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { isTauri } from "../../lib/sidecar";
import { withAlpha } from "../dashboard/helpers";
import { ToggleSwitch } from "../ui/toggle-switch"; // R93-A4: the shared contrast-aware switch
import {
  fetchComputerUseConfig,
  testComputerUse,
  updateComputerUseConfig,
  type ComputerUsePosture,
  type ComputerUseSettings,
  type ComputerUseConfigResponse,
} from "../../lib/api";

/**
 * ComputerUseTab — ROUND-61 (R61-2-a): the owner's master switch for host
 * control.
 *
 * ROUND-66 (R66-2-b, owner directive B3+B5): the VISION-MODEL card was
 * REMOVED — image analysis now lives in its own dedicated section (Settings
 * → Image Analysis: the provider/model/key, the supports-vision rows, the
 * app-wide configuration the computer-use screenshots, browser screenshots
 * and analyze_image all read). This tab keeps only the host-control
 * surface:
 *  (a) Computer use — the master switch (optimistic PUT /computer-use/config
 *      {enabled}), the posture radio (observe / act / auto) while ON, the
 *      platform + capability report, and the Test readiness probe
 *      (POST /computer-use/test).
 *  (b) The pointer card — where the vision model went.
 *  (c) Safety note — the honest defaults (OFF; STOP lives in the monitor).
 *
 * Design mirrors SubAgentsTab (R58-d): theme system, useQuery/useMutation +
 * invalidation, useTimeoutClear toasts, mode-aware coreUnreachableHint.
 */
const coreUnreachableHint = isTauri()
  ? "agent-core is not responding — if the connection banner is showing, use its Restart engine button, then reopen this tab."
  : "Agent core unreachable — start the app (or pnpm dev:full).";

const AMBER = "#f59e0b";

/** A radio row (title + description) in the SubAgentsTab picker style. */
function RadioRow({
  selected,
  disabled,
  title,
  description,
  badge,
  onClick,
  ariaLabel,
}: {
  selected: boolean;
  disabled?: boolean;
  title: string;
  description: string;
  badge?: string;
  onClick: () => void;
  ariaLabel: string;
}) {
  const styles = useThemeStyles();
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      role="radio"
      aria-checked={selected}
      aria-label={ariaLabel}
      className="w-full flex items-center gap-2 px-3 py-2 border-b last:border-b-0 text-left disabled:cursor-not-allowed"
      style={{
        borderColor: styles.borderSubtle,
        background: selected ? withAlpha(styles.accent, 0.07) : "transparent",
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <span className="min-w-0 flex-1 flex flex-col gap-0.5">
        <span className="flex items-center gap-1.5 flex-wrap">
          <span
            className="text-[12px] font-bold"
            style={{ color: disabled ? styles.textTertiary : styles.text }}
          >
            {title}
          </span>
          {badge && (
            <span
              className="text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5"
              style={{ background: withAlpha(styles.accent, 0.14), color: styles.accent }}
            >
              {badge}
            </span>
          )}
        </span>
        <span className="text-[10.5px]" style={{ color: styles.textTertiary }}>
          {description}
        </span>
      </span>
      {selected && <Check size={12} className="shrink-0" style={{ color: styles.accent }} />}
    </button>
  );
}

/* ── Card (a): the master switch + posture + platform + readiness ─────────── */

const POSTURES: { id: ComputerUsePosture; title: string; description: string; badge?: string }[] = [
  {
    id: "observe",
    title: "Observe only",
    description: "The agent can look (apps, windows, accessibility tree, screenshots) but never act.",
  },
  {
    id: "act",
    title: "Act with approval",
    description: "Mutating actions ask first.",
    badge: "recommended",
  },
  {
    id: "auto",
    title: "Autopilot",
    description: "No per-action prompts — every action fires without asking.",
  },
];

function ComputerUseMasterCard() {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const resetAfter = useTimeoutClear();
  const [msg, setMsg] = useState<string | null>(null);
  const [msgIsError, setMsgIsError] = useState(false);
  const [testReport, setTestReport] = useState<{
    ok: boolean;
    issues?: string[];
    [extra: string]: unknown;
  } | null>(null);

  const configQuery = useQuery({
    queryKey: ["computer-use-config"],
    queryFn: fetchComputerUseConfig,
  });

  const note = (text: string, isError = false) => {
    setMsg(text);
    setMsgIsError(isError);
    resetAfter(() => setMsg(null), 1500);
  };

  // The owner's master switch — OPTIMISTIC: the cache flips immediately, a
  // failure rolls back to the server's truth.
  const toggleEnabled = useMutation({
    mutationFn: (enabled: boolean) => updateComputerUseConfig({ enabled }),
    onMutate: async (enabled) => {
      await queryClient.cancelQueries({ queryKey: ["computer-use-config"] });
      const prev = queryClient.getQueryData<ComputerUseConfigResponse>(["computer-use-config"]);
      if (prev !== undefined) {
        queryClient.setQueryData<ComputerUseConfigResponse>(["computer-use-config"], {
          ...prev,
          settings: { ...prev.settings, enabled },
        });
      }
      return { prev };
    },
    onError: (err: Error, _enabled, ctx) => {
      if (ctx?.prev !== undefined) {
        queryClient.setQueryData<ComputerUseConfigResponse>(["computer-use-config"], ctx.prev);
      }
      note(err.message, true);
    },
    onSuccess: (_data, enabled) => {
      if (enabled) note("Computer use enabled.");
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["computer-use-config"] });
    },
  });

  const setPosture = useMutation({
    mutationFn: (permission: ComputerUsePosture) => updateComputerUseConfig({ permission }),
    onSuccess: () => {
      note("Posture saved.");
      void queryClient.invalidateQueries({ queryKey: ["computer-use-config"] });
    },
    onError: (err: Error) => note(err.message, true),
  });

  const testReadiness = useMutation({
    mutationFn: testComputerUse,
    onSuccess: (resp) => setTestReport(resp.report),
    onError: (err: Error) => note(err.message, true),
  });

  if (configQuery.isError) {
    return (
      <section
        className="rounded-[16px] border-[1.5px] p-4"
        style={{ background: styles.card, borderColor: styles.border }}
        aria-label="Computer use"
      >
        <p className="text-[11px]" style={{ color: "#ef4444" }} role="alert">
          {coreUnreachableHint} to configure computer use.
        </p>
      </section>
    );
  }
  const config = configQuery.data;
  if (configQuery.isLoading || config === undefined) {
    return (
      <section
        className="rounded-[16px] border-[1.5px] p-4"
        style={{ background: styles.card, borderColor: styles.border }}
        aria-label="Computer use"
      >
        <span className="text-[12px] font-mono" style={{ color: styles.textTertiary }}>
          loading computer use settings…
        </span>
      </section>
    );
  }

  const settings: ComputerUseSettings = config.settings;
  const issues = Array.isArray(testReport?.issues) ? (testReport?.issues as string[]) : [];

  return (
    <section
      className="rounded-[16px] border-[1.5px] p-4 flex flex-col gap-2.5"
      style={{ background: styles.card, borderColor: styles.border }}
      aria-label="Computer use"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <Monitor size={13} style={{ color: styles.accent, opacity: 0.8 }} />
        <span className="text-[13px] font-bold" style={{ color: styles.text }}>
          Computer use
        </span>
        <span className="flex-1" />
        {msg && (
          <span
            className="text-[11px] font-bold"
            style={{ color: msgIsError ? "#ef4444" : "#22c55e" }}
          >
            {msg}
          </span>
        )}
        <span className="flex items-center gap-2">
          <span className="text-[11px] font-bold" style={{ color: styles.textSecondary }}>
            {settings.enabled ? "Enabled" : "Disabled"}
          </span>
          <ToggleSwitch
            big
            checked={settings.enabled}
            onToggle={() => toggleEnabled.mutate(!settings.enabled)}
            label="Toggle computer use"
            title={
              settings.enabled
                ? "Turn computer use off — the consent gate closes for every agent"
                : "Turn computer use on — the agent may observe (and act, per the posture) this host"
            }
            disabled={toggleEnabled.isPending}
          />
        </span>
      </div>
      <p className="text-[11px] leading-relaxed" style={{ color: styles.textSecondary }}>
        The master switch for host control. When on, the agent gains the computer-use tools and the
        posture below decides how far it may go.
      </p>

      {/* Posture radio — only meaningful while the master switch is ON. */}
      {settings.enabled ? (
        <div
          role="radiogroup"
          aria-label="Computer use posture"
          className="rounded-[10px] border-[1.5px] overflow-hidden"
          style={{ borderColor: styles.border }}
        >
          {POSTURES.map((p) => (
            <RadioRow
              key={p.id}
              selected={settings.permission === p.id}
              title={p.title}
              description={p.description}
              badge={p.badge}
              onClick={() => setPosture.mutate(p.id)}
              ariaLabel={`Posture: ${p.title}`}
            />
          ))}
        </div>
      ) : (
        <p className="text-[10.5px]" style={{ color: styles.textTertiary }}>
          Posture is set while computer use is on — flip the switch to choose observe / act /
          autopilot.
        </p>
      )}

      {/* Platform + capabilities (the backend's own report). */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="font-mono text-[10.5px] shrink-0" style={{ color: styles.textTertiary }}>
          backend: {config.platform}
        </span>
        {Object.entries(config.capabilities ?? {}).map(([key, ok]) => (
          <span
            key={key}
            className="text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5"
            title={ok ? "available on this backend" : "not available on this backend"}
            style={{
              background: ok ? withAlpha("#22c55e", 0.12) : styles.subtle,
              color: ok ? "#22c55e" : styles.textTertiary,
            }}
          >
            {key}
          </span>
        ))}
      </div>

      {/* Readiness probe */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={() => testReadiness.mutate()}
          disabled={testReadiness.isPending}
          aria-label="Test computer use readiness"
          className="h-8 px-3 rounded-[8px] text-[11px] font-bold shrink-0 disabled:opacity-50"
          style={{ background: withAlpha(styles.accent, 0.12), color: styles.accent }}
        >
          {testReadiness.isPending ? "Testing…" : "Test readiness"}
        </button>
        <span className="text-[10.5px] flex-1 min-w-[180px]" style={{ color: styles.textTertiary }}>
          Runs the engine's readiness probe (permissions + capabilities; never pops dialogs).
        </span>
      </div>
      {testReport && (
        <div
          className="rounded-[10px] border-[1.5px] px-3 py-2.5 flex flex-col gap-1.5"
          style={{
            borderColor: testReport.ok ? withAlpha("#22c55e", 0.4) : withAlpha(AMBER, 0.4),
            background: testReport.ok ? withAlpha("#22c55e", 0.04) : withAlpha(AMBER, 0.04),
          }}
          data-testid="readiness-result"
        >
          <div className="flex items-center gap-2">
            <span
              className="text-[11px] font-black uppercase tracking-wider rounded-full px-2 py-0.5"
              style={{
                background: testReport.ok ? withAlpha("#22c55e", 0.14) : withAlpha(AMBER, 0.14),
                color: testReport.ok ? "#22c55e" : AMBER,
              }}
            >
              {testReport.ok ? "Ready" : "Issues"}
            </span>
            <span className="text-[11px]" style={{ color: styles.textSecondary }}>
              {testReport.ok
                ? "The engine reports computer use is ready on this host."
                : issues.length > 0
                  ? "The readiness probe reported problems:"
                  : "The readiness probe reported problems — see the engine log for details."}
            </span>
          </div>
          {issues.length > 0 && (
            <ul className="flex flex-col gap-1 m-0 pl-4">
              {issues.map((line, i) => (
                <li
                  key={i}
                  className="text-[10.5px] leading-relaxed list-disc"
                  style={{ color: styles.textSecondary }}
                >
                  {line}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

/* ── Card (b): the pointer to the dedicated Image analysis section ────────── */

/**
 * R66-2-b: the vision model (the provider + model + key + supports-vision
 * rows) moved to its own section — a compact, honest pointer so nobody
 * hunts for it here.
 */
function ImageAnalysisPointerCard() {
  const styles = useThemeStyles();
  return (
    <section
      className="rounded-[16px] border-[1.5px] p-4 flex items-start gap-2.5"
      style={{ background: withAlpha(styles.text, 0.02), borderColor: styles.borderSubtle }}
      aria-label="Image analysis moved"
      data-testid="image-analysis-pointer"
    >
      <ScanEye size={13} className="shrink-0 mt-0.5" style={{ color: styles.textTertiary }} />
      <p className="text-[10.5px] leading-relaxed" style={{ color: styles.textTertiary }}>
        Image analysis (the vision model) now lives in its own section — open Settings → Image
        Analysis to pick the provider and model, paste its API key, and mark which models support
        vision. It applies app-wide: computer-use screenshots, browser screenshots, and the general
        analyze_image tool.
      </p>
    </section>
  );
}

/* ── Card (c): the safety note ─────────────────────────────────────────────── */

function SafetyCard() {
  const styles = useThemeStyles();
  return (
    <section
      className="rounded-[16px] border-[1.5px] p-4 flex items-start gap-2.5"
      style={{ background: withAlpha(styles.text, 0.02), borderColor: styles.borderSubtle }}
      aria-label="Computer use safety"
    >
      <ShieldAlert size={13} className="shrink-0 mt-0.5" style={{ color: styles.textTertiary }} />
      <p className="text-[10.5px] leading-relaxed" style={{ color: styles.textTertiary }}>
        Computer use is OFF by default. When on, the agent observes via the accessibility tree
        first and falls back to screenshots; destructive actions need your approval in Act mode. A
        STOP kill switch lives in the Computer monitor panel (right sidebar).
      </p>
    </section>
  );
}

/* ── Composition ──────────────────────────────────────────────────────────── */

/** The dedicated Computer use settings tab (?tab=computeruse). */
export function ComputerUseTab() {
  const styles = useThemeStyles();
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <div className="pb-1">
        <h2 className="text-[16px] font-black" style={{ color: styles.text }}>
          Computer use
        </h2>
        <p className="mt-1 text-[12px]" style={{ color: styles.textSecondary }}>
          The master switch for host control and the safety posture — everything computer-use lives
          on this one page.
        </p>
      </div>
      <ComputerUseMasterCard />
      <ImageAnalysisPointerCard />
      <SafetyCard />
    </div>
  );
}

export default ComputerUseTab;
