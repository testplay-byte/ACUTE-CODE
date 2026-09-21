import { useMemo, useState, type FormEvent, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import type { Agent, AgentDraft, ProviderModelConfig } from "../../lib/api";
import {
  PROVIDER_IDS,
  TOOL_CATALOG,
  fetchConfiguredModels,
  fetchProviders,
} from "../../lib/api";
import type { MemoryPolicy } from "shared";
import { Dialog, DialogContent, DialogHeader } from "../ui/dialog";
import { Badge, Button, Field, inputClass } from "../ui/controls";

const MEMORY_POLICIES: MemoryPolicy[] = ["none", "on-start", "every-turn"];

/**
 * ROUND-117 (R117-b): the policy's honest captions — the flag is LIVE now
 * (runtime.ts gates the digest + the memory tools on it), so the labels say
 * what each value actually does instead of the raw enum token.
 */
const MEMORY_POLICY_LABELS: Record<MemoryPolicy, string> = {
  none: "Never",
  "on-start": "On first turn only",
  "every-turn": "Every turn",
};

/**
 * ROUND-93 (R93-A8): the small uppercase section label that groups the form
 * into scannable blocks (Identity / Model / Behavior / Capabilities /
 * Advanced) — the app's existing section visual language (see
 * ModelsProvidersTab's SectionLabel), with a hairline rule running to the
 * right so sections read as dividers, not floating captions.
 */
function SectionLabel({ children }: { children: string }) {
  return (
    <div className="col-span-2 flex items-center gap-2.5" aria-hidden>
      <span className="text-[10px] font-bold uppercase tracking-widest text-muted">{children}</span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

type FormState = {
  name: string;
  role: string;
  systemPrompt: string;
  providerId: string;
  model: string;
  visionModel: string;
  memoryPolicy: MemoryPolicy;
  allowedTools: string[];
  skills: string[];
  maxTurns: string;
  temperature: string;
};

const DEFAULTS: FormState = {
  name: "",
  role: "",
  systemPrompt: "",
  providerId: "openrouter",
  model: "",
  visionModel: "",
  memoryPolicy: "every-turn",
  allowedTools: [], // empty = all tools (ADR-0019)
  skills: [],
  maxTurns: "40",
  temperature: "0.2",
};

function toFormState(agent: Agent | null): FormState {
  if (!agent) return { ...DEFAULTS, allowedTools: [...DEFAULTS.allowedTools] };
  return {
    name: agent.name,
    role: agent.role,
    systemPrompt: agent.systemPrompt,
    // ROUND-92 (R92-C): null-safe — the seeded templates have been NULL/NULL
    // since round 1, and since R91-A every force-deleted provider's referencing
    // agents are too. The old copy crashed validate's form.model.trim() during
    // render (the app ErrorBoundary replaced the whole Agents screen — the
    // owner's "agents were not editable"). Empty string is the form's
    // "not configured" state; toDraft maps it back to null.
    providerId: agent.providerId ?? "",
    model: agent.model ?? "",
    visionModel: agent.visionModel ?? "",
    memoryPolicy: agent.memoryPolicy,
    allowedTools: [...agent.allowedTools],
    skills: [...agent.skills],
    maxTurns: String(agent.maxTurns),
    temperature: String(agent.temperature),
  };
}

/** Convert loose form state into the strict AgentDraft (API.md §4.2 payload).
 * ROUND-92 (R92-C): providerId/model are OPTIONAL — an empty trim sends
 * null ("not configured — pick in chat"), which the backend stores verbatim
 * (PATCH/POST accept string | null; updateAgent honors an explicit null). */
function toDraft(s: FormState): AgentDraft {
  return {
    name: s.name.trim(),
    role: s.role.trim(),
    systemPrompt: s.systemPrompt,
    providerId: s.providerId.trim() || null,
    model: s.model.trim() || null,
    visionModel: s.visionModel.trim() || null,
    allowedTools: s.allowedTools,
    memoryPolicy: s.memoryPolicy,
    skills: s.skills,
    maxTurns: Number(s.maxTurns),
    temperature: Number(s.temperature),
  };
}

export function AgentFormDialog({
  agent,
  open,
  onOpenChange,
  onSubmit,
}: {
  /** null = create; agent = edit its editable fields. */
  agent: Agent | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Resolve to close; reject to surface the error inline. */
  onSubmit: (draft: AgentDraft) => Promise<void>;
}) {
  const [form, setForm] = useState<FormState>(() => toFormState(agent));
  const [skillInput, setSkillInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [submitting, setSubmitting] = useState(false);

  // ROUND-47 (R47-c2): provider options come from the live registry
  // (GET /providers — the SAME ["settings-providers"] cache as the Models &
  // Providers tab, so CRUD there refreshes here too). The dialog must ALWAYS
  // open: while loading, or when the registry is unreachable, it falls back
  // to the PROVIDER_IDS defaults with an honest dim note on failure.
  const providersQuery = useQuery({
    queryKey: ["settings-providers"],
    queryFn: fetchProviders,
    enabled: open,
    retry: false,
  });
  const providerOptions = useMemo(() => {
    const loaded = providersQuery.data;
    if (!loaded || loaded.length === 0) {
      return PROVIDER_IDS.map((id) => ({ id, name: id }));
    }
    return loaded.map((p) => ({ id: p.id, name: p.name }));
  }, [providersQuery.data]);
  // Never strand the current selection (an agent can outlive its provider —
  // keep its id visible instead of silently blanking the select).
  // ROUND-92 (R92-C): the "— none —" selection ("") is a REAL option below —
  // it never needs the keep-visible fallback row.
  const selectionVisible =
    form.providerId === "" || providerOptions.some((o) => o.id === form.providerId);

  // ROUND-93 (R93-A8, owner directive — the edit dialog's UX pass): the model
  // inputs stay FREE-TEXT (custom models must remain enterable) but their
  // <datalist> suggestions now come from the user's CONFIGURED rows (GET
  // /models/configured — the Models & Providers page), hidden rows excluded —
  // NOT the static OpenRouter catalog (the fetchModelsCatalog query is gone:
  // it fed ~47 ids the owner never curated, the same class of noise A9 removed
  // from the sub-agent picker). Fails soft: unreachable config ⇒ no
  // suggestions, inputs keep working.
  const configuredQuery = useQuery({
    queryKey: ["models-configured"],
    queryFn: fetchConfiguredModels,
    enabled: open,
    staleTime: 60 * 1000, // rows change only via Models & Providers (invalidates)
    retry: false,
  });
  const configuredRows = useMemo(
    () => (configuredQuery.data ?? []).filter((m) => m.hidden !== true),
    [configuredQuery.data],
  );
  // The Model field's suggestion order: the SELECTED provider's rows first
  // (what the agent will actually call), then every other provider's rows —
  // clearly labeled "provider: model-id" so a cross-provider id is never
  // mistaken for a local one. Deduped by value (datalist collapses dupes
  // anyway; first occurrence wins, i.e. the selected provider's row).
  const modelSuggestions = useMemo(() => {
    const current = form.providerId.trim();
    const mine: ProviderModelConfig[] = [];
    const others: ProviderModelConfig[] = [];
    for (const m of configuredRows) {
      if (current !== "" && m.providerId === current) mine.push(m);
      else others.push(m);
    }
    return [...mine, ...others];
  }, [configuredRows, form.providerId]);
  const visionSuggestions = useMemo(
    () => modelSuggestions.filter((m) => m.supportsVision),
    [modelSuggestions],
  );
  // The LIVE first suggestion (the selected provider's first row once the
  // config lands) rides the placeholder; the known default id before that.
  const modelPlaceholder = modelSuggestions[0]?.modelId ?? "z-ai/glm-5.2:free";

  // Reset whenever a different agent (or create-mode) opens the dialog, and
  // again on close so a cancelled draft never leaks into the next open.
  const key = `${agent?.id ?? "new"}:${open}`;
  const [lastKey, setLastKey] = useState(key);
  if (lastKey !== key) {
    setLastKey(key);
    setForm(toFormState(agent));
    setError(null);
    setFieldErrors({});
    setSkillInput("");
  }

  const set = <K extends keyof FormState>(field: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [field]: value }));

  const toggleTool = (tool: string, checked: boolean) =>
    set(
      "allowedTools",
      checked
        ? [...form.allowedTools, tool]
        : form.allowedTools.filter((t) => t !== tool),
    );

  const addSkill = (raw: string) => {
    const skill = raw.trim().replace(/,+$/, "");
    if (skill && !form.skills.includes(skill)) set("skills", [...form.skills, skill]);
    setSkillInput("");
  };

  const onSkillKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addSkill(skillInput);
    } else if (e.key === "Backspace" && !skillInput && form.skills.length > 0) {
      set("skills", form.skills.slice(0, -1));
    }
  };

  const validate = useMemo(() => {
    const errs: Partial<Record<keyof FormState, string>> = {};
    if (!form.name.trim()) errs.name = "Name is required";
    if (!form.role.trim()) errs.role = "Role is required";
    // ROUND-92 (R92-C): model/provider are OPTIONAL now — "not configured"
    // is a legitimate saved state (the R92 contract: an unconfigured agent
    // arms itself from the first chat pick; the backend's override-first gate
    // lets the send carry the pair). The old "Model is required" error is
    // gone — the Model field carries the "pick in chat" hint instead.
    const turns = Number(form.maxTurns);
    if (!Number.isInteger(turns) || turns < 1) errs.maxTurns = "Must be an integer ≥ 1";
    const temp = Number(form.temperature);
    if (!Number.isFinite(temp) || temp < 0 || temp > 2) errs.temperature = "Must be 0 – 2";
    return errs;
  }, [form]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (Object.keys(validate).length > 0) {
      setFieldErrors(validate);
      return;
    }
    setFieldErrors({});
    setSubmitting(true);
    try {
      await onSubmit(toDraft(form));
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader
          title={agent ? `Edit ${agent.name}` : "New agent"}
          description="Saved to the agent registry (SPEC F2) and reusable across sessions."
        />
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          {/* ROUND-93 (R93-A8): the body is SECTIONED (Identity / Model /
              Behavior / Capabilities / Advanced) instead of one long
              undifferentiated grid — the same scannable block language the
              settings tabs use. The scroll container is unchanged: the
              DialogContent caps the height (max-h-[86vh]) and this div
              scrolls internally, so long prompts/tool grids never push the
              footer off-screen. */}
          <div className="grid min-h-0 flex-1 grid-cols-2 gap-x-3.5 gap-y-3 overflow-y-auto px-5 py-4">
            <SectionLabel>Identity</SectionLabel>
            <Field label="Name" hint={fieldErrors.name}>
              <input
                className={inputClass}
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder="Coder"
                autoFocus
              />
            </Field>
            <Field label="Role" hint={fieldErrors.role}>
              <input
                className={inputClass}
                value={form.role}
                onChange={(e) => set("role", e.target.value)}
                placeholder="implementer"
              />
            </Field>

            <SectionLabel>Model</SectionLabel>
            <Field
              label="Provider"
              hint={
                // Honest, dim (Field renders hints muted) — the dropdown is
                // still fully usable on the PROVIDER_IDS defaults.
                providersQuery.isError ? "provider list unavailable — showing defaults" : undefined
              }
            >
              <select
                className={inputClass}
                value={form.providerId}
                onChange={(e) => set("providerId", e.target.value)}
              >
                {/* ROUND-92 (R92-C): the "not configured" choice — null on
                    the wire. An agent saved this way arms itself from the
                    first chat pick (the R92 contract), exactly like the
                    R91-A force-delete reset state. */}
                <option value="">— none —</option>
                {providerOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name === p.id ? p.id : `${p.name} (${p.id})`}
                  </option>
                ))}
                {!selectionVisible && <option value={form.providerId}>{form.providerId}</option>}
              </select>
            </Field>
            <Field label="Model" hint="Leave empty to pick the model in chat">
              <input
                className={`${inputClass} font-mono text-xs`}
                value={form.model}
                onChange={(e) => set("model", e.target.value)}
                list="agent-model-options"
                // The LIVE first configured row's id once the config lands;
                // the known current default before that. The old placeholder
                // advertised the dead openrouter/ox-alpha (deleted upstream)
                // — never again.
                placeholder={modelPlaceholder}
              />
            </Field>
            <Field
              label="Vision model (optional)"
              hint="Secondary vision-capable model; empty = none"
              className="col-span-2"
            >
              <input
                className={`${inputClass} font-mono text-xs`}
                value={form.visionModel}
                onChange={(e) => set("visionModel", e.target.value)}
                list="agent-vision-model-options"
                placeholder="e.g. a vision-capable model id — empty = none"
              />
            </Field>
            {/* ROUND-93 (R93-A8): config-fed datalists for the free-text
                model inputs above (the catalog-fed ones are retired — the
                suggestions are exactly the user's configured rows now).
                value = the exact modelId (what gets pasted); the selected
                provider's rows come first, other providers' rows are
                labeled "provider: model-id" so a cross-provider pick is
                never mistaken for a local one. */}
            <datalist id="agent-model-options">
              {modelSuggestions.map((m) => (
                <option key={`${m.providerId}:${m.modelId}`} value={m.modelId}>
                  {form.providerId.trim() !== "" && m.providerId === form.providerId.trim()
                    ? m.displayName || m.modelId
                    : `${m.providerId}: ${m.modelId}`}
                </option>
              ))}
            </datalist>
            <datalist id="agent-vision-model-options">
              {visionSuggestions.map((m) => (
                <option key={`${m.providerId}:${m.modelId}`} value={m.modelId}>
                  {form.providerId.trim() !== "" && m.providerId === form.providerId.trim()
                    ? m.displayName || m.modelId
                    : `${m.providerId}: ${m.modelId}`}
                </option>
              ))}
            </datalist>

            <SectionLabel>Behavior</SectionLabel>
            {/* R93-A8: the system prompt gets REAL room to breathe — a
                min-h-[160px] mono textarea (was a 72px sliver) with the
                app's input chrome; it is the main thing an agent IS. */}
            <Field label="System prompt" className="col-span-2">
              <textarea
                className={`${inputClass} min-h-[160px] resize-y rounded-[14px] font-mono text-xs leading-relaxed`}
                value={form.systemPrompt}
                onChange={(e) => set("systemPrompt", e.target.value)}
                placeholder="You write precise, minimal diffs…"
              />
            </Field>
            <Field
              label="Memory policy"
              hint="Governs the memory digest injection + the memory tools (R117-b)"
            >
              <select
                className={inputClass}
                value={form.memoryPolicy}
                onChange={(e) => set("memoryPolicy", e.target.value as MemoryPolicy)}
              >
                {MEMORY_POLICIES.map((m) => (
                  <option key={m} value={m}>
                    {MEMORY_POLICY_LABELS[m]}
                  </option>
                ))}
              </select>
            </Field>

            <SectionLabel>Capabilities</SectionLabel>
            <Field label="Allowed tools" hint="Empty = all tools (ADR-0019)" className="col-span-2">
              <div className="grid grid-cols-3 gap-1.5">
                {TOOL_CATALOG.map((tool) => (
                  <label
                    key={tool}
                    className="flex cursor-pointer items-center gap-2 rounded-lg border-[1.5px] border-line bg-input px-2.5 py-1.5 text-[11px] font-medium"
                  >
                    <input
                      type="checkbox"
                      className="accent-accent"
                      checked={form.allowedTools.includes(tool)}
                      onChange={(e) => toggleTool(tool, e.target.checked)}
                    />
                    <span className="font-mono text-[10.5px]">{tool}</span>
                  </label>
                ))}
              </div>
            </Field>

            <Field label="Skills" className="col-span-2">
              <div className="flex flex-wrap items-center gap-1.5 rounded-lg border-[1.5px] border-line bg-input px-2 py-1.5">
                {form.skills.map((skill) => (
                  <Badge key={skill} tone="accent">
                    {skill}
                    <button
                      type="button"
                      aria-label={`Remove skill ${skill}`}
                      className="cursor-pointer"
                      onClick={() => set("skills", form.skills.filter((s) => s !== skill))}
                    >
                      <X size={9} />
                    </button>
                  </Badge>
                ))}
                <input
                  className="min-w-[120px] flex-1 bg-transparent py-0.5 text-[12px] text-ink outline-none placeholder:text-muted/70"
                  value={skillInput}
                  onChange={(e) => setSkillInput(e.target.value)}
                  onKeyDown={onSkillKeyDown}
                  onBlur={() => skillInput && addSkill(skillInput)}
                  placeholder="type and press Enter…"
                />
              </div>
            </Field>

            <SectionLabel>Advanced</SectionLabel>
            <Field label="Max turns" hint={fieldErrors.maxTurns}>
              <input
                type="number"
                min={1}
                step={1}
                className={inputClass}
                value={form.maxTurns}
                onChange={(e) => set("maxTurns", e.target.value)}
              />
            </Field>
            <Field label="Temperature" hint={fieldErrors.temperature}>
              <input
                type="number"
                min={0}
                max={2}
                step={0.1}
                className={inputClass}
                value={form.temperature}
                onChange={(e) => set("temperature", e.target.value)}
              />
            </Field>
          </div>

          {error ? (
            <p role="alert" className="mx-5 mb-2 rounded-lg bg-red-500/10 px-3 py-2 text-[11px] text-red-500">
              {error}
            </p>
          ) : null}

          <div className="flex justify-end gap-2 border-t-[1.5px] border-line px-5 py-3.5">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={submitting}>
              {submitting ? "Saving…" : agent ? "Save changes" : "Create agent"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
