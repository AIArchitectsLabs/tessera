# Task Model Settings And Agent Profiles Design

## Summary

Task execution should resolve its model and credential from saved desktop model
settings by default. On top of that, Tessera should introduce Agent Profiles as
the user-facing way to control task behavior: instructions, persona, skills,
tools, and an optional model override.

These are two separate layers:

- Global Model Settings answer: "Which provider/model/credential should Tessera
  use by default?"
- Agent Profiles answer: "What kind of agent should execute this task?"

Agent Profiles may override the model, but they must never own raw credentials.
Credentials stay provider-level in the OS keychain.

## Goals

- Make cloud-backed task runs work from saved model settings without requiring
  environment variables.
- Preserve the existing keychain-backed model settings implementation.
- Add a clear model resolution order for task execution.
- Define Agent Profiles as durable task executors with optional model override.
- Keep credentials provider-level, not agent-level.
- Keep the default path simple: a built-in Tessera agent uses global model
  settings.

## Non-Goals

- Do not build a multi-agent task execution engine in this slice.
- Do not store API keys in agent profile records.
- Do not replace global model settings with agent-specific settings.
- Do not design a full agent marketplace, sharing system, or extension registry.
- Do not add background planning modes or sub-agent orchestration in this slice.

## Current State

Tessera already has global model settings:

- `packages/contracts` defines provider/model settings and credential payloads.
- `apps/desktop/src-tauri/src/model_settings.rs` stores provider config in a
  settings JSON file and secrets in the OS keychain.
- The sidecar task runner can accept `provider` and `credential`, but the
  sidecar currently has no automatic bridge from desktop keychain settings into
  task execution.

As a result, a cloud-backed task run can fail unless a credential is passed
explicitly or provided through an environment variable.

## Product Model

### Global Model Settings

Global settings remain the baseline runtime configuration:

```ts
type GlobalModelSettings = {
  selectedProvider: "openai" | "anthropic" | "openrouter" | "local";
  providers: {
    openai: { provider: "openai"; model: string; hasCredential: boolean };
    anthropic: { provider: "anthropic"; model: string; hasCredential: boolean };
    openrouter: { provider: "openrouter"; model: string; hasCredential: boolean };
    local: {
      provider: "local";
      model: string;
      baseUrl: string;
      hasCredential: boolean;
    };
  };
};
```

The UI continues to show redacted credential state. Only the Tauri process may
read the actual provider credential from keychain.

### Agent Profile

An Agent Profile is a reusable task executor configuration:

```ts
type AgentProfile = {
  id: string;
  name: string;
  description?: string;
  model: AgentModelSelection;
  instructions?: string;
  soul?: string;
  skills: string[];
  tools: string[];
  createdAt: string;
  updatedAt: string;
};

type AgentModelSelection =
  | { mode: "default" }
  | { mode: "override"; provider: AgentProviderConfig };
```

`instructions` is the operating contract, similar in spirit to `AGENTS.md`.
`soul` is the optional personality/style layer, similar in spirit to `SOUL.md`.
The first version can store both as text fields; file-backed editing can come
later.

### Built-In Default Agent

Tessera should always provide a built-in default profile:

```ts
{
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
    "workspace_edit"
  ]
}
```

The built-in agent does not need to be persisted. It should appear in task
execution and later UI selection as the fallback when no custom agent is
selected.

## Model Resolution

Task execution resolves model config in this order:

1. Load selected task agent.
2. If the agent has `model.mode === "override"`, use that provider config.
3. Otherwise use global model settings' selected provider config.
4. Fetch the credential for the resolved provider from the OS keychain.
5. If the resolved provider is `local`, credential is optional.
6. If the resolved provider is cloud-backed and no credential exists, fail
   before starting the Pi session.
7. Start the Pi session with the resolved provider config, runtime credential,
   agent instructions, agent soul, enabled skills, and enabled tools.

The failure message should name the provider and point to Settings > Model.

## Credential Boundary

Agent Profiles must not store API keys, OAuth tokens, or secret-bearing config.
They only reference provider/model choices. This keeps key rotation and
credential deletion provider-level.

For cloud providers:

```text
agent model override -> provider id -> keychain account -> runtime credential
```

For local providers:

```text
agent model override -> local base URL -> no credential required by default
```

If OAuth support is added later, OAuth tokens follow the same rule: provider
credential storage, not agent profile storage.

## Data Ownership

Global model settings remain desktop-owned because the keychain lives behind
Tauri commands.

Agent profiles can be sidecar-owned because they are non-secret product data.
The preferred first storage is a sidecar SQLite table or JSON store under
Tessera app data, matching tasks and workflow persistence. Profiles must be
included in shared contracts so the desktop UI and sidecar agree on shape.

The sidecar should receive a resolved task execution config, not direct access
to the keychain:

```ts
type TaskExecutionConfig = {
  agent: AgentProfile;
  provider: AgentProviderConfig;
  credential?: { apiKey: string };
};
```

For the first implementation, Tauri can assemble this config by reading model
settings and keychain credential, then passing it to the sidecar when creating
or continuing a task turn.

## Task API Behavior

Task creation and task continuation should accept an optional `agentId`.

```ts
type TaskCreateRequest = {
  workspaceRoot: string;
  initialInstruction: string;
  agentId?: string;
};

type TaskCreateTurnRequest = {
  content: string;
  agentId?: string;
};
```

If `agentId` is omitted, use `"default"`.

For the immediate credential bridge, the sidecar task start call should also be
able to receive the resolved provider and credential. Longer term, the sidecar
can own profile lookup, while Tauri injects only the resolved credential.

## Pi Session Behavior

The Pi adapter should be extended to accept:

- resolved provider config
- runtime credential
- agent instructions
- agent soul
- enabled tools
- enabled skills

The system prompt should combine:

```text
Tessera base workspace policy
+ agent instructions
+ agent soul
+ enabled skill prompt material
```

Workspace tool policy from the Pi MVP remains unchanged:

- read/list/search only inside selected workspace
- write/edit allowed inside selected workspace
- outside-workspace access denied
- bash disabled in the first MVP

## Agent Profile MVP

The first Agent Profile UI can be small:

- name
- description
- instructions
- soul
- model mode: use global model or override
- model override provider/model fields when override is selected
- tools: fixed default workspace tool set in v1
- skills: empty list in v1, with schema support for later

The first backend can support full shape even if the UI only exposes the simple
fields.

## Error Handling

Missing selected global provider config should fail with a settings error.

Missing keychain credential for a cloud provider should fail before the task
turn is queued or before the Pi session starts. The task should not sit in a
long-running "active" state if the credential is known missing.

Unknown `agentId` should return a validation error rather than silently falling
back to default. Silent fallback would make task behavior hard to explain.

Invalid agent model override should block saving the profile, not fail at task
run time.

## Testing

Required contract tests:

- Agent Profile schema accepts default model mode.
- Agent Profile schema accepts override model mode.
- Agent Profile schema rejects credential fields.
- Task create/turn schemas accept optional `agentId`.

Required resolver tests:

- default agent uses global selected provider.
- agent override uses override provider.
- cloud provider without credential fails before Pi session creation.
- local provider without credential succeeds.
- unknown agent id fails.
- resolved execution config never includes credentials inside the agent object.

Required task runner tests:

- task creation without `agentId` uses default agent.
- task creation with `agentId` uses that profile.
- task run passes resolved provider and runtime credential to Pi adapter.
- missing credential marks task failed with Settings > Model guidance.

## Phasing

### Phase 1: Saved Model Settings For Task Runs

Wire task execution to saved global model settings and keychain credentials.
Create an internal default agent profile shape, but do not build full agent
management UI yet.

### Phase 2: Agent Profiles

Persist custom Agent Profiles and allow tasks to select one. Support optional
model override. Keep skills/tools mostly fixed until the first profile flow is
stable.

### Phase 3: Skills And Tool Groups

Expose skill selection and tool group selection in Agent Profiles. Continue to
enforce workspace policy in the Pi adapter.

### Phase 4: Advanced Agents

Consider background planning modes, sub-agents, and OpenClaw-style parity
features only after single-agent task execution is reliable.
