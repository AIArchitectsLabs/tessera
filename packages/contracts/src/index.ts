import { z } from "zod";

// IPC envelope — all messages between frontend and sidecar use this shape.
export const IpcEnvelopeSchema = z.object({
  id: z.string(),
  type: z.string(),
  payload: z.unknown(),
});

export type IpcEnvelope = z.infer<typeof IpcEnvelopeSchema>;

// Sidecar reports its connection info to the Rust shell on stdout at boot.
export const SidecarReadySchema = z.discriminatedUnion("transport", [
  z.object({
    type: z.literal("ready"),
    transport: z.literal("unix"),
    path: z.string(),
    token: z.string(),
  }),
  z.object({
    type: z.literal("ready"),
    transport: z.literal("tcp"),
    port: z.number(),
    token: z.string(),
  }),
]);

export type SidecarReady = z.infer<typeof SidecarReadySchema>;

// Spawn a registered CLI binary via the sidecar.
export const SpawnRequestSchema = z.object({
  binary: z.enum(["workspace-cli"]),
  args: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().max(60_000).default(10_000),
});

export type SpawnRequest = z.infer<typeof SpawnRequestSchema>;

export const SpawnResultSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int(),
  signal: z.string().nullable(),
  durationMs: z.number().nonnegative(),
});

export type SpawnResult = z.infer<typeof SpawnResultSchema>;

export const AgentProviderConfigSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("openai"),
    model: z.string().min(1),
    apiKeyEnv: z.string().min(1).default("OPENAI_API_KEY"),
  }),
  z.object({
    provider: z.literal("anthropic"),
    model: z.string().min(1),
    apiKeyEnv: z.string().min(1).default("ANTHROPIC_API_KEY"),
  }),
  z.object({
    provider: z.literal("openrouter"),
    model: z.string().min(1),
    apiKeyEnv: z.string().min(1).default("OPENROUTER_API_KEY"),
  }),
  z.object({
    provider: z.literal("local"),
    model: z.string().min(1),
    baseUrl: z.string().url(),
    apiKeyEnv: z.string().min(1).optional(),
  }),
]);

export type AgentProviderConfig = z.infer<typeof AgentProviderConfigSchema>;

export const ModelProviderSchema = z.enum(["openai", "anthropic", "openrouter", "local"]);
export type ModelProvider = z.infer<typeof ModelProviderSchema>;

const OpenAIModelProviderSettingsSchema = z.object({
  provider: z.literal("openai"),
  model: z.string().min(1),
  hasCredential: z.boolean().default(false),
});

const AnthropicModelProviderSettingsSchema = z.object({
  provider: z.literal("anthropic"),
  model: z.string().min(1),
  hasCredential: z.boolean().default(false),
});

const OpenRouterModelProviderSettingsSchema = z.object({
  provider: z.literal("openrouter"),
  model: z.string().min(1),
  hasCredential: z.boolean().default(false),
});

const LocalModelProviderSettingsSchema = z.object({
  provider: z.literal("local"),
  model: z.string().min(1),
  baseUrl: z.string().url(),
  hasCredential: z.boolean().default(false),
});

export const ModelProviderSettingsSchema = z.discriminatedUnion("provider", [
  OpenAIModelProviderSettingsSchema,
  AnthropicModelProviderSettingsSchema,
  OpenRouterModelProviderSettingsSchema,
  LocalModelProviderSettingsSchema,
]);
export type ModelProviderSettings = z.infer<typeof ModelProviderSettingsSchema>;

export const ModelSettingsReadSchema = z.object({
  selectedProvider: ModelProviderSchema,
  providers: z.object({
    openai: OpenAIModelProviderSettingsSchema,
    anthropic: AnthropicModelProviderSettingsSchema,
    openrouter: OpenRouterModelProviderSettingsSchema,
    local: LocalModelProviderSettingsSchema,
  }),
});
export type ModelSettingsRead = z.infer<typeof ModelSettingsReadSchema>;

export const ModelSettingsSaveRequestSchema = z
  .object({
    selectedProvider: ModelProviderSchema,
    provider: AgentProviderConfigSchema,
    hasExistingCredential: z.boolean().default(false),
    credential: z
      .object({
        apiKey: z.string().min(1),
      })
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.selectedProvider !== value.provider.provider) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "selectedProvider must match provider.provider",
        path: ["provider"],
      });
    }
  });
export type ModelSettingsSaveRequest = z.infer<typeof ModelSettingsSaveRequestSchema>;

export const ModelCredentialDeleteRequestSchema = z.object({
  provider: ModelProviderSchema,
});
export type ModelCredentialDeleteRequest = z.infer<typeof ModelCredentialDeleteRequestSchema>;

export const ModelConnectionTestRequestSchema = z.object({
  provider: AgentProviderConfigSchema,
  credential: z
    .object({
      apiKey: z.string().min(1),
    })
    .optional(),
});
export type ModelConnectionTestRequest = z.infer<typeof ModelConnectionTestRequestSchema>;

export const ModelConnectionTestResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
});
export type ModelConnectionTestResult = z.infer<typeof ModelConnectionTestResultSchema>;

export const GoogleWorkspaceProviderSchema = z.literal("google-workspace");

export const IntegrationProviderSchema = z.enum(["brave-search", "google-workspace"]);
export type IntegrationProvider = z.infer<typeof IntegrationProviderSchema>;

const BraveSearchIntegrationSettingsSchema = z.object({
  provider: z.literal("brave-search"),
  hasCredential: z.boolean().default(false),
});

const GoogleWorkspaceIntegrationSettingsSchema = z.object({
  provider: GoogleWorkspaceProviderSchema,
  hasCredential: z.boolean().default(false),
});

export const SearchProviderSchema = z.enum(["brave-search", "tavily", "duckduckgo"]);
export type SearchProvider = z.infer<typeof SearchProviderSchema>;

export const SearchCapabilitySchema = z.enum(["search"]);
export type SearchCapability = z.infer<typeof SearchCapabilitySchema>;

export const SearchModeSchema = z.union([z.literal("auto"), SearchProviderSchema]);
export type SearchMode = z.infer<typeof SearchModeSchema>;

export const SearchSettingsSchema = z.object({
  mode: SearchModeSchema,
  allowKeylessFallback: z.boolean(),
});
export type SearchSettings = z.infer<typeof SearchSettingsSchema>;

const BraveSearchProviderSettingsSchema = z.object({
  provider: z.literal("brave-search"),
  hasCredential: z.boolean().default(false),
});

const TavilyProviderSettingsSchema = z.object({
  provider: z.literal("tavily"),
  hasCredential: z.boolean().default(false),
});

const DuckDuckGoProviderSettingsSchema = z.object({
  provider: z.literal("duckduckgo"),
  hasCredential: z.boolean().default(false),
});

export const IntegrationSettingsReadSchema = z.object({
  providers: z.object({
    braveSearch: BraveSearchIntegrationSettingsSchema,
    googleWorkspace: GoogleWorkspaceIntegrationSettingsSchema,
  }),
  search: z
    .object({
      mode: SearchModeSchema,
      allowKeylessFallback: z.boolean(),
      providers: z.object({
        braveSearch: BraveSearchProviderSettingsSchema,
        tavily: TavilyProviderSettingsSchema,
        duckduckgo: DuckDuckGoProviderSettingsSchema,
      }),
    })
    .default({
      mode: "auto",
      allowKeylessFallback: false,
      providers: {
        braveSearch: {
          provider: "brave-search",
          hasCredential: false,
        },
        tavily: {
          provider: "tavily",
          hasCredential: false,
        },
        duckduckgo: {
          provider: "duckduckgo",
          hasCredential: false,
        },
      },
    }),
});
export type IntegrationSettingsRead = z.infer<typeof IntegrationSettingsReadSchema>;

const IntegrationSettingsSaveProviderRequestSchema = z
  .object({
    provider: IntegrationProviderSchema,
    hasExistingCredential: z.boolean().default(false),
    credential: z
      .object({
        apiKey: z.string().min(1),
      })
      .optional(),
    search: SearchSettingsSchema.optional(),
  })
  .strict();

const IntegrationSettingsSaveSearchProviderRequestSchema = z
  .object({
    searchProvider: SearchProviderSchema,
    hasExistingCredential: z.boolean().default(false),
    credential: z
      .object({
        apiKey: z.string().min(1),
      })
      .optional(),
    search: SearchSettingsSchema.optional(),
  })
  .strict();

export const IntegrationSettingsSaveRequestSchema = z.union([
  IntegrationSettingsSaveProviderRequestSchema,
  IntegrationSettingsSaveSearchProviderRequestSchema,
]);
export type IntegrationSettingsSaveRequest = z.infer<typeof IntegrationSettingsSaveRequestSchema>;

export const IntegrationCredentialDeleteRequestSchema = z.union([
  z
    .object({
      provider: IntegrationProviderSchema,
    })
    .strict(),
  z
    .object({
      searchProvider: SearchProviderSchema,
    })
    .strict(),
]);
export type IntegrationCredentialDeleteRequest = z.infer<
  typeof IntegrationCredentialDeleteRequestSchema
>;

export const IntegrationConnectionTestRequestSchema = z.union([
  z
    .object({
      provider: IntegrationProviderSchema,
      credential: z
        .object({
          apiKey: z.string().min(1),
        })
        .optional(),
    })
    .strict(),
  z
    .object({
      searchProvider: SearchProviderSchema,
      credential: z
        .object({
          apiKey: z.string().min(1),
        })
        .optional(),
    })
    .strict(),
]);
export type IntegrationConnectionTestRequest = z.infer<
  typeof IntegrationConnectionTestRequestSchema
>;

export const IntegrationConnectionTestResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  provider: IntegrationProviderSchema.optional(),
  searchProvider: SearchProviderSchema.optional(),
});
export type IntegrationConnectionTestResult = z.infer<typeof IntegrationConnectionTestResultSchema>;

export const GcalEventSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  start: z.string().min(1),
  end: z.string().optional(),
  isAllDay: z.boolean(),
  organizerEmail: z.string().optional(),
  htmlLink: z.string().optional(),
});

export const GcalListResultSchema = z.object({
  calendarId: z.string().min(1),
  events: z.array(GcalEventSchema),
});
export type GcalListResult = z.infer<typeof GcalListResultSchema>;

export const GcalReadResultSchema = z.object({
  calendarId: z.string().min(1),
  event: GcalEventSchema.extend({
    attendees: z
      .array(
        z.object({
          email: z.string().min(1),
          displayName: z.string().optional(),
          responseStatus: z.string().optional(),
        })
      )
      .optional(),
  }),
});
export type GcalReadResult = z.infer<typeof GcalReadResultSchema>;

export const MailMessageSummarySchema = z.object({
  id: z.string().min(1),
  threadId: z.string().optional(),
  subject: z.string().default("(no subject)"),
  from: z.string().optional(),
  date: z.string().optional(),
  snippet: z.string().optional(),
  labels: z.array(z.string()).default([]),
});
export type MailMessageSummary = z.infer<typeof MailMessageSummarySchema>;

export const MailListResultSchema = z.object({
  messages: z.array(MailMessageSummarySchema),
});
export type MailListResult = z.infer<typeof MailListResultSchema>;

export const MailReadResultSchema = z.object({
  message: MailMessageSummarySchema.extend({
    to: z.array(z.string()).default([]),
    cc: z.array(z.string()).default([]),
    text: z.string().default(""),
    html: z.string().optional(),
  }),
});
export type MailReadResult = z.infer<typeof MailReadResultSchema>;

export const DriveFileSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  mimeType: z.string().min(1),
  modifiedTime: z.string().optional(),
  webViewLink: z.string().url().optional(),
});
export type DriveFileSummary = z.infer<typeof DriveFileSummarySchema>;

export const DriveSearchResultSchema = z.object({
  files: z.array(DriveFileSummarySchema),
});
export type DriveSearchResult = z.infer<typeof DriveSearchResultSchema>;

export const DriveReadResultSchema = z
  .object({
    file: DriveFileSummarySchema.extend({
      text: z.string().optional(),
      rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).optional(),
    }),
  })
  .superRefine((value, ctx) => {
    if (value.file.text === undefined && value.file.rows === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Drive read result must include readable content in file.text or file.rows",
        path: ["file"],
      });
    }
  });
export type DriveReadResult = z.infer<typeof DriveReadResultSchema>;

export const ContactSummarySchema = z.object({
  resourceName: z.string().min(1),
  displayName: z.string().min(1),
  emailAddresses: z.array(z.string()).default([]),
  phoneNumbers: z.array(z.string()).default([]),
  organizations: z.array(z.string()).default([]),
});
export type ContactSummary = z.infer<typeof ContactSummarySchema>;

export const ContactsLookupResultSchema = z.object({
  contacts: z.array(ContactSummarySchema),
});
export type ContactsLookupResult = z.infer<typeof ContactsLookupResultSchema>;

export const ToolCapabilitySchema = z.enum(["read", "write"]);
export type ToolCapability = z.infer<typeof ToolCapabilitySchema>;

export const ToolRiskSchema = z.object({
  mutates: z.boolean(),
  destructive: z.boolean(),
  external: z.boolean(),
  reversible: z.boolean(),
  dryRunSupported: z.boolean(),
});

export type ToolRisk = z.infer<typeof ToolRiskSchema>;

export const PermissionGrantSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("tool"),
    toolId: z.string().min(1),
  }),
  z.object({
    type: z.literal("exact"),
    toolId: z.string().min(1),
    args: z.record(z.unknown()),
  }),
]);

export type PermissionGrant = z.infer<typeof PermissionGrantSchema>;

export const PermissionDecisionSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("allow"),
    toolId: z.string(),
    reason: z.string(),
  }),
  z.object({
    decision: z.literal("ask"),
    toolId: z.string(),
    reason: z.string(),
    approval: z.object({
      toolId: z.string(),
      args: z.record(z.unknown()),
      capability: ToolCapabilitySchema,
      risk: ToolRiskSchema,
      preview: z.string(),
      reasonCode: z.string(),
    }),
  }),
  z.object({
    decision: z.literal("deny"),
    toolId: z.string(),
    reason: z.string(),
  }),
]);

export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

export const AgentTurnRequestSchema = z.object({
  prompt: z.string().min(1),
  provider: AgentProviderConfigSchema,
  credential: z
    .object({
      apiKey: z.string().min(1),
    })
    .optional(),
  grants: z.array(PermissionGrantSchema).default([]),
  timeoutMs: z.number().int().positive().max(120_000).default(60_000),
});

export type AgentTurnRequest = z.infer<typeof AgentTurnRequestSchema>;

export const AgentMessageSummarySchema = z.object({
  role: z.string(),
  text: z.string().optional(),
});

export type AgentMessageSummary = z.infer<typeof AgentMessageSummarySchema>;

export const AgentToolResultSummarySchema = z.object({
  toolId: z.string(),
  status: z.enum(["success", "error", "blocked"]),
  text: z.string(),
  details: z.unknown().optional(),
});

export type AgentToolResultSummary = z.infer<typeof AgentToolResultSummarySchema>;

export const AgentTurnResultSchema = z.object({
  status: z.enum(["completed", "blocked", "denied", "error"]),
  messages: z.array(AgentMessageSummarySchema),
  toolResults: z.array(AgentToolResultSummarySchema),
  permissionDecisions: z.array(PermissionDecisionSchema),
  error: z.string().optional(),
});

export type AgentTurnResult = z.infer<typeof AgentTurnResultSchema>;

export const ShellCommandNameSchema = z.enum([
  "web-search",
  "web-fetch",
  "gcal",
  "mail",
  "drive",
  "contacts",
]);
export type ShellCommandName = z.infer<typeof ShellCommandNameSchema>;

export const ShellToolCallSchema = z.object({
  command: ShellCommandNameSchema,
  subcommand: z.string().min(1),
  args: z.array(z.string()).default([]),
});
export type ShellToolCall = z.infer<typeof ShellToolCallSchema>;

export const WebSearchResultSchema = z.object({
  query: z.string().min(1),
  provider: SearchProviderSchema,
  capability: SearchCapabilitySchema,
  cached: z.boolean(),
  latencyMs: z.number().nonnegative(),
  results: z.array(
    z.object({
      title: z.string().min(1),
      url: z.string().url(),
      snippet: z.string().optional(),
      source: z.string().optional(),
      position: z.number().int().positive(),
    })
  ),
});
export type WebSearchResult = z.infer<typeof WebSearchResultSchema>;

export const BraveSearchResultSchema = z.object({
  query: z.string().min(1),
  results: z.array(
    z.object({
      title: z.string().min(1),
      url: z.string().url(),
      snippet: z.string().optional(),
      source: z.string().optional(),
    })
  ),
});
export type BraveSearchResult = z.infer<typeof BraveSearchResultSchema>;

export const WebFetchResultSchema = z.object({
  url: z.string().url(),
  title: z.string().optional(),
  markdown: z.string().min(1),
  author: z.string().optional(),
  publishedAt: z.string().optional(),
  diagnostics: z.object({
    status: z.number().int(),
    contentType: z.string().optional(),
  }),
});
export type WebFetchResult = z.infer<typeof WebFetchResultSchema>;

export const ShellToolResultSchema = z.object({
  command: ShellCommandNameSchema,
  subcommand: z.string().min(1),
  stdout: z.string().default(""),
  stderr: z.string().default(""),
  exitCode: z.number().int(),
  durationMs: z.number().int().nonnegative(),
  parsed: z.unknown().optional(),
});
export type ShellToolResult = z.infer<typeof ShellToolResultSchema>;

export const BrowserActionSchema = z.enum([
  "open",
  "snap",
  "see",
  "click",
  "type",
  "select",
  "back",
  "reload",
  "eval",
  "close",
]);
export type BrowserAction = z.infer<typeof BrowserActionSchema>;

export const BrowserActionInputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("open"),
    pageId: z.string().min(1).optional(),
    url: z.string().min(1),
  }),
  z.object({
    action: z.literal("snap"),
    pageId: z.string().min(1).optional(),
    fullPage: z.boolean().default(false),
  }),
  z.object({
    action: z.literal("see"),
    pageId: z.string().min(1).optional(),
    query: z.string().min(1).optional(),
  }),
  z.object({
    action: z.literal("click"),
    pageId: z.string().min(1).optional(),
    selector: z.string().min(1),
  }),
  z.object({
    action: z.literal("type"),
    pageId: z.string().min(1).optional(),
    selector: z.string().min(1),
    text: z.string(),
    submit: z.boolean().default(false),
  }),
  z.object({
    action: z.literal("select"),
    pageId: z.string().min(1).optional(),
    selector: z.string().min(1),
    value: z.string().min(1),
  }),
  z.object({
    action: z.literal("back"),
    pageId: z.string().min(1).optional(),
  }),
  z.object({
    action: z.literal("reload"),
    pageId: z.string().min(1).optional(),
  }),
  z.object({
    action: z.literal("eval"),
    pageId: z.string().min(1).optional(),
    expression: z.string().min(1),
  }),
  z.object({
    action: z.literal("close"),
    pageId: z.string().min(1).optional(),
  }),
]);
export type BrowserActionInput = z.infer<typeof BrowserActionInputSchema>;

export const BrowserToolResultSchema = z.object({
  action: BrowserActionSchema,
  summary: z.string().optional(),
  sessionId: z.string().min(1).optional(),
  pageId: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
  content: z.string().optional(),
  screenshotPath: z.string().min(1).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type BrowserToolResult = z.infer<typeof BrowserToolResultSchema>;

export const BrowserRecipeStatusSchema = z.enum([
  "draft",
  "reviewed",
  "approved_for_action",
  "stale",
]);
export type BrowserRecipeStatus = z.infer<typeof BrowserRecipeStatusSchema>;

export const BrowserRecipePermissionSchema = z.enum([
  "browser.read",
  "browser.action",
  "browser.eval",
]);
export type BrowserRecipePermission = z.infer<typeof BrowserRecipePermissionSchema>;

export const BrowserRecipeStepSchema = z.object({
  action: BrowserActionSchema,
  url: z.string().url().optional(),
  selector: z.string().min(1).optional(),
  text: z.string().optional(),
  expectedState: z.string().min(1).optional(),
  fallbackLabel: z.string().min(1).optional(),
});
export type BrowserRecipeStep = z.infer<typeof BrowserRecipeStepSchema>;

export const BrowserRecipeProposalSchema = z.object({
  id: z.string().min(1),
  status: BrowserRecipeStatusSchema,
  domain: z.string().min(1),
  goal: z.string().min(1),
  source: z.object({
    taskId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
  }),
  permissions: z.array(BrowserRecipePermissionSchema),
  steps: z.array(BrowserRecipeStepSchema).min(1),
  artifacts: z
    .array(
      z.object({
        title: z.string().min(1),
        path: z.string().min(1),
      })
    )
    .default([]),
  createdAt: z.string().datetime(),
  lastVerifiedAt: z.string().datetime().optional(),
});
export type BrowserRecipeProposal = z.infer<typeof BrowserRecipeProposalSchema>;

export const ClarifyOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
});
export type ClarifyOption = z.infer<typeof ClarifyOptionSchema>;

export const ClarifyRequestSchema = z.object({
  promptId: z.string().min(1),
  taskId: z.string().min(1),
  message: z.string().min(1),
  detail: z.string().optional(),
  allowFreeform: z.boolean().default(true),
  options: z.array(ClarifyOptionSchema).default([]),
  createdAt: z.string().datetime(),
});
export type ClarifyRequest = z.infer<typeof ClarifyRequestSchema>;

export const ClarifyResponseSchema = z.object({
  promptId: z.string().min(1),
  selectedOptionId: z.string().min(1).optional(),
  freeform: z.string().optional(),
  cancelled: z.boolean(),
});
export type ClarifyResponse = z.infer<typeof ClarifyResponseSchema>;

export const NotifyRequestSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  actionLabel: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
});
export type NotifyRequest = z.infer<typeof NotifyRequestSchema>;

export const AuditRecordSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1).optional(),
  toolId: z.string().min(1),
  action: z.string().min(1),
  summary: z.string().min(1),
  status: z.enum(["requested", "approved", "denied", "completed", "failed"]),
  createdAt: z.string().datetime(),
  metadata: z.record(z.unknown()).optional(),
});
export type AuditRecord = z.infer<typeof AuditRecordSchema>;

export const WorkflowCapabilitySchema = z.enum(["web", "calendar", "mail", "drive", "contacts"]);
export type WorkflowCapability = z.infer<typeof WorkflowCapabilitySchema>;

export const CapabilityKindSchema = z.enum(["model", "skill", "tool", "integration"]);
export type CapabilityKind = z.infer<typeof CapabilityKindSchema>;

export const WorkflowDataPolicySchema = z.enum(["cloud-ok", "workspace-local-ok", "local-only"]);
export type WorkflowDataPolicy = z.infer<typeof WorkflowDataPolicySchema>;

export const CanonicalCapabilitySchema = z
  .object({
    id: z.string().min(1),
    kind: CapabilityKindSchema,
    label: z.string().min(1),
    description: z.string().min(1),
    version: z.number().int().positive().default(1),
    aliases: z.array(z.string().min(1)).default([]),
    deprecated: z.boolean().default(false),
  })
  .strict();
export type CanonicalCapability = z.infer<typeof CanonicalCapabilitySchema>;

export const CANONICAL_CAPABILITIES = [
  {
    id: "model.reasoning",
    kind: "model",
    label: "Reasoning",
    description: "Can reason across multi-step business context.",
    version: 1,
    aliases: ["reasoning"],
    deprecated: false,
  },
  {
    id: "model.summarization",
    kind: "model",
    label: "Summarization",
    description: "Can summarize long source material.",
    version: 1,
    aliases: ["summarization"],
    deprecated: false,
  },
  {
    id: "skill.meeting-prep",
    kind: "skill",
    label: "Meeting prep",
    description: "Can prepare customer or prospect meeting material.",
    version: 1,
    aliases: ["meeting-prep"],
    deprecated: false,
  },
  {
    id: "skill.account-research",
    kind: "skill",
    label: "Account research",
    description: "Can research account context.",
    version: 1,
    aliases: ["account-research"],
    deprecated: false,
  },
  {
    id: "tool.workspace.read",
    kind: "tool",
    label: "Read workspace",
    description: "Can inspect workspace files.",
    version: 1,
    aliases: ["workspace.read"],
    deprecated: false,
  },
  {
    id: "tool.workspace.write",
    kind: "tool",
    label: "Write workspace",
    description: "Can create or update workspace files.",
    version: 1,
    aliases: ["workspace.write"],
    deprecated: false,
  },
  {
    id: "integration.calendar.events.read",
    kind: "integration",
    label: "Calendar events",
    description: "Can read calendar events.",
    version: 1,
    aliases: ["calendar.events.read"],
    deprecated: false,
  },
  {
    id: "integration.crm.accounts.read",
    kind: "integration",
    label: "CRM accounts",
    description: "Can read account records.",
    version: 1,
    aliases: ["crm.accounts.read"],
    deprecated: false,
  },
] as const satisfies readonly CanonicalCapability[];

export function canonicalCapability(idOrAlias: string): CanonicalCapability | undefined {
  return CANONICAL_CAPABILITIES.find(
    (capability) =>
      capability.id === idOrAlias || (capability.aliases as readonly string[]).includes(idOrAlias)
  );
}

export function assertKnownCapability(id: string, kind: CapabilityKind, optional: boolean): string {
  const capability = canonicalCapability(id);
  if (!capability) {
    if (optional) return id;
    throw new Error(`Unknown ${kind} capability: ${id}`);
  }

  if (capability.kind !== kind) {
    throw new Error(`Capability ${id} must be registered as a ${kind} capability`);
  }

  return capability.id;
}

export const WorkflowCapabilityRequirementSchema = z
  .object({
    capability: z.string().min(1),
    optional: z.boolean().default(false),
  })
  .strict();
export type WorkflowCapabilityRequirement = z.infer<typeof WorkflowCapabilityRequirementSchema>;

export const WorkflowModelRequirementSchema = z
  .object({
    acceptableProviders: z.array(ModelProviderSchema).default([]),
    acceptableModels: z.array(z.string().min(1)).default([]),
    acceptableModelClasses: z.array(z.string().min(1)).default([]),
    acceptablePortableModelIds: z.array(z.string().min(1)).default([]),
    acceptableCapabilities: z.array(z.string().min(1)).default([]),
    capabilities: z.array(z.string().min(1)).default([]),
    minContextTokens: z.number().int().positive().optional(),
    dataPolicy: WorkflowDataPolicySchema.default("cloud-ok"),
  })
  .strict();
export type WorkflowModelRequirement = z.infer<typeof WorkflowModelRequirementSchema>;

export const WorkflowNodeRequirementsSchema = z
  .object({
    model: WorkflowModelRequirementSchema.optional(),
    skills: z.array(WorkflowCapabilityRequirementSchema).default([]),
    tools: z.array(WorkflowCapabilityRequirementSchema).default([]),
    integrations: z.array(WorkflowCapabilityRequirementSchema).default([]),
  })
  .strict()
  .superRefine((requires, ctx) => {
    for (const [index, capability] of requires.model?.capabilities.entries() ?? []) {
      const known = canonicalCapability(capability);
      if (!known) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown model capability: ${capability}`,
          path: ["model", "capabilities", index],
        });
        continue;
      }

      if (known.kind !== "model") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Capability ${capability} must be a model capability`,
          path: ["model", "capabilities", index],
        });
      }
    }

    for (const [index, capability] of requires.skills.entries()) {
      const known = canonicalCapability(capability.capability);
      if (!known) {
        if (!capability.optional) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Unknown skill capability: ${capability.capability}`,
            path: ["skills", index, "capability"],
          });
        }
        continue;
      }

      if (known.kind !== "skill") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Capability ${capability.capability} must be a skill capability`,
          path: ["skills", index, "capability"],
        });
      }
    }

    for (const [index, capability] of requires.tools.entries()) {
      const known = canonicalCapability(capability.capability);
      if (!known) {
        if (!capability.optional) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Unknown tool capability: ${capability.capability}`,
            path: ["tools", index, "capability"],
          });
        }
        continue;
      }

      if (known.kind !== "tool") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Capability ${capability.capability} must be a tool capability`,
          path: ["tools", index, "capability"],
        });
      }
    }

    for (const [index, capability] of requires.integrations.entries()) {
      const known = canonicalCapability(capability.capability);
      if (!known) {
        if (!capability.optional) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Unknown integration capability: ${capability.capability}`,
            path: ["integrations", index, "capability"],
          });
        }
        continue;
      }

      if (known.kind !== "integration") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Capability ${capability.capability} must be an integration capability`,
          path: ["integrations", index, "capability"],
        });
      }
    }
  });
export type WorkflowNodeRequirements = z.infer<typeof WorkflowNodeRequirementsSchema>;

export const WorkflowSourceGapSchema = z
  .object({
    stepId: z.string().min(1),
    kind: CapabilityKindSchema,
    capability: z.string().min(1),
    optional: z.boolean().default(true),
    reason: z.string().min(1).optional(),
  })
  .strict();
export type WorkflowSourceGap = z.infer<typeof WorkflowSourceGapSchema>;

export const WorkflowNodeAssignmentSchema = z
  .object({
    stepId: z.string().min(1),
    agentId: z.string().min(1).optional(),
    agentLabel: z.string().min(1).optional(),
    agentFingerprint: z.string().min(1).optional(),
    provider: AgentProviderConfigSchema.optional(),
    providerFingerprint: z.string().min(1).optional(),
    credentialRef: z.string().min(1).optional(),
    skillCapabilities: z.array(z.string().min(1)).default([]),
    toolCapabilities: z.array(z.string().min(1)).default([]),
    integrationCapabilities: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type WorkflowNodeAssignment = z.infer<typeof WorkflowNodeAssignmentSchema>;

export const WorkflowRunAssignmentPlanSchema = z
  .object({
    resolverVersion: z.number().int().positive().default(1),
    createdAt: z.string().datetime(),
    assignments: z.record(WorkflowNodeAssignmentSchema).default({}),
  })
  .strict();
export type WorkflowRunAssignmentPlan = z.infer<typeof WorkflowRunAssignmentPlanSchema>;

export const PlaybookAssignmentCandidateSchema = z
  .object({
    agentId: z.string().min(1),
    agentLabel: z.string().min(1),
    assignment: WorkflowNodeAssignmentSchema,
    recommended: z.boolean().default(false),
    disabled: z.boolean().default(false),
    reason: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((candidate, ctx) => {
    if (candidate.assignment.agentId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Playbook assignment candidates require assignment.agentId",
        path: ["assignment", "agentId"],
      });
    } else if (candidate.agentId !== candidate.assignment.agentId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Playbook assignment candidate agentId must match assignment.agentId",
        path: ["agentId"],
      });
    }

    if (candidate.assignment.agentLabel === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Playbook assignment candidates require assignment.agentLabel",
        path: ["assignment", "agentLabel"],
      });
    } else if (candidate.agentLabel !== candidate.assignment.agentLabel) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Playbook assignment candidate agentLabel must match assignment.agentLabel",
        path: ["agentLabel"],
      });
    }
  });
export type PlaybookAssignmentCandidate = z.infer<typeof PlaybookAssignmentCandidateSchema>;

export const PlaybookAssignmentNodePreviewSchema = z
  .object({
    stepId: z.string().min(1),
    stepLabel: z.string().min(1),
    kind: z.enum(["agent", "tool"]),
    recommendedAgentId: z.string().min(1).optional(),
    recommendedAgentLabel: z.string().min(1).optional(),
    candidates: z.array(PlaybookAssignmentCandidateSchema).default([]),
    blocker: WorkflowSourceGapSchema.optional(),
  })
  .strict();
export type PlaybookAssignmentNodePreview = z.infer<typeof PlaybookAssignmentNodePreviewSchema>;

export const PlaybookAssignmentPreviewResultSchema = z
  .object({
    assignmentPlan: WorkflowRunAssignmentPlanSchema.optional(),
    confirmationRequired: z.boolean(),
    blockers: z.array(WorkflowSourceGapSchema).default([]),
    sourceGaps: z.array(WorkflowSourceGapSchema).default([]),
    nodePreviews: z.array(PlaybookAssignmentNodePreviewSchema).default([]),
  })
  .strict();
export type PlaybookAssignmentPreviewResult = z.infer<typeof PlaybookAssignmentPreviewResultSchema>;

export const PlaybookRunPreferenceSchema = z
  .object({
    workspaceRoot: z.string().min(1),
    playbookId: z.string().min(1),
    assignmentPlan: WorkflowRunAssignmentPlanSchema,
    updatedAt: z.string().datetime(),
  })
  .strict();
export type PlaybookRunPreference = z.infer<typeof PlaybookRunPreferenceSchema>;

export const PlaybookRunPreferenceReadRequestSchema = z
  .object({
    workspaceRoot: z.string().min(1),
  })
  .strict();
export type PlaybookRunPreferenceReadRequest = z.infer<
  typeof PlaybookRunPreferenceReadRequestSchema
>;

export const PlaybookRunPreferenceReadResultSchema = z
  .object({
    preference: PlaybookRunPreferenceSchema.optional(),
  })
  .strict();
export type PlaybookRunPreferenceReadResult = z.infer<typeof PlaybookRunPreferenceReadResultSchema>;

export const WorkflowCapabilityInventorySchema = z
  .object({
    fingerprint: z.string().min(1).optional(),
    agents: z
      .array(
        z
          .object({
            id: z.string().min(1),
            label: z.string().min(1),
            fingerprint: z.string().min(1),
            model: ModelProviderSettingsSchema.optional(),
            modelCapabilities: z.array(z.string().min(1)).default([]),
            contextTokens: z.number().int().positive().optional(),
            dataPolicies: z.array(WorkflowDataPolicySchema).default([]),
            skillCapabilities: z.array(z.string().min(1)).default([]),
            toolCapabilities: z.array(z.string().min(1)).default([]),
          })
          .strict()
      )
      .default([]),
    models: z
      .array(
        z
          .object({
            provider: ModelProviderSchema,
            model: z.string().min(1),
            label: z.string().min(1).optional(),
            hasCredential: z.boolean().default(false),
            capabilities: z.array(z.string().min(1)).default([]),
            dataPolicy: WorkflowDataPolicySchema.optional(),
          })
          .strict()
      )
      .default([]),
    skills: z
      .array(
        z
          .object({
            id: z.string().min(1),
            label: z.string().min(1).optional(),
          })
          .strict()
      )
      .default([]),
    tools: z
      .array(
        z
          .object({
            id: z.string().min(1),
            label: z.string().min(1).optional(),
          })
          .strict()
      )
      .default([]),
    integrations: z
      .array(
        z
          .object({
            id: z.string().min(1),
            label: z.string().min(1),
            fingerprint: z.string().min(1),
            capabilities: z.array(z.string().min(1)).default([]),
            dataPolicies: z.array(WorkflowDataPolicySchema).default([]),
            configured: z.boolean(),
          })
          .strict()
      )
      .default([]),
  })
  .strict();
export type WorkflowCapabilityInventory = z.infer<typeof WorkflowCapabilityInventorySchema>;

export const PlaybookAssignmentPreviewRequestSchema = z
  .object({
    playbookId: z.string().min(1),
    workspaceRoot: z.string().min(1).optional(),
    capabilityInventory: WorkflowCapabilityInventorySchema.optional(),
    previousPlan: WorkflowRunAssignmentPlanSchema.optional(),
  })
  .strict();
export type PlaybookAssignmentPreviewRequest = z.infer<
  typeof PlaybookAssignmentPreviewRequestSchema
>;

const WorkflowInputControlSchema = z.enum(["text", "textarea", "date", "checkbox", "multiselect"]);
const WorkflowInputTypeSchema = z.enum(["string", "number", "boolean", "string[]", "enum"]);

export const WorkflowInputOptionSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
});
export type WorkflowInputOption = z.infer<typeof WorkflowInputOptionSchema>;

export const WorkflowInputDefinitionSchema = z
  .object({
    type: WorkflowInputTypeSchema,
    required: z.boolean().default(false),
    default: z.unknown().optional(),
    label: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    placeholder: z.string().min(1).optional(),
    order: z.number().int().nonnegative().optional(),
    group: z.string().min(1).optional(),
    options: z.array(WorkflowInputOptionSchema).optional(),
    ui: z
      .object({
        control: WorkflowInputControlSchema,
      })
      .optional(),
  })
  .superRefine((input, ctx) => {
    const control = input.ui?.control;
    if (!control) return;

    const validControlsByType: Record<z.infer<typeof WorkflowInputTypeSchema>, Set<string>> = {
      boolean: new Set(["checkbox"]),
      enum: new Set(["text", "multiselect"]),
      number: new Set(["text"]),
      string: new Set(["text", "textarea", "date"]),
      "string[]": new Set(["multiselect"]),
    };

    if (!validControlsByType[input.type].has(control)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Control ${control} is not valid for workflow input type ${input.type}`,
        path: ["ui", "control"],
      });
    }
  });

export type WorkflowInputDefinition = z.infer<typeof WorkflowInputDefinitionSchema>;

export const WorkflowToolStepSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  phase: z.string().min(1).optional(),
  kind: z.literal("tool"),
  toolId: z.enum(["workspace.ping", "workspace.writeProbe"]),
  args: z.record(z.unknown()).default({}),
  requires: WorkflowNodeRequirementsSchema.optional(),
  onSuccess: z.string().min(1).optional(),
  onFailure: z.string().min(1).optional(),
});

export type WorkflowToolStep = z.infer<typeof WorkflowToolStepSchema>;

export const WorkflowAgentStepSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  phase: z.string().min(1).optional(),
  kind: z.literal("agent"),
  prompt: z.string().min(1),
  workspaceRootInput: z.string().min(1).default("workspaceRoot"),
  requires: WorkflowNodeRequirementsSchema.optional(),
  onSuccess: z.string().min(1).optional(),
  onFailure: z.string().min(1).optional(),
});

export type WorkflowAgentStep = z.infer<typeof WorkflowAgentStepSchema>;
export type WorkflowStep = WorkflowToolStep | WorkflowAgentStep;

export const WorkflowOutputDeclarationSchema = z.object({
  kind: z.enum([
    "meetingBrief",
    "businessBrief",
    "statusDigest",
    "sourceSummary",
    "approvalRequest",
    "dashboard",
  ]),
  label: z.string().min(1),
  description: z.string().min(1).optional(),
  id: z.string().min(1).optional(),
  layoutScript: z.string().min(1).optional(),
  layout: z.string().min(1).optional(),
});
export type WorkflowOutputDeclaration = z.infer<typeof WorkflowOutputDeclarationSchema>;

export const DashboardSectionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("metrics"),
    title: z.string().min(1).optional(),
    items: z
      .array(
        z.object({
          label: z.string().min(1),
          binding: z.string().min(1),
          unit: z.string().min(1).optional(),
        })
      )
      .min(1),
  }),
  z.object({
    type: z.literal("list"),
    title: z.string().min(1),
    binding: z.string().min(1),
    emptyLabel: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("text"),
    title: z.string().min(1),
    binding: z.string().min(1),
  }),
  z.object({
    type: z.literal("table"),
    title: z.string().min(1),
    binding: z.string().min(1),
    columns: z.array(z.object({ key: z.string().min(1), label: z.string().min(1) })).min(1),
  }),
]);
export type DashboardSection = z.infer<typeof DashboardSectionSchema>;

export const DashboardLayoutSchema = z.object({
  refreshLabel: z.string().min(1).optional(),
  sections: z.array(DashboardSectionSchema).min(1),
});
export type DashboardLayout = z.infer<typeof DashboardLayoutSchema>;

function extractDashboardJsonValue(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```/i);
  const source = fenced?.[1]?.trim() ?? trimmed;
  const start = source.search(/[\[{]/);
  if (start === -1) return undefined;

  const opener = source[start];
  const closer = opener === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === opener) depth += 1;
    if (char === closer) depth -= 1;

    if (depth === 0) {
      try {
        return JSON.parse(source.slice(start, index + 1));
      } catch {
        return undefined;
      }
    }
  }

  return undefined;
}

function dashboardJsonTextFallback(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const text = (value as Record<string, unknown>).text;
  return typeof text === "string" ? extractDashboardJsonValue(text) : undefined;
}

export function resolveDashboardBinding(outputs: unknown, binding: string): unknown {
  if (!binding) return undefined;

  const parts = binding.split(".");
  let cursor: unknown = outputs;

  for (const part of parts) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
    const record = cursor as Record<string, unknown>;
    if (!(part in record)) {
      const fallback = dashboardJsonTextFallback(cursor);
      if (!fallback || typeof fallback !== "object" || Array.isArray(fallback)) return undefined;
      cursor = fallback;
    }
    cursor = (cursor as Record<string, unknown>)[part];
    if (cursor === undefined) return undefined;
  }

  return cursor;
}

export const WorkflowDefinitionSchema = z
  .object({
    id: z.string().min(1),
    version: z.number().int().positive(),
    name: z.string().min(1),
    description: z.string().optional(),
    category: z.string().min(1).optional(),
    businessUseCase: z.string().min(1).optional(),
    requiredCapabilities: z.array(WorkflowCapabilitySchema).default([]),
    optionalCapabilities: z.array(WorkflowCapabilitySchema).default([]),
    outputs: z.array(WorkflowOutputDeclarationSchema).optional(),
    phaseOrder: z.array(z.string().min(1)).optional(),
    inputs: z.record(WorkflowInputDefinitionSchema).default({}),
    start: z.string().min(1),
    steps: z
      .array(z.discriminatedUnion("kind", [WorkflowToolStepSchema, WorkflowAgentStepSchema]))
      .min(1),
  })
  .superRefine((definition, ctx) => {
    const sources = definition.inputs.sources;
    if (!sources?.options) return;

    for (const [index, option] of sources.options.entries()) {
      if (!WorkflowCapabilitySchema.safeParse(option.value).success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unsupported workflow source option: ${option.value}`,
          path: ["inputs", "sources", "options", index, "value"],
        });
      }
    }
  });

export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

export const PlaybookMetaSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  name: z.string().min(1),
  description: z.string().optional(),
  author: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).optional(),
  signature: z.string().min(1).optional(),
});
export type PlaybookMeta = z.infer<typeof PlaybookMetaSchema>;

export const PlaybookManifestSchema = z.object({
  schemaVersion: z.literal(1),
  meta: PlaybookMetaSchema,
  workflow: WorkflowDefinitionSchema,
});
export type PlaybookManifest = z.infer<typeof PlaybookManifestSchema>;

export const PlaybookSummarySchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  name: z.string().min(1),
  description: z.string().optional(),
  category: z.string().min(1).optional(),
  businessUseCase: z.string().min(1).optional(),
  requiredCapabilities: z.array(WorkflowCapabilitySchema).default([]),
  optionalCapabilities: z.array(WorkflowCapabilitySchema).default([]),
  outputs: z.array(WorkflowOutputDeclarationSchema).optional(),
  stepCount: z.number().int().nonnegative(),
  phases: z.array(z.string().min(1)).default([]),
});

export type PlaybookSummary = z.infer<typeof PlaybookSummarySchema>;

export const PlaybookDetailSchema = PlaybookSummarySchema.extend({
  inputs: z.record(WorkflowInputDefinitionSchema).default({}),
  steps: z.array(z.discriminatedUnion("kind", [WorkflowToolStepSchema, WorkflowAgentStepSchema])),
});

export type PlaybookDetail = z.infer<typeof PlaybookDetailSchema>;

export const PlaybookListResultSchema = z.object({
  playbooks: z.array(PlaybookSummarySchema),
});

export type PlaybookListResult = z.infer<typeof PlaybookListResultSchema>;

export const WorkflowRunStatusSchema = z.enum([
  "running",
  "blocked",
  "completed",
  "denied",
  "failed",
]);

export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>;

export const WorkflowRunEventStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "blocked",
  "failed",
  "denied",
  "completed",
]);

export type WorkflowRunEventStatus = z.infer<typeof WorkflowRunEventStatusSchema>;

export const WorkflowRunEventSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  workflowId: z.string().min(1),
  stepId: z.string().min(1).optional(),
  status: WorkflowRunEventStatusSchema,
  message: z.string().min(1),
  createdAt: z.string().datetime(),
  metadata: z.record(z.unknown()).optional(),
});

export type WorkflowRunEvent = z.infer<typeof WorkflowRunEventSchema>;

export const TokenUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    reasoningTokens: z.number().int().nonnegative().optional(),
  })
  .strict();
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const WorkflowRunStepRecordSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(["tool", "agent"]),
  phase: z.string().min(1),
  status: z.enum(["queued", "running", "succeeded", "blocked", "failed", "denied", "skipped"]),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  usage: TokenUsageSchema.optional(),
  outputPreview: z.string().optional(),
  error: z.string().optional(),
  assignment: WorkflowNodeAssignmentSchema.optional(),
});

export type WorkflowRunStepRecord = z.infer<typeof WorkflowRunStepRecordSchema>;

export const WorkflowRunRequestSchema = z.object({
  workflowId: z.string().min(1).default("demo.write-approval"),
  input: z.record(z.unknown()).default({}),
  capabilityInventory: WorkflowCapabilityInventorySchema.optional(),
  assignmentPlan: WorkflowRunAssignmentPlanSchema.optional(),
  agentProvider: AgentProviderConfigSchema.optional(),
  credential: z.object({ apiKey: z.string().min(1) }).optional(),
});

export type WorkflowRunRequest = z.infer<typeof WorkflowRunRequestSchema>;

export const WorkflowRunResultSchema = z.object({
  runId: z.string().min(1),
  workflowId: z.string().min(1),
  status: WorkflowRunStatusSchema,
  currentStepId: z.string().optional(),
  input: z.record(z.unknown()).default({}),
  assignmentPlan: WorkflowRunAssignmentPlanSchema.optional(),
  sourceGaps: z.array(WorkflowSourceGapSchema).default([]),
  outputs: z.record(z.unknown()).optional(),
  dashboardLayout: DashboardLayoutSchema.optional(),
  approval: PermissionDecisionSchema.options[1].shape.approval.optional(),
  error: z.string().optional(),
  startedAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  usage: TokenUsageSchema.optional(),
  steps: z.array(WorkflowRunStepRecordSchema).optional(),
  events: z.array(WorkflowRunEventSchema).optional(),
});

export type WorkflowRunResult = z.infer<typeof WorkflowRunResultSchema>;

export const PlaybookRunDetailSchema = WorkflowRunResultSchema.extend({
  playbook: PlaybookSummarySchema.optional(),
});

export type PlaybookRunDetail = z.infer<typeof PlaybookRunDetailSchema>;

export const WorkflowRunListResultSchema = z.object({
  runs: z.array(WorkflowRunResultSchema),
});

export type WorkflowRunListResult = z.infer<typeof WorkflowRunListResultSchema>;

export const WorkflowResumeRequestSchema = z.object({
  runId: z.string().min(1),
  decision: z.enum(["approve", "deny"]),
  capabilityInventory: WorkflowCapabilityInventorySchema.optional(),
  assignmentPlan: WorkflowRunAssignmentPlanSchema.optional(),
  agentProvider: AgentProviderConfigSchema.optional(),
  credential: z.object({ apiKey: z.string().min(1) }).optional(),
});

export type WorkflowResumeRequest = z.infer<typeof WorkflowResumeRequestSchema>;

const SECRET_FIELD_NAMES = new Set([
  "apikey",
  "api_key",
  "token",
  "secret",
  "password",
  "credential",
]);

function containsSecretField(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => containsSecretField(item));

  return Object.entries(value).some(([key, nested]) => {
    const normalized = key.toLowerCase().replace(/[-\s]/g, "_");
    return SECRET_FIELD_NAMES.has(normalized) || containsSecretField(nested);
  });
}

const SecretFreeJsonSchema = z.unknown().superRefine((value, ctx) => {
  if (!containsSecretField(value)) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: "Inbox payloads must not contain secret-bearing fields",
  });
});

export const InboxSourceSchema = z.enum(["task", "workflow", "agent", "system", "integration"]);
export type InboxSource = z.infer<typeof InboxSourceSchema>;

export const InboxMessageTypeSchema = z.enum([
  "approval",
  "input_required",
  "review",
  "exception",
  "credential",
  "policy_override",
  "artifact_review",
  "production_promotion",
]);
export type InboxMessageType = z.infer<typeof InboxMessageTypeSchema>;

export const InboxStatusSchema = z.enum(["open", "snoozed", "resolved", "expired", "cancelled"]);
export type InboxStatus = z.infer<typeof InboxStatusSchema>;

export const InboxSeveritySchema = z.enum(["info", "warning", "critical"]);
export type InboxSeverity = z.infer<typeof InboxSeveritySchema>;

export const InboxActionSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    style: z.enum(["primary", "secondary", "danger"]).default("secondary"),
    payloadHint: z.string().optional(),
  })
  .strict();
export type InboxAction = z.infer<typeof InboxActionSchema>;

export const InboxAuditEntrySchema = z.object({
  id: z.string().min(1),
  messageId: z.string().min(1),
  event: z.string().min(1),
  actor: z.string().min(1),
  payload: SecretFreeJsonSchema.optional(),
  createdAt: z.string().datetime(),
});
export type InboxAuditEntry = z.infer<typeof InboxAuditEntrySchema>;

export const InboxMessageSchema = z.object({
  id: z.string().min(1),
  workspaceRoot: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  workflowRunId: z.string().min(1).optional(),
  turnId: z.string().min(1).optional(),
  source: InboxSourceSchema,
  type: InboxMessageTypeSchema,
  severity: InboxSeveritySchema,
  status: InboxStatusSchema,
  title: z.string().min(1),
  body: z.string().optional(),
  context: SecretFreeJsonSchema,
  actions: z.array(InboxActionSchema),
  deadline: z.string().datetime().optional(),
  snoozedUntil: z.string().datetime().optional(),
  resolvedAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  audit: z.array(InboxAuditEntrySchema).default([]),
});
export type InboxMessage = z.infer<typeof InboxMessageSchema>;

export const InboxCreateRequestSchema = z.object({
  workspaceRoot: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  workflowRunId: z.string().min(1).optional(),
  turnId: z.string().min(1).optional(),
  source: InboxSourceSchema,
  type: InboxMessageTypeSchema,
  severity: InboxSeveritySchema,
  title: z.string().min(1),
  body: z.string().optional(),
  context: SecretFreeJsonSchema.default({}),
  actions: z.array(InboxActionSchema).default([]),
  deadline: z.string().datetime().optional(),
});
export type InboxCreateRequest = z.infer<typeof InboxCreateRequestSchema>;

export const InboxListResultSchema = z.object({
  messages: z.array(InboxMessageSchema),
});
export type InboxListResult = z.infer<typeof InboxListResultSchema>;

export const InboxResolveRequestSchema = z.object({
  actionId: z.string().min(1),
  payload: SecretFreeJsonSchema.optional(),
});
export type InboxResolveRequest = z.infer<typeof InboxResolveRequestSchema>;

export const InboxSnoozeRequestSchema = z.object({
  snoozedUntil: z.string().datetime(),
  reason: z.string().optional(),
});
export type InboxSnoozeRequest = z.infer<typeof InboxSnoozeRequestSchema>;

export const InboxCancelRequestSchema = z.object({
  reason: z.string().optional(),
});
export type InboxCancelRequest = z.infer<typeof InboxCancelRequestSchema>;

export const TaskStatusSchema = z.enum(["active", "waiting", "done", "failed"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskTurnRoleSchema = z.enum(["user", "agent", "system"]);
export type TaskTurnRole = z.infer<typeof TaskTurnRoleSchema>;

export const TaskTurnStatusSchema = z.enum(["queued", "running", "completed", "failed"]);
export type TaskTurnStatus = z.infer<typeof TaskTurnStatusSchema>;

export const TaskTurnSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  role: TaskTurnRoleSchema,
  content: z.string().min(1),
  status: TaskTurnStatusSchema,
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  error: z.string().optional(),
});
export type TaskTurn = z.infer<typeof TaskTurnSchema>;

export const TaskArtifactSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  turnId: z.string().min(1).optional(),
  kind: z.enum(["text", "file"]),
  title: z.string().min(1),
  path: z.string().min(1).optional(),
  contentPreview: z.string().optional(),
  createdAt: z.string().datetime(),
});
export type TaskArtifact = z.infer<typeof TaskArtifactSchema>;

export const TodoItemStatusSchema = z.enum(["pending", "in_progress", "completed"]);
export type TodoItemStatus = z.infer<typeof TodoItemStatusSchema>;

export const TodoItemSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  status: TodoItemStatusSchema,
  note: z.string().optional(),
  order: z.number().int().nonnegative(),
});
export type TodoItem = z.infer<typeof TodoItemSchema>;

export const TaskTodoSchema = z.object({
  items: z.array(TodoItemSchema),
  updatedAt: z.string().datetime(),
});
export type TaskTodo = z.infer<typeof TaskTodoSchema>;

export const SkillSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, {
  message: "Skill names must be lowercase slugs",
});
export const SkillIdSchema = z.string().regex(/^(?:[a-z0-9][a-z0-9-]*:)?[a-z0-9][a-z0-9-]*$/, {
  message: "Skill ids must be lowercase slugs, optionally prefixed by provider",
});
export const SkillSourceSchema = z.enum(["curated", "user", "workspace", "external"]);
export type SkillSource = z.infer<typeof SkillSourceSchema>;
export const ExternalSkillProviderSchema = z.enum(["claude-code", "codex"]);
export type ExternalSkillProvider = z.infer<typeof ExternalSkillProviderSchema>;

export const SkillSummarySchema = z.object({
  id: SkillIdSchema,
  name: SkillSlugSchema,
  description: z.string().min(1),
  source: SkillSourceSchema,
  externalProvider: ExternalSkillProviderSchema.optional(),
  path: z.string().min(1).optional(),
  updatedAt: z.string().datetime().optional(),
  conflict: z
    .object({
      shadowedSources: z.array(SkillSourceSchema),
    })
    .optional(),
});
export type SkillSummary = z.infer<typeof SkillSummarySchema>;

export const SkillDetailSchema = SkillSummarySchema.extend({
  content: z.string().min(1),
});
export type SkillDetail = z.infer<typeof SkillDetailSchema>;

export const SkillListResultSchema = z.object({
  skills: z.array(SkillSummarySchema),
});
export type SkillListResult = z.infer<typeof SkillListResultSchema>;

export const TaskSkillActivationSchema = z.object({
  skillId: SkillIdSchema,
  name: SkillSlugSchema,
  source: SkillSourceSchema,
  externalProvider: ExternalSkillProviderSchema.optional(),
  activatedAt: z.string().datetime(),
  activatedByTurnId: z.string().min(1).optional(),
});
export type TaskSkillActivation = z.infer<typeof TaskSkillActivationSchema>;

export const TaskSummarySchema = z.object({
  id: z.string().min(1),
  workspaceRoot: z.string().min(1),
  title: z.string().min(1),
  status: TaskStatusSchema,
  agentId: z.string().min(1).default("default"),
  agentLabel: z.string().min(1).optional(),
  latestActivity: z.string().optional(),
  archivedAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type TaskSummary = z.infer<typeof TaskSummarySchema>;

export const TaskDetailSchema = TaskSummarySchema.extend({
  description: z.string().optional(),
  agentContext: z
    .object({
      profileId: z.string().min(1),
      profileName: z.string().min(1),
      templateId: z.string().min(1).optional(),
      templateLabel: z.string().min(1).optional(),
      modelSource: z.enum(["global", "profile_override"]),
      sectionSummaries: z.object({
        instructions: z.string(),
        soul: z.string(),
        userContext: z.string(),
        memoryDefaults: z.string(),
      }),
      toolPolicy: z.object({
        preset: z.enum(["read_only", "workspace_editor", "elevated_with_approval"]),
        label: z.string().min(1),
        approvalMode: z.enum(["never", "ask"]),
        summary: z.string().min(1),
        capabilities: z.array(z.string().min(1)).min(1),
        allowedTools: z.array(z.string().min(1)).min(1),
      }),
      compiledSummary: z.string().min(1),
    })
    .optional(),
  todo: TaskTodoSchema.optional(),
  clarify: ClarifyRequestSchema.optional(),
  notifications: z.array(NotifyRequestSchema).default([]),
  auditRecords: z.array(AuditRecordSchema).default([]),
  activeSkills: z.array(TaskSkillActivationSchema).default([]),
  turns: z.array(TaskTurnSchema),
  artifacts: z.array(TaskArtifactSchema),
});
export type TaskDetail = z.infer<typeof TaskDetailSchema>;

export const TodoOperationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create"),
    items: z.array(TodoItemSchema),
  }),
  z.object({
    type: z.literal("replace"),
    items: z.array(TodoItemSchema),
  }),
  z.object({
    type: z.literal("set_status"),
    itemId: z.string().min(1),
    status: TodoItemStatusSchema,
  }),
  z.object({
    type: z.literal("append"),
    item: TodoItemSchema,
  }),
  z.object({
    type: z.literal("remove"),
    itemId: z.string().min(1),
  }),
]);
export type TodoOperation = z.infer<typeof TodoOperationSchema>;

export const TaskListResultSchema = z.object({
  tasks: z.array(TaskSummarySchema),
});
export type TaskListResult = z.infer<typeof TaskListResultSchema>;

export const AgentModelSelectionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("default") }).strict(),
  z.object({ mode: z.literal("override"), provider: AgentProviderConfigSchema }).strict(),
]);
export type AgentModelSelection = z.infer<typeof AgentModelSelectionSchema>;

export const ToolPolicyPresetSchema = z.enum([
  "read_only",
  "workspace_editor",
  "elevated_with_approval",
]);
export type ToolPolicyPreset = z.infer<typeof ToolPolicyPresetSchema>;

export const ToolPolicyRuntimeSchema = z.object({
  preset: ToolPolicyPresetSchema,
  label: z.string().min(1),
  approvalMode: z.enum(["never", "ask"]),
  summary: z.string().min(1),
  capabilities: z.array(z.string().min(1)).min(1),
  allowedTools: z.array(z.string().min(1)).min(1),
});
export type ToolPolicyRuntime = z.infer<typeof ToolPolicyRuntimeSchema>;

export const AgentSectionSummariesSchema = z.object({
  instructions: z.string(),
  soul: z.string(),
  userContext: z.string(),
  memoryDefaults: z.string(),
});
export type AgentSectionSummaries = z.infer<typeof AgentSectionSummariesSchema>;

export const AgentRuntimeContextSchema = z.object({
  profileId: z.string().min(1),
  profileName: z.string().min(1),
  templateId: z.string().min(1).optional(),
  templateLabel: z.string().min(1).optional(),
  modelSource: z.enum(["global", "profile_override"]),
  sectionSummaries: AgentSectionSummariesSchema,
  toolPolicy: ToolPolicyRuntimeSchema,
  compiledSummary: z.string().min(1),
});
export type AgentRuntimeContext = z.infer<typeof AgentRuntimeContextSchema>;

export const AgentProfileSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    model: AgentModelSelectionSchema,
    templateId: z.string().min(1).optional(),
    instructions: z.string().default(""),
    soul: z.string().default(""),
    userContext: z.string().default(""),
    skills: z.array(SkillIdSchema).default([]),
    toolPolicyPreset: ToolPolicyPresetSchema.default("workspace_editor"),
    memoryDefaults: z.string().default(""),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

export const AgentProfileCreateRequestSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  model: AgentModelSelectionSchema,
  templateId: z.string().min(1).optional(),
  instructions: z.string().default(""),
  soul: z.string().default(""),
  userContext: z.string().default(""),
  skills: z.array(SkillIdSchema).default([]),
  toolPolicyPreset: ToolPolicyPresetSchema.default("workspace_editor"),
  memoryDefaults: z.string().default(""),
});
export type AgentProfileCreateRequest = z.infer<typeof AgentProfileCreateRequestSchema>;

export const AgentProfileUpdateRequestSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  model: AgentModelSelectionSchema.optional(),
  instructions: z.string().optional(),
  soul: z.string().optional(),
  templateId: z.string().min(1).optional(),
  userContext: z.string().optional(),
  skills: z.array(SkillIdSchema).optional(),
  toolPolicyPreset: ToolPolicyPresetSchema.optional(),
  memoryDefaults: z.string().optional(),
});
export type AgentProfileUpdateRequest = z.infer<typeof AgentProfileUpdateRequestSchema>;

export const AgentProfileListResultSchema = z.object({
  profiles: z.array(AgentProfileSchema),
});
export type AgentProfileListResult = z.infer<typeof AgentProfileListResultSchema>;

export const TaskExecutionConfigSchema = z.object({
  agent: AgentProfileSchema,
  runtime: AgentRuntimeContextSchema,
  provider: AgentProviderConfigSchema,
  credential: z.object({ apiKey: z.string().min(1) }).optional(),
});
export type TaskExecutionConfig = z.infer<typeof TaskExecutionConfigSchema>;

export const TaskCreateRequestSchema = z.object({
  workspaceRoot: z.string().min(1),
  initialInstruction: z.string().min(1),
  description: z.string().optional(),
  agentId: z.string().min(1).default("default"),
  agentLabel: z.string().min(1).default("Tessera"),
  execution: TaskExecutionConfigSchema.optional(),
});
export type TaskCreateRequest = z.infer<typeof TaskCreateRequestSchema>;

export const TaskUpdateRequestSchema = z.object({
  title: z.string().min(1).optional(),
  status: TaskStatusSchema.optional(),
  latestActivity: z.string().optional(),
  archived: z.boolean().optional(),
});
export type TaskUpdateRequest = z.infer<typeof TaskUpdateRequestSchema>;

export const TaskCreateTurnRequestSchema = z.object({
  content: z.string().min(1),
  agentId: z.string().min(1).default("default"),
  execution: TaskExecutionConfigSchema.optional(),
});
export type TaskCreateTurnRequest = z.infer<typeof TaskCreateTurnRequestSchema>;

export const TaskEventTypeSchema = z.enum([
  "task.updated",
  "task.todo_updated",
  "task.clarify_requested",
  "task.clarify_resolved",
  "task.notification",
  "task.audit_recorded",
  "turn.created",
  "turn.status_changed",
  "turn.completed",
  "artifact.created",
]);
export type TaskEventType = z.infer<typeof TaskEventTypeSchema>;

const TaskEventBase = z.object({
  taskId: z.string().min(1),
  emittedAt: z.string().datetime(),
});

export const TaskUpdatedEventSchema = TaskEventBase.extend({
  type: z.literal("task.updated"),
  task: TaskSummarySchema,
});
export const TaskTodoUpdatedEventSchema = TaskEventBase.extend({
  type: z.literal("task.todo_updated"),
  todo: TaskTodoSchema.optional(),
});
export const TaskClarifyRequestedEventSchema = TaskEventBase.extend({
  type: z.literal("task.clarify_requested"),
  clarify: ClarifyRequestSchema,
});
export const TaskClarifyResolvedEventSchema = TaskEventBase.extend({
  type: z.literal("task.clarify_resolved"),
  response: ClarifyResponseSchema,
});
export const TaskNotificationEventSchema = TaskEventBase.extend({
  type: z.literal("task.notification"),
  notification: NotifyRequestSchema,
});
export const TaskAuditRecordedEventSchema = TaskEventBase.extend({
  type: z.literal("task.audit_recorded"),
  auditRecord: AuditRecordSchema,
});
export const TurnCreatedEventSchema = TaskEventBase.extend({
  type: z.literal("turn.created"),
  turn: TaskTurnSchema,
});
export const TurnStatusChangedEventSchema = TaskEventBase.extend({
  type: z.literal("turn.status_changed"),
  turn: TaskTurnSchema,
});
export const TurnCompletedEventSchema = TaskEventBase.extend({
  type: z.literal("turn.completed"),
  turn: TaskTurnSchema,
});
export const ArtifactCreatedEventSchema = TaskEventBase.extend({
  type: z.literal("artifact.created"),
  artifact: TaskArtifactSchema,
});

export const TaskEventSchema = z.discriminatedUnion("type", [
  TaskUpdatedEventSchema,
  TaskTodoUpdatedEventSchema,
  TaskClarifyRequestedEventSchema,
  TaskClarifyResolvedEventSchema,
  TaskNotificationEventSchema,
  TaskAuditRecordedEventSchema,
  TurnCreatedEventSchema,
  TurnStatusChangedEventSchema,
  TurnCompletedEventSchema,
  ArtifactCreatedEventSchema,
]);
export type TaskEvent = z.infer<typeof TaskEventSchema>;

export const TOOL_POLICY_PRESET_DETAILS: Record<
  ToolPolicyPreset,
  {
    label: string;
    approvalMode: ToolPolicyRuntime["approvalMode"];
    summary: string;
    capabilities: string[];
    allowedTools: string[];
  }
> = {
  read_only: {
    label: "Read-only",
    approvalMode: "never",
    summary:
      "Can inspect and search the workspace, research the public web, and maintain the task checklist, but cannot make file changes.",
    capabilities: [
      "Read files",
      "Extract PDF, Word, and Excel content",
      "List directories",
      "Search content",
      "Search and fetch public web pages",
      "Inspect public web pages with managed browser",
      "Manage task checklist",
    ],
    allowedTools: [
      "workspace_read",
      "workspace_extract",
      "workspace_list",
      "workspace_search",
      "shell",
      "browser",
      "todo",
      "skill_list",
      "skill_load",
    ],
  },
  workspace_editor: {
    label: "Workspace editor",
    approvalMode: "never",
    summary:
      "Can inspect the workspace, research the public web, maintain the task checklist, and update files directly when needed.",
    capabilities: [
      "Read files",
      "Extract PDF, Word, and Excel content",
      "List directories",
      "Search content",
      "Search and fetch public web pages",
      "Inspect public web pages with managed browser",
      "Write files",
      "Edit files",
      "Manage task checklist",
    ],
    allowedTools: [
      "workspace_read",
      "workspace_extract",
      "workspace_list",
      "workspace_search",
      "shell",
      "browser",
      "workspace_write",
      "workspace_edit",
      "todo",
      "skill_list",
      "skill_load",
    ],
  },
  elevated_with_approval: {
    label: "Elevated with approval",
    approvalMode: "ask",
    summary:
      "Can edit the workspace, research the public web, and maintain the task checklist, but should ask before taking mutating actions.",
    capabilities: [
      "Read files",
      "Extract PDF, Word, and Excel content",
      "List directories",
      "Search content",
      "Search and fetch public web pages",
      "Inspect public web pages with managed browser",
      "Write files",
      "Edit files",
      "Manage task checklist",
    ],
    allowedTools: [
      "workspace_read",
      "workspace_extract",
      "workspace_list",
      "workspace_search",
      "shell",
      "browser",
      "workspace_write",
      "workspace_edit",
      "todo",
      "skill_list",
      "skill_load",
    ],
  },
};

export function resolveToolPolicyPreset(preset: ToolPolicyPreset): ToolPolicyRuntime {
  const details = TOOL_POLICY_PRESET_DETAILS[preset];
  return ToolPolicyRuntimeSchema.parse({
    preset,
    label: details.label,
    approvalMode: details.approvalMode,
    summary: details.summary,
    capabilities: details.capabilities,
    allowedTools: details.allowedTools,
  });
}

function summarizeSection(text: string, emptyLabel: string): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) return emptyLabel;
  if (normalized.length <= 140) return normalized;
  return `${normalized.slice(0, 137).trimEnd()}...`;
}

function templateSummary(templateId?: string): string | undefined {
  return AGENT_PROFILE_TEMPLATES.find((template) => template.id === templateId)?.name;
}

export function compileAgentRuntimeContext(profile: AgentProfile): AgentRuntimeContext {
  const toolPolicy = resolveToolPolicyPreset(profile.toolPolicyPreset);
  const modelSource = profile.model.mode === "override" ? "profile_override" : "global";
  const profileSkills = profile.skills ?? [];
  const skillSummary =
    profileSkills.length === 0
      ? "No profile skills enabled."
      : `${profileSkills.length} profile skill${profileSkills.length === 1 ? "" : "s"} enabled.`;

  return AgentRuntimeContextSchema.parse({
    profileId: profile.id,
    profileName: profile.name,
    templateId: profile.templateId,
    templateLabel: templateSummary(profile.templateId),
    modelSource,
    sectionSummaries: {
      instructions: summarizeSection(profile.instructions, "No operating contract added."),
      soul: summarizeSection(profile.soul, "No tone guidance added."),
      userContext: summarizeSection(profile.userContext, "No user context added."),
      memoryDefaults: summarizeSection(profile.memoryDefaults, "No default memory added."),
    },
    toolPolicy,
    compiledSummary:
      modelSource === "profile_override"
        ? `${profile.name} uses ${toolPolicy.label} access with approval mode ${toolPolicy.approvalMode}, overrides the model configuration, and has ${skillSummary}`
        : `${profile.name} uses ${toolPolicy.label} access with approval mode ${toolPolicy.approvalMode}, inherits the workspace model settings, and has ${skillSummary}`,
  });
}

export const AgentProfileTemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  profile: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    instructions: z.string(),
    soul: z.string(),
    userContext: z.string(),
    skills: z.array(SkillIdSchema).default([]),
    toolPolicyPreset: ToolPolicyPresetSchema,
    memoryDefaults: z.string(),
  }),
});
export type AgentProfileTemplate = z.infer<typeof AgentProfileTemplateSchema>;

export const AGENT_PROFILE_TEMPLATES: AgentProfileTemplate[] = [
  {
    id: "business-operator",
    name: "Business Operator",
    description: "Structured delivery for planning, operations, and execution-heavy work.",
    profile: {
      name: "Business Operator",
      description: "Operational partner for planning and execution work.",
      instructions:
        "Turn broad business requests into concrete deliverables. Prefer clear next steps, decisions, and artifacts over abstract advice.",
      soul: "Direct, calm, and concise. Avoid filler and unnecessary flourish.",
      userContext:
        "The user is a business operator or founder who wants practical output, not a tutorial.",
      skills: [],
      toolPolicyPreset: "workspace_editor",
      memoryDefaults:
        "Reuse workspace terminology, active project names, and known deliverable formats when they are already established.",
    },
  },
  {
    id: "research-analyst",
    name: "Research Analyst",
    description: "Evidence-first profile for market, customer, and strategy research.",
    profile: {
      name: "Research Analyst",
      description: "Evidence-first research and synthesis assistant.",
      instructions:
        "Surface evidence, assumptions, and gaps clearly. Distinguish observed facts from recommendations and synthesize findings into concise takeaways.",
      soul: "Analytical, measured, and precise.",
      userContext:
        "The user needs synthesis they can use in strategy documents, memos, or stakeholder updates.",
      skills: [],
      toolPolicyPreset: "read_only",
      memoryDefaults:
        "Favor prior research notes, customer language, and recurring business questions already present in the workspace.",
    },
  },
  {
    id: "exec-partner",
    name: "Executive Partner",
    description: "High-trust profile for drafting, refining, and shipping polished outputs.",
    profile: {
      name: "Executive Partner",
      description: "High-trust drafting and execution partner.",
      instructions:
        "Produce decision-ready output quickly. When changes are material, confirm the intended direction before making irreversible edits.",
      soul: "Senior, polished, and brief.",
      userContext:
        "The user expects an experienced partner who can draft, revise, and package work at executive quality.",
      skills: [],
      toolPolicyPreset: "elevated_with_approval",
      memoryDefaults:
        "Preserve the user's established voice, preferred document structures, and recurring stakeholder context when available.",
    },
  },
];

export function getAgentProfileTemplate(templateId: string): AgentProfileTemplate | undefined {
  return AGENT_PROFILE_TEMPLATES.find((template) => template.id === templateId);
}
