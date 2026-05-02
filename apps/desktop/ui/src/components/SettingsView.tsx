import { Button } from "@/components/ui/button";
import {
  MODEL_PROVIDERS,
  defaultDraftForProvider,
  modelPlaceholderForProvider,
  providerLabel,
  shouldSendCredential,
} from "@/lib/modelSettings";
import { cn } from "@/lib/utils";
import { invoke } from "@tauri-apps/api/core";
import type {
  AgentProviderConfig,
  ModelConnectionTestResult,
  ModelProvider,
  ModelSettingsRead,
} from "@tessera/contracts";
import { KeyRound, Loader2, Trash2, Wifi, X, Box, Bot } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AgentSettingsView } from "./AgentSettingsView";

interface SettingsViewProps {
  onClose: () => void;
}

type StatusTone = "error" | "info" | "success";

interface StatusMessage {
  message: string;
  tone: StatusTone;
}

export function SettingsView({ onClose }: SettingsViewProps) {
  const [settings, setSettings] = useState<ModelSettingsRead | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<ModelProvider>("openai");
  const [draft, setDraft] = useState<AgentProviderConfig>(defaultDraftForProvider("openai"));
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeAction, setActiveAction] = useState<"remove" | "save" | "test" | null>(null);
  const [activeTab, setActiveTab] = useState<"model" | "agents">("model");
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    let active = true;

    async function loadSettings() {
      setLoading(true);
      setStatus(null);
      try {
        const loaded = await invoke<ModelSettingsRead>("model_settings_get");
        if (!active) {
          return;
        }
        hydrateFromSettings(loaded);
      } catch (error) {
        if (!active) {
          return;
        }
        setStatus({
          message: error instanceof Error ? error.message : String(error),
          tone: "error",
        });
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    void loadSettings();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const hasCredential = settings?.providers[selectedProvider]?.hasCredential ?? false;
  const busy = loading || activeAction !== null;
  const requiresBaseUrl = draft.provider === "local";
  const canSubmit =
    draft.model.trim().length > 0 && (!requiresBaseUrl || draft.baseUrl.trim().length > 0);

  function hydrateFromSettings(
    loaded: ModelSettingsRead,
    provider: ModelProvider = loaded.selectedProvider
  ) {
    setSettings(loaded);
    setSelectedProvider(provider);
    setDraft(providerConfigFromSettings(loaded.providers[provider]));
    setApiKey("");
  }

  function handleProviderSelect(provider: ModelProvider) {
    if (busy) {
      return;
    }
    setSelectedProvider(provider);
    setDraft(
      settings
        ? providerConfigFromSettings(settings.providers[provider])
        : defaultDraftForProvider(provider)
    );
    setApiKey("");
    setStatus(null);
  }

  async function handleSave() {
    if (!canSubmit) {
      return;
    }

    const requestId = ++requestIdRef.current;
    setActiveAction("save");
    setStatus(null);
    try {
      const next = await invoke<ModelSettingsRead>("model_settings_save", {
        request: {
          selectedProvider,
          provider: draft,
          ...(shouldSendCredential(apiKey) ? { credential: { apiKey: apiKey.trim() } } : {}),
        },
      });
      if (!mountedRef.current || requestIdRef.current !== requestId) {
        return;
      }
      hydrateFromSettings(next, selectedProvider);
      setStatus({ message: "Model settings saved", tone: "success" });
    } catch (error) {
      if (!mountedRef.current || requestIdRef.current !== requestId) {
        return;
      }
      setStatus({
        message: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      if (mountedRef.current && requestIdRef.current === requestId) {
        setActiveAction(null);
      }
    }
  }

  async function handleRemoveKey() {
    const requestId = ++requestIdRef.current;
    setActiveAction("remove");
    setStatus(null);
    try {
      const next = await invoke<ModelSettingsRead>("model_credential_delete", {
        request: { provider: selectedProvider },
      });
      if (!mountedRef.current || requestIdRef.current !== requestId) {
        return;
      }
      hydrateFromSettings(next, selectedProvider);
      setStatus({ message: "Stored key removed", tone: "success" });
    } catch (error) {
      if (!mountedRef.current || requestIdRef.current !== requestId) {
        return;
      }
      setStatus({
        message: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      if (mountedRef.current && requestIdRef.current === requestId) {
        setActiveAction(null);
      }
    }
  }

  async function handleTestConnection() {
    if (!canSubmit) {
      return;
    }

    const requestId = ++requestIdRef.current;
    setActiveAction("test");
    setStatus(null);
    try {
      const result = await invoke<ModelConnectionTestResult>("model_connection_test", {
        request: {
          provider: draft,
          ...(shouldSendCredential(apiKey) ? { credential: { apiKey: apiKey.trim() } } : {}),
        },
      });
      if (!mountedRef.current || requestIdRef.current !== requestId) {
        return;
      }
      setStatus({ message: result.message, tone: result.ok ? "success" : "info" });
    } catch (error) {
      if (!mountedRef.current || requestIdRef.current !== requestId) {
        return;
      }
      setStatus({
        message: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      if (mountedRef.current && requestIdRef.current === requestId) {
        setActiveAction(null);
      }
    }
  }

  const credentialPlaceholder = hasCredential
    ? "Saved key present"
    : draft.provider === "local"
      ? "Optional local API key"
      : "Paste API key";

  return (
    <main className="flex min-w-0 flex-1 bg-background">
      <aside className="flex w-56 flex-shrink-0 flex-col border-r border-border bg-secondary px-4 py-5 gap-2">
        <div className="text-sm font-semibold text-foreground mb-3">Settings</div>
        <button
          type="button"
          onClick={() => setActiveTab("model")}
          className={cn(
            "rounded-xl px-3 py-2 text-left text-sm font-medium transition-colors flex items-center gap-2",
            activeTab === "model" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:bg-background/50 hover:text-foreground"
          )}
        >
          <Box size={16} />
          Model
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("agents")}
          className={cn(
            "rounded-xl px-3 py-2 text-left text-sm font-medium transition-colors flex items-center gap-2",
            activeTab === "agents" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:bg-background/50 hover:text-foreground"
          )}
        >
          <Bot size={16} />
          Agents
        </button>
      </aside>

      <section className="min-w-0 flex-1 overflow-auto relative">
        <div className="absolute top-6 right-8 z-10">
          <Button type="button" variant="outline" onClick={onClose}>
            <X size={16} className="mr-2" />
            Close
          </Button>
        </div>
        {activeTab === "model" ? (
          <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col px-8 py-6">
            <div className="flex items-start justify-between gap-4 border-b border-border pb-5">
              <div className="min-w-0">
                <h1 className="text-xl font-semibold text-foreground">Model</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  Global provider defaults for Tessera.
                </p>
              </div>
            </div>

          <div className="mt-6 space-y-6">
            <div className="space-y-3">
              <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                Providers
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                {MODEL_PROVIDERS.map((provider) => {
                  const providerSettings = settings?.providers[provider];
                  const selected = provider === selectedProvider;

                  return (
                    <button
                      key={provider}
                      type="button"
                      disabled={busy}
                      className={cn(
                        "rounded-xl border px-4 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                        selected
                          ? "border-primary bg-secondary text-foreground shadow-sm"
                          : "border-border bg-background text-foreground hover:bg-secondary/70"
                      )}
                      onClick={() => handleProviderSelect(provider)}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="truncate text-sm font-medium">
                          {providerLabel(provider)}
                        </span>
                        {selected && (
                          <span className="rounded-full bg-background px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                            Selected
                          </span>
                        )}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {providerSettings?.hasCredential ? "Saved key present" : "No saved key"}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-4">
              <label className="block">
                <span className="text-sm font-medium text-foreground">Model</span>
                <input
                  className="input mt-2"
                  value={draft.model}
                  disabled={busy}
                  placeholder={modelPlaceholderForProvider(selectedProvider)}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, model: event.target.value }))
                  }
                />
              </label>

              {draft.provider === "local" && (
                <label className="block">
                  <span className="text-sm font-medium text-foreground">Base URL</span>
                  <input
                    className="input mt-2"
                    value={draft.baseUrl}
                    disabled={busy}
                    placeholder="http://127.0.0.1:11434/v1"
                    onChange={(event) =>
                      setDraft((current) =>
                        current.provider === "local"
                          ? { ...current, baseUrl: event.target.value }
                          : current
                      )
                    }
                  />
                </label>
              )}

              <label className="block">
                <span className="text-sm font-medium text-foreground">API key</span>
                <input
                  className="input mt-2"
                  type="password"
                  value={apiKey}
                  disabled={busy}
                  placeholder={credentialPlaceholder}
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </label>

              {status && (
                <div
                  className={cn(
                    "rounded-xl border px-3 py-2 text-sm",
                    status.tone === "error" &&
                      "border-destructive/25 bg-destructive/5 text-destructive",
                    status.tone === "info" && "border-border bg-secondary text-foreground",
                    status.tone === "success" && "border-emerald-200 bg-emerald-50 text-emerald-800"
                  )}
                >
                  {status.message}
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                <Button type="button" onClick={handleSave} disabled={busy || !canSubmit}>
                  {activeAction === "save" ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <KeyRound size={16} />
                  )}
                  Save
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleTestConnection}
                  disabled={busy || !canSubmit}
                >
                  {activeAction === "test" ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <Wifi size={16} />
                  )}
                  Test connection
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleRemoveKey}
                  disabled={busy || !hasCredential}
                >
                  {activeAction === "remove" ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <Trash2 size={16} />
                  )}
                  Remove key
                </Button>
              </div>
            </div>
          </div>
        </div>
        ) : (
          <AgentSettingsView />
        )}
      </section>
    </main>
  );
}

function providerConfigFromSettings(
  settings: ModelSettingsRead["providers"][ModelProvider]
): AgentProviderConfig {
  switch (settings.provider) {
    case "openai":
      return {
        provider: "openai",
        model: settings.model,
        apiKeyEnv: "OPENAI_API_KEY",
      };
    case "anthropic":
      return {
        provider: "anthropic",
        model: settings.model,
        apiKeyEnv: "ANTHROPIC_API_KEY",
      };
    case "openrouter":
      return {
        provider: "openrouter",
        model: settings.model,
        apiKeyEnv: "OPENROUTER_API_KEY",
      };
    case "local":
      return {
        provider: "local",
        model: settings.model,
        baseUrl: settings.baseUrl ?? "http://127.0.0.1:11434/v1",
      };
  }
}
