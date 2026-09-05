// @vitest-environment happy-dom
/**
 * ROUND-68 (R68-A) tests — ScreenshotRow, the INLINE screenshot row
 * rendered by WorkingSection at the `screenshot` WorkingEntry's list
 * position (the owner: "When the screenshots were taken they should be
 * shown at that specific time" — not in a bottom strip). Pinned here:
 *   · the row lazy-fetches its raster (fetchComputerFrameRaster) and shows
 *     the PNG via an object URL (createObjectURL mocked — happy-dom has no
 *     Blob URL support) — with the caption/alt carrying the capturing tool;
 *   · a failed fetch (the honest 404 after the 10-minute TTL) renders the
 *     quiet "expired" placeholder, never a crash;
 *   · clicking the row opens the full-view Dialog (image + tool + timestamp);
 *   · the object URL is REVOKED on unmount (no Blob leak).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ScreenshotRow, type ScreenshotRowShot } from "./ScreenshotRow";
import { resetTestState } from "../../test-utils";

/** The api-module mock holder (the AgentChatPanel hoisted-mock pattern). */
const rasterMock = vi.hoisted(() => ({
  fetch: null as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock("../../lib/api", async () => {
  const mod = await import("../../lib/api");
  rasterMock.fetch = vi.fn();
  return { ...mod, fetchComputerFrameRaster: rasterMock.fetch };
});

const createObjectURL = vi.fn(() => "blob:screenshot-test");
const revokeObjectURL = vi.fn();

const SHOT = (over: Partial<ScreenshotRowShot> = {}): ScreenshotRowShot => ({
  frameId: "f-1",
  tool: "screenshot",
  ts: "2026-09-06T10:40:00.000Z", // a fixed, sane clock read
  ...over,
});

beforeEach(() => {
  resetTestState();
  // happy-dom implements neither createObjectURL nor revokeObjectURL — the
  // object-URL lifecycle is the mock pair above (created → revoked).
  URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  rasterMock.fetch.mockReset();
});

afterEach(cleanup);

describe("ScreenshotRow (ROUND-68 R68-A)", () => {
  it("the row lazy-fetches its raster and renders the PNG through an object URL", async () => {
    rasterMock.fetch.mockResolvedValue(new Blob(["\x89PNG-bytes"], { type: "image/png" }));
    render(<ScreenshotRow shot={SHOT()} />);
    const row = screen.getByTestId("screenshot-row");
    expect(row).toBeTruthy();
    // The lazy fetch fired for exactly this frame id.
    await waitFor(() => expect(rasterMock.fetch).toHaveBeenCalledWith("f-1"));
    // The blob became an object URL and the <img> carries it + the caption alt.
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const img = await screen.findByRole("img", { name: "Screenshot captured by screenshot" });
    expect(img.getAttribute("src")).toBe("blob:screenshot-test");
    // NO strip header (the R67-D "Screenshots" label + count are gone with
    // the strip — the row is inline, self-contained).
    expect(screen.queryByText("Screenshots")).toBeNull();
    // The caption names WHAT was captured ("Screenshot · <tool>").
    expect(screen.getByText("Screenshot · screenshot")).toBeTruthy();
  });

  it("a FAILED raster fetch (the 404 after the 10-minute TTL) renders the quiet 'expired' placeholder — never a crash", async () => {
    rasterMock.fetch.mockRejectedValue(new Error("404 NOT_FOUND"));
    render(<ScreenshotRow shot={SHOT({ frameId: "f-gone", tool: "zoom" })} />);
    await waitFor(() => expect(screen.getByText("expired")).toBeTruthy());
    // No image, no object URL, and the row is still clickable (it opens the
    // dialog with the honest "expired" line).
    expect(screen.queryByRole("img")).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("clicking the row opens the full-view dialog (image + capturing tool)", async () => {
    rasterMock.fetch.mockResolvedValue(new Blob(["\x89PNG-bytes"], { type: "image/png" }));
    render(<ScreenshotRow shot={SHOT({ frameId: "bs_x", tool: "browser_control" })} />);
    await screen.findByRole("img", { name: "Screenshot captured by browser_control" });
    fireEvent.click(screen.getByRole("button", { name: "Open screenshot captured by browser_control" }));
    const dialog = await screen.findByTestId("screenshot-dialog");
    expect(dialog).toBeTruthy();
    // The description carries the capturing tool (the caption contract).
    expect(dialog.textContent).toContain("browser_control");
    // The full image rides the SAME object URL.
    const fullImg = dialog.querySelector("img");
    expect(fullImg?.getAttribute("src")).toBe("blob:screenshot-test");
  });

  it("the object URL is REVOKED when the row unmounts (no Blob leak)", async () => {
    rasterMock.fetch.mockResolvedValue(new Blob(["\x89PNG-bytes"], { type: "image/png" }));
    const { unmount } = render(<ScreenshotRow shot={SHOT()} />);
    await screen.findByRole("img", { name: "Screenshot captured by screenshot" });
    expect(revokeObjectURL).not.toHaveBeenCalled();
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:screenshot-test");
  });

  it("each capture renders its own row (one row per entry — the caller maps entries in order)", async () => {
    rasterMock.fetch.mockResolvedValue(new Blob(["\x89PNG-bytes"], { type: "image/png" }));
    const { container } = render(
      <>
        <ScreenshotRow shot={SHOT({ frameId: "f-1" })} />
        <ScreenshotRow shot={SHOT({ frameId: "f-2", tool: "zoom" })} />
      </>,
    );
    const rows = await waitFor(() => {
      const found = container.querySelectorAll('[data-testid="screenshot-row"]');
      expect(found).toHaveLength(2);
      return found;
    });
    expect(rows).toHaveLength(2);
    expect(rasterMock.fetch).toHaveBeenCalledWith("f-1");
    expect(rasterMock.fetch).toHaveBeenCalledWith("f-2");
  });
});
