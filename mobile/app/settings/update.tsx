/**
 * App updates — the phone's own update screen (R124, the owner's
 * first-improvement ruling: "within the Android application, there should
 * be an option to easily update it and download the latest version and be
 * able to install the APK").
 *
 * THE FLOW, top to bottom (one honest card per state — never a spinner
 * pretending to be an answer):
 *
 *   · THE VERSION CARD — this build's own version (the same source the
 *     More hub's identity line reads) + the one-line role.
 *   · THE CHECK CARD — "Check for updates" (the button carries the busy
 *     state; every answer renders inline):
 *       up-to-date  → the calm line
 *       available   → the release card (title, notes, size) + Download
 *       rate-limited→ the honest limit + the optional-token suggestion
 *       error       → the honest message + the retry
 *   · THE DOWNLOAD CARD (while a transfer runs) — a REAL determinate bar
 *     (animated fill on 1%-step events; reduced motion snaps) + the
 *     received/total counts + the cancel affordance (R123's rule: every
 *     processing state carries real motion).
 *   · THE INSTALL CARD — the gate is honest: when Android's per-app
 *     "Install unknown apps" grant is missing, the one-tap "Allow installs
 *     from this source" row opens the system page FIRST; Install then
 *     hands the cached APK to the OS installer (whose own confirm dialog
 *     is the confirmation an APK install deserves).
 *   · THE OPTIONAL TOKEN — the R123 grammar verbatim: "Optional — the
 *     repository is public… the token only accelerates rate-limited or
 *     private access." SecureStore custody; Save/Remove.
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
import { Download, ShieldCheck, Trash2, Upload } from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { useToast } from "@/components/toast";
import {
  ClayCard,
  ChromeButton,
  ClayInput,
  FadeInUp,
  QuietButton,
  SectionHeader,
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
  clearGithubToken,
  downloadAppUpdate,
  getCachedCheck,
  getSavedGithubToken,
  installAppUpdate,
  openInstallPermissionSettings,
  saveGithubToken,
  type AppUpdateCheck,
  type ApkAsset,
} from "@/update/updater";
import { formatBytes } from "@/update/core";
import type { NativeDownloadResult } from "@/update/installer-floor";

/** How much of the release notes renders before the fold (honest cap — the
 * full body lives in the release page's grammar; a phone card is a digest). */
const NOTES_MAX_LINES = 8;

export default function AppUpdateScreen() {
  const { tokens } = useTheme();
  const toast = useToast();
  const reducedMotion = useReducedMotion();

  // ── the check state ──
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<AppUpdateCheck | null>(null);

  // ── the download state ──
  const [downloading, setDownloading] = useState(false);
  const [received, setReceived] = useState(0);
  const [total, setTotal] = useState(0);
  const [downloaded, setDownloaded] = useState<NativeDownloadResult | null>(null);

  // ── the install gate ──
  const [installsAllowed, setInstallsAllowed] = useState<boolean | null>(null);
  const [installing, setInstalling] = useState(false);

  // ── the optional token ──
  const [tokenDraft, setTokenDraft] = useState("");
  const [tokenSaved, setTokenSaved] = useState(false);
  const [tokenBusy, setTokenBusy] = useState(false);

  const available = check?.kind === "available" ? check : null;
  const asset: ApkAsset | null = available?.apk ?? null;

  // ── the cached answer (the 24 h auto-check) paints the first frame; the
  // grant probe runs once so the gate never lies by omission. ──
  useEffect(() => {
    void (async () => {
      const cached = await getCachedCheck();
      if (cached) setCheck(cached);
      const saved = await getSavedGithubToken();
      setTokenSaved(saved !== null);
      const allowed = await canRequestInstalls().catch(() => null);
      setInstallsAllowed(allowed);
    })();
  }, []);

  // ── the manual check ──
  const runCheck = useCallback(async () => {
    if (checking) return;
    setChecking(true);
    mobLog("update", "manual check");
    try {
      const result = await checkForAppUpdate();
      setCheck(result);
      await cacheCheckResult(result);
      if (result.kind === "error") {
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

  const cancelDownload = useCallback(async () => {
    // The handle's promise rejects with "canceled" — the catch above owns
    // the state reset; this just fires the native stop.
    try {
      await cancelAppUpdate();
    } catch {
      // The cancel is best-effort; the transfer finishing is fine too.
    }
  }, []);

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

  // ── the optional token ──
  const saveToken = useCallback(async () => {
    setTokenBusy(true);
    try {
      await saveGithubToken(tokenDraft);
      setTokenSaved(tokenDraft.trim() !== "");
      setTokenDraft("");
      toast.show({ kind: "saved", text: "token saved" });
    } catch {
      toast.show({ kind: "error", text: "could not save the token" });
    } finally {
      setTokenBusy(false);
    }
  }, [tokenDraft, toast]);

  const removeToken = useCallback(async () => {
    setTokenBusy(true);
    try {
      await clearGithubToken();
      setTokenSaved(false);
      toast.show({ kind: "saved", text: "token removed" });
    } catch {
      toast.show({ kind: "error", text: "could not remove the token" });
    } finally {
      setTokenBusy(false);
    }
  }, [toast]);

  return (
    <ScreenScaffold title="App updates" back subtitle="this phone's own build">
      {/* ── the version card ── */}
      <SectionHeader>Version</SectionHeader>
      <ClayCard>
        <View style={styles.pad}>
          <View style={styles.versionRow}>
            <TypeBodyStrong>ACUTE companion</TypeBodyStrong>
            <TypeMono>v{APP_VERSION}</TypeMono>
          </View>
          <TypeCaption>
            Checks GitHub for the ACUTE-CODE release APK (arm64) — the same
            releases the desktop watches.
          </TypeCaption>
        </View>
      </ClayCard>

      {/* ── the check card ── */}
      <SectionHeader>Check</SectionHeader>
      <ClayCard>
        <View style={styles.pad}>
          <ChromeButton
            onPress={() => void runCheck()}
            busy={checking}
            labelFit
            testID="update-check-button"
          >
            {checking ? "Checking…" : "Check for updates"}
          </ChromeButton>

          {check?.kind === "up-to-date" && (
            <FadeInUp>
              <View style={styles.answerRow} accessibilityLabel="Up to date">
                <View style={[styles.answerIcon, { backgroundColor: tokens.subtle }]}>
                  <ShieldCheck size={18} color={tokens.accent} strokeWidth={2.2} />
                </View>
                <TypeBody>
                  Up to date — v{check.latest} is the latest release.
                </TypeBody>
              </View>
            </FadeInUp>
          )}

          {available && (
            <FadeInUp>
              <View style={styles.releaseCard}>
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
                {asset ? (
                  downloading ? null : (
                    <ChromeButton
                      onPress={() => startDownload(asset)}
                      labelFit
                      testID="update-download-button"
                    >
                      <Download size={18} color={tokens.accentText} strokeWidth={2.2} />
                      Download the APK
                    </ChromeButton>
                  )
                ) : (
                  <TypeCaption>
                    This release ships no Android APK — the next release carries one.
                  </TypeCaption>
                )}
              </View>
            </FadeInUp>
          )}

          {check?.kind === "rate-limited" && (
            <FadeInUp>
              <View style={styles.answerRow}>
                <TypeBody>
                  GitHub's anonymous rate limit was hit
                  {check.tokenTried ? " even with the token" : ""}. Try again in a little
                  while, or save a token below to raise the limit.
                </TypeBody>
              </View>
            </FadeInUp>
          )}

          {check?.kind === "error" && (
            <FadeInUp>
              <View style={styles.answerRow}>
                <TypeBody style={{ color: tokens.danger }}>{check.message}</TypeBody>
              </View>
            </FadeInUp>
          )}
        </View>
      </ClayCard>

      {/* ── the download card (a REAL determinate bar — R123's rule) ── */}
      {downloading && (
        <FadeInUp>
          <ClayCard>
            <View style={styles.pad}>
              <View style={styles.versionRow}>
                <TypeBodyStrong>Downloading the APK</TypeBodyStrong>
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
            </View>
          </ClayCard>
        </FadeInUp>
      )}

      {/* ── the install card (the honest gate first) ── */}
      {downloaded && !downloading && (
        <FadeInUp>
          <ClayCard>
            <View style={styles.pad}>
              <View style={styles.versionRow}>
                <TypeBodyStrong>Ready to install</TypeBodyStrong>
                <TypeMono>{formatBytes(downloaded.size)}</TypeMono>
              </View>

              {installsAllowed === false && (
                <View style={styles.answerRow}>
                  <TypeBody>
                    Android needs this app's permission to install from this source
                    before the install can start.
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
                Install v{available?.version ?? "the update"}
              </ChromeButton>
              <TypeCaption>
                Android's own installer confirms the update — nothing installs
                silently.
              </TypeCaption>
            </View>
          </ClayCard>
        </FadeInUp>
      )}

      {/* ── the optional token (R123's grammar verbatim) ── */}
      <SectionHeader>GitHub token · optional</SectionHeader>
      <ClayCard>
        <View style={styles.pad}>
          <TypeCaption>
            Optional — the repository is public. A token only accelerates
            rate-limited checks and private access; it never rides the
            anonymous first leg.
          </TypeCaption>
          <ClayInput
            placeholder="ghp_… or github_pat_…"
            value={tokenDraft}
            onChangeText={setTokenDraft}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            accessibilityLabel="Optional GitHub token"
          />
          <View style={styles.tokenRow}>
            <ChromeButton
              onPress={() => void saveToken()}
              disabled={!tokenDraft.trim()}
              busy={tokenBusy}
              labelFit
            >
              Save token
            </ChromeButton>
            {tokenSaved && (
              <QuietButton onPress={() => void removeToken()} tone="danger" busy={tokenBusy}>
                <Trash2 size={16} color={tokens.danger} strokeWidth={2.2} />
                Remove
              </QuietButton>
            )}
          </View>
          {tokenSaved && (
            <TypeCaption>
              A token is saved on this phone (SecureStore) — it rides only the
              retry leg.
            </TypeCaption>
          )}
        </View>
      </ClayCard>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  pad: {
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
  answerIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  releaseCard: {
    gap: spacing.xs,
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
  tokenRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
});
