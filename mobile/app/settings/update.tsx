/**
 * App updates — the phone's own update screen, REDESIGNED for R130 (the
 * owner's exact directive):
 *
 *   "In the More section, it should directly below the Settings option give
 *   the Update option… at the top it shows the current version, but it
 *   should not show the description, the Check GitHub for the acute code
 *   releases… It should only show the version at the very top and nothing
 *   else. And below it, it should show only one button for Check Updates…
 *   even if the update is available, it should not show the details… there
 *   is a shield icon showing, which is not proper… when the user clicks the
 *   update button, it will check for an update and it will show the user a
 *   bottom-up menu with the update details and the download button at the
 *   very bottom. And when the user clicks it and then closes the bottom-up
 *   menu, then the progress will start to show below the check for update
 *   button and the user will also be given an option to cancel it from
 *   there or delete it from there. And if it has been downloaded, then the
 *   install option will be shown there. At the very bottom… no need to show
 *   the GitHub token options. Now you can just outright directly remove
 *   it."
 *
 * THE FLOW (minimal by design):
 *
 *   · THE VERSION — ONE card, `v{APP_VERSION}` and nothing else (the
 *     description caption is dead; the shield icon is dead).
 *   · ONE "Check updates" ChromeButton. Every answer is ONE quiet line —
 *     never an icon, never an inline release card:
 *       up-to-date  → "Up to date"
 *       rate-limited→ "Rate limited — try again in a little while"
 *       error       → the honest one-liner (danger ink)
 *       available   → THE SHEET OPENS (never inline details)
 *   · THE SHEET (the reusable clay bottom sheet) — the release details
 *     (title, the v→v transition, the size, the notes digest) with the
 *     DOWNLOAD button at the sheet's very bottom. Tapping download starts
 *     the transfer AND closes the sheet.
 *   · THE PROGRESS UNDER THE BUTTON — while a transfer runs: the real
 *     determinate bar + the received/total mono line + the quiet Cancel.
 *     When the download lands: "Ready to install" + Install (+ the honest
 *     Android grant gate when the OS demands it) + the quiet Delete that
 *     discards the cached APK — all in the same slot, never a separate card.
 *   · THE TOKEN SECTION IS REMOVED OUTRIGHT (the owner's "just outright
 *     directly remove it"). The updater's anonymous-first policy + its
 *     pinned tests stand untouched — a token saved by an older install
 *     still rides the retry leg; there is simply no UI to manage one.
 *
 * R132-MU — THE STATE OUTLIVES THE ROUTE (the owner's defect: "sometimes
 * the downloading options would disappear and would not be shown even
 * though the download was happening, and if I click check for updates and
 * click download again, it would say download already happening"). The
 * native OkHttp transfer is process-lifetime; the download state here used
 * to be component-local useState, so back-navigation destroyed the mirror
 * while the transfer kept running — a re-mount showed NOTHING and a second
 * Download tap hit the native "busy" rejection as an error toast. All of
 * it now renders FROM the module-scope download manager
 * (src/update/download-manager.ts): a re-mount shows the live progress /
 * the completed card again, "busy" re-attaches instead of erroring
 * (never a toast for a download that is genuinely running), and a completed
 * APK is never silently deleted by a re-download. The check flow, the
 * sheet's own behavior, and the toast grammar are unchanged — this screen's
 * whole job became subscribe → render.
 *
 * This screen never imports the native modules — src/update/updater.ts
 * owns the policy; installer-floor.ts owns the bridge; download-manager.ts
 * owns the lifetime.
 */

import { useCallback, useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import Reanimated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { Download, Trash2, Upload } from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { Sheet } from "@/components/sheet";
import { useToast } from "@/components/toast";
import {
  ChromeButton,
  ClayCard,
  FadeInUp,
  QuietButton,
  TypeBody,
  TypeBodyStrong,
  TypeCaption,
  TypeMono,
} from "@/design/primitives";
import { useTheme } from "@/design/theme";
import { spacing, RADIUS_PILL } from "@/design/tokens";
import { mobLog, mobWarn } from "@/lib/log";
import {
  APP_VERSION,
  cacheCheckResult,
  canRequestInstalls,
  checkForAppUpdate,
  getCachedCheck,
  openInstallPermissionSettings,
  type AppUpdateCheck,
  type ApkAsset,
} from "@/update/updater";
import { formatBytes } from "@/update/core";
import {
  downloadManager,
  type DownloadNotice,
  type DownloadState,
} from "@/update/download-manager";

/** How much of the release notes renders before the fold (honest cap — the
 * full body lives in the release page's grammar; a phone sheet is a digest). */
const NOTES_MAX_LINES = 8;

export default function AppUpdateScreen() {
  const { tokens } = useTheme();
  const toast = useToast();
  const reducedMotion = useReducedMotion();

  // ── the check state ──
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<AppUpdateCheck | null>(null);

  // ── the sheet state (R130-D3: the available answer opens the bottom-up
  //     menu; the details NEVER render inline) ──
  const [sheetOpen, setSheetOpen] = useState(false);

  // ── the download state (R132-MU1 — the MANAGER's, not the route's: the
  //     native transfer is process-lifetime, so the mirror must be too; a
  //     back-navigation mid-download changes nothing) ──
  const [dlState, setDlState] = useState<DownloadState>(() => downloadManager.getState());
  const [deleting, setDeleting] = useState(false);

  // ── the install gate ──
  const [installsAllowed, setInstallsAllowed] = useState<boolean | null>(null);
  const [installing, setInstalling] = useState(false);

  const available = check?.kind === "available" ? check : null;
  const asset: ApkAsset | null = available?.apk ?? null;

  // The render's whole download truth, derived from the manager's snapshot.
  const dlActive = dlState.phase === "active";
  const dlResult = dlState.phase === "done" ? dlState.result : null;
  const received = dlState.phase === "active" ? dlState.received : 0;
  const total = dlState.phase === "active" ? dlState.total : 0;

  // ── the cached answer (the 24 h auto-check) paints the first frame; the
  //     grant probe runs once so the gate never lies by omission. R130: the
  //     CACHED available answer does NOT auto-open the sheet (details show
  //     only through an explicit check). ──
  useEffect(() => {
    void (async () => {
      const cached = await getCachedCheck();
      if (cached) setCheck(cached);
      const allowed = await canRequestInstalls().catch(() => null);
      setInstallsAllowed(allowed);
    })();
  }, []);

  // ── the download subscription (R132-MU1/MU2): render from the manager,
  // and ask the native side ONCE whether a transfer is live — if the JS
  // state was lost (a reload-class desync) while OkHttp kept streaming, the
  // manager adopts the real transfer and the bar RESUMES instead of a
  // blank menu. ──
  const progress = useSharedValue(0);
  // The animated fill — 1%-step events smoothed by a 260ms timing; reduced
  // motion snaps (the design system's rule for every moving affordance).
  const barFill = useAnimatedStyle(() => {
    const fraction = Math.max(0, Math.min(1, progress.value));
    return { width: `${fraction * 100}%` };
  });
  useEffect(() => {
    // The notice grammar drives the bar + the toasts: "busy" NEVER reaches
    // here as an error (the manager re-attaches it internally — R132-MU3);
    // "canceled" stays the caution toast; real failures stay errors.
    const applyNotice = (state: DownloadState, notice: DownloadNotice) => {
      setDlState(state);
      switch (notice.kind) {
        case "started":
          // Snap — a new transfer never drains the previous bar.
          progress.value = 0;
          break;
        case "progress": {
          const s = state.phase === "active" ? state : null;
          if (!s) break;
          const fraction = s.total > 0 ? Math.max(0, Math.min(1, s.received / s.total)) : 0;
          progress.value = reducedMotion ? fraction : withTiming(fraction, { duration: 260 });
          break;
        }
        case "completed":
          progress.value = 1;
          break;
        case "discarded":
          progress.value = 0;
          break;
        case "canceled":
          toast.show({ kind: "caution", text: "download canceled" });
          break;
        case "failed":
          toast.show({ kind: "error", text: notice.message });
          mobWarn("update", "download failed", { message: notice.message });
          break;
        case "reset":
          break; // quiet — the card simply leaves (an adopted transfer's end)
      }
    };
    const unsub = downloadManager.subscribe(applyNotice);
    // Re-sync once on subscribe (a transition inside the commit gap), then
    // the one-per-mount native probe.
    setDlState(downloadManager.getState());
    const snap = downloadManager.getState();
    if (snap.phase === "active") {
      progress.value =
        snap.total > 0 ? Math.max(0, Math.min(1, snap.received / snap.total)) : 0;
    } else if (snap.phase === "done") {
      progress.value = 1;
    }
    void downloadManager.probeNative();
    return unsub;
  }, [progress, reducedMotion, toast]);

  // ── the manual check: ONE button, one quiet line per answer — an
  //     AVAILABLE answer opens the sheet (the R130 flow's whole shape). ──
  const runCheck = useCallback(async () => {
    if (checking) return;
    setChecking(true);
    mobLog("update", "manual check");
    try {
      const result = await checkForAppUpdate();
      setCheck(result);
      await cacheCheckResult(result);
      if (result.kind === "available") {
        setSheetOpen(true);
      } else if (result.kind === "error") {
        mobWarn("update", "check failed", { message: result.message });
      }
    } finally {
      setChecking(false);
    }
  }, [checking]);

  // R130-D3 + R132-MU3: tapping the sheet's download starts the transfer
  // AND closes the sheet — the progress then lives under the Check updates
  // button (the owner's exact flow). The manager owns the lifecycle: a
  // second tap while one runs is a no-op (the native single-flight law,
  // guarded in JS — never a "busy" toast), and a tap with a COMPLETED
  // result for the same asset is a no-op too — the sheet closes on the
  // ready-to-install card already sitting under the button, and the cached
  // APK is never silently deleted just to re-download ~57 MB.
  const downloadFromSheet = useCallback((assetToFetch: ApkAsset) => {
    setSheetOpen(false);
    downloadManager.start(assetToFetch);
  }, []);

  const cancelDownload = useCallback(async () => {
    // The manager settles the state (our handle's chain rejects "canceled"
    // — the caution toast rides the notice, not this call); this just fires
    // the stop through the manager's live-transfer knowledge.
    try {
      await downloadManager.cancel();
    } catch {
      // The cancel is best-effort; the transfer finishing is fine too.
    }
  }, []);

  // ── the delete (R130-D4 — "or delete it from there"): discard the cached
  //     APK; the slot returns to the quiet check state. ──
  const deleteDownloaded = useCallback(async () => {
    if (dlState.phase !== "done" || deleting) return;
    setDeleting(true);
    try {
      await downloadManager.discard();
      toast.show({ kind: "saved", text: "update deleted" });
    } catch {
      toast.show({ kind: "error", text: "could not delete the update" });
    } finally {
      setDeleting(false);
    }
  }, [dlState, deleting, toast]);

  // ── the install ──
  const runInstall = useCallback(async () => {
    if (dlState.phase !== "done" || installing) return;
    setInstalling(true);
    try {
      await downloadManager.install();
      mobLog("update", "install intent fired");
      // The OS installer now owns the flow; the app goes background.
    } catch (e) {
      const message = e instanceof Error ? e.message : "the installer refused to start";
      toast.show({ kind: "error", text: message });
      mobWarn("update", "install failed", { message });
      // The grant may have been revoked mid-flow — re-probe honestly.
      const allowed = await canRequestInstalls().catch(() => null);
      setInstallsAllowed(allowed);
    } finally {
      setInstalling(false);
    }
  }, [dlState, installing, toast]);

  const openGrant = useCallback(async () => {
    try {
      await openInstallPermissionSettings();
    } catch {
      toast.show({ kind: "error", text: "could not open the permission page" });
    }
  }, [toast]);

  return (
    <ScreenScaffold title="Update" back>
      {/* ── THE VERSION — and NOTHING else (R130-D2: the description caption
          is dead, the "ACUTE companion" label is dead — the owner's "only
          show the version at the very top and nothing else"). ── */}
      <ClayCard>
        <View style={styles.versionPad}>
          <TypeMono testID="update-version">{`v${APP_VERSION}`}</TypeMono>
        </View>
      </ClayCard>

      {/* ── THE CHECK — one button; every answer is ONE quiet line (never an
          icon, never inline details — an AVAILABLE answer opens the sheet
          below). ── */}
      <ClayCard>
        <View style={styles.checkPad}>
          <ChromeButton
            onPress={() => void runCheck()}
            busy={checking}
            labelFit
            testID="update-check-button"
          >
            {checking ? "Checking…" : "Check updates"}
          </ChromeButton>

          {check?.kind === "up-to-date" && (
            <FadeInUp>
              <TypeBody style={{ color: tokens.textSecondary }}>Up to date</TypeBody>
            </FadeInUp>
          )}
          {check?.kind === "rate-limited" && (
            <FadeInUp>
              <TypeBody style={{ color: tokens.textSecondary }}>
                Rate limited — try again in a little while
              </TypeBody>
            </FadeInUp>
          )}
          {check?.kind === "error" && (
            <FadeInUp>
              <TypeBody style={{ color: tokens.danger }}>{check.message}</TypeBody>
            </FadeInUp>
          )}
        </View>
      </ClayCard>

      {/* ── THE PROGRESS / THE INSTALL — under the Check updates button, in
          the SAME slot (never a separate card): the determinate bar + the
          byte counts + Cancel while the transfer runs; "Ready to install" +
          Install + Delete once it lands (the owner's exact flow — and
          R132-MU: the slot renders from the manager, so it SURVIVES
          back-navigation and re-appears on the re-mounted screen). ── */}
      {(dlActive || dlResult !== null) && (
        <FadeInUp>
          <ClayCard>
            <View style={styles.checkPad}>
              {dlActive ? (
                <>
                  <View style={styles.versionRow}>
                    <TypeBodyStrong>Downloading</TypeBodyStrong>
                    <TypeMono>
                      {formatBytes(received)}
                      {total > 0 ? ` / ${formatBytes(total)}` : ""}
                    </TypeMono>
                  </View>
                  <View
                    style={[styles.barTrack, { backgroundColor: tokens.subtle }]}
                    accessibilityLabel="Download progress"
                  >
                    <Reanimated.View
                      style={[styles.barFill, { backgroundColor: tokens.accentDeep }, barFill]}
                    />
                  </View>
                  <QuietButton onPress={() => void cancelDownload()} tone="danger">
                    Cancel
                  </QuietButton>
                </>
              ) : dlResult !== null ? (
                <>
                  <View style={styles.versionRow}>
                    <TypeBodyStrong>Ready to install</TypeBodyStrong>
                    <TypeMono>{formatBytes(dlResult.size)}</TypeMono>
                  </View>

                  {installsAllowed === false && (
                    <View style={styles.answerRow}>
                      <TypeBody style={{ color: tokens.textSecondary }}>
                        Android needs this app's permission to install from this
                        source before the install can start.
                      </TypeBody>
                      <QuietButton onPress={() => void openGrant()}>
                        Allow installs from this source
                      </QuietButton>
                    </View>
                  )}

                  <ChromeButton
                    onPress={() => void runInstall()}
                    busy={installing}
                    labelFit
                    testID="update-install-button"
                  >
                    <Upload size={18} color={tokens.accentText} strokeWidth={2.2} />
                    Install{available !== null ? ` v${available.version}` : ""}
                  </ChromeButton>
                  <QuietButton
                    onPress={() => void deleteDownloaded()}
                    tone="danger"
                    busy={deleting}
                  >
                    <Trash2 size={16} color={tokens.danger} strokeWidth={2.2} />
                    Delete
                  </QuietButton>
                </>
              ) : null}
            </View>
          </ClayCard>
        </FadeInUp>
      )}

      {/* ── THE SHEET (R130-D3 — the bottom-up menu with the update details
          and the download button at the very bottom). ── */}
      <Sheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title="Update available"
        testID="update-sheet"
      >
        {available !== null ? (
          <View style={styles.sheetBody}>
            <TypeBodyStrong>{available.title}</TypeBodyStrong>
            <TypeCaption numberOfLines={1}>
              v{available.current} → v{available.version}
              {asset?.size != null ? ` · ${formatBytes(asset.size)}` : ""}
            </TypeCaption>
            {available.notes ? (
              <View style={styles.notesBlock}>
                <TypeBody numberOfLines={NOTES_MAX_LINES}>{available.notes}</TypeBody>
              </View>
            ) : null}
            {asset !== null ? (
              dlActive ? null : (
                <ChromeButton
                  onPress={() => downloadFromSheet(asset)}
                  labelFit
                  testID="update-download-button"
                >
                  <Download size={18} color={tokens.accentText} strokeWidth={2.2} />
                  Download
                </ChromeButton>
              )
            ) : (
              <TypeCaption>
                This release ships no Android APK — the next release carries one.
              </TypeCaption>
            )}
          </View>
        ) : (
          <View style={styles.sheetBody}>
            <TypeCaption>the check's answer is no longer available — check again</TypeCaption>
          </View>
        )}
      </Sheet>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  /** R130-D2 — the version card's pad: one quiet row, nothing else. */
  versionPad: {
    padding: spacing.lg,
  },
  /** The check slot + the progress/install slot share the same grammar. */
  checkPad: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  versionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  answerRow: {
    gap: spacing.sm,
  },
  sheetBody: {
    gap: spacing.sm,
    paddingBottom: spacing.md,
  },
  notesBlock: {
    marginTop: spacing.xs,
  },
  barTrack: {
    height: 10,
    borderRadius: RADIUS_PILL,
    overflow: "hidden",
  },
  barFill: {
    height: "100%",
    borderRadius: RADIUS_PILL,
  },
});
