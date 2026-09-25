// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { clearUsageData, fetchUsageStats, type UsageStats } from "../../lib/api";
import { ClearUsageDataCard } from "./ClearUsageDataCard";
import { DataStatsPanel } from "./DataStatsPanel";
import { useConfigStore } from "../../lib/config-store";
import { renderWithProviders, resetTestState } from "../../test-utils";

/**
 * ROUND-127 (R127-W1 — SCREENS §3 "THE USAGE PAGE ORDER", step 8 +
 * COMPONENTS §6 at PAGE scope): the pins for the standalone clear-all-data
 * DANGER ZONE, byte-moved from DataStatsPanel (the owner's directive: the
 * danger zone is supposed to be shown at the very bottom — at PAGE scope,
 * never interleaved mid-page). The danger-zone grammar pins (quiet
 * red-OUTLINED box, description-left / red-action-button-right) and the
 * clear-flow contract (ConfirmDialog enumeration → clearUsageData → the
 * success note → the invalidations) are MOVED HERE from
 * DataStatsPanel.test.tsx — their truth is unchanged, only their home.
 *
 * The card renders at BOTH mount sites' tails: the /usage page (after the
 * projects drill-down) and the settings ?tab=data pane (after DataStatsPanel
 * — the composition rendered below, so the invalidation-refetch leg of the
 * moved flow pin stays honest).
 */
vi.mock("../../lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...original,
    fetchUsageStats: vi.fn(),
    clearUsageData: vi.fn(),
  };
});

afterEach(cleanup);

beforeEach(() => {
  resetTestState();
  // The stats hook only runs against the live sidecar (demo mode has no
  // usage log) — flip the store so the mocked fetch actually executes for
  // the sibling-mount flow test.
  useConfigStore.setState({ demoData: false });
  vi.mocked(fetchUsageStats).mockReset().mockResolvedValue(seedStats());
  vi.mocked(clearUsageData).mockReset().mockResolvedValue({ deleted: 0 });
});

function seedStats(): UsageStats {
  return {
    months: 12,
    totals: {
      inputTokens: 420_000,
      outputTokens: 210_000,
      totalTokens: 630_000,
      costUsd: 12.34,
      requests: 321,
      providerCalls: 456,
    },
    peak: { date: "2026-08-14", tokens: 90_000 },
    series: [],
    models: [],
    health: { turnErrors: [], toolFailures: [] },
    generatedAt: "2026-09-15T00:00:00.000Z",
  };
}

/** The standalone card (the /usage page's final section). */
function renderCard() {
  return renderWithProviders(<ClearUsageDataCard />);
}

/** The settings ?tab=data composition — the panel, then the card LAST. */
function renderSettingsTabComposition() {
  return renderWithProviders(
    <>
      <DataStatsPanel />
      <ClearUsageDataCard />
    </>,
  );
}

/** a precedes b in document order. */
function precedes(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

describe("ClearUsageDataCard (R127-W1 — the page-scope danger zone)", () => {
  it("the danger zone is the QUIET GitHub pattern: red outline, NO filled background, NO shadow, description-left / button-right", async () => {
    renderCard();
    const zone = await screen.findByTestId("clear-usage-card");

    // Red-OUTLINED (withAlpha(danger, 0.4))…
    expect(zone.style.borderColor).toBe("rgba(239, 68, 68, 0.4)");
    // …but QUIET: no tinted fill, no shadow (the mid-flow danger card was
    // the owner's "completely looks out of place" verdict).
    expect(zone.style.backgroundColor).toBe("");
    expect(zone.style.boxShadow).toBe("");

    // The danger-tinted micro-header (the label-caps grammar).
    expect(screen.getByText("Danger zone")).toBeTruthy();

    // ONE row: the description LEFT, the red action button RIGHT (the
    // button follows the description inside the row container).
    const button = screen.getByTestId("clear-usage-button");
    expect(button.textContent).toBe("Clear data…");
    const row = button.parentElement as HTMLElement;
    const description = row.querySelector("p");
    expect(description).not.toBeNull();
    expect(description?.textContent).toContain("deletes every usage event in the ledger");
    expect(precedes(description as Element, button)).toBe(true);

    // R127-W1: the standalone section carries its own top spacing — it
    // closes a page/tab now, not a `gap-4` panel flow.
    expect(zone.className).toContain("mt-4");
  });

  it("in the settings-tab composition the card renders AFTER the panel (the zone stays the tab's final section)", async () => {
    renderSettingsTabComposition();
    const panel = await screen.findByTestId("data-stats-panel");
    const zone = screen.getByTestId("clear-usage-card");
    expect(precedes(panel, zone)).toBe(true);
  });

  it("the clear flow keeps its contract: Clear data… → the enumeration dialog → confirm → clearUsageData + the success note + the stats refetch", async () => {
    vi.mocked(clearUsageData).mockResolvedValue({ deleted: 27 });
    renderSettingsTabComposition();
    await screen.findByTestId("clear-usage-card");

    fireEvent.click(screen.getByTestId("clear-usage-button"));

    // The ConfirmDialog — the exact enumeration (what dies vs. what stays).
    expect(await screen.findByTestId("confirm-dialog")).toBeTruthy();
    expect(
      screen.getByText(/Sessions, conversations, agents, providers, and settings are NOT touched/),
    ).toBeTruthy();

    // The stats fetch count BEFORE the clear (the panel's initial mount).
    const fetchesBefore = vi.mocked(fetchUsageStats).mock.calls.length;

    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
    await waitFor(() => expect(vi.mocked(clearUsageData)).toHaveBeenCalledTimes(1));

    // The success note (verb matches the button 1:1) + the invalidation
    // re-drives the panel's own query.
    expect(await screen.findByTestId("clear-usage-success")).toBeTruthy();
    expect(screen.getByTestId("clear-usage-success").textContent).toBe("Cleared 27 usage events");
    await waitFor(() => {
      expect(vi.mocked(fetchUsageStats).mock.calls.length).toBeGreaterThan(fetchesBefore);
    });
  });
});
