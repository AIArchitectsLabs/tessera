import { Button } from "@/components/ui/button";
import {
  INTEGRATION_PROVIDERS,
  SEARCH_MODE_OPTIONS,
  SEARCH_PROVIDERS,
  integrationLabel,
  searchModeLabel,
  searchProviderLabel,
  searchProviderSupportsCredential,
  shouldSendIntegrationCredential,
} from "@/lib/integrationSettings";
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
  IntegrationConnectionTestRequest,
  IntegrationConnectionTestResult,
  IntegrationCredentialDeleteRequest,
  IntegrationProvider,
  IntegrationSettingsRead,
  IntegrationSettingsSaveRequest,
  ModelConnectionTestResult,
  ModelProvider,
  ModelSettingsRead,
  SearchMode,
  SearchProvider,
} from "@tessera/contracts";
import { Bot, Box, KeyRound, Loader2, Search, Trash2, Wifi, X } from "lucide-react";
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

async function invokeWithTimeout<T>(
  command: Parameters<typeof invoke>[0],
  args?: Parameters<typeof invoke>[1],
  timeoutMs = 20_000
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`Request timed out after ${timeoutMs}ms: ${command}`)),
      timeoutMs
    );
  });

  try {
    return await Promise.race([invoke<T>(command, args), timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export function SettingsView({ onClose }: SettingsViewProps) {
  const [settings, setSettings] = useState<ModelSettingsRead | null>(null);
  const [integrations, setIntegrations] = useState<IntegrationSettingsRead | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<ModelProvider>("openai");
  const [selectedIntegration, setSelectedIntegration] =
    useState<IntegrationProvider>("google-calendar");
  const [selectedSearchProvider, setSelectedSearchProvider] =
    useState<SearchProvider>("brave-search");
  const [searchMode, setSearchMode] = useState<SearchMode>("auto");
  const [allowKeylessFallback, setAllowKeylessFallback] = useState(false);
  const [draft, setDraft] = useState<AgentProviderConfig>(defaultDraftForProvider("openai"));
  const [apiKey, setApiKey] = useState("");
  const [integrationApiKey, setIntegrationApiKey] = useState("");
  const [searchApiKey, setSearchApiKey] = useState("");
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [integrationStatus, setIntegrationStatus] = useState<StatusMessage | null>(null);
  const [searchStatus, setSearchStatus] = useState<StatusMessage | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeModelAction, setActiveModelAction] = useState<"remove" | "save" | "test" | null>(
    null
  );
  const [activeIntegrationAction, setActiveIntegrationAction] = useState<
    "remove" | "save" | "test" | null
  >(null);
  const [activeSearchAction, setActiveSearchAction] = useState<"remove" | "save" | "test" | null>(
    null
  );
  const [activeTab, setActiveTab] = useState<"model" | "integrations" | "agents">("model");
  const modelRequestIdRef = useRef(0);
  const integrationRequestIdRef = useRef(0);
  const searchRequestIdRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    let active = true;

    async function loadSettings() {
      setLoading(true);
      setStatus(null);
      setIntegrationStatus(null);
      setSearchStatus(null);
      try {
        const [loaded, loadedIntegrations] = await Promise.all([
          invokeWithTimeout<ModelSettingsRead>("model_settings_get"),
          invokeWithTimeout<IntegrationSettingsRead>("integration_settings_get"),
        ]);
        if (!active) {
          return;
        }
        hydrateFromSettings(loaded);
        hydrateFromIntegrations(loadedIntegrations);
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
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const hasCredential = settings?.providers[selectedProvider]?.hasCredential ?? false;
  const hasIntegrationCredential = integrations?.providers.googleCalendar.hasCredential ?? false;
  const hasSearchCredential =
    searchProviderSettings(integrations, selectedSearchProvider)?.hasCredential ?? false;
  const searchProviderAllowsCredentials = searchProviderSupportsCredential(selectedSearchProvider);
  const modelBusy = loading || activeModelAction !== null;
  const integrationBusy = loading || activeIntegrationAction !== null;
  const searchBusy = loading || activeSearchAction !== null;
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

  function hydrateFromIntegrations(loaded: IntegrationSettingsRead) {
    setIntegrations(loaded);
    setSearchMode(loaded.search.mode);
    setAllowKeylessFallback(loaded.search.allowKeylessFallback);
    setSelectedSearchProvider((current) =>
      loaded.search.mode === "auto" ? current : loaded.search.mode
    );
    setIntegrationApiKey("");
    setSearchApiKey("");
  }

  function handleProviderSelect(provider: ModelProvider) {
    if (modelBusy) {
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

  function handleIntegrationSelect(provider: IntegrationProvider) {
    if (integrationBusy) {
      return;
    }
    setSelectedIntegration(provider);
    setIntegrationApiKey("");
    setIntegrationStatus(null);
  }

  function handleSearchProviderSelect(provider: SearchProvider) {
    if (searchBusy) {
      return;
    }
    setSelectedSearchProvider(provider);
    if (searchProviderSupportsCredential(provider)) {
      setSearchApiKey("");
    }
    setSearchStatus(null);
  }

  function handleSearchModeSelect(mode: SearchMode) {
    if (searchBusy) {
      return;
    }
    setSearchMode(mode);
    setSelectedSearchProvider((current) => nextSelectedSearchProvider(mode, current));
    setSearchStatus(null);
  }

  async function handleSave() {
    if (!canSubmit) {
      return;
    }

    const requestId = ++modelRequestIdRef.current;
    setActiveModelAction("save");
    setStatus(null);
    try {
      const next = await invokeWithTimeout<ModelSettingsRead>("model_settings_save", {
        request: {
          selectedProvider,
          provider: draft,
          hasExistingCredential: hasCredential,
          ...(shouldSendCredential(apiKey) ? { credential: { apiKey: apiKey.trim() } } : {}),
        },
      });
      if (!mountedRef.current || modelRequestIdRef.current !== requestId) {
        return;
      }
      hydrateFromSettings(next, selectedProvider);
      setStatus({ message: "Model settings saved", tone: "success" });
    } catch (error) {
      if (!mountedRef.current || modelRequestIdRef.current !== requestId) {
        return;
      }
      setStatus({
        message: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      if (mountedRef.current && modelRequestIdRef.current === requestId) {
        setActiveModelAction(null);
      }
    }
  }

  async function handleRemoveKey() {
    const requestId = ++modelRequestIdRef.current;
    setActiveModelAction("remove");
    setStatus(null);
    try {
      const next = await invokeWithTimeout<ModelSettingsRead>("model_credential_delete", {
        request: { provider: selectedProvider },
      });
      if (!mountedRef.current || modelRequestIdRef.current !== requestId) {
        return;
      }
      hydrateFromSettings(next, selectedProvider);
      setStatus({ message: "Stored key removed", tone: "success" });
    } catch (error) {
      if (!mountedRef.current || modelRequestIdRef.current !== requestId) {
        return;
      }
      setStatus({
        message: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      if (mountedRef.current && modelRequestIdRef.current === requestId) {
        setActiveModelAction(null);
      }
    }
  }

  async function handleTestConnection() {
    if (!canSubmit) {
      return;
    }

    const requestId = ++modelRequestIdRef.current;
    setActiveModelAction("test");
    setStatus(null);
    try {
      const result = await invokeWithTimeout<ModelConnectionTestResult>("model_connection_test", {
        request: {
          provider: draft,
          ...(shouldSendCredential(apiKey) ? { credential: { apiKey: apiKey.trim() } } : {}),
        },
      });
      if (!mountedRef.current || modelRequestIdRef.current !== requestId) {
        return;
      }
      setStatus({ message: result.message, tone: result.ok ? "success" : "info" });
    } catch (error) {
      if (!mountedRef.current || modelRequestIdRef.current !== requestId) {
        return;
      }
      setStatus({
        message: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      if (mountedRef.current && modelRequestIdRef.current === requestId) {
        setActiveModelAction(null);
      }
    }
  }

  async function handleSaveIntegration() {
    const requestId = ++integrationRequestIdRef.current;
    setActiveIntegrationAction("save");
    setIntegrationStatus(null);
    try {
      const next = await invokeWithTimeout<IntegrationSettingsRead>("integration_settings_save", {
        request: {
          provider: selectedIntegration,
          hasExistingCredential: hasIntegrationCredential,
          ...(shouldSendIntegrationCredential(integrationApiKey)
            ? { credential: { apiKey: integrationApiKey.trim() } }
            : {}),
        },
      });
      if (!mountedRef.current || integrationRequestIdRef.current !== requestId) {
        return;
      }
      hydrateFromIntegrations(next);
      setIntegrationStatus({ message: "Integration settings saved", tone: "success" });
    } catch (error) {
      if (!mountedRef.current || integrationRequestIdRef.current !== requestId) {
        return;
      }
      setIntegrationStatus({
        message: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      if (mountedRef.current && integrationRequestIdRef.current === requestId) {
        setActiveIntegrationAction(null);
      }
    }
  }

  async function handleRemoveIntegrationKey() {
    const requestId = ++integrationRequestIdRef.current;
    setActiveIntegrationAction("remove");
    setIntegrationStatus(null);
    try {
      const next = await invokeWithTimeout<IntegrationSettingsRead>(
        "integration_credential_delete",
        {
          request: { provider: selectedIntegration },
        }
      );
      if (!mountedRef.current || integrationRequestIdRef.current !== requestId) {
        return;
      }
      hydrateFromIntegrations(next);
      setIntegrationStatus({ message: "Stored key removed", tone: "success" });
    } catch (error) {
      if (!mountedRef.current || integrationRequestIdRef.current !== requestId) {
        return;
      }
      setIntegrationStatus({
        message: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      if (mountedRef.current && integrationRequestIdRef.current === requestId) {
        setActiveIntegrationAction(null);
      }
    }
  }

  async function handleIntegrationTestConnection() {
    const requestId = ++integrationRequestIdRef.current;
    setActiveIntegrationAction("test");
    setIntegrationStatus(null);
    try {
      const result = await invokeWithTimeout<IntegrationConnectionTestResult>(
        "integration_connection_test",
        {
          request: {
            provider: selectedIntegration,
            ...(shouldSendIntegrationCredential(integrationApiKey)
              ? { credential: { apiKey: integrationApiKey.trim() } }
              : {}),
          },
        }
      );
      if (!mountedRef.current || integrationRequestIdRef.current !== requestId) {
        return;
      }
      setIntegrationStatus({ message: result.message, tone: result.ok ? "success" : "info" });
    } catch (error) {
      if (!mountedRef.current || integrationRequestIdRef.current !== requestId) {
        return;
      }
      setIntegrationStatus({
        message: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      if (mountedRef.current && integrationRequestIdRef.current === requestId) {
        setActiveIntegrationAction(null);
      }
    }
  }

  async function handleSaveSearchSettings() {
    const requestId = ++searchRequestIdRef.current;
    setActiveSearchAction("save");
    setSearchStatus(null);
    try {
      const next = await invokeWithTimeout<IntegrationSettingsRead>("integration_settings_save", {
        request: buildSearchSettingsSaveRequest({
          selectedSearchProvider,
          hasExistingCredential: hasSearchCredential,
          searchMode,
          allowKeylessFallback,
          apiKey: searchApiKey,
        }),
      });
      if (!mountedRef.current || searchRequestIdRef.current !== requestId) {
        return;
      }
      hydrateFromIntegrations(next);
      setSearchStatus({ message: "Search settings saved", tone: "success" });
    } catch (error) {
      if (!mountedRef.current || searchRequestIdRef.current !== requestId) {
        return;
      }
      setSearchStatus({
        message: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      if (mountedRef.current && searchRequestIdRef.current === requestId) {
        setActiveSearchAction(null);
      }
    }
  }

  async function handleRemoveSearchKey() {
    if (!searchProviderSupportsCredential(selectedSearchProvider)) {
      return;
    }
    const requestId = ++searchRequestIdRef.current;
    setActiveSearchAction("remove");
    setSearchStatus(null);
    try {
      const deleteRequest = buildSearchCredentialDeleteRequest(selectedSearchProvider);
      if (!deleteRequest) {
        return;
      }
      const next = await invokeWithTimeout<IntegrationSettingsRead>(
        "integration_credential_delete",
        {
          request: deleteRequest,
        }
      );
      if (!mountedRef.current || searchRequestIdRef.current !== requestId) {
        return;
      }
      hydrateFromIntegrations(next);
      setSearchStatus({ message: "Stored key removed", tone: "success" });
    } catch (error) {
      if (!mountedRef.current || searchRequestIdRef.current !== requestId) {
        return;
      }
      setSearchStatus({
        message: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      if (mountedRef.current && searchRequestIdRef.current === requestId) {
        setActiveSearchAction(null);
      }
    }
  }

  async function handleSearchTestConnection() {
    const requestId = ++searchRequestIdRef.current;
    setActiveSearchAction("test");
    setSearchStatus(null);
    try {
      const result = await invokeWithTimeout<IntegrationConnectionTestResult>(
        "integration_connection_test",
        {
          request: buildSearchConnectionTestRequest({
            selectedSearchProvider,
            apiKey: searchApiKey,
          }),
        }
      );
      if (!mountedRef.current || searchRequestIdRef.current !== requestId) {
        return;
      }
      setSearchStatus({ message: result.message, tone: result.ok ? "success" : "info" });
    } catch (error) {
      if (!mountedRef.current || searchRequestIdRef.current !== requestId) {
        return;
      }
      setSearchStatus({
        message: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      if (mountedRef.current && searchRequestIdRef.current === requestId) {
        setActiveSearchAction(null);
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
      <aside className="flex w-56 flex-shrink-0 flex-col border-r border-border bg-sidebar px-4 py-5 gap-2">
        <div className="text-sm font-semibold text-foreground mb-3">Settings</div>
        <button
          type="button"
          onClick={() => setActiveTab("model")}
          className={cn(
            "rounded-xl px-3 py-2 text-left text-sm font-medium transition-colors flex items-center gap-2",
            activeTab === "model"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:bg-black/5 hover:text-foreground"
          )}
        >
          <Box size={16} />
          Model
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("integrations")}
          className={cn(
            "rounded-xl px-3 py-2 text-left text-sm font-medium transition-colors flex items-center gap-2",
            activeTab === "integrations"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:bg-black/5 hover:text-foreground"
          )}
        >
          <Search size={16} />
          Integrations
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("agents")}
          className={cn(
            "rounded-xl px-3 py-2 text-left text-sm font-medium transition-colors flex items-center gap-2",
            activeTab === "agents"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:bg-black/5 hover:text-foreground"
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
                        disabled={modelBusy}
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
                    disabled={modelBusy}
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
                      disabled={modelBusy}
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
                    disabled={modelBusy}
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
                      status.tone === "info" && "border-border bg-muted text-foreground",
                      status.tone === "success" &&
                        "border-success bg-success/10 text-success"
                    )}
                  >
                    {status.message}
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  <Button type="button" onClick={handleSave} disabled={modelBusy || !canSubmit}>
                    {activeModelAction === "save" ? (
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
                    disabled={modelBusy || !canSubmit}
                  >
                    {activeModelAction === "test" ? (
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
                    disabled={modelBusy || !hasCredential}
                  >
                    {activeModelAction === "remove" ? (
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
        ) : activeTab === "integrations" ? (
          <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col px-8 py-6">
            <div className="flex items-start justify-between gap-4 border-b border-border pb-5">
              <div className="min-w-0">
                <h1 className="text-xl font-semibold text-foreground">Integrations</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  Search providers and calendar access for Tessera tools.
                </p>
              </div>
            </div>

            <div className="mt-6 space-y-8">
              <section className="space-y-4">
                <div className="space-y-3">
                  <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                    Search mode
                  </div>
                  <div className="grid gap-3 md:grid-cols-4">
                    {SEARCH_MODE_OPTIONS.map((mode) => {
                      const selected = mode === searchMode;

                      return (
                        <button
                          key={mode}
                          type="button"
                          disabled={searchBusy}
                          className={cn(
                            "rounded-xl border px-4 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                            selected
                              ? "border-primary bg-accent text-accent-foreground shadow-sm"
                              : "border-border bg-card text-foreground hover:bg-muted"
                          )}
                          onClick={() => handleSearchModeSelect(mode)}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <span className="truncate text-sm font-medium">
                              {searchModeLabel(mode)}
                            </span>
                            {selected && (
                              <span className="rounded-full bg-background px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                Selected
                              </span>
                            )}
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {mode === "auto"
                              ? "Let Tessera choose the active search provider."
                              : `Use ${searchProviderLabel(mode)} as the active search provider.`}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <label className="flex items-center gap-3 text-sm text-foreground">
                  <input
                    type="checkbox"
                    checked={allowKeylessFallback}
                    disabled={searchBusy}
                    onChange={(event) => setAllowKeylessFallback(event.target.checked)}
                  />
                  Allow keyless fallback
                </label>
              </section>

              <section className="space-y-4">
                <div className="space-y-3">
                  <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                    Search providers
                  </div>
                  <div className="grid gap-3 md:grid-cols-3">
                    {SEARCH_PROVIDERS.map((provider) => {
                      const providerSettings = searchProviderSettings(integrations, provider);
                      const selected = provider === selectedSearchProvider;

                      return (
                        <button
                          key={provider}
                          type="button"
                          disabled={searchBusy}
                          className={cn(
                            "rounded-xl border px-4 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                            selected
                              ? "border-primary bg-secondary text-foreground shadow-sm"
                              : "border-border bg-background text-foreground hover:bg-secondary/70"
                          )}
                          onClick={() => handleSearchProviderSelect(provider)}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <span className="truncate text-sm font-medium">
                              {searchProviderLabel(provider)}
                            </span>
                            {selected && (
                              <span className="rounded-full bg-background px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                Selected
                              </span>
                            )}
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {provider === "duckduckgo"
                              ? "Keyless provider"
                              : providerSettings?.hasCredential
                                ? "Saved key present"
                                : "No saved key"}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="rounded-xl border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
                  {searchProviderDescription(selectedSearchProvider)}
                </div>

                {searchProviderAllowsCredentials ? (
                  <label className="block">
                    <span className="text-sm font-medium text-foreground">API key</span>
                    <input
                      className="input mt-2"
                      type="password"
                      value={searchApiKey}
                      disabled={searchBusy}
                      placeholder={
                        hasSearchCredential
                          ? "Saved key present"
                          : `Paste ${searchProviderLabel(selectedSearchProvider)} API key`
                      }
                      onChange={(event) => setSearchApiKey(event.target.value)}
                    />
                  </label>
                ) : (
                  <div className="rounded-xl border border-dashed border-border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
                    DuckDuckGo uses keyless search. No API key is required or stored.
                  </div>
                )}

                {searchStatus && (
                  <div
                    className={cn(
                      "rounded-xl border px-3 py-2 text-sm",
                      searchStatus.tone === "error" &&
                        "border-destructive/25 bg-destructive/5 text-destructive",
                      searchStatus.tone === "info" && "border-border bg-muted text-foreground",
                      searchStatus.tone === "success" &&
                        "border-success bg-success/10 text-success"
                    )}
                  >
                    {searchStatus.message}
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  <Button type="button" onClick={handleSaveSearchSettings} disabled={searchBusy}>
                    {activeSearchAction === "save" ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : (
                      <KeyRound size={16} />
                    )}
                    Save
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleSearchTestConnection}
                    disabled={searchBusy}
                  >
                    {activeSearchAction === "test" ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : (
                      <Wifi size={16} />
                    )}
                    Test connection
                  </Button>
                  {searchProviderAllowsCredentials && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleRemoveSearchKey}
                      disabled={searchBusy || !hasSearchCredential}
                    >
                      {activeSearchAction === "remove" ? (
                        <Loader2 size={16} className="animate-spin" />
                      ) : (
                        <Trash2 size={16} />
                      )}
                      Remove key
                    </Button>
                  )}
                </div>
              </section>

              <section className="space-y-4">
                <div className="space-y-3">
                  <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                    Calendar integration
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    {INTEGRATION_PROVIDERS.map((provider) => {
                      const selected = provider === selectedIntegration;

                      return (
                        <button
                          key={provider}
                          type="button"
                          disabled={integrationBusy}
                          className={cn(
                            "rounded-xl border px-4 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                            selected
                              ? "border-primary bg-accent text-accent-foreground shadow-sm"
                              : "border-border bg-card text-foreground hover:bg-muted"
                          )}
                          onClick={() => handleIntegrationSelect(provider)}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <span className="truncate text-sm font-medium">
                              {integrationLabel(provider)}
                            </span>
                            {selected && (
                              <span className="rounded-full bg-background px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                Selected
                              </span>
                            )}
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {hasIntegrationCredential ? "Saved key present" : "No saved key"}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="rounded-xl border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
                  Google Calendar powers the `gcal list` and `gcal read` shell commands for calendar
                  context.
                </div>

                <label className="block">
                  <span className="text-sm font-medium text-foreground">API key</span>
                  <input
                    className="input mt-2"
                    type="password"
                    value={integrationApiKey}
                    disabled={integrationBusy}
                    placeholder={
                      hasIntegrationCredential
                        ? "Saved key present"
                        : "Paste Google Calendar API key"
                    }
                    onChange={(event) => setIntegrationApiKey(event.target.value)}
                  />
                </label>

                {integrationStatus && (
                  <div
                    className={cn(
                      "rounded-xl border px-3 py-2 text-sm",
                      integrationStatus.tone === "error" &&
                        "border-destructive/25 bg-destructive/5 text-destructive",
                      integrationStatus.tone === "info" &&
                        "border-border bg-muted text-foreground",
                      integrationStatus.tone === "success" &&
                        "border-success bg-success/10 text-success"
                    )}
                  >
                    {integrationStatus.message}
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  <Button type="button" onClick={handleSaveIntegration} disabled={integrationBusy}>
                    {activeIntegrationAction === "save" ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : (
                      <KeyRound size={16} />
                    )}
                    Save
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleIntegrationTestConnection}
                    disabled={integrationBusy}
                  >
                    {activeIntegrationAction === "test" ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : (
                      <Wifi size={16} />
                    )}
                    Test connection
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleRemoveIntegrationKey}
                    disabled={integrationBusy || !hasIntegrationCredential}
                  >
                    {activeIntegrationAction === "remove" ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : (
                      <Trash2 size={16} />
                    )}
                    Remove key
                  </Button>
                </div>
              </section>
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

function searchProviderSettings(
  integrations: IntegrationSettingsRead | null,
  provider: SearchProvider
) {
  if (!integrations) {
    return null;
  }

  switch (provider) {
    case "brave-search":
      return integrations.search.providers.braveSearch;
    case "tavily":
      return integrations.search.providers.tavily;
    case "duckduckgo":
      return integrations.search.providers.duckduckgo;
  }
}

function searchProviderDescription(provider: SearchProvider): string {
  switch (provider) {
    case "brave-search":
      return "Brave Search powers the `web-search search` shell command for live agent research.";
    case "tavily":
      return "Tavily powers the `web-search search` shell command for live agent research.";
    case "duckduckgo":
      return "DuckDuckGo powers the `web-search search` shell command and uses keyless search.";
  }
}

export function nextSelectedSearchProvider(
  mode: SearchMode,
  currentProvider: SearchProvider
): SearchProvider {
  return mode === "auto" ? currentProvider : mode;
}

export function buildSearchSettingsSaveRequest(params: {
  selectedSearchProvider: SearchProvider;
  hasExistingCredential: boolean;
  searchMode: SearchMode;
  allowKeylessFallback: boolean;
  apiKey: string;
}): IntegrationSettingsSaveRequest {
  const credential = shouldSendIntegrationCredential(params.apiKey)
    ? { credential: { apiKey: params.apiKey.trim() } }
    : {};

  if (!searchProviderSupportsCredential(params.selectedSearchProvider)) {
    return {
      searchProvider: params.selectedSearchProvider,
      hasExistingCredential: false,
      search: {
        mode: params.searchMode,
        allowKeylessFallback: params.allowKeylessFallback,
      },
    };
  }

  return {
    searchProvider: params.selectedSearchProvider,
    hasExistingCredential: params.hasExistingCredential,
    search: {
      mode: params.searchMode,
      allowKeylessFallback: params.allowKeylessFallback,
    },
    ...credential,
  };
}

export function buildSearchConnectionTestRequest(params: {
  selectedSearchProvider: SearchProvider;
  apiKey: string;
}): IntegrationConnectionTestRequest {
  if (!searchProviderSupportsCredential(params.selectedSearchProvider)) {
    return {
      searchProvider: params.selectedSearchProvider,
    };
  }

  const credential = shouldSendIntegrationCredential(params.apiKey)
    ? { credential: { apiKey: params.apiKey.trim() } }
    : {};

  return {
    searchProvider: params.selectedSearchProvider,
    ...credential,
  };
}

export function buildSearchCredentialDeleteRequest(
  provider: SearchProvider
): IntegrationCredentialDeleteRequest | null {
  if (!searchProviderSupportsCredential(provider)) {
    return null;
  }

  return {
    searchProvider: provider,
  };
}
