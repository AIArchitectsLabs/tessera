import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { invoke } from "@tauri-apps/api/core";
import type { AgentProfile, AgentProfileListResult } from "@tessera/contracts";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

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

  const selectedProfile = profiles.find((p) => p.id === selectedId) || null;

  return (
    <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col px-8 py-6">
      <div className="flex items-start justify-between gap-4 border-b border-border pb-5">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-foreground">Agents</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Configure agent personas, instructions, and tools.
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
        <div className="w-64 shrink-0 space-y-2 border-r border-border pr-4">
          {loading && <Loader2 size={16} className="animate-spin text-muted-foreground" />}
          {!loading && profiles.length === 0 && (
            <div className="text-sm text-muted-foreground">No custom agents.</div>
          )}
          {profiles.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setSelectedId(p.id)}
              className={cn(
                "w-full rounded-lg px-3 py-2 text-left text-sm transition-colors",
                selectedId === p.id
                  ? "bg-secondary text-foreground font-medium"
                  : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
              )}
            >
              {p.name}
            </button>
          ))}
          {selectedId === "new" && (
            <button
              type="button"
              className="w-full rounded-lg px-3 py-2 text-left text-sm transition-colors bg-secondary text-foreground font-medium"
            >
              New Agent
            </button>
          )}
        </div>

        <div className="flex-1 min-w-0">
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
            <div className="text-center text-sm text-muted-foreground mt-12">
              Select an agent to edit, or create a new one.
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
  const [name, setName] = useState(profile?.name || "");
  const [description, setDescription] = useState(profile?.description || "");
  const [instructions, setInstructions] = useState(profile?.instructions || "");
  const [soul, setSoul] = useState(profile?.soul || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // When profile prop changes, update state
  useEffect(() => {
    setName(profile?.name || "");
    setDescription(profile?.description || "");
    setInstructions(profile?.instructions || "");
    setSoul(profile?.soul || "");
    setError(null);
  }, [profile]);

  const canSave = name.trim().length > 0 && !busy;

  async function handleSave() {
    if (!canSave) return;
    setBusy(true);
    setError(null);

    try {
      if (profile) {
        await invoke("agent_profile_update", {
          id: profile.id,
          request: {
            name: name.trim(),
            description: description.trim() || undefined,
            instructions: instructions.trim() || undefined,
            soul: soul.trim() || undefined,
          },
        });
      } else {
        await invoke("agent_profile_create", {
          request: {
            name: name.trim(),
            description: description.trim() || undefined,
            instructions: instructions.trim() || undefined,
            soul: soul.trim() || undefined,
            model: { mode: "default" }, // UI doesn't support model override yet per simplified design
            skills: [],
            tools: [
              "workspace_read",
              "workspace_list",
              "workspace_search",
              "workspace_write",
              "workspace_edit",
            ],
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

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-xl border border-destructive/25 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <label className="block">
        <span className="text-sm font-medium text-foreground">Name</span>
        <input
          className="input mt-2"
          value={name}
          disabled={busy}
          placeholder="e.g. Frontend Specialist"
          onChange={(e) => setName(e.target.value)}
        />
      </label>

      <label className="block">
        <span className="text-sm font-medium text-foreground">Description</span>
        <input
          className="input mt-2"
          value={description}
          disabled={busy}
          placeholder="Optional short description"
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>

      <label className="block">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-foreground">Instructions (AGENTS.md)</span>
        </div>
        <p className="text-xs text-muted-foreground mt-1 mb-2">
          Primary directives and context for this agent.
        </p>
        <textarea
          className="input min-h-32 resize-y"
          value={instructions}
          disabled={busy}
          placeholder="You are a frontend expert. Use React and Tailwind CSS."
          onChange={(e) => setInstructions(e.target.value)}
        />
      </label>

      <label className="block">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-foreground">Soul (SOUL.md)</span>
        </div>
        <p className="text-xs text-muted-foreground mt-1 mb-2">
          Personality, tone, and stylistic constraints.
        </p>
        <textarea
          className="input min-h-32 resize-y"
          value={soul}
          disabled={busy}
          placeholder="Be concise. Do not use filler words."
          onChange={(e) => setSoul(e.target.value)}
        />
      </label>

      <div className="flex items-center justify-between pt-4">
        <Button onClick={handleSave} disabled={!canSave}>
          {busy && <Loader2 size={16} className="animate-spin mr-2" />}
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
