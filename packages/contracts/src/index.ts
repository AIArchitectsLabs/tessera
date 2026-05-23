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

export const ThinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]);
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;

const CloudThinkingLevelSchema = ThinkingLevelSchema.exclude(["off"]).optional();

export const AgentProviderConfigSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("openai"),
    model: z.string().min(1),
    apiKeyEnv: z.string().min(1).default("OPENAI_API_KEY"),
    thinkingLevel: CloudThinkingLevelSchema,
  }),
  z.object({
    provider: z.literal("openai-codex"),
    model: z.string().min(1),
    thinkingLevel: CloudThinkingLevelSchema,
  }),
  z.object({
    provider: z.literal("anthropic"),
    model: z.string().min(1),
    apiKeyEnv: z.string().min(1).default("ANTHROPIC_API_KEY"),
    thinkingLevel: CloudThinkingLevelSchema,
  }),
  z.object({
    provider: z.literal("openrouter"),
    model: z.string().min(1),
    apiKeyEnv: z.string().min(1).default("OPENROUTER_API_KEY"),
    thinkingLevel: CloudThinkingLevelSchema,
  }),
  z.object({
    provider: z.literal("local"),
    model: z.string().min(1),
    baseUrl: z.string().url(),
    apiKeyEnv: z.string().min(1).optional(),
    thinkingLevel: z.never().optional(),
  }),
]);

export type AgentProviderConfig = z.infer<typeof AgentProviderConfigSchema>;

export const ModelProviderSchema = z.enum([
  "openai",
  "openai-codex",
  "anthropic",
  "openrouter",
  "local",
]);
export type ModelProvider = z.infer<typeof ModelProviderSchema>;

const OpenAIModelProviderSettingsSchema = z.object({
  provider: z.literal("openai"),
  model: z.string().min(1),
  hasCredential: z.boolean().default(false),
});

const OpenAICodexModelProviderSettingsSchema = z.object({
  provider: z.literal("openai-codex"),
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
  OpenAICodexModelProviderSettingsSchema,
  AnthropicModelProviderSettingsSchema,
  OpenRouterModelProviderSettingsSchema,
  LocalModelProviderSettingsSchema,
]);
export type ModelProviderSettings = z.infer<typeof ModelProviderSettingsSchema>;

export const ModelSettingsReadSchema = z.object({
  selectedProvider: ModelProviderSchema,
  providers: z.object({
    openai: OpenAIModelProviderSettingsSchema,
    "openai-codex": OpenAICodexModelProviderSettingsSchema,
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

export const ApiKeyRuntimeCredentialSchema = z.object({
  apiKey: z.string().min(1),
});

export const CodexOAuthRuntimeCredentialSchema = z.object({
  authType: z.literal("codex-oauth"),
  accessToken: z.string().min(1),
  baseUrl: z.string().url().default("https://chatgpt.com/backend-api/codex"),
  accountId: z.string().min(1).optional(),
});

export const ModelRuntimeCredentialSchema = z.union([
  ApiKeyRuntimeCredentialSchema,
  CodexOAuthRuntimeCredentialSchema,
]);
export type ModelRuntimeCredential = z.infer<typeof ModelRuntimeCredentialSchema>;

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

export const AuthenticatedUserSchema = z.object({
  userKey: z.string().min(1),
  email: z.string().min(1).optional(),
});
export type AuthenticatedUser = z.infer<typeof AuthenticatedUserSchema>;

export const IntegrationConnectionTestResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  provider: IntegrationProviderSchema.optional(),
  searchProvider: SearchProviderSchema.optional(),
  user: AuthenticatedUserSchema.optional(),
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

export const SheetsTableNameSchema = z.enum([
  "Suppliers",
  "RFQs",
  "Messages",
  "Quotes",
  "FollowUps",
  "Decisions",
]);
export type SheetsTableName = z.infer<typeof SheetsTableNameSchema>;

export const SheetsRowOperationSchema = z.enum([
  "upsert",
  "append",
  "updateStatus",
  "createWorkbook",
]);
export type SheetsRowOperation = z.infer<typeof SheetsRowOperationSchema>;

export const SheetsSupplierWorkbookHeaders = {
  Suppliers: ["supplier id", "name", "contact", "email", "platform URL", "country", "status"],
  RFQs: ["batch id", "product spec", "quantity", "due date", "requested fields"],
  Messages: ["supplier id", "thread id", "last sent", "last received", "follow-up count"],
  Quotes: [
    "supplier id",
    "price",
    "currency",
    "MOQ",
    "lead time",
    "incoterm",
    "confidence",
    "source message id",
  ],
  FollowUps: ["supplier id", "reason", "draft", "approval status", "sent timestamp"],
  Decisions: ["shortlisted", "rejected", "sample requested", "rationale"],
} as const satisfies Record<z.infer<typeof SheetsTableNameSchema>, readonly string[]>;

export const SheetsSupplierWorkbookTableSchema = z.object({
  table: SheetsTableNameSchema,
  headers: z.array(z.string().min(1)).min(1),
});
export type SheetsSupplierWorkbookTable = z.infer<typeof SheetsSupplierWorkbookTableSchema>;

export const SheetsRowPreviewSchema = z.object({
  action: SheetsRowOperationSchema,
  spreadsheetId: z.string().min(1).optional(),
  table: SheetsTableNameSchema.optional(),
  key: z
    .object({
      column: z.string().min(1),
      value: z.string().min(1),
    })
    .optional(),
  before: z.record(z.unknown()).nullable().optional(),
  after: z.record(z.unknown()).optional(),
  changedCells: z
    .array(
      z.object({
        column: z.string().min(1),
        before: z.unknown().optional(),
        after: z.unknown().optional(),
      })
    )
    .default([]),
  warnings: z.array(z.string()).default([]),
});
export type SheetsRowPreview = z.infer<typeof SheetsRowPreviewSchema>;

export const SheetsWritePreviewResultSchema = z.object({
  dryRun: z.literal(true),
  operation: SheetsRowOperationSchema,
  preview: SheetsRowPreviewSchema,
  idempotencyKey: z.string().min(1),
});
export type SheetsWritePreviewResult = z.infer<typeof SheetsWritePreviewResultSchema>;

export const SheetsWriteCommitResultSchema = z.object({
  dryRun: z.literal(false),
  operation: SheetsRowOperationSchema,
  spreadsheetId: z.string().min(1),
  table: SheetsTableNameSchema.optional(),
  updatedRange: z.string().min(1).optional(),
  updates: z.unknown().optional(),
  idempotencyKey: z.string().min(1),
  approvalId: z.string().min(1),
});
export type SheetsWriteCommitResult = z.infer<typeof SheetsWriteCommitResultSchema>;

export const SheetsWorkbookCreateResultSchema = z.object({
  dryRun: z.boolean(),
  operation: z.literal("createWorkbook").default("createWorkbook"),
  spreadsheetId: z.string().min(1).optional(),
  spreadsheetUrl: z.string().url().optional(),
  title: z.string().min(1),
  sheets: z.array(SheetsSupplierWorkbookTableSchema).min(1),
  headers: z.record(z.array(z.string().min(1))).optional(),
  idempotencyKey: z.string().min(1),
  approvalId: z.string().min(1).optional(),
});
export type SheetsWorkbookCreateResult = z.infer<typeof SheetsWorkbookCreateResultSchema>;

export const DocsOperationSchema = z.enum(["createDocument", "appendText", "replacePlaceholders"]);
export type DocsOperation = z.infer<typeof DocsOperationSchema>;

export const DocsWritePreviewResultSchema = z.object({
  dryRun: z.literal(true),
  operation: DocsOperationSchema,
  target: z
    .object({
      documentId: z.string().min(1).optional(),
      title: z.string().min(1).optional(),
    })
    .default({}),
  preview: z.object({
    text: z.string().optional(),
    replacements: z.record(z.string()).optional(),
    warnings: z.array(z.string()).default([]),
  }),
  idempotencyKey: z.string().min(1),
});
export type DocsWritePreviewResult = z.infer<typeof DocsWritePreviewResultSchema>;

export const DocsWriteCommitResultSchema = z.object({
  dryRun: z.literal(false),
  operation: DocsOperationSchema,
  documentId: z.string().min(1),
  documentUrl: z.string().url().optional(),
  revisionId: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1),
  approvalId: z.string().min(1),
});
export type DocsWriteCommitResult = z.infer<typeof DocsWriteCommitResultSchema>;

export const DocsCreateResultSchema = z.object({
  dryRun: z.boolean(),
  operation: z.literal("createDocument").default("createDocument"),
  documentId: z.string().min(1).optional(),
  title: z.string().min(1),
  documentUrl: z.string().url().optional(),
  textPreview: z.string().optional(),
  idempotencyKey: z.string().min(1),
  approvalId: z.string().min(1).optional(),
});
export type DocsCreateResult = z.infer<typeof DocsCreateResultSchema>;

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
  credential: ModelRuntimeCredentialSchema.optional(),
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

export const AgentTurnResultSchema = z.object({
  status: z.enum(["completed", "blocked", "denied", "error"]),
  messages: z.array(AgentMessageSummarySchema),
  toolResults: z.array(AgentToolResultSummarySchema),
  permissionDecisions: z.array(PermissionDecisionSchema),
  usage: TokenUsageSchema.optional(),
  error: z.string().optional(),
});

export type AgentTurnResult = z.infer<typeof AgentTurnResultSchema>;

export const ShellCommandNameSchema = z.enum([
  "web-search",
  "web-fetch",
  "gcal",
  "mail",
  "drive",
  "sheets",
  "docs",
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

export const PlaybookRunPreferenceSaveRequestSchema = z
  .object({
    workspaceRoot: z.string().min(1),
    assignmentPlan: WorkflowRunAssignmentPlanSchema,
    capabilityInventory: WorkflowCapabilityInventorySchema.optional(),
  })
  .strict();
export type PlaybookRunPreferenceSaveRequest = z.infer<
  typeof PlaybookRunPreferenceSaveRequestSchema
>;

export const PlaybookAssignmentPreviewRequestSchema = z
  .object({
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
  kind: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1).optional(),
  id: z.string().min(1).optional(),
  layoutScript: z.string().min(1).optional(),
  layout: z.string().min(1).optional(),
  layoutData: z.lazy(() => DashboardLayoutSchema).optional(),
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

const PLAYBOOK_ID_RE = /^[A-Za-z0-9._:-]+$/;
const ABSOLUTE_PATH_RE = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;

function isPackageRelativeRef(value: string): boolean {
  if (!value || ABSOLUTE_PATH_RE.test(value)) return false;

  return value.split(/[\\/]/).every((segment) => segment !== ".." && segment.length > 0);
}

const SafePlaybookIdSchema = z.string().min(1).regex(PLAYBOOK_ID_RE, {
  message: "Playbook ids may only contain letters, numbers, dot, underscore, colon, and dash",
});

const PlaybookGraphOutputPathSchema = z.string().min(1).refine(isPackageRelativeRef, {
  message: "Output paths must be package-relative and may not contain .. segments",
});

export const PlaybookGraphSourceRefSchema = z.string().min(1).refine(isPackageRelativeRef, {
  message: "Source refs must be package-relative and may not contain .. segments",
});
export type PlaybookGraphSourceRef = z.infer<typeof PlaybookGraphSourceRefSchema>;

export const PlaybookGraphArtifactPathRefSchema = z
  .object({
    artifact: z.string().min(1),
    path: z.string().min(1).default("$"),
  })
  .strict();
export type PlaybookGraphArtifactPathRef = z.infer<typeof PlaybookGraphArtifactPathRefSchema>;

export const PlaybookGraphArtifactSchema = z
  .object({
    schema: PlaybookGraphSourceRefSchema,
    materialize: PlaybookGraphOutputPathSchema.optional(),
  })
  .strict();
export type PlaybookGraphArtifact = z.infer<typeof PlaybookGraphArtifactSchema>;

export type PlaybookGraphCondition = {
  artifact: string;
  path: string;
  equals: unknown;
};

export const PlaybookGraphConditionSchema = z
  .object({
    artifact: z.string().min(1),
    path: z.string().min(1),
    equals: z.unknown(),
  })
  .strict();

export const PlaybookGraphLimitsSchema = z
  .object({
    maxGeneratedItems: z.number().int().positive().optional(),
    maxConcurrentBranches: z.number().int().positive().optional(),
    maxTotalBranches: z.number().int().positive().optional(),
    maxTotalAgentSteps: z.number().int().positive().optional(),
    maxRuntimeMs: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    maxExternalToolCalls: z.number().int().positive().optional(),
    maxFetches: z.number().int().positive().optional(),
  })
  .strict()
  .default({});
export type PlaybookGraphLimits = z.infer<typeof PlaybookGraphLimitsSchema>;

const PlaybookGraphInputSchema = WorkflowInputDefinitionSchema;
export type PlaybookGraphInput = WorkflowInputDefinition;

export const WorkspaceStyleToneDimensionsSchema = z
  .object({
    formality: z.number().int().min(0).max(5).default(3),
    warmth: z.number().int().min(0).max(5).default(2),
    urgency: z.number().int().min(0).max(5).default(1),
    playfulness: z.number().int().min(0).max(5).default(0),
  })
  .passthrough();
export type WorkspaceStyleToneDimensions = z.infer<typeof WorkspaceStyleToneDimensionsSchema>;

export const WorkspaceStyleCopyTypeSchema = z
  .object({
    label: z.string().min(1),
    length: z.enum(["short", "medium", "long"]).optional(),
    targetWords: z
      .object({
        min: z.number().int().nonnegative().optional(),
        max: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    tone: z.array(z.string().min(1)).default([]),
    formatRules: z.array(z.string().min(1)).default([]),
  })
  .passthrough();
export type WorkspaceStyleCopyType = z.infer<typeof WorkspaceStyleCopyTypeSchema>;

export const WorkspaceStyleExampleSchema = z
  .object({
    label: z.string().min(1).optional(),
    kind: z.enum(["positive", "negative"]).default("positive"),
    text: z.string().min(1),
    note: z.string().min(1).optional(),
  })
  .strict();
export type WorkspaceStyleExample = z.infer<typeof WorkspaceStyleExampleSchema>;

export const WorkspaceStyleGuideSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    profile: z
      .object({
        id: z.string().min(1).default("default"),
        name: z.string().min(1).default("Default Brand Voice"),
        locale: z.string().min(1).default("en-US"),
        defaultCopyType: z.string().min(1).default("blog.article.long"),
      })
      .passthrough()
      .default({}),
    voice: z
      .object({
        pointOfView: z.string().default(""),
        persona: z.string().default(""),
        principles: z.array(z.string().min(1)).default([]),
        avoid: z.array(z.string().min(1)).default([]),
      })
      .passthrough()
      .default({}),
    tone: z
      .object({
        default: z.array(z.string().min(1)).default([]),
        dimensions: WorkspaceStyleToneDimensionsSchema.default({}),
      })
      .passthrough()
      .default({}),
    language: z
      .object({
        readingLevel: z.string().default(""),
        jargonPolicy: z.string().default(""),
        preferredTerms: z.array(z.string().min(1)).default([]),
        bannedTerms: z.array(z.string().min(1)).default([]),
      })
      .passthrough()
      .default({}),
    structure: z
      .object({
        introMaxWords: z.number().int().positive().optional(),
        paragraphMaxSentences: z.number().int().positive().optional(),
        prefer: z.array(z.string().min(1)).default([]),
        avoid: z.array(z.string().min(1)).default([]),
      })
      .passthrough()
      .default({}),
    evidence: z
      .object({
        claimPolicy: z.string().default(""),
        citationStyle: z.string().default(""),
        unsupportedClaims: z.string().default(""),
      })
      .passthrough()
      .default({}),
    seoGeo: z
      .object({
        directAnswerRequired: z.boolean().default(false),
        answerWithinWords: z.number().int().positive().optional(),
        entityGuidance: z.string().default(""),
        snippetOptimization: z.array(z.string().min(1)).default([]),
      })
      .passthrough()
      .default({}),
    copyTypes: z.record(WorkspaceStyleCopyTypeSchema).default({}),
    examples: z.array(WorkspaceStyleExampleSchema).default([]),
    review: z
      .object({
        failOn: z.array(z.string().min(1)).default([]),
        warnOn: z.array(z.string().min(1)).default([]),
      })
      .passthrough()
      .default({}),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (!containsSecretField(value)) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Workspace style guide must not contain secret-bearing fields",
    });
  });
export type WorkspaceStyleGuide = z.infer<typeof WorkspaceStyleGuideSchema>;

export const WorkspaceConfigSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    styleGuide: WorkspaceStyleGuideSchema.optional(),
  })
  .catchall(z.unknown())
  .superRefine((value, ctx) => {
    if (!containsSecretField(value)) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Workspace config must not contain secret-bearing fields",
    });
  });
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;

export const WorkspaceStyleGuideReadRequestSchema = z
  .object({
    workspaceRoot: z.string().min(1),
  })
  .strict();
export type WorkspaceStyleGuideReadRequest = z.infer<typeof WorkspaceStyleGuideReadRequestSchema>;

export const WorkspaceStyleGuideSaveRequestSchema = z
  .object({
    workspaceRoot: z.string().min(1),
    config: WorkspaceConfigSchema,
    expectedFingerprint: z.string().min(1).optional(),
    overwrite: z.boolean().default(false),
  })
  .strict();
export type WorkspaceStyleGuideSaveRequest = z.infer<typeof WorkspaceStyleGuideSaveRequestSchema>;

export const WorkspaceStyleGuideReadResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaceRoot: z.string().min(1),
    exists: z.boolean(),
    config: WorkspaceConfigSchema,
    fingerprint: z.string().min(1),
    updatedAt: z.string().datetime().optional(),
  })
  .strict();
export type WorkspaceStyleGuideReadResult = z.infer<typeof WorkspaceStyleGuideReadResultSchema>;

export const WorkspaceStyleGuideSaveResultSchema = WorkspaceStyleGuideReadResultSchema.extend({
  savedAt: z.string().datetime(),
}).strict();
export type WorkspaceStyleGuideSaveResult = z.infer<typeof WorkspaceStyleGuideSaveResultSchema>;

export const GraphRunStyleSelectionSchema = z
  .object({
    copyType: z.string().min(1).optional(),
    override: z.string().max(2_000).optional(),
    toneNudges: z.array(z.string().min(1).max(80)).default([]),
  })
  .strict();
export type GraphRunStyleSelection = z.infer<typeof GraphRunStyleSelectionSchema>;

export const PlaybookGraphWritingStyleMetadataSchema = z
  .object({
    enabled: z.boolean().default(false),
    defaultCopyType: z.string().min(1).optional(),
    supportedCopyTypes: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type PlaybookGraphWritingStyleMetadata = z.infer<
  typeof PlaybookGraphWritingStyleMetadataSchema
>;

export const PlaybookGraphNodeStyleSchema = z
  .object({
    consume: z.boolean().default(false),
    copyType: z.string().min(1).optional(),
    purpose: z.enum(["draft", "rework", "review", "other"]).default("other"),
  })
  .strict();
export type PlaybookGraphNodeStyle = z.infer<typeof PlaybookGraphNodeStyleSchema>;

export type PlaybookGraphBranch = {
  start: string;
  nodes: PlaybookGraphNode[];
};

export type PlaybookGraphNodeBase = {
  id: string;
  label?: string;
  onSuccess?: string;
  onFailure?: string;
  style?: PlaybookGraphNodeStyle;
};

export type PlaybookGraphNodeOutput =
  | {
      artifact: string;
      schema?: string;
      style?: PlaybookGraphNodeStyle;
    }
  | {
      artifact?: string;
      schema: string;
      style?: PlaybookGraphNodeStyle;
    };

export const PlaybookGraphReviewActionDecisionSchema = z.enum([
  "approve",
  "request_changes",
  "deny",
]);
export type PlaybookGraphReviewActionDecision = z.infer<
  typeof PlaybookGraphReviewActionDecisionSchema
>;

export const PlaybookGraphActionToneSchema = z.enum(["primary", "secondary", "danger"]);
export type PlaybookGraphActionTone = z.infer<typeof PlaybookGraphActionToneSchema>;

export const PlaybookGraphReviewPayloadFieldSchema = z
  .object({
    path: z.string().min(1),
    label: z.string().min(1),
    kind: z.enum(["string", "json", "object", "compiledGraph", "sourceFiles"]),
    required: z.boolean().default(true),
  })
  .strict();
export type PlaybookGraphReviewPayloadField = z.infer<typeof PlaybookGraphReviewPayloadFieldSchema>;

export type PlaybookGraphHumanReviewAction = {
  id: string;
  decision: PlaybookGraphReviewActionDecision;
  label?: string;
  description?: string;
  target?: string;
  tone?: PlaybookGraphActionTone;
  payloadFields?: PlaybookGraphReviewPayloadField[];
  outputArtifact?: string;
};

export type PlaybookGraphJoinNode = PlaybookGraphNodeBase & {
  kind: "join";
  inputs: string[];
  outputArtifact?: string;
};

export type PlaybookGraphScriptNode = PlaybookGraphNodeBase & {
  kind: "script";
  run: string;
  inputs: Record<string, unknown>;
  outputArtifact?: string;
};

export type PlaybookGraphToolNode = PlaybookGraphNodeBase & {
  kind: "tool";
  capability: string;
  args: Record<string, unknown>;
  outputArtifact?: string;
};

export type PlaybookGraphHumanReviewNode = PlaybookGraphNodeBase & {
  kind: "humanReview";
  artifact: string;
  actions: Array<string | PlaybookGraphHumanReviewAction>;
  onApprove?: string;
  onRequestChanges?: string;
};

export type PlaybookGraphParallelMapNode = PlaybookGraphNodeBase & {
  kind: "parallelMap";
  items: PlaybookGraphArtifactPathRef;
  branch: PlaybookGraphBranch;
  outputArtifact?: string;
};

export type PlaybookGraphAgentNode = PlaybookGraphNodeBase & {
  kind: "agent";
  prompt: string;
  inputs: Record<string, unknown>;
  tools: string[];
  output?: PlaybookGraphNodeOutput;
};

export type PlaybookGraphConditionNode = PlaybookGraphNodeBase & {
  kind: "condition";
  when: PlaybookGraphCondition;
  onTrue: string;
  onFalse: string;
};

export type PlaybookGraphArtifactWriteNode = PlaybookGraphNodeBase & {
  kind: "artifactWrite";
  artifact: string;
  path: string;
};

export const PlaybookGraphNodeIdSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_.:-]+$/, {
    message: "Graph node ids must be stable path-safe id segments",
  })
  .refine((value) => value !== "." && value !== "..", {
    message: "Graph node ids may not be dot segments",
  });
export type PlaybookGraphNodeId = z.infer<typeof PlaybookGraphNodeIdSchema>;

export type PlaybookGraphNode =
  | PlaybookGraphJoinNode
  | PlaybookGraphScriptNode
  | PlaybookGraphToolNode
  | PlaybookGraphHumanReviewNode
  | PlaybookGraphParallelMapNode
  | PlaybookGraphAgentNode
  | PlaybookGraphConditionNode
  | PlaybookGraphArtifactWriteNode;

const PlaybookGraphNodeBaseSchema = z
  .object({
    id: PlaybookGraphNodeIdSchema,
    label: z.string().min(1).optional(),
    onSuccess: PlaybookGraphNodeIdSchema.optional(),
    onFailure: PlaybookGraphNodeIdSchema.optional(),
    style: PlaybookGraphNodeStyleSchema.optional(),
  })
  .strict();

const PlaybookGraphNodeOutputSchema = z
  .object({
    artifact: z.string().min(1).optional(),
    schema: PlaybookGraphSourceRefSchema.optional(),
    style: PlaybookGraphNodeStyleSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.artifact === undefined && value.schema === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Agent output must include artifact or schema",
      });
    }
  });

const PlaybookGraphBranchSchema: z.ZodType<PlaybookGraphBranch> = z
  .object({
    start: PlaybookGraphNodeIdSchema,
    nodes: z.array(z.lazy(() => PlaybookGraphNodeSchema)).min(1),
  })
  .strict();

const PlaybookGraphScriptRunSchema = PlaybookGraphSourceRefSchema.refine(
  (value) => value.endsWith(".ts"),
  {
    message: "Phase 1 playbook scripts must be TypeScript files",
  }
);

const PlaybookGraphJoinNodeSchema = PlaybookGraphNodeBaseSchema.extend({
  kind: z.literal("join"),
  inputs: z.array(z.string().min(1)).default([]),
  outputArtifact: z.string().min(1).optional(),
}).strict();

const PlaybookGraphScriptNodeSchema = PlaybookGraphNodeBaseSchema.extend({
  kind: z.literal("script"),
  run: PlaybookGraphScriptRunSchema,
  inputs: z.record(z.unknown()).default({}),
  outputArtifact: z.string().min(1).optional(),
}).strict();

const PlaybookGraphToolNodeSchema = PlaybookGraphNodeBaseSchema.extend({
  kind: z.literal("tool"),
  capability: z.string().min(1),
  args: z.record(z.unknown()).default({}),
  outputArtifact: z.string().min(1).optional(),
}).strict();

const PlaybookGraphHumanReviewActionSchema = z
  .object({
    id: PlaybookGraphNodeIdSchema,
    decision: PlaybookGraphReviewActionDecisionSchema,
    label: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    target: PlaybookGraphNodeIdSchema.optional(),
    tone: PlaybookGraphActionToneSchema.optional(),
    payloadFields: z.array(PlaybookGraphReviewPayloadFieldSchema).default([]),
    outputArtifact: z.string().min(1).optional(),
  })
  .strict();

const PlaybookGraphHumanReviewNodeSchema = PlaybookGraphNodeBaseSchema.extend({
  kind: z.literal("humanReview"),
  artifact: z.string().min(1),
  actions: z.array(z.union([z.string().min(1), PlaybookGraphHumanReviewActionSchema])).min(1),
  onApprove: PlaybookGraphNodeIdSchema.optional(),
  onRequestChanges: PlaybookGraphNodeIdSchema.optional(),
}).strict();

const PlaybookGraphParallelMapNodeSchema = PlaybookGraphNodeBaseSchema.extend({
  kind: z.literal("parallelMap"),
  items: PlaybookGraphArtifactPathRefSchema,
  branch: PlaybookGraphBranchSchema,
  outputArtifact: z.string().min(1).optional(),
}).strict();

const PlaybookGraphAgentNodeSchema = PlaybookGraphNodeBaseSchema.extend({
  kind: z.literal("agent"),
  prompt: PlaybookGraphSourceRefSchema,
  inputs: z.record(z.unknown()).default({}),
  tools: z.array(z.string().min(1)).default([]),
  output: PlaybookGraphNodeOutputSchema.optional(),
}).strict();

const PlaybookGraphConditionNodeSchema = PlaybookGraphNodeBaseSchema.extend({
  kind: z.literal("condition"),
  when: PlaybookGraphConditionSchema,
  onTrue: PlaybookGraphNodeIdSchema,
  onFalse: PlaybookGraphNodeIdSchema,
}).strict();

const PlaybookGraphArtifactWriteNodeSchema = PlaybookGraphNodeBaseSchema.extend({
  kind: z.literal("artifactWrite"),
  artifact: z.string().min(1),
  path: PlaybookGraphOutputPathSchema,
}).strict();

// Zod v3 recursive discriminated unions require a lazy/cast boundary here.
export const PlaybookGraphNodeSchema = z.lazy(() =>
  z.discriminatedUnion("kind", [
    PlaybookGraphJoinNodeSchema,
    PlaybookGraphScriptNodeSchema,
    PlaybookGraphToolNodeSchema,
    PlaybookGraphHumanReviewNodeSchema,
    PlaybookGraphParallelMapNodeSchema,
    PlaybookGraphAgentNodeSchema,
    PlaybookGraphConditionNodeSchema,
    PlaybookGraphArtifactWriteNodeSchema,
  ])
) as unknown as z.ZodType<PlaybookGraphNode>;

export type PlaybookGraph = {
  schemaVersion: 1;
  id: string;
  version: string;
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
  inputs: Record<string, PlaybookGraphInput>;
  artifacts: Record<string, PlaybookGraphArtifact>;
  capabilities: string[];
  limits: PlaybookGraphLimits;
  start: string;
  nodes: PlaybookGraphNode[];
};

export const PlaybookGraphSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: SafePlaybookIdSchema,
    version: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1).optional(),
    metadata: z.record(z.unknown()).optional(),
    inputs: z.record(PlaybookGraphInputSchema).default({}),
    artifacts: z.record(PlaybookGraphArtifactSchema).default({}),
    capabilities: z.array(z.string().min(1)).default([]),
    limits: PlaybookGraphLimitsSchema,
    start: PlaybookGraphNodeIdSchema,
    nodes: z.array(PlaybookGraphNodeSchema).min(1),
  })
  .strict();

export const PlaybookGraphPackageManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: SafePlaybookIdSchema,
    version: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1).optional(),
    entrypoint: PlaybookGraphSourceRefSchema.default("playbook.ts"),
  })
  .strict();
export type PlaybookGraphPackageManifest = z.infer<typeof PlaybookGraphPackageManifestSchema>;

export const GraphPlaybookImportStatusSchema = z.enum([
  "installed",
  "updated",
  "unchanged",
  "archived",
]);
export type GraphPlaybookImportStatus = z.infer<typeof GraphPlaybookImportStatusSchema>;

export const PlaybookGraphCompileMetadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    playbookId: SafePlaybookIdSchema,
    packageVersion: z.string().min(1),
    compilerVersion: z.string().min(1),
    graphSchemaVersion: z.literal(1),
    scriptSdkVersion: z.string().min(1),
    sourceHash: z
      .string()
      .min(1)
      .regex(/^sha256:/),
    graphHash: z
      .string()
      .min(1)
      .regex(/^sha256:/),
    compiledAt: z.string().datetime(),
  })
  .strict();
export type PlaybookGraphCompileMetadata = z.infer<typeof PlaybookGraphCompileMetadataSchema>;

export const CompiledPlaybookGraphSchema = z
  .object({
    graph: PlaybookGraphSchema,
    metadata: PlaybookGraphCompileMetadataSchema,
  })
  .strict();
export type CompiledPlaybookGraph = z.infer<typeof CompiledPlaybookGraphSchema>;

const Sha256DigestSchema = z
  .string()
  .min(1)
  .regex(/^sha256:/, "Expected a sha256-prefixed digest");
const StrictSha256DigestSchema = z
  .string()
  .min(1)
  .regex(/^sha256:[a-f0-9]{64}$/, "Expected a sha256-prefixed hex digest");

export const GraphPlaybookImportResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: GraphPlaybookImportStatusSchema,
    id: SafePlaybookIdSchema,
    version: z.string().min(1),
    name: z.string().min(1),
    graphHash: StrictSha256DigestSchema,
    sourceHash: StrictSha256DigestSchema,
    warnings: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type GraphPlaybookImportResult = z.infer<typeof GraphPlaybookImportResultSchema>;

export const PlaybookGraphRunStatusSchema = z.enum([
  "queued",
  "running",
  "blocked",
  "interrupted",
  "needs_attention",
  "completed",
  "failed",
  "denied",
  "needs_repair",
]);
export type PlaybookGraphRunStatus = z.infer<typeof PlaybookGraphRunStatusSchema>;

export const PlaybookGraphQueueStatusSchema = z.enum([
  "queued",
  "running",
  "memoized",
  "succeeded",
  "blocked",
  "interrupted",
  "needs_attention",
  "failed",
  "skipped",
]);
export type PlaybookGraphQueueStatus = z.infer<typeof PlaybookGraphQueueStatusSchema>;

export const PlaybookGraphNodePathSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_.:-]+(?:\/[A-Za-z0-9_.:-]+)*$/, {
    message: "Graph node paths must use stable slash-separated id segments",
  })
  .refine((value) => value.split("/").every((segment) => segment !== "." && segment !== ".."), {
    message: "Graph node paths may not contain dot segments",
  });
export type PlaybookGraphNodePath = z.infer<typeof PlaybookGraphNodePathSchema>;

export const GraphRunStyleContextSchema = z
  .object({
    schemaVersion: z.literal(1),
    profileId: z.string().min(1),
    profileName: z.string().min(1),
    copyType: z.string().min(1),
    source: z.enum(["defaults", "workspace"]),
    snapshot: WorkspaceStyleGuideSchema,
    override: z.string().max(2_000).optional(),
    toneNudges: z.array(z.string().min(1).max(80)).default([]),
  })
  .strict();
export type GraphRunStyleContext = z.infer<typeof GraphRunStyleContextSchema>;

export const PlaybookGraphPlatformContextSchema = z
  .object({
    styleGuide: GraphRunStyleContextSchema.optional(),
    styleGuideHash: Sha256DigestSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!containsSecretField(value)) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Graph platform context must not contain secret-bearing fields",
    });
  });
export type PlaybookGraphPlatformContext = z.infer<typeof PlaybookGraphPlatformContextSchema>;

export const StyleComplianceSeveritySchema = z.enum(["pass", "warning", "fail"]);
export type StyleComplianceSeverity = z.infer<typeof StyleComplianceSeveritySchema>;

export const StyleComplianceFindingSchema = z
  .object({
    artifactId: z.string().min(1),
    outputKind: z.string().min(1).optional(),
    nodePath: PlaybookGraphNodePathSchema,
    severity: StyleComplianceSeveritySchema,
    ruleId: z.string().min(1),
    message: z.string().min(1),
    suggestedFix: z.string().min(1).optional(),
  })
  .strict();
export type StyleComplianceFinding = z.infer<typeof StyleComplianceFindingSchema>;

export const StyleComplianceSummarySchema = z
  .object({
    schemaVersion: z.literal(1),
    styleGuideHash: Sha256DigestSchema.optional(),
    profileName: z.string().min(1).optional(),
    copyType: z.string().min(1).optional(),
    severity: StyleComplianceSeveritySchema.default("pass"),
    findings: z.array(StyleComplianceFindingSchema).default([]),
  })
  .strict();
export type StyleComplianceSummary = z.infer<typeof StyleComplianceSummarySchema>;

export const PlaybookGraphSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    snapshotJson: z.string().min(1),
    snapshotHash: Sha256DigestSchema,
    graphHash: Sha256DigestSchema,
    sourceHash: Sha256DigestSchema,
    sourceFileHashes: z.record(Sha256DigestSchema).default({}),
    sourceFiles: z.record(z.string()).optional(),
    playbookId: SafePlaybookIdSchema,
    packageVersion: z.string().min(1),
    compilerVersion: z.string().min(1),
    graphSchemaVersion: z.literal(1),
    scriptSdkVersion: z.string().min(1),
    compiledAt: z.string().datetime(),
  })
  .strict();
export type PlaybookGraphSnapshot = z.infer<typeof PlaybookGraphSnapshotSchema>;

export const PlaybookGraphRunListFilterSchema = z
  .object({
    ownerUserKey: z.string().min(1).optional(),
    workspaceRoot: z.string().min(1).optional(),
    playbookId: SafePlaybookIdSchema.optional(),
    status: PlaybookGraphRunStatusSchema.optional(),
    limit: z.number().int().positive().max(100).optional(),
  })
  .strict();
export type PlaybookGraphRunListFilter = z.infer<typeof PlaybookGraphRunListFilterSchema>;

export const PlaybookGraphMaterializationTargetSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("workspace"),
    workspaceRoot: z.string().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!containsSecretField(value)) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Graph materialization targets must not contain secret-bearing fields",
    });
  });
export type PlaybookGraphMaterializationTarget = z.infer<
  typeof PlaybookGraphMaterializationTargetSchema
>;

const PlaybookGraphExecutionContextInputSchema = z.record(z.unknown()).superRefine((value, ctx) => {
  if (!containsSecretField(value)) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: "Graph execution context must not contain secret-bearing fields",
  });
});

export const PlaybookGraphExecutionContextSchema = z
  .object({
    schemaVersion: z.literal(1),
    executionContextHash: Sha256DigestSchema,
    fingerprints: PlaybookGraphExecutionContextInputSchema.default({}),
  })
  .strict();
export type PlaybookGraphExecutionContext = z.infer<typeof PlaybookGraphExecutionContextSchema>;

export const PlaybookGraphRunRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().min(1),
    ownerUserKey: z.string().min(1).optional(),
    playbookId: SafePlaybookIdSchema,
    status: PlaybookGraphRunStatusSchema,
    input: z.record(z.unknown()).default({}),
    platformContext: PlaybookGraphPlatformContextSchema.optional(),
    materialization: PlaybookGraphMaterializationTargetSchema.optional(),
    executionContext: PlaybookGraphExecutionContextSchema.optional(),
    assignmentPlan: WorkflowRunAssignmentPlanSchema.optional(),
    snapshot: PlaybookGraphSnapshotSchema,
    currentQueueEntryId: z.string().min(1).optional(),
    blockedReason: z.string().min(1).optional(),
    repairReason: z.string().min(1).optional(),
    error: z.string().min(1).optional(),
    startedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
  })
  .strict();
export type PlaybookGraphRunRecord = z.infer<typeof PlaybookGraphRunRecordSchema>;

export const PlaybookGraphArtifactVersionRefSchema = z
  .object({
    artifactId: z.string().min(1),
    versionId: z.string().min(1),
    contentHash: Sha256DigestSchema,
  })
  .strict();
export type PlaybookGraphArtifactVersionRef = z.infer<typeof PlaybookGraphArtifactVersionRefSchema>;

export const PlaybookGraphRecoveryPolicySchema = z.enum([
  "rerun_if_no_success_memo",
  "block_for_review",
  "fail",
]);
export type PlaybookGraphRecoveryPolicy = z.infer<typeof PlaybookGraphRecoveryPolicySchema>;

export const PlaybookGraphAttentionCodeSchema = z.enum([
  "stale_lease",
  "stale_heartbeat",
  "hard_timeout",
  "hard_timeout_observed",
  "lost_worker",
  "ambiguous_recovery",
  "manual_mark_worker_lost",
  "cancellation_requested",
]);
export type PlaybookGraphAttentionCode = z.infer<typeof PlaybookGraphAttentionCodeSchema>;

export const PlaybookGraphRecoveryDecisionSchema = z.enum([
  "auto_requeued",
  "needs_attention",
  "continued_waiting",
  "retry_requested",
  "force_failed",
  "cancel_requested",
]);
export type PlaybookGraphRecoveryDecision = z.infer<typeof PlaybookGraphRecoveryDecisionSchema>;

export const PlaybookGraphAttentionEvidenceSchema = z
  .object({
    code: PlaybookGraphAttentionCodeSchema,
    reason: z.string().min(1),
    observedAt: z.string().datetime(),
    previousQueueStatus: z.enum(["running", "interrupted"]).optional(),
    lastRuntimeId: z.string().min(1).optional(),
    lastLeaseId: z.string().min(1).optional(),
    lastClaimedAt: z.string().datetime().optional(),
    leaseExpiredAt: z.string().datetime().optional(),
    thresholdMs: z.number().int().positive().optional(),
    lastHeartbeatAt: z.string().datetime().optional(),
    recoveryDecision: PlaybookGraphRecoveryDecisionSchema,
  })
  .strict();
export type PlaybookGraphAttentionEvidence = z.infer<typeof PlaybookGraphAttentionEvidenceSchema>;

export const PlaybookGraphArtifactBindingStateSchema = z.enum(["resolved", "unresolved", "stale"]);
export type PlaybookGraphArtifactBindingState = z.infer<
  typeof PlaybookGraphArtifactBindingStateSchema
>;

export const PlaybookGraphQueueEntrySchema = z
  .object({
    schemaVersion: z.literal(1),
    queueEntryId: z.string().min(1),
    runId: z.string().min(1),
    nodeId: z.string().min(1),
    nodePath: PlaybookGraphNodePathSchema,
    nodeKind: z.enum([
      "join",
      "script",
      "tool",
      "humanReview",
      "parallelMap",
      "agent",
      "condition",
      "artifactWrite",
    ]),
    status: PlaybookGraphQueueStatusSchema,
    dependsOn: z.array(z.string().min(1)).default([]),
    producesArtifacts: z.array(z.string().min(1)).default([]),
    declaredConsumesArtifacts: z.array(z.string().min(1)).default([]),
    consumesArtifacts: z.array(PlaybookGraphArtifactVersionRefSchema).default([]),
    artifactBindingState: PlaybookGraphArtifactBindingStateSchema.default("resolved"),
    recoveryPolicy: PlaybookGraphRecoveryPolicySchema.default("rerun_if_no_success_memo"),
    attentionEvidence: PlaybookGraphAttentionEvidenceSchema.optional(),
    nodeMemoKey: Sha256DigestSchema.optional(),
    attempt: z.number().int().nonnegative().default(0),
    runtimeId: z.string().min(1).optional(),
    leaseId: z.string().min(1).optional(),
    claimedAt: z.string().datetime().optional(),
    leaseExpiresAt: z.string().datetime().optional(),
    lastHeartbeatAt: z.string().datetime().optional(),
    blockedReason: z.string().min(1).optional(),
    error: z.string().min(1).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
  })
  .strict();
export type PlaybookGraphQueueEntry = z.infer<typeof PlaybookGraphQueueEntrySchema>;

export const PlaybookGraphBranchItemSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().min(1),
    parentQueueEntryId: z.string().min(1),
    branchItemId: z.string().min(1),
    nodePath: PlaybookGraphNodePathSchema,
    index: z.number().int().nonnegative(),
    itemHash: Sha256DigestSchema,
    value: z.unknown().optional(),
    status: z.enum(["queued", "running", "completed", "failed", "skipped"]),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type PlaybookGraphBranchItem = z.infer<typeof PlaybookGraphBranchItemSchema>;

export const PlaybookGraphArtifactVersionSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().min(1),
    artifactId: z.string().min(1),
    versionId: z.string().min(1),
    producerQueueEntryId: z.string().min(1),
    nodePath: PlaybookGraphNodePathSchema,
    contentHash: Sha256DigestSchema,
    value: z.unknown(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type PlaybookGraphArtifactVersion = z.infer<typeof PlaybookGraphArtifactVersionSchema>;

export const PlaybookGraphReviewEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    reviewEventId: z.string().min(1),
    runId: z.string().min(1),
    queueEntryId: z.string().min(1),
    nodePath: PlaybookGraphNodePathSchema,
    artifactId: z.string().min(1),
    artifactVersionId: z.string().min(1).optional(),
    decision: z.enum(["requested", "approved", "denied", "request_changes", "edited"]),
    payload: z.record(z.unknown()).default({}),
    createdAt: z.string().datetime(),
  })
  .strict();
export type PlaybookGraphReviewEvent = z.infer<typeof PlaybookGraphReviewEventSchema>;

export const PlaybookGraphOperationKindSchema = z.enum([
  "resume",
  "edit_input",
  "edit_artifact",
  "edit_review",
  "retry_interrupted",
  "retry_needs_attention",
  "repair",
  "git_milestone",
  "soft_timeout_observed",
  "hard_timeout_observed",
]);
export type PlaybookGraphOperationKind = z.infer<typeof PlaybookGraphOperationKindSchema>;

export const PlaybookGraphOperationStatusSchema = z.enum(["started", "succeeded", "failed"]);
export type PlaybookGraphOperationStatus = z.infer<typeof PlaybookGraphOperationStatusSchema>;

const PlaybookGraphOperationSummarySchema = z
  .string()
  .max(500)
  .superRefine((value, ctx) => {
    if (
      !/(api[-_\s]?key|access[-_\s]?token|refresh[-_\s]?token|secret|password|credential|authorization)/i.test(
        value
      )
    ) {
      return;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Graph operation payload summaries must not contain secret-bearing fields",
    });
  });

export const PlaybookGraphOperationRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    operationRecordId: z.string().min(1),
    operationAttemptId: z.string().min(1),
    runId: z.string().min(1),
    actionSpecId: z.string().min(1),
    kind: PlaybookGraphOperationKindSchema,
    status: PlaybookGraphOperationStatusSchema,
    operatorIntent: z.string().min(1).max(160),
    queueEntryId: z.string().min(1).optional(),
    affectedArtifactIds: z.array(z.string().min(1)).default([]),
    affectedReviewEventIds: z.array(z.string().min(1)).default([]),
    affectedQueueEntryIds: z.array(z.string().min(1)).default([]),
    gitEvidenceId: z.string().min(1).optional(),
    redactedPayloadSummary: PlaybookGraphOperationSummarySchema.optional(),
    createdAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
    failureReason: z.string().min(1).max(1_000).optional(),
  })
  .strict();
export type PlaybookGraphOperationRecord = z.infer<typeof PlaybookGraphOperationRecordSchema>;

export const PlaybookGraphMemoKeyPartsSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().min(1),
    snapshotHash: Sha256DigestSchema,
    graphHash: Sha256DigestSchema,
    nodePath: PlaybookGraphNodePathSchema,
    nodeSpecHash: Sha256DigestSchema,
    executionContextHash: Sha256DigestSchema,
    platformContextHash: Sha256DigestSchema.optional(),
    inputSnapshotHash: Sha256DigestSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!containsSecretField(value)) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Graph memo key parts must not contain secret-bearing fields",
    });
  });
export type PlaybookGraphMemoKeyParts = z.infer<typeof PlaybookGraphMemoKeyPartsSchema>;

export const PlaybookGraphNodeMemoSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().min(1),
    nodeMemoKey: Sha256DigestSchema,
    queueEntryId: z.string().min(1),
    nodePath: PlaybookGraphNodePathSchema,
    status: z.literal("succeeded"),
    memoKeyParts: PlaybookGraphMemoKeyPartsSchema,
    artifactRefs: z.array(PlaybookGraphArtifactVersionRefSchema).default([]),
    outputPreview: z.string().optional(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type PlaybookGraphNodeMemo = z.infer<typeof PlaybookGraphNodeMemoSchema>;

export const PlaybookGraphResumeDecisionSchema = z
  .object({
    runId: z.string().min(1),
    actionId: z.string().min(1).optional(),
    decision: z.enum([
      "approve",
      "deny",
      "request_changes",
      "retry_interrupted",
      "retry_needs_attention",
      "approve_context_change",
      "approve_repair",
      "retry_repair",
      "edit_input",
      "edit_artifact",
      "edit_review",
    ]),
    queueEntryId: z.string().min(1).optional(),
    payload: z.record(z.unknown()).default({}),
    executionContext: PlaybookGraphExecutionContextInputSchema.optional(),
    assignmentPlan: WorkflowRunAssignmentPlanSchema.optional(),
    agentProvider: AgentProviderConfigSchema.optional(),
    credential: ModelRuntimeCredentialSchema.optional(),
  })
  .strict();
export type PlaybookGraphResumeDecision = z.infer<typeof PlaybookGraphResumeDecisionSchema>;

export const PlaybookGraphResumeActionSpecSchema = z
  .object({
    schemaVersion: z.literal(1),
    actionId: z.string().min(1),
    decision: PlaybookGraphResumeDecisionSchema.shape.decision,
    label: z.string().min(1),
    description: z.string().min(1).optional(),
    tone: PlaybookGraphActionToneSchema.optional(),
    queueEntryId: z.string().min(1).optional(),
    nodePath: PlaybookGraphNodePathSchema.optional(),
    nodeKind: PlaybookGraphQueueEntrySchema.shape.nodeKind.optional(),
    allowedRunStatuses: z.array(PlaybookGraphRunStatusSchema).min(1),
    allowedQueueStatuses: z.array(PlaybookGraphQueueStatusSchema).default([]),
    requiredPayloadFields: z.array(PlaybookGraphReviewPayloadFieldSchema).default([]),
    sideEffect: z.enum(["none", "resume", "invalidate_downstream", "terminal", "git_commit"]),
    destructive: z.boolean().default(false),
    invalidatesDownstream: z.boolean().default(false),
    requiresExecutionContext: z.boolean().default(false),
    requiresProvider: z.boolean().default(false),
    requiresCredential: z.boolean().default(false),
    requiresWorkspace: z.boolean().default(false),
  })
  .strict();
export type PlaybookGraphResumeActionSpec = z.infer<typeof PlaybookGraphResumeActionSpecSchema>;

export const PlaybookRunProductStateSchema = z.enum([
  "working",
  "recovering",
  "waiting_for_review",
  "retry_available",
  "failed",
  "completed",
  "restart_required",
]);
export type PlaybookRunProductState = z.infer<typeof PlaybookRunProductStateSchema>;

export const PlaybookRunProductActionSchema = z
  .object({
    actionId: z.string().min(1),
    label: z.string().min(1),
    description: z.string().min(1).optional(),
    tone: PlaybookGraphActionToneSchema.default("primary"),
    decision: PlaybookGraphResumeDecisionSchema.shape.decision,
    queueEntryId: z.string().min(1).optional(),
  })
  .strict();
export type PlaybookRunProductAction = z.infer<typeof PlaybookRunProductActionSchema>;

export const PlaybookRunProductViewSchema = z
  .object({
    schemaVersion: z.literal(1),
    state: PlaybookRunProductStateSchema,
    title: z.string().min(1),
    message: z.string().min(1),
    primaryAction: PlaybookRunProductActionSchema.optional(),
    secondaryActions: z.array(PlaybookRunProductActionSchema).default([]),
    technicalSummary: z
      .object({
        internalStatus: z.string().min(1),
        attentionCode: PlaybookGraphAttentionCodeSchema.optional(),
        queueEntryId: z.string().min(1).optional(),
        nodePath: PlaybookGraphNodePathSchema.optional(),
        nodeKind: PlaybookGraphQueueEntrySchema.shape.nodeKind.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PlaybookRunProductView = z.infer<typeof PlaybookRunProductViewSchema>;

export const PlaybookGraphActiveArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactId: z.string().min(1),
    versionId: z.string().min(1),
    producerQueueEntryId: z.string().min(1),
    producerStatus: PlaybookGraphQueueStatusSchema.optional(),
    nodePath: PlaybookGraphNodePathSchema,
    contentHash: Sha256DigestSchema,
    value: z.unknown(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type PlaybookGraphActiveArtifact = z.infer<typeof PlaybookGraphActiveArtifactSchema>;

export const PlaybookGraphArtifactTimelineRowSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactId: z.string().min(1),
    versionId: z.string().min(1),
    producerQueueEntryId: z.string().min(1),
    producerStatus: PlaybookGraphQueueStatusSchema.optional(),
    nodePath: PlaybookGraphNodePathSchema,
    contentHash: Sha256DigestSchema,
    active: z.boolean(),
    value: z.unknown(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type PlaybookGraphArtifactTimelineRow = z.infer<
  typeof PlaybookGraphArtifactTimelineRowSchema
>;

export const PlaybookGraphTimelineRowSchema = z
  .object({
    schemaVersion: z.literal(1),
    timelineRowId: z.string().min(1),
    kind: z.enum([
      "review_event",
      "synthetic_requested",
      "synthetic_blocked",
      "synthetic_interrupted",
      "synthetic_repair",
      "git_milestone",
      "operation_record",
    ]),
    createdAt: z.string().datetime(),
    synthetic: z.boolean().default(false),
    queueEntryId: z.string().min(1).optional(),
    nodePath: PlaybookGraphNodePathSchema.optional(),
    artifactId: z.string().min(1).optional(),
    reviewEventId: z.string().min(1).optional(),
    decision: PlaybookGraphReviewEventSchema.shape.decision.optional(),
    message: z.string().min(1),
    payload: z.record(z.unknown()).default({}),
  })
  .strict();
export type PlaybookGraphTimelineRow = z.infer<typeof PlaybookGraphTimelineRowSchema>;

export const PlaybookGraphBranchDrilldownItemSchema = z
  .object({
    schemaVersion: z.literal(1),
    branchItem: PlaybookGraphBranchItemSchema,
    queue: z.array(PlaybookGraphQueueEntrySchema).default([]),
    activeArtifacts: z.array(PlaybookGraphActiveArtifactSchema).default([]),
    stale: z.boolean().default(false),
    error: z.string().min(1).optional(),
  })
  .strict();
export type PlaybookGraphBranchDrilldownItem = z.infer<
  typeof PlaybookGraphBranchDrilldownItemSchema
>;

export const PlaybookGraphBranchDrilldownGroupSchema = z
  .object({
    schemaVersion: z.literal(1),
    parentQueueEntryId: z.string().min(1),
    parentNodePath: PlaybookGraphNodePathSchema,
    parentStatus: PlaybookGraphQueueStatusSchema,
    items: z.array(PlaybookGraphBranchDrilldownItemSchema).default([]),
  })
  .strict();
export type PlaybookGraphBranchDrilldownGroup = z.infer<
  typeof PlaybookGraphBranchDrilldownGroupSchema
>;

export const PlaybookGraphGitChangedFileSchema = z
  .object({
    path: z.string().min(1),
    previousPath: z.string().min(1).optional(),
    status: z.string().min(1),
    allowed: z.boolean(),
  })
  .strict();
export type PlaybookGraphGitChangedFile = z.infer<typeof PlaybookGraphGitChangedFileSchema>;

export const PlaybookGraphGitMilestoneEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().min(1),
    actionSpecId: z.string().min(1),
    affectedPaths: z.array(z.string().min(1)).min(1),
    commitHash: z.string().min(1),
    committedAt: z.string().datetime(),
    trailers: z.record(z.string()).default({}),
  })
  .strict();
export type PlaybookGraphGitMilestoneEvidence = z.infer<
  typeof PlaybookGraphGitMilestoneEvidenceSchema
>;

export const PlaybookGraphGitMilestonePreviewSchema = z
  .object({
    schemaVersion: z.literal(1),
    available: z.boolean(),
    unavailableReason: z.string().min(1).optional(),
    workspaceRoot: z.string().min(1).optional(),
    gitRoot: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
    changedFiles: z.array(PlaybookGraphGitChangedFileSchema).default([]),
    proposedMessage: z.string().min(1).optional(),
    dirtyPolicy: z.enum(["clean_only", "allow_selected_paths"]).default("allow_selected_paths"),
    unsupportedFeatures: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type PlaybookGraphGitMilestonePreview = z.infer<
  typeof PlaybookGraphGitMilestonePreviewSchema
>;

export const PlaybookGraphGitMilestonePreviewRequestSchema = z
  .object({
    runId: z.string().min(1),
    actionSpecId: z.string().min(1),
    workspaceRoot: z.string().min(1).optional(),
    affectedPaths: z.array(z.string().min(1)).default([]),
    message: z.string().min(1).optional(),
    dirtyPolicy: z.enum(["clean_only", "allow_selected_paths"]).default("allow_selected_paths"),
  })
  .strict();
export type PlaybookGraphGitMilestonePreviewRequest = z.infer<
  typeof PlaybookGraphGitMilestonePreviewRequestSchema
>;

export const PlaybookGraphGitMilestoneCommitRequestSchema = z
  .object({
    runId: z.string().min(1),
    actionSpecId: z.string().min(1),
    workspaceRoot: z.string().min(1),
    affectedPaths: z.array(z.string().min(1)).min(1),
    message: z.string().min(1),
  })
  .strict();
export type PlaybookGraphGitMilestoneCommitRequest = z.infer<
  typeof PlaybookGraphGitMilestoneCommitRequestSchema
>;

export const PlaybookGraphGitMilestoneCommitResultSchema = z
  .object({
    evidence: PlaybookGraphGitMilestoneEvidenceSchema,
    preview: PlaybookGraphGitMilestonePreviewSchema,
  })
  .strict();
export type PlaybookGraphGitMilestoneCommitResult = z.infer<
  typeof PlaybookGraphGitMilestoneCommitResultSchema
>;

export const PlaybookGraphRunListResultSchema = z
  .object({
    runs: z.array(PlaybookGraphRunRecordSchema),
  })
  .strict();
export type PlaybookGraphRunListResult = z.infer<typeof PlaybookGraphRunListResultSchema>;

export const PlaybookGraphRunCreateRequestSchema = z
  .object({
    input: z.record(z.unknown()).default({}),
    compiledGraph: CompiledPlaybookGraphSchema.optional(),
    sourceFiles: z.record(z.string()).optional(),
    playbookId: SafePlaybookIdSchema.optional(),
    graphHash: Sha256DigestSchema.optional(),
    sourceHash: Sha256DigestSchema.optional(),
    drainDeterministic: z.boolean().default(false),
    workspaceRoot: z.string().min(1).optional(),
    styleGuideSelection: GraphRunStyleSelectionSchema.optional(),
    executionContext: PlaybookGraphExecutionContextInputSchema.optional(),
    assignmentPlan: WorkflowRunAssignmentPlanSchema.optional(),
    agentId: z.string().min(1).default("default"),
    agentProvider: AgentProviderConfigSchema.optional(),
    credential: ModelRuntimeCredentialSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasCompiledGraph = value.compiledGraph !== undefined;
    const hasCacheRef =
      value.playbookId !== undefined ||
      value.graphHash !== undefined ||
      value.sourceHash !== undefined;
    if (hasCompiledGraph === hasCacheRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide either compiledGraph or playbookId plus graphHash plus sourceHash",
      });
    }
    if (
      hasCacheRef &&
      (value.playbookId === undefined ||
        value.graphHash === undefined ||
        value.sourceHash === undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Cache reference requires playbookId, graphHash, and sourceHash",
      });
    }
  });
export type PlaybookGraphRunCreateRequest = z.infer<typeof PlaybookGraphRunCreateRequestSchema>;

export const PlaybookGraphRunDrainRequestSchema = z
  .object({
    executionContext: PlaybookGraphExecutionContextInputSchema.optional(),
    assignmentPlan: WorkflowRunAssignmentPlanSchema.optional(),
    agentProvider: AgentProviderConfigSchema.optional(),
    credential: ModelRuntimeCredentialSchema.optional(),
  })
  .strict();
export type PlaybookGraphRunDrainRequest = z.infer<typeof PlaybookGraphRunDrainRequestSchema>;

export const PlaybookGraphRunDetailSchema = z
  .object({
    run: PlaybookGraphRunRecordSchema,
    queue: z.array(PlaybookGraphQueueEntrySchema).default([]),
    branchItems: z.array(PlaybookGraphBranchItemSchema).default([]),
    artifacts: z.array(PlaybookGraphArtifactVersionSchema).default([]),
    reviews: z.array(PlaybookGraphReviewEventSchema).default([]),
    operations: z.array(PlaybookGraphOperationRecordSchema).default([]),
  })
  .strict();
export type PlaybookGraphRunDetail = z.infer<typeof PlaybookGraphRunDetailSchema>;

export const PlaybookGraphRunReviewSurfaceSchema = z
  .object({
    schemaVersion: z.literal(1),
    detail: PlaybookGraphRunDetailSchema,
    activeArtifacts: z.array(PlaybookGraphActiveArtifactSchema).default([]),
    artifactTimeline: z.array(PlaybookGraphArtifactTimelineRowSchema).default([]),
    timeline: z.array(PlaybookGraphTimelineRowSchema).default([]),
    branches: z.array(PlaybookGraphBranchDrilldownGroupSchema).default([]),
    actions: z.array(PlaybookGraphResumeActionSpecSchema).default([]),
    gitMilestone: PlaybookGraphGitMilestonePreviewSchema.optional(),
    productView: PlaybookRunProductViewSchema.optional(),
    styleCompliance: StyleComplianceSummarySchema.optional(),
  })
  .strict();
export type PlaybookGraphRunReviewSurface = z.infer<typeof PlaybookGraphRunReviewSurfaceSchema>;

export const PlaybookSummarySchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  packageVersion: z.string().min(1).default("1"),
  name: z.string().min(1),
  description: z.string().optional(),
  graphHash: Sha256DigestSchema.optional(),
  sourceHash: Sha256DigestSchema.optional(),
  category: z.string().min(1).optional(),
  businessUseCase: z.string().min(1).optional(),
  requiredCapabilities: z.array(WorkflowCapabilitySchema).default([]),
  optionalCapabilities: z.array(WorkflowCapabilitySchema).default([]),
  outputs: z.array(WorkflowOutputDeclarationSchema).optional(),
  writingStyle: PlaybookGraphWritingStyleMetadataSchema.optional(),
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
  "needs_attention",
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

export const WorkflowRunStepRecordSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(["tool", "agent"]),
  phase: z.string().min(1),
  status: z.enum([
    "queued",
    "running",
    "succeeded",
    "blocked",
    "needs_attention",
    "failed",
    "denied",
    "skipped",
  ]),
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
  workflowId: z.string().min(1).default("sales.meeting-brief"),
  input: z.record(z.unknown()).default({}),
  capabilityInventory: WorkflowCapabilityInventorySchema.optional(),
  assignmentPlan: WorkflowRunAssignmentPlanSchema.optional(),
  agentProvider: AgentProviderConfigSchema.optional(),
  credential: ModelRuntimeCredentialSchema.optional(),
});

export type WorkflowRunRequest = z.infer<typeof WorkflowRunRequestSchema>;

export const WorkflowRunResultSchema = z.object({
  runId: z.string().min(1),
  workflowId: z.string().min(1),
  packageVersion: z.string().min(1).optional(),
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
  credential: ModelRuntimeCredentialSchema.optional(),
});

export type WorkflowResumeRequest = z.infer<typeof WorkflowResumeRequestSchema>;

const SECRET_FIELD_NAMES = new Set([
  "apikey",
  "accesstoken",
  "token",
  "refreshtoken",
  "secret",
  "clientsecret",
  "secretkey",
  "privatekey",
  "password",
  "credential",
  "authorization",
]);

function containsSecretField(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => containsSecretField(item));

  return Object.entries(value).some(([key, nested]) => {
    const normalized = key.toLowerCase().replace(/[-_\s]/g, "");
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

export const InboxStatusSchema = z.enum([
  "open",
  "snoozed",
  "resolved",
  "expired",
  "cancelled",
  "consumed",
]);
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
  consumedAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  audit: z.array(InboxAuditEntrySchema).default([]),
});
export type InboxMessage = z.infer<typeof InboxMessageSchema>;

export const InboxCreateRequestSchema = z.object({
  workspaceRoot: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
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

export const MemoryScopeSchema = z.enum(["task", "playbook", "user", "workspace", "system"]);
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

export const MemoryTypeSchema = z.enum(["fact", "preference", "procedure", "lesson", "warning"]);
export type MemoryType = z.infer<typeof MemoryTypeSchema>;

export const MemorySensitivitySchema = z.enum([
  "public",
  "personal",
  "sensitive",
  "secret_suspect",
]);
export type MemorySensitivity = z.infer<typeof MemorySensitivitySchema>;

export const MemoryCapturePolicySchema = z.enum([
  "full",
  "summary",
  "metadata_only",
  "redacted",
  "rejected",
]);
export type MemoryCapturePolicy = z.infer<typeof MemoryCapturePolicySchema>;

export const MemoryFreshnessSchema = z.enum(["fresh", "aging", "stale", "unknown"]);
export type MemoryFreshness = z.infer<typeof MemoryFreshnessSchema>;

export const MemoryStatusSchema = z.enum(["candidate", "active", "rejected", "archived"]);
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;

export const MemoryRuntimeStatusSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(["active", "disabled", "fallback"]),
  dbPath: z.string(),
  startupWarning: z
    .object({
      type: z.literal("tessera.memory.startup_failed"),
      message: z.string(),
    })
    .optional(),
});
export type MemoryRuntimeStatus = z.infer<typeof MemoryRuntimeStatusSchema>;

export const MemoryEventSchema = z.object({
  id: z.string().min(1),
  eventKey: z.string().min(1),
  workspaceKey: z.string().min(1).optional(),
  ownerId: z.string().min(1).optional(),
  scope: MemoryScopeSchema,
  subjectType: z.string().min(1),
  subjectId: z.string().min(1),
  eventType: z.string().min(1),
  content: z.string(),
  contentHash: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).default({}),
  sensitivity: MemorySensitivitySchema,
  capturePolicy: MemoryCapturePolicySchema,
  schemaVersion: z.literal(1),
  createdAt: z.string().datetime(),
});
export type MemoryEvent = z.infer<typeof MemoryEventSchema>;

export const MemorySourceRefSchema = z.object({
  type: z.string().min(1),
  id: z.string().min(1),
});
export type MemorySourceRef = z.infer<typeof MemorySourceRefSchema>;

export const MemorySchema = z.object({
  id: z.string().min(1),
  workspaceKey: z.string().min(1).optional(),
  ownerId: z.string().min(1).optional(),
  scope: MemoryScopeSchema,
  type: MemoryTypeSchema,
  title: z.string().min(1),
  body: z.string().min(1),
  status: MemoryStatusSchema,
  confidence: z.number().min(0).max(1),
  freshness: MemoryFreshnessSchema,
  expiresAt: z.string().datetime().optional(),
  sourceEventIds: z.array(z.string().min(1)),
  sourceDocumentIds: z.array(z.string().min(1)),
  supersedesMemoryId: z.string().min(1).optional(),
  lastUsedAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Memory = z.infer<typeof MemorySchema>;

export const MemoryRecallModeSchema = z.enum(["none", "task", "workspace", "personalized"]);
export type MemoryRecallMode = z.infer<typeof MemoryRecallModeSchema>;

export const MemoryRecallItemSchema = z.object({
  memoryId: z.string().min(1),
  scope: MemoryScopeSchema,
  type: MemoryTypeSchema,
  title: z.string().min(1),
  body: z.string().min(1),
  confidence: z.number().min(0).max(1),
  freshness: MemoryFreshnessSchema,
  sourceRefs: z.array(MemorySourceRefSchema),
  reason: z.string().min(1),
});
export type MemoryRecallItem = z.infer<typeof MemoryRecallItemSchema>;

export const MemoryRecallTraceSchema = z.object({
  query: z.string(),
  workspaceKey: z.string().min(1).optional(),
  candidateCount: z.number().int().nonnegative(),
  selectedCount: z.number().int().nonnegative(),
  omittedReasons: z.array(z.string().min(1)).default([]),
  durationMs: z.number().nonnegative(),
});
export type MemoryRecallTrace = z.infer<typeof MemoryRecallTraceSchema>;

export const MemoryRecallRequestSchema = z.object({
  mode: MemoryRecallModeSchema,
  query: z.string(),
  workspaceKey: z.string().min(1).optional(),
  ownerId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  maxCharacters: z.number().int().positive().default(1500),
});
export type MemoryRecallRequest = z.infer<typeof MemoryRecallRequestSchema>;

export const MemoryRecallResultSchema = z
  .object({
    mode: MemoryRecallModeSchema,
    timedOut: z.boolean().default(false),
    items: z.array(MemoryRecallItemSchema),
    trace: MemoryRecallTraceSchema,
  })
  .superRefine((value, ctx) => {
    if (value.trace.selectedCount > value.trace.candidateCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "trace.selectedCount cannot exceed trace.candidateCount",
        path: ["trace", "selectedCount"],
      });
    }

    if (value.trace.selectedCount !== value.items.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "trace.selectedCount must match items.length",
        path: ["trace", "selectedCount"],
      });
    }

    if (value.timedOut && value.items.length !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "timedOut results must not include items",
        path: ["items"],
      });
    }

    if (value.timedOut && value.trace.selectedCount !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "timedOut results must report zero selected items",
        path: ["trace", "selectedCount"],
      });
    }

    if (value.mode === "none" && value.items.length !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'mode "none" must not return items',
        path: ["items"],
      });
    }

    if (value.mode === "none" && value.trace.selectedCount !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'mode "none" must report zero selected items',
        path: ["trace", "selectedCount"],
      });
    }
  });
export type MemoryRecallResult = z.infer<typeof MemoryRecallResultSchema>;

export const MemoryCandidateRationaleSchema = z.object({
  supportingEventIds: z.array(z.string().min(1)),
  conflictingMemoryIds: z.array(z.string().min(1)),
  promotionReason: z.string().min(1),
  riskFlags: z.array(z.enum(["personal", "secret_suspect", "stale", "low_confidence"])),
});
export type MemoryCandidateRationale = z.infer<typeof MemoryCandidateRationaleSchema>;

export const MemoryCandidateSchema = MemorySchema.extend({
  status: z.literal("candidate"),
  rationale: MemoryCandidateRationaleSchema,
});
export type MemoryCandidate = z.infer<typeof MemoryCandidateSchema>;

export const MemoryReviewListResultSchema = z.object({
  active: z.array(MemorySchema),
  candidates: z.array(MemoryCandidateSchema),
});
export type MemoryReviewListResult = z.infer<typeof MemoryReviewListResultSchema>;

export const MemoryPromotionDecisionSchema = z.object({
  candidateId: z.string().min(1),
  decision: z.enum(["accept", "reject", "archive"]),
  reason: z.string().min(1),
  decidedAt: z.string().datetime(),
});
export type MemoryPromotionDecision = z.infer<typeof MemoryPromotionDecisionSchema>;

export const MemoryReviewDecisionRequestSchema = z.object({
  memoryId: z.string().min(1),
  decision: z.enum(["accept", "reject", "archive"]),
  reason: z.string().min(1),
  decidedAt: z.string().datetime(),
});
export type MemoryReviewDecisionRequest = z.infer<typeof MemoryReviewDecisionRequestSchema>;

export const MemoryForgetActionSchema = z.enum(["archive", "redact", "delete"]);
export type MemoryForgetAction = z.infer<typeof MemoryForgetActionSchema>;

export const MemoryForgetRequestSchema = z.object({
  memoryId: z.string().min(1),
  action: MemoryForgetActionSchema.optional(),
  reason: z.string().min(1),
  requestedAt: z.string().datetime(),
});
export type MemoryForgetRequest = z.infer<typeof MemoryForgetRequestSchema>;

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

export const PdfEngineRuntimeSchema = z.enum(["typescript", "python", "binary"]);
export type PdfEngineRuntime = z.infer<typeof PdfEngineRuntimeSchema>;

export const PdfWarningSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();
export type PdfWarning = z.infer<typeof PdfWarningSchema>;

export const PdfToolNameSchema = z.enum([
  "pdf_inspect",
  "pdf_extract",
  "pdf_validate",
  "pdf_render",
  "pdf_transform",
  "pdf_create",
  "pdf_manifest",
]);
export type PdfToolName = z.infer<typeof PdfToolNameSchema>;

export const PdfCapabilityInstallHintSchema = z
  .object({
    capabilityId: z.string().min(1),
    available: z.boolean(),
    installed: z.boolean(),
    version: z.string().min(1),
    sizeBytes: z.number().int().positive().optional(),
  })
  .strict();
export type PdfCapabilityInstallHint = z.infer<typeof PdfCapabilityInstallHintSchema>;

export const PdfEngineCapabilitySchema = z
  .object({
    engine: z.string().min(1),
    engineRuntime: PdfEngineRuntimeSchema,
    available: z.boolean(),
    command: z.string().min(1).optional(),
    version: z.string().min(1).optional(),
    provides: z.array(PdfToolNameSchema),
    message: z.string().min(1).optional(),
    install: PdfCapabilityInstallHintSchema.optional(),
  })
  .strict();
export type PdfEngineCapability = z.infer<typeof PdfEngineCapabilitySchema>;

export const PdfToolCapabilitySchema = z
  .object({
    name: PdfToolNameSchema,
    available: z.boolean(),
    requiredEngines: z.array(z.string().min(1)),
    message: z.string().min(1).optional(),
  })
  .strict();
export type PdfToolCapability = z.infer<typeof PdfToolCapabilitySchema>;

export const PdfCapabilitiesResultSchema = z
  .object({
    engines: z.array(PdfEngineCapabilitySchema),
    tools: z.array(PdfToolCapabilitySchema),
    warnings: z.array(PdfWarningSchema).default([]),
  })
  .strict();
export type PdfCapabilitiesResult = z.infer<typeof PdfCapabilitiesResultSchema>;

export const PdfPageRangeSchema = z
  .object({
    start: z.number().int().positive().optional(),
    end: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.start === undefined && value.end === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Pdf page ranges must specify at least one bound",
      });
    }

    if (value.start !== undefined && value.end !== undefined && value.end < value.start) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Pdf page ranges must not end before they start",
      });
    }
  });
export type PdfPageRange = z.infer<typeof PdfPageRangeSchema>;

export const PdfOperationProvenanceSchema = z
  .object({
    createdAt: z.string().datetime(),
    immutableSource: z.literal(true),
  })
  .strict();
export type PdfOperationProvenance = z.infer<typeof PdfOperationProvenanceSchema>;

export const PdfInspectResultSchema = z
  .object({
    path: z.string().min(1),
    fileType: z.literal("pdf"),
    bytes: z.number().int().nonnegative(),
    pageCount: z.number().int().nonnegative(),
    encrypted: z.boolean(),
    hasTextLayer: z.boolean(),
    pagesWithText: z.array(z.number().int().positive()),
    metadata: z.record(z.string(), z.string()).default({}),
    engine: z.string().min(1),
    engineRuntime: PdfEngineRuntimeSchema,
    provenance: PdfOperationProvenanceSchema,
    warnings: z.array(PdfWarningSchema).default([]),
  })
  .strict();
export type PdfInspectResult = z.infer<typeof PdfInspectResultSchema>;

export const PdfExtractPageSchema = z
  .object({
    pageNumber: z.number().int().positive(),
    text: z.string(),
    charCount: z.number().int().nonnegative(),
    ocr: z.boolean(),
  })
  .strict();
export type PdfExtractPage = z.infer<typeof PdfExtractPageSchema>;

export const PdfExtractResultSchema = z
  .object({
    path: z.string().min(1),
    fileType: z.literal("pdf"),
    bytes: z.number().int().nonnegative(),
    text: z.string(),
    pages: z.array(PdfExtractPageSchema),
    truncated: z.boolean(),
    engine: z.string().min(1),
    engineRuntime: PdfEngineRuntimeSchema,
    provenance: PdfOperationProvenanceSchema,
    warnings: z.array(PdfWarningSchema).default([]),
  })
  .strict();
export type PdfExtractResult = z.infer<typeof PdfExtractResultSchema>;

export const PdfValidationCheckSchema = z
  .object({
    name: z.string().min(1),
    passed: z.boolean(),
    message: z.string().min(1),
  })
  .strict();
export type PdfValidationCheck = z.infer<typeof PdfValidationCheckSchema>;

export const PdfValidateResultSchema = z
  .object({
    path: z.string().min(1),
    exists: z.boolean(),
    fileType: z.literal("pdf"),
    bytes: z.number().int().nonnegative(),
    pageCount: z.number().int().nonnegative(),
    hasTextLayer: z.boolean(),
    passed: z.boolean(),
    checks: z.array(PdfValidationCheckSchema),
    engine: z.string().min(1),
    engineRuntime: PdfEngineRuntimeSchema,
    provenance: PdfOperationProvenanceSchema,
    warnings: z.array(PdfWarningSchema).default([]),
  })
  .strict();
export type PdfValidateResult = z.infer<typeof PdfValidateResultSchema>;

export const PdfRenderOutputSchema = z
  .object({
    pageNumber: z.number().int().positive(),
    path: z.string().min(1),
    format: z.enum(["png"]),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();
export type PdfRenderOutput = z.infer<typeof PdfRenderOutputSchema>;

export const PdfRenderResultSchema = z
  .object({
    path: z.string().min(1),
    fileType: z.literal("pdf"),
    outputs: z.array(PdfRenderOutputSchema),
    engine: z.string().min(1),
    engineRuntime: PdfEngineRuntimeSchema,
    provenance: PdfOperationProvenanceSchema,
    warnings: z.array(PdfWarningSchema).default([]),
  })
  .strict();
export type PdfRenderResult = z.infer<typeof PdfRenderResultSchema>;

export const PdfTransformOperationSchema = z.enum(["split", "merge", "reorder", "rotate"]);
export type PdfTransformOperation = z.infer<typeof PdfTransformOperationSchema>;

export const PdfPageMappingSchema = z
  .object({
    sourcePath: z.string().min(1),
    sourcePage: z.number().int().positive(),
    outputPage: z.number().int().positive(),
  })
  .strict();
export type PdfPageMapping = z.infer<typeof PdfPageMappingSchema>;

export const PdfTransformResultSchema = z
  .object({
    outputPath: z.string().min(1),
    fileType: z.literal("pdf"),
    operation: PdfTransformOperationSchema,
    sourcePaths: z.array(z.string().min(1)).min(1),
    pageMapping: z.array(PdfPageMappingSchema),
    engine: z.string().min(1),
    engineRuntime: PdfEngineRuntimeSchema,
    provenance: PdfOperationProvenanceSchema,
    warnings: z.array(PdfWarningSchema).default([]),
  })
  .strict();
export type PdfTransformResult = z.infer<typeof PdfTransformResultSchema>;

export const PdfCreateResultSchema = z
  .object({
    outputPath: z.string().min(1),
    fileType: z.literal("pdf"),
    pageCount: z.number().int().positive(),
    sourcePaths: z.array(z.string().min(1)).default([]),
    engine: z.string().min(1),
    engineRuntime: PdfEngineRuntimeSchema,
    provenance: PdfOperationProvenanceSchema,
    warnings: z.array(PdfWarningSchema).default([]),
  })
  .strict();
export type PdfCreateResult = z.infer<typeof PdfCreateResultSchema>;

export const PdfManifestOperationKindSchema = z.enum([
  "inspect",
  "extract",
  "validate",
  "render",
  "transform",
  "create",
]);
export type PdfManifestOperationKind = z.infer<typeof PdfManifestOperationKindSchema>;

export const PdfManifestOperationResultSchema = z.union([
  PdfInspectResultSchema,
  PdfExtractResultSchema,
  PdfValidateResultSchema,
  PdfRenderResultSchema,
  PdfTransformResultSchema,
  PdfCreateResultSchema,
]);
export type PdfManifestOperationResult = z.infer<typeof PdfManifestOperationResultSchema>;

export const PdfPacketManifestOperationSchema = z
  .object({
    operationId: z.string().min(1),
    kind: PdfManifestOperationKindSchema,
    result: PdfManifestOperationResultSchema,
  })
  .strict();
export type PdfPacketManifestOperation = z.infer<typeof PdfPacketManifestOperationSchema>;

export const PdfPacketManifestSummarySchema = z
  .object({
    operationCount: z.number().int().nonnegative(),
    validationCount: z.number().int().nonnegative(),
    failedValidationCount: z.number().int().nonnegative(),
    warningCount: z.number().int().nonnegative(),
  })
  .strict();
export type PdfPacketManifestSummary = z.infer<typeof PdfPacketManifestSummarySchema>;

export const PdfPacketManifestSchema = z
  .object({
    manifestVersion: z.literal(1),
    packetId: z.string().min(1),
    outputPath: z.string().min(1),
    title: z.string().min(1).optional(),
    sourcePaths: z.array(z.string().min(1)),
    artifactPaths: z.array(z.string().min(1)),
    operations: z.array(PdfPacketManifestOperationSchema),
    validations: z.array(PdfValidateResultSchema),
    warnings: z.array(PdfWarningSchema),
    summary: PdfPacketManifestSummarySchema,
    provenance: PdfOperationProvenanceSchema,
  })
  .strict();
export type PdfPacketManifest = z.infer<typeof PdfPacketManifestSchema>;

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
  credential: ModelRuntimeCredentialSchema.optional(),
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
      "Extract PDF, Word, Excel, and PowerPoint content",
      "Check PDF engine readiness; inspect, render, validate, transform, create, and manifest PDFs",
      "List directories",
      "Search content",
      "Search and fetch public web pages",
      "Inspect public web pages with managed browser",
      "Manage task checklist",
    ],
    allowedTools: [
      "workspace_read",
      "workspace_extract",
      "pdf_capabilities",
      "pdf_inspect",
      "pdf_extract",
      "pdf_validate",
      "pdf_render",
      "pdf_transform",
      "pdf_create",
      "pdf_manifest",
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
      "Extract PDF, Word, Excel, and PowerPoint content",
      "Check PDF engine readiness; inspect, render, validate, transform, create, and manifest PDFs",
      "List directories",
      "Search content",
      "Search and fetch public web pages",
      "Inspect public web pages with managed browser",
      "Write files",
      "Edit files",
      "Manage task checklist",
      "Run declared skill Python helpers",
    ],
    allowedTools: [
      "workspace_read",
      "workspace_extract",
      "pdf_capabilities",
      "pdf_inspect",
      "pdf_extract",
      "pdf_validate",
      "pdf_render",
      "pdf_transform",
      "pdf_create",
      "pdf_manifest",
      "workspace_list",
      "workspace_search",
      "shell",
      "browser",
      "workspace_write",
      "workspace_edit",
      "todo",
      "skill_list",
      "skill_load",
      "skill_run_python",
    ],
  },
  elevated_with_approval: {
    label: "Elevated with approval",
    approvalMode: "ask",
    summary:
      "Can edit the workspace, research the public web, and maintain the task checklist, but should ask before taking mutating actions.",
    capabilities: [
      "Read files",
      "Extract PDF, Word, Excel, and PowerPoint content",
      "Check PDF engine readiness; inspect, render, validate, transform, create, and manifest PDFs",
      "List directories",
      "Search content",
      "Search and fetch public web pages",
      "Inspect public web pages with managed browser",
      "Write files",
      "Edit files",
      "Manage task checklist",
      "Run declared skill Python helpers",
    ],
    allowedTools: [
      "workspace_read",
      "workspace_extract",
      "pdf_capabilities",
      "pdf_inspect",
      "pdf_extract",
      "pdf_validate",
      "pdf_render",
      "pdf_transform",
      "pdf_create",
      "pdf_manifest",
      "workspace_list",
      "workspace_search",
      "shell",
      "browser",
      "workspace_write",
      "workspace_edit",
      "todo",
      "skill_list",
      "skill_load",
      "skill_run_python",
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
