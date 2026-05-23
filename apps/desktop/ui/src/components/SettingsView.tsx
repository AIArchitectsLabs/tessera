import { Button } from "@/components/ui/button";
import {
  INTEGRATION_PROVIDERS,
  SEARCH_MODE_OPTIONS,
  SEARCH_PROVIDERS,
  integrationLabel,
  integrationProviderSupportsCredential,
  searchModeLabel,
  searchProviderLabel,
  searchProviderSupportsCredential,
  shouldSendIntegrationCredential,
} from "@/lib/integrationSettings";
import {
  MODEL_PROVIDERS,
  defaultDraftForProvider,
  modelOptionsForProvider,
  modelPlaceholderForProvider,
  providerLabel,
  shouldSendCredential,
} from "@/lib/modelSettings";
import { cn } from "@/lib/utils";
import { invoke } from "@tauri-apps/api/core";
import { WorkspaceConfigSchema, type WorkspaceStyleGuide } from "@tessera/contracts";
import type {
  AgentProviderConfig,
  IntegrationConnectionTestRequest,
  IntegrationConnectionTestResult,
  IntegrationCredentialDeleteRequest,
  IntegrationProvider,
  IntegrationSettingsRead,
  IntegrationSettingsSaveRequest,
  Memory,
  MemoryCandidate,
  MemoryForgetRequest,
  MemoryReviewDecisionRequest,
  MemoryReviewListResult,
  MemoryRuntimeStatus,
  ModelConnectionTestResult,
  ModelProvider,
  ModelSettingsRead,
  SearchMode,
  SearchProvider,
  WorkspaceConfig,
  WorkspaceStyleGuideReadResult,
  WorkspaceStyleGuideSaveResult,
} from "@tessera/contracts";
import {
  AlertTriangle,
  Archive,
  Bot,
  Box,
  Check,
  Database,
  Download,
  FileText,
  KeyRound,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
  Wifi,
  X,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentSettingsView } from "./AgentSettingsView";

interface SettingsViewProps {
  onClose: () => void;
  userKey: string;
  workspaceRoot?: string | null;
}

type StatusTone = "error" | "info" | "success";

interface StatusMessage {
  message: string;
  tone: StatusTone;
}

interface GoogleWorkspaceServiceHealth {
  service: string;
  ok: boolean;
  message: string;
}

interface GoogleWorkspaceOAuthClientStatus {
  hasClient: boolean;
  source: "build" | "bundled" | "missing" | "saved";
}

type GoogleWorkspaceCapabilityProgressPhase =
  | "available"
  | "downloading"
  | "failed"
  | "installed"
  | "installing"
  | "verifying";

interface GoogleWorkspaceCapabilityProgress {
  phase: GoogleWorkspaceCapabilityProgressPhase;
  downloadedBytes?: number;
  totalBytes?: number;
  message?: string;
}

interface GoogleWorkspaceCapabilityStatus {
  capabilityId: string;
  binaryName: string;
  path?: string;
  installed: boolean;
  installAvailable: boolean;
  version: string;
  sizeBytes?: number;
  message?: string;
  progress?: GoogleWorkspaceCapabilityProgress;
}

interface CodexDeviceCode {
  deviceAuthId: string;
  interval: number;
  userCode: string;
  verificationUri: string;
}

type CodexPollResult =
  | { status: "pending" }
  | { status: "authorized"; settings: ModelSettingsRead };

const GOOGLE_WORKSPACE_CAPABILITIES = ["Calendar", "Gmail", "Drive", "Contacts", "Docs", "Sheets"];

const DEFAULT_WORKSPACE_STYLE_CONFIG: WorkspaceConfig = {
  schemaVersion: 1,
  styleGuide: {
    schemaVersion: 1,
    profile: {
      id: "default",
      name: "Default Brand Voice",
      locale: "en-US",
      defaultCopyType: "blog.article.long",
    },
    voice: {
      pointOfView: "",
      persona: "",
      principles: ["Be clear, specific, and useful."],
      avoid: ["Generic AI filler", "Unsupported superlatives"],
    },
    tone: {
      default: ["clear", "practical", "authoritative", "calm"],
      dimensions: { formality: 3, warmth: 2, urgency: 1, playfulness: 0 },
    },
    language: {
      readingLevel: "Accessible business reader",
      jargonPolicy: "Use domain terms only when useful; define them in plain English.",
      preferredTerms: [],
      bannedTerms: [],
    },
    structure: {
      introMaxWords: 100,
      paragraphMaxSentences: 4,
      prefer: ["direct answer first", "scannable headings"],
      avoid: ["summary-only conclusions"],
    },
    evidence: {
      claimPolicy: "Factual claims need source support or clear qualification.",
      citationStyle: "Preserve source URLs.",
      unsupportedClaims:
        "Reject ranking, market-share, performance, or legal claims without evidence.",
    },
    seoGeo: {
      directAnswerRequired: true,
      answerWithinWords: 100,
      entityGuidance: "Include primary entities naturally; do not keyword-stuff.",
      snippetOptimization: ["clear definition", "steps", "comparison table"],
    },
    copyTypes: {
      "business.brief.medium": {
        label: "Business Brief",
        length: "medium",
        targetWords: { min: 500, max: 900 },
        tone: ["clear", "executive-ready", "specific"],
        formatRules: ["short summary first", "evidence before recommendation"],
      },
      "blog.article.long": {
        label: "Blog Article",
        length: "long",
        targetWords: { min: 900, max: 1500 },
        tone: ["authoritative", "practical", "source-backed"],
        formatRules: ["one H1", "H2/H3 hierarchy", "at least two lists or tables"],
      },
      "operations.digest.medium": {
        label: "Operations Digest",
        length: "medium",
        targetWords: { min: 400, max: 800 },
        tone: ["direct", "calm", "decision-oriented"],
        formatRules: ["progress, risks, decisions, follow-ups", "bullets over paragraphs"],
      },
      "social.post.short": {
        label: "Social Post",
        length: "short",
        targetWords: { max: 120 },
        tone: ["direct", "human", "specific"],
        formatRules: ["one clear hook", "no unsupported claims"],
      },
    },
    examples: [],
    review: {
      failOn: ["unsupported factual claims", "banned terms"],
      warnOn: ["long introductions", "generic filler"],
    },
  },
};

type WorkspaceStyleCopyTypeDraft = WorkspaceStyleGuide["copyTypes"][string];
type WorkspaceStyleExampleDraft = WorkspaceStyleGuide["examples"][number];

function cloneWorkspaceConfig(config: WorkspaceConfig): WorkspaceConfig {
  return JSON.parse(JSON.stringify(config)) as WorkspaceConfig;
}

function parseWorkspaceStyleDraft(text: string): WorkspaceConfig | null {
  try {
    return WorkspaceConfigSchema.parse(JSON.parse(text));
  } catch {
    return null;
  }
}

function listToText(items: string[] | undefined): string {
  return (items ?? []).join("\n");
}

function textToList(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function optionalPositiveInteger(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
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

export function SettingsView({ onClose, userKey, workspaceRoot }: SettingsViewProps) {
  const [settings, setSettings] = useState<ModelSettingsRead | null>(null);
  const [integrations, setIntegrations] = useState<IntegrationSettingsRead | null>(null);
  const [memoryStatus, setMemoryStatus] = useState<MemoryRuntimeStatus | null>(null);
  const [memoryReview, setMemoryReview] = useState<MemoryReviewListResult>({
    active: [],
    candidates: [],
  });
  const [styleGuideResult, setStyleGuideResult] = useState<WorkspaceStyleGuideReadResult | null>(
    null
  );
  const [styleGuideDraft, setStyleGuideDraft] = useState("");
  const [memoryStatusMessage, setMemoryStatusMessage] = useState<StatusMessage | null>(null);
  const [memoryReviewMessage, setMemoryReviewMessage] = useState<StatusMessage | null>(null);
  const [styleGuideStatus, setStyleGuideStatus] = useState<StatusMessage | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<ModelProvider>("openai");
  const [selectedIntegration, setSelectedIntegration] =
    useState<IntegrationProvider>("google-workspace");
  const [selectedSearchProvider, setSelectedSearchProvider] =
    useState<SearchProvider>("brave-search");
  const [searchMode, setSearchMode] = useState<SearchMode>("auto");
  const [allowKeylessFallback, setAllowKeylessFallback] = useState(false);
  const [draft, setDraft] = useState<AgentProviderConfig>(defaultDraftForProvider("openai"));
  const [apiKey, setApiKey] = useState("");
  const [integrationApiKey, setIntegrationApiKey] = useState("");
  const [googleWorkspaceOAuthClientStatus, setGoogleWorkspaceOAuthClientStatus] =
    useState<GoogleWorkspaceOAuthClientStatus>({ hasClient: false, source: "missing" });
  const [searchApiKey, setSearchApiKey] = useState("");
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [integrationStatus, setIntegrationStatus] = useState<StatusMessage | null>(null);
  const [googleWorkspaceHealth, setGoogleWorkspaceHealth] = useState<
    GoogleWorkspaceServiceHealth[]
  >([]);
  const [googleWorkspaceCapability, setGoogleWorkspaceCapability] =
    useState<GoogleWorkspaceCapabilityStatus | null>(null);
  const [googleWorkspaceInstallConsent, setGoogleWorkspaceInstallConsent] = useState(false);
  const [searchStatus, setSearchStatus] = useState<StatusMessage | null>(null);
  const [loading, setLoading] = useState(true);
  const [memoryLoading, setMemoryLoading] = useState(true);
  const [memoryReviewLoading, setMemoryReviewLoading] = useState(true);
  const [styleGuideLoading, setStyleGuideLoading] = useState(false);
  const [styleGuideSaving, setStyleGuideSaving] = useState(false);
  const [styleGuideCopyTypeKey, setStyleGuideCopyTypeKey] = useState("blog.article.long");
  const [activeModelAction, setActiveModelAction] = useState<
    "codexSignIn" | "remove" | "save" | "test" | null
  >(null);
  const [activeIntegrationAction, setActiveIntegrationAction] = useState<
    "connect" | "disconnect" | "installGws" | "remove" | "save" | "saveOAuthClient" | "test" | null
  >(null);
  const [activeSearchAction, setActiveSearchAction] = useState<"remove" | "save" | "test" | null>(
    null
  );
  const [activeMemoryAction, setActiveMemoryAction] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<
    "model" | "integrations" | "memory" | "agents" | "styleGuide"
  >("model");
  const modelRequestIdRef = useRef(0);
  const integrationRequestIdRef = useRef(0);
  const searchRequestIdRef = useRef(0);
  const googleWorkspaceClientIdRef = useRef<HTMLInputElement>(null);
  const googleWorkspaceClientSecretRef = useRef<HTMLInputElement>(null);
  const styleGuideDraftRef = useRef("");
  const mountedRef = useRef(true);
  const styleGuideEditorConfig = useMemo(
    () => parseWorkspaceStyleDraft(styleGuideDraft),
    [styleGuideDraft]
  );
  const styleGuideEditor = styleGuideEditorConfig?.styleGuide ?? null;
  const styleGuideCopyTypeKeys = Object.keys(styleGuideEditor?.copyTypes ?? {});
  const selectedStyleGuideCopyTypeKey = styleGuideCopyTypeKeys.includes(styleGuideCopyTypeKey)
    ? styleGuideCopyTypeKey
    : (styleGuideCopyTypeKeys[0] ?? "");
  const selectedStyleGuideCopyType = selectedStyleGuideCopyTypeKey
    ? styleGuideEditor?.copyTypes[selectedStyleGuideCopyTypeKey]
    : undefined;
  const styleGuideConflict =
    styleGuideStatus?.tone === "error" &&
    styleGuideStatus.message.includes("changed outside Tessera");

  const setStyleGuideDraftText = useCallback(
    (next: string | ((currentDraft: string) => string)) => {
      if (typeof next === "function") {
        setStyleGuideDraft((currentDraft) => {
          const resolved = next(currentDraft);
          styleGuideDraftRef.current = resolved;
          return resolved;
        });
        return;
      }
      styleGuideDraftRef.current = next;
      setStyleGuideDraft(next);
    },
    []
  );

  useEffect(() => {
    let active = true;

    async function loadSettings() {
      setLoading(true);
      setMemoryLoading(true);
      setStatus(null);
      setIntegrationStatus(null);
      setSearchStatus(null);
      setMemoryStatusMessage(null);
      setMemoryReviewMessage(null);
      try {
        const memoryStatusResult = invokeWithTimeout<MemoryRuntimeStatus>("memory_status_get", {
          userKey,
        })
          .then((loadedMemoryStatus) => ({ loadedMemoryStatus }))
          .catch((error: unknown) => ({ error }));
        const memoryReviewResult = invokeWithTimeout<MemoryReviewListResult>("memory_review_list", {
          userKey,
        })
          .then((loadedMemoryReview) => ({ loadedMemoryReview }))
          .catch((error: unknown) => ({ error }));
        const googleWorkspaceCapabilityResult = invokeWithTimeout<GoogleWorkspaceCapabilityStatus>(
          "google_workspace_capability_status"
        )
          .then((loadedGoogleWorkspaceCapability) => ({ loadedGoogleWorkspaceCapability }))
          .catch((error: unknown) => ({ error }));
        const [loaded, loadedIntegrations, loadedGoogleWorkspaceOAuthClientStatus] =
          await Promise.all([
            invokeWithTimeout<ModelSettingsRead>("model_settings_get", { userKey }),
            invokeWithTimeout<IntegrationSettingsRead>("integration_settings_get", { userKey }),
            invokeWithTimeout<GoogleWorkspaceOAuthClientStatus>(
              "google_workspace_oauth_client_status"
            ),
          ]);
        if (!active) {
          return;
        }
        hydrateFromSettings(loaded);
        hydrateFromIntegrations(loadedIntegrations);
        setGoogleWorkspaceOAuthClientStatus(loadedGoogleWorkspaceOAuthClientStatus);
        const loadedGoogleWorkspaceCapabilityResult = await googleWorkspaceCapabilityResult;
        if (!active) {
          return;
        }
        if ("loadedGoogleWorkspaceCapability" in loadedGoogleWorkspaceCapabilityResult) {
          setGoogleWorkspaceCapability(
            loadedGoogleWorkspaceCapabilityResult.loadedGoogleWorkspaceCapability
          );
        }
        const loadedMemoryResult = await memoryStatusResult;
        if (!active) {
          return;
        }
        if ("loadedMemoryStatus" in loadedMemoryResult) {
          setMemoryStatus(loadedMemoryResult.loadedMemoryStatus);
        } else {
          setMemoryStatusMessage({
            message:
              loadedMemoryResult.error instanceof Error
                ? loadedMemoryResult.error.message
                : String(loadedMemoryResult.error),
            tone: "error",
          });
        }
        const loadedReviewResult = await memoryReviewResult;
        if (!active) {
          return;
        }
        if ("loadedMemoryReview" in loadedReviewResult) {
          setMemoryReview(loadedReviewResult.loadedMemoryReview);
        } else {
          setMemoryReviewMessage({
            message:
              loadedReviewResult.error instanceof Error
                ? loadedReviewResult.error.message
                : String(loadedReviewResult.error),
            tone: "error",
          });
        }
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
          setMemoryLoading(false);
          setMemoryReviewLoading(false);
        }
      }
    }

    void loadSettings();

    return () => {
      active = false;
    };
  }, [userKey]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;

    if (!workspaceRoot) {
      setStyleGuideResult(null);
      setStyleGuideDraftText("");
      setStyleGuideLoading(false);
      setStyleGuideStatus(null);
      return () => {
        active = false;
      };
    }

    async function loadStyleGuide() {
      setStyleGuideLoading(true);
      setStyleGuideStatus(null);
      try {
        const next = await invokeWithTimeout<WorkspaceStyleGuideReadResult>(
          "workspace_style_guide_get",
          { workspaceRoot },
          20_000
        );
        if (!active || !mountedRef.current) {
          return;
        }
        setStyleGuideResult(next);
        setStyleGuideDraftText(JSON.stringify(next.config, null, 2));
        setStyleGuideCopyTypeKey(
          next.config.styleGuide?.profile.defaultCopyType ??
            Object.keys(next.config.styleGuide?.copyTypes ?? {})[0] ??
            "blog.article.long"
        );
      } catch (error) {
        if (!active || !mountedRef.current) {
          return;
        }
        setStyleGuideResult(null);
        setStyleGuideDraftText(JSON.stringify(DEFAULT_WORKSPACE_STYLE_CONFIG, null, 2));
        setStyleGuideCopyTypeKey("blog.article.long");
        setStyleGuideStatus({
          message: error instanceof Error ? error.message : String(error),
          tone: "error",
        });
      } finally {
        if (active && mountedRef.current) {
          setStyleGuideLoading(false);
        }
      }
    }

    void loadStyleGuide();

    return () => {
      active = false;
    };
  }, [setStyleGuideDraftText, workspaceRoot]);

  const hasCredential = settings?.providers[selectedProvider]?.hasCredential ?? false;
  const hasIntegrationCredential = integrations?.providers.googleWorkspace.hasCredential ?? false;
  const hasSearchCredential =
    searchProviderSettings(integrations, selectedSearchProvider)?.hasCredential ?? false;
  const integrationAllowsCredentials = integrationProviderSupportsCredential(selectedIntegration);
  const searchProviderAllowsCredentials = searchProviderSupportsCredential(selectedSearchProvider);
  const modelBusy = loading || activeModelAction !== null;
  const integrationBusy = loading || activeIntegrationAction !== null;
  const searchBusy = loading || activeSearchAction !== null;
  const requiresBaseUrl = draft.provider === "local";
  const canSubmit =
    draft.model.trim().length > 0 && (!requiresBaseUrl || draft.baseUrl.trim().length > 0);
  const isCodexProvider = selectedProvider === "openai-codex";
  const canRemoveGoogleWorkspaceOAuthClient = googleWorkspaceOAuthClientStatus.source === "saved";
  const googleWorkspaceManagedInstallRequired = Boolean(
    selectedIntegration === "google-workspace" &&
      googleWorkspaceCapability?.installAvailable &&
      !googleWorkspaceCapability.installed
  );
  const googleWorkspaceProgressPercent = capabilityProgressPercent(
    googleWorkspaceCapability?.progress
  );

  function hydrateFromSettings(
    loaded: ModelSettingsRead,
    provider: ModelProvider = loaded.selectedProvider
  ) {
    setSettings(loaded);
    setSelectedProvider(provider);
    const providerSettings = loaded.providers[provider];
    setDraft(providerConfigFromSettings(providerSettings) ?? defaultDraftForProvider(provider));
    setApiKey("");
  }

  function hydrateFromIntegrations(loaded: IntegrationSettingsRead) {
    setIntegrations(loaded);
    if (!loaded.providers.googleWorkspace.hasCredential) {
      setGoogleWorkspaceHealth([]);
    }
    setSearchMode(loaded.search.mode);
    setAllowKeylessFallback(loaded.search.allowKeylessFallback);
    setSelectedSearchProvider((current) =>
      loaded.search.mode === "auto" ? current : loaded.search.mode
    );
    setIntegrationApiKey("");
    setSearchApiKey("");
  }

  async function refreshGoogleWorkspaceCapability() {
    const status = await invokeWithTimeout<GoogleWorkspaceCapabilityStatus>(
      "google_workspace_capability_status"
    );
    if (mountedRef.current) {
      setGoogleWorkspaceCapability(status);
    }
    return status;
  }

  async function refreshGoogleWorkspaceHealth(requestId: number) {
    const health =
      await invokeWithTimeout<GoogleWorkspaceServiceHealth[]>("google_workspace_health");
    if (mountedRef.current && integrationRequestIdRef.current === requestId) {
      setGoogleWorkspaceHealth(health);
    }
  }

  async function handleRefreshMemoryStatus() {
    setMemoryLoading(true);
    setMemoryStatusMessage(null);
    try {
      const next = await invokeWithTimeout<MemoryRuntimeStatus>("memory_status_get", { userKey });
      if (!mountedRef.current) {
        return;
      }
      setMemoryStatus(next);
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      setMemoryStatusMessage({
        message: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      if (mountedRef.current) {
        setMemoryLoading(false);
      }
    }
    await loadMemoryReview();
  }

  async function loadMemoryReview() {
    setMemoryReviewLoading(true);
    setMemoryReviewMessage(null);
    try {
      const next = await invokeWithTimeout<MemoryReviewListResult>("memory_review_list", {
        userKey,
      });
      if (!mountedRef.current) {
        return;
      }
      setMemoryReview(next);
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      setMemoryReviewMessage({
        message: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      if (mountedRef.current) {
        setMemoryReviewLoading(false);
      }
    }
  }

  async function handleMemoryReviewDecision(
    memoryId: string,
    decision: MemoryReviewDecisionRequest["decision"]
  ) {
    const actionId = `${memoryId}:${decision}`;
    setActiveMemoryAction(actionId);
    setMemoryReviewMessage(null);
    try {
      await invokeWithTimeout<Memory>("memory_review_decide", {
        decision: {
          memoryId,
          decision,
          reason: `Memory ${decision} from Settings review.`,
          decidedAt: new Date().toISOString(),
        } satisfies MemoryReviewDecisionRequest,
        userKey,
      });
      if (!mountedRef.current) {
        return;
      }
      setMemoryReviewMessage({
        message:
          decision === "accept"
            ? "Memory accepted."
            : decision === "reject"
              ? "Memory rejected."
              : "Memory archived.",
        tone: "success",
      });
      await loadMemoryReview();
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      setMemoryReviewMessage({
        message: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      if (mountedRef.current) {
        setActiveMemoryAction(null);
      }
    }
  }

  async function handleMemoryForget(memoryId: string) {
    const actionId = `${memoryId}:delete`;
    setActiveMemoryAction(actionId);
    setMemoryReviewMessage(null);
    try {
      await invokeWithTimeout<{ ok: boolean }>("memory_forget", {
        request: {
          memoryId,
          action: "delete",
          reason: "Memory forgotten from Settings.",
          requestedAt: new Date().toISOString(),
        } satisfies MemoryForgetRequest,
        userKey,
      });
      if (!mountedRef.current) {
        return;
      }
      setMemoryReviewMessage({
        message: "Memory forgotten.",
        tone: "success",
      });
      await loadMemoryReview();
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      setMemoryReviewMessage({
        message: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      if (mountedRef.current) {
        setActiveMemoryAction(null);
      }
    }
  }

  async function pollGoogleWorkspaceConnection(requestId: number) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      if (!mountedRef.current || integrationRequestIdRef.current !== requestId) {
        return;
      }
      const result = await invokeWithTimeout<IntegrationConnectionTestResult>(
        "google_workspace_connection_status",
        { userKey }
      );
      if (!mountedRef.current || integrationRequestIdRef.current !== requestId) {
        return;
      }
      if (result.ok) {
        setIntegrationStatus({ message: result.message, tone: "success" });
        const next = await invokeWithTimeout<IntegrationSettingsRead>("integration_settings_get", {
          userKey,
        });
        if (mountedRef.current && integrationRequestIdRef.current === requestId) {
          hydrateFromIntegrations(next);
        }
        await refreshGoogleWorkspaceHealth(requestId);
        return;
      }
    }
    if (mountedRef.current && integrationRequestIdRef.current === requestId) {
      setIntegrationStatus({
        message: "Finish Google sign-in in your browser, then click Test connection.",
        tone: "info",
      });
    }
  }

  function handleProviderSelect(provider: ModelProvider) {
    if (modelBusy) {
      return;
    }
    setSelectedProvider(provider);
    setDraft(
      settings
        ? (providerConfigFromSettings(settings.providers[provider]) ??
            defaultDraftForProvider(provider))
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
    setGoogleWorkspaceInstallConsent(false);
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
        userKey,
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

  function resetStyleGuideDraftToDefaults() {
    setStyleGuideDraftText(JSON.stringify(DEFAULT_WORKSPACE_STYLE_CONFIG, null, 2));
    setStyleGuideCopyTypeKey("blog.article.long");
    setStyleGuideStatus({ message: "Default style guide ready to edit", tone: "info" });
  }

  function updateStyleGuideDraft(update: (styleGuide: WorkspaceStyleGuide) => void) {
    const parsed = parseWorkspaceStyleDraft(styleGuideDraftRef.current);
    if (!parsed) {
      setStyleGuideStatus({
        message: "Fix the advanced JSON before editing fields.",
        tone: "error",
      });
      return;
    }

    const next = parsed.styleGuide
      ? cloneWorkspaceConfig(parsed)
      : {
          ...cloneWorkspaceConfig(parsed),
          styleGuide: cloneWorkspaceConfig(DEFAULT_WORKSPACE_STYLE_CONFIG).styleGuide,
        };
    if (!next.styleGuide) {
      return;
    }
    update(next.styleGuide);
    setStyleGuideDraftText(JSON.stringify(WorkspaceConfigSchema.parse(next), null, 2));
    setStyleGuideStatus({ message: "Unsaved style guide changes", tone: "info" });
  }

  function updateSelectedCopyType(update: (copyType: WorkspaceStyleCopyTypeDraft) => void) {
    if (!selectedStyleGuideCopyTypeKey) return;
    updateStyleGuideDraft((guide) => {
      const existing = guide.copyTypes[selectedStyleGuideCopyTypeKey] ?? {
        label: selectedStyleGuideCopyTypeKey,
        tone: [],
        formatRules: [],
      };
      const nextCopyType: WorkspaceStyleCopyTypeDraft = { ...existing };
      update(nextCopyType);
      guide.copyTypes = {
        ...guide.copyTypes,
        [selectedStyleGuideCopyTypeKey]: nextCopyType,
      };
    });
  }

  function updateFirstExample(update: (example: WorkspaceStyleExampleDraft) => void) {
    updateStyleGuideDraft((guide) => {
      const examples = [...guide.examples];
      const nextExample: WorkspaceStyleExampleDraft = {
        kind: "positive",
        label: "Example",
        text: "Example copy goes here.",
        ...(examples[0] ?? {}),
      };
      update(nextExample);
      examples[0] = nextExample;
      guide.examples = examples;
    });
  }

  async function handleReloadStyleGuide() {
    if (!workspaceRoot || styleGuideLoading || styleGuideSaving) {
      return;
    }

    setStyleGuideLoading(true);
    setStyleGuideStatus(null);
    try {
      const next = await invokeWithTimeout<WorkspaceStyleGuideReadResult>(
        "workspace_style_guide_get",
        { workspaceRoot },
        20_000
      );
      if (!mountedRef.current) {
        return;
      }
      setStyleGuideResult(next);
      setStyleGuideDraftText(JSON.stringify(next.config, null, 2));
      setStyleGuideCopyTypeKey(
        next.config.styleGuide?.profile.defaultCopyType ??
          Object.keys(next.config.styleGuide?.copyTypes ?? {})[0] ??
          "blog.article.long"
      );
      setStyleGuideStatus({ message: "Style guide reloaded", tone: "success" });
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      setStyleGuideStatus({
        message: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      if (mountedRef.current) {
        setStyleGuideLoading(false);
      }
    }
  }

  async function handleSaveStyleGuide(options: { overwrite?: boolean } = {}) {
    if (!workspaceRoot || styleGuideSaving) {
      return;
    }

    try {
      const config = WorkspaceConfigSchema.parse(JSON.parse(styleGuideDraftRef.current));
      setStyleGuideSaving(true);
      setStyleGuideStatus(null);
      const next = await invokeWithTimeout<WorkspaceStyleGuideSaveResult>(
        "workspace_style_guide_save",
        {
          request: {
            workspaceRoot,
            config,
            ...(styleGuideResult?.fingerprint
              ? { expectedFingerprint: styleGuideResult.fingerprint }
              : {}),
            ...(options.overwrite ? { overwrite: true } : {}),
          },
        },
        20_000
      );
      if (!mountedRef.current) {
        return;
      }
      setStyleGuideResult(next);
      setStyleGuideDraftText(JSON.stringify(next.config, null, 2));
      setStyleGuideCopyTypeKey(
        next.config.styleGuide?.profile.defaultCopyType ??
          Object.keys(next.config.styleGuide?.copyTypes ?? {})[0] ??
          "blog.article.long"
      );
      setStyleGuideStatus({ message: "Style guide saved", tone: "success" });
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      setStyleGuideStatus({
        message: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      if (mountedRef.current) {
        setStyleGuideSaving(false);
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
        userKey,
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
        userKey,
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

  async function handleCodexSignIn() {
    if (modelBusy || !isCodexProvider) return;
    const requestId = ++modelRequestIdRef.current;
    setActiveModelAction("codexSignIn");
    setStatus({ message: "Starting ChatGPT sign-in...", tone: "info" });
    try {
      const deviceCode = await invokeWithTimeout<CodexDeviceCode>("model_codex_oauth_device_code");
      if (!mountedRef.current || modelRequestIdRef.current !== requestId) {
        return;
      }
      setStatus({
        message: `Open ${deviceCode.verificationUri} and enter code ${deviceCode.userCode}. Waiting for approval...`,
        tone: "info",
      });
      for (let attempt = 0; attempt < 90; attempt += 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(3, deviceCode.interval) * 1_000)
        );
        if (!mountedRef.current || modelRequestIdRef.current !== requestId) {
          return;
        }
        const result = await invokeWithTimeout<CodexPollResult>("model_codex_oauth_poll", {
          deviceAuthId: deviceCode.deviceAuthId,
          userKey,
          userCode: deviceCode.userCode,
        });
        if (result.status === "authorized") {
          if (!mountedRef.current || modelRequestIdRef.current !== requestId) {
            return;
          }
          hydrateFromSettings(result.settings, "openai-codex");
          setStatus({ message: "ChatGPT sign-in connected", tone: "success" });
          return;
        }
      }
      if (mountedRef.current && modelRequestIdRef.current === requestId) {
        setStatus({
          message: "ChatGPT sign-in is still pending. Start sign-in again when you are ready.",
          tone: "info",
        });
      }
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
          hasExistingCredential: integrationAllowsCredentials && hasIntegrationCredential,
          ...(integrationAllowsCredentials && shouldSendIntegrationCredential(integrationApiKey)
            ? { credential: { apiKey: integrationApiKey.trim() } }
            : {}),
        },
        userKey,
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
          userKey,
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
    if (selectedIntegration === "google-workspace" && googleWorkspaceManagedInstallRequired) {
      setGoogleWorkspaceInstallConsent(true);
      setIntegrationStatus({
        message: "Download the Google Workspace connector before testing.",
        tone: "info",
      });
      return;
    }

    const requestId = ++integrationRequestIdRef.current;
    setActiveIntegrationAction("test");
    setIntegrationStatus(null);
    try {
      const result = await invokeWithTimeout<IntegrationConnectionTestResult>(
        "integration_connection_test",
        {
          request: {
            provider: selectedIntegration,
            ...(integrationAllowsCredentials && shouldSendIntegrationCredential(integrationApiKey)
              ? { credential: { apiKey: integrationApiKey.trim() } }
              : {}),
          },
          userKey,
        }
      );
      if (!mountedRef.current || integrationRequestIdRef.current !== requestId) {
        return;
      }
      setIntegrationStatus({ message: result.message, tone: result.ok ? "success" : "info" });
      if (selectedIntegration === "google-workspace" && !integrationAllowsCredentials) {
        const next = await invokeWithTimeout<IntegrationSettingsRead>("integration_settings_get", {
          userKey,
        });
        if (mountedRef.current && integrationRequestIdRef.current === requestId) {
          hydrateFromIntegrations(next);
        }
        if (result.ok) {
          await refreshGoogleWorkspaceHealth(requestId);
        }
      }
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

  async function handleInstallGoogleWorkspaceCapability() {
    if (integrationBusy || !googleWorkspaceCapability?.installAvailable) return;
    if (googleWorkspaceCapability.installed) return;
    if (!googleWorkspaceInstallConsent) {
      setGoogleWorkspaceInstallConsent(true);
      setIntegrationStatus({
        message: "Confirm download to install the Google Workspace connector.",
        tone: "info",
      });
      return;
    }

    const requestId = ++integrationRequestIdRef.current;
    setActiveIntegrationAction("installGws");
    setIntegrationStatus(null);
    let polling = true;
    const pollStatus = async () => {
      while (polling) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        if (!mountedRef.current || integrationRequestIdRef.current !== requestId) {
          return;
        }
        try {
          await refreshGoogleWorkspaceCapability();
        } catch {
          // The install request below owns the user-facing error.
        }
      }
    };
    void pollStatus();

    try {
      const next = await invokeWithTimeout<GoogleWorkspaceCapabilityStatus>(
        "google_workspace_capability_install",
        undefined,
        120_000
      );
      if (!mountedRef.current || integrationRequestIdRef.current !== requestId) {
        return;
      }
      setGoogleWorkspaceCapability(next);
      setGoogleWorkspaceInstallConsent(false);
      setIntegrationStatus({ message: "Google Workspace connector installed.", tone: "success" });
    } catch (error) {
      if (!mountedRef.current || integrationRequestIdRef.current !== requestId) {
        return;
      }
      setIntegrationStatus({
        message: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      polling = false;
      if (mountedRef.current && integrationRequestIdRef.current === requestId) {
        setActiveIntegrationAction(null);
      }
    }
  }

  async function handleConnectGoogleWorkspace() {
    if (integrationBusy || !googleWorkspaceOAuthClientStatus.hasClient) return;
    if (googleWorkspaceManagedInstallRequired) {
      setGoogleWorkspaceInstallConsent(true);
      setIntegrationStatus({
        message: "Download the Google Workspace connector before connecting.",
        tone: "info",
      });
      return;
    }
    const requestId = ++integrationRequestIdRef.current;
    setActiveIntegrationAction("connect");
    setIntegrationStatus({ message: "Opening Google sign-in...", tone: "info" });
    try {
      const result = await invokeWithTimeout<IntegrationConnectionTestResult>(
        "google_workspace_connect",
        { userKey },
        120_000
      );
      if (!mountedRef.current || integrationRequestIdRef.current !== requestId) {
        return;
      }
      setIntegrationStatus({
        message: result.message,
        tone: result.ok ? "success" : result.message.includes("Google sign-in") ? "info" : "error",
      });
      if (result.ok) {
        const next = await invokeWithTimeout<IntegrationSettingsRead>("integration_settings_get", {
          userKey,
        });
        if (mountedRef.current && integrationRequestIdRef.current === requestId) {
          hydrateFromIntegrations(next);
        }
        await refreshGoogleWorkspaceHealth(requestId);
      } else if (result.message.includes("Google sign-in")) {
        setActiveIntegrationAction(null);
        void pollGoogleWorkspaceConnection(requestId);
      }
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

  async function handleDisconnectGoogleWorkspace() {
    if (integrationBusy) return;
    const requestId = ++integrationRequestIdRef.current;
    setActiveIntegrationAction("disconnect");
    setIntegrationStatus(null);
    try {
      const next = await invokeWithTimeout<IntegrationSettingsRead>("google_workspace_disconnect", {
        userKey,
      });
      if (!mountedRef.current || integrationRequestIdRef.current !== requestId) {
        return;
      }
      hydrateFromIntegrations(next);
      setGoogleWorkspaceHealth([]);
      setIntegrationStatus({ message: "Google Workspace disconnected.", tone: "success" });
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

  async function handleSaveGoogleWorkspaceOAuthClient() {
    if (integrationBusy) return;
    const clientId = googleWorkspaceClientIdRef.current?.value.trim() ?? "";
    const clientSecret = googleWorkspaceClientSecretRef.current?.value.trim() ?? "";
    const requestId = ++integrationRequestIdRef.current;
    setActiveIntegrationAction("saveOAuthClient");
    setIntegrationStatus(null);
    try {
      const next = await invokeWithTimeout<GoogleWorkspaceOAuthClientStatus>(
        "google_workspace_oauth_client_save",
        {
          request: {
            clientId,
            clientSecret,
          },
        }
      );
      if (!mountedRef.current || integrationRequestIdRef.current !== requestId) {
        return;
      }
      setGoogleWorkspaceOAuthClientStatus(next);
      if (googleWorkspaceClientIdRef.current) googleWorkspaceClientIdRef.current.value = "";
      if (googleWorkspaceClientSecretRef.current) {
        googleWorkspaceClientSecretRef.current.value = "";
      }
      setIntegrationStatus({ message: "OAuth client saved.", tone: "success" });
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

  async function handleRemoveGoogleWorkspaceOAuthClient() {
    if (integrationBusy || !canRemoveGoogleWorkspaceOAuthClient) return;
    const requestId = ++integrationRequestIdRef.current;
    setActiveIntegrationAction("remove");
    setIntegrationStatus(null);
    try {
      const next = await invokeWithTimeout<GoogleWorkspaceOAuthClientStatus>(
        "google_workspace_oauth_client_delete"
      );
      if (!mountedRef.current || integrationRequestIdRef.current !== requestId) {
        return;
      }
      setGoogleWorkspaceOAuthClientStatus(next);
      setIntegrationStatus({ message: "OAuth client removed.", tone: "success" });
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
        userKey,
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
          userKey,
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
          userKey,
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
      <aside className="flex w-56 flex-shrink-0 flex-col border-r border-border bg-secondary px-4 py-5 gap-2">
        <div className="text-sm font-semibold text-foreground mb-3">Settings</div>
        <button
          type="button"
          onClick={() => setActiveTab("model")}
          className={cn(
            "rounded-xl px-3 py-2 text-left text-sm font-medium transition-colors flex items-center gap-2",
            activeTab === "model"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:bg-background/50 hover:text-foreground"
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
              : "text-muted-foreground hover:bg-background/50 hover:text-foreground"
          )}
        >
          <Search size={16} />
          Integrations
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("memory")}
          className={cn(
            "rounded-xl px-3 py-2 text-left text-sm font-medium transition-colors flex items-center gap-2",
            activeTab === "memory"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:bg-background/50 hover:text-foreground"
          )}
        >
          <Database size={16} />
          Memory
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("styleGuide")}
          className={cn(
            "rounded-xl px-3 py-2 text-left text-sm font-medium transition-colors flex items-center gap-2",
            activeTab === "styleGuide"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:bg-background/50 hover:text-foreground"
          )}
        >
          <FileText size={16} />
          Style Guide
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("agents")}
          className={cn(
            "rounded-xl px-3 py-2 text-left text-sm font-medium transition-colors flex items-center gap-2",
            activeTab === "agents"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:bg-background/50 hover:text-foreground"
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
                  Choose the app default provider and model. Agents can inherit this setting or use
                  their own model override.
                </p>
              </div>
            </div>

            <div className="mt-6 space-y-6">
              <div className="space-y-3">
                <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                  Providers
                </div>
                <p className="text-xs text-muted-foreground">
                  The provider marked App default is used by agents set to inherit the Settings
                  default.
                </p>
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
                              App default
                            </span>
                          )}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {provider === "openai-codex"
                            ? providerSettings?.hasCredential
                              ? "ChatGPT connected"
                              : "Sign in required"
                            : providerSettings?.hasCredential
                              ? "Saved key present"
                              : "No saved key"}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-4">
                <div className="block">
                  <label htmlFor="settings-model" className="text-sm font-medium text-foreground">
                    Model
                  </label>
                  {modelOptionsForProvider(selectedProvider, draft.model).length > 0 ? (
                    <select
                      id="settings-model"
                      className="input mt-2"
                      value={draft.model}
                      disabled={modelBusy}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, model: event.target.value }))
                      }
                    >
                      {modelOptionsForProvider(selectedProvider, draft.model).map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id="settings-model"
                      className="input mt-2"
                      value={draft.model}
                      disabled={modelBusy}
                      placeholder={modelPlaceholderForProvider(selectedProvider)}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, model: event.target.value }))
                      }
                    />
                  )}
                </div>

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

                {isCodexProvider ? (
                  <div className="rounded-xl border border-border bg-secondary px-4 py-3">
                    <div className="text-sm font-medium text-foreground">ChatGPT sign-in</div>
                    <div className="mt-1 text-sm text-muted-foreground">
                      Use your ChatGPT Codex subscription without storing an OpenAI API key.
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">
                      {hasCredential ? "ChatGPT connected" : "No ChatGPT session connected"}
                    </div>
                  </div>
                ) : (
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
                )}

                {status && (
                  <div
                    className={cn(
                      "rounded-xl border px-3 py-2 text-sm",
                      status.tone === "error" &&
                        "border-destructive/25 bg-destructive/5 text-destructive",
                      status.tone === "info" && "border-border bg-secondary text-foreground",
                      status.tone === "success" &&
                        "border-emerald-200 bg-emerald-50 text-emerald-800"
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
                  {isCodexProvider && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleCodexSignIn}
                      disabled={modelBusy || !canSubmit}
                    >
                      {activeModelAction === "codexSignIn" ? (
                        <Loader2 size={16} className="animate-spin" />
                      ) : (
                        <KeyRound size={16} />
                      )}
                      Sign in with ChatGPT
                    </Button>
                  )}
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
                    {isCodexProvider ? "Disconnect" : "Remove key"}
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
                              ? "border-primary bg-secondary text-foreground shadow-sm"
                              : "border-border bg-background text-foreground hover:bg-secondary/70"
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

                <div className="rounded-xl border border-border bg-secondary/35 px-4 py-3 text-sm text-muted-foreground">
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
                  <div className="rounded-xl border border-dashed border-border bg-secondary/20 px-4 py-3 text-sm text-muted-foreground">
                    DuckDuckGo uses keyless search. No API key is required or stored.
                  </div>
                )}

                {searchStatus && (
                  <div
                    className={cn(
                      "rounded-xl border px-3 py-2 text-sm",
                      searchStatus.tone === "error" &&
                        "border-destructive/25 bg-destructive/5 text-destructive",
                      searchStatus.tone === "info" && "border-border bg-secondary text-foreground",
                      searchStatus.tone === "success" &&
                        "border-emerald-200 bg-emerald-50 text-emerald-800"
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
                    Workspace integration
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
                              ? "border-primary bg-secondary text-foreground shadow-sm"
                              : "border-border bg-background text-foreground hover:bg-secondary/70"
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
                            {integrationProviderSupportsCredential(provider)
                              ? hasIntegrationCredential
                                ? "Saved key present"
                                : "No saved key"
                              : "Uses Google Workspace CLI"}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="rounded-xl border border-border bg-secondary/35 px-4 py-3 text-sm text-muted-foreground">
                  {hasIntegrationCredential
                    ? "Connected with read-only access."
                    : "Connect once to let Tessera read Calendar, Gmail, Drive, Contacts, Docs, and Sheets with Google Workspace."}
                </div>

                {integrationAllowsCredentials && (
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
                          : `Paste ${integrationLabel(selectedIntegration)} API key`
                      }
                      onChange={(event) => setIntegrationApiKey(event.target.value)}
                    />
                  </label>
                )}

                {!integrationAllowsCredentials && (
                  <div className="rounded-xl border border-border bg-background px-4 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium text-foreground">OAuth client</div>
                        <div className="mt-1 text-sm text-muted-foreground">
                          {googleWorkspaceOAuthClientStatus.hasClient
                            ? googleWorkspaceOAuthClientStatus.source === "build"
                              ? "OAuth client bundled with this build."
                              : googleWorkspaceOAuthClientStatus.source === "bundled"
                                ? "OAuth client bundled with the desktop app."
                                : "OAuth client saved for this device."
                            : "Add a Google Workspace OAuth client before connecting."}
                        </div>
                      </div>
                      <span
                        className={cn(
                          "rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide",
                          googleWorkspaceOAuthClientStatus.hasClient
                            ? "bg-emerald-50 text-emerald-800"
                            : "bg-secondary text-muted-foreground"
                        )}
                      >
                        {googleWorkspaceOAuthClientStatus.hasClient ? "Ready" : "Required"}
                      </span>
                    </div>

                    <div className="mt-4 grid gap-3 md:grid-cols-2">
                      <label className="block">
                        <span className="text-sm font-medium text-foreground">OAuth client ID</span>
                        <input
                          className="input mt-2"
                          type="text"
                          ref={googleWorkspaceClientIdRef}
                          disabled={integrationBusy}
                          placeholder="Desktop client ID"
                        />
                      </label>
                      <label className="block">
                        <span className="text-sm font-medium text-foreground">
                          OAuth client secret
                        </span>
                        <input
                          className="input mt-2"
                          type="password"
                          ref={googleWorkspaceClientSecretRef}
                          disabled={integrationBusy}
                          placeholder={
                            googleWorkspaceOAuthClientStatus.hasClient
                              ? "Saved client present"
                              : "Desktop client secret"
                          }
                        />
                      </label>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={handleSaveGoogleWorkspaceOAuthClient}
                        disabled={integrationBusy}
                      >
                        {activeIntegrationAction === "saveOAuthClient" ? (
                          <Loader2 size={16} className="animate-spin" />
                        ) : (
                          <KeyRound size={16} />
                        )}
                        Save OAuth client
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={handleRemoveGoogleWorkspaceOAuthClient}
                        disabled={integrationBusy || !canRemoveGoogleWorkspaceOAuthClient}
                      >
                        {activeIntegrationAction === "remove" ? (
                          <Loader2 size={16} className="animate-spin" />
                        ) : (
                          <Trash2 size={16} />
                        )}
                        Remove OAuth client
                      </Button>
                    </div>
                  </div>
                )}

                {!integrationAllowsCredentials && googleWorkspaceCapability && (
                  <div className="rounded-xl border border-border bg-background px-4 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium text-foreground">
                          Google Workspace CLI
                        </div>
                        <div className="mt-1 text-sm text-muted-foreground">
                          {googleWorkspaceCapabilityDescription(googleWorkspaceCapability)}
                        </div>
                      </div>
                      <span
                        className={cn(
                          "rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide",
                          googleWorkspaceCapability.installed
                            ? "bg-emerald-50 text-emerald-800"
                            : googleWorkspaceCapability.installAvailable
                              ? "bg-amber-50 text-amber-800"
                              : "bg-secondary text-muted-foreground"
                        )}
                      >
                        {googleWorkspaceCapabilityStatusLabel(googleWorkspaceCapability)}
                      </span>
                    </div>

                    {googleWorkspaceCapability.progress &&
                      activeIntegrationAction === "installGws" && (
                        <div className="mt-4 space-y-2">
                          <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                            <span>
                              {googleWorkspaceCapabilityProgressLabel(
                                googleWorkspaceCapability.progress
                              )}
                            </span>
                            <span>
                              {googleWorkspaceProgressPercent !== null
                                ? `${googleWorkspaceProgressPercent}%`
                                : ""}
                            </span>
                          </div>
                          <div className="h-2 overflow-hidden rounded-full bg-secondary">
                            <div
                              className={cn(
                                "h-full rounded-full bg-primary transition-all",
                                googleWorkspaceProgressPercent === null && "w-1/2 animate-pulse"
                              )}
                              style={
                                googleWorkspaceProgressPercent === null
                                  ? undefined
                                  : { width: `${googleWorkspaceProgressPercent}%` }
                              }
                            />
                          </div>
                        </div>
                      )}

                    {!googleWorkspaceCapability.installed &&
                      googleWorkspaceCapability.installAvailable && (
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <Button
                            type="button"
                            variant={googleWorkspaceInstallConsent ? "default" : "outline"}
                            onClick={handleInstallGoogleWorkspaceCapability}
                            disabled={integrationBusy}
                          >
                            {activeIntegrationAction === "installGws" ? (
                              <Loader2 size={16} className="animate-spin" />
                            ) : (
                              <Download size={16} />
                            )}
                            {googleWorkspaceInstallConsent
                              ? "Install connector"
                              : "Download connector"}
                          </Button>
                          {googleWorkspaceInstallConsent && (
                            <Button
                              type="button"
                              variant="outline"
                              onClick={() => {
                                setGoogleWorkspaceInstallConsent(false);
                                setIntegrationStatus(null);
                              }}
                              disabled={integrationBusy}
                            >
                              Cancel
                            </Button>
                          )}
                          {googleWorkspaceCapability.sizeBytes !== undefined && (
                            <span className="text-xs text-muted-foreground">
                              {formatCapabilityBytes(googleWorkspaceCapability.sizeBytes)}
                            </span>
                          )}
                        </div>
                      )}
                  </div>
                )}

                {!integrationAllowsCredentials && (
                  <div className="rounded-xl border border-border bg-background px-4 py-3">
                    <div className="mb-2 text-sm font-medium text-foreground">
                      Workspace services
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {GOOGLE_WORKSPACE_CAPABILITIES.map((service) => {
                        const health = googleWorkspaceHealth.find(
                          (item) => item.service === service
                        );
                        const message = health
                          ? health.message
                          : hasIntegrationCredential
                            ? "Not checked"
                            : "Connect required";
                        return (
                          <div
                            key={service}
                            className="flex items-center justify-between gap-3 rounded-lg border border-border bg-secondary/30 px-3 py-2"
                          >
                            <span className="text-sm font-medium text-foreground">{service}</span>
                            <span
                              className={cn(
                                "text-xs",
                                health
                                  ? health.ok
                                    ? "text-emerald-700"
                                    : "text-destructive"
                                  : "text-muted-foreground"
                              )}
                            >
                              {message}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {integrationStatus && (
                  <div
                    className={cn(
                      "rounded-xl border px-3 py-2 text-sm",
                      integrationStatus.tone === "error" &&
                        "border-destructive/25 bg-destructive/5 text-destructive",
                      integrationStatus.tone === "info" &&
                        "border-border bg-secondary text-foreground",
                      integrationStatus.tone === "success" &&
                        "border-emerald-200 bg-emerald-50 text-emerald-800"
                    )}
                  >
                    {integrationStatus.message}
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  {!integrationAllowsCredentials && !hasIntegrationCredential && (
                    <Button
                      type="button"
                      onClick={handleConnectGoogleWorkspace}
                      disabled={
                        integrationBusy ||
                        !googleWorkspaceOAuthClientStatus.hasClient ||
                        googleWorkspaceManagedInstallRequired
                      }
                    >
                      {activeIntegrationAction === "connect" ? (
                        <Loader2 size={16} className="animate-spin" />
                      ) : (
                        <KeyRound size={16} />
                      )}
                      Connect Google Workspace
                    </Button>
                  )}
                  {!integrationAllowsCredentials && hasIntegrationCredential && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleDisconnectGoogleWorkspace}
                      disabled={integrationBusy}
                    >
                      {activeIntegrationAction === "disconnect" ? (
                        <Loader2 size={16} className="animate-spin" />
                      ) : (
                        <Trash2 size={16} />
                      )}
                      Disconnect
                    </Button>
                  )}
                  {integrationAllowsCredentials && (
                    <Button
                      type="button"
                      onClick={handleSaveIntegration}
                      disabled={integrationBusy}
                    >
                      {activeIntegrationAction === "save" ? (
                        <Loader2 size={16} className="animate-spin" />
                      ) : (
                        <KeyRound size={16} />
                      )}
                      Save
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleIntegrationTestConnection}
                    disabled={integrationBusy || googleWorkspaceManagedInstallRequired}
                  >
                    {activeIntegrationAction === "test" ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : (
                      <Wifi size={16} />
                    )}
                    Test connection
                  </Button>
                  {integrationAllowsCredentials && (
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
                  )}
                </div>
              </section>
            </div>
          </div>
        ) : activeTab === "styleGuide" ? (
          <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col px-8 py-6">
            <div className="flex items-start justify-between gap-4 border-b border-border pb-5">
              <div className="min-w-0">
                <h1 className="text-xl font-semibold text-foreground">Style Guide</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  Workspace-local writing style for playbooks that opt into voice guidance.
                </p>
              </div>
            </div>

            <div className="mt-6 space-y-4">
              <section className="rounded-xl border border-border bg-background px-4 py-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <FileText size={18} className="text-muted-foreground" />
                      <h2 className="text-sm font-semibold text-foreground">
                        .tessera/config.json
                      </h2>
                    </div>
                    <p className="mt-1 break-all text-sm text-muted-foreground">
                      {workspaceRoot ?? "Select a workspace to edit its local style guide."}
                    </p>
                  </div>
                  <span
                    className={cn(
                      "rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide",
                      styleGuideLoading
                        ? "bg-secondary text-muted-foreground"
                        : styleGuideResult?.exists
                          ? "bg-emerald-50 text-emerald-800"
                          : "bg-amber-50 text-amber-800"
                    )}
                  >
                    {styleGuideLoading
                      ? "Loading"
                      : styleGuideResult?.exists
                        ? "Configured"
                        : "Defaults"}
                  </span>
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  <div className="rounded-lg border border-border bg-secondary/30 px-3 py-2">
                    <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                      Profile
                    </div>
                    <div className="mt-1 truncate text-sm font-medium text-foreground">
                      {styleGuideResult?.config.styleGuide?.profile.name ?? "Not configured"}
                    </div>
                  </div>
                  <div className="rounded-lg border border-border bg-secondary/30 px-3 py-2">
                    <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                      Copy Types
                    </div>
                    <div className="mt-1 text-sm font-medium text-foreground">
                      {Object.keys(styleGuideResult?.config.styleGuide?.copyTypes ?? {}).length}
                    </div>
                  </div>
                  <div className="rounded-lg border border-border bg-secondary/30 px-3 py-2">
                    <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                      Fingerprint
                    </div>
                    <div className="mt-1 truncate text-sm font-medium text-foreground">
                      {styleGuideResult?.fingerprint ?? "Not loaded"}
                    </div>
                  </div>
                </div>
              </section>

              <section className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-sm font-semibold text-foreground">Style fields</h2>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={resetStyleGuideDraftToDefaults}
                    disabled={!workspaceRoot || styleGuideLoading || styleGuideSaving}
                  >
                    Start from defaults
                  </Button>
                </div>

                {!workspaceRoot ? (
                  <div className="rounded-xl border border-border bg-secondary/30 px-4 py-4 text-sm text-muted-foreground">
                    Select a workspace to create or edit its local style guide.
                  </div>
                ) : !styleGuideEditor ? (
                  <div className="rounded-xl border border-border bg-secondary/30 px-4 py-4 text-sm text-muted-foreground">
                    {styleGuideEditorConfig
                      ? "No style guide is configured yet. Start from defaults to create one."
                      : "The advanced JSON is invalid. Fix it or start from defaults."}
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="grid gap-4 md:grid-cols-2">
                      <section className="rounded-xl border border-border bg-background px-4 py-4">
                        <h3 className="text-sm font-semibold text-foreground">Profile</h3>
                        <div className="mt-3 grid gap-3">
                          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
                            Profile name
                            <input
                              className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                              value={styleGuideEditor.profile.name}
                              disabled={styleGuideSaving}
                              onInput={(event) => {
                                const value = event.currentTarget.value;
                                updateStyleGuideDraft((guide) => {
                                  guide.profile.name = value;
                                });
                              }}
                              onChange={(event) =>
                                updateStyleGuideDraft((guide) => {
                                  guide.profile.name = event.target.value;
                                })
                              }
                            />
                          </label>
                          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
                            Locale
                            <input
                              className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                              value={styleGuideEditor.profile.locale}
                              disabled={styleGuideSaving}
                              onChange={(event) =>
                                updateStyleGuideDraft((guide) => {
                                  guide.profile.locale = event.target.value;
                                })
                              }
                            />
                          </label>
                          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
                            Default copy type
                            <select
                              className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                              value={styleGuideEditor.profile.defaultCopyType}
                              disabled={styleGuideSaving}
                              onChange={(event) => {
                                setStyleGuideCopyTypeKey(event.target.value);
                                updateStyleGuideDraft((guide) => {
                                  guide.profile.defaultCopyType = event.target.value;
                                });
                              }}
                            >
                              {styleGuideCopyTypeKeys.map((copyType) => (
                                <option key={copyType} value={copyType}>
                                  {styleGuideEditor.copyTypes[copyType]?.label ?? copyType}
                                </option>
                              ))}
                            </select>
                          </label>
                        </div>
                      </section>

                      <section className="rounded-xl border border-border bg-background px-4 py-4">
                        <h3 className="text-sm font-semibold text-foreground">Voice</h3>
                        <div className="mt-3 grid gap-3">
                          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
                            Persona
                            <input
                              className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                              value={styleGuideEditor.voice.persona}
                              disabled={styleGuideSaving}
                              onChange={(event) =>
                                updateStyleGuideDraft((guide) => {
                                  guide.voice.persona = event.target.value;
                                })
                              }
                            />
                          </label>
                          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
                            Point of view
                            <textarea
                              className="min-h-20 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                              value={styleGuideEditor.voice.pointOfView}
                              disabled={styleGuideSaving}
                              onChange={(event) =>
                                updateStyleGuideDraft((guide) => {
                                  guide.voice.pointOfView = event.target.value;
                                })
                              }
                            />
                          </label>
                          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
                            Voice principles
                            <textarea
                              className="min-h-24 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                              value={listToText(styleGuideEditor.voice.principles)}
                              disabled={styleGuideSaving}
                              onInput={(event) => {
                                const value = event.currentTarget.value;
                                updateStyleGuideDraft((guide) => {
                                  guide.voice.principles = textToList(value);
                                });
                              }}
                              onChange={(event) =>
                                updateStyleGuideDraft((guide) => {
                                  guide.voice.principles = textToList(event.target.value);
                                })
                              }
                            />
                          </label>
                        </div>
                      </section>
                    </div>

                    <div className="grid gap-4 md:grid-cols-2">
                      <section className="rounded-xl border border-border bg-background px-4 py-4">
                        <h3 className="text-sm font-semibold text-foreground">Tone and language</h3>
                        <div className="mt-3 grid gap-3">
                          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
                            Tone words
                            <textarea
                              className="min-h-20 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                              value={listToText(styleGuideEditor.tone.default)}
                              disabled={styleGuideSaving}
                              onChange={(event) =>
                                updateStyleGuideDraft((guide) => {
                                  guide.tone.default = textToList(event.target.value);
                                })
                              }
                            />
                          </label>
                          <div className="grid gap-3 sm:grid-cols-4">
                            {(["formality", "warmth", "urgency", "playfulness"] as const).map(
                              (dimension) => (
                                <label
                                  key={dimension}
                                  className="grid gap-1 text-xs font-medium text-muted-foreground"
                                >
                                  {dimension}
                                  <input
                                    className="rounded-lg border border-border bg-background px-2 py-2 text-sm text-foreground outline-none focus:border-primary"
                                    type="number"
                                    min={0}
                                    max={5}
                                    value={styleGuideEditor.tone.dimensions[dimension] ?? 0}
                                    disabled={styleGuideSaving}
                                    onChange={(event) =>
                                      updateStyleGuideDraft((guide) => {
                                        guide.tone.dimensions[dimension] = Number.parseInt(
                                          event.target.value,
                                          10
                                        );
                                      })
                                    }
                                  />
                                </label>
                              )
                            )}
                          </div>
                          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
                            Reading level
                            <input
                              className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                              value={styleGuideEditor.language.readingLevel}
                              disabled={styleGuideSaving}
                              onChange={(event) =>
                                updateStyleGuideDraft((guide) => {
                                  guide.language.readingLevel = event.target.value;
                                })
                              }
                            />
                          </label>
                          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
                            Banned terms
                            <textarea
                              className="min-h-20 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                              value={listToText(styleGuideEditor.language.bannedTerms)}
                              disabled={styleGuideSaving}
                              onInput={(event) => {
                                const value = event.currentTarget.value;
                                updateStyleGuideDraft((guide) => {
                                  guide.language.bannedTerms = textToList(value);
                                });
                              }}
                              onChange={(event) =>
                                updateStyleGuideDraft((guide) => {
                                  guide.language.bannedTerms = textToList(event.target.value);
                                })
                              }
                            />
                          </label>
                        </div>
                      </section>

                      <section className="rounded-xl border border-border bg-background px-4 py-4">
                        <h3 className="text-sm font-semibold text-foreground">
                          Structure and evidence
                        </h3>
                        <div className="mt-3 grid gap-3">
                          <div className="grid gap-3 sm:grid-cols-2">
                            <label className="grid gap-1 text-xs font-medium text-muted-foreground">
                              Intro max words
                              <input
                                className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                                type="number"
                                min={1}
                                value={styleGuideEditor.structure.introMaxWords ?? ""}
                                disabled={styleGuideSaving}
                                onChange={(event) =>
                                  updateStyleGuideDraft((guide) => {
                                    const value = optionalPositiveInteger(event.target.value);
                                    if (value === undefined)
                                      guide.structure.introMaxWords = undefined;
                                    else guide.structure.introMaxWords = value;
                                  })
                                }
                              />
                            </label>
                            <label className="grid gap-1 text-xs font-medium text-muted-foreground">
                              Paragraph max sentences
                              <input
                                className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                                type="number"
                                min={1}
                                value={styleGuideEditor.structure.paragraphMaxSentences ?? ""}
                                disabled={styleGuideSaving}
                                onChange={(event) =>
                                  updateStyleGuideDraft((guide) => {
                                    const value = optionalPositiveInteger(event.target.value);
                                    if (value === undefined)
                                      guide.structure.paragraphMaxSentences = undefined;
                                    else guide.structure.paragraphMaxSentences = value;
                                  })
                                }
                              />
                            </label>
                          </div>
                          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
                            Structure preferences
                            <textarea
                              className="min-h-20 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                              value={listToText(styleGuideEditor.structure.prefer)}
                              disabled={styleGuideSaving}
                              onChange={(event) =>
                                updateStyleGuideDraft((guide) => {
                                  guide.structure.prefer = textToList(event.target.value);
                                })
                              }
                            />
                          </label>
                          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
                            Claim policy
                            <textarea
                              className="min-h-20 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                              value={styleGuideEditor.evidence.claimPolicy}
                              disabled={styleGuideSaving}
                              onChange={(event) =>
                                updateStyleGuideDraft((guide) => {
                                  guide.evidence.claimPolicy = event.target.value;
                                })
                              }
                            />
                          </label>
                        </div>
                      </section>
                    </div>

                    <section className="rounded-xl border border-border bg-background px-4 py-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <h3 className="text-sm font-semibold text-foreground">Copy type preset</h3>
                        <select
                          className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                          value={selectedStyleGuideCopyTypeKey}
                          disabled={styleGuideSaving}
                          onChange={(event) => setStyleGuideCopyTypeKey(event.target.value)}
                        >
                          {styleGuideCopyTypeKeys.map((copyType) => (
                            <option key={copyType} value={copyType}>
                              {copyType}
                            </option>
                          ))}
                        </select>
                      </div>
                      {selectedStyleGuideCopyType ? (
                        <div className="mt-3 grid gap-3 md:grid-cols-2">
                          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
                            Copy type label
                            <input
                              className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                              value={selectedStyleGuideCopyType.label}
                              disabled={styleGuideSaving}
                              onChange={(event) =>
                                updateSelectedCopyType((copyType) => {
                                  copyType.label = event.target.value;
                                })
                              }
                            />
                          </label>
                          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
                            Length
                            <select
                              className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                              value={selectedStyleGuideCopyType.length ?? ""}
                              disabled={styleGuideSaving}
                              onChange={(event) =>
                                updateSelectedCopyType((copyType) => {
                                  if (!event.target.value) copyType.length = undefined;
                                  else
                                    copyType.length = event.target.value as
                                      | "long"
                                      | "medium"
                                      | "short";
                                })
                              }
                            >
                              <option value="">Unspecified</option>
                              <option value="short">Short</option>
                              <option value="medium">Medium</option>
                              <option value="long">Long</option>
                            </select>
                          </label>
                          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
                            Copy type tone
                            <textarea
                              className="min-h-20 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                              value={listToText(selectedStyleGuideCopyType.tone)}
                              disabled={styleGuideSaving}
                              onChange={(event) =>
                                updateSelectedCopyType((copyType) => {
                                  copyType.tone = textToList(event.target.value);
                                })
                              }
                            />
                          </label>
                          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
                            Format rules
                            <textarea
                              className="min-h-20 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                              value={listToText(selectedStyleGuideCopyType.formatRules)}
                              disabled={styleGuideSaving}
                              onChange={(event) =>
                                updateSelectedCopyType((copyType) => {
                                  copyType.formatRules = textToList(event.target.value);
                                })
                              }
                            />
                          </label>
                        </div>
                      ) : null}
                    </section>

                    <div className="grid gap-4 md:grid-cols-2">
                      <section className="rounded-xl border border-border bg-background px-4 py-4">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <h3 className="text-sm font-semibold text-foreground">Examples</h3>
                          {styleGuideEditor.examples.length === 0 ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => updateFirstExample(() => undefined)}
                            >
                              Add example
                            </Button>
                          ) : null}
                        </div>
                        {styleGuideEditor.examples[0] ? (
                          <div className="mt-3 grid gap-3">
                            <label className="grid gap-1 text-xs font-medium text-muted-foreground">
                              Example label
                              <input
                                className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                                value={styleGuideEditor.examples[0].label ?? ""}
                                disabled={styleGuideSaving}
                                onChange={(event) =>
                                  updateFirstExample((example) => {
                                    example.label = event.target.value || undefined;
                                  })
                                }
                              />
                            </label>
                            <label className="grid gap-1 text-xs font-medium text-muted-foreground">
                              Example text
                              <textarea
                                className="min-h-24 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                                value={styleGuideEditor.examples[0].text}
                                disabled={styleGuideSaving}
                                onChange={(event) =>
                                  updateFirstExample((example) => {
                                    example.text = event.target.value;
                                  })
                                }
                              />
                            </label>
                          </div>
                        ) : (
                          <p className="mt-3 text-sm text-muted-foreground">
                            Add a positive or negative sample when the team has a canonical example.
                          </p>
                        )}
                      </section>

                      <section className="rounded-xl border border-border bg-background px-4 py-4">
                        <h3 className="text-sm font-semibold text-foreground">Review rules</h3>
                        <div className="mt-3 grid gap-3">
                          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
                            Fail on
                            <textarea
                              className="min-h-20 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                              value={listToText(styleGuideEditor.review.failOn)}
                              disabled={styleGuideSaving}
                              onChange={(event) =>
                                updateStyleGuideDraft((guide) => {
                                  guide.review.failOn = textToList(event.target.value);
                                })
                              }
                            />
                          </label>
                          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
                            Warn on
                            <textarea
                              className="min-h-20 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                              value={listToText(styleGuideEditor.review.warnOn)}
                              disabled={styleGuideSaving}
                              onChange={(event) =>
                                updateStyleGuideDraft((guide) => {
                                  guide.review.warnOn = textToList(event.target.value);
                                })
                              }
                            />
                          </label>
                        </div>
                      </section>
                    </div>
                  </div>
                )}

                <details className="rounded-xl border border-border bg-background px-4 py-3">
                  <summary className="cursor-pointer text-sm font-semibold text-foreground">
                    Advanced JSON
                  </summary>
                  <textarea
                    aria-label="Style guide JSON"
                    className="mt-3 min-h-[24rem] w-full resize-y rounded-lg border border-border bg-background px-3 py-3 font-mono text-xs leading-5 text-foreground outline-none focus:border-primary disabled:cursor-not-allowed disabled:opacity-60"
                    value={styleGuideDraft}
                    disabled={!workspaceRoot || styleGuideLoading || styleGuideSaving}
                    spellCheck={false}
                    onInput={(event) => setStyleGuideDraftText(event.currentTarget.value)}
                    onChange={(event) => setStyleGuideDraftText(event.target.value)}
                  />
                </details>
              </section>

              {styleGuideStatus && (
                <div
                  className={cn(
                    "rounded-xl border px-3 py-2 text-sm",
                    styleGuideStatus.tone === "error" &&
                      "border-destructive/25 bg-destructive/5 text-destructive",
                    styleGuideStatus.tone === "info" &&
                      "border-border bg-secondary text-foreground",
                    styleGuideStatus.tone === "success" &&
                      "border-emerald-200 bg-emerald-50 text-emerald-800"
                  )}
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span>{styleGuideStatus.message}</span>
                    {styleGuideConflict ? (
                      <span className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => void handleReloadStyleGuide()}
                          disabled={styleGuideLoading || styleGuideSaving}
                        >
                          <RefreshCw size={14} />
                          Reload
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => void handleSaveStyleGuide({ overwrite: true })}
                          disabled={styleGuideLoading || styleGuideSaving}
                        >
                          Overwrite
                        </Button>
                      </span>
                    ) : null}
                  </div>
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  onClick={() => void handleSaveStyleGuide()}
                  disabled={!workspaceRoot || styleGuideLoading || styleGuideSaving}
                >
                  {styleGuideSaving ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <Check size={16} />
                  )}
                  Save style guide
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    if (styleGuideResult) {
                      setStyleGuideDraftText(JSON.stringify(styleGuideResult.config, null, 2));
                    }
                  }}
                  disabled={!styleGuideResult || styleGuideLoading || styleGuideSaving}
                >
                  Revert
                </Button>
              </div>
            </div>
          </div>
        ) : activeTab === "memory" ? (
          <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col px-8 py-6">
            <div className="flex items-start justify-between gap-4 border-b border-border pb-5">
              <div className="min-w-0">
                <h1 className="text-xl font-semibold text-foreground">Memory</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  Runtime status for Tessera local memory capture and recall.
                </p>
              </div>
            </div>

            <div className="mt-6 space-y-4">
              <section className="rounded-xl border border-border bg-background px-4 py-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Database size={18} className="text-muted-foreground" />
                      <h2 className="text-sm font-semibold text-foreground">Local memory store</h2>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {memoryStatusDescription(memoryStatus, memoryLoading)}
                    </p>
                  </div>
                  <span
                    className={cn(
                      "rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide",
                      memoryStatusTone(memoryStatus, memoryLoading) === "success" &&
                        "bg-emerald-50 text-emerald-800",
                      memoryStatusTone(memoryStatus, memoryLoading) === "info" &&
                        "bg-secondary text-muted-foreground",
                      memoryStatusTone(memoryStatus, memoryLoading) === "error" &&
                        "bg-destructive/10 text-destructive"
                    )}
                  >
                    {memoryStatusLabel(memoryStatus, memoryLoading)}
                  </span>
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <div className="rounded-lg border border-border bg-secondary/30 px-3 py-2">
                    <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                      Mode
                    </div>
                    <div className="mt-1 text-sm font-medium text-foreground">
                      {memoryStatus ? memoryModeLabel(memoryStatus.mode) : "Checking"}
                    </div>
                  </div>
                  <div className="rounded-lg border border-border bg-secondary/30 px-3 py-2">
                    <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                      Database
                    </div>
                    <div className="mt-1 truncate text-sm font-medium text-foreground">
                      {memoryStatus?.dbPath ?? "Not available"}
                    </div>
                  </div>
                </div>

                {memoryStatus?.startupWarning && (
                  <div className="mt-4 flex gap-3 rounded-xl border border-destructive/25 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                    <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
                    <span>{memoryStatus.startupWarning.message}</span>
                  </div>
                )}

                {memoryStatusMessage && (
                  <div
                    className={cn(
                      "mt-4 rounded-xl border px-3 py-2 text-sm",
                      memoryStatusMessage.tone === "error" &&
                        "border-destructive/25 bg-destructive/5 text-destructive",
                      memoryStatusMessage.tone === "info" &&
                        "border-border bg-secondary text-foreground",
                      memoryStatusMessage.tone === "success" &&
                        "border-emerald-200 bg-emerald-50 text-emerald-800"
                    )}
                  >
                    {memoryStatusMessage.message}
                  </div>
                )}

                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleRefreshMemoryStatus}
                    disabled={memoryLoading || memoryReviewLoading}
                  >
                    {memoryLoading ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : (
                      <RefreshCw size={16} />
                    )}
                    Refresh
                  </Button>
                </div>
              </section>

              <section className="rounded-xl border border-border bg-background px-4 py-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h2 className="text-sm font-semibold text-foreground">Review queue</h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {memoryReview.candidates.length} candidate
                      {memoryReview.candidates.length === 1 ? "" : "s"} need review.
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={loadMemoryReview}
                    disabled={memoryReviewLoading}
                  >
                    {memoryReviewLoading ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <RefreshCw size={14} />
                    )}
                    Refresh
                  </Button>
                </div>

                {memoryReviewMessage && (
                  <div
                    className={cn(
                      "mt-4 rounded-xl border px-3 py-2 text-sm",
                      memoryReviewMessage.tone === "error" &&
                        "border-destructive/25 bg-destructive/5 text-destructive",
                      memoryReviewMessage.tone === "info" &&
                        "border-border bg-secondary text-foreground",
                      memoryReviewMessage.tone === "success" &&
                        "border-emerald-200 bg-emerald-50 text-emerald-800"
                    )}
                  >
                    {memoryReviewMessage.message}
                  </div>
                )}

                <div className="mt-4 space-y-3">
                  {memoryReviewLoading && memoryReview.candidates.length === 0 ? (
                    <div className="rounded-lg border border-border bg-secondary/30 px-3 py-3 text-sm text-muted-foreground">
                      Loading review queue.
                    </div>
                  ) : memoryReview.candidates.length === 0 ? (
                    <div className="rounded-lg border border-border bg-secondary/30 px-3 py-3 text-sm text-muted-foreground">
                      No candidate memories need review.
                    </div>
                  ) : (
                    memoryReview.candidates.map((candidate) => (
                      <article
                        key={candidate.id}
                        className="rounded-lg border border-border bg-secondary/20 px-3 py-3"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <h3 className="text-sm font-semibold text-foreground">
                              {candidate.title}
                            </h3>
                            <p className="mt-1 text-sm text-foreground">{candidate.body}</p>
                          </div>
                          <MemoryBadges memory={candidate} />
                        </div>
                        <p className="mt-2 text-xs text-muted-foreground">
                          {candidate.rationale.promotionReason}
                        </p>
                        {candidate.rationale.riskFlags.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1">
                            {candidate.rationale.riskFlags.map((flag) => (
                              <span
                                key={flag}
                                className="rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-destructive"
                              >
                                {memoryRiskLabel(flag)}
                              </span>
                            ))}
                          </div>
                        )}
                        <div className="mt-3 flex flex-wrap gap-2">
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => handleMemoryReviewDecision(candidate.id, "accept")}
                            disabled={activeMemoryAction !== null}
                          >
                            {activeMemoryAction === `${candidate.id}:accept` ? (
                              <Loader2 size={14} className="animate-spin" />
                            ) : (
                              <Check size={14} />
                            )}
                            Accept
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => handleMemoryReviewDecision(candidate.id, "reject")}
                            disabled={activeMemoryAction !== null}
                          >
                            {activeMemoryAction === `${candidate.id}:reject` ? (
                              <Loader2 size={14} className="animate-spin" />
                            ) : (
                              <XCircle size={14} />
                            )}
                            Reject
                          </Button>
                        </div>
                      </article>
                    ))
                  )}
                </div>
              </section>

              <section className="rounded-xl border border-border bg-background px-4 py-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h2 className="text-sm font-semibold text-foreground">Active memories</h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {memoryReview.active.length === 1
                        ? "1 active memory"
                        : `${memoryReview.active.length} active memories`}{" "}
                      available for recall.
                    </p>
                  </div>
                </div>

                <div className="mt-4 space-y-3">
                  {memoryReviewLoading && memoryReview.active.length === 0 ? (
                    <div className="rounded-lg border border-border bg-secondary/30 px-3 py-3 text-sm text-muted-foreground">
                      Loading active memories.
                    </div>
                  ) : memoryReview.active.length === 0 ? (
                    <div className="rounded-lg border border-border bg-secondary/30 px-3 py-3 text-sm text-muted-foreground">
                      No active memories are stored yet.
                    </div>
                  ) : (
                    memoryReview.active.map((memory) => (
                      <article
                        key={memory.id}
                        className="rounded-lg border border-border bg-secondary/20 px-3 py-3"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <h3 className="text-sm font-semibold text-foreground">
                              {memory.title}
                            </h3>
                            <p className="mt-1 text-sm text-foreground">{memory.body}</p>
                          </div>
                          <MemoryBadges memory={memory} />
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => handleMemoryReviewDecision(memory.id, "archive")}
                            disabled={activeMemoryAction !== null}
                          >
                            {activeMemoryAction === `${memory.id}:archive` ? (
                              <Loader2 size={14} className="animate-spin" />
                            ) : (
                              <Archive size={14} />
                            )}
                            Archive
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => handleMemoryForget(memory.id)}
                            disabled={activeMemoryAction !== null}
                          >
                            {activeMemoryAction === `${memory.id}:delete` ? (
                              <Loader2 size={14} className="animate-spin" />
                            ) : (
                              <Trash2 size={14} />
                            )}
                            Forget
                          </Button>
                        </div>
                      </article>
                    ))
                  )}
                </div>
              </section>
            </div>
          </div>
        ) : (
          <AgentSettingsView userKey={userKey} />
        )}
      </section>
    </main>
  );
}

function providerConfigFromSettings(
  settings: ModelSettingsRead["providers"][ModelProvider] | undefined
): AgentProviderConfig | undefined {
  if (!settings) return undefined;
  switch (settings.provider) {
    case "openai":
      return {
        provider: "openai",
        model: settings.model,
        apiKeyEnv: "OPENAI_API_KEY",
      };
    case "openai-codex":
      return {
        provider: "openai-codex",
        model: settings.model,
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
    case "google":
      return {
        provider: "google",
        model: settings.model,
        apiKeyEnv: "GOOGLE_AI_STUDIO_API_KEY",
      };
    case "local":
      return {
        provider: "local",
        model: settings.model,
        baseUrl: settings.baseUrl ?? "http://127.0.0.1:11434/v1",
      };
  }
}

function googleWorkspaceCapabilityStatusLabel(status: GoogleWorkspaceCapabilityStatus): string {
  if (status.installed) return "Connector ready";
  if (status.installAvailable) return "Download required";
  return "Manual install";
}

function googleWorkspaceCapabilityDescription(status: GoogleWorkspaceCapabilityStatus): string {
  if (status.installed) {
    return `Managed connector ${status.version} is installed.`;
  }
  if (status.installAvailable) {
    const size = formatCapabilityBytes(status.sizeBytes);
    return size
      ? `Download managed connector ${status.version} (${size}).`
      : `Download managed connector ${status.version}.`;
  }
  return status.message ?? "No managed connector is available for this system.";
}

function googleWorkspaceCapabilityProgressLabel(
  progress: GoogleWorkspaceCapabilityProgress
): string {
  switch (progress.phase) {
    case "downloading":
      return "Downloading connector";
    case "verifying":
      return "Verifying download";
    case "installing":
      return "Installing connector";
    case "installed":
      return "Connector ready";
    case "failed":
      return progress.message ?? "Installation failed";
    case "available":
      return "Download ready";
  }
}

function capabilityProgressPercent(progress?: GoogleWorkspaceCapabilityProgress): number | null {
  if (
    progress?.downloadedBytes === undefined ||
    progress.totalBytes === undefined ||
    progress.totalBytes <= 0
  ) {
    return null;
  }
  return Math.max(
    0,
    Math.min(100, Math.round((progress.downloadedBytes / progress.totalBytes) * 100))
  );
}

function formatCapabilityBytes(bytes?: number): string | null {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return null;
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const formatted = value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1);
  return `${formatted} ${units[unitIndex]}`;
}

function memoryModeLabel(mode: MemoryRuntimeStatus["mode"]): string {
  switch (mode) {
    case "active":
      return "Active";
    case "disabled":
      return "Disabled";
    case "fallback":
      return "Fallback";
  }
}

function memoryStatusLabel(status: MemoryRuntimeStatus | null, loading: boolean): string {
  if (loading) return "Checking";
  if (!status) return "Unavailable";
  return memoryModeLabel(status.mode);
}

function memoryStatusTone(status: MemoryRuntimeStatus | null, loading: boolean): StatusTone {
  if (loading || !status || status.mode === "disabled") return "info";
  return status.mode === "active" ? "success" : "error";
}

function memoryStatusDescription(status: MemoryRuntimeStatus | null, loading: boolean): string {
  if (loading) return "Checking memory runtime status.";
  if (!status) return "Memory status is not available from the sidecar.";
  switch (status.mode) {
    case "active":
      return "Memory capture and recall are available for local tasks.";
    case "disabled":
      return "Memory is explicitly disabled for this runtime.";
    case "fallback":
      return "Memory is unavailable, so Tessera is using the no-op fallback.";
  }
}

function memoryTypeLabel(type: Memory["type"]): string {
  switch (type) {
    case "fact":
      return "Fact";
    case "preference":
      return "Preference";
    case "procedure":
      return "Procedure";
    case "lesson":
      return "Lesson";
    case "warning":
      return "Warning";
  }
}

function memoryScopeLabel(scope: Memory["scope"]): string {
  switch (scope) {
    case "task":
      return "Task";
    case "playbook":
      return "Playbook";
    case "user":
      return "User";
    case "workspace":
      return "Workspace";
    case "system":
      return "System";
  }
}

function memoryRiskLabel(flag: MemoryCandidate["rationale"]["riskFlags"][number]): string {
  switch (flag) {
    case "personal":
      return "Personal";
    case "secret_suspect":
      return "Secret suspect";
    case "stale":
      return "Conflict";
    case "low_confidence":
      return "Low confidence";
  }
}

function MemoryBadges({ memory }: { memory: Memory }) {
  return (
    <div className="flex flex-wrap justify-end gap-1">
      <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {memoryTypeLabel(memory.type)}
      </span>
      <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {memoryScopeLabel(memory.scope)}
      </span>
      <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {Math.round(memory.confidence * 100)}%
      </span>
    </div>
  );
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
