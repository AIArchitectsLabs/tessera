# Task Model Settings And Agent Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make task runs use saved model settings and keychain credentials, while adding the contract and resolver foundation for default and overrideable Agent Profiles.

**Architecture:** Keep global model settings and credentials desktop-owned in Tauri. Add shared Agent Profile and task execution config contracts, add a core resolver that chooses global model settings or agent override, and have Tauri task commands attach the resolved provider/credential payload before forwarding task creation/turn requests to the sidecar. The sidecar remains keychain-blind and only receives runtime credentials needed for the current run.

**Tech Stack:** Tauri 2 Rust commands, Bun sidecar, React/Vite UI, TypeScript strict mode, Zod contracts, Bun tests, Rust unit tests.

---

## File Structure

- `packages/contracts/src/index.ts`: add Agent Profile, model selection, resolved task execution config, and optional `agentId`/execution config fields on task requests.
- `packages/contracts/src/agent-profile.test.ts`: validate Agent Profile and execution config shapes, including credential rejection inside profiles.
- `packages/core/src/task-model-resolution.ts`: pure resolver for default agent/global settings/agent override decisions.
- `packages/core/src/task-model-resolution.test.ts`: prove resolver behavior without Tauri or sidecar.
- `packages/core/src/pi-session.ts`: accept optional agent instructions/soul/tools/skills in the Pi task turn options.
- `apps/sidecar/src/task-runner.ts`: read resolved provider/credential/agent from task requests instead of relying on env fallback.
- `apps/sidecar/src/task-store.ts`: persist `agentId` on task summaries/details; keep execution credential out of persistence.
- `apps/sidecar/src/server.ts`: pass resolved execution config from task create/turn requests into `runTaskTurn`.
- `apps/desktop/src-tauri/src/model_settings.rs`: add helper to resolve selected provider config plus keychain credential.
- `apps/desktop/src-tauri/src/lib.rs`: enrich `task_create` and `task_create_turn` requests with resolved execution config before posting to sidecar.
- `apps/desktop/ui/src/App.tsx`: pass optional `agentId` once UI is ready; for this slice it may omit `agentId` and rely on `"default"`.

---

### Task 1: Shared Contracts For Agent Profiles And Task Execution Config

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/agent-profile.test.ts`

- [ ] **Step 1: Add failing contract tests**

Create `packages/contracts/src/agent-profile.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  AgentProfileSchema,
  TaskCreateRequestSchema,
  TaskCreateTurnRequestSchema,
  TaskExecutionConfigSchema,
} from "./index.js";

describe("agent profile contracts", () => {
  test("accepts default model mode", () => {
    const parsed = AgentProfileSchema.parse({
      id: "default",
      name: "Tessera",
      model: { mode: "default" },
      skills: [],
      tools: ["workspace_read"],
      createdAt: "2026-05-02T00:00:00.000Z",
      updatedAt: "2026-05-02T00:00:00.000Z",
    });

    expect(parsed.model.mode).toBe("default");
  });

  test("accepts override model mode", () => {
    const parsed = AgentProfileSchema.parse({
      id: "writer",
      name: "Writer",
      model: {
        mode: "override",
        provider: { provider: "anthropic", model: "claude-sonnet-4-6" },
      },
      skills: [],
      tools: ["workspace_read", "workspace_write"],
      createdAt: "2026-05-02T00:00:00.000Z",
      updatedAt: "2026-05-02T00:00:00.000Z",
    });

    expect(parsed.model.mode).toBe("override");
  });

  test("rejects credentials embedded in agent profiles", () => {
    const parsed = AgentProfileSchema.safeParse({
      id: "bad",
      name: "Bad",
      model: {
        mode: "override",
        provider: { provider: "openai", model: "gpt-5.4" },
      },
      credential: { apiKey: "sk-secret" },
      skills: [],
      tools: [],
      createdAt: "2026-05-02T00:00:00.000Z",
      updatedAt: "2026-05-02T00:00:00.000Z",
    });

    expect(parsed.success).toBe(false);
  });

  test("task requests accept optional agent id and execution config", () => {
    const execution = {
      agent: {
        id: "default",
        name: "Tessera",
        model: { mode: "default" },
        skills: [],
        tools: ["workspace_read"],
        createdAt: "2026-05-02T00:00:00.000Z",
        updatedAt: "2026-05-02T00:00:00.000Z",
      },
      provider: { provider: "openai", model: "gpt-5.4" },
      credential: { apiKey: "sk-runtime" },
    };

    expect(TaskExecutionConfigSchema.parse(execution).provider.provider).toBe("openai");
    expect(
      TaskCreateRequestSchema.parse({
        workspaceRoot: "/workspace/acme",
        initialInstruction: "Draft",
        agentId: "default",
        execution,
      }).agentId
    ).toBe("default");
    expect(
      TaskCreateTurnRequestSchema.parse({
        content: "Continue",
        agentId: "default",
        execution,
      }).agentId
    ).toBe("default");
  });
});
```

Run:

```bash
bun test packages/contracts/src/agent-profile.test.ts
```

Expected: FAIL because the new schemas do not exist.

- [ ] **Step 2: Add schemas and types**

Modify `packages/contracts/src/index.ts` near the model settings schemas:

```ts
export const AgentModelSelectionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("default") }).strict(),
  z.object({ mode: z.literal("override"), provider: AgentProviderConfigSchema }).strict(),
]);
export type AgentModelSelection = z.infer<typeof AgentModelSelectionSchema>;

export const AgentProfileSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    model: AgentModelSelectionSchema,
    instructions: z.string().optional(),
    soul: z.string().optional(),
    skills: z.array(z.string().min(1)).default([]),
    tools: z.array(z.string().min(1)).default([]),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

export const TaskExecutionConfigSchema = z.object({
  agent: AgentProfileSchema,
  provider: AgentProviderConfigSchema,
  credential: z.object({ apiKey: z.string().min(1) }).optional(),
});
export type TaskExecutionConfig = z.infer<typeof TaskExecutionConfigSchema>;
```

Modify task request schemas:

```ts
export const TaskCreateRequestSchema = z.object({
  workspaceRoot: z.string().min(1),
  initialInstruction: z.string().min(1),
  description: z.string().optional(),
  agentId: z.string().min(1).default("default"),
  agentLabel: z.string().min(1).default("Tessera"),
  execution: TaskExecutionConfigSchema.optional(),
});

export const TaskCreateTurnRequestSchema = z.object({
  content: z.string().min(1),
  agentId: z.string().min(1).default("default"),
  execution: TaskExecutionConfigSchema.optional(),
});
```

- [ ] **Step 3: Verify contracts**

Run:

```bash
bun test packages/contracts/src/agent-profile.test.ts
bun run --filter @tessera/contracts typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit contracts**

```bash
git add packages/contracts/src/index.ts packages/contracts/src/agent-profile.test.ts
git commit -m "Define agent profile task execution contracts" -m "Agent profiles describe task executor behavior and optional model override, while runtime credentials remain outside the profile and are carried only in task execution config.\n\nConstraint: AgentProfileSchema is strict so secret fields cannot be persisted accidentally\nConfidence: high\nScope-risk: narrow\nTested: bun test packages/contracts/src/agent-profile.test.ts\nTested: bun run --filter @tessera/contracts typecheck"
```

---

### Task 2: Core Resolver For Agent And Model Selection

**Files:**
- Create: `packages/core/src/task-model-resolution.ts`
- Create: `packages/core/src/task-model-resolution.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write resolver tests**

Create `packages/core/src/task-model-resolution.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { AgentProfile, ModelSettingsRead } from "@tessera/contracts";
import { DEFAULT_AGENT_PROFILE, resolveTaskExecutionConfig } from "./task-model-resolution.js";

const now = "2026-05-02T00:00:00.000Z";

const settings: ModelSettingsRead = {
  selectedProvider: "openai",
  providers: {
    openai: { provider: "openai", model: "gpt-5.4", hasCredential: true },
    anthropic: { provider: "anthropic", model: "claude-sonnet-4-6", hasCredential: false },
    openrouter: { provider: "openrouter", model: "openai/gpt-5.4", hasCredential: false },
    local: {
      provider: "local",
      model: "llama3.2",
      baseUrl: "http://127.0.0.1:11434/v1",
      hasCredential: false,
    },
  },
};

describe("resolveTaskExecutionConfig", () => {
  test("default agent uses global selected provider", () => {
    const result = resolveTaskExecutionConfig({
      agent: DEFAULT_AGENT_PROFILE,
      credential: "sk-openai",
      modelSettings: settings,
    });

    expect(result.provider).toEqual({
      provider: "openai",
      model: "gpt-5.4",
      apiKeyEnv: "OPENAI_API_KEY",
    });
    expect(result.credential?.apiKey).toBe("sk-openai");
    expect("credential" in result.agent).toBe(false);
  });

  test("agent override uses override provider", () => {
    const agent: AgentProfile = {
      id: "writer",
      name: "Writer",
      model: {
        mode: "override",
        provider: { provider: "anthropic", model: "claude-sonnet-4-6" },
      },
      skills: [],
      tools: [],
      createdAt: now,
      updatedAt: now,
    };

    const result = resolveTaskExecutionConfig({
      agent,
      credential: "sk-anthropic",
      modelSettings: settings,
    });

    expect(result.provider.provider).toBe("anthropic");
    expect(result.credential?.apiKey).toBe("sk-anthropic");
  });

  test("cloud provider without credential fails before Pi session creation", () => {
    expect(() =>
      resolveTaskExecutionConfig({
        agent: DEFAULT_AGENT_PROFILE,
        modelSettings: settings,
      })
    ).toThrow("openai is not configured. Add an API key in Settings > Model.");
  });

  test("local provider without credential succeeds", () => {
    const result = resolveTaskExecutionConfig({
      agent: DEFAULT_AGENT_PROFILE,
      modelSettings: { ...settings, selectedProvider: "local" },
    });

    expect(result.provider).toEqual({
      provider: "local",
      model: "llama3.2",
      baseUrl: "http://127.0.0.1:11434/v1",
    });
    expect(result.credential).toBeUndefined();
  });
});
```

Run:

```bash
bun test packages/core/src/task-model-resolution.test.ts
```

Expected: FAIL because resolver does not exist.

- [ ] **Step 2: Implement resolver**

Create `packages/core/src/task-model-resolution.ts`:

```ts
import type {
  AgentProfile,
  AgentProviderConfig,
  ModelProvider,
  ModelProviderSettings,
  ModelSettingsRead,
  TaskExecutionConfig,
} from "@tessera/contracts";

const now = "1970-01-01T00:00:00.000Z";

export const DEFAULT_AGENT_PROFILE: AgentProfile = {
  id: "default",
  name: "Tessera",
  model: { mode: "default" },
  instructions: "You are Tessera's workspace agent. Work inside the selected workspace.",
  soul: "",
  skills: [],
  tools: [
    "workspace_read",
    "workspace_list",
    "workspace_search",
    "workspace_write",
    "workspace_edit",
  ],
  createdAt: now,
  updatedAt: now,
};

function apiKeyEnvFor(provider: Exclude<ModelProvider, "local">): string {
  if (provider === "anthropic") return "ANTHROPIC_API_KEY";
  if (provider === "openrouter") return "OPENROUTER_API_KEY";
  return "OPENAI_API_KEY";
}

function providerSettingsToConfig(settings: ModelProviderSettings): AgentProviderConfig {
  if (settings.provider === "local") {
    return {
      provider: "local",
      model: settings.model,
      baseUrl: settings.baseUrl,
    };
  }

  return {
    provider: settings.provider,
    model: settings.model,
    apiKeyEnv: apiKeyEnvFor(settings.provider),
  };
}

function requiresCredential(provider: AgentProviderConfig): boolean {
  return provider.provider === "openai" || provider.provider === "anthropic" || provider.provider === "openrouter";
}

export function resolveTaskExecutionConfig(options: {
  agent?: AgentProfile;
  credential?: string;
  modelSettings: ModelSettingsRead;
}): TaskExecutionConfig {
  const agent = options.agent ?? DEFAULT_AGENT_PROFILE;
  const provider =
    agent.model.mode === "override"
      ? agent.model.provider
      : providerSettingsToConfig(options.modelSettings.providers[options.modelSettings.selectedProvider]);

  if (requiresCredential(provider) && !options.credential) {
    throw new Error(`${provider.provider} is not configured. Add an API key in Settings > Model.`);
  }

  return {
    agent,
    provider,
    ...(options.credential ? { credential: { apiKey: options.credential } } : {}),
  };
}
```

- [ ] **Step 3: Export resolver**

Modify `packages/core/src/index.ts`:

```ts
export {
  DEFAULT_AGENT_PROFILE,
  resolveTaskExecutionConfig,
} from "./task-model-resolution.js";
```

- [ ] **Step 4: Verify resolver**

Run:

```bash
bun test packages/core/src/task-model-resolution.test.ts
bun run --filter @tessera/core typecheck
```

Expected: PASS.

Run formatting before committing:

```bash
bunx biome check --write packages/core/src/task-model-resolution.ts packages/core/src/task-model-resolution.test.ts
```

- [ ] **Step 5: Commit resolver**

```bash
git add packages/core/src/task-model-resolution.ts packages/core/src/task-model-resolution.test.ts packages/core/src/index.ts
git commit -m "Resolve task execution model config" -m "Task runs now have a pure resolver that chooses between global model settings and an optional agent model override before any Pi session is created.\n\nConstraint: Credentials are returned only in TaskExecutionConfig, never embedded in AgentProfile\nConfidence: high\nScope-risk: narrow\nTested: bun test packages/core/src/task-model-resolution.test.ts\nTested: bun run --filter @tessera/core typecheck"
```

---

### Task 3: Sidecar Uses Resolved Execution Config

**Files:**
- Modify: `apps/sidecar/src/task-runner.ts`
- Modify: `apps/sidecar/src/task-runner.test.ts`
- Modify: `apps/sidecar/src/server.ts`

- [ ] **Step 1: Add sidecar task runner tests**

Modify `apps/sidecar/src/task-runner.test.ts` to add this test:

```ts
test("passes resolved execution provider, credential, and agent to Pi runner", async () => {
  const store = makeStore();
  const task = store.createTask({
    workspaceRoot: "/workspace/acme",
    initialInstruction: "Draft a launch announcement",
  });
  const userTurn = store.createUserTurn(task.id, "Run the task");
  const agentTurn = store.createQueuedAgentTurn(task.id);
  const seen: unknown[] = [];

  await runTaskTurn({
    store,
    taskId: task.id,
    userTurnId: userTurn.id,
    agentTurnId: agentTurn.id,
    execution: {
      agent: {
        id: "default",
        name: "Tessera",
        model: { mode: "default" },
        skills: [],
        tools: ["workspace_read"],
        createdAt: "2026-05-02T00:00:00.000Z",
        updatedAt: "2026-05-02T00:00:00.000Z",
      },
      provider: { provider: "anthropic", model: "claude-sonnet-4-6" },
      credential: { apiKey: "sk-runtime" },
    },
    piRunner: async (options) => {
      seen.push(options);
      return { text: "done" };
    },
    publish() {},
    delayMs: 0,
  });

  expect(seen).toEqual([
    expect.objectContaining({
      credential: "sk-runtime",
      provider: { provider: "anthropic", model: "claude-sonnet-4-6" },
      prompt: "Run the task",
      workspaceRoot: "/workspace/acme",
    }),
  ]);
});
```

Run:

```bash
bun test apps/sidecar/src/task-runner.test.ts
```

Expected: FAIL because `execution` is not accepted by `RunTaskTurnOptions`.

- [ ] **Step 2: Update task runner options**

Modify `apps/sidecar/src/task-runner.ts`:

```ts
import type { AgentProviderConfig, TaskExecutionConfig } from "@tessera/contracts";
```

Add to `RunTaskTurnOptions`:

```ts
execution?: TaskExecutionConfig;
```

Replace provider/credential resolution:

```ts
const provider = opts.execution?.provider ?? opts.provider ?? DEFAULT_PROVIDER;
const credential = opts.execution?.credential?.apiKey ?? opts.credential;
```

Do not fall back to `process.env` in the task runner after this change. Missing credentials should be handled before the task reaches Pi execution.

- [ ] **Step 3: Pass execution config from server**

Modify `apps/sidecar/src/server.ts` in `handleTaskCreate`:

```ts
void runTaskTurn({
  store: taskStore,
  taskId,
  userTurnId,
  agentTurnId,
  ...(parsed.data.execution ? { execution: parsed.data.execution } : {}),
  publish: (e) => taskEventBus.publish(taskId, e),
});
```

Modify `handleTaskCreateTurn` with the execution payload:

```ts
void runTaskTurn({
  store: taskStore,
  taskId,
  userTurnId,
  agentTurnId,
  ...(parsed.data.execution ? { execution: parsed.data.execution } : {}),
  publish: (e) => taskEventBus.publish(taskId, e),
});
```

- [ ] **Step 4: Verify sidecar**

Run:

```bash
bun test apps/sidecar/src/task-runner.test.ts
bun run --filter @tessera/sidecar typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit sidecar runtime changes**

```bash
git add apps/sidecar/src/task-runner.ts apps/sidecar/src/task-runner.test.ts apps/sidecar/src/server.ts
git commit -m "Run tasks from resolved execution config" -m "The sidecar now consumes provider and runtime credential from the task execution payload instead of trying to infer cloud credentials from environment variables.\n\nConstraint: Sidecar remains keychain-blind\nRejected: Keep env fallback in task runner | desktop-saved settings should be authoritative for app task runs\nConfidence: high\nScope-risk: moderate\nTested: bun test apps/sidecar/src/task-runner.test.ts\nTested: bun run --filter @tessera/sidecar typecheck"
```

---

### Task 4: Tauri Resolves Saved Model Settings For Task Requests

**Files:**
- Modify: `apps/desktop/src-tauri/src/model_settings.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`

- [ ] **Step 1: Add Rust tests for selected provider resolution**

In `apps/desktop/src-tauri/src/model_settings.rs` tests, add:

```rust
#[test]
fn selected_provider_config_returns_selected_provider() {
    let settings = default_settings_file();
    let provider = selected_provider_config(&settings).expect("selected provider");

    assert_eq!(provider.provider, ModelProvider::Openai);
}
```

Run:

```bash
cargo test -p tessera --lib model_settings::selected_provider_config_returns_selected_provider
```

Expected: FAIL because `selected_provider_config` does not exist.

- [ ] **Step 2: Add selected provider helper**

In `apps/desktop/src-tauri/src/model_settings.rs`, add:

```rust
pub fn selected_provider_config(settings: &SettingsFile) -> Result<ProviderConfig> {
    settings
        .providers
        .get(&settings.selected_provider)
        .cloned()
        .map(|config| normalize_provider_config(config))
        .transpose()?
        .ok_or_else(|| anyhow::anyhow!("Selected model provider is missing from settings"))
}
```

- [ ] **Step 3: Extract provider JSON helper**

In `apps/desktop/src-tauri/src/lib.rs`, extract the provider JSON construction currently embedded in `model_connection_test_body` into a reusable helper:

```rust
fn provider_config_json(provider: &model_settings::ProviderConfig) -> serde_json::Value {
    match provider.provider {
        model_settings::ModelProvider::Openai => serde_json::json!({
            "provider": "openai",
            "model": provider.model,
            "apiKeyEnv": "OPENAI_API_KEY"
        }),
        model_settings::ModelProvider::Anthropic => serde_json::json!({
            "provider": "anthropic",
            "model": provider.model,
            "apiKeyEnv": "ANTHROPIC_API_KEY"
        }),
        model_settings::ModelProvider::Openrouter => serde_json::json!({
            "provider": "openrouter",
            "model": provider.model,
            "apiKeyEnv": "OPENROUTER_API_KEY"
        }),
        model_settings::ModelProvider::Local => serde_json::json!({
            "provider": "local",
            "model": provider.model,
            "baseUrl": provider.base_url
                .clone()
                .unwrap_or_else(|| "http://127.0.0.1:11434/v1".to_string())
        }),
    }
}
```

Then update `model_connection_test_body` to use:

```rust
let provider_value = provider_config_json(provider);
```

- [ ] **Step 4: Add request enrichment helper**

In `apps/desktop/src-tauri/src/lib.rs`, add:

```rust
fn default_agent_profile_json() -> serde_json::Value {
    serde_json::json!({
        "id": "default",
        "name": "Tessera",
        "model": { "mode": "default" },
        "instructions": "You are Tessera's workspace agent. Work inside the selected workspace.",
        "soul": "",
        "skills": [],
        "tools": [
            "workspace_read",
            "workspace_list",
            "workspace_search",
            "workspace_write",
            "workspace_edit"
        ],
        "createdAt": "1970-01-01T00:00:00.000Z",
        "updatedAt": "1970-01-01T00:00:00.000Z"
    })
}

fn attach_default_task_execution(
    app: &AppHandle,
    mut request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if request.get("execution").is_some() {
        return Ok(request);
    }

    let settings_path = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?
        .join(model_settings::SETTINGS_FILE);
    let settings =
        model_settings::load_settings_file(&settings_path).map_err(|error| error.to_string())?;
    let provider =
        model_settings::selected_provider_config(&settings).map_err(|error| error.to_string())?;
    let credential =
        model_settings::get_credential(provider.provider).map_err(|error| error.to_string())?;

    if credential.is_none() && provider.provider != model_settings::ModelProvider::Local {
        return Err(format!(
            "{} is not configured. Add an API key in Settings > Model.",
            provider.provider.label()
        ));
    }

    let mut execution = serde_json::json!({
        "agent": default_agent_profile_json(),
        "provider": provider_config_json(&provider)
    });

    if let Some(api_key) = credential {
        execution["credential"] = serde_json::json!({ "apiKey": api_key });
    }

    request["execution"] = execution;
    Ok(request)
}
```

Add `ModelProvider::label()` in `model_settings.rs`:

```rust
pub fn label(self) -> &'static str {
    match self {
        Self::Openai => "openai",
        Self::Anthropic => "anthropic",
        Self::Openrouter => "openrouter",
        Self::Local => "local",
    }
}
```

- [ ] **Step 5: Enrich task commands**

Change `task_create` signature in `apps/desktop/src-tauri/src/lib.rs`:

```rust
async fn task_create(
    app: AppHandle,
    state: State<'_, SidecarHandle>,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let request = attach_default_task_execution(&app, request)?;
    let json = state
        .post("/tasks", &request.to_string())
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}
```

Change `task_create_turn` the same way:

```rust
async fn task_create_turn(
    app: AppHandle,
    state: State<'_, SidecarHandle>,
    task_id: String,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let request = attach_default_task_execution(&app, request)?;
    let path = format!("/tasks/{}/turns", percent_encode(&task_id));
    let json = state
        .post(&path, &request.to_string())
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}
```

- [ ] **Step 6: Verify Rust**

Run:

```bash
cargo test -p tessera --lib model_settings
bun run check
```

Expected: PASS.

- [ ] **Step 7: Commit Tauri bridge**

```bash
git add apps/desktop/src-tauri/src/model_settings.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "Inject saved model settings into task runs" -m "Tauri now enriches task creation and continuation requests with the selected provider config and runtime keychain credential before forwarding them to the sidecar.\n\nConstraint: Sidecar must not read keychain directly\nConstraint: Local providers do not require credentials\nRejected: Store credentials in task records | task persistence must remain non-secret\nConfidence: medium\nScope-risk: moderate\nTested: cargo test model_settings\nTested: bun run check"
```

---

### Task 5: Persist Agent Identity Without Persisting Secrets

**Files:**
- Modify: `apps/sidecar/src/task-store.ts`
- Modify: `apps/sidecar/src/task-store.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/task.test.ts`

- [ ] **Step 1: Add tests for agent id**

In `packages/contracts/src/task.test.ts`, extend task summary/detail tests to assert `agentId: "default"` is accepted.

In `apps/sidecar/src/task-store.test.ts`, update task creation expectations:

```ts
const task = store.createTask({
  workspaceRoot: "/workspace/acme",
  initialInstruction: "Draft",
  agentId: "writer",
});

expect(task.agentId).toBe("writer");
expect(task.turns[0]?.content).toBe("Draft");
```

Run:

```bash
bun test packages/contracts/src/task.test.ts apps/sidecar/src/task-store.test.ts
```

Expected: FAIL because agent id is not persisted or exposed.

- [ ] **Step 2: Add contract field**

In `TaskSummarySchema`, add:

```ts
agentId: z.string().min(1).default("default"),
```

Keep `agentLabel` for display compatibility.

- [ ] **Step 3: Add sidecar storage field**

In `apps/sidecar/src/task-store.ts`:

- add `agent_id TEXT NOT NULL DEFAULT 'default'` to table creation.
- include `agent_id` in `TaskRow`.
- include `agentId: row.agent_id` in `rowToSummary`.
- insert `parsed.agentId ?? "default"` in `createTask`.

Because SQLite does not add new columns to existing tables from `CREATE TABLE IF NOT EXISTS`, add a small migration:

```ts
const taskColumns = db.query<{ name: string }, []>("PRAGMA table_info(tasks)").all();
if (!taskColumns.some((column) => column.name === "agent_id")) {
  db.exec("ALTER TABLE tasks ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'default'");
}
```

- [ ] **Step 4: Verify storage**

Run:

```bash
bun test packages/contracts/src/task.test.ts apps/sidecar/src/task-store.test.ts
bun run --filter @tessera/contracts typecheck
bun run --filter @tessera/sidecar typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit agent identity persistence**

```bash
git add packages/contracts/src/index.ts packages/contracts/src/task.test.ts apps/sidecar/src/task-store.ts apps/sidecar/src/task-store.test.ts
git commit -m "Persist task agent identity" -m "Tasks now record the selected agent id for history and future reruns while keeping resolved runtime credentials out of SQLite.\n\nConstraint: Task records may store agent identity but never API keys\nConfidence: high\nScope-risk: moderate\nTested: bun test packages/contracts/src/task.test.ts apps/sidecar/src/task-store.test.ts\nTested: bun run --filter @tessera/contracts typecheck\nTested: bun run --filter @tessera/sidecar typecheck"
```

---

### Task 6: Pi Session Receives Agent Instructions And Tool Selection

**Files:**
- Modify: `packages/core/src/pi-session.ts`
- Modify: `packages/core/src/pi-session.test.ts`

- [ ] **Step 1: Add adapter test for agent instructions and tools**

In `packages/core/src/pi-session.test.ts`, add:

```ts
test("passes agent instructions and selected workspace tools into session setup", async () => {
  const workspaceRoot = await makeWorkspace();
  const seen: { customToolNames?: string[]; prompt?: string } = {};
  const factory: PiSessionFactory = async (options) => {
    seen.customToolNames = options.customTools.map((tool) => tool.name).sort();
    return new FakeSession([]);
  };

  await runPiTaskTurn({
    credential: "sk-test",
    factory,
    prompt: "Draft",
    provider: { provider: "openai", model: "gpt-5.4", apiKeyEnv: "OPENAI_API_KEY" },
    workspaceRoot,
    agent: {
      id: "writer",
      name: "Writer",
      model: { mode: "default" },
      instructions: "Write crisp updates.",
      soul: "Calm and direct.",
      skills: [],
      tools: ["workspace_read", "workspace_write"],
      createdAt: "2026-05-02T00:00:00.000Z",
      updatedAt: "2026-05-02T00:00:00.000Z",
    },
  });

  expect(seen.customToolNames).toEqual(["workspace_read", "workspace_write"]);
});
```

Expected: FAIL because `runPiTaskTurn` does not accept `agent` or filter tools.

- [ ] **Step 2: Extend Pi session options**

In `packages/core/src/pi-session.ts`, add `agent?: AgentProfile` to `RunPiTaskTurnOptions`.

Filter tools:

```ts
const allTools = createWorkspaceToolDefinitions(guard);
const allowedTools = new Set(options.agent?.tools ?? allTools.map((tool) => tool.name));
const customTools = allTools.filter((tool) => allowedTools.has(tool.name));
```

Add prompt prefixing if the Pi SDK adapter does not expose a direct system prompt hook:

```ts
function withAgentInstructions(prompt: string, agent?: AgentProfile): string {
  if (!agent) return prompt;
  const sections = [
    agent.instructions ? `Agent instructions:\n${agent.instructions}` : "",
    agent.soul ? `Agent soul:\n${agent.soul}` : "",
    `User task:\n${prompt}`,
  ].filter(Boolean);
  return sections.join("\n\n");
}
```

Use `session.prompt(withAgentInstructions(options.prompt, options.agent))`.

- [ ] **Step 3: Verify Pi adapter**

Run:

```bash
bun test packages/core/src/pi-session.test.ts
bun run --filter @tessera/core typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit adapter update**

```bash
git add packages/core/src/pi-session.ts packages/core/src/pi-session.test.ts
git commit -m "Apply agent profile context to Pi sessions" -m "Pi task turns now honor the selected agent profile by filtering workspace tools and prepending agent instructions and soul to the task prompt.\n\nConstraint: Tool filtering can only reduce the workspace-safe tool set\nRejected: Directly register arbitrary agent tools | tool-group support needs a separate policy layer\nConfidence: medium\nScope-risk: narrow\nTested: bun test packages/core/src/pi-session.test.ts\nTested: bun run --filter @tessera/core typecheck"
```

---

### Task 7: Desktop UI Keeps Default Agent Path Stable

**Files:**
- Modify: `apps/desktop/ui/src/App.tsx`

- [ ] **Step 1: Include default agent id in task requests**

In `apps/desktop/ui/src/App.tsx`, update task creation:

```ts
const request: TaskCreateRequest = {
  workspaceRoot,
  initialInstruction,
  agentId: "default",
  agentLabel: "Tessera",
};
```

Update task continuation:

```ts
const request: TaskCreateTurnRequest = { content, agentId: "default" };
```

- [ ] **Step 2: Verify UI typecheck**

Run:

```bash
bun run --filter @tessera/ui typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit UI request field**

```bash
git add apps/desktop/ui/src/App.tsx
git commit -m "Send default agent id for task requests" -m "The desktop UI now makes the default task agent explicit while custom-agent selection remains out of this slice.\n\nConstraint: This slice does not add custom-agent management UI\nConfidence: high\nScope-risk: narrow\nTested: bun run --filter @tessera/ui typecheck"
```

---

### Task 8: Full Verification

**Files:**
- All changed files

- [ ] **Step 1: Run full check**

```bash
bun run check
```

Expected: PASS.

- [ ] **Step 2: Run full tests**

```bash
bun run --filter '*' test
```

Expected: PASS. The sidecar task-event-bus test may intentionally log `boom` while passing.

- [ ] **Step 3: Run Rust tests**

```bash
cargo test model_settings
```

Expected: PASS.

- [ ] **Step 4: Confirm clean working tree**

```bash
git status --short
```

Expected: clean working tree after all task commits.

---

## Self-Review

Spec coverage:

- Saved global model settings for task runs: Task 4.
- Agent Profile contracts with optional model override: Task 1.
- Credential boundary and no profile-owned secrets: Tasks 1, 2, 4, and 5.
- Default agent path: Tasks 2, 4, and 7.
- Resolver behavior: Task 2.
- Sidecar receives resolved config without keychain access: Tasks 3 and 4.
- Pi adapter receives agent instructions/tools: Task 6.

Known exclusions:

- Full custom Agent Profile management UI is intentionally deferred to the Phase 2 spec slice.
- Multi-agent execution, sub-agents, background planning, and advanced OpenClaw parity are intentionally excluded.
