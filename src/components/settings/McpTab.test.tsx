// @vitest-environment happy-dom
/**
 * ROUND-61 (R61-2-a) — the MCP servers settings tab:
 *
 *  1. loading → data flow (the mono loader swaps for the rows).
 *  2. Rows render name + the mono command line + args chip + enabled Switch.
 *  3. The enabled Switch PATCHes /mcp/:id with {enabled} and refetches.
 *  4. Probe → probeMcpServer(id): ok renders the green "reachable · N tools
 *     · Xms" chip; a failed probe renders the server's error text.
 *  5. Tools → listMcpTools(id) rows (name + description); the server's
 *     in-band error surfaces when listing fails.
 *  6. Delete → two-step confirm ("The child process is killed.") →
 *     deleteMcpServer(id) + refetch.
 *  7. The add-server form parses args/env and POSTs /mcp (enabled: true);
 *     a rejection surfaces the ApiError message inline.
 *  8. Empty state + the load-error hint (coreUnreachableHint).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  createMcpServer,
  deleteMcpServer,
  listMcpServers,
  listMcpTools,
  probeMcpServer,
  updateMcpServer,
} from "../../lib/api";
import type { McpServerRecord } from "../../lib/api";
import { renderWithProviders, resetTestState } from "../../test-utils";
import McpTab from "./McpTab";

// The tab is a VIEW over the MCP REST surface — the api module is mocked
// exactly as the real sidecar shapes it (MemoryPanel.test.tsx pattern).
vi.mock("../../lib/api", () => ({
  listMcpServers: vi.fn(),
  createMcpServer: vi.fn(),
  updateMcpServer: vi.fn(),
  deleteMcpServer: vi.fn(),
  listMcpTools: vi.fn(),
  probeMcpServer: vi.fn(),
}));

afterEach(cleanup);

beforeEach(() => {
  resetTestState();
  vi.mocked(listMcpServers).mockReset().mockResolvedValue([]);
  vi.mocked(createMcpServer).mockReset().mockResolvedValue(undefined as unknown as McpServerRecord);
  vi.mocked(updateMcpServer).mockReset().mockResolvedValue(undefined as unknown as McpServerRecord);
  vi.mocked(deleteMcpServer).mockReset().mockResolvedValue(undefined);
  vi.mocked(listMcpTools).mockReset().mockResolvedValue({ tools: [] });
  vi.mocked(probeMcpServer).mockReset().mockResolvedValue({ ok: true, toolCount: 0, ms: 0 });
});

function serverFactory(m: Partial<McpServerRecord> & { id: string; name: string }): McpServerRecord {
  return {
    ...m,
    command: m.command ?? "npx",
    args: m.args ?? [],
    env: m.env ?? {},
    enabled: m.enabled ?? true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const SERVERS: McpServerRecord[] = [
  serverFactory({
    id: "mcp_1",
    name: "filesystem",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    enabled: true,
  }),
  serverFactory({
    id: "mcp_2",
    name: "demo",
    command: "node",
    args: ["demo.js"],
    enabled: false,
  }),
];

describe("McpTab (ROUND-61 R61-2-a)", () => {
  it("renders the loading state, then the rows (loading → data flow)", async () => {
    vi.mocked(listMcpServers).mockResolvedValue(SERVERS);
    renderWithProviders(<McpTab />);

    expect(screen.getByText("loading MCP servers…")).toBeTruthy();
    expect(await screen.findByText("filesystem")).toBeTruthy();
    expect(screen.getByText("demo")).toBeTruthy();
    expect(screen.queryByText("loading MCP servers…")).toBeNull();
  });

  it("renders rows with the mono command line, args chip, and switch state", async () => {
    vi.mocked(listMcpServers).mockResolvedValue(SERVERS);
    renderWithProviders(<McpTab />);

    expect(await screen.findByText("filesystem")).toBeTruthy();
    // The command line renders as one clamped mono line.
    expect(
      screen.getByText("npx -y @modelcontextprotocol/server-filesystem /tmp"),
    ).toBeTruthy();
    expect(screen.getByText("node demo.js")).toBeTruthy();
    // Args count chips.
    expect(screen.getByText("3 args")).toBeTruthy();
    expect(screen.getByText("1 args")).toBeTruthy();
    // Switch state mirrors the record.
    expect(screen.getByRole("switch", { name: "Toggle server filesystem" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("switch", { name: "Toggle server demo" }).getAttribute("aria-checked")).toBe("false");
  });

  it("renders the empty state when no servers exist", async () => {
    vi.mocked(listMcpServers).mockResolvedValue([]);
    renderWithProviders(<McpTab />);

    expect(await screen.findByText(/No MCP servers configured/)).toBeTruthy();
    // The sanitized-env footer hint is always present.
    expect(
      screen.getByText(/no ACUTE credentials ever reach an MCP server/),
    ).toBeTruthy();
  });

  it("flips the enabled Switch → updateMcpServer(id, {enabled}) + refetch", async () => {
    vi.mocked(listMcpServers).mockResolvedValue(SERVERS);
    renderWithProviders(<McpTab />);

    await screen.findByText("demo");
    fireEvent.click(screen.getByRole("switch", { name: "Toggle server demo" }));
    await waitFor(() => expect(updateMcpServer).toHaveBeenCalledWith("mcp_2", { enabled: true }));
    await waitFor(() => expect(listMcpServers).toHaveBeenCalledTimes(2));
  });

  it("probes a server and renders the green reachable chip", async () => {
    vi.mocked(listMcpServers).mockResolvedValue(SERVERS);
    vi.mocked(probeMcpServer).mockResolvedValue({ ok: true, toolCount: 3, ms: 42 });
    renderWithProviders(<McpTab />);

    await screen.findByText("filesystem");
    fireEvent.click(screen.getByRole("button", { name: "Probe server filesystem" }));
    await waitFor(() => expect(probeMcpServer).toHaveBeenCalledWith("mcp_1"));
    expect(await screen.findByTestId("probe-result-mcp_1")).toBeTruthy();
    expect(screen.getByText("reachable · 3 tools · 42ms")).toBeTruthy();
  });

  it("renders the server's error when the probe fails", async () => {
    vi.mocked(listMcpServers).mockResolvedValue(SERVERS);
    vi.mocked(probeMcpServer).mockResolvedValue({ ok: false, error: "spawn npx ENOENT" });
    renderWithProviders(<McpTab />);

    await screen.findByText("filesystem");
    fireEvent.click(screen.getByRole("button", { name: "Probe server filesystem" }));
    expect(await screen.findByText("spawn npx ENOENT")).toBeTruthy();
  });

  it("expands the tools panel → listMcpTools(id) rows render", async () => {
    vi.mocked(listMcpServers).mockResolvedValue(SERVERS);
    vi.mocked(listMcpTools).mockResolvedValue({
      tools: [
        {
          name: "echo",
          description: "Echo a message back.",
          inputSchema: {},
        },
        {
          name: "read_file",
          description: "Read a file's contents.",
          inputSchema: {},
        },
      ],
    });
    renderWithProviders(<McpTab />);

    await screen.findByText("filesystem");
    // Nothing is fetched while collapsed.
    expect(listMcpTools).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Show tools for server filesystem" }));
    await waitFor(() => expect(listMcpTools).toHaveBeenCalledWith("mcp_1"));
    expect(await screen.findByText("echo")).toBeTruthy();
    expect(screen.getByText("Read a file's contents.")).toBeTruthy();
    expect(screen.getByText("Echo a message back.")).toBeTruthy();
  });

  it("shows the server's error inside the tools panel when listing fails", async () => {
    vi.mocked(listMcpServers).mockResolvedValue(SERVERS);
    vi.mocked(listMcpTools).mockResolvedValue({
      tools: [],
      error: "server not running — enable it and probe again",
    });
    renderWithProviders(<McpTab />);

    await screen.findByText("filesystem");
    fireEvent.click(screen.getByRole("button", { name: "Show tools for server filesystem" }));
    expect(
      await screen.findByText("server not running — enable it and probe again"),
    ).toBeTruthy();
  });

  it("deletes a server via the two-step confirm (child process killed) and refetches", async () => {
    vi.mocked(listMcpServers).mockResolvedValue(SERVERS);
    renderWithProviders(<McpTab />);

    await screen.findByText("filesystem");
    fireEvent.click(screen.getByRole("button", { name: "Delete server filesystem" }));
    // Two-step: the honest warning shows BEFORE anything is sent.
    const confirmRow = screen.getByTestId("confirm-delete-mcp_1");
    expect(confirmRow.textContent).toContain("Stop and remove this MCP server?");
    expect(confirmRow.textContent).toContain("The child process is killed.");
    expect(deleteMcpServer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete server filesystem" }));
    await waitFor(() => expect(deleteMcpServer).toHaveBeenCalledWith("mcp_1"));
    await waitFor(() => expect(listMcpServers).toHaveBeenCalledTimes(2));
  });

  it("creates a server from the form (args + env parsed) and refetches", async () => {
    vi.mocked(listMcpServers).mockResolvedValue([]);
    renderWithProviders(<McpTab />);

    await screen.findByText(/No MCP servers configured/);
    fireEvent.click(screen.getByRole("button", { name: "Add server" }));
    fireEvent.change(screen.getByLabelText("New server name"), { target: { value: "filesystem" } });
    fireEvent.change(screen.getByLabelText("New server command"), { target: { value: "npx" } });
    fireEvent.change(screen.getByLabelText("New server args"), {
      target: { value: "-y @modelcontextprotocol/server-filesystem, /tmp" },
    });
    fireEvent.change(screen.getByLabelText("New server env"), {
      target: { value: "API_TOKEN=abc123\n# a comment with no equals sign" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create server" }));
    await waitFor(() =>
      expect(createMcpServer).toHaveBeenCalledWith({
        name: "filesystem",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        env: { API_TOKEN: "abc123" },
        enabled: true,
      }),
    );
    await waitFor(() => expect(listMcpServers).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId("add-server-form")).toBeNull());
  });

  it("surfaces the ApiError message inline when the create is rejected", async () => {
    vi.mocked(listMcpServers).mockResolvedValue([]);
    vi.mocked(createMcpServer).mockRejectedValue(
      new Error("mcp server 'filesystem' already exists — names must be unique"),
    );
    renderWithProviders(<McpTab />);

    await screen.findByText(/No MCP servers configured/);
    fireEvent.click(screen.getByRole("button", { name: "Add server" }));
    fireEvent.change(screen.getByLabelText("New server name"), { target: { value: "filesystem" } });
    fireEvent.change(screen.getByLabelText("New server command"), { target: { value: "npx" } });
    fireEvent.click(screen.getByRole("button", { name: "Create server" }));
    expect(await screen.findByTestId("add-server-error")).toBeTruthy();
    expect(screen.getByText(/mcp server 'filesystem' already exists/)).toBeTruthy();
    // The form stays open for a fix.
    expect(screen.getByTestId("add-server-form")).toBeTruthy();
  });

  it("shows the load-error hint when the sidecar fails", async () => {
    vi.mocked(listMcpServers).mockRejectedValue(new Error("sidecar down"));
    renderWithProviders(<McpTab />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Agent core unreachable");
    expect(alert.textContent).toContain("to manage MCP servers.");
  });
});
