import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { invoke } from "@tauri-apps/api/core";
import {
  AGENT_PROFILE_TEMPLATES,
  type AgentProfile,
  type AgentProfileListResult,
  TOOL_POLICY_PRESET_DETAILS,
  type ToolPolicyPreset,
} from "@tessera/contracts";
import { Bot, Loader2, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

type DraftState = {
  templateId: string | undefined;
  name: string;
  description: string;
  instructions: string;
  soul: string;
  userContext: string;
  toolPolicyPreset: ToolPolicyPreset;
  memoryDefaults: string;
};

function draftFromProfile(profile: AgentProfile | null): DraftState {
  return {
    templateId: profile?.templateId,
    name: profile?.name ?? "",
    description: profile?.description ?? "",
    instructions: profile?.instructions ?? "",
    soul: profile?.soul ?? "",
    userContext: profile?.userContext ?? "",
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
      instructions: "",
      soul: "",
      userContext: "",
      toolPolicyPreset: "workspace_editor",
      memoryDefaults: "",
    };
  }

  return {
    templateId: template.id,
    name: template.profile.name,
    description: template.profile.description ?? "",
    instructions: template.profile.instructions,
    soul: template.profile.soul,
    userContext: template.profile.userContext,
    toolPolicyPreset: template.profile.toolPolicyPreset,
    memoryDefaults: template.profile.memoryDefaults,
  };
}

export function AgentSettingsView() {
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadProfiles = useCallback(async () => {
    setLoading(true);
    try {
      const result = await invoke<AgentProfileListResult>("agent_profile_list");
      setProfiles(result.profiles);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  const selectedProfile = profiles.find((profile) => profile.id === selectedId) || null;

  return (
    <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col px-8 py-6">
      <div className="flex items-start justify-between gap-4 border-b border-border pb-5">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-foreground">Agents</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Author structured agent profiles with named sections, preset access policy, and reusable
            templates.
          </p>
        </div>
        <Button
          type="button"
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
                  ? "border-primary bg-accent text-accent-foreground"
                  : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <div className="text-sm font-medium">{profile.name}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {TOOL_POLICY_PRESET_DETAILS[profile.toolPolicyPreset].label}
              </div>
            </button>
          ))}
          {selectedId === "new" && (
            <div className="rounded-xl border border-primary bg-accent px-3 py-3 text-sm font-medium text-accent-foreground">
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
  onSaved,
  onDeleted,
}: {
  profile: AgentProfile | null;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const [draft, setDraft] = useState<DraftState>(() => draftFromProfile(profile));
  const [templateChosen, setTemplateChosen] = useState(Boolean(profile));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(draftFromProfile(profile));
    setTemplateChosen(Boolean(profile));
    setError(null);
  }, [profile]);

  function updateDraft<K extends keyof DraftState>(key: K, value: DraftState[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  const canSave = draft.name.trim().length > 0 && templateChosen && !busy;

  async function handleSave() {
    if (!canSave) return;
    setBusy(true);
    setError(null);

    const request = {
      name: draft.name.trim(),
      description: draft.description.trim() || undefined,
      templateId: draft.templateId,
      instructions: draft.instructions.trim(),
      soul: draft.soul.trim(),
      userContext: draft.userContext.trim(),
      toolPolicyPreset: draft.toolPolicyPreset,
      memoryDefaults: draft.memoryDefaults.trim(),
    };

    try {
      if (profile) {
        await invoke("agent_profile_update", {
          id: profile.id,
          request,
        });
      } else {
        await invoke("agent_profile_create", {
          request: {
            ...request,
            model: { mode: "default" },
          },
        });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!profile) return;
    if (!confirm(`Are you sure you want to delete the agent "${profile.name}"?`)) return;

    setBusy(true);
    setError(null);
    try {
      await invoke("agent_profile_delete", { id: profile.id });
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
              className="rounded-2xl border border-border bg-card p-5 text-left transition-colors hover:border-primary/30 hover:bg-accent"
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
            disabled={busy}
            placeholder="e.g. Operations Partner"
            onChange={(event) => updateDraft("name", event.target.value)}
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium text-foreground">Description</span>
          <input
            className="input mt-2"
            value={draft.description}
            disabled={busy}
            placeholder="Optional short description"
            onChange={(event) => updateDraft("description", event.target.value)}
          />
        </label>
      </div>

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
          Save Agent
        </Button>

        {profile && (
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
    <label className="block rounded-2xl border border-border bg-muted/20 p-4">
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
