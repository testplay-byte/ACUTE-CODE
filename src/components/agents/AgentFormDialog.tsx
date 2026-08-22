import { useMemo, useState, type FormEvent, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import type { Agent, AgentDraft } from "../../lib/api";
import { PROVIDER_IDS, TOOL_CATALOG } from "../../lib/api";
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
  allowedTools: ["file_read"],
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

            <Field label="Provider">
              <select
                className={inputClass}
                value={form.providerId}
                onChange={(e) => set("providerId", e.target.value)}
              >
                {PROVIDER_IDS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Model" hint={fieldErrors.model}>
              <input
                className={`${inputClass} font-mono text-xs`}
                value={form.model}
                onChange={(e) => set("model", e.target.value)}
                placeholder="openrouter/ox-alpha"
              />
            </Field>

            <Field label="Vision model (optional)" hint="Secondary vision-capable model; empty = none">
              <input
                className={`${inputClass} font-mono text-xs`}
                value={form.visionModel}
                onChange={(e) => set("visionModel", e.target.value)}
                placeholder="null"
              />
            </Field>
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
