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
 * This screen never imports the native modules — src/update/updater.ts
 * owns the policy; installer-floor.ts owns the bridge.
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
  cancelAppUpdate,
  checkForAppUpdate,
  deleteDownloadedUpdate,
  downloadAppUpdate,
  getCachedCheck,
  installAppUpdate,
  openInstallPermissionSettings,
  type AppUpdateCheck,
  type ApkAsset,
} from "@/update/updater";
import { formatBytes } from "@/update/core";
import type { NativeDownloadResult } from "@/update/installer-floor";

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

  // ── the download state ──
  const [downloading, setDownloading] = useState(false);
  const [received, setReceived] = useState(0);
  const [total, setTotal] = useState(0);
  const [downloaded, setDownloaded] = useState<NativeDownloadResult | null>(null);
  const [deleting, setDeleting] = useState(false);

  // ── the install gate ──
  const [installsAllowed, setInstallsAllowed] = useState<boolean | null>(null);
  const [installing, setInstalling] = useState(false);

  const available = check?.kind === "available" ? check : null;
  const asset: ApkAsset | null = available?.apk ?? null;

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

  // ── the download ──
  const progress = useSharedValue(0);
  // The animated fill — 1%-step events smoothed by a 260ms timing; reduced
  // motion snaps (the design system's rule for every moving affordance).
  const barFill = useAnimatedStyle(() => {
    const fraction = Math.max(0, Math.min(1, progress.value));
    return { width: `${fraction * 100}%` };
  });
  const startDownload = useCallback(
    (assetToFetch: ApkAsset) => {
      if (downloading) return;
      setDownloading(true);
      setDownloaded(null);
      setReceived(0);
      setTotal(assetToFetch.size ?? 0);
      progress.value = 0;
      mobLog("update", "download start", { name: assetToFetch.name });
      const handle = downloadAppUpdate(assetToFetch);
      const unsub = handle.onProgress((ev) => {
        setReceived(ev.received);
        if (ev.total > 0) setTotal(ev.total);
        const fraction = ev.fraction >= 0 ? ev.fraction : 0;
        progress.value = reducedMotion
          ? fraction
          : withTiming(fraction, { duration: 260 });
      });
      void handle.result
        .then((result) => {
          setDownloaded(result);
          progress.value = 1;
        })
        .catch((e: unknown) => {
          const canceled =
            typeof e === "object" &&
            e !== null &&
            "code" in e &&
            (e as { code?: string }).code === "canceled";
          if (canceled) {
            toast.show({ kind: "caution", text: "download canceled" });
          } else {
            const message = e instanceof Error ? e.message : "the download failed";
            toast.show({ kind: "error", text: message });
            mobWarn("update", "download failed", { message });
          }
        })
        .finally(() => {
          unsub();
          setDownloading(false);
        });
    },
    [downloading, progress, reducedMotion, toast]
  );

  // R130-D3: tapping the sheet's download starts the transfer AND closes
  // the sheet — the progress then lives under the Check updates button
  // (the owner's exact flow).
  const downloadFromSheet = useCallback(
    (assetToFetch: ApkAsset) => {
      setSheetOpen(false);
      startDownload(assetToFetch);
    },
    [startDownload],
  );

  const cancelDownload = useCallback(async () => {
    // The handle's promise rejects with "canceled" — the catch above owns
    // the state reset; this just fires the native stop.
    try {
      await cancelAppUpdate();
    } catch {
      // The cancel is best-effort; the transfer finishing is fine too.
    }
  }, []);

  // ── the delete (R130-D4 — "or delete it from there"): discard the cached
  //     APK; the slot returns to the quiet check state. ──
  const deleteDownloaded = useCallback(async () => {
    if (downloaded === null || deleting) return;
    setDeleting(true);
    try {
      await deleteDownloadedUpdate(downloaded.path);
      setDownloaded(null);
      progress.value = 0;
      setReceived(0);
      toast.show({ kind: "saved", text: "update deleted" });
    } catch {
      toast.show({ kind: "error", text: "could not delete the update" });
    } finally {
      setDeleting(false);
    }
  }, [downloaded, deleting, progress, toast]);

  // ── the install ──
  const runInstall = useCallback(async () => {
    if (!downloaded || installing) return;
    setInstalling(true);
    try {
      await installAppUpdate(downloaded.path);
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
  }, [downloaded, installing, toast]);

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
          Install + Delete once it lands (the owner's exact flow). ── */}
      {(downloading || downloaded !== null) && (
        <FadeInUp>
          <ClayCard>
            <View style={styles.checkPad}>
              {downloading ? (
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
              ) : downloaded !== null ? (
                <>
                  <View style={styles.versionRow}>
                    <TypeBodyStrong>Ready to install</TypeBodyStrong>
                    <TypeMono>{formatBytes(downloaded.size)}</TypeMono>
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
              downloading ? null : (
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
