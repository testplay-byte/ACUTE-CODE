// @vitest-environment happy-dom
/**
 * ROUND-67 (R67/D) tests — ScreenshotStrip, the live screenshot THUMBNAIL
 * strip rendered under the live turn's WorkingSection (the owner: "if the
 * agent takes screenshots or does some image work, then the images should
 * be shown during its thinking in the agent's chat window itself, in a
 * small view"). Pinned here:
 *   · the strip renders NOTHING when the turn has no captures;
 *   · each tile lazy-fetches its raster (fetchComputerFrameRaster) and shows
 *     the PNG via an object URL (createObjectURL mocked — happy-dom has no
 *     Blob URL support) — with the caption/alt carrying the capturing tool;
 *   · a failed fetch (the honest 404 after the 10-minute TTL) renders the
 *     quiet "expired" placeholder tile, never a crash;
 *   · clicking a tile opens the full-view Dialog (image + tool + timestamp);
 *   · the object URL is REVOKED on unmount (no Blob leak).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ScreenshotStrip, type ScreenshotStripShot } from "./ScreenshotStrip";
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

const SHOT = (over: Partial<ScreenshotStripShot> = {}): ScreenshotStripShot => ({
  frameId: "f-1",
  tool: "screenshot",
  ts: 1_757_136_000_000, // 2026-09-06T~10:40Z — a fixed, sane clock read
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

describe("ScreenshotStrip (ROUND-67 R67-D)", () => {
  it("renders NOTHING when the turn has no screenshots (the owner sees no empty section)", () => {
    const { container } = render(<ScreenshotStrip screenshots={[]} />);
    expect(screen.queryByTestId("screenshot-strip")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("a tile lazy-fetches its raster and renders the PNG through an object URL", async () => {
    rasterMock.fetch.mockResolvedValue(new Blob(["\x89PNG-bytes"], { type: "image/png" }));
    render(<ScreenshotStrip screenshots={[SHOT()]} />);
    const thumb = screen.getByTestId("screenshot-thumb");
    expect(thumb).toBeTruthy();
    // The lazy fetch fired for exactly this frame id.
    await waitFor(() => expect(rasterMock.fetch).toHaveBeenCalledWith("f-1"));
    // The blob became an object URL and the <img> carries it + the caption alt.
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const img = await screen.findByRole("img", { name: "Screenshot captured by screenshot" });
    expect(img.getAttribute("src")).toBe("blob:screenshot-test");
    // The strip header is present with the count.
    expect(screen.getByText("Screenshots")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    // The caption names WHAT was captured ("Screenshot · <tool>").
    expect(screen.getByText("Screenshot · screenshot")).toBeTruthy();
  });

  it("a FAILED raster fetch (the 404 after the 10-minute TTL) renders the quiet 'expired' placeholder — never a crash", async () => {
    rasterMock.fetch.mockRejectedValue(new Error("404 NOT_FOUND"));
    render(<ScreenshotStrip screenshots={[SHOT({ frameId: "f-gone", tool: "zoom" })]} />);
    await waitFor(() => expect(screen.getByText("expired")).toBeTruthy());
    // No image, no object URL, and the tile is still clickable (it opens the
    // dialog with the honest "expired" line).
    expect(screen.queryByRole("img")).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("clicking a tile opens the full-view dialog (image + capturing tool)", async () => {
    rasterMock.fetch.mockResolvedValue(new Blob(["\x89PNG-bytes"], { type: "image/png" }));
    render(
      <ScreenshotStrip screenshots={[SHOT({ frameId: "bs_x", tool: "browser_control" })]} />,
    );
    await screen.findByRole("img", { name: "Screenshot captured by browser_control" });
    fireEvent.click(screen.getByTestId("screenshot-thumb"));
    const dialog = await screen.findByTestId("screenshot-dialog");
    expect(dialog).toBeTruthy();
    // The description carries the capturing tool (the caption contract).
    expect(dialog.textContent).toContain("browser_control");
    // The full image rides the SAME object URL.
    const fullImg = dialog.querySelector("img");
    expect(fullImg?.getAttribute("src")).toBe("blob:screenshot-test");
  });

  it("the object URL is REVOKED when the tile unmounts (no Blob leak)", async () => {
    rasterMock.fetch.mockResolvedValue(new Blob(["\x89PNG-bytes"], { type: "image/png" }));
    const { unmount } = render(<ScreenshotStrip screenshots={[SHOT()]} />);
    await screen.findByRole("img", { name: "Screenshot captured by screenshot" });
    expect(revokeObjectURL).not.toHaveBeenCalled();
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:screenshot-test");
  });

  it("multiple captures render one tile EACH, in strip order (newest last)", async () => {
    rasterMock.fetch.mockResolvedValue(new Blob(["\x89PNG-bytes"], { type: "image/png" }));
    render(<ScreenshotStrip screenshots={[SHOT({ frameId: "f-1" }), SHOT({ frameId: "f-2", tool: "zoom" })]} />);
    const thumbs = await screen.findAllByTestId("screenshot-thumb");
    expect(thumbs).toHaveLength(2);
    expect(rasterMock.fetch).toHaveBeenCalledWith("f-1");
    expect(rasterMock.fetch).toHaveBeenCalledWith("f-2");
  });
});
