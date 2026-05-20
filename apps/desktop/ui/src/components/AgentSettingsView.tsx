import { Button } from "@/components/ui/button";
import {
  MODEL_PROVIDERS,
  defaultDraftForProvider,
  modelOptionsForProvider,
  modelPlaceholderForProvider,
  providerLabel,
} from "@/lib/modelSettings";
import { cn } from "@/lib/utils";
import { invoke } from "@tauri-apps/api/core";
import {
  AGENT_PROFILE_TEMPLATES,
  type AgentModelSelection,
  type AgentProfile,
  type AgentProfileListResult,
  type AgentProviderConfig,
  type ModelProvider,
  type SkillListResult,
  type SkillSummary,
  TOOL_POLICY_PRESET_DETAILS,
  type ThinkingLevel,
  type ToolPolicyPreset,
} from "@tessera/contracts";
import { Bot, Loader2, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

type DraftState = {
  templateId: string | undefined;
  name: string;
  description: string;
  model: AgentModelSelection;
  instructions: string;
  soul: string;
  userContext: string;
  skills: string[];
  toolPolicyPreset: ToolPolicyPreset;
  memoryDefaults: string;
};

const THINKING_LEVEL_OPTIONS: Array<{
  label: string;
  value: ThinkingLevel;
}> = [
  { label: "Off", value: "off" },
  { label: "Minimal", value: "minimal" },
  { label: "Low", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High", value: "high" },
  { label: "X-High", value: "xhigh" },
];

function draftFromProfile(profile: AgentProfile | null): DraftState {
  return {
    templateId: profile?.templateId,
    name: profile?.name ?? "",
    description: profile?.description ?? "",
    model: profile?.model ?? { mode: "default" },
    instructions: profile?.instructions ?? "",
    soul: profile?.soul ?? "",
    userContext: profile?.userContext ?? "",
    skills: profile?.skills ?? [],
    toolPolicyPreset: profile?.toolPolicyPreset ?? "workspace_editor",
    memoryDefaults: profile?.memoryDefaults ?? "",
  };
}

function draftFromTemplate(templateId: string): DraftState {
  const template = AGENT_PROFILE_TEMPLATES.find((item) => item.id === templateId);
  if (!template) {
    return {
      templateId,
      name: "",
      description: "",
      model: { mode: "default" },
      instructions: "",
      soul: "",
      userContext: "",
      skills: [],
      toolPolicyPreset: "workspace_editor",
      memoryDefaults: "",
    };
  }

  return {
    templateId: template.id,
    name: template.profile.name,
    description: template.profile.description ?? "",
    model: { mode: "default" },
    instructions: template.profile.instructions,
    soul: template.profile.soul,
    userContext: template.profile.userContext,
    skills: template.profile.skills ?? [],
    toolPolicyPreset: template.profile.toolPolicyPreset,
    memoryDefaults: template.profile.memoryDefaults,
  };
}

function modelSummary(model: AgentModelSelection): string {
  if (model.mode === "default") return "Inherits Settings default";
  const thinking =
    "thinkingLevel" in model.provider && model.provider.thinkingLevel
      ? ` / Thinking ${model.provider.thinkingLevel}`
      : "";
  return `${providerLabel(model.provider.provider)} / ${model.provider.model}${thinking}`;
}

function modelProvider(model: AgentModelSelection): AgentProviderConfig {
  return model.mode === "override" ? model.provider : defaultDraftForProvider("openai");
}

function providerSupportsThinking(
  provider: AgentProviderConfig
): provider is Exclude<AgentProviderConfig, { provider: "local" }> {
  return provider.provider !== "local";
}

interface AgentSettingsViewProps {
  userKey: string;
}

export function AgentSettingsView({ userKey }: AgentSettingsViewProps) {
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadProfiles = useCallback(async () => {
    setLoading(true);
    try {
      const result = await invoke<AgentProfileListResult>("agent_profile_list", { userKey });
      setProfiles(result.profiles);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [userKey]);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  const selectedProfile = profiles.find((profile) => profile.id === selectedId) || null;

  return (
    <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col px-8 py-6">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-5 pr-44">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-foreground">Agents</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Author structured agent profiles with named sections, preset access policy, and reusable
            templates.
          </p>
        </div>
        <Button
          type="button"
          className="shrink-0"
          onClick={() => setSelectedId("new")}
          disabled={loading || selectedId === "new"}
        >
          <Plus size={16} className="mr-2" />
          New Agent
        </Button>
      </div>

      <div className="mt-6 flex gap-6">
        <div className="w-72 shrink-0 space-y-2 border-r border-border pr-4">
          {loading && <Loader2 size={16} className="animate-spin text-muted-foreground" />}
          {!loading && profiles.length === 0 && (
            <div className="text-sm text-muted-foreground">No custom agents yet.</div>
          )}
          {profiles.map((profile) => (
            <button
              key={profile.id}
              type="button"
              onClick={() => setSelectedId(profile.id)}
              className={cn(
                "w-full rounded-xl border px-3 py-3 text-left transition-colors",
                selectedId === profile.id
                  ? "border-primary/30 bg-secondary text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
              )}
            >
              <div className="text-sm font-medium">{profile.name}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {TOOL_POLICY_PRESET_DETAILS[profile.toolPolicyPreset].label}
              </div>
              <div className="mt-1 truncate text-xs text-muted-foreground">
                {modelSummary(profile.model)}
              </div>
            </button>
          ))}
          {selectedId === "new" && (
            <div className="rounded-xl border border-primary/30 bg-secondary px-3 py-3 text-sm font-medium text-foreground">
              New Agent
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          {error && (
            <div className="mb-4 rounded-xl border border-destructive/25 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          {selectedProfile || selectedId === "new" ? (
            <AgentEditor
              profile={selectedProfile}
              userKey={userKey}
              onSaved={() => {
                void loadProfiles();
                setSelectedId(null);
              }}
              onDeleted={() => {
                void loadProfiles();
                setSelectedId(null);
              }}
            />
          ) : (
            <div className="mt-12 text-center text-sm text-muted-foreground">
              Select an agent to edit, or start from a built-in template.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AgentEditor({
  profile,
  userKey,
  onSaved,
  onDeleted,
}: {
  profile: AgentProfile | null;
  userKey: string;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const [draft, setDraft] = useState<DraftState>(() => draftFromProfile(profile));
  const [templateChosen, setTemplateChosen] = useState(Boolean(profile));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const isDefaultProfile = profile?.id === "default";

  useEffect(() => {
    setDraft(draftFromProfile(profile));
    setTemplateChosen(Boolean(profile));
    setError(null);
  }, [profile]);

  useEffect(() => {
    invoke<SkillListResult>("skill_list", { userKey })
      .then((result) => setSkills(result.skills))
      .catch(() => setSkills([]));
  }, [userKey]);

  function updateDraft<K extends keyof DraftState>(key: K, value: DraftState[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  const canSave = (isDefaultProfile || draft.name.trim().length > 0) && templateChosen && !busy;

  async function handleSave() {
    if (!canSave) return;
    setBusy(true);
    setError(null);

    const request = {
      ...(!isDefaultProfile
        ? {
            name: draft.name.trim(),
            description: draft.description.trim() || undefined,
            templateId: draft.templateId,
          }
        : {}),
      instructions: draft.instructions.trim(),
      model: draft.model,
      soul: draft.soul.trim(),
      userContext: draft.userContext.trim(),
      skills: draft.skills,
      toolPolicyPreset: draft.toolPolicyPreset,
      memoryDefaults: draft.memoryDefaults.trim(),
    };

    try {
      if (profile) {
        await invoke("agent_profile_update", {
          id: profile.id,
          request,
          userKey,
        });
      } else {
        await invoke("agent_profile_create", {
          request: {
            ...request,
          },
          userKey,
        });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleReset() {
    if (!profile || !isDefaultProfile) return;
    if (!confirm("Reset Tessera to the shipped default profile?")) return;

    setBusy(true);
    setError(null);
    try {
      await invoke("agent_profile_reset", { id: profile.id, userKey });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!profile) return;
    if (!confirm(`Are you sure you want to delete the agent "${profile.name}"?`)) return;

    setBusy(true);
    setError(null);
    try {
      await invoke("agent_profile_delete", { id: profile.id, userKey });
      onDeleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  if (!templateChosen && !profile) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Choose a template</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Start from a structured profile instead of a blank prompt.
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {AGENT_PROFILE_TEMPLATES.map((template) => (
            <button
              key={template.id}
              type="button"
              className="rounded-2xl border border-border bg-background p-5 text-left transition-colors hover:border-primary/30 hover:bg-secondary/40"
              onClick={() => {
                setDraft(draftFromTemplate(template.id));
                setTemplateChosen(true);
              }}
            >
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Bot size={16} className="text-primary" />
                {template.name}
              </div>
              <p className="mt-2 text-sm text-muted-foreground">{template.description}</p>
              <div className="mt-4 text-xs text-muted-foreground">
                {TOOL_POLICY_PRESET_DETAILS[template.profile.toolPolicyPreset].label}
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-xl border border-destructive/25 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {!profile && (
        <button
          type="button"
          className="text-sm text-muted-foreground hover:text-foreground"
          onClick={() => setTemplateChosen(false)}
          disabled={busy}
        >
          Change template
        </button>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <label className="block">
          <span className="text-sm font-medium text-foreground">Name</span>
          <input
            className="input mt-2"
            value={draft.name}
            disabled={busy || isDefaultProfile}
            placeholder="e.g. Operations Partner"
            onChange={(event) => updateDraft("name", event.target.value)}
          />
          {isDefaultProfile && (
            <p className="mt-2 text-xs text-muted-foreground">
              Tessera is the protected default profile.
            </p>
          )}
        </label>

        <label className="block">
          <span className="text-sm font-medium text-foreground">Description</span>
          <input
            className="input mt-2"
            value={draft.description}
            disabled={busy || isDefaultProfile}
            placeholder="Optional short description"
            onChange={(event) => updateDraft("description", event.target.value)}
          />
          {isDefaultProfile && (
            <p className="mt-2 text-xs text-muted-foreground">
              Model: inherits the Settings default.
            </p>
          )}
        </label>
      </div>

      <ModelField
        model={draft.model}
        disabled={busy}
        onChange={(model) => updateDraft("model", model)}
      />

      <label className="block">
        <span className="text-sm font-medium text-foreground">Tool Policy</span>
        <p className="mb-2 mt-1 text-xs text-muted-foreground">
          Pick the business-friendly capability preset instead of raw tool wiring.
        </p>
        <select
          className="input"
          value={draft.toolPolicyPreset}
          disabled={busy}
          onChange={(event) =>
            updateDraft("toolPolicyPreset", event.target.value as ToolPolicyPreset)
          }
        >
          {Object.entries(TOOL_POLICY_PRESET_DETAILS).map(([preset, details]) => (
            <option key={preset} value={preset}>
              {details.label}
            </option>
          ))}
        </select>
        <p className="mt-2 text-xs text-muted-foreground">
          {TOOL_POLICY_PRESET_DETAILS[draft.toolPolicyPreset].summary}
        </p>
      </label>

      <SectionField
        label="Instructions"
        hint="Operating contract, constraints, and work rules."
        placeholder="Turn broad requests into concrete deliverables with explicit next steps."
        value={draft.instructions}
        disabled={busy}
        onChange={(value) => updateDraft("instructions", value)}
      />

      <SectionField
        label="Soul"
        hint="Tone, stance, brevity, and stylistic expectations."
        placeholder="Brief, direct, and calm. Avoid filler."
        value={draft.soul}
        disabled={busy}
        onChange={(value) => updateDraft("soul", value)}
      />

      <SectionField
        label="User Context"
        hint="Who this agent serves and the domain assumptions it should carry."
        placeholder="This agent supports an operations leader shipping internal plans and stakeholder updates."
        value={draft.userContext}
        disabled={busy}
        onChange={(value) => updateDraft("userContext", value)}
      />

      <SkillPicker
        skills={skills}
        selected={draft.skills}
        disabled={busy}
        onChange={(selected) => updateDraft("skills", selected)}
      />

      <SectionField
        label="Memory Defaults"
        hint="Static authored preferences and reusable non-secret context."
        placeholder="Reuse the weekly update format and established project names when available."
        value={draft.memoryDefaults}
        disabled={busy}
        onChange={(value) => updateDraft("memoryDefaults", value)}
      />

      <div className="flex items-center justify-between pt-4">
        <Button onClick={handleSave} disabled={!canSave}>
          {busy && <Loader2 size={16} className="mr-2 animate-spin" />}
          {isDefaultProfile ? "Save Tessera" : "Save Agent"}
        </Button>

        {isDefaultProfile && (
          <Button variant="ghost" onClick={handleReset} disabled={busy}>
            <RotateCcw size={16} className="mr-2" />
            Reset to Default
          </Button>
        )}

        {profile && !isDefaultProfile && (
          <Button
            variant="ghost"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={handleDelete}
            disabled={busy}
          >
            <Trash2 size={16} className="mr-2" />
            Delete Agent
          </Button>
        )}
      </div>
    </div>
  );
}

function sourceLabel(skill: SkillSummary): string {
  if (skill.source === "external") {
    return skill.externalProvider === "claude-code" ? "Claude Code" : "Codex";
  }
  if (skill.source === "curated") return "Built-in";
  if (skill.source === "workspace") return "Workspace";
  return "User";
}

function ModelField({
  model,
  disabled,
  onChange,
}: {
  model: AgentModelSelection;
  disabled: boolean;
  onChange: (model: AgentModelSelection) => void;
}) {
  const provider = modelProvider(model);

  function updateProvider(nextProvider: ModelProvider) {
    onChange({
      mode: "override",
      provider: defaultDraftForProvider(nextProvider),
    });
  }

  function updateModel(value: string) {
    onChange({
      mode: "override",
      provider: {
        ...provider,
        model: value,
      } as AgentProviderConfig,
    });
  }

  function updateBaseUrl(value: string) {
    if (provider.provider !== "local") return;
    onChange({
      mode: "override",
      provider: {
        ...provider,
        baseUrl: value,
      },
    });
  }

  function updateThinkingLevel(value: ThinkingLevel) {
    if (!providerSupportsThinking(provider)) return;
    const { thinkingLevel: _thinkingLevel, ...providerWithoutThinking } = provider;
    onChange({
      mode: "override",
      provider:
        value === "off"
          ? (providerWithoutThinking as AgentProviderConfig)
          : ({
              ...provider,
              thinkingLevel: value,
            } as AgentProviderConfig),
    });
  }

  return (
    <section className="rounded-2xl border border-border bg-secondary/20 p-4">
      <div className="text-sm font-medium text-foreground">Model</div>
      <p className="mt-1 text-xs text-muted-foreground">
        Choose whether this agent inherits Settings or always uses a specific provider and model.
      </p>

      <div className="mt-4 grid gap-2 md:grid-cols-2">
        <label className="flex items-start gap-3 rounded-lg border border-border bg-background px-3 py-2">
          <input
            type="radio"
            aria-label="Inherit Settings default"
            className="mt-1"
            checked={model.mode === "default"}
            disabled={disabled}
            onChange={() => onChange({ mode: "default" })}
          />
          <span>
            <span className="block text-sm font-medium text-foreground">
              Inherit Settings default
            </span>
            <span className="mt-1 block text-xs text-muted-foreground">
              Uses the app default from Settings - Model.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-3 rounded-lg border border-border bg-background px-3 py-2">
          <input
            type="radio"
            aria-label="Use custom model"
            className="mt-1"
            checked={model.mode === "override"}
            disabled={disabled}
            onChange={() =>
              onChange({
                mode: "override",
                provider,
              })
            }
          />
          <span>
            <span className="block text-sm font-medium text-foreground">Use custom model</span>
            <span className="mt-1 block text-xs text-muted-foreground">
              Credentials still come from Settings.
            </span>
          </span>
        </label>
      </div>

      {model.mode === "override" && (
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="block">
            <span className="text-sm font-medium text-foreground">Provider</span>
            <select
              className="input mt-2"
              value={provider.provider}
              disabled={disabled}
              onChange={(event) => updateProvider(event.target.value as ModelProvider)}
            >
              {MODEL_PROVIDERS.map((option) => (
                <option key={option} value={option}>
                  {providerLabel(option)}
                </option>
              ))}
            </select>
          </label>

          <div className="block">
            <label htmlFor="agent-model" className="text-sm font-medium text-foreground">
              Model
            </label>
            {modelOptionsForProvider(provider.provider, provider.model).length > 0 ? (
              <select
                id="agent-model"
                className="input mt-2"
                value={provider.model}
                disabled={disabled}
                onChange={(event) => updateModel(event.target.value)}
              >
                {modelOptionsForProvider(provider.provider, provider.model).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="agent-model"
                className="input mt-2"
                value={provider.model}
                disabled={disabled}
                placeholder={modelPlaceholderForProvider(provider.provider)}
                onInput={(event) => updateModel(event.currentTarget.value)}
                onChange={(event) => updateModel(event.target.value)}
              />
            )}
          </div>

          {provider.provider === "local" && (
            <label className="block md:col-span-2">
              <span className="text-sm font-medium text-foreground">Base URL</span>
              <input
                className="input mt-2"
                value={provider.baseUrl}
                disabled={disabled}
                placeholder="http://127.0.0.1:11434/v1"
                onInput={(event) => updateBaseUrl(event.currentTarget.value)}
                onChange={(event) => updateBaseUrl(event.target.value)}
              />
            </label>
          )}

          {providerSupportsThinking(provider) && (
            <label className="block md:col-span-2">
              <span className="text-sm font-medium text-foreground">Thinking level</span>
              <select
                aria-label="Thinking level"
                className="input mt-2"
                value={"thinkingLevel" in provider ? (provider.thinkingLevel ?? "off") : "off"}
                disabled={disabled}
                onChange={(event) => updateThinkingLevel(event.target.value as ThinkingLevel)}
              >
                {THINKING_LEVEL_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span className="mt-2 block text-xs text-muted-foreground">
                Used only by providers and models that support reasoning effort.
              </span>
            </label>
          )}

          <p className="text-xs text-muted-foreground md:col-span-2">
            This agent will use {providerLabel(provider.provider)} / {provider.model || "model"}.
            Provider credentials are managed in Settings - Model.
          </p>
        </div>
      )}
    </section>
  );
}

function SkillPicker({
  skills,
  selected,
  disabled,
  onChange,
}: {
  skills: SkillSummary[];
  selected: string[];
  disabled: boolean;
  onChange: (selected: string[]) => void;
}) {
  const selectedSet = new Set(selected);

  function toggle(skillId: string) {
    if (selectedSet.has(skillId)) {
      onChange(selected.filter((id) => id !== skillId));
    } else {
      onChange([...selected, skillId]);
    }
  }

  return (
    <div className="rounded-2xl border border-border bg-secondary/20 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-foreground">Skills</div>
          <p className="mt-1 text-xs text-muted-foreground">
            Enable procedural instruction bundles for this agent.
          </p>
        </div>
        <div className="text-xs text-muted-foreground">{selected.length} selected</div>
      </div>

      {skills.length === 0 ? (
        <div className="mt-4 text-sm text-muted-foreground">No local skills found.</div>
      ) : (
        <div className="mt-4 grid gap-2">
          {skills.map((skill) => (
            <label
              key={skill.id}
              className="flex items-start gap-3 rounded-lg border border-border bg-background px-3 py-2"
            >
              <input
                type="checkbox"
                className="mt-1"
                checked={selectedSet.has(skill.id)}
                disabled={disabled}
                onChange={() => toggle(skill.id)}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                  {skill.name}
                  <span className="rounded border border-border px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground">
                    {sourceLabel(skill)}
                  </span>
                  {skill.conflict && (
                    <span className="text-[11px] font-normal text-amber-600">Shadowing</span>
                  )}
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {skill.description}
                </span>
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function SectionField({
  label,
  hint,
  placeholder,
  value,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  placeholder: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block rounded-2xl border border-border bg-secondary/20 p-4">
      <span className="text-sm font-medium text-foreground">{label}</span>
      <p className="mb-3 mt-1 text-xs text-muted-foreground">{hint}</p>
      <textarea
        className="input min-h-28 resize-y"
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
