/**
 * config.ts — the typed clients for EVERYTHING the phone manages (R109:
 * "From the Android application I should be able to configure the models
 * and providers, configure all the settings like the agents, the prompts,
 * see the dashboard, the stats, the usage").
 *
 * Every shape here is the desktop's EXISTING /api/v1 surface, typed 1:1
 * with the routes the owner's UI already speaks — the phone rides the same
 * wall with the same device token, no new desktop routes needed. HTTP
 * errors are VALUES (ApiOutcome); transport throws stay the screens' truth
 * (the link manager already transitioned offline).
 *
 * SECURITY NOTE (the R109 desktop hardening pairs with this): the phone's
 * UI deliberately exposes NO path to /providers/:id/keys/reveal,
 * /system/reset, terminal input, or computer-use — those routes carry a
 * device-token blocklist on the desktop side.
 */

import { apiJson, apiJsonNoBody, type ApiOutcome, type ApiSender } from "./api";
import { mobLog } from "@/lib/log";

// ── the wire shapes ─────────────────────────────────────────────────────────

export interface ProjectRow {
  id: string;
  name: string;
  rootPath: string;
  color: string;
  createdAt: string;
}

export interface ProviderRow {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  apiFormat?: string;
  enabled: boolean;
  createdAt: string;
  hasKey: boolean;
  keyCount: number;
  /** R113-e: the SERVER's configured bit (R113-a — custom row OR any held
   * key, pool-aware). The providers screen splits configured-first off
   * exactly this flag (the desktop's R113-d structure); undefined = an
   * older sidecar — treated as unconfigured (the honest pre-split read). */
  configured?: boolean;
}

export interface ModelSummary {
  id: string;
  name: string;
  /** R95-b/R114-f: the DETECTED reasoning capability — an OBJECT
   * ({supported, efforts, defaultEffort?}), exactly the registry's
   * ModelReasoningSupport (the old `boolean` read here was never the wire
   * shape). Absent = the catalog said nothing (unknown). */
  reasoningSupport?: { supported: boolean; efforts: string[]; defaultEffort?: string };
}

export interface ModelRecord {
  id: string;
  providerId: string;
  modelId: string;
  displayName: string | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  inputPricePerMtok: number | null;
  inputPriceCachedPerMtok: number | null;
  outputPricePerMtok: number | null;
  supportsThinking: boolean | null;
  supportsVision: boolean | null;
  supportsTools: boolean | null;
  /** R116-j: the R82/R87 tri-state capability columns the wire has always
   * returned (storage/models.ts toModel) — the edit sheet finally owns
   * them. null = unknown (never set), false = off, true = on. */
  supportsAudio: boolean | null;
  supportsVideo: boolean | null;
  supportsPdf: boolean | null;
  supportsTextOutput: boolean | null;
  supportsImageOutput: boolean | null;
  supportsVideoOutput: boolean | null;
  supportsAudioOutput: boolean | null;
  sizeLabel: string | null;
  reasoningSupport: { supported: boolean; efforts: string[]; defaultEffort?: string } | null;
  hidden: boolean;
  createdAt: string;
}

export interface AgentRow {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
  providerId: string | null;
  model: string | null;
  visionModel: string | null;
  allowedTools: string[];
  memoryPolicy: string;
  skills: string[];
  maxTurns: number;
  maxOuterLoops: number;
  temperature: number;
  isTemplate: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface PromptSectionView {
  id: string;
  description: string;
  dynamic: boolean;
  bucket: string;
  overridden?: boolean;
  overrideContent: string | null;
  defaultText: string | null;
}

export interface PromptsSectionsResponse {
  rootPath: string;
  sections: PromptSectionView[];
  overridden: number;
  effectiveOrder: string[];
  diagnostics: unknown[];
}

export interface UsageDayBucket {
  date: string;
  inputTokens: number;
  outputTokens: number;
  requests: number;
  costUsd: number;
}

export interface UsageSummary {
  days: UsageDayBucket[];
  totals: { inputTokens: number; outputTokens: number; requests: number; costUsd: number };
  generatedAt: string;
}

export interface UsageStatsModel {
  model: string;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  costUsd: number;
  calls: number;
  requests: number;
  providers: string[];
}

export interface UsageStatsHealth {
  turnErrors: { name: string; count: number }[];
  toolFailures: { name: string; count: number }[];
}

export interface UsageStats {
  months: number;
  totals: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
    requests: number;
    providerCalls: number;
  };
  peak: { date: string | null; tokens: number };
  series: { date: string; byModel: Record<string, number> }[];
  models: UsageStatsModel[];
  health: UsageStatsHealth;
  generatedAt: string;
}

// ── detailed usage (R116-g: GET /usage/detailed — the whole-history drill-
// down; typed 1:1 with agent-core storage/usage.ts so the wire is the
// contract, ids/titles/roles raw — this link is the private bearer loopback) ──

/** Token triplet shared by every detailed-usage aggregate. */
export interface DetailedUsageTokens {
  input: number;
  output: number;
  cached: number;
}

/** One tool's call volume + failure count (from session_events tool.use). */
export interface DetailedUsageToolCall {
  tool: string;
  count: number;
  failures: number;
}

/** Per-model aggregate (usage_events grouped by session × model, re-summed). */
export interface DetailedUsageModel {
  model: string;
  calls: number;
  tokens: DetailedUsageTokens;
  costUsd: number;
  /** The real SDK-call count ("requests" fields count TURNS/rows — R83). */
  providerCalls: number;
  /** False when every pricing row that served this model is unknown on both
   * sides — the honest "$0.00 (unpriced)" flag (R83). */
  costKnown: boolean;
}

/** One provider key-pool slot's whole-history usage rollup (R64-e). */
export interface DetailedUsageKey {
  providerId: string;
  /** 0 = primary key; N ≥ 2 = pool slot N. */
  keySlot: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** ISO ts of the slot's latest recorded call (MAX(ts)). */
  lastUsedAt: string;
}

/** A chat session (or a sub-agent child) row in the projects drill-down. */
export interface DetailedUsageSession {
  id: string;
  title: string;
  status: string;
  /** Dominant model (highest input+output tokens across its usage rows). */
  model: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number;
  tokens: DetailedUsageTokens;
  costUsd: number;
  requests: number;
  /** The real SDK-call count ("requests" above = turns — R83). */
  providerCalls: number;
  toolCalls: DetailedUsageToolCall[];
  toolCallCount: number;
  /** How many sub-agent children this session delegated (parent rows). */
  subagentCount: number;
  /** True when the row is a delegate_task child (parent_session_id set). */
  isSubagent: boolean;
  /** The delegating parent session's id (null for main sessions). */
  parentId: string | null;
  /** The delegated role (planner/researcher/coder/…), null on main sessions. */
  role: string | null;
}

export interface DetailedUsageProject {
  id: string;
  name: string;
  color: string;
  /** True for the synthetic "Unassigned sessions" bucket (no project row). */
  synthetic: boolean;
  /** Main (non-sub-agent) session count — what the section header shows. */
  sessionCount: number;
  firstActivity: string | null;
  lastActivity: string | null;
  totals: {
    sessions: number;
    subagents: number;
    toolCalls: number;
    requests: number;
    costUsd: number;
    tokens: DetailedUsageTokens;
  };
  toolCalls: DetailedUsageToolCall[];
  /** Sub-agent-only rollup nested inside the project totals. */
  subagents: {
    count: number;
    toolCalls: number;
    requests: number;
    tokens: DetailedUsageTokens;
    costUsd: number;
  };
  models: DetailedUsageModel[];
  /** Main + sub-agent children, newest-first (children nest by parentId). */
  sessions: DetailedUsageSession[];
}

export interface DetailedUsageTotals {
  projects: number;
  sessions: number;
  subagentSessions: number;
  toolCalls: number;
  requests: number;
  /** The real SDK-call count ("requests" above = turns — R83). */
  providerCalls: number;
  tokens: DetailedUsageTokens;
  costUsd: number;
}

export interface DetailedUsage {
  /** Windowed, zero-filled, ascending (getUsageSummary's series). */
  days: UsageDayBucket[];
  /** Whole-history rollups — the drill-down's totals/leaderboards. */
  totals: DetailedUsageTotals;
  tools: DetailedUsageToolCall[];
  models: DetailedUsageModel[];
  /** Per-key (provider × pool slot) rollups, cost-desc (R64-e). */
  keys: DetailedUsageKey[];
  projects: DetailedUsageProject[];
  generatedAt: string;
}

export interface SessionCreateResponse {
  id: string;
  projectId: string | null;
  agentId: string;
  mode: string;
  status: string;
  title: string;
  createdAt: string;
}

// ── projects ────────────────────────────────────────────────────────────────

export function fetchProjects(sender: ApiSender): Promise<ApiOutcome<{ projects: ProjectRow[] }>> {
  return apiJson<{ projects: ProjectRow[] }>(sender, "/projects");
}

/** GET /projects/:id — the project detail screen's own row (name + root
 * + color, straight from the registry). */
export function fetchProject(sender: ApiSender, id: string): Promise<ApiOutcome<ProjectRow>> {
  return apiJson<ProjectRow>(sender, `/projects/${encodeURIComponent(id)}`);
}

/**
 * The POST /projects body — name + an absolute root path, both trimmed;
 * null when either is empty (the route's own validation would 400 — the
 * new-project sheet refuses earlier, honestly). Color rides only when set
 * (a #rrggbb string; the server picks its own otherwise). Pure.
 */
export function newProjectBody(
  name: string,
  rootPath: string,
  color?: string,
): { name: string; rootPath: string; color?: string } | null {
  const trimmedName = name.trim();
  const trimmedRoot = rootPath.trim();
  if (trimmedName === "" || trimmedRoot === "") return null;
  return {
    name: trimmedName,
    rootPath: trimmedRoot,
    ...(color !== undefined && color !== "" ? { color } : {}),
  };
}

export function createProject(
  sender: ApiSender,
  body: { name: string; rootPath: string; color?: string },
): Promise<ApiOutcome<ProjectRow>> {
  return apiJson<ProjectRow>(sender, "/projects", {
    method: "POST",
    bodyText: JSON.stringify(body),
  });
}

// ── sessions (creation — the lists live in features/sessions.ts) ────────────

export function createSession(
  sender: ApiSender,
  body: { mode: "single"; agentId: string; title?: string; projectId?: string },
): Promise<ApiOutcome<SessionCreateResponse>> {
  return apiJson<SessionCreateResponse>(sender, "/sessions", {
    method: "POST",
    bodyText: JSON.stringify(body),
  });
}

// ── agents ──────────────────────────────────────────────────────────────────

export function fetchAgents(sender: ApiSender): Promise<ApiOutcome<{ agents: AgentRow[] }>> {
  return apiJson<{ agents: AgentRow[] }>(sender, "/agents");
}

export function updateAgent(
  sender: ApiSender,
  id: string,
  body: Partial<Pick<AgentRow, "name" | "role" | "systemPrompt" | "providerId" | "model" | "visionModel" | "maxTurns" | "temperature">>,
): Promise<ApiOutcome<AgentRow>> {
  return apiJson<AgentRow>(sender, `/agents/${encodeURIComponent(id)}`, {
    method: "PATCH",
    bodyText: JSON.stringify(body),
  });
}

// ── providers ───────────────────────────────────────────────────────────────

export function fetchProviders(sender: ApiSender): Promise<ApiOutcome<{ providers: ProviderRow[] }>> {
  return apiJson<{ providers: ProviderRow[] }>(sender, "/providers");
}

/**
 * R113-e: the providers screen's two-tier derivation (the desktop R113-d
 * structure, ported): the SERVER's `configured` bit (R113-a — custom row OR
 * any held key, pool-aware) splits the rows into "Your providers" (the
 * owner's inventory) first + the addable catalog below. `configured ===
 * undefined` (an older sidecar predating the flag) reads UNCONFIGURED — the
 * honest pre-split fallback, same verdict the screen renders. Order is
 * preserved within each tier (the route's created order). Pure.
 */
export function splitProviders(
  providers: ProviderRow[],
): { configured: ProviderRow[]; addable: ProviderRow[] } {
  return {
    configured: providers.filter((p) => p.configured === true),
    addable: providers.filter((p) => p.configured !== true),
  };
}

export function updateProvider(
  sender: ApiSender,
  id: string,
  body: { name?: string; baseUrl?: string; apiFormat?: string; enabled?: boolean },
): Promise<ApiOutcome<ProviderRow>> {
  return apiJson<ProviderRow>(sender, `/providers/${encodeURIComponent(id)}`, {
    method: "PATCH",
    bodyText: JSON.stringify(body),
  });
}

// ── providers: the R114-f management surface ────────────────────────────────
//
// The phone's Models & Providers replica: custom provider creation, the key
// POOL (masked slots — add/remove/test per slot), the per-provider SAVED
// model rows (models-config — the DB truth, never the live catalog), the
// add-model upsert, model edit/hide/delete, and the per-model completion
// probe. Every shape below was read off agent-core/src/routes/providers.ts +
// models.ts (the R114-d wire-verification discipline): no guessed fields.

/** GET /providers/:id/keys — one masked pool slot (slot 0 = the primary).
 * The VALUE never rides this shape (poolInfo masks `abcd…wxyz`); the phone
 * deliberately has no path to /providers/:id/keys/reveal. */
export interface ProviderKeySlot {
  slot: number;
  hasKey: boolean;
  masked: string | null;
  /** R118-E: the slot's last successful USE (ISO timestamp) — the OPTIONAL
   * pool-route interlock. An older sidecar omits it entirely; the key row's
   * meta line degrades to the mask-only spelling (provider-display.ts's
   * keySlotMetaLine owns that honesty). */
  lastUsedAt?: string | null;
}

/** The live catalog entry (GET /providers/:id/models — the provider's own
 * /models listing; ModelSummary above). Context/pricing/vision are NOT
 * here — those come from the static catalog (CatalogModelEntry) at prefill
 * time. */

/** GET /models/catalog — one static catalog row (the desktop's
 * ModelsProvidersTab CatalogModel, verbatim fields). */
export interface CatalogModelEntry {
  modelId: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number | null;
  inputPricePerMtok: number;
  inputPriceCachedPerMtok: number | null;
  outputPricePerMtok: number;
  free: boolean;
  supportsTools: boolean;
  supportsStructuredOutputs: boolean;
  supportsVision: boolean;
}

export interface ModelCatalogResponse {
  models: CatalogModelEntry[];
  defaultModelId: string;
  subagentDefaultModelId: string;
  recommendedModelIds: string[];
}

/** POST /models/:id/test — the real 64-token completion probe (R82). A probe
 * that RAN and got a NO is HTTP 200 {ok:false} — a successful test call.
 * R119-P: after the pong phase passes, the probe runs a SECOND tool-carrying
 * call (the agent's real shape — the owner's TokenHarbor report: chat worked
 * while every agent action failed); the tools legs below are ABSENT whenever
 * the pong phase failed first (not-run, never guessed). */
export interface ModelTestResult {
  ok: boolean;
  latencyMs: number;
  providerId: string;
  model: string;
  checks: {
    http: boolean;
    auth: boolean;
    modelAccepted: boolean;
    nonEmptyContent: boolean;
    /** R119-P — present ONLY when the tools leg ran: the provider accepted
     * the tool-carrying request. false (with ok:false + reason) = the
     * TokenHarbor action-failure shape — the provider hard-rejected the
     * tools request. */
    toolsAccepted?: boolean;
    /** R119-P — present when the tools leg ran AND was accepted: the reply
     * contained a well-formed echo tool call. false = the model answered in
     * text instead (see note — chat-only, agent actions will fail). */
    toolCalled?: boolean;
  };
  contentPreview?: string;
  usage?: { inputTokens: number; outputTokens: number };
  reason?: string;
  /** R119-P — present when the tools leg was accepted but the model answered
   * in text: the honest "usable for chat, NOT for agent actions" line. */
  note?: string;
}

/**
 * R119-P — the model-actions sheet's TOOLS-leg verdict line (pure; the
 * sheet renders it as a SECOND note line under the base ok/failed verdict).
 * Three honest spellings, exactly the round-119 §2 Track P wording:
 *   · called            → "tools ✓ (called echo)"                     (good)
 *   · accepted, no call → "tools accepted — answered in text, not
 *                          called — usable for chat, not for agent
 *                          actions"                                    (caution)
 *   · rejected          → "tools rejected — {reason snippet}"         (bad)
 * null = the leg never ran (the pong phase failed first — the base note
 * already tells that story; no second line, never a guess).
 */
export function modelTestToolsLegLine(
  result: Pick<ModelTestResult, "checks" | "reason">,
): { tone: "good" | "caution" | "bad"; text: string } | null {
  // Defensive read: `checks` has ridden every R82+ reply, but a malformed
  // body degrades to not-run (null) — never a crash, never a guess.
  const accepted = result.checks?.toolsAccepted;
  if (accepted === undefined) return null;
  if (!accepted) {
    const snippet = (result.reason ?? "the provider refused the tools request").slice(0, 110);
    const ellipsis = (result.reason ?? "").length > 110 ? "…" : "";
    return { tone: "bad", text: `tools rejected — ${snippet}${ellipsis}` };
  }
  if (result.checks.toolCalled === true) {
    return { tone: "good", text: "tools ✓ (called echo)" };
  }
  return {
    tone: "caution",
    text: "tools accepted — answered in text, not called — usable for chat, not for agent actions",
  };
}

/** The POST /providers apiFormat enum — exactly the three values the route
 * accepts (anything else falls back to chat-completions server-side). */
export type ProviderApiFormat = "chat-completions" | "anthropic-messages" | "responses";

/** The custom-create sheet's body (POST /providers). Null when the name or
 * the base URL is blank after trimming — the sheet refuses honestly before
 * the route 400s; URL VALIDITY stays the server's call (its message shows
 * inline, the New Project sheet's discipline). Pure. */
export function customProviderBody(
  name: string,
  baseUrl: string,
  apiFormat: ProviderApiFormat,
): { name: string; baseUrl: string; apiFormat: ProviderApiFormat } | null {
  const trimmedName = name.trim();
  const trimmedBaseUrl = baseUrl.trim();
  if (trimmedName === "" || trimmedBaseUrl === "") return null;
  return { name: trimmedName, baseUrl: trimmedBaseUrl, apiFormat };
}

/**
 * ── ROUND-120 (why): ── the preset-add sheet's COMMIT PLAN (the owner's
 * round-120 report, §1 C7: tapping OpenAI / NVIDIA / Anthropic / Google /
 * OpenRouter must NOT navigate to the provider page — the add flow happens
 * IN the bottom-up sheet, the custom-providers grammar mirrored for the
 * presets). The key is REQUIRED (the server's `configured` bit flips on a
 * held key — a keyless "add" would leave the row exactly as unconfigured as
 * it started, a lie); the base-URL PATCH rides only when the field drifted
 * from the preset's own URL; a cleared URL is refused honestly before the
 * route 400s (the customProviderBody discipline). Pure (table-tested in
 * __tests__/config.test.ts).
 */
export type PresetAddPlan =
  | { error: string }
  | { baseUrlPatch: string | null; key: string };

export function presetAddPlan(
  provider: Pick<ProviderRow, "baseUrl">,
  baseUrl: string,
  key: string,
): PresetAddPlan {
  const trimmedKey = key.trim();
  if (trimmedKey === "") return { error: "paste the provider's API key to add it" };
  const trimmedBaseUrl = baseUrl.trim();
  if (trimmedBaseUrl === "") return { error: "a base URL is required" };
  return {
    baseUrlPatch: trimmedBaseUrl !== provider.baseUrl ? trimmedBaseUrl : null,
    key: trimmedKey,
  };
}

/** POST /providers — custom provider create. Answers 201 (fresh row) or 200
 * (the ADOPT case: a keyless built-in row at the wanted id, `adopted:true`)
 * — both parse as the ProviderRow the list re-reads. The FIRST KEY does not
 * ride this call: the sheet follows up with setProviderKey (the primary
 * endpoint) when one was pasted. */
export function createCustomProvider(
  sender: ApiSender,
  body: { name: string; baseUrl: string; apiFormat: ProviderApiFormat },
): Promise<ApiOutcome<ProviderRow & { adopted?: boolean }>> {
  return apiJson<ProviderRow & { adopted?: boolean }>(sender, "/providers", {
    method: "POST",
    bodyText: JSON.stringify(body),
  });
}

/** DELETE /providers/:id — 204, no body. `force` reassigns referencing
 * agents to no-provider (R91-A); the honest 409 (naming the agents) surfaces
 * when false. */
export function deleteProvider(
  sender: ApiSender,
  id: string,
  force = false,
): Promise<ApiOutcome<null>> {
  return apiJsonNoBody(
    sender,
    `/providers/${encodeURIComponent(id)}${force ? "?force=1" : ""}`,
    { method: "DELETE" },
  );
}

/** GET /providers/:id/keys — the masked pool (slot 0 = the primary). */
export function fetchProviderKeys(
  sender: ApiSender,
  id: string,
): Promise<ApiOutcome<{ keys: ProviderKeySlot[] }>> {
  return apiJson<{ keys: ProviderKeySlot[] }>(sender, `/providers/${encodeURIComponent(id)}/keys`);
}

/** PUT /providers/:id/keys/:slot — write one pool slot (1..31; slot 0 is
 * writable but the PRIMARY path is setProviderKey). Answers the fresh masked
 * pool. The pasted value is NEVER echoed back by the phone after this. */
export function putProviderKeySlot(
  sender: ApiSender,
  id: string,
  slot: number,
  value: string,
): Promise<ApiOutcome<{ keys: ProviderKeySlot[] }>> {
  return apiJson<{ keys: ProviderKeySlot[] }>(
    sender,
    `/providers/${encodeURIComponent(id)}/keys/${slot}`,
    { method: "PUT", bodyText: JSON.stringify({ value }) },
  );
}

/** DELETE /providers/:id/keys/:slot — pool slots only (the route 409s on
 * slot 0: the primary is never removed over HTTP, only replaced). Answers
 * the pool with the emptied slot re-included. */
export function deleteProviderKeySlot(
  sender: ApiSender,
  id: string,
  slot: number,
): Promise<ApiOutcome<{ keys: ProviderKeySlot[] }>> {
  return apiJson<{ keys: ProviderKeySlot[] }>(
    sender,
    `/providers/${encodeURIComponent(id)}/keys/${slot}`,
    { method: "DELETE" },
  );
}

/**
 * R114-f: the add-a-key sheet's slot math (the desktop key-pool.ts twin —
 * the phone cannot import src/). The FIRST key lands on the PRIMARY (slot
 * 0, written through setProviderKey's endpoint); once the primary is held
 * the first free POOL slot in [1, 31] wins (a gap never collides — slots 2
 * and 4 held → 3, never `length + 2` overwriting 4). -1 = the pool is full
 * (31 keys). Pure: order/duplicates/out-of-range entries are fine.
 */
export function nextFreeKeySlot(keys: ProviderKeySlot[]): number {
  const primaryHeld = keys.some((k) => k.slot === 0 && k.hasKey);
  if (!primaryHeld) return 0;
  const held = new Set(keys.filter((k) => k.hasKey).map((k) => k.slot));
  for (let slot = 1; slot <= 31; slot++) {
    if (!held.has(slot)) return slot;
  }
  return -1;
}

/** GET /providers/:id/models-config — THIS provider's saved DB rows (the
 * owner's demand: "show me the models I SAVED, not everything the provider
 * offers"). Order: visible first, then hidden. */
export function fetchProviderModelsConfig(
  sender: ApiSender,
  id: string,
): Promise<ApiOutcome<{ models: ModelRecord[] }>> {
  return apiJson<{ models: ModelRecord[] }>(
    sender,
    `/providers/${encodeURIComponent(id)}/models-config`,
  );
}

/** GET /models/catalog — the static 47-entry catalog (the add-model sheet's
 * fallback list + the prefill's pricing/context/vision source). */
export function fetchModelCatalog(sender: ApiSender): Promise<ApiOutcome<ModelCatalogResponse>> {
  return apiJson<ModelCatalogResponse>(sender, "/models/catalog");
}

/** POST /providers/:id/models — the add/upsert. modelId is required; every
 * other field is the R50-d contract (number sets, null clears to unknown,
 * absent keeps the stored value). Answers 201 with the saved row. */
export function addProviderModel(
  sender: ApiSender,
  id: string,
  body: {
    modelId: string;
    displayName?: string;
    sizeLabel?: string;
    contextWindow?: number;
    maxOutputTokens?: number;
    inputPricePerMtok?: number;
    inputPriceCachedPerMtok?: number;
    outputPricePerMtok?: number;
    supportsVision?: boolean;
    supportsTools?: boolean | null;
    supportsAudio?: boolean | null;
    supportsVideo?: boolean | null;
    supportsPdf?: boolean | null;
    supportsTextOutput?: boolean | null;
    supportsImageOutput?: boolean | null;
    supportsVideoOutput?: boolean | null;
    supportsAudioOutput?: boolean | null;
    hidden?: boolean;
  },
): Promise<ApiOutcome<ModelRecord>> {
  return apiJson<ModelRecord>(sender, `/providers/${encodeURIComponent(id)}/models`, {
    method: "POST",
    bodyText: JSON.stringify(body),
  });
}

/** R116-j (§1.8) → R119-P: the phone's wait for a MODEL test call. The
 * server's per-model probe is now TWO sequential bounded legs — the pong
 * completion + the TOOLS leg (agent-core registry.ts MODEL_TEST_TIMEOUT_MS
 * 30s per leg, "reasoning models are slow to first token") — so the
 * exchange's worst case is 60s. Acute-net's default callTimeout is 15s —
 * the exchange aborted mid-probe and every honest failure read as "the
 * host dropped". 65s = BOTH legs' full budget + travel (the R116-j 35s
 * budget covered only the single-phase probe and would have cut the tools
 * leg off exactly in the slow-model case it exists for). */
const MODEL_TEST_CALL_TIMEOUT_MS = 65_000;

/** R119-P: the phone's wait for a PROVIDER test call — the provider-level
 * probe stays single-phase (agent-core TEST_TIMEOUT_MS 15s + the models
 * listing), so the R116-j 35s budget stays the right number for it. */
const PROVIDER_TEST_CALL_TIMEOUT_MS = 35_000;

/** POST /models/:id/test — the per-model probe. {slot} scopes the key used
 * (the R47-b pool contract); omitted = the primary. */
export function testModel(
  sender: ApiSender,
  id: string,
  body: { slot?: number } = {},
): Promise<ApiOutcome<ModelTestResult>> {
  return apiJson<ModelTestResult>(sender, `/models/${encodeURIComponent(id)}/test`, {
    method: "POST",
    bodyText: JSON.stringify(body),
    timeoutMs: MODEL_TEST_CALL_TIMEOUT_MS,
  });
}

/** DELETE /models/:id — 204, no body. */
export function deleteModel(sender: ApiSender, id: string): Promise<ApiOutcome<null>> {
  return apiJsonNoBody(sender, `/models/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// ── models: the R114-f pure sheet math ──────────────────────────────────────

/** The add/edit sheet's draft — numerics live as STRINGS so an empty input
 * can mean "unknown" (null) rather than 0 (the desktop dialog's contract).
 * R116-j (verdict #43): the full R87 field set — sizing (context + max
 * output), the pricing trio (in/out/cache-read), the size label, and the
 * input/output capability toggles. supportsThinking is GONE: the PC has no
 * thinking toggle ("reasoning and tool use are detected automatically") —
 * the wire field stays, the phone just never configures it (absent = the
 * stored/detected value keeps). supportsTools rides for the round-trip
 * only — no chip owns it (the app detects tool use at runtime). */
export interface ModelFormDraft {
  modelId: string;
  displayName: string;
  sizeLabel: string;
  contextWindow: string;
  maxOutputTokens: string;
  inputPricePerMtok: string;
  outputPricePerMtok: string;
  inputPriceCachedPerMtok: string;
  supportsVision: boolean;
  /** Tri-state: null = unknown, false = off, true = on (chips flip the
   * value between true/false; an untouched null round-trips as null). */
  supportsTools: boolean | null;
  supportsAudio: boolean | null;
  supportsVideo: boolean | null;
  supportsPdf: boolean | null;
  supportsTextOutput: boolean | null;
  supportsImageOutput: boolean | null;
  supportsVideoOutput: boolean | null;
  supportsAudioOutput: boolean | null;
  hidden: boolean;
}

/** A blank numeric field, or a non-numeric/negative one. */
export type ModelNumericParse =
  | { ok: true; value: number | null }
  | { ok: false; field: string; message: string };

/**
 * Parse ONE numeric sheet field: blank → null ("unknown"), a finite number
 * ≥ 0 → the number, anything else → the honest per-field error the sheet
 * shows inline (the desktop dialog's "must be a number ≥ 0 (or empty for
 * unknown)"). Pure.
 */
export function parseModelNumericField(field: string, raw: string): ModelNumericParse {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) {
    return {
      ok: false,
      field,
      message: `${field} must be a number ≥ 0 (or blank for unknown)`,
    };
  }
  return { ok: true, value };
}

/**
 * The add sheet's POST body. modelId blank after trim → null (the sheet
 * refuses before the route 400s). Blank numerics are OMITTED (the server's
 * insert defaults + catalog lookups decide — never a fabricated 0); the
 * capability flags ride verbatim (the sheet owns them — tri-state nulls
 * included, the route's boolean-or-null contract); supportsThinking is
 * NEVER sent (detected server-side; absent keeps/derives the stored
 * value). displayName and sizeLabel are omitted when blank (the route
 * stores the modelId as the name / leaves the label unspecified). Pure.
 */
export function modelAddBody(
  draft: ModelFormDraft,
): {
  modelId: string;
  displayName?: string;
  sizeLabel?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  inputPricePerMtok?: number;
  inputPriceCachedPerMtok?: number;
  outputPricePerMtok?: number;
  supportsVision: boolean;
  supportsTools: boolean | null;
  supportsAudio: boolean | null;
  supportsVideo: boolean | null;
  supportsPdf: boolean | null;
  supportsTextOutput: boolean | null;
  supportsImageOutput: boolean | null;
  supportsVideoOutput: boolean | null;
  supportsAudioOutput: boolean | null;
  hidden: boolean;
} | null {
  const modelId = draft.modelId.trim();
  if (modelId === "") return null;
  const contextWindow = parseModelNumericField("Context window", draft.contextWindow);
  const maxOutputTokens = parseModelNumericField("Max output tokens", draft.maxOutputTokens);
  const inputPrice = parseModelNumericField("Input price", draft.inputPricePerMtok);
  const outputPrice = parseModelNumericField("Output price", draft.outputPricePerMtok);
  const cachePrice = parseModelNumericField("Cache read price", draft.inputPriceCachedPerMtok);
  if (
    !contextWindow.ok ||
    !maxOutputTokens.ok ||
    !inputPrice.ok ||
    !outputPrice.ok ||
    !cachePrice.ok
  ) {
    return null;
  }
  return {
    modelId,
    ...(draft.displayName.trim() === "" ? {} : { displayName: draft.displayName.trim() }),
    ...(draft.sizeLabel.trim() === "" ? {} : { sizeLabel: draft.sizeLabel.trim() }),
    ...(contextWindow.value === null ? {} : { contextWindow: contextWindow.value }),
    ...(maxOutputTokens.value === null ? {} : { maxOutputTokens: maxOutputTokens.value }),
    ...(inputPrice.value === null ? {} : { inputPricePerMtok: inputPrice.value }),
    ...(outputPrice.value === null ? {} : { outputPricePerMtok: outputPrice.value }),
    ...(cachePrice.value === null ? {} : { inputPriceCachedPerMtok: cachePrice.value }),
    supportsVision: draft.supportsVision,
    supportsTools: draft.supportsTools,
    supportsAudio: draft.supportsAudio,
    supportsVideo: draft.supportsVideo,
    supportsPdf: draft.supportsPdf,
    supportsTextOutput: draft.supportsTextOutput,
    supportsImageOutput: draft.supportsImageOutput,
    supportsVideoOutput: draft.supportsVideoOutput,
    supportsAudioOutput: draft.supportsAudioOutput,
    hidden: draft.hidden,
  };
}

/**
 * The edit sheet's PATCH body — the fields the sheet OWNS, nothing else (the
 * spec's tri-state discipline: caps the sheet does not touch are never
 * sent — supportsThinking is deliberately absent, the detected value
 * keeps). displayName always rides (blank = "no custom name" — the pickers
 * fall back to the modelId); blank numerics ride as NULL (the R50-d
 * clear-to-unknown contract — the desktop dialog's semantics); blank
 * sizeLabel rides as NULL (unspecified); the capability flags ride verbatim
 * (untouched nulls round-trip as null — unknown stays unknown). modelId is
 * identity: read-only on the sheet, absent here. Pure.
 */
export function modelEditBody(
  draft: ModelFormDraft,
): {
  displayName: string;
  sizeLabel: string | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  inputPricePerMtok: number | null;
  outputPricePerMtok: number | null;
  inputPriceCachedPerMtok: number | null;
  supportsVision: boolean;
  supportsTools: boolean | null;
  supportsAudio: boolean | null;
  supportsVideo: boolean | null;
  supportsPdf: boolean | null;
  supportsTextOutput: boolean | null;
  supportsImageOutput: boolean | null;
  supportsVideoOutput: boolean | null;
  supportsAudioOutput: boolean | null;
  hidden: boolean;
} {
  const contextWindow = parseModelNumericField("Context window", draft.contextWindow);
  const maxOutputTokens = parseModelNumericField("Max output tokens", draft.maxOutputTokens);
  const inputPrice = parseModelNumericField("Input price", draft.inputPricePerMtok);
  const outputPrice = parseModelNumericField("Output price", draft.outputPricePerMtok);
  const cachePrice = parseModelNumericField("Cache read price", draft.inputPriceCachedPerMtok);
  // The caller validates first (the sheet shows the per-field error); a
  // malformed value that reaches here reads as null — never a fabricated 0.
  const num = (parse: ModelNumericParse): number | null => (parse.ok ? parse.value : null);
  return {
    displayName: draft.displayName.trim(),
    sizeLabel: draft.sizeLabel.trim() === "" ? null : draft.sizeLabel.trim(),
    contextWindow: num(contextWindow),
    maxOutputTokens: num(maxOutputTokens),
    inputPricePerMtok: num(inputPrice),
    outputPricePerMtok: num(outputPrice),
    inputPriceCachedPerMtok: num(cachePrice),
    supportsVision: draft.supportsVision,
    supportsTools: draft.supportsTools,
    supportsAudio: draft.supportsAudio,
    supportsVideo: draft.supportsVideo,
    supportsPdf: draft.supportsPdf,
    supportsTextOutput: draft.supportsTextOutput,
    supportsImageOutput: draft.supportsImageOutput,
    supportsVideoOutput: draft.supportsVideoOutput,
    supportsAudioOutput: draft.supportsAudioOutput,
    hidden: draft.hidden,
  };
}

/** Hydrate the edit sheet off a saved row (numerics → strings, "" = null).
 * R116-j: the full R87 field set round-trips — untouched tri-state caps
 * keep their stored unknown (null), never a guessed boolean. */
export function modelDraftFromRecord(record: ModelRecord): ModelFormDraft {
  const num = (v: number | null): string => (v === null ? "" : String(v));
  return {
    modelId: record.modelId,
    displayName: record.displayName ?? "",
    sizeLabel: record.sizeLabel ?? "",
    contextWindow: num(record.contextWindow),
    maxOutputTokens: num(record.maxOutputTokens),
    inputPricePerMtok: num(record.inputPricePerMtok),
    outputPricePerMtok: num(record.outputPricePerMtok),
    inputPriceCachedPerMtok: num(record.inputPriceCachedPerMtok),
    supportsVision: record.supportsVision === true,
    supportsTools: record.supportsTools,
    supportsAudio: record.supportsAudio,
    supportsVideo: record.supportsVideo,
    supportsPdf: record.supportsPdf,
    supportsTextOutput: record.supportsTextOutput,
    supportsImageOutput: record.supportsImageOutput,
    supportsVideoOutput: record.supportsVideoOutput,
    supportsAudioOutput: record.supportsAudioOutput,
    hidden: record.hidden,
  };
}

/**
 * The saved-model row's capability chips (the owner's at-a-glance read):
 * vision + thinking when the row says so, hidden always surfaced. Pure.
 */
export function modelCapabilityChips(
  model: Pick<ModelRecord, "supportsVision" | "supportsThinking" | "hidden">,
): { vision: boolean; thinking: boolean; hidden: boolean } {
  return {
    vision: model.supportsVision === true,
    thinking: model.supportsThinking === true,
    hidden: model.hidden,
  };
}

/**
 * R89-C2 (the desktop's cleanModelName, ported — the phone cannot import
 * src/): the humanized last path segment of a model id ("openrouter/z-ai/
 * glm-4.7:free" → "Glm 4.7"). The owner: "the last part of the model ID was
 * supposed to be shown as the name". Pure.
 */
export function cleanModelName(modelId: string): string {
  const tail = modelId.split("/").pop() ?? modelId;
  const stripped = tail.replace(/:[a-z0-9-]+$/i, "");
  const base = stripped.trim() !== "" ? stripped : tail;
  const tokens = base
    .replace(/[-_]+/g, " ")
    .split(/\s+/)
    .filter((t) => t !== "");
  if (tokens.length === 0) return modelId;
  const pretty = tokens.map((t) => {
    // tokens with digits keep their shape ("3.3", "70b", "4o")
    if (/\d/.test(t)) return t;
    // vowel-less short tokens read as acronyms (gpt, glm, sdxl, t5) —
    // word-like ones (mini, nano, flash) stay words.
    if (t.length <= 5 && !/[aeiou]/.test(t)) return t.toUpperCase();
    return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
  });
  return pretty.join(" ");
}

/**
 * The add-model sheet's catalog PREFILL (the desktop prefillFor's port):
 * the LIVE entry owns the id + display name (the provider's own naming —
 * but an entry whose "name" is just the id falls to the static catalog's
 * displayName, then the humanized last segment); the STATIC catalog row
 * fills the sizing pair + the pricing trio (cache read included) + vision
 * when the id matches (OpenRouter ids). Text output defaults ON (the
 * chat-completions contract); every other cap starts unknown (null). Pure.
 */
export function catalogPrefillFor(
  entry: Pick<ModelSummary, "id" | "name">,
  staticCatalog: readonly CatalogModelEntry[],
): ModelFormDraft {
  const meta = staticCatalog.find((m) => m.modelId === entry.id);
  const displayName =
    entry.name !== "" && entry.name !== entry.id
      ? entry.name
      : (meta?.displayName ?? cleanModelName(entry.id));
  const num = (v: number | null | undefined): string => (v === null || v === undefined ? "" : String(v));
  return {
    modelId: entry.id,
    displayName,
    sizeLabel: "",
    contextWindow: num(meta?.contextWindow),
    maxOutputTokens: num(meta?.maxOutputTokens),
    inputPricePerMtok: num(meta?.inputPricePerMtok),
    outputPricePerMtok: num(meta?.outputPricePerMtok),
    inputPriceCachedPerMtok: num(meta?.inputPriceCachedPerMtok),
    supportsVision: meta?.supportsVision ?? false,
    supportsTools: null,
    supportsAudio: null,
    supportsVideo: null,
    supportsPdf: null,
    // Unknown text output renders ON (the chat-completions default).
    supportsTextOutput: true,
    supportsImageOutput: null,
    supportsVideoOutput: null,
    supportsAudioOutput: null,
    hidden: false,
  };
}

/**
 * The catalog list's search filter (the add-model sheet's query): a
 * case-insensitive substring match on the entry id OR its name. Pure,
 * order-preserving.
 */
export function searchCatalogEntries<T extends { id: string; name: string }>(
  query: string,
  entries: readonly T[],
): T[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...entries];
  return entries.filter(
    (entry) =>
      entry.id.toLowerCase().includes(needle) || entry.name.toLowerCase().includes(needle),
  );
}

/** The static catalog rows as listable entries (the live catalog's fallback
 * shape — {id, name} — so one renderer serves both sources). Pure. */
export function catalogEntriesFromStatic(
  catalog: readonly CatalogModelEntry[],
): ModelSummary[] {
  return catalog.map((m) => ({ id: m.modelId, name: m.displayName }));
}

/** PUT /providers/:id/key — the PRIMARY key (204, no body — apiJsonNoBody
 * since R114-f: the old apiJson read the empty 204 as BAD_JSON). */
export function setProviderKey(sender: ApiSender, id: string, value: string): Promise<ApiOutcome<null>> {
  return apiJsonNoBody(sender, `/providers/${encodeURIComponent(id)}/key`, {
    method: "PUT",
    bodyText: JSON.stringify({ value }),
  });
}

export function fetchProviderModels(
  sender: ApiSender,
  id: string,
): Promise<ApiOutcome<{ models: ModelSummary[]; cached: boolean }>> {
  return apiJson<{ models: ModelSummary[]; cached: boolean }>(
    sender,
    `/providers/${encodeURIComponent(id)}/models`,
  );
}

export function fetchConfiguredModels(
  sender: ApiSender,
): Promise<ApiOutcome<{ models: ModelRecord[] }>> {
  return apiJson<{ models: ModelRecord[] }>(sender, "/models/configured");
}

export function updateModel(
  sender: ApiSender,
  id: string,
  body: {
    displayName?: string;
    sizeLabel?: string | null;
    contextWindow?: number | null;
    maxOutputTokens?: number | null;
    inputPricePerMtok?: number | null;
    inputPriceCachedPerMtok?: number | null;
    outputPricePerMtok?: number | null;
    supportsVision?: boolean;
    supportsThinking?: boolean;
    supportsTools?: boolean | null;
    supportsAudio?: boolean | null;
    supportsVideo?: boolean | null;
    supportsPdf?: boolean | null;
    supportsTextOutput?: boolean | null;
    supportsImageOutput?: boolean | null;
    supportsVideoOutput?: boolean | null;
    supportsAudioOutput?: boolean | null;
    hidden?: boolean;
  },
): Promise<ApiOutcome<ModelRecord>> {
  return apiJson<ModelRecord>(sender, `/models/${encodeURIComponent(id)}`, {
    method: "PATCH",
    bodyText: JSON.stringify(body),
  });
}

export function testProvider(
  sender: ApiSender,
  id: string,
  body: { model?: string; slot?: number },
): Promise<ApiOutcome<{ ok: boolean; latencyMs?: number; message?: string }>> {
  return apiJson<{ ok: boolean; latencyMs?: number; message?: string }>(
    sender,
    `/providers/${encodeURIComponent(id)}/test`,
    // R116-j (§1.8): the 35s test-call budget — the server's own probe can
    // outlive the 15s acute-net default (see PROVIDER_TEST_CALL_TIMEOUT_MS;
    // the MODEL probe's own budget grew to 65s in R119-P for its second,
    // tools-carrying leg).
    { method: "POST", bodyText: JSON.stringify(body), timeoutMs: PROVIDER_TEST_CALL_TIMEOUT_MS },
  );
}

// ── R116-j: the honest test-failure copy (§1.8) ──────────────────────────

/** The scrubbed raw message tail — whitespace collapsed, capped so a
 * stack-shaped novel never wraps the note line. Pure. */
function scrubTransportMessage(message: string): string {
  const collapsed = message.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return "";
  return collapsed.length > 120 ? `${collapsed.slice(0, 117)}…` : collapsed;
}

/**
 * R116-j (verdict #42 / §1.8): the one-liner a TEST call's catch shows —
 * never the blanket "the host dropped during the test". The transport
 * error's CLASS owns the message: an unreachable/canceled link (incl. the
 * NotConnectedError the manager throws when the link already fell) says so
 * plainly; a timeout-shaped "network" failure (SocketTimeoutException
 * arrives classified "network") names the 30s reasoning-model reality;
 * everything else surfaces the REAL scrubbed message (a tls/bad-argument/
 * unknown error names its own cause). A message-less failure reads as
 * unreachable (NetError's own fallback message makes this rare). Pure.
 */
export function testTransportFailureMessage(err: unknown): string {
  const kind =
    typeof err === "object" && err !== null && "kind" in err && typeof (err as { kind: unknown }).kind === "string"
      ? ((err as { kind: string }).kind as string)
      : null;
  const rawMessage = err instanceof Error ? err.message : "";
  const scrubbed = scrubTransportMessage(rawMessage);
  // NotConnectedError is name-checked (not imported) — config.ts stays pure
  // (the connection module drags the RN storage stack into the graph).
  const isNotConnected = err instanceof Error && err.name === "NotConnectedError";
  const unreachable =
    kind === "network" || kind === "canceled" || isNotConnected || scrubbed === "";
  if (unreachable) {
    if (/timeout|timed[\s_-]*out/i.test(rawMessage)) {
      return "The test timed out — reasoning models can take 30s.";
    }
    return "Couldn't reach the desktop — try again.";
  }
  return `The test failed — ${scrubbed}`;
}

// ── prompts ─────────────────────────────────────────────────────────────────

export function fetchPromptSections(
  sender: ApiSender,
  projectRoot: string,
): Promise<ApiOutcome<PromptsSectionsResponse>> {
  return apiJson<PromptsSectionsResponse>(
    sender,
    `/prompts/sections?projectRoot=${encodeURIComponent(projectRoot)}`,
  );
}

export function savePromptSection(
  sender: ApiSender,
  sectionId: string,
  projectRoot: string,
  content: string,
): Promise<ApiOutcome<{ ok: boolean; id: string; dropped: boolean }>> {
  return apiJson<{ ok: boolean; id: string; dropped: boolean }>(
    sender,
    `/prompts/sections/${encodeURIComponent(sectionId)}`,
    { method: "PUT", bodyText: JSON.stringify({ projectRoot, content }) },
  );
}

export function revertPromptSection(
  sender: ApiSender,
  sectionId: string,
  projectRoot: string,
): Promise<ApiOutcome<{ ok: boolean; id: string; reverted: boolean }>> {
  return apiJson<{ ok: boolean; id: string; reverted: boolean }>(
    sender,
    `/prompts/sections/${encodeURIComponent(sectionId)}?projectRoot=${encodeURIComponent(projectRoot)}`,
    { method: "DELETE" },
  );
}

// ── settings (the typed GET/PUT pairs the preferences screen edits) ─────────

export interface OrchestrationSettings {
  maxParallel: number;
  perKeyLimit: number;
  subagentModel: string | { providerId: string; modelId: string } | null;
  childWatchdogMs: number;
  childStallTimeoutMs: number;
}

export interface RetrySettings {
  autoRetryRateLimit: boolean;
  autoRetryTimeout: boolean;
  autoRetryNetwork: boolean;
  maxAttempts: number;
  waitMinutes: number[];
  providerTimeoutSeconds: number;
}

export interface ThinkingLoopSettings {
  enabled: boolean;
  stallSeconds: number;
  reasoningBytesKB: number;
}

export interface BrowserSettings {
  searchEngine: string;
  homepage: string;
  defaultZoom: number;
  quickLinks: { label: string; url: string }[];
  linkOpeningMode: string;
}

/** Generic GET /settings/:domain */
export function fetchSettings<T>(sender: ApiSender, domain: string): Promise<ApiOutcome<T>> {
  return apiJson<T>(sender, `/settings/${domain}`);
}

/** Generic PUT /settings/:domain (partial patch; returns the updated object). */
export function saveSettings<T>(
  sender: ApiSender,
  domain: string,
  body: Partial<T>,
): Promise<ApiOutcome<T>> {
  mobLog("config", `settings PUT ${domain}`, { keys: Object.keys(body) });
  return apiJson<T>(sender, `/settings/${domain}`, {
    method: "PUT",
    bodyText: JSON.stringify(body),
  });
}

// ── usage / dashboard ───────────────────────────────────────────────────────

export function fetchUsageSummary(sender: ApiSender, days = 14): Promise<ApiOutcome<UsageSummary>> {
  return apiJson<UsageSummary>(sender, `/usage/summary?days=${days}`);
}

export function fetchUsageStats(sender: ApiSender, months = 1): Promise<ApiOutcome<UsageStats>> {
  return apiJson<UsageStats>(sender, `/usage/stats?months=${months}`);
}

/**
 * R116-g: the whole-history drill-down (agent-core storage/usage.ts
 * getDetailedUsage). `days` scopes ONLY the zero-filled activity series
 * (1–90, validated server-side); totals/tools/models/keys/projects are
 * WHOLE-HISTORY — the dashboard labels those sections "all time" honestly.
 */
export function fetchDetailedUsage(sender: ApiSender, days = 30): Promise<ApiOutcome<DetailedUsage>> {
  return apiJson<DetailedUsage>(sender, `/usage/detailed?days=${days}`);
}
