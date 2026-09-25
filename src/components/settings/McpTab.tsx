import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ListTree, PlugZap, Plus, Trash2, Zap } from "lucide-react";
import { useTimeoutClear } from "../../hooks/use-timeout-clear";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { isTauri } from "../../lib/sidecar";
import { ClampedText } from "../shared/ClampedText";
// R100-E2: the round-100 primitives (USAGE.md §3).
import { Kicker } from "../ui/Kicker";
import { SectionCard } from "../ui/SectionCard";
import { ToggleSwitch } from "../ui/toggle-switch"; // R93-A4: the shared contrast-aware switch
import {
  createMcpServer,
  deleteMcpServer,
  listMcpServers,
  listMcpTools,
  probeMcpServer,
  updateMcpServer,
  type McpServerRecord,
} from "../../lib/api";

/**
 * McpTab — ROUND-61 (R61-2-a): the owner's "ability to add MCP servers too"
 * — the settings surface for the MCP store (GET/POST /mcp, PATCH/DELETE
 * /mcp/:id, GET /mcp/:id/tools, POST /mcp/:id/probe).
 *
 * Design mirrors SubAgentsTab (R58-d): one max-w-2xl column, section card
 * with the theme system, useQuery/useMutation + queryClient invalidation,
 * useTimeoutClear toasts, and the mode-aware coreUnreachableHint for load
 * errors. The api module is the ONLY backend surface touched here.
 */
const coreUnreachableHint = isTauri()
  ? "agent-core is not responding — if the connection banner is showing, use its Restart engine button, then reopen this tab."
  : "Agent core unreachable — start the app (or pnpm dev:full).";

/** "npx  -y,@model/context server" → ["npx","-y","@model/context","server"]. */
function parseArgs(text: string): string[] {
  return text.split(/[\s,]+/).filter(Boolean);
}

/** KEY=VALUE lines → Record (the first "=" splits; junk lines are dropped). */
function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
  }
  return env;
}

/* ── One server row ────────────────────────────────────────────────────────── */

function McpServerRow({
  server,
  onNote,
  invalidate,
  onToggle,
}: {
  server: McpServerRecord;
  /** Card-level toast (delete success etc.). */
  onNote: (text: string, isError?: boolean) => void;
  invalidate: () => void;
  /** The enabled PATCH — owned by the parent card (one shared mutation). */
  onToggle: (id: string, enabled: boolean) => void;
}) {
  const styles = useThemeStyles();
  const [toolsOpen, setToolsOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  const probe = useMutation({
    mutationFn: () => probeMcpServer(server.id),
    onSuccess: () => setRowError(null),
    onError: (err: Error) => setRowError(err.message),
  });

  // The tool listing fetches ONLY while expanded (enabled gate).
  const toolsQuery = useQuery({
    queryKey: ["mcp-tools", server.id],
    queryFn: () => listMcpTools(server.id),
    enabled: toolsOpen,
  });

  const remove = useMutation({
    mutationFn: () => deleteMcpServer(server.id),
    onSuccess: () => {
      onNote("Server removed.");
      invalidate();
    },
    onError: (err: Error) => {
      setConfirmDelete(false);
      setRowError(err.message);
    },
  });

  const envCount = Object.keys(server.env ?? {}).length;
  const probeResult = probe.data;

  return (
    <div
      data-mcp-server={server.id}
      /* R126-3f-3: the row hairline on the class leg. */
      className="border-b border-line last:border-b-0"
    >
      <div className="flex items-center gap-2 px-3 py-2 flex-wrap">
        <span
          className="font-mono text-[12px] font-medium min-w-0 truncate"
          style={{ color: styles.text }}
          title={server.name}
        >
          {server.name}
        </span>
        <span
          className="text-[10px] font-medium uppercase tracking-wider rounded-full px-1.5 py-0.5 shrink-0 bg-badge-neutral text-badge-neutral-fg"
          title={
            envCount > 0
              ? `${server.args.length} args · ${envCount} env vars (sanitized before launch)`
              : `${server.args.length} args`
          }
        >
          {server.args.length === 0 ? "no args" : `${server.args.length} args`}
        </span>
        <span className="flex-1" />
        <button
          onClick={() => probe.mutate()}
          disabled={probe.isPending}
          aria-label={`Probe server ${server.name}`}
          title="Probe: spawn the server and list its tools"
          /* R126-3f-3: the accent-tint action spelling. */
          className="h-7 px-2.5 rounded-lg text-[11px] font-semibold shrink-0 flex items-center gap-1 bg-accent-tint text-accent-deep transition-colors duration-100 hover:bg-hover active:scale-[0.98] disabled:opacity-50"
        >
          <Zap size={11} strokeWidth={2.5} /> {probe.isPending ? "Probing…" : "Probe"}
        </button>
        <button
          onClick={() => setToolsOpen((v) => !v)}
          aria-label={`Show tools for server ${server.name}`}
          aria-expanded={toolsOpen}
          title={toolsOpen ? "Hide the tool listing" : "List this server's tools"}
          className={`h-7 px-2.5 rounded-lg text-[11px] font-semibold shrink-0 flex items-center gap-1 transition-colors duration-100 ${
            toolsOpen ? "bg-accent-tint text-accent-deep" : "border border-clay-rim bg-well text-muted"
          } hover:bg-hover`}
        >
          <ListTree size={11} /> Tools
        </button>
        <button
          onClick={() => setConfirmDelete((v) => !v)}
          aria-label={`Delete server ${server.name}`}
          title="Stop and remove this server"
          /* R100-E2: the JS hover-red pair retired — the standard
             hover:bg-hover wash (TOKENS.md §6). R126-3f-3: the armed state
             rides the §11 danger-deep ink. */
          className="w-6 h-6 grid place-items-center rounded-lg shrink-0 transition-colors hover:bg-hover cursor-pointer"
          style={{ color: confirmDelete ? styles.dangerDeep : styles.textTertiary }}
        >
          <Trash2 size={11} />
        </button>
        <ToggleSwitch
          checked={server.enabled}
          onToggle={() => onToggle(server.id, !server.enabled)}
          label={`Toggle server ${server.name}`}
          title={server.enabled ? "Disable this server" : "Enable this server"}
        />
      </div>
      <div className="px-3 pb-2 pl-3 min-w-0">
        <ClampedText
          text={[server.command, ...server.args].join(" ")}
          lines={1}
          className="font-mono text-[11px]"
          style={{ color: styles.textSecondary }}
        />
      </div>
      {probeResult && (
        <div className="px-3 pb-2" data-testid={`probe-result-${server.id}`}>
          {probeResult.ok ? (
            <span
              className="text-[11px] font-medium rounded-full px-2 py-0.5 bg-badge-success text-badge-success-fg tabular-nums"
            >
              reachable · {probeResult.toolCount ?? "?"} tools · {probeResult.ms ?? "?"}ms
            </span>
          ) : (
            <span
              className="text-[11px] font-medium text-danger-deep"
              role="alert"
            >
              {probeResult.error ?? "probe failed"}
            </span>
          )}
        </div>
      )}
      {toolsOpen && (
        <div
          className="px-3 pb-3 border-t border-line"
          data-testid={`tools-panel-${server.id}`}
        >
          <div className="text-[11px] font-medium uppercase tracking-wider mt-2 mb-1" style={{ color: styles.textTertiary }}>
            mcp__{server.name}__* tools
          </div>
          {toolsQuery.isLoading ? (
            <span className="text-[11px] font-mono" style={{ color: styles.textTertiary }}>
              listing tools…
            </span>
          ) : toolsQuery.isError ? (
            <p className="text-[11px] text-danger-deep" role="alert">
              {toolsQuery.error instanceof Error
                ? toolsQuery.error.message
                : String(toolsQuery.error)}
            </p>
          ) : toolsQuery.data?.error ? (
            <p className="text-[11px] text-danger-deep" role="alert">
              {toolsQuery.data.error}
            </p>
          ) : (toolsQuery.data?.tools ?? []).length === 0 ? (
            <span className="text-[11px]" style={{ color: styles.textTertiary }}>
              No tools listed (the server may be disabled or not started yet).
            </span>
          ) : (
            <div
              /* R126-3f-3: the rim hairline container (TOKENS §5). */
              className="rounded-lg border border-clay-rim overflow-hidden max-h-56 overflow-y-auto"
            >
              {toolsQuery.data?.tools.map((t) => (
                <div
                  key={t.name}
                  className="px-2.5 py-1.5 border-b border-line last:border-b-0"
                >
                  <div className="font-mono text-[11px] font-medium truncate" style={{ color: styles.text }}>
                    {t.name}
                  </div>
                  {t.description && (
                    <div className="text-[11px]" style={{ color: styles.textSecondary }}>
                      {t.description}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {confirmDelete && (
        <div
          className="flex items-center gap-2 px-3 pb-2 flex-wrap"
          data-testid={`confirm-delete-${server.id}`}
        >
          <span className="text-[11px] font-medium text-danger-deep">
            Stop and remove this MCP server? The child process is killed.
          </span>
          <button
            onClick={() => remove.mutate()}
            disabled={remove.isPending}
            aria-label={`Confirm delete server ${server.name}`}
            /* R126-3f-3: the outlined danger action. */
            className="h-7 px-2.5 rounded-lg text-[11px] font-semibold shrink-0 border border-danger-deep text-danger-deep transition-colors duration-100 hover:bg-hover active:scale-[0.98] disabled:opacity-50"
          >
            {remove.isPending ? "Removing…" : "Remove"}
          </button>
          <button
            onClick={() => setConfirmDelete(false)}
            aria-label={`Cancel delete server ${server.name}`}
            className="h-7 px-2.5 rounded-lg text-[11px] font-semibold shrink-0 border border-clay-rim bg-well text-muted transition-colors duration-100 hover:bg-hover"
          >
            Cancel
          </button>
        </div>
      )}
      {rowError && (
        <p
          className="px-3 pb-2 text-[11px] font-medium text-danger-deep"
          role="alert"
          data-testid={`row-error-${server.id}`}
        >
          {rowError}
        </p>
      )}
    </div>
  );
}

/* ── The add-server form ───────────────────────────────────────────────────── */

function AddServerForm({ onDone }: { onDone: () => void }) {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      createMcpServer({
        name: name.trim(),
        command: command.trim(),
        args: parseArgs(args),
        env: parseEnv(env),
        enabled: true,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
      onDone();
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div
      /* R126-3f-3: the add-form region = the well recess (TOKENS §10). */
      className="flex flex-col gap-2.5 px-3 py-3 border-t border-line bg-well"
      data-testid="add-server-form"
    >
      <div>
        <label
          className="mb-1 block text-[11px] font-medium"
          style={{ color: styles.textSecondary }}
          htmlFor="new-mcp-name"
        >
          Name (slug — tools appear as mcp__name__tool)
        </label>
        <input
          id="new-mcp-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. filesystem"
          aria-label="New server name"
          /* R126-3f-3: THE WELL + rim (TOKENS §10) — the form inputs. */
          className="h-8 w-full rounded-lg border border-clay-rim bg-card px-2.5 font-mono text-[12px] text-ink outline-none"
        />
      </div>
      <div>
        <label
          className="mb-1 block text-[11px] font-medium"
          style={{ color: styles.textSecondary }}
          htmlFor="new-mcp-command"
        >
          Command
        </label>
        <input
          id="new-mcp-command"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="e.g. npx"
          aria-label="New server command"
          className="h-8 w-full rounded-lg border border-clay-rim bg-card px-2.5 font-mono text-[12px] text-ink outline-none"
        />
      </div>
      <div>
        <label
          className="mb-1 block text-[11px] font-medium"
          style={{ color: styles.textSecondary }}
          htmlFor="new-mcp-args"
        >
          Args (comma or space separated)
        </label>
        <input
          id="new-mcp-args"
          value={args}
          onChange={(e) => setArgs(e.target.value)}
          placeholder="e.g. -y @modelcontextprotocol/server-filesystem /tmp"
          aria-label="New server args"
          className="h-8 w-full rounded-lg border border-clay-rim bg-card px-2.5 font-mono text-[12px] text-ink outline-none"
        />
      </div>
      <div>
        <label
          className="mb-1 block text-[11px] font-medium"
          style={{ color: styles.textSecondary }}
          htmlFor="new-mcp-env"
        >
          Env (one KEY=VALUE per line — sanitized before launch)
        </label>
        <textarea
          id="new-mcp-env"
          value={env}
          onChange={(e) => setEnv(e.target.value)}
          placeholder={"API_TOKEN=abc123\nOTHER_FLAG=1"}
          aria-label="New server env"
          rows={3}
          className="w-full rounded-lg border border-clay-rim bg-card px-2.5 py-2 font-mono text-[11px] leading-relaxed text-ink outline-none resize-y"
        />
      </div>
      {error && (
        <p
          className="text-[11px] font-medium text-danger-deep"
          role="alert"
          data-testid="add-server-error"
        >
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <button
          onClick={() => create.mutate()}
          disabled={!name.trim() || !command.trim() || create.isPending}
          aria-label="Create server"
          /* R126-3f-3: the accent-tint action spelling. */
          className="h-8 px-3 rounded-lg text-[11px] font-semibold shrink-0 bg-accent-tint text-accent-deep transition-colors duration-100 hover:bg-hover active:scale-[0.98] disabled:opacity-50"
        >
          {create.isPending ? "Adding…" : "Add server"}
        </button>
        <button
          onClick={onDone}
          aria-label="Cancel add server"
          className="h-8 px-3 rounded-lg text-[11px] font-semibold shrink-0 border border-clay-rim bg-card text-muted transition-colors duration-100 hover:bg-hover"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ── The card ──────────────────────────────────────────────────────────────── */

function McpCard() {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const resetAfter = useTimeoutClear();
  const [msg, setMsg] = useState<string | null>(null);
  const [msgIsError, setMsgIsError] = useState(false);
  const [showAdd, setShowAdd] = useState(false);

  const serversQuery = useQuery({ queryKey: ["mcp-servers"], queryFn: listMcpServers });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
  };

  const note = (text: string, isError = false) => {
    setMsg(text);
    setMsgIsError(isError);
    resetAfter(() => setMsg(null), 1500);
  };

  const toggleEnabled = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      updateMcpServer(id, { enabled }),
    onSuccess: (_data, vars) => {
      note(vars.enabled ? "Server enabled." : "Server disabled.");
      invalidate();
    },
    onError: (err: Error) => note(err.message, true),
  });

  return (
    /* R100-E2: the SectionCard primitive (aria-label passthrough). */
    <SectionCard className="p-4 flex flex-col gap-2.5" ariaLabel="MCP servers">
      <div className="flex items-center gap-2 flex-wrap">
        <PlugZap size={13} className="text-accent-deep" />
        <span className="text-[13px] font-semibold" style={{ color: styles.text }}>
          MCP servers
        </span>
        <span className="flex-1" />
        {msg && (
          <span
            className={`text-[11px] font-medium ${
              msgIsError ? "text-danger-deep" : "text-success-deep"
            }`}
          >
            {msg}
          </span>
        )}
        <button
          onClick={() => setShowAdd((v) => !v)}
          aria-label="Add server"
          title="Add an MCP server"
          /* R126-3f-3: the accent-tint action spelling. */
          className="h-8 px-3 rounded-lg text-[11px] font-semibold shrink-0 flex items-center gap-1 bg-accent-tint text-accent-deep transition-colors duration-100 hover:bg-hover active:scale-[0.98]"
        >
          <Plus size={11} strokeWidth={2.5} /> Add server
        </button>
      </div>
      <p className="text-[11px] leading-relaxed" style={{ color: styles.textSecondary }}>
        External tool servers (stdio MCP). Their tools join the agent's toolset as{" "}
        <span className="font-mono" style={{ color: styles.text }}>
          mcp__&lt;server&gt;__&lt;tool&gt;
        </span>{" "}
        while enabled.
      </p>

      {serversQuery.isError ? (
        <p className="text-[11px] text-danger-deep" role="alert">
          {coreUnreachableHint} to manage MCP servers.
        </p>
      ) : serversQuery.isLoading || serversQuery.data === undefined ? (
        <span className="text-[12px] font-mono" style={{ color: styles.textTertiary }}>
          loading MCP servers…
        </span>
      ) : (
        <>
          <div
            /* R126-3f-3: the rim hairline container (TOKENS §5). */
            className="rounded-lg border border-clay-rim overflow-hidden"
          >
            {serversQuery.data.length === 0 && (
              <div className="px-3 py-2.5 text-[11px]" style={{ color: styles.textTertiary }}>
                No MCP servers configured — add one below; its tools join the agent toolset while
                enabled.
              </div>
            )}
            {serversQuery.data.map((srv) => (
              <McpServerRow
                key={srv.id}
                server={srv}
                onNote={note}
                invalidate={invalidate}
                onToggle={(id, enabled) => toggleEnabled.mutate({ id, enabled })}
              />
            ))}
          </div>
          {showAdd && <AddServerForm onDone={() => setShowAdd(false)} />}
        </>
      )}
      <p className="text-[11px]" style={{ color: styles.textTertiary }}>
        Commands run as child processes of the engine. The env passed to them is sanitized — no
        ACUTE credentials ever reach an MCP server.
      </p>
    </SectionCard>
  );
}

/* ── Composition ──────────────────────────────────────────────────────────── */

/** The dedicated MCP servers settings tab (?tab=mcp). */
export function McpTab() {
  const styles = useThemeStyles();
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <div className="pb-1">
        {/* R100-E2: the tab-intro header snapped to the E1 grammar. */}
        <Kicker className="mb-1">Integrations</Kicker>
        <h2 className="text-[13px] font-semibold text-ink">MCP servers</h2>
        <p className="mt-1 text-[12px]" style={{ color: styles.textSecondary }}>
          External tool servers (stdio MCP) — their tools join the agent's toolset as
          mcp__&lt;server&gt;__&lt;tool&gt; while enabled.
        </p>
      </div>
      <McpCard />
    </div>
  );
}

export default McpTab;
