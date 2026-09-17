// @vitest-environment happy-dom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MermaidDiagram } from "./MermaidDiagram";
import { renderWithProviders } from "../../test-utils";

/**
 * ROUND-102 (R102-D, owner v0.99.0: "the mermaid flow diagram shows properly
 * now … but apparently I don't have any editing options for it. I cannot
 * zoom in on it, move it right or left, or see the raw code of it or
 * anything like that"): the diagram card's INTERACTIVE VIEWER — the zoom
 * toolbar, the pointer-drag + keyboard pan, the source toggle, the reset.
 *
 * The mermaid render pipeline itself (laziness, retries, the honest failure
 * note) is pinned in ChatMarkdown.test.tsx — these tests mock the chunk the
 * same way and drive the VIEWER on top of a resolved render.
 */
const mockMermaid = vi.hoisted(() => {
  function factory() {
    return {
      default: {
        initialize: vi.fn(),
        render: mockMermaid.render,
      },
    };
  }
  return {
    factory,
    render: vi.fn(),
  };
});

vi.mock("mermaid", () => mockMermaid.factory());

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const CODE = "graph TD;\nA-->B;\nB-->C;";

async function renderDiagram() {
  mockMermaid.render.mockResolvedValue({
    svg: '<svg data-acute-mermaid="probe"><g /></svg>',
  });
  const utils = renderWithProviders(<MermaidDiagram code={CODE} />);
  // The diagram resolves and the viewport mounts.
  await waitFor(() => expect(screen.getByTestId("mermaid-viewport")).toBeTruthy());
  return utils;
}

describe("MermaidDiagram — the R102-D interactive viewer", () => {
  it("renders the toolbar with the zoom level at 100% and the source toggle", async () => {
    await renderDiagram();

    expect(screen.getByTestId("mermaid-zoom-level").textContent).toBe("100%");
    expect(screen.getByTestId("mermaid-zoom-in")).toBeTruthy();
    expect(screen.getByTestId("mermaid-zoom-out")).toBeTruthy();
    expect(screen.getByTestId("mermaid-zoom-reset")).toBeTruthy();
    expect(screen.getByTestId("mermaid-toggle-source")).toBeTruthy();
  });

  it("ZOOM IN/OUT: the buttons step 25% and clamp at 50–300%, and the stage's transform follows", async () => {
    await renderDiagram();

    const stage = screen.getByTestId("mermaid-stage") as HTMLDivElement;
    expect(stage.style.transform).toContain("scale(1)");

    fireEvent.click(screen.getByTestId("mermaid-zoom-in"));
    expect(screen.getByTestId("mermaid-zoom-level").textContent).toBe("125%");
    expect((screen.getByTestId("mermaid-stage") as HTMLDivElement).style.transform).toContain("scale(1.25)");

    // Two more steps land on 175%.
    fireEvent.click(screen.getByTestId("mermaid-zoom-in"));
    fireEvent.click(screen.getByTestId("mermaid-zoom-in"));
    expect(screen.getByTestId("mermaid-zoom-level").textContent).toBe("175%");

    // The upper clamp: hammering zoom-in never exceeds 300%.
    for (let i = 0; i < 10; i += 1) fireEvent.click(screen.getByTestId("mermaid-zoom-in"));
    expect(screen.getByTestId("mermaid-zoom-level").textContent).toBe("300%");

    // The lower clamp: hammering zoom-out never drops below 50%.
    for (let i = 0; i < 16; i += 1) fireEvent.click(screen.getByTestId("mermaid-zoom-out"));
    expect(screen.getByTestId("mermaid-zoom-level").textContent).toBe("50%");
    expect((screen.getByTestId("mermaid-stage") as HTMLDivElement).style.transform).toContain("scale(0.5)");
    expect(stage).toBeTruthy();
  });

  it("RESET: after zoom + pan, the reset button restores 100% and the center", async () => {
    await renderDiagram();

    fireEvent.click(screen.getByTestId("mermaid-zoom-in"));
    const viewport = screen.getByTestId("mermaid-viewport") as HTMLDivElement;
    // Pan via the keyboard path (deterministic in jsdom — pointer capture is
    // not implemented there): focus + ArrowRight.
    fireEvent.keyDown(viewport, { key: "ArrowRight" });
    const stage = screen.getByTestId("mermaid-stage") as HTMLDivElement;
    expect(stage.style.transform).toContain("translate(48px, 0px)");
    expect(stage.style.transform).toContain("scale(1.25)");

    fireEvent.click(screen.getByTestId("mermaid-zoom-reset"));
    expect(screen.getByTestId("mermaid-zoom-level").textContent).toBe("100%");
    expect((screen.getByTestId("mermaid-stage") as HTMLDivElement).style.transform).toBe(
      "translate(0px, 0px) scale(1)",
    );
  });

  it("KEYBOARD PAN: the focused viewport moves with the arrow keys (shift = the 4× jump)", async () => {
    await renderDiagram();

    const viewport = screen.getByTestId("mermaid-viewport") as HTMLDivElement;
    const stage = screen.getByTestId("mermaid-stage") as HTMLDivElement;
    fireEvent.keyDown(viewport, { key: "ArrowLeft" });
    fireEvent.keyDown(viewport, { key: "ArrowDown" });
    expect(stage.style.transform).toContain("translate(-48px, 48px)");
    fireEvent.keyDown(viewport, { key: "ArrowUp", shiftKey: true });
    expect(stage.style.transform).toContain("translate(-48px, -144px)");
    // The viewport is a real tab-stop with an honest label.
    expect(viewport.getAttribute("tabIndex")).toBe("0");
    expect(viewport.getAttribute("role")).toBe("img");
    expect(viewport.getAttribute("aria-label") ?? "").toContain("zoom");
  });

  it("VIEW SOURCE: the toggle swaps the rendered diagram for the raw CodeBlock and back", async () => {
    await renderDiagram();

    // Diagram side first: the viewport is mounted, no code fence yet.
    expect(screen.getByTestId("mermaid-viewport")).toBeTruthy();

    fireEvent.click(screen.getByTestId("mermaid-toggle-source"));
    // Source side: the raw fence renders (CodeBlock's lang badge + the
    // source text), the viewport unmounts, and the toggle reads pressed.
    expect(document.querySelector('[data-code-lang="mermaid"]')).toBeTruthy();
    expect(screen.getByText(/A-->B/)).toBeTruthy();
    expect(screen.queryByTestId("mermaid-viewport")).toBeNull();
    expect(screen.getByTestId("mermaid-toggle-source").getAttribute("aria-pressed")).toBe("true");

    // And back: the diagram returns, the source text is gone.
    fireEvent.click(screen.getByTestId("mermaid-toggle-source"));
    expect(await screen.findByTestId("mermaid-viewport")).toBeTruthy();
    expect(screen.queryByText(/A-->B/)).toBeNull();
  });

  it("a code change RESETS the view — a fresh diagram starts at 100%, centered, diagram-side", async () => {
    mockMermaid.render.mockResolvedValue({
      svg: '<svg data-acute-mermaid="probe"><g /></svg>',
    });
    const { rerender } = renderWithProviders(<MermaidDiagram code={CODE} />);
    await waitFor(() => expect(screen.getByTestId("mermaid-viewport")).toBeTruthy());

    // Manipulate: zoom + enter source view.
    fireEvent.click(screen.getByTestId("mermaid-zoom-in"));
    fireEvent.click(screen.getByTestId("mermaid-toggle-source"));
    expect(screen.queryByTestId("mermaid-viewport")).toBeNull();

    // A NEW diagram code arrives → the view resets.
    rerender(<MermaidDiagram code={"graph LR;\nX-->Y;"} />);
    await waitFor(() => expect(screen.getByTestId("mermaid-viewport")).toBeTruthy());
    expect(screen.getByTestId("mermaid-zoom-level").textContent).toBe("100%");
    expect((screen.getByTestId("mermaid-stage") as HTMLDivElement).style.transform).toBe(
      "translate(0px, 0px) scale(1)",
    );
  });
});
