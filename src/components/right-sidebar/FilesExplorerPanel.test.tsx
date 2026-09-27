// @vitest-environment happy-dom
/**
 * ROUND-48 (R48-c) — FilesExplorerPanel: the right-sidebar file explorer
 * (owner: "on the left half, the actual file system with navigation/open
 * folders/click files; on the right side, the actual content of the files").
 *
 * The panel is a VIEW over the projects surface — getProjectsBackend() is
 * mocked with an in-memory ProjectsBackend shaped exactly like the sidecar's
 * (list/tree/file), so the REAL useProjectTree/useProjectFile hooks and the
 * REAL render paths run: tree rows from GET /tree, folder expand/collapse,
 * click-file → GET /file content (markdown for .md, line-numbered code
 * otherwise), the Search button firing the requestFilePicker event, the
 * tree-collapse toggle, and honest loading/error states with retry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { useRightSidebarEvents } from "../../lib/right-sidebar-events";
import type { Project, TreeNode } from "../../lib/api";
import { renderWithProviders, resetTestState } from "../../test-utils";
import { FilesExplorerPanel } from "./FilesExplorerPanel";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  remove: vi.fn(),
  tree: vi.fn(),
  file: vi.fn(),
  // R131-TH (TH3): the bytes-route fetch — mocked so the image leg's door
  // is observable (the REAL isDisplayableImageAttachment stays).
  bytes: vi.fn(),
}));

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    getProjectsBackend: () => mocks,
    fetchAttachmentBytes: mocks.bytes,
  };
});

afterEach(cleanup);

const PROJECT: Project = {
  id: "prj_1",
  name: "ACUTE-CODE",
  rootPath: "/home/dev/ACUTE-CODE",
  color: "#FF6B2C",
  createdAt: "2026-08-20T08:00:00Z",
};

const TREE: TreeNode[] = [
  { name: "README.md", type: "file", path: "README.md", size: 1204 },
  // R131-TH (TH3): the image + binary probe files (the pixels branch and
  // the NUL-sniff guard's own pins).
  { name: "screen.png", type: "file", path: "shots/screen.png", size: 2048 },
  { name: "data.bin", type: "file", path: "assets/data.bin", size: 512 },
  {
    name: "src",
    type: "folder",
    path: "src",
    children: [
      { name: "index.ts", type: "file", path: "src/index.ts", size: 318 },
      {
        name: "components",
        type: "folder",
        path: "src/components",
        children: [{ name: "Button.tsx", type: "file", path: "src/components/Button.tsx", size: 388 }],
      },
    ],
  },
];

const FILES: Record<string, string> = {
  "README.md": "# ACUTE-CODE\n\nAgent-native coding workspace.\n\n- item one\n",
  "src/index.ts": 'import { createRoot } from "react-dom/client";\n\ncreateRoot(el).render(<App />);\n',
  "src/components/Button.tsx": "export function Button() {\n  return <button />;\n}\n",
  // R131-TH (TH3): a NUL-bearing "text" payload — the binary guard's probe.
  "assets/data.bin": "PK\u0000\u0003\u0004-binary-garbage",
};

const tab = { id: "tab-files", type: "files" as const, title: "Files", createdAt: Date.now() };

beforeEach(() => {
  resetTestState();
  vi.mocked(mocks.list).mockReset().mockResolvedValue([PROJECT]);
  vi.mocked(mocks.get).mockReset().mockResolvedValue(PROJECT);
  vi.mocked(mocks.remove).mockReset().mockResolvedValue(undefined);
  vi.mocked(mocks.tree).mockReset().mockResolvedValue({ tree: TREE, rootPath: PROJECT.rootPath });
  vi.mocked(mocks.file).mockReset().mockImplementation(async (_id: string, path: string) => {
    if (FILES[path] === undefined) throw new Error(`no such file: ${path}`);
    return { path, content: FILES[path] };
  });
  useRightSidebarEvents.setState({ filePickerRequest: 0, terminalFocusRequest: 0 });
});

const treeRow = (path: string): HTMLElement => {
  // Paths are quoted attribute values (no quotes/backslashes in them).
  const el = document.querySelector(`[data-tree-path="${path}"]`);
  if (el === null) throw new Error(`tree row not found: ${path}`);
  return el as HTMLElement;
};

function renderPanel() {
  return renderWithProviders(<FilesExplorerPanel projectId="prj_1" tab={tab} />);
}

describe("FilesExplorerPanel (ROUND-48 R48-c)", () => {
  it("renders the two-pane explorer: header project name + tree from GET /tree with top-level folders expanded", async () => {
    renderPanel();

    // Header: project name (from the projects list).
    expect(await screen.findByText("ACUTE-CODE")).toBeTruthy();
    // Tree rows render; top-level folder `src` is expanded on first load
    // (seeded) so its direct child is visible without a click.
    expect(await waitFor(() => treeRow("src"))).toBeTruthy();
    expect(treeRow("README.md")).toBeTruthy();
    expect(treeRow("src/index.ts")).toBeTruthy();
    // Depth-2 folder row renders (child of the expanded top-level `src`)
    // but stays COLLAPSED — its own children are hidden until clicked.
    expect(treeRow("src/components")).toBeTruthy();
    expect(document.querySelector('[data-tree-path="src/components/Button.tsx"]')).toBeNull();
    expect(mocks.tree).toHaveBeenCalledWith("prj_1");
  });

  it("folder click expands nested children, second click collapses", async () => {
    renderPanel();
    await waitFor(() => treeRow("src"));

    fireEvent.click(treeRow("src/components"));
    await waitFor(() => expect(treeRow("src/components/Button.tsx")).toBeTruthy());

    fireEvent.click(treeRow("src/components"));
    await waitFor(() =>
      expect(document.querySelector('[data-tree-path="src/components/Button.tsx"]')).toBeNull(),
    );
  });

  it("click file → GET /file content renders: markdown for .md, line-numbered code for .ts", async () => {
    renderPanel();
    await waitFor(() => treeRow("src/index.ts"));

    // Empty state before a selection.
    expect(screen.getByText(/Select a file in the tree/i)).toBeTruthy();

    // Markdown file: the shared FileViewerPanel renderer output.
    fireEvent.click(treeRow("README.md"));
    expect(await screen.findByText("Agent-native coding workspace.")).toBeTruthy();
    expect(mocks.file).toHaveBeenCalledWith("prj_1", "README.md");
    // Breadcrumb shows the selected path (tree row + breadcrumb = 2 hits).
    expect(screen.getAllByText("README.md")).toHaveLength(2);
  });

  it("clicking a code file renders line-numbered tokenized content", async () => {
    renderPanel();
    await waitFor(() => treeRow("src/index.ts"));

    fireEvent.click(treeRow("src/index.ts"));
    // Code body renders (the fixture body mentions createRoot on two lines,
    // each line tokenized separately) + line numbers 1..3.
    await waitFor(() => expect(screen.getAllByText(/createRoot/).length).toBe(2));
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(mocks.file).toHaveBeenCalledWith("prj_1", "src/index.ts");
  });

  it("the header Search button fires requestFilePicker (the old quick-menu behavior stays reachable)", async () => {
    renderPanel();
    await waitFor(() => treeRow("src"));

    expect(useRightSidebarEvents.getState().filePickerRequest).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: /Search files/i }));
    expect(useRightSidebarEvents.getState().filePickerRequest).toBe(1);
  });

  it("the tree-collapse toggle hides the tree pane (narrow-width mode) and brings it back", async () => {
    renderPanel();
    await waitFor(() => treeRow("src"));

    fireEvent.click(screen.getByRole("button", { name: /Hide file tree/i }));
    expect(document.querySelector('[data-tree-path="src"]')).toBeNull();
    expect(screen.queryByLabelText(/Project file tree/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Show file tree/i }));
    await waitFor(() => expect(treeRow("src")).toBeTruthy());
  });

  it("tree load failure shows the honest error card and Retry refetches", async () => {
    vi.mocked(mocks.tree).mockRejectedValueOnce(new Error("sidecar unreachable"));
    renderPanel();

    expect(await screen.findByText("sidecar unreachable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Try again/i }));
    await waitFor(() => expect(treeRow("src")).toBeTruthy());
  });

  it("file load failure shows the honest error card and Retry refetches", async () => {
    renderPanel();
    await waitFor(() => treeRow("README.md"));

    vi.mocked(mocks.file).mockRejectedValueOnce(new Error("file read blew up"));
    fireEvent.click(treeRow("README.md"));
    expect(await screen.findByText("file read blew up")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Try again/i }));
    await waitFor(() => expect(screen.getByText("Agent-native coding workspace.")).toBeTruthy());
  });
});

// ── ROUND-131 (R131-TH, TH3): the explorer pane mirrors the viewer tab's
// image law — a displayable image NEVER rides the text route (the bytes
// route + an object URL instead), and NUL-bearing content renders the
// honest binary notice instead of mojibake. ──
describe("FilesExplorerPanel (ROUND-131 R131-TH TH3 — the image branch + the binary guard)", () => {
  const SLOW = { timeout: 5000 };
  // happy-dom implements neither — the object-URL lifecycle is this pair.
  const createObjectURL = vi.fn(() => "blob:explorer");
  const revokeObjectURL = vi.fn();

  beforeEach(() => {
    URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    vi.mocked(mocks.bytes).mockReset().mockResolvedValue(
      new Blob(["\x89PNG-explorer-bytes"], { type: "image/png" }),
    );
  });

  it("clicking an image file renders the PIXEL pane — the bytes route, an object-URL <img>, no text-route fetch, no <pre>", async () => {
    renderPanel();
    await waitFor(() => treeRow("shots/screen.png"));

    fireEvent.click(treeRow("shots/screen.png"));
    await waitFor(() => {
      expect(mocks.bytes).toHaveBeenCalledWith("prj_1", "shots/screen.png");
    });
    // The text route never fires for the image (and would have thrown the
    // "no such file" error card — the implicit backstop).
    expect(mocks.file).not.toHaveBeenCalledWith("prj_1", "shots/screen.png");

    const img = await screen.findByTestId("file-image-preview", {}, SLOW);
    expect(img.getAttribute("src")).toBe("blob:explorer");
    expect(img.getAttribute("alt")).toBe("screen.png");
    expect(document.querySelector("pre")).toBeNull();
  });

  it("a bytes-route failure keeps the honest placeholder frame (no fabricated photo, no error card)", async () => {
    vi.mocked(mocks.bytes).mockRejectedValue(new Error("404 — no attachment at 'shots/screen.png'"));
    renderPanel();
    await waitFor(() => treeRow("shots/screen.png"));

    fireEvent.click(treeRow("shots/screen.png"));
    const frame = await screen.findByTestId("file-image-frame", {}, SLOW);
    expect(frame.textContent).toContain("could not load");
    expect(frame.textContent).toContain("screen.png");
    expect(screen.queryByTestId("file-image-preview")).toBeNull();
  });

  it("unmounting the panel REVOKES the object URL (the lifecycle law)", async () => {
    renderPanel();
    await waitFor(() => treeRow("shots/screen.png"));

    fireEvent.click(treeRow("shots/screen.png"));
    expect(await screen.findByTestId("file-image-preview", {}, SLOW)).toBeTruthy();
    cleanup();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:explorer");
  });

  it("clicking a NUL-bearing file renders the BINARY notice — the honest guard, not mojibake", async () => {
    renderPanel();
    await waitFor(() => treeRow("assets/data.bin"));

    fireEvent.click(treeRow("assets/data.bin"));
    const notice = await screen.findByTestId("file-binary-notice", {}, SLOW);
    expect(notice.textContent).toContain("Binary file");
    // The raw-text leg never mounts — no <pre>, no mojibake.
    expect(document.querySelector("pre")).toBeNull();
    expect(document.body.textContent).not.toContain("PK");
  });
});
