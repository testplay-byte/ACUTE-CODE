import { useMemo, useState, type FormEvent, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import type { Agent, AgentDraft } from "../../lib/api";
import {
  PROVIDER_IDS,
  TOOL_CATALOG,
  fetchModelsCatalog,
  fetchProviders,
} from "../../lib/api";
import type { MemoryPolicy } from "shared";
import { Dialog, DialogContent, DialogHeader } from "../ui/dialog";
import { Badge, Button, Field, inputClass } from "../ui/controls";

const MEMORY_POLICIES: MemoryPolicy[] = ["none", "on-start", "every-turn"];

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
    providerId: agent.providerId,
    model: agent.model,
    visionModel: agent.visionModel ?? "",
    memoryPolicy: agent.memoryPolicy,
    allowedTools: [...agent.allowedTools],
    skills: [...agent.skills],
    maxTurns: String(agent.maxTurns),
    temperature: String(agent.temperature),
  };
}

/** Convert loose form state into the strict AgentDraft (API.md §4.2 payload). */
function toDraft(s: FormState): AgentDraft {
  return {
    name: s.name.trim(),
    role: s.role.trim(),
    systemPrompt: s.systemPrompt,
    providerId: s.providerId,
    model: s.model.trim(),
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
  const selectionVisible = providerOptions.some((o) => o.id === form.providerId);

  // ROUND-47 (R47-c2): the model inputs stay FREE-TEXT (custom models must
  // remain enterable) but gain <datalist> suggestions fed by the served
  // catalog (GET /models/catalog) — free models first, then paid. The
  // suggestion VALUE is the exact modelId, so picking one pastes the
  // unambiguous id; the label shows the human name + tier. Fails soft:
  // unreachable catalog ⇒ no suggestions, inputs keep working.
  const catalogQuery = useQuery({
    queryKey: ["models-catalog"],
    queryFn: fetchModelsCatalog,
    enabled: open,
    staleTime: 10 * 60 * 1000, // constants on the wire — generous
    retry: false,
  });
  const modelSuggestions = useMemo(() => {
    const models = catalogQuery.data?.models ?? [];
    return [...models.filter((m) => m.free), ...models.filter((m) => !m.free)];
  }, [catalogQuery.data]);
  const visionSuggestions = useMemo(
    () => modelSuggestions.filter((m) => m.supportsVision),
    [modelSuggestions],
  );

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
    if (!form.model.trim()) errs.model = "Model is required";
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
          <div className="grid min-h-0 flex-1 grid-cols-2 gap-3.5 overflow-y-auto px-5 py-4">
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

            <Field label="System prompt" className="col-span-2">
              <textarea
                className={`${inputClass} min-h-[72px] resize-y`}
                value={form.systemPrompt}
                onChange={(e) => set("systemPrompt", e.target.value)}
                placeholder="You write precise, minimal diffs…"
              />
            </Field>

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
                {providerOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name === p.id ? p.id : `${p.name} (${p.id})`}
                  </option>
                ))}
                {!selectionVisible && <option value={form.providerId}>{form.providerId}</option>}
              </select>
            </Field>
            <Field label="Model" hint={fieldErrors.model}>
              <input
                className={`${inputClass} font-mono text-xs`}
                value={form.model}
                onChange={(e) => set("model", e.target.value)}
                list="agent-model-options"
                // The LIVE default model id once the catalog lands; the known
                // current id before that. The old placeholder advertised the
                // dead openrouter/ox-alpha (deleted upstream) — never again.
                placeholder={catalogQuery.data?.defaultModelId ?? "z-ai/glm-5.2:free"}
              />
            </Field>

            <Field label="Vision model (optional)" hint="Secondary vision-capable model; empty = none">
              <input
                className={`${inputClass} font-mono text-xs`}
                value={form.visionModel}
                onChange={(e) => set("visionModel", e.target.value)}
                list="agent-vision-model-options"
                placeholder="e.g. google/gemma-4-31b-it:free — empty = none"
              />
            </Field>

            {/* ROUND-47 (R47-c2): catalog-fed datalists for the free-text model
                inputs above. value = the exact modelId (what gets pasted);
                label = displayName + tier so suggestions read at a glance. */}
            <datalist id="agent-model-options">
              {modelSuggestions.map((m) => (
                <option key={m.modelId} value={m.modelId}>
                  {`${m.displayName} (${m.free ? "free" : "paid"})`}
                </option>
              ))}
            </datalist>
            <datalist id="agent-vision-model-options">
              {visionSuggestions.map((m) => (
                <option key={m.modelId} value={m.modelId}>
                  {`${m.displayName} (${m.free ? "free" : "paid"}, vision)`}
                </option>
              ))}
            </datalist>
            <Field label="Memory policy">
              <select
                className={inputClass}
                value={form.memoryPolicy}
                onChange={(e) => set("memoryPolicy", e.target.value as MemoryPolicy)}
              >
                {MEMORY_POLICIES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Allowed tools" className="col-span-2">
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
