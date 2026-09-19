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

import { apiJson, type ApiOutcome, type ApiSender } from "./api";
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
}

export interface ModelSummary {
  id: string;
  name: string;
  reasoningSupport?: boolean;
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

export function setProviderKey(sender: ApiSender, id: string, value: string): Promise<ApiOutcome<null>> {
  return apiJson<null>(sender, `/providers/${encodeURIComponent(id)}/key`, {
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
    contextWindow?: number | null;
    maxOutputTokens?: number | null;
    inputPricePerMtok?: number | null;
    outputPricePerMtok?: number | null;
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
  body: { model?: string },
): Promise<ApiOutcome<{ ok: boolean; latencyMs?: number; message?: string }>> {
  return apiJson<{ ok: boolean; latencyMs?: number; message?: string }>(
    sender,
    `/providers/${encodeURIComponent(id)}/test`,
    { method: "POST", bodyText: JSON.stringify(body) },
  );
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
