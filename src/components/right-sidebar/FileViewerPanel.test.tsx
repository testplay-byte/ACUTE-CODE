// @vitest-environment happy-dom
/**
 * ROUND-99 (R99-A) — FileViewerPanel: the file tab's markdown LINKS route
 * through the central link router (owner directive: "add native browser
 * support… ship them alongside the application so it does not have to rely
 * on the device's browser itself"). Before R99 the renderer's anchors were
 * plain `<a target="_blank">` — silently SWALLOWED inside WebView2, i.e.
 * dead links (the documented AboutTab lesson).
 *
 * The panel is a VIEW over the projects surface — getProjectsBackend() is
 * mocked with an in-memory file backend (the FilesExplorerPanel.test.tsx
 * pattern) so the REAL useProjectFile hook + the REAL render path run; a
 * README-shaped .md with a markdown link, a code file for the non-md leg,
 * and the no-file-bound guard.
 *
 * Pins:
 *  · a markdown link click routes IN-APP — a browser tab lands in THIS
 *    project's right-sidebar slice (useRightSidebarStore), href preserved;
 *  · the 'system' preference hands the click to window.open instead;
 *  · a code file renders the line-numbered path (links don't exist there);
 *  · a tab with no bound file says so honestly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { setLinkOpeningMode } from "../../lib/open-link";
import { useRightSidebarStore, type RightSidebarTab } from "../../lib/right-sidebar-store";
import { renderWithProviders, resetTestState } from "../../test-utils";
import { FileViewerPanel } from "./FileViewerPanel";

const mocks = vi.hoisted(() => ({
  file: vi.fn(),
}));

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    getProjectsBackend: () => mocks,
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  resetTestState();
  window.localStorage.clear();
  setLinkOpeningMode("in-app");
  useRightSidebarStore.setState({ byProject: {} });
});

const PROJECT_ID = "prj_fv_probe";

const README_MD = [
  "# ACUTE-CODE",
  "",
  "See [the docs](https://example.com/docs) and [the guide](https://example.com/guide).",
  "",
  "- plain bullet",
].join("\n");

function makeFileTab(filePath: string): RightSidebarTab {
  return { id: "tab_file_1", type: "file", title: filePath.split("/").pop() ?? filePath, filePath, createdAt: 1 };
}

/** The browser tabs currently sitting in the right-sidebar store. */
function browserTabsInStore(): Array<{ browserUrl?: string | null }> {
  return Object.values(useRightSidebarStore.getState().byProject).flatMap((slice) =>
    slice.tabs.filter((t) => t.type === "browser"),
  );
}

describe("FileViewerPanel (ROUND-99 R99-A)", () => {
  it("a markdown link click routes IN-APP — a browser tab lands in this project's sidebar; the href stays on the anchor", async () => {
    mocks.file.mockResolvedValue({ content: README_MD });
    renderWithProviders(<FileViewerPanel projectId={PROJECT_ID} tab={makeFileTab("README.md")} />);

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "the docs" })).toBeTruthy();
    });
    const link = screen.getByRole("link", { name: "the docs" }) as HTMLAnchorElement;
    // The a11y/copy-link contract: the REAL href + rel survive — only the
    // navigation is intercepted.
    expect(link.getAttribute("href")).toBe("https://example.com/docs");
    expect(link.getAttribute("rel")).toBe("noreferrer");

    fireEvent.click(link);
    await waitFor(() => {
      expect(browserTabsInStore()).toEqual([
        expect.objectContaining({ type: "browser", browserUrl: "https://example.com/docs" }),
      ]);
    });
    // The tab landed in THIS project's slice (the panel passes its own
    // projectId — no prop drilling, no guessing).
    const key = Object.keys(useRightSidebarStore.getState().byProject)[0];
    expect(key).toContain(PROJECT_ID);
  });

  it("a second link click opens a SECOND in-app browser tab (both stay in the sidebar)", async () => {
    mocks.file.mockResolvedValue({ content: README_MD });
    renderWithProviders(<FileViewerPanel projectId={PROJECT_ID} tab={makeFileTab("README.md")} />);

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "the docs" })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("link", { name: "the docs" }));
    fireEvent.click(screen.getByRole("link", { name: "the guide" }));

    await waitFor(() => {
      expect(browserTabsInStore()).toHaveLength(2);
    });
    expect(browserTabsInStore().map((t) => t.browserUrl)).toEqual([
      "https://example.com/docs",
      "https://example.com/guide",
    ]);
  });

  it("the 'system' preference sends the click to the OS browser instead (window.open in web mode)", async () => {
    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);
    setLinkOpeningMode("system");
    mocks.file.mockResolvedValue({ content: README_MD });
    renderWithProviders(<FileViewerPanel projectId={PROJECT_ID} tab={makeFileTab("README.md")} />);

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "the docs" })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("link", { name: "the docs" }));

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith("https://example.com/docs", "_blank", "noreferrer");
    });
    expect(browserTabsInStore()).toHaveLength(0);
  });

  it("a CODE file renders the line-numbered view — no anchors to route", async () => {
    mocks.file.mockResolvedValue({ content: 'console.log("hi");\nconst x = 1;\n' });
    renderWithProviders(<FileViewerPanel projectId={PROJECT_ID} tab={makeFileTab("src/main.js")} />);

    // The code path tokenizes each line into highlight spans — assert on the
    // rendered text content, not a single text node.
    await waitFor(() => {
      expect(document.body.textContent).toContain("console.log");
    });
    expect(document.body.textContent).toContain("const x = 1;");
    expect(document.querySelector("a")).toBeNull();
    expect(browserTabsInStore()).toHaveLength(0);
  });

  it("a tab with no bound file says so honestly (no crash, no query)", () => {
    renderWithProviders(
      <FileViewerPanel projectId={PROJECT_ID} tab={{ id: "tab_none", type: "file", title: "Empty", createdAt: 1 }} />,
    );
    expect(screen.getByText("No file bound to this tab.")).toBeTruthy();
    expect(mocks.file).not.toHaveBeenCalled();
  });
});
