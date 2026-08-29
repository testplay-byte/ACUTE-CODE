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
}));

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    getProjectsBackend: () => mocks,
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
