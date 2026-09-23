/**
 * The model CONFIGURE SCREEN (R120-M, round-120 §1 items 19-22 — the owner's
 * models overhaul): the Edit-Model surface is a SCREEN now, not a sheet —
 * the reasoning-levels editor + the one-line capability rows + the pricing
 * trio need the room a 0.86-height sheet never had, and the flow laws the
 * owner ruled:
 *
 *   · item 19 — tapping an add-model SEARCH RESULT (or submitting a custom
 *     id) lands HERE with the id/name carried in (the old tap prefilled a
 *     form below the search list — which read as "does nothing");
 *   · item 20 — the SMART FETCH: while the screen opens it fetches the
 *     model's live entry off GET /providers/:id/models (the same listing
 *     the picker read — 5-minute cache server-side) and auto-populates the
 *     context window, max output, the pricing trio, and the capability
 *     hints the provider actually serves (agent-core registry.ts's
 *     extractModelDetails). A provider that serves none of those fields is
 *     the GRACEFUL NO-OP: one honest line, never a fabricated value;
 *   · item 22 — SAVE-BEFORE-ADD: the model lands in the provider's list
 *     ONLY when this screen's explicit save succeeds (draft state while
 *     configuring; cancel/back = discard — nothing was ever committed);
 *   · items 17/18/21 ride the shared ModelFormSections (model-form.tsx):
 *     the simplified-on-blur sizing fields, the color-coded SVG capability
 *     pills on ONE line, and the reasoning-levels ladder.
 *
 * Edit mode (?record=<db id>) hydrates off GET /providers/:id/models-config
 * (the saved row) and then runs the same smart fetch in ONLY-BLANK mode —
 * the owner's saved configuration outranks the catalog, a blank field takes
 * the provider's first served value, and a user typing while the fetch
 * lands is never clobbered (any edit flips the apply to blank-only).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { ErrorState, SkeletonList } from "@/components/list-state";
import {
  ChromeButton,
  ClayInput,
  QuietButton,
  StatusDot,
  TypeCaption,
  TypeMono,
} from "@/design/primitives";
import { useTheme } from "@/design/theme";
import { PAGE_CTA_MIN_W, RADIUS_INPUT, spacing } from "@/design/tokens";
import { successHaptic, warningHaptic } from "@/design/haptics";
import { ModelFormSections, type ModelFormPatch } from "@/components/model-form";
import {
  addProviderModel,
  applyModelDetailsToDraft,
  blankModelDraft,
  catalogPrefillFor,
  cleanModelName,
  fetchModelCatalog,
  fetchProviderModelDetails,
  fetchProviderModelsConfig,
  firstNumericError,
  modelAddBody,
  modelDraftFromRecord,
  modelDraftPreview,
  modelEditBody,
  updateModel,
  type CatalogModelEntry,
  type ModelFormDraft,
  type ModelRecord,
  type ModelSummary,
} from "@/features/config";
import { modelRowLabel } from "@/features/provider-display";
import { getLinkManager } from "@/link/runtime";
import { useLink } from "@/link/use-link";
import { mobLog, mobWarn } from "@/lib/log";

/** The smart-fetch strip's honest states (item 20). */
type SmartFetchState = "pending" | "served" | "absent";

export default function ModelConfigureScreen() {
  const { tokens } = useTheme();
  const router = useRouter();
  const { status } = useLink();
  const connected = status === "connected";
  const params = useLocalSearchParams<{ id: string; record?: string; modelId?: string; name?: string }>();
  const providerId = typeof params.id === "string" ? params.id : null;
  const recordParam = typeof params.record === "string" && params.record !== "" ? params.record : null;
  const modelIdParam = typeof params.modelId === "string" && params.modelId !== "" ? params.modelId : null;
  const nameParam = typeof params.name === "string" ? params.name : null;
  // The mode is settled by the params: ?record= edits a saved row,
  // ?modelId= configures a NEW one (the draft that only save commits).
  const addMode = recordParam === null && modelIdParam !== null;

  const [record, setRecord] = useState<ModelRecord | null>(null);
  const [draft, setDraft] = useState<ModelFormDraft>(() => blankModelDraft());
  const [phase, setPhase] = useState<"loading" | "ready" | "notfound">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [smartFetch, setSmartFetch] = useState<SmartFetchState>("pending");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Any user edit flips the smart fetch's apply to ONLY-BLANK (an owner
  // typing outranks the catalog — never a clobber mid-edit).
  const userTouched = useRef(false);

  const patch = useCallback<ModelFormPatch>((next) => {
    userTouched.current = true;
    setDraft((prev) => ({ ...prev, ...next }));
  }, []);

  /** The one model's live catalog details (item 20) — applied onto the
   * current draft with the mode's blank policy; a provider that serves no
   * details (or a listing that does not know the id) is the honest no-op. */
  const runSmartFetch = useCallback(
    async (modelId: string, onlyBlank: boolean) => {
      if (providerId === null) return;
      try {
        const outcome = await fetchProviderModelDetails(getLinkManager(), providerId, modelId);
        if (!outcome.ok) {
          // A failed details fetch never blocks editing — the graceful
          // no-op line, the honest reason logged.
          setSmartFetch("absent");
          mobWarn("config", "model details fetch failed (graceful no-op)", {
            providerId,
            modelId,
            status: outcome.error.status,
            message: outcome.error.message,
          });
          return;
        }
        const entry: ModelSummary | null = outcome.data.entry;
        const details = entry?.details;
        if (entry === null || details === undefined) {
          setSmartFetch("absent");
          mobLog("config", "model details not served", {
            providerId,
            modelId,
            cached: outcome.data.cached,
          });
          return;
        }
        setSmartFetch("served");
        // Any edit while the fetch was in flight wins over the catalog
        // (onlyBlank) — the owner's hands outrank the provider's metadata.
        setDraft((prev) => applyModelDetailsToDraft(prev, details, onlyBlank || userTouched.current));
        mobLog("config", "model details applied", { providerId, modelId, cached: outcome.data.cached });
      } catch {
        setSmartFetch("absent");
        mobWarn("config", "model details fetch threw (graceful no-op)", { providerId, modelId });
      }
    },
    [providerId],
  );

  const load = useCallback(async () => {
    if (!connected || providerId === null) return;
    setPhase("loading");
    setLoadError(null);
    setSmartFetch("pending");
    userTouched.current = false;
    const sender = getLinkManager();
    try {
      if (recordParam !== null) {
        // ── EDIT: the saved row is the truth; the smart fetch only fills
        // what the owner never set (onlyBlank). ──
        const outcome = await fetchProviderModelsConfig(sender, providerId);
        if (!outcome.ok) {
          setLoadError(outcome.error.message);
          mobWarn("config", "model configure load failed", {
            providerId,
            status: outcome.error.status,
            message: outcome.error.message,
          });
          return;
        }
        const row = outcome.data.models.find((m) => m.id === recordParam) ?? null;
        if (row === null) {
          setPhase("notfound");
          return;
        }
        setRecord(row);
        setDraft(modelDraftFromRecord(row));
        setError(null);
        setPhase("ready");
        void runSmartFetch(row.modelId, true);
        mobLog("config", "model configure loaded (edit)", { providerId, record: row.id });
        return;
      }
      // ── ADD: the static catalog prefill + the live entry (name, detected
      // reasoning, details) in one flight; the provider's own numbers
      // OVERRIDE the static prefill (item 20's add-mode policy). ──
      if (modelIdParam === null) return;
      const [catalogOutcome, detailsOutcome] = await Promise.all([
        fetchModelCatalog(sender),
        fetchProviderModelDetails(sender, providerId, modelIdParam),
      ]);
      const staticCatalog: CatalogModelEntry[] = catalogOutcome.ok
        ? catalogOutcome.data.models
        : [];
      if (!catalogOutcome.ok) {
        mobWarn("config", "static catalog unavailable at prefill", {
          message: catalogOutcome.error.message,
        });
      }
      let entry: ModelSummary | null = null;
      if (detailsOutcome.ok) {
        entry = detailsOutcome.data.entry;
        setSmartFetch(entry !== null && entry.details !== undefined ? "served" : "absent");
      } else {
        setSmartFetch("absent");
        mobWarn("config", "model details fetch failed (graceful no-op)", {
          providerId,
          modelId: modelIdParam,
          message: detailsOutcome.error.message,
        });
      }
      const seed: ModelFormDraft =
        entry !== null
          ? catalogPrefillFor(entry, staticCatalog)
          : catalogPrefillFor(
              { id: modelIdParam, name: nameParam ?? modelIdParam },
              staticCatalog,
            );
      const details = entry?.details;
      // The provider's own numbers outrank the static catalog on ADD (the
      // freshest truth) — a fetch that failed never blocks the seed.
      setDraft(details !== undefined ? applyModelDetailsToDraft(seed, details, false) : seed);
      setError(null);
      setPhase("ready");
      mobLog("config", "model configure loaded (add)", {
        providerId,
        modelId: modelIdParam,
        details: details !== undefined,
      });
    } catch (err) {
      setLoadError("the host dropped while loading — pull to retry");
      mobWarn("config", "model configure load threw", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [connected, providerId, recordParam, modelIdParam, nameParam, runSmartFetch]);

  useEffect(() => {
    if (connected) void load();
  }, [connected, load]);

  const onSave = useCallback(async () => {
    if (busy || phase !== "ready") return;
    // Validate the numerics first — the per-field message shows inline.
    const numericError = firstNumericError(draft);
    if (numericError !== null) {
      setError(numericError);
      void warningHaptic();
      return;
    }
    if (addMode) {
      const body = modelAddBody(draft);
      if (body === null) {
        setError("a model id is required");
        void warningHaptic();
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const outcome = await addProviderModel(getLinkManager(), providerId ?? "", body);
        if (outcome.ok) {
          mobLog("config", "model added (configure screen)", {
            providerId,
            modelId: body.modelId,
          });
          void successHaptic();
          router.back();
        } else {
          mobWarn("config", "model add failed", {
            providerId,
            status: outcome.error.status,
            message: outcome.error.message,
          });
          void warningHaptic();
          setError(outcome.error.message);
        }
      } catch {
        mobWarn("config", "model add threw");
        void warningHaptic();
        setError("the host is offline — the model was not added");
      } finally {
        setBusy(false);
      }
      return;
    }
    if (record === null) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await updateModel(getLinkManager(), record.id, modelEditBody(draft, record));
      if (outcome.ok) {
        mobLog("config", "model record updated (configure screen)", {
          id: record.id,
          modelId: record.modelId,
        });
        void successHaptic();
        router.back();
      } else {
        mobWarn("config", "model PATCH failed", {
          id: record.id,
          status: outcome.error.status,
          message: outcome.error.message,
        });
        void warningHaptic();
        setError(outcome.error.message);
      }
    } catch {
      mobWarn("config", "model PATCH threw");
      void warningHaptic();
      setError("the host is offline — the record is unchanged");
    } finally {
      setBusy(false);
    }
  }, [busy, phase, draft, addMode, record, providerId, router]);

  const title =
    record !== null
      ? modelRowLabel(record)
      : modelIdParam !== null
        ? nameParam ?? cleanModelName(modelIdParam)
        : "Model";

  return (
    <ScreenScaffold title={title} back subtitle={providerId ?? undefined}>
      {!connected ? (
        <HostGate status={status} />
      ) : phase === "notfound" ? (
        <ErrorState
          title="model not found"
          caption="it may have been deleted on the desktop — the list is one back tap away."
          retryLabel="back to the list"
          onRetry={() => router.back()}
        />
      ) : loadError !== null ? (
        <ErrorState
          title="could not load the model"
          caption={loadError}
          retryLabel="try again"
          onRetry={() => void load()}
        />
      ) : phase === "loading" ? (
        <SkeletonList rows={7} rowHeight={64} />
      ) : (
        <View style={styles.formGap}>
          {/* ── item 20 — the SMART FETCH strip: the calm pulsing dot while
              the provider's own metadata loads; the ONE honest no-op line
              when the provider serves none (never a fabricated value); a
              served fetch renders NO line — the populated fields are the
              evidence. ── */}
          {smartFetch === "pending" ? <SmartFetchStrip state="pending" /> : null}
          {smartFetch === "absent" ? <SmartFetchStrip state="absent" /> : null}

          {/* modelId — IDENTITY on PATCH (read-only mono truth), the one
              editable seed field on ADD. */}
          {addMode ? (
            <ClayInput
              label="Model id"
              mono
              value={draft.modelId}
              onChangeText={(text) => patch({ modelId: text })}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Model id"
            />
          ) : (
            <View style={styles.readOnlyWrap}>
              <TypeCaption style={styles.fieldLabel} numberOfLines={1}>
                Model id (read-only)
              </TypeCaption>
              <View
                style={[
                  styles.readOnlyMono,
                  { borderColor: tokens.borderSubtle, backgroundColor: tokens.inputBg },
                ]}
              >
                <TypeMono numberOfLines={1}>{draft.modelId}</TypeMono>
              </View>
            </View>
          )}

          {/* items 17/18/21 — the shared editor sections (model-form.tsx). */}
          <ModelFormSections draft={draft} patch={patch} />

          {/* the live preview strip — the draft's key numbers, ONE mono line. */}
          <View style={[styles.previewStrip, { backgroundColor: tokens.subtle }]}>
            <TypeMono
              numberOfLines={1}
              style={[styles.previewMono, { color: tokens.textTertiary }]}
              testID={addMode ? "add-model-preview" : "edit-model-preview"}
            >
              {modelDraftPreview(draft)}
            </TypeMono>
          </View>

          {error !== null ? (
            <TypeCaption style={{ color: tokens.danger }} numberOfLines={3}>
              {error}
            </TypeCaption>
          ) : null}

          {/* ── item 22 — the ONE commit: the model lands in the list only
              here (add) / the row's truth changes only here (edit). The CTA
              grammar: centered, self-sized, minWidth 200; the discard escape
              sits quiet beneath — cancel = discard, nothing was committed. ── */}
          <ChromeButton
            onPress={() => void onSave()}
            disabled={busy}
            accessibilityLabel={busy ? "Saving the model" : "Save the model"}
            style={styles.pageCta}
          >
            {busy ? "saving…" : addMode ? "Add model" : "Save model"}
          </ChromeButton>
          <QuietButton onPress={() => router.back()} disabled={busy} style={styles.pageQuiet}>
            Cancel
          </QuietButton>
        </View>
      )}
    </ScreenScaffold>
  );
}

// ── the smart-fetch strip (item 20's small loading animation) ───────────────

function SmartFetchStrip({ state }: { state: "pending" | "absent" }) {
  const { tokens } = useTheme();
  if (state === "pending") {
    return (
      <View style={styles.smartFetchRow}>
        {/* The calm 600ms pulse (StatusDot's own breathing) — the "small
            loading animation" the owner asked for; never a spinner. */}
        <StatusDot color={tokens.accent} pulse />
        <TypeCaption numberOfLines={1} style={{ color: tokens.textTertiary }}>
          fetching the model's details…
        </TypeCaption>
      </View>
    );
  }
  return (
    <View style={styles.smartFetchRow}>
      <StatusDot color={tokens.textTertiary} />
      <TypeCaption numberOfLines={1} style={{ color: tokens.textTertiary }}>
        the provider didn't serve model details
      </TypeCaption>
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
          ? "this model lives on the desktop — pair one to configure it here."
          : "the model reloads the moment the link returns."
      }
      retryLabel={unpaired ? "link a desktop" : "retry now"}
      onRetry={() => (unpaired ? router.push("/connect") : getLinkManager().retryNow())}
    />
  );
}

const styles = StyleSheet.create({
  formGap: { gap: spacing.lg },
  fieldLabel: { textTransform: "uppercase", letterSpacing: 0.8 },
  readOnlyWrap: { gap: spacing.xs },
  readOnlyMono: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: RADIUS_INPUT,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    minHeight: 44,
    justifyContent: "center",
  },
  previewStrip: {
    borderRadius: RADIUS_INPUT,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  previewMono: { fontSize: 11, lineHeight: 15 },
  smartFetchRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  pageCta: { alignSelf: "center", minWidth: PAGE_CTA_MIN_W },
  pageQuiet: { alignSelf: "center" },
});
