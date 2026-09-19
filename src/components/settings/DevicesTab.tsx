import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  ChevronDown,
  Globe,
  QrCode,
  Smartphone,
  Trash2,
} from "lucide-react";
import { useTimeoutClear } from "../../hooks/use-timeout-clear";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { isTauri } from "../../lib/sidecar";
import { withAlpha } from "../dashboard/helpers";
// R100-E2: the round-100 primitives (USAGE.md §3) + the semantic status home.
import { Kicker } from "../ui/Kicker";
import { SectionCard } from "../ui/SectionCard";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { ToggleSwitch } from "../ui/toggle-switch"; // R93-A4: the shared contrast-aware switch
import { Dialog, DialogContent, DialogHeader } from "../ui/dialog";
import { ConfirmDialog } from "./ConfirmDialog";
// R106-S2: the QR rendering wrapper (the sanctioned values home — the QR's
// fixed dark-on-light module pair lives in src/lib, like SEMANTIC_COLORS).
import { QR_MODULE_LIGHT, QR_TILE_INK, renderQrSvg } from "../../lib/qr";
import {
  fetchCloudConnectorSettings,
  fetchDeviceLinkSettings,
  fetchMobileDevices,
  fetchMobileLinkInfo,
  revokeMobileDevice,
  startMobilePairing,
  updateCloudConnectorSettings,
  updateDeviceLinkSettings,
  type CloudConnectorSettingsView,
  type DeviceLinkSettings,
  type MobileDeviceInfo,
  type MobilePairingPayload,
} from "../../lib/api";

/**
 * DevicesTab — ROUND-106 (R106-S2, per ANDROID-R3-OWNER-RULINGS.md §3.2):
 * the DESKTOP half of device linking — the Settings surface where the owner
 * (a) flips the master "Allow device links" switch, (b) pairs a phone
 * (QR + PIN + the live 120-second countdown + the type-it-in manual
 * fallback), and (c) manages/revokes the linked devices.
 *
 * ROUND-112 (R112-a) adds the remote-access half: §a2's "Remote access
 * (internet)" card (the cloud connector's toggle + relay URL + host key +
 * live status), INDEPENDENT of the local link by the owner's explicit
 * ruling (both ON at once; the phone tries LAN first, relay fallback), and
 * the pairing dialog's "Reachable over the internet via <relay>" hint while
 * the tunnel is connected.
 *
 * The wire surface is the R106-S1 sidecar contract (LINKING-PROTOCOL.md §2
 * + §5): GET/PUT /settings/device-link, GET/PUT /settings/cloud-connector,
 * GET /mobile/link-info, POST /mobile/pair/start, GET /mobile/devices,
 * DELETE /mobile/devices/:id. pair/claim is deliberately NOT touched here —
 * claiming is the PHONE's hop, not the desktop window's.
 *
 * Design mirrors the tab family (McpTab/ComputerUseTab/AboutTab): one
 * max-w-2xl column of SectionCards, useQuery/useMutation + invalidation,
 * useTimeoutClear toasts, the theme token system, the shared switch and
 * dialog primitives. The api module is the ONLY backend surface touched.
 */
const coreUnreachableHint = isTauri()
  ? "agent-core is not responding — if the connection banner is showing, use its Restart engine button, then reopen this tab."
  : "Agent core unreachable — start the app (or pnpm dev:full).";

/** The pairing window's live countdown tick (BrowserCheckpointCard's cadence
 * family — fast enough to feel alive, calm enough for a settings dialog). */
const COUNTDOWN_TICK_MS = 250;

/** The claim poll while the pairing dialog is open (the task's calm 2s). */
const PAIRING_POLL_MS = 2_000;

/** How long the "Device linked ✓" state lingers before the dialog closes
 * itself (the QR is single-use — a lingering dead window teaches nothing). */
const LINKED_AUTOCLOSE_MS = 2_500;

/* ── Local formatters ─────────────────────────────────────────────────────── */

/** "just now" / "3m ago" / "2h ago" / "Aug 4" — the repo's established
 * timeAgo spelling (Toaster.tsx/NotificationBell.tsx carry private copies
 * for ISO strings; this one takes the devices list's EPOCH-MS timestamps). */
function timeAgo(epochMs: number): string {
  const diff = Date.now() - epochMs;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(epochMs).toLocaleDateString([], { month: "short", day: "numeric" });
}

/** "Added Aug 21, 2026" — the row's creation date. */
function fmtCreated(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/* ── §a The master switch card ────────────────────────────────────────────── */

function DeviceLinkCard() {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const resetAfter = useTimeoutClear();
  const [msg, setMsg] = useState<string | null>(null);
  const [msgIsError, setMsgIsError] = useState(false);

  const settingsQuery = useQuery({
    queryKey: ["device-link-settings"],
    queryFn: fetchDeviceLinkSettings,
  });
  // The live listener state (port + LAN addresses) for the ON status line.
  const linkInfoQuery = useQuery({
    queryKey: ["mobile-link-info"],
    queryFn: fetchMobileLinkInfo,
  });

  const note = (text: string, isError = false) => {
    setMsg(text);
    setMsgIsError(isError);
    resetAfter(() => setMsg(null), 1_500);
  };

  // The master switch — OPTIMISTIC (the ComputerUseTab pattern): the cache
  // flips immediately; a failed PUT (e.g. the listener refused to bind → 400)
  // rolls back to the server's truth and the setting stays honestly OFF.
  const toggleLink = useMutation({
    mutationFn: (enabled: boolean) => updateDeviceLinkSettings({ enabled }),
    onMutate: async (enabled) => {
      await queryClient.cancelQueries({ queryKey: ["device-link-settings"] });
      const prev = queryClient.getQueryData<DeviceLinkSettings>(["device-link-settings"]);
      if (prev !== undefined) {
        queryClient.setQueryData<DeviceLinkSettings>(["device-link-settings"], {
          ...prev,
          enabled,
        });
      }
      return { prev };
    },
    onError: (err: Error, _enabled, ctx) => {
      if (ctx?.prev !== undefined) {
        queryClient.setQueryData<DeviceLinkSettings>(["device-link-settings"], ctx.prev);
      }
      note(err.message, true);
    },
    onSuccess: (_data, enabled) => {
      note(
        enabled
          ? "Device links on — the encrypted listener is live."
          : "Device links off — loopback only.",
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["device-link-settings"] });
      void queryClient.invalidateQueries({ queryKey: ["mobile-link-info"] });
    },
  });

  if (settingsQuery.isError) {
    return (
      <SectionCard className="p-4" ariaLabel="Device links">
        <p className="text-[11px]" style={{ color: SEMANTIC_COLORS.danger }} role="alert">
          {coreUnreachableHint} to manage device links.
        </p>
      </SectionCard>
    );
  }
  const settings = settingsQuery.data;
  if (settingsQuery.isLoading || settings === undefined) {
    return (
      <SectionCard className="p-4" ariaLabel="Device links">
        <span className="text-[12px] font-mono" style={{ color: styles.textTertiary }}>
          loading device link settings…
        </span>
      </SectionCard>
    );
  }

  const linkInfo = linkInfoQuery.data;

  return (
    /* R100-E2: the SectionCard primitive (aria-label passthrough). */
    <SectionCard className="p-4 flex flex-col gap-2.5" ariaLabel="Device links">
      <div className="flex items-center gap-2 flex-wrap">
        <Smartphone size={13} style={{ color: styles.accent, opacity: 0.8 }} />
        <span className="text-[13px] font-semibold" style={{ color: styles.text }}>
          Device links
        </span>
        <span className="flex-1" />
        {msg && (
          <span
            className="text-[11px] font-medium"
            style={{ color: msgIsError ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.success }}
          >
            {msg}
          </span>
        )}
        <span className="flex items-center gap-2">
          <span className="text-[11px] font-medium" style={{ color: styles.textSecondary }}>
            {settings.enabled ? "Enabled" : "Disabled"}
          </span>
          <ToggleSwitch
            big
            checked={settings.enabled}
            onToggle={() => toggleLink.mutate(!settings.enabled)}
            label="Toggle device links"
            title={
              settings.enabled
                ? "Turn device links off — the server returns to loopback-only, as before"
                : "Allow your phone to link to this machine over your LAN"
            }
            disabled={toggleLink.isPending}
            testId="device-link-toggle"
          />
        </span>
      </div>
      <p className="text-[11px] leading-relaxed" style={{ color: styles.textSecondary }}>
        Allow your phone to link to this machine over your LAN. The server binds an encrypted
        listener on your network; off = loopback only, as before.
      </p>
      {/* The live listener state, read from link-info while ON (the one-shot
          status endpoint — port + the LAN addresses the phone can reach). */}
      {settings.enabled && linkInfo !== undefined && linkInfo.port !== null && (
        <div
          className="font-mono text-[11px] tabular-nums"
          style={{ color: styles.textSecondary }}
          data-testid="link-status"
        >
          Listening on port {linkInfo.port}
          {linkInfo.addrs.length > 0 ? ` · ${linkInfo.addrs.join(", ")}` : ""}
        </div>
      )}
      {settings.enabled && linkInfo !== undefined && linkInfo.port === null && (
        <div className="text-[11px]" style={{ color: styles.textTertiary }} data-testid="link-status-unavailable">
          The encrypted listener has not reported a port — try toggling device links off and on.
        </div>
      )}
    </SectionCard>
  );
}

/** "Aug 4, 14:05" style — the remote-access "connected since" line. */
function fmtClock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** The relay's HOST for display ("https://acute-relay.x.workers.dev/…" →
 * "acute-relay.x.workers.dev"); the raw string is the honest fallback. */
function hostOf(relayUrl: string): string {
  try {
    return new URL(relayUrl).host;
  } catch {
    return relayUrl;
  }
}

/* ── §a2 The remote-access card (ROUND-112 R112-a — the cloud half) ───────── */

/**
 * RemoteAccessCard — "Remote access (internet)": the cloud connector's
 * desktop surface. INDEPENDENT of §a's local Device-link card by the owner's
 * explicit ruling — both can be ON at once (the phone tries LAN first and
 * falls back to the relay). The card is a small FORM: the toggle + the two
 * inputs edit a draft; Save PUTs {enabled, relayUrl, hostKey?} (the key only
 * rides the PUT when typed — the saved one is never echoed back by the
 * backend, hostKeyPresent is the truth). The status line reads the polled
 * GET's live connector status (Connecting… / Connected to <host> since
 * <time> / Error: <lastError>).
 */
function RemoteAccessCard({ settings }: { settings: CloudConnectorSettingsView | undefined }) {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const resetAfter = useTimeoutClear();
  const [msg, setMsg] = useState<string | null>(null);
  const [msgIsError, setMsgIsError] = useState(false);
  // The form draft: null = "follow the server" (not dirty yet).
  const [enabledDraft, setEnabledDraft] = useState<boolean | null>(null);
  const [relayUrlDraft, setRelayUrlDraft] = useState<string | null>(null);
  // The host key is write-only: typed text replaces, empty = keep the saved
  // key. `forgetKey` marks "clear the saved key on Save" (only offered while
  // the draft is disabled — the backend refuses clearing while enabled).
  const [hostKeyDraft, setHostKeyDraft] = useState("");
  const [forgetKey, setForgetKey] = useState(false);

  const note = (text: string, isError = false) => {
    setMsg(text);
    setMsgIsError(isError);
    resetAfter(() => setMsg(null), 2_500);
  };

  const save = useMutation({
    mutationFn: () =>
      updateCloudConnectorSettings({
        enabled: enabledDraft ?? settings?.enabled ?? false,
        relayUrl: (relayUrlDraft ?? settings?.relayUrl ?? "").trim(),
        // Typed text replaces; the forget flag clears; else the saved key
        // stays (hostKey omitted = keep).
        ...(hostKeyDraft.trim() !== ""
          ? { hostKey: hostKeyDraft.trim() }
          : forgetKey
            ? { hostKey: "" }
            : {}),
      }),
    onSuccess: () => {
      note("Remote access settings saved.");
      // Resync the draft to the server's truth (the poll refreshes the rest).
      setEnabledDraft(null);
      setRelayUrlDraft(null);
      setHostKeyDraft("");
      setForgetKey(false);
    },
    onError: (err: Error) => {
      note(err.message, true);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["cloud-connector-settings"] });
    },
  });

  if (settings === undefined) {
    return (
      <SectionCard className="p-4" ariaLabel="Remote access">
        <span className="text-[12px] font-mono" style={{ color: styles.textTertiary }}>
          loading remote access settings…
        </span>
      </SectionCard>
    );
  }

  const inputStyle = {
    background: styles.bg,
    borderColor: styles.border,
    color: styles.text,
  };
  const enabled = enabledDraft ?? settings.enabled;
  const relayUrlValue = relayUrlDraft ?? settings.relayUrl;
  const status = settings.status;

  // The live status line — the polled connector truth (never the draft).
  let statusLine: { text: string; tone: "success" | "neutral" | "danger" | "muted" } | null = null;
  if (status.state === "connected") {
    statusLine = {
      text: `Connected to ${hostOf(status.relayUrl)}${
        status.lastConnectedAt !== null ? ` since ${fmtClock(status.lastConnectedAt)}` : ""
      }`,
      tone: "success",
    };
  } else if (status.state === "connecting") {
    statusLine = { text: "Connecting…", tone: "neutral" };
  } else if (status.state === "error") {
    statusLine = { text: `Error: ${status.lastError ?? "unknown error"}`, tone: "danger" };
  } else if (settings.enabled) {
    // Enabled but the tunnel is not running (e.g. the boot config was
    // incomplete) — the honest fallback, not a silent blank.
    statusLine = {
      text: "Enabled but the tunnel is not running — save the settings again or restart the engine.",
      tone: "muted",
    };
  }
  const toneColor = (tone: "success" | "neutral" | "danger" | "muted"): string | undefined => {
    if (tone === "success") return SEMANTIC_COLORS.success;
    if (tone === "danger") return SEMANTIC_COLORS.danger;
    if (tone === "muted") return styles.textTertiary;
    return styles.textSecondary;
  };

  return (
    <SectionCard className="p-4 flex flex-col gap-2.5" ariaLabel="Remote access">
      <div className="flex items-center gap-2 flex-wrap">
        <Globe size={13} style={{ color: styles.accent, opacity: 0.8 }} />
        <span className="text-[13px] font-semibold" style={{ color: styles.text }}>
          Remote access (internet)
        </span>
        <span className="flex-1" />
        {msg && (
          <span
            className="text-[11px] font-medium"
            style={{ color: msgIsError ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.success }}
          >
            {msg}
          </span>
        )}
        <span className="flex items-center gap-2">
          <span className="text-[11px] font-medium" style={{ color: styles.textSecondary }}>
            {enabled ? "Enabled" : "Disabled"}
          </span>
          <ToggleSwitch
            big
            checked={enabled}
            onToggle={() => setEnabledDraft(!enabled)}
            label="Toggle remote access"
            title={
              enabled
                ? "Turn remote access off — the tunnel to the relay closes (LAN links are unaffected)"
                : "Reachable from anywhere through the Cloudflare relay — independent of the LAN link"
            }
            disabled={save.isPending}
            testId="remote-access-toggle"
          />
        </span>
      </div>
      <p className="text-[11px] leading-relaxed" style={{ color: styles.textSecondary }}>
        Keep your phone working from any network (mobile data, a friend's Wi-Fi) through the
        Cloudflare relay — no open ports, no router changes. Independent of the LAN device link
        above: both can be on at once, and the phone always tries the LAN first.
      </p>
      {/* The live status line (the ~5 s poll keeps it fresh while the tab is
          open — the connector's own truth, never the draft). */}
      {statusLine !== null && (
        <div
          className="text-[11px] leading-relaxed"
          style={{ color: toneColor(statusLine.tone) }}
          data-testid="remote-status"
        >
          {statusLine.text}
        </div>
      )}
      <div className="flex flex-col gap-2">
        <div>
          <div className="text-[10px] font-medium uppercase tracking-wider mb-1" style={{ color: styles.textTertiary }}>
            Relay URL
          </div>
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={relayUrlValue}
            onChange={(e) => setRelayUrlDraft(e.target.value)}
            placeholder="https://acute-relay.anikuta.workers.dev"
            aria-label="Relay URL"
            data-testid="remote-relay-input"
            className="h-8 w-full rounded-lg border-[1.5px] px-2.5 font-mono text-[11px] outline-none"
            style={inputStyle}
          />
        </div>
        <div>
          <div className="text-[10px] font-medium uppercase tracking-wider mb-1" style={{ color: styles.textTertiary }}>
            Host key
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="password"
              autoComplete="off"
              value={hostKeyDraft}
              onChange={(e) => {
                setHostKeyDraft(e.target.value);
                if (e.target.value !== "") setForgetKey(false);
              }}
              placeholder={settings.hostKeyPresent ? "•••••••• saved — type to replace" : "paste the relay's host key"}
              aria-label="Host key"
              data-testid="remote-hostkey-input"
              className="h-8 flex-1 min-w-[180px] rounded-lg border-[1.5px] px-2.5 font-mono text-[11px] outline-none"
              style={inputStyle}
            />
            {settings.hostKeyPresent && hostKeyDraft === "" && forgetKey === false && !enabled && (
              <button
                type="button"
                onClick={() => setForgetKey(true)}
                title="Clear the saved host key when you Save (offered only while remote access is disabled)"
                className="h-8 px-2.5 rounded-lg text-[11px] font-medium shrink-0"
                style={{ background: withAlpha(SEMANTIC_COLORS.danger, 0.1), color: SEMANTIC_COLORS.danger }}
                data-testid="remote-forget-key"
              >
                Forget
              </button>
            )}
            {settings.hostKeyPresent && forgetKey && (
              <span
                className="text-[10px] font-medium uppercase tracking-wider rounded-full px-1.5 py-0.5 shrink-0"
                style={{ background: withAlpha(SEMANTIC_COLORS.danger, 0.12), color: SEMANTIC_COLORS.danger }}
                data-testid="remote-forget-key-pending"
              >
                will be cleared on Save
              </span>
            )}
            {settings.hostKeyPresent && hostKeyDraft === "" && forgetKey === false && enabled && (
              <span
                className="text-[10px] font-medium uppercase tracking-wider rounded-full px-1.5 py-0.5 shrink-0"
                style={{ background: withAlpha(SEMANTIC_COLORS.success, 0.12), color: SEMANTIC_COLORS.success }}
                data-testid="remote-key-saved"
              >
                Key saved
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => save.mutate()}
            disabled={save.isPending}
            title="Apply the relay URL, host key, and the enabled switch"
            className="h-9 px-4 rounded-full text-[11px] font-semibold transition-all active:scale-95 disabled:opacity-50 inline-flex items-center gap-1.5 self-start"
            style={{ background: styles.accent, color: styles.accentText }}
            data-testid="remote-save"
          >
            <Globe size={13} /> {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </SectionCard>
  );
}

/* ── §b The pairing card + dialog ─────────────────────────────────────────── */

/** The QR tile — the EXACT pair/start payload JSON as one compact object,
 * rendered through the SVG encoder on a fixed light ground (scannability
 * beats theming: dark modules on a light background regardless of the app's
 * dark mode — LINKING-PROTOCOL §2). `data-payload` carries the exact string
 * handed to the encoder (the phone parses this payload; nothing is
 * reformatted or dropped). */
function QrTile({ payload, dimmed }: { payload: string; dimmed: boolean }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    setSvg(null);
    renderQrSvg(payload)
      .then((rendered) => {
        if (!cancelled) setSvg(rendered);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [payload]);
  return (
    <div
      data-testid="pair-qr"
      data-payload={payload}
      className="w-56 h-56 rounded-md overflow-hidden grid place-items-center shrink-0 transition-opacity"
      style={{ background: QR_MODULE_LIGHT, opacity: dimmed ? 0.35 : 1 }}
    >
      {failed ? (
        <span className="text-[11px] px-4 text-center" style={{ color: SEMANTIC_COLORS.danger }}>
          the QR could not be rendered
        </span>
      ) : svg === null ? (
        <span className="text-[11px] font-mono" style={{ color: QR_TILE_INK }}>
          rendering…
        </span>
      ) : (
        // The encoder's own SVG markup (module paths only — generated by the
        // qrcode library from the payload string, never user HTML).
        <div className="w-full h-full [&>svg]:w-full [&>svg]:h-full" dangerouslySetInnerHTML={{ __html: svg }} aria-hidden="true" />
      )}
    </div>
  );
}

/** The pairing dialog's internal state machine. */
type PairingState =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "pairing"; payload: MobilePairingPayload }
  | { kind: "linked" }
  | { kind: "error"; message: string };

function PairingDialog({
  open,
  onClose,
  relayHost,
}: {
  open: boolean;
  onClose: () => void;
  /** ROUND-112: the relay's host while remote access is connected — the
   * QR dialog's "Reachable over the internet" hint (null = LAN only). */
  relayHost: string | null;
}) {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const [state, setState] = useState<PairingState>({ kind: "idle" });
  const [manualOpen, setManualOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  // The poll callback reads the CURRENT state without re-subscribing the
  // interval on every render.
  const stateRef = useRef(state);
  stateRef.current = state;

  const start = async () => {
    setState({ kind: "starting" });
    setManualOpen(false);
    try {
      const payload = await startMobilePairing();
      setState({ kind: "pairing", payload });
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // Opening the dialog mints a fresh window ("Generate new PIN" reuses this
  // exact leg — pair/start invalidates any prior session server-side).
  useEffect(() => {
    if (open) void start();
  }, [open]);

  const payload = state.kind === "pairing" ? state.payload : null;

  // The live countdown (BrowserCheckpointCard's now-tick pattern).
  useEffect(() => {
    if (!open || payload === null) return;
    setNowMs(Date.now());
    const t = setInterval(() => setNowMs(Date.now()), COUNTDOWN_TICK_MS);
    return () => clearInterval(t);
  }, [open, payload]);

  // THE CLAIM POLL — while the window is open, link-info is refreshed at a
  // calm 2s cadence. activePairing disappearing while our own countdown is
  // still running means the phone CLAIMED (a consumed session): show the
  // linked state briefly, then refresh the devices list behind the dialog.
  useEffect(() => {
    if (!open || payload === null) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const info = await fetchMobileLinkInfo();
        if (cancelled) return;
        const st = stateRef.current;
        if (st.kind !== "pairing") return;
        if (info.activePairing === null && Date.now() < st.payload.expiresAt) {
          setState({ kind: "linked" });
          void queryClient.invalidateQueries({ queryKey: ["mobile-devices"] });
        }
      } catch {
        // an unreachable sidecar keeps its calm cadence — the countdown is
        // the window's truth, not the poll.
      }
    };
    const t = setInterval(() => void poll(), PAIRING_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [open, payload, queryClient]);

  // The "briefly" in "Device linked ✓ — briefly": the single-use window is
  // dead the moment it is claimed, so the dialog closes itself shortly
  // after the handshake lands (Close still works — this is a courtesy).
  useEffect(() => {
    if (state.kind !== "linked") return;
    const t = setTimeout(onClose, LINKED_AUTOCLOSE_MS);
    return () => clearTimeout(t);
  }, [state.kind, onClose]);

  const secondsLeft =
    payload !== null ? Math.max(0, Math.ceil((payload.expiresAt - nowMs) / 1000)) : 0;
  const expired = payload !== null && secondsLeft <= 0;
  // THE QR PAYLOAD — the pair/start response re-serialized as ONE COMPACT
  // JSON object, fields untouched, same order the phone expects (v, addrs,
  // port, certFP, machineId, pin, ttl, expiresAt).
  const qrPayloadStr = payload !== null ? JSON.stringify(payload) : "";

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="w-[min(460px,92vw)]" aria-describedby={undefined}>
        <DialogHeader
          title="Link a device"
          description="Scan the code with ACUTE-CODE on your phone — or type the details in by hand. The pairing window is single-use and lasts two minutes."
        />
        {state.kind === "starting" ? (
          <div className="px-5 py-8 text-center" data-testid="pair-starting">
            <span className="text-[12px] font-mono" style={{ color: styles.textTertiary }}>
              preparing the pairing window…
            </span>
          </div>
        ) : state.kind === "error" ? (
          <div className="px-5 py-5 flex flex-col gap-3" data-testid="pair-error">
            <p className="text-[11px] leading-relaxed" style={{ color: SEMANTIC_COLORS.danger }} role="alert">
              Could not open the pairing window ({state.message}).
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void start()}
                className="h-9 px-4 rounded-full text-[11px] font-semibold border-[1.5px] transition-all active:scale-95"
                style={{ borderColor: withAlpha(styles.accent, 0.5), color: styles.accent }}
                data-testid="pair-retry"
              >
                Try again
              </button>
              <button
                type="button"
                onClick={onClose}
                className="h-9 px-4 rounded-full text-[11px] font-semibold border-[1.5px] transition-colors hover:opacity-80"
                style={{ borderColor: styles.border, color: styles.textSecondary }}
              >
                Close
              </button>
            </div>
          </div>
        ) : state.kind === "linked" ? (
          <div
            className="px-5 py-8 flex flex-col items-center gap-2 text-center"
            data-testid="pair-linked"
          >
            <CheckCircle2 size={20} style={{ color: SEMANTIC_COLORS.success }} />
            <span className="text-[13px] font-semibold" style={{ color: styles.text }}>
              Device linked ✓
            </span>
            <span className="text-[11px] leading-relaxed max-w-[320px]" style={{ color: styles.textSecondary }}>
              Your phone holds its own long-lived key now — it stays linked until you revoke it
              below.
            </span>
          </div>
        ) : payload !== null ? (
          <div className="flex flex-col gap-4 px-5 py-4" data-testid="pair-body">
            <div className="flex flex-col items-center gap-2.5">
              <QrTile payload={qrPayloadStr} dimmed={expired} />
              {expired ? (
                <p
                  className="text-[11px] font-medium"
                  style={{ color: SEMANTIC_COLORS.danger }}
                  data-testid="pair-expired"
                >
                  Pairing window closed — generate a new PIN
                </p>
              ) : (
                <>
                  {/* The 8-digit PIN in the ladder's VALUE tier (22px/600,
                      tabular) — the number the phone asks to confirm. */}
                  <div
                    className="font-mono text-[22px] font-semibold leading-none tabular-nums"
                    style={{ color: styles.text }}
                    data-testid="pair-pin"
                  >
                    {payload.pin}
                  </div>
                  <span
                    className="text-[11px] tabular-nums"
                    style={{ color: styles.textTertiary }}
                    data-testid="pair-countdown"
                  >
                    expires in {secondsLeft}s
                  </span>
                </>
              )}
              {/* ROUND-112 (R112-a): the cloud hint — present only while the
                  remote-access tunnel is connected (the QR payload carries
                  the full relay address; this is the human-readable note). */}
              {relayHost !== null && !expired && (
                <p
                  className="text-[11px] leading-relaxed max-w-[320px] text-center"
                  style={{ color: SEMANTIC_COLORS.success }}
                  data-testid="pair-relay-hint"
                >
                  Reachable over the internet via {relayHost}
                </p>
              )}
            </div>
            {/* The manual fallback (the AboutTab "What's new" disclosure
                grammar): the address list + port + PIN as selectable text
                for typing into the phone by hand, plus the full certFP in
                small mono — what the phone should show when it pins. */}
            <div
              className="rounded-xl border-[1.5px] overflow-hidden"
              style={{ borderColor: styles.border, background: styles.subtle }}
            >
              <button
                type="button"
                onClick={() => setManualOpen((v) => !v)}
                aria-expanded={manualOpen}
                data-testid="pair-manual-toggle"
                className="w-full h-9 px-3 flex items-center justify-between gap-2 text-[11px] font-semibold transition-colors hover:opacity-80"
                style={{ color: styles.textSecondary }}
              >
                Type it in by hand instead
                <ChevronDown
                  size={13}
                  className={`transition-transform duration-200 ${manualOpen ? "rotate-180" : ""}`}
                />
              </button>
              {manualOpen && (
                <div
                  className="px-3 pb-3 flex flex-col gap-2 border-t"
                  style={{ borderColor: styles.borderSubtle }}
                  data-testid="pair-manual"
                >
                  <div>
                    <div className="text-[10px] font-medium uppercase tracking-wider mb-1" style={{ color: styles.textTertiary }}>
                      Address (any one of these)
                    </div>
                    <div
                      className="font-mono text-[12px] select-text leading-relaxed break-all"
                      style={{ color: styles.text }}
                      data-testid="pair-manual-addrs"
                    >
                      {payload.addrs.map((addr) => (
                        <div key={addr}>
                          {addr}:{payload.port}
                        </div>
                      ))}
                      {payload.addrs.length === 0 && <div>(no LAN address reported)</div>}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] font-medium uppercase tracking-wider mb-1" style={{ color: styles.textTertiary }}>
                      Pairing PIN
                    </div>
                    <div
                      className="font-mono text-[12px] select-text tabular-nums"
                      style={{ color: styles.text }}
                      data-testid="pair-manual-pin"
                    >
                      {payload.pin}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] font-medium uppercase tracking-wider mb-1" style={{ color: styles.textTertiary }}>
                      Certificate fingerprint (the phone shows this when it pins)
                    </div>
                    <div
                      className="font-mono text-[10px] select-text leading-relaxed break-all"
                      style={{ color: styles.textSecondary }}
                      data-testid="pair-manual-certfp"
                    >
                      {payload.certFP}
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => void start()}
                disabled={state.kind !== "pairing"}
                title="Mints a fresh 120-second window — the old PIN dies immediately"
                className="h-9 px-4 rounded-full text-[11px] font-semibold border-[1.5px] transition-all active:scale-95 disabled:opacity-50 inline-flex items-center gap-1.5"
                style={{ borderColor: withAlpha(styles.accent, 0.5), color: styles.accent }}
                data-testid="pair-new-pin"
              >
                <QrCode size={13} /> Generate new PIN
              </button>
              <button
                type="button"
                onClick={onClose}
                className="h-9 px-4 rounded-full text-[11px] font-semibold border-[1.5px] transition-colors hover:opacity-80"
                style={{ borderColor: styles.border, color: styles.textSecondary }}
                data-testid="pair-close"
              >
                Close
              </button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function LinkDeviceCard({ linksEnabled, relayHost }: { linksEnabled: boolean; relayHost: string | null }) {
  const styles = useThemeStyles();
  const [dialogOpen, setDialogOpen] = useState(false);
  const closeDialog = useCallback(() => setDialogOpen(false), []);

  return (
    <SectionCard className="p-4 flex flex-col gap-2.5" ariaLabel="Link a device">
      <div className="flex items-center gap-2 flex-wrap">
        <QrCode size={13} style={{ color: styles.accent, opacity: 0.8 }} />
        <span className="text-[13px] font-semibold" style={{ color: styles.text }}>
          Link a device
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          disabled={!linksEnabled}
          title={
            linksEnabled
              ? "Opens a 120-second pairing window with a QR code and PIN"
              : "Turn on device links first — the pairing window rides the encrypted listener"
          }
          className="h-9 px-4 rounded-full text-[11px] font-semibold transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5 self-start"
          style={{ background: styles.accent, color: styles.accentText }}
          data-testid="pair-start-button"
        >
          <QrCode size={13} /> Pair a device
        </button>
      </div>
      <p className="text-[11px] leading-relaxed" style={{ color: styles.textSecondary }}>
        Pair ACUTE-CODE on your phone by scanning a QR code (or typing the details in by hand).
        The code carries this machine's address and identity fingerprint; the window is
        single-use and lasts two minutes.
      </p>
      {!linksEnabled && (
        <p className="text-[11px]" style={{ color: styles.textTertiary }} data-testid="pair-needs-links">
          Device links are off — turn them on above to pair a phone.
        </p>
      )}
      <PairingDialog open={dialogOpen} onClose={closeDialog} relayHost={relayHost} />
    </SectionCard>
  );
}

/* ── §c The linked-devices list ───────────────────────────────────────────── */

function DeviceRow({
  device,
  onNote,
  invalidate,
}: {
  device: MobileDeviceInfo;
  /** Card-level toast (revoke success etc.). */
  onNote: (text: string, isError?: boolean) => void;
  invalidate: () => void;
}) {
  const styles = useThemeStyles();
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  // Revoke — the DELETE rides the R95-A styled confirm (never the browser's
  // window.confirm). A 404 (already revoked elsewhere) surfaces the honest
  // message AND refreshes the list, so the stale row leaves either way.
  const revoke = useMutation({
    mutationFn: () => revokeMobileDevice(device.id),
    onSuccess: () => {
      onNote("Device revoked — its token is dead.");
      setConfirmRevoke(false);
      invalidate();
    },
    onError: (err: Error) => {
      onNote(err.message, true);
      setConfirmRevoke(false);
      invalidate();
    },
  });

  return (
    <div
      data-device={device.id}
      className="border-b last:border-b-0"
      style={{ borderColor: styles.borderSubtle }}
    >
      <div className="flex items-center gap-2 px-3 pt-2.5 flex-wrap">
        <span
          className="text-[12px] font-medium min-w-0 truncate"
          style={{ color: styles.text }}
          title={device.label}
        >
          {device.label}
        </span>
        {device.scopes.map((scope) => (
          <span
            key={scope}
            className="text-[10px] font-medium uppercase tracking-wider rounded-full px-1.5 py-0.5 shrink-0"
            style={{ background: styles.subtle, color: styles.textTertiary }}
            data-testid={`device-scope-${device.id}`}
          >
            {scope}
          </span>
        ))}
        <span className="flex-1" />
        <span
          className="text-[11px] shrink-0 tabular-nums"
          style={{ color: styles.textTertiary }}
          data-testid={`device-lastseen-${device.id}`}
        >
          last seen {timeAgo(device.lastSeenAt)}
        </span>
        <button
          type="button"
          onClick={() => setConfirmRevoke(true)}
          aria-label={`Revoke device ${device.label}`}
          title="Unlink this device — its token stops working immediately"
          className="h-7 px-2.5 rounded-lg text-[11px] font-semibold shrink-0 flex items-center gap-1"
          style={{ background: withAlpha(SEMANTIC_COLORS.danger, 0.12), color: SEMANTIC_COLORS.danger }}
          data-testid={`device-revoke-${device.id}`}
        >
          <Trash2 size={11} /> Revoke
        </button>
      </div>
      <div className="px-3 pb-2.5 text-[10px]" style={{ color: styles.textTertiary }}>
        <span data-testid={`device-created-${device.id}`}>Added {fmtCreated(device.createdAt)}</span>
      </div>
      {confirmRevoke && (
        <ConfirmDialog
          title="Revoke this device?"
          message={`"${device.label}" stops working immediately — its token is deleted, and the phone falls back to its pairing screen. Re-pairing is the only way back.`}
          confirmLabel="Revoke"
          danger
          onConfirm={() => revoke.mutate()}
          onClose={() => setConfirmRevoke(false)}
        >
          <p className="text-[11px]" style={{ color: styles.textTertiary }}>
            The link is long-lived by design — this is the one way it ends.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function LinkedDevicesCard() {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const resetAfter = useTimeoutClear();
  const [msg, setMsg] = useState<string | null>(null);
  const [msgIsError, setMsgIsError] = useState(false);

  const devicesQuery = useQuery({
    queryKey: ["mobile-devices"],
    queryFn: fetchMobileDevices,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["mobile-devices"] });
  };

  const note = (text: string, isError = false) => {
    setMsg(text);
    setMsgIsError(isError);
    resetAfter(() => setMsg(null), 1_500);
  };

  return (
    <SectionCard className="p-4 flex flex-col gap-2.5" ariaLabel="Linked devices">
      <div className="flex items-center gap-2 flex-wrap">
        <Smartphone size={13} style={{ color: styles.accent, opacity: 0.8 }} />
        <span className="text-[13px] font-semibold" style={{ color: styles.text }}>
          Linked devices
        </span>
        <span className="flex-1" />
        {msg && (
          <span
            className="text-[11px] font-medium"
            style={{ color: msgIsError ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.success }}
          >
            {msg}
          </span>
        )}
      </div>
      <p className="text-[11px] leading-relaxed" style={{ color: styles.textSecondary }}>
        Every paired phone, with its last-seen time. A link is long-lived — it survives restarts
        and network changes — until you revoke it.
      </p>

      {devicesQuery.isError ? (
        <p className="text-[11px]" style={{ color: SEMANTIC_COLORS.danger }} role="alert">
          {coreUnreachableHint} to list linked devices.
        </p>
      ) : devicesQuery.isLoading || devicesQuery.data === undefined ? (
        <span className="text-[12px] font-mono" style={{ color: styles.textTertiary }}>
          loading linked devices…
        </span>
      ) : (
        <div
          className="rounded-lg border-[1.5px] overflow-hidden max-h-72 overflow-y-auto"
          style={{ borderColor: styles.border }}
          data-testid="devices-list"
        >
          {devicesQuery.data.length === 0 && (
            <div className="px-3 py-2.5 text-[11px]" style={{ color: styles.textTertiary }} data-testid="devices-empty">
              No devices linked yet — pair your phone above.
            </div>
          )}
          {devicesQuery.data.map((device) => (
            <DeviceRow key={device.id} device={device} onNote={note} invalidate={invalidate} />
          ))}
        </div>
      )}
    </SectionCard>
  );
}

/* ── Composition ──────────────────────────────────────────────────────────── */

/** The dedicated Devices settings tab (?tab=devices) — the desktop half of
 * the R106 device-linking flow + ROUND-112's remote-access card. */
export function DevicesTab() {
  const styles = useThemeStyles();
  // §b's Pair button gates on §a's toggle — one shared read of the setting.
  const settingsQuery = useQuery({
    queryKey: ["device-link-settings"],
    queryFn: fetchDeviceLinkSettings,
  });
  const linksEnabled = settingsQuery.data?.enabled === true;
  // ROUND-112 (R112-a): the remote-access card's shared read — the ~5 s
  // refetchInterval is the card's status-line poll ("while the card is
  // open" — the tab mounts/unmounts with selection, so the poll lives and
  // dies with it) AND the pairing dialog's relay hint stays fresh off the
  // same cache entry.
  const cloudQuery = useQuery({
    queryKey: ["cloud-connector-settings"],
    queryFn: fetchCloudConnectorSettings,
    refetchInterval: 5_000,
  });
  const relayHost =
    cloudQuery.data?.status.state === "connected" ? hostOf(cloudQuery.data.status.relayUrl) : null;
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4" data-testid="devices-tab">
      <div className="pb-1">
        {/* R100-E2: the tab-intro header snapped to the E1 grammar. */}
        <Kicker className="mb-1">Integrations</Kicker>
        <h2 className="text-[13px] font-semibold text-ink">Devices</h2>
        <p className="mt-1 text-[12px]" style={{ color: styles.textSecondary }}>
          Link your phone as a remote view + input for this machine — pairing, remote access,
          linked devices, and revocation.
        </p>
      </div>
      {cloudQuery.isError ? (
        <SectionCard className="p-4" ariaLabel="Remote access">
          <p className="text-[11px]" style={{ color: SEMANTIC_COLORS.danger }} role="alert">
            {coreUnreachableHint} to manage remote access.
          </p>
        </SectionCard>
      ) : (
        <RemoteAccessCard settings={cloudQuery.data} />
      )}
      <DeviceLinkCard />
      <LinkDeviceCard linksEnabled={linksEnabled} relayHost={relayHost} />
      <LinkedDevicesCard />
    </div>
  );
}

export default DevicesTab;
