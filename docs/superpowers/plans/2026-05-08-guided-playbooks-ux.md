# Guided Playbooks UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current Playbooks run-console UI with a guided same-flow business experience: intake, preparing, review, and result.

**Architecture:** Keep the existing workflow runner and Playbooks sidecar/Tauri APIs. Refactor the desktop UI into focused Playbooks helpers: business copy helpers, intake form rendering, guided state panels, and a slim Playbooks shell. The UI should consume manifest metadata and run display records without exposing workflow IDs, tool names, raw JSON, or event logs by default.

**Runtime Constraint:** Current playbook creation is synchronous. The guided Preparing state is a local pending state while `playbook_run_create` is in flight. Do not claim durable live checkpoint progress unless async launch or run subscriptions are added in a later plan.

**Default Catalog Constraint:** Sidecar may keep demo/internal workflows registered for compatibility, but the desktop Playbooks catalog must promote manifest-backed business playbooks by default. Hide workflows without business metadata from the primary catalog unless a later developer/debug toggle is added.

**Agent Assignment Constraint:** If more than one agent profile exists, the intake page must show a compact `Run with` selector. The selected run stores only non-secret `agentId` and `agentLabel`; credentials stay request-scoped. Agent-backed workflow steps must receive the selected profile/runtime in core execution, not just the selected model provider.

**Tech Stack:** React + TypeScript, Tauri `invoke`, `@tessera/contracts`, lucide-react, Tailwind, Bun tests, Biome.

---

## File Structure

- Modify `packages/contracts/src/index.ts`
  Keep rich manifest metadata and run detail contracts. Add only missing display fields if tests prove they are needed.

- Modify `packages/contracts/src/workflow.test.ts`
  Cover restored business playbook metadata and display-ready run shape.

- Modify `packages/core/src/workflow.ts`
  Keep restored business playbook manifests registered through exports. Avoid changing runner semantics unless UI tests expose a missing display field.

- Modify `packages/core/src/index.ts`
  Export restored business playbooks.

- Modify `apps/sidecar/src/server.ts`
  Keep `GET /playbooks`, `GET /playbooks/:id`, run create/list/get/resume. Ensure business playbooks are ordered before demo/internal playbooks.

- Modify `apps/desktop/ui/src/components/PlaybooksView.tsx`
  Replace run-console layout with guided same-flow shell. This file may stay as the container, but most logic should move into smaller helpers.

- Modify `apps/desktop/src-tauri/src/lib.rs`
  Attach default model execution context to playbook run and resume commands for agent-backed playbooks.

- Create `apps/desktop/ui/src/lib/playbooks.ts`
  Business copy, formatting, hidden/system input filtering, default input normalization, output labels, and guided state helpers.

- Create `apps/desktop/ui/src/lib/playbooks.test.ts`
  Unit tests for copy/format/input helpers.

- Create `apps/desktop/ui/src/components/PlaybookIntakeForm.tsx`
  Renders manifest-driven user inputs, compact agent assignment, and emits normalized input plus selected agent id/label.

- Create `apps/desktop/ui/src/components/PlaybookGuidedFlow.tsx`
  Owns Start, Preparing, Review, Result state rendering for the selected playbook/run.

- Create `apps/desktop/ui/src/components/PlaybooksView.test.tsx`
  Integration tests for list selection, intake, start, review, result, missing workspace, and no raw technical detail.

## Repo Test Harness Rules

UI tests in this repo must follow the existing Bun/JSDOM pattern:

- Install JSDOM globals at the top of the file.
- Mock Tauri modules before importing the component under test.
- Import tested components with `await import(...)` after `mock.module(...)`.
- Use `fireEvent` from `@testing-library/react`; `@testing-library/user-event` is not installed.
- Do not use jest-dom matchers such as `toBeDisabled`; assert DOM properties directly.

Use this skeleton for new component tests:

```tsx
/// <reference types="bun" />

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { JSDOM } from "jsdom";
import React from "react";

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
  });
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  globals.window = dom.window as never;
  globals.document = dom.window.document as never;
  globals.navigator = dom.window.navigator as never;
  globals.Node = dom.window.Node as never;
  globals.Element = dom.window.Element as never;
  globals.HTMLElement = dom.window.HTMLElement as never;
  globals.HTMLInputElement = dom.window.HTMLInputElement as never;
  globals.HTMLTextAreaElement = dom.window.HTMLTextAreaElement as never;
  globals.HTMLSelectElement = dom.window.HTMLSelectElement as never;
  globals.SVGElement = dom.window.SVGElement as never;
  globals.Text = dom.window.Text as never;
  globals.Event = dom.window.Event as never;
  globals.KeyboardEvent = dom.window.KeyboardEvent as never;
  globals.MouseEvent = dom.window.MouseEvent as never;
  globals.getComputedStyle = dom.window.getComputedStyle.bind(dom.window) as never;
  globals.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(cb, 0)) as never;
  globals.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as never;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", {
    value: () => undefined,
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", {
    value: () => undefined,
  });
}

installDom();

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  cleanup();
});
```

---

### Task 1: Lock Business Playbook Contracts

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/workflow.test.ts`
- Modify: `packages/core/src/workflow.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `apps/sidecar/src/server.ts`
- Test: `packages/contracts/src/workflow.test.ts`
- Test: `packages/core/src/workflow.test.ts`

- [ ] **Step 1: Write contract assertions for business playbook metadata**

Add this test to `packages/contracts/src/workflow.test.ts`:

```ts
test("accepts business playbook manifest metadata", () => {
  const parsed = WorkflowDefinitionSchema.parse({
    id: "sales.meeting-brief",
    version: 1,
    name: "Sales Meeting Brief",
    description: "Creates a source-aware customer meeting brief.",
    category: "sales",
    businessUseCase: "Prepare for a customer or prospect meeting",
    requiredCapabilities: [],
    optionalCapabilities: ["web", "calendar", "mail", "drive", "contacts"],
    outputs: [
      { kind: "meetingBrief", label: "Meeting brief" },
      { kind: "sourceSummary", label: "Source summary" },
      { kind: "approvalRequest", label: "Workspace prep approval" },
    ],
    phaseOrder: ["Prepare", "Review"],
    start: "draftBrief",
    inputs: {
      company: {
        type: "string",
        required: true,
        label: "Company",
        placeholder: "Acme Corp",
        order: 1,
        group: "Meeting",
        ui: { control: "text" },
      },
      sources: {
        type: "string[]",
        required: true,
        label: "Research sources",
        default: ["web"],
        options: [
          { value: "web", label: "Web" },
          { value: "calendar", label: "Calendar" },
        ],
        ui: { control: "multiselect" },
      },
    },
    steps: [
      {
        id: "draftBrief",
        kind: "agent",
        label: "Draft meeting brief",
        phase: "Prepare",
        prompt: "Draft for {{inputs.company}}",
        workspaceRootInput: "workspaceRoot",
      },
    ],
  });

  expect(parsed.businessUseCase).toBe("Prepare for a customer or prospect meeting");
  expect(parsed.inputs.sources?.type).toBe("string[]");
  expect(parsed.outputs?.map((output) => output.label)).toEqual([
    "Meeting brief",
    "Source summary",
    "Workspace prep approval",
  ]);
});
```

- [ ] **Step 2: Run the contract test and verify it fails only if metadata support is missing**

Run:

```bash
bun test packages/contracts/src/workflow.test.ts
```

Expected before implementation if metadata support is absent: FAIL with schema validation errors for `businessUseCase`, `string[]`, `outputs`, or `ui`.

- [ ] **Step 3: Ensure contract schemas support the metadata**

In `packages/contracts/src/index.ts`, ensure these exports exist exactly:

```ts
export const WorkflowCapabilitySchema = z.enum(["web", "calendar", "mail", "drive", "contacts"]);
export type WorkflowCapability = z.infer<typeof WorkflowCapabilitySchema>;

const WorkflowInputControlSchema = z.enum(["text", "textarea", "date", "checkbox", "multiselect"]);
const WorkflowInputTypeSchema = z.enum(["string", "number", "boolean", "string[]", "enum"]);

export const WorkflowInputOptionSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
});
export type WorkflowInputOption = z.infer<typeof WorkflowInputOptionSchema>;
```

Ensure `WorkflowInputDefinitionSchema` contains:

```ts
type: WorkflowInputTypeSchema,
required: z.boolean().default(false),
default: z.unknown().optional(),
label: z.string().min(1).optional(),
description: z.string().min(1).optional(),
placeholder: z.string().min(1).optional(),
order: z.number().int().nonnegative().optional(),
group: z.string().min(1).optional(),
options: z.array(WorkflowInputOptionSchema).optional(),
ui: z.object({ control: WorkflowInputControlSchema }).optional(),
```

Ensure `WorkflowDefinitionSchema` contains:

```ts
category: z.string().min(1).optional(),
businessUseCase: z.string().min(1).optional(),
requiredCapabilities: z.array(WorkflowCapabilitySchema).default([]),
optionalCapabilities: z.array(WorkflowCapabilitySchema).default([]),
outputs: z.array(WorkflowOutputDeclarationSchema).optional(),
```

- [ ] **Step 4: Ensure restored playbooks are registered before demo workflows**

In `packages/core/src/workflow.ts`, import and export these manifests:

```ts
import customerRenewalRiskReviewManifest from "./workflows/customer.renewal-risk-review.json";
import operationsWeeklyStatusDigestManifest from "./workflows/operations.weekly-status-digest.json";
import salesMeetingBriefManifest from "./workflows/sales.meeting-brief.json";

export const SALES_MEETING_BRIEF_WORKFLOW = loadWorkflowDefinition(salesMeetingBriefManifest);
export const CUSTOMER_RENEWAL_RISK_REVIEW_WORKFLOW = loadWorkflowDefinition(
  customerRenewalRiskReviewManifest
);
export const WEEKLY_STATUS_DIGEST_WORKFLOW = loadWorkflowDefinition(
  operationsWeeklyStatusDigestManifest
);
```

In `apps/sidecar/src/server.ts`, keep registry ordering:

```ts
const workflowRegistry = new Map([
  [SALES_MEETING_BRIEF_WORKFLOW.id, SALES_MEETING_BRIEF_WORKFLOW],
  [CUSTOMER_RENEWAL_RISK_REVIEW_WORKFLOW.id, CUSTOMER_RENEWAL_RISK_REVIEW_WORKFLOW],
  [WEEKLY_STATUS_DIGEST_WORKFLOW.id, WEEKLY_STATUS_DIGEST_WORKFLOW],
  [DEMO_WORKFLOW.id, DEMO_WORKFLOW],
  [WEEKLY_UPDATE_WORKFLOW.id, WEEKLY_UPDATE_WORKFLOW],
]);
```

- [ ] **Step 5: Run focused workflow tests**

Run:

```bash
bun test packages/contracts/src/workflow.test.ts
bun test packages/core/src/workflow.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Commit only contract/core/server registration changes:

```bash
git add packages/contracts/src/index.ts packages/contracts/src/workflow.test.ts packages/core/src/workflow.ts packages/core/src/index.ts apps/sidecar/src/server.ts packages/core/src/workflows/sales.meeting-brief.json packages/core/src/workflows/customer.renewal-risk-review.json packages/core/src/workflows/operations.weekly-status-digest.json
git commit -m "Restore business playbooks for guided launch"
```

---

### Task 2: Make Agent-Backed Playbooks Runnable

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/workflow.test.ts`
- Modify: `apps/sidecar/src/server.ts`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Test: `packages/contracts/src/workflow.test.ts`

- [ ] **Step 1: Write contract test for playbook execution config**

Add this test to `packages/contracts/src/workflow.test.ts`:

```ts
test("accepts workflow run requests with workflow execution config", () => {
  const parsed = WorkflowRunRequestSchema.parse({
    workflowId: "sales.meeting-brief",
    agentId: "agent-1",
    agentLabel: "Sales Partner",
    input: { company: "Acme Corp", workspaceRoot: "/workspace/acme" },
    execution: {
      provider: { provider: "local", model: "llama3.2", baseUrl: "http://127.0.0.1:11434/v1" },
    },
  });

  expect(parsed.execution?.provider.provider).toBe("local");
  expect(parsed.agentId).toBe("agent-1");
});
```

Also add this resume-request assertion:

```ts
test("accepts workflow resume requests with workflow execution config", () => {
  const parsed = WorkflowResumeRequestSchema.parse({
    runId: "run-1",
    decision: "approve",
    agentId: "agent-1",
    execution: {
      provider: { provider: "local", model: "llama3.2", baseUrl: "http://127.0.0.1:11434/v1" },
      credential: { apiKey: "test-key" },
    },
  });

  expect(parsed.execution?.provider.provider).toBe("local");
  expect(parsed.execution?.credential?.apiKey).toBe("test-key");
  expect(parsed.agentId).toBe("agent-1");
});
```

- [ ] **Step 2: Run contract test and verify failure if execution is missing**

Run:

```bash
bun test packages/contracts/src/workflow.test.ts
```

Expected before implementation if needed: FAIL because `WorkflowRunRequestSchema` strips or rejects `execution`.

- [ ] **Step 3: Extend workflow run request schema**

In `packages/contracts/src/index.ts`, define a small workflow execution schema near `AgentProviderConfigSchema`. Do not reuse the full `TaskExecutionConfigSchema`; playbook run requests only need provider and request-scoped credential, and they must not couple workflow APIs to task profile internals.

```ts
export const WorkflowExecutionConfigSchema = z.object({
  provider: AgentProviderConfigSchema,
  credential: z.object({ apiKey: z.string().min(1) }).optional(),
});

export type WorkflowExecutionConfig = z.infer<typeof WorkflowExecutionConfigSchema>;
```

Then update the workflow run request schema:

```ts
export const WorkflowRunRequestSchema = z.object({
  workflowId: z.string().min(1).default("demo.write-approval"),
  agentId: z.string().min(1).default("default"),
  agentLabel: z.string().min(1).default("Tessera"),
  input: z.record(z.unknown()).default({}),
  execution: WorkflowExecutionConfigSchema.optional(),
});
```

Update `WorkflowResumeRequestSchema` in the same location:

```ts
export const WorkflowResumeRequestSchema = z.object({
  runId: z.string().min(1),
  decision: z.enum(["approve", "deny"]),
  agentId: z.string().min(1).optional(),
  execution: WorkflowExecutionConfigSchema.optional(),
});
```

Add the same non-secret assignment fields to `WorkflowRunResultSchema` so resume can reuse the selected assignment:

```ts
agentId: z.string().min(1).default("default"),
agentLabel: z.string().min(1).default("Tessera"),
```

- [ ] **Step 4: Pass execution provider and credential into workflow runs**

In `apps/sidecar/src/server.ts`, update both `handleWorkflowRun` and `handlePlaybookRunCreate` `runWorkflow` calls to pass execution details:

```ts
const execution = parsed.data.execution;
const result = await runWorkflow({
  definition,
  agent: profileForAgentId(parsed.data.agentId),
  input: parsed.data.input,
  cli: { runWorkspaceCli },
  ...(execution?.provider ? { agentProvider: execution.provider } : {}),
  ...(execution?.credential ? { agentCredential: execution.credential.apiKey } : {}),
  onCheckpoint(run) {
    workflowStore.save(run);
  },
});
```

For `handlePlaybookRunCreate`, parse the body with `WorkflowRunRequestSchema` after forcing `workflowId` from the URL:

```ts
const parsed = WorkflowRunRequestSchema.safeParse({
  workflowId: playbookId,
  input,
  execution: body && typeof body === "object" ? (body as { execution?: unknown }).execution : undefined,
});
if (!parsed.success) {
  return Response.json({ error: parsed.error.message }, { status: 400 });
}
```

Then use `parsed.data.input` and `parsed.data.execution`.

Update `handleWorkflowResume` to pass execution into `resumeWorkflowRun` without storing credentials:

```ts
const execution = parsed.data.execution;
const result = await resumeWorkflowRun({
  run: existing,
  decision: parsed.data.decision,
  definition,
  agent: profileForAgentId(parsed.data.agentId ?? existing.agentId ?? "default"),
  cli: { runWorkspaceCli },
  ...(execution?.provider ? { agentProvider: execution.provider } : {}),
  ...(execution?.credential ? { agentCredential: execution.credential.apiKey } : {}),
  onCheckpoint(checkpoint) {
    workflowStore.save(checkpoint);
  },
});
```

- [ ] **Step 5: Attach default model execution in Tauri playbook commands**

In `apps/desktop/src-tauri/src/lib.rs`, add:

```rust
async fn attach_default_workflow_execution(
    app: &AppHandle,
    mut request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if request.get("execution").is_some() {
        return Ok(request);
    }

    let mut task_like = serde_json::json!({
        "workspaceRoot": request
            .get("input")
            .and_then(|input| input.get("workspaceRoot"))
            .and_then(|value| value.as_str())
            .unwrap_or(""),
        "initialInstruction": "Run playbook",
        "agentId": request
            .get("agentId")
            .and_then(|value| value.as_str())
            .unwrap_or("default"),
        "agentLabel": request
            .get("agentLabel")
            .and_then(|value| value.as_str())
            .unwrap_or("Tessera")
    });
    task_like = attach_default_task_execution(app, task_like).await?;
    if let Some(execution) = task_like.get("execution") {
        let Some(provider) = execution.get("provider").cloned() else {
            return Ok(request);
        };
        let mut workflow_execution = serde_json::json!({
            "provider": provider
        });
        if let Some(credential) = execution.get("credential").cloned() {
            workflow_execution["credential"] = credential;
        }
        request["execution"] = workflow_execution;
    }
    Ok(request)
}
```

Update `playbook_run_create`:

```rust
async fn playbook_run_create(
    app: AppHandle,
    state: State<'_, SidecarHandle>,
    playbook_id: String,
    agent_id: String,
    agent_label: String,
    input: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let request = attach_default_workflow_execution(
        &app,
        serde_json::json!({
            "workflowId": &playbook_id,
            "agentId": agent_id,
            "agentLabel": agent_label,
            "input": input
        }),
    )
    .await?;
    let body = request.to_string();
    let path = format!("/playbooks/{}/runs", percent_encode(&playbook_id));
    let json = state.post(&path, &body).await.map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}
```

Update `playbook_run_resume` to attach execution too:

```rust
async fn playbook_run_resume(
    app: AppHandle,
    state: State<'_, SidecarHandle>,
    run_id: String,
    decision: String,
    agent_id: Option<String>,
    agent_label: Option<String>,
) -> Result<serde_json::Value, String> {
    let request = attach_default_workflow_execution(
        &app,
        serde_json::json!({
            "runId": &run_id,
            "decision": decision,
            "agentId": agent_id.unwrap_or_else(|| "default".to_string()),
            "agentLabel": agent_label.unwrap_or_else(|| "Tessera".to_string()),
            "input": {}
        }),
    )
    .await?;
    let mut body_value = request;
    body_value
        .as_object_mut()
        .map(|object| object.remove("input"));
    let path = format!("/playbook-runs/{}/resume", percent_encode(&run_id));
    let json = state
        .post(&path, &body_value.to_string())
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}
```

Do not write `execution` into workflow checkpoints. It contains credential
material and must remain request-scoped.

- [ ] **Step 6: Pass selected profile into core agent steps**

In `packages/core/src/workflow.ts`, extend workflow run/resume options to accept the selected agent profile and runtime:

```ts
agent?: AgentProfile;
runtime?: AgentRuntimeContext;
```

When executing an agent step, pass those fields to `runPiTaskTurn`:

```ts
const result = await (options.agentRunner ?? runPiTaskTurn)({
  ...(options.agent ? { agent: options.agent } : {}),
  ...(credential ? { credential } : {}),
  prompt: resolveTemplate(step.prompt, input),
  provider,
  ...(options.runtime ? { runtime: options.runtime } : {}),
  workspaceRoot,
});
```

Also include `agentId` and `agentLabel` in each returned checkpoint/result. These are non-secret run assignment fields and are required so approval resumes continue with the original assignment.

- [ ] **Step 7: Add a sidecar or core test for agent execution routing**

Add this focused assertion to `packages/core/src/workflow.test.ts` if not already covered by existing tests:

```ts
test("agent playbook uses supplied provider and credential", async () => {
  const definition = loadWorkflowDefinition({
    id: "custom.agent-playbook",
    version: 1,
    name: "Custom Agent Playbook",
    start: "draft",
    inputs: {
      workspaceRoot: { type: "string", required: true },
      prompt: { type: "string", required: true },
    },
    steps: [
      {
        id: "draft",
        kind: "agent",
        label: "Draft",
        prompt: "{{inputs.prompt}}",
        workspaceRootInput: "workspaceRoot",
      },
    ],
  });
  const seen: Array<{ credential?: string; provider: string }> = [];

  await runWorkflow({
    definition,
    input: { workspaceRoot: "/workspace/acme", prompt: "hello" },
    cli: {
      async runWorkspaceCli() {
        throw new Error("agent workflow should not call tool CLI");
      },
    },
    agentProvider: { provider: "openai", model: "gpt-5.4", apiKeyEnv: "OPENAI_API_KEY" },
    agentCredential: "test-key",
    async agentRunner(options) {
      seen.push({ credential: options.credential, provider: options.provider.provider });
      return { text: "drafted", boundaryViolations: 0 };
    },
  });

  expect(seen).toEqual([{ credential: "test-key", provider: "openai" }]);
});
```

- [ ] **Step 8: Run focused checks**

Run:

```bash
bun test packages/contracts/src/workflow.test.ts
bun test packages/core/src/workflow.test.ts
bun run --filter './apps/sidecar' typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/src/workflow.test.ts packages/core/src/workflow.test.ts apps/sidecar/src/server.ts apps/desktop/src-tauri/src/lib.rs
git commit -m "Wire model execution into playbook runs"
```

---

### Task 3: Add Playbooks UI Helper Layer

**Files:**
- Create: `apps/desktop/ui/src/lib/playbooks.ts`
- Create: `apps/desktop/ui/src/lib/playbooks.test.ts`

- [ ] **Step 1: Write helper tests**

Create `apps/desktop/ui/src/lib/playbooks.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { PlaybookSummary, WorkflowInputDefinition, WorkflowRunStepRecord } from "@tessera/contracts";
import {
  defaultPlaybookInput,
  displayInputRows,
  formatPlaybookDuration,
  hasRequiredPlaybookInput,
  outputLabels,
  playbookActionLabel,
  runStatusLabel,
  stepStatusLabel,
  userInputDefinitions,
} from "./playbooks";

const playbook: PlaybookSummary = {
  id: "sales.meeting-brief",
  version: 1,
  name: "Sales Meeting Brief",
  description: "Creates a meeting brief.",
  businessUseCase: "Prepare for a customer or prospect meeting",
  requiredCapabilities: [],
  optionalCapabilities: ["web"],
  outputs: [
    { kind: "meetingBrief", label: "Meeting brief" },
    { kind: "sourceSummary", label: "Source summary" },
  ],
  stepCount: 2,
  phases: ["Prepare", "Review"],
};

const inputs: Record<string, WorkflowInputDefinition> = {
  company: {
    type: "string",
    required: true,
    label: "Company",
    placeholder: "Acme Corp",
    order: 1,
    group: "Meeting",
    ui: { control: "text" },
  },
  objective: {
    type: "string",
    required: true,
    label: "Objective",
    placeholder: "Agree next steps",
    order: 2,
    group: "Meeting",
    ui: { control: "textarea" },
  },
  sources: {
    type: "string[]",
    required: true,
    label: "Research sources",
    default: ["web"],
    order: 3,
    group: "Research",
    options: [{ value: "web", label: "Web" }],
    ui: { control: "multiselect" },
  },
  workspaceRoot: {
    type: "string",
    required: true,
    label: "Workspace",
    group: "System",
    ui: { control: "text" },
  },
};

describe("playbooks UI helpers", () => {
  test("uses business labels for run and step status", () => {
    expect(runStatusLabel("blocked")).toBe("Needs review");
    expect(runStatusLabel("completed")).toBe("Ready");
    expect(stepStatusLabel("blocked")).toBe("Waiting for your review");
    expect(stepStatusLabel("succeeded")).toBe("Done");
  });

  test("hides system inputs and orders visible fields", () => {
    expect(userInputDefinitions(inputs).map((field) => field.key)).toEqual([
      "company",
      "objective",
      "sources",
    ]);
  });

  test("builds default input with hidden workspace root and no placeholder-as-value", () => {
    expect(defaultPlaybookInput(playbook, inputs, "/workspace/acme")).toEqual({
      company: "",
      objective: "",
      sources: ["web"],
      workspaceRoot: "/workspace/acme",
    });
  });

  test("requires business inputs before start", () => {
    expect(hasRequiredPlaybookInput({ company: "", objective: "", sources: ["web"] }, inputs)).toBe(false);
    expect(
      hasRequiredPlaybookInput({ company: "Acme Corp", objective: "Agree next steps", sources: ["web"] }, inputs)
    ).toBe(true);
  });

  test("formats user request rows without workspace root", () => {
    expect(
      displayInputRows(
        { company: "Acme Corp", sources: ["web"], workspaceRoot: "/workspace/acme" },
        inputs
      )
    ).toEqual([
      { key: "company", label: "Company", value: "Acme Corp" },
      { key: "sources", label: "Research sources", value: "Web" },
    ]);
  });

  test("returns artifact labels and action labels", () => {
    expect(outputLabels(playbook)).toEqual(["Meeting brief", "Source summary"]);
    expect(playbookActionLabel(playbook)).toBe("Prepare brief");
  });

  test("formats durations for business users", () => {
    expect(formatPlaybookDuration(undefined)).toBe("Still running");
    expect(formatPlaybookDuration(250)).toBe("Under a second");
    expect(formatPlaybookDuration(16_000)).toBe("16 sec");
  });
});
```

- [ ] **Step 2: Run helper tests and verify they fail**

Run:

```bash
bun test apps/desktop/ui/src/lib/playbooks.test.ts
```

Expected: FAIL because `apps/desktop/ui/src/lib/playbooks.ts` does not exist.

- [ ] **Step 3: Implement helpers**

Create `apps/desktop/ui/src/lib/playbooks.ts`:

```ts
import type {
  PlaybookSummary,
  WorkflowInputDefinition,
  WorkflowRunResult,
  WorkflowRunStepRecord,
} from "@tessera/contracts";

export interface PlaybookInputField {
  key: string;
  definition: WorkflowInputDefinition;
}

export interface PlaybookInputRow {
  key: string;
  label: string;
  value: string;
}

export function runStatusLabel(status: WorkflowRunResult["status"]): string {
  if (status === "running") return "In progress";
  if (status === "blocked") return "Needs review";
  if (status === "completed") return "Ready";
  if (status === "denied") return "Stopped";
  return "Needs attention";
}

export function stepStatusLabel(status: WorkflowRunStepRecord["status"]): string {
  if (status === "succeeded") return "Done";
  if (status === "running") return "Working";
  if (status === "blocked") return "Waiting for your review";
  if (status === "failed") return "Needs attention";
  if (status === "denied") return "Stopped";
  return "Not started";
}

export function formatPlaybookDuration(value?: number): string {
  if (value === undefined) return "Still running";
  if (value < 1000) return "Under a second";
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} min`;
}

export function formatPlaybookTime(value?: string): string {
  if (!value) return "Not started";
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function userInputDefinitions(
  inputs: Record<string, WorkflowInputDefinition>
): PlaybookInputField[] {
  return Object.entries(inputs)
    .filter(([key, definition]) => key !== "workspaceRoot" && definition.group !== "System")
    .map(([key, definition]) => ({ key, definition }))
    .sort((a, b) => (a.definition.order ?? 999) - (b.definition.order ?? 999));
}

function titleFromKey(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[._\s-]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function optionLabel(definition: WorkflowInputDefinition, value: string): string {
  return definition.options?.find((option) => option.value === value)?.label ?? value;
}

function displayValue(value: unknown, definition: WorkflowInputDefinition): string {
  if (Array.isArray(value)) return value.map((item) => optionLabel(definition, String(item))).join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string") return optionLabel(definition, value);
  if (value === undefined || value === null || value === "") return "Not provided";
  return String(value);
}

export function displayInputRows(
  input: Record<string, unknown>,
  definitions: Record<string, WorkflowInputDefinition>
): PlaybookInputRow[] {
  return userInputDefinitions(definitions)
    .filter((field) => field.key in input)
    .map((field) => ({
      key: field.key,
      label: field.definition.label ?? titleFromKey(field.key),
      value: displayValue(input[field.key], field.definition),
    }));
}

export function hasRequiredPlaybookInput(
  input: Record<string, unknown>,
  definitions: Record<string, WorkflowInputDefinition>
): boolean {
  return userInputDefinitions(definitions)
    .filter((field) => field.definition.required)
    .every((field) => {
      const value = input[field.key];
      if (Array.isArray(value)) return value.length > 0;
      return value !== undefined && value !== null && String(value).trim().length > 0;
    });
}

export function defaultPlaybookInput(
  playbook: PlaybookSummary,
  inputs: Record<string, WorkflowInputDefinition>,
  workspaceRoot: string | null
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [key, definition] of Object.entries(inputs)) {
    if (key === "workspaceRoot") {
      values[key] = workspaceRoot ?? "";
    } else if (definition.default !== undefined) {
      values[key] = definition.default;
    } else if (definition.ui?.control === "date") {
      values[key] = "";
    } else if (definition.type === "string[]") {
      values[key] = definition.options?.slice(0, 1).map((option) => option.value) ?? [];
    } else if (definition.type === "string" || definition.type === "enum") {
      values[key] = "";
    } else if (definition.type === "number") {
      values[key] = 0;
    } else {
      values[key] = false;
    }
  }

  return values;
}

export function outputLabels(playbook?: Pick<PlaybookSummary, "outputs">): string[] {
  return playbook?.outputs?.map((output) => output.label) ?? ["Result"];
}

export function playbookActionLabel(playbook: PlaybookSummary): string {
  const outputKinds = new Set(playbook.outputs?.map((output) => output.kind) ?? []);
  if (outputKinds.has("meetingBrief")) return "Prepare brief";
  if (outputKinds.has("businessBrief")) return "Prepare risk review";
  if (outputKinds.has("statusDigest")) return "Create digest";
  return "Start playbook";
}
```

- [ ] **Step 4: Run helper tests**

Run:

```bash
bun test apps/desktop/ui/src/lib/playbooks.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/ui/src/lib/playbooks.ts apps/desktop/ui/src/lib/playbooks.test.ts
git commit -m "Add business copy helpers for guided playbooks"
```

---

### Task 4: Build Manifest-Driven Intake Form

**Files:**
- Create: `apps/desktop/ui/src/components/PlaybookIntakeForm.tsx`
- Test: `apps/desktop/ui/src/components/PlaybooksView.test.tsx`

- [ ] **Step 1: Write UI tests for intake rendering**

Create `apps/desktop/ui/src/components/PlaybooksView.test.tsx` with this initial content:

```tsx
/// <reference types="bun" />

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentProfile, PlaybookDetail, PlaybookSummary } from "@tessera/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { JSDOM } from "jsdom";
import React from "react";

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
  });
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  globals.window = dom.window as never;
  globals.document = dom.window.document as never;
  globals.navigator = dom.window.navigator as never;
  globals.Node = dom.window.Node as never;
  globals.Element = dom.window.Element as never;
  globals.HTMLElement = dom.window.HTMLElement as never;
  globals.HTMLInputElement = dom.window.HTMLInputElement as never;
  globals.HTMLTextAreaElement = dom.window.HTMLTextAreaElement as never;
  globals.HTMLSelectElement = dom.window.HTMLSelectElement as never;
  globals.SVGElement = dom.window.SVGElement as never;
  globals.Text = dom.window.Text as never;
  globals.Event = dom.window.Event as never;
  globals.MouseEvent = dom.window.MouseEvent as never;
  globals.getComputedStyle = dom.window.getComputedStyle.bind(dom.window) as never;
  globals.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(cb, 0)) as never;
  globals.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as never;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", {
    value: () => undefined,
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", {
    value: () => undefined,
  });
}

installDom();

const playbook: PlaybookSummary = {
  id: "sales.meeting-brief",
  version: 1,
  name: "Sales Meeting Brief",
  description: "Creates a meeting brief.",
  businessUseCase: "Prepare for a customer or prospect meeting",
  requiredCapabilities: [],
  optionalCapabilities: ["web"],
  outputs: [{ kind: "meetingBrief", label: "Meeting brief" }],
  stepCount: 2,
  phases: ["Prepare", "Review"],
};

const detail: PlaybookDetail = {
  ...playbook,
  inputs: {
    company: {
      type: "string",
      required: true,
      label: "Company",
      placeholder: "Acme Corp",
      order: 1,
      group: "Meeting",
      ui: { control: "text" },
    },
    objective: {
      type: "string",
      required: true,
      label: "Objective",
      placeholder: "Agree next steps",
      order: 2,
      group: "Meeting",
      ui: { control: "textarea" },
    },
    sources: {
      type: "string[]",
      required: true,
      label: "Research sources",
      default: ["web"],
      order: 3,
      group: "Research",
      options: [{ value: "web", label: "Web" }],
      ui: { control: "multiselect" },
    },
    workspaceRoot: {
      type: "string",
      required: true,
      label: "Workspace",
      group: "System",
      ui: { control: "text" },
    },
  },
  steps: [],
};

const agents = [
  { id: "default", name: "Tessera" },
  { id: "agent-1", name: "Sales Partner" },
] as unknown as AgentProfile[];

const { PlaybookIntakeForm } = await import("./PlaybookIntakeForm");

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  cleanup();
});

describe("PlaybookIntakeForm", () => {
  test("renders business inputs and hides system inputs", () => {
    render(
      <PlaybookIntakeForm
        agents={agents}
        disabled={false}
        playbook={playbook}
        playbookDetail={detail}
        workspaceRoot="/workspace/acme"
        onStart={() => {}}
      />
    );

    expect(screen.getByText("What meeting should Tessera prepare for?")).toBeTruthy();
    expect(screen.getByLabelText("Company")).toBeTruthy();
    expect(screen.getByLabelText("Objective")).toBeTruthy();
    expect(screen.queryByLabelText("Workspace")).toBeNull();
    expect(screen.getByLabelText("Run with")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Prepare brief" })).toBeTruthy();
  });

  test("submits normalized input with hidden workspace root", async () => {
    const onStart = mock(() => {});
    render(
      <PlaybookIntakeForm
        agents={agents}
        disabled={false}
        playbook={playbook}
        playbookDetail={detail}
        workspaceRoot="/workspace/acme"
        onStart={onStart}
      />
    );

    fireEvent.input(screen.getByLabelText("Company"), { target: { value: "Globex" } });
    fireEvent.input(screen.getByLabelText("Objective"), { target: { value: "Agree next steps" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare brief" }));

    expect(onStart).toHaveBeenCalledWith(
      {
        company: "Globex",
        objective: "Agree next steps",
        sources: ["web"],
        workspaceRoot: "/workspace/acme",
      },
      { agentId: "default", agentLabel: "Tessera" }
    );
  });

  test("disables start when workspace is missing", () => {
    render(
      <PlaybookIntakeForm
        agents={agents}
        disabled={false}
        playbook={playbook}
        playbookDetail={detail}
        workspaceRoot={null}
        onStart={() => {}}
      />
    );

    expect(screen.getByText("Select a workspace before starting this playbook.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Prepare brief" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("keeps start disabled until required business inputs are filled", () => {
    render(
      <PlaybookIntakeForm
        agents={agents}
        disabled={false}
        playbook={playbook}
        playbookDetail={detail}
        workspaceRoot="/workspace/acme"
        onStart={() => {}}
      />
    );

    expect((screen.getByRole("button", { name: "Prepare brief" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.input(screen.getByLabelText("Company"), { target: { value: "Globex" } });
    fireEvent.input(screen.getByLabelText("Objective"), { target: { value: "Agree next steps" } });
    expect((screen.getByRole("button", { name: "Prepare brief" }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("refreshes defaults when playbook detail arrives after first render", () => {
    const { rerender } = render(
      <PlaybookIntakeForm
        agents={agents}
        disabled={false}
        playbook={playbook}
        playbookDetail={null}
        workspaceRoot="/workspace/acme"
        onStart={() => {}}
      />
    );

    rerender(
      <PlaybookIntakeForm
        agents={agents}
        disabled={false}
        playbook={playbook}
        playbookDetail={detail}
        workspaceRoot="/workspace/acme"
        onStart={() => {}}
      />
    );

    expect((screen.getByLabelText("Company") as HTMLInputElement).value).toBe("");
  });
});
```

- [ ] **Step 2: Run UI test and verify it fails**

Run:

```bash
bun test apps/desktop/ui/src/components/PlaybooksView.test.tsx
```

Expected: FAIL because `PlaybookIntakeForm` does not exist.

- [ ] **Step 3: Implement the intake form**

Create `apps/desktop/ui/src/components/PlaybookIntakeForm.tsx`:

```tsx
import type { AgentProfile, PlaybookDetail, PlaybookSummary, WorkflowInputDefinition } from "@tessera/contracts";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  defaultPlaybookInput,
  hasRequiredPlaybookInput,
  playbookActionLabel,
  userInputDefinitions,
} from "@/lib/playbooks";

interface PlaybookIntakeFormProps {
  agents: AgentProfile[];
  disabled: boolean;
  playbook: PlaybookSummary;
  playbookDetail: PlaybookDetail | null;
  workspaceRoot: string | null;
  onStart: (input: Record<string, unknown>, agent: { agentId: string; agentLabel: string }) => void;
}

function valueForInput(value: unknown): string {
  if (Array.isArray(value)) return value.join(",");
  if (value === undefined || value === null) return "";
  return String(value);
}

function updateValue(definition: WorkflowInputDefinition, value: string): unknown {
  if (definition.type === "number") return Number(value);
  if (definition.type === "boolean") return value === "true";
  if (definition.type === "string[]") return value ? value.split(",").filter(Boolean) : [];
  return value;
}

function promptTitle(playbook: PlaybookSummary): string {
  const outputKind = playbook.outputs?.[0]?.kind;
  if (outputKind === "meetingBrief") return "What meeting should Tessera prepare for?";
  if (outputKind === "businessBrief") return "What account should Tessera review?";
  if (outputKind === "statusDigest") return "What weekly update should Tessera prepare?";
  return `What should Tessera prepare for ${playbook.name}?`;
}

export function PlaybookIntakeForm({
  agents,
  disabled,
  playbook,
  playbookDetail,
  workspaceRoot,
  onStart,
}: PlaybookIntakeFormProps) {
  const initialInput = useMemo(
    () => defaultPlaybookInput(playbook, playbookDetail?.inputs ?? {}, workspaceRoot),
    [playbook, playbookDetail?.inputs, workspaceRoot]
  );
  const [input, setInput] = useState<Record<string, unknown>>(initialInput);
  const fields = userInputDefinitions(playbookDetail?.inputs ?? {});
  const actionLabel = playbookActionLabel(playbook);
  const [selectedAgentId, setSelectedAgentId] = useState("default");
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? agents[0] ?? null;
  const canStart =
    Boolean(workspaceRoot) && Boolean(playbookDetail) && hasRequiredPlaybookInput(input, playbookDetail?.inputs ?? {});

  useEffect(() => {
    setInput(initialInput);
  }, [initialInput]);

  function setField(key: string, definition: WorkflowInputDefinition, value: string) {
    setInput((current) => ({ ...current, [key]: updateValue(definition, value) }));
  }

  return (
    <div className="mx-auto max-w-3xl py-8">
      <div className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
        {playbook.businessUseCase ?? playbook.category ?? "Playbook"}
      </div>
      <h2 className="mt-1 text-2xl font-semibold text-foreground">
        {promptTitle(playbook)}
      </h2>
      {playbook.description ? (
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{playbook.description}</p>
      ) : null}

      <div className="mt-6 grid gap-4">
        {agents.length > 1 ? (
          <label className="grid gap-1 text-sm font-medium text-foreground">
            Run with
            <select
              className="rounded-md border border-border bg-background px-3 py-2 text-sm font-normal"
              value={selectedAgent?.id ?? "default"}
              onChange={(event) => setSelectedAgentId(event.target.value)}
            >
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {fields.map(({ key, definition }) => (
          <label key={key} className="grid gap-1 text-sm font-medium text-foreground">
            {definition.label ?? key}
            {definition.ui?.control === "textarea" ? (
              <textarea
                className="min-h-24 rounded-md border border-border bg-background px-3 py-2 text-sm font-normal"
                placeholder={definition.placeholder}
                value={valueForInput(input[key])}
                onChange={(event) => setField(key, definition, event.target.value)}
              />
            ) : definition.ui?.control === "multiselect" ? (
              <div className="grid gap-2 rounded-md border border-border bg-background p-3">
                {definition.options?.map((option) => (
                  <label key={option.value} className="flex items-center gap-2 text-sm font-normal">
                    <input
                      type="checkbox"
                      className="size-4"
                      checked={Array.isArray(input[key]) && (input[key] as string[]).includes(option.value)}
                      onChange={(event) =>
                        setInput((current) => {
                          const currentValues = Array.isArray(current[key]) ? (current[key] as string[]) : [];
                          return {
                            ...current,
                            [key]: event.target.checked
                              ? [...currentValues, option.value]
                              : currentValues.filter((value) => value !== option.value),
                          };
                        })
                      }
                    />
                    {option.label}
                  </label>
                ))}
              </div>
            ) : (
              <input
                className="rounded-md border border-border bg-background px-3 py-2 text-sm font-normal"
                placeholder={definition.placeholder}
                type={definition.ui?.control === "date" ? "date" : "text"}
                value={valueForInput(input[key])}
                onChange={(event) => setField(key, definition, event.target.value)}
              />
            )}
            {definition.description ? (
              <span className="text-xs font-normal text-muted-foreground">{definition.description}</span>
            ) : null}
          </label>
        ))}
      </div>

      {!workspaceRoot ? (
        <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Select a workspace before starting this playbook.
        </div>
      ) : null}

      <div className="mt-5 flex items-center gap-3">
        <Button
          type="button"
          className="h-9 rounded-md"
          disabled={disabled || !canStart}
          onClick={() =>
            onStart(
              { ...input, workspaceRoot: workspaceRoot ?? "" },
              { agentId: selectedAgent?.id ?? "default", agentLabel: selectedAgent?.name ?? "Tessera" }
            )
          }
        >
          {actionLabel}
        </Button>
        <span className="text-xs text-muted-foreground">Tessera will ask before changing your workspace.</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run UI test**

Run:

```bash
bun test apps/desktop/ui/src/components/PlaybooksView.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/ui/src/components/PlaybookIntakeForm.tsx apps/desktop/ui/src/components/PlaybooksView.test.tsx
git commit -m "Add guided playbook intake form"
```

---

### Task 5: Build Same-Flow Guided State Renderer

**Files:**
- Create: `apps/desktop/ui/src/components/PlaybookGuidedFlow.tsx`
- Modify: `apps/desktop/ui/src/components/PlaybooksView.test.tsx`

- [ ] **Step 1: Add tests for preparing, review, and result states**

Modify `apps/desktop/ui/src/components/PlaybooksView.test.tsx`:

- Add `PlaybookRunDetail` to the existing `@tessera/contracts` type import.
- Add the dynamic import after the existing `PlaybookIntakeForm` dynamic import:

```tsx
const { PlaybookGuidedFlow } = await import("./PlaybookGuidedFlow");
```

Then append these fixtures and tests:

```tsx
const completedRun: PlaybookRunDetail = {
  runId: "run-1",
  workflowId: "sales.meeting-brief",
  status: "completed",
  input: { company: "Acme Corp", objective: "Agree next steps", workspaceRoot: "/workspace/acme" },
  outputs: { draftBrief: { text: "Brief ready" } },
  playbook,
  steps: [
    {
      id: "draftBrief",
      label: "Draft meeting brief",
      kind: "agent",
      phase: "Prepare",
      status: "succeeded",
    },
  ],
};

const blockedRun: PlaybookRunDetail = {
  ...completedRun,
  status: "blocked",
  approval: {
    toolId: "workspace.writeProbe",
    args: { target: "meeting-prep", value: "Agree next steps" },
    capability: "write",
    risk: {
      mutates: true,
      destructive: false,
      external: false,
      reversible: true,
      dryRunSupported: true,
    },
    preview: "write-probe target=meeting-prep value=Agree next steps",
    reasonCode: "write_requires_approval",
  },
  steps: [
    {
      id: "draftBrief",
      label: "Draft meeting brief",
      kind: "agent",
      phase: "Prepare",
      status: "succeeded",
    },
    {
      id: "approveBrief",
      label: "Review workspace preparation",
      kind: "tool",
      phase: "Review",
      status: "blocked",
    },
  ],
};

describe("PlaybookGuidedFlow", () => {
  test("renders local preparing state while start request is pending", () => {
    render(
      <PlaybookGuidedFlow
        agents={agents}
        playbook={playbook}
        playbookDetail={detail}
        run={null}
        running={true}
        workspaceRoot="/workspace/acme"
        onResume={() => {}}
        onStart={() => {}}
      />
    );

    expect(screen.getByText("Tessera is preparing your meeting brief")).toBeTruthy();
    expect(screen.getByText("Draft meeting brief")).toBeTruthy();
    expect(screen.queryByText("Run console")).toBeNull();
  });

  test("renders result state around artifacts, not raw JSON", () => {
    render(
      <PlaybookGuidedFlow
        agents={agents}
        playbook={playbook}
        playbookDetail={detail}
        run={completedRun}
        running={false}
        workspaceRoot="/workspace/acme"
        onResume={() => {}}
        onStart={() => {}}
      />
    );

    expect(screen.getByText("Your meeting brief is ready")).toBeTruthy();
    expect(screen.getByText("Meeting brief")).toBeTruthy();
    expect(screen.queryByText(/workspace.writeProbe/)).toBeNull();
    expect(screen.queryByText(/run-1/)).toBeNull();
  });

  test("renders approval as a business review", async () => {
    const onResume = mock(() => {});
    render(
      <PlaybookGuidedFlow
        agents={agents}
        playbook={playbook}
        playbookDetail={detail}
        run={blockedRun}
        running={false}
        workspaceRoot="/workspace/acme"
        onResume={onResume}
        onStart={() => {}}
      />
    );

    expect(screen.getByText("Approve the workspace prep?")).toBeTruthy();
    expect(screen.queryByText(/write-probe/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Approve and save" }));
    expect(onResume).toHaveBeenCalledWith("approve");
  });
});
```

- [ ] **Step 2: Run UI test and verify it fails**

Run:

```bash
bun test apps/desktop/ui/src/components/PlaybooksView.test.tsx
```

Expected: FAIL because `PlaybookGuidedFlow` does not exist.

- [ ] **Step 3: Implement guided state renderer**

Create `apps/desktop/ui/src/components/PlaybookGuidedFlow.tsx`:

```tsx
import type { AgentProfile, PlaybookDetail, PlaybookRunDetail, PlaybookSummary } from "@tessera/contracts";
import { AlertTriangle, CheckCircle2, Clock3, FileText, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  displayInputRows,
  formatPlaybookDuration,
  outputLabels,
  runStatusLabel,
  stepStatusLabel,
} from "@/lib/playbooks";
import { PlaybookIntakeForm } from "./PlaybookIntakeForm";

interface PlaybookGuidedFlowProps {
  agents: AgentProfile[];
  playbook: PlaybookSummary;
  playbookDetail: PlaybookDetail | null;
  run: PlaybookRunDetail | null;
  running: boolean;
  workspaceRoot: string | null;
  onStart: (input: Record<string, unknown>, agent: { agentId: string; agentLabel: string }) => void;
  onResume: (decision: "approve" | "deny") => void;
}

function stepIcon(status: NonNullable<PlaybookRunDetail["steps"]>[number]["status"]) {
  if (status === "succeeded") return <CheckCircle2 size={16} className="text-emerald-600" />;
  if (status === "running") return <Loader2 size={16} className="animate-spin text-blue-600" />;
  if (status === "blocked") return <AlertTriangle size={16} className="text-amber-600" />;
  return <Clock3 size={16} className="text-muted-foreground" />;
}

function artifactTitle(playbook: PlaybookSummary): string {
  const label = outputLabels(playbook)[0] ?? "result";
  return label.charAt(0).toLowerCase() + label.slice(1);
}

export function PlaybookGuidedFlow({
  agents,
  playbook,
  playbookDetail,
  run,
  running,
  workspaceRoot,
  onStart,
  onResume,
}: PlaybookGuidedFlowProps) {
  if (!run) {
    if (running) {
      return (
        <div className="mx-auto max-w-3xl py-8">
          <div className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            In progress
          </div>
          <h2 className="mt-1 text-2xl font-semibold text-foreground">
            Tessera is preparing your {artifactTitle(playbook)}
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            This screen will update when the playbook needs review or the result is ready.
          </p>
          <div className="mt-6 divide-y divide-border rounded-md border border-border">
            {(playbookDetail?.steps ?? []).map((step, index) => (
              <div key={step.id} className="grid grid-cols-[28px_1fr_auto] gap-3 px-3 py-3">
                <div className="pt-0.5">
                  {index === 0 ? <Loader2 size={16} className="animate-spin text-blue-600" /> : <Clock3 size={16} className="text-muted-foreground" />}
                </div>
                <div>
                  <div className="text-sm font-medium text-foreground">{step.label ?? step.id}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{index === 0 ? "Working" : "Not started"}</div>
                </div>
                <div className="text-xs text-muted-foreground">{index === 0 ? "Working" : "Later"}</div>
              </div>
            ))}
          </div>
        </div>
      );
    }

    return (
      <PlaybookIntakeForm
        agents={agents}
        disabled={running}
        playbook={playbook}
        playbookDetail={playbookDetail}
        workspaceRoot={workspaceRoot}
        onStart={onStart}
      />
    );
  }

  const rows = displayInputRows(run.input, playbookDetail?.inputs ?? {});
  const isReview = run.status === "blocked" && run.approval;
  const isResult = run.status === "completed";

  return (
    <div className="mx-auto max-w-3xl py-8">
      <div className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
        {runStatusLabel(run.status)}
      </div>
      <h2 className="mt-1 text-2xl font-semibold text-foreground">
        {isReview
          ? "Approve the workspace prep?"
          : isResult
            ? `Your ${artifactTitle(playbook)} is ready`
            : `Tessera is preparing your ${artifactTitle(playbook)}`}
      </h2>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        {isReview
          ? "Tessera prepared the next step and needs your approval before it changes the workspace."
          : isResult
            ? `${playbook.name} is ready to review.`
            : "You can leave this screen. Tessera will pause if it needs your review."}
      </p>

      {isReview ? (
        <div className="mt-5 rounded-md border border-amber-200 bg-amber-50 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-amber-900">
            <ShieldCheck size={16} />
            Review needed
          </div>
          <p className="mt-2 text-sm text-amber-800">
            Approving lets Tessera save the prepared workspace update. Stopping keeps the prepared information without making the update.
          </p>
          <div className="mt-3 flex gap-2">
            <Button type="button" size="sm" className="h-8 rounded-md" disabled={running} onClick={() => onResume("approve")}>
              Approve and save
            </Button>
            <Button type="button" size="sm" variant="destructive" className="h-8 rounded-md" disabled={running} onClick={() => onResume("deny")}>
              Stop here
            </Button>
          </div>
        </div>
      ) : null}

      <div className="mt-6 divide-y divide-border rounded-md border border-border">
        {(run.steps ?? []).map((step) => (
          <div key={step.id} className="grid grid-cols-[28px_1fr_auto] gap-3 px-3 py-3">
            <div className="pt-0.5">{stepIcon(step.status)}</div>
            <div>
              <div className="text-sm font-medium text-foreground">{step.label}</div>
              <div className="mt-1 text-xs text-muted-foreground">{stepStatusLabel(step.status)}</div>
            </div>
            <div className="text-xs text-muted-foreground">{formatPlaybookDuration(step.durationMs)}</div>
          </div>
        ))}
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Request</h3>
          <div className="mt-2 divide-y divide-border rounded-md border border-border bg-secondary">
            {rows.map((row) => (
              <div key={row.key} className="px-3 py-2 text-xs">
                <div className="font-medium text-foreground">{row.label}</div>
                <div className="mt-0.5 text-muted-foreground">{row.value}</div>
              </div>
            ))}
          </div>
        </div>
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Outputs</h3>
          <div className="mt-2 space-y-2">
            {outputLabels(playbook).map((label) => (
              <div key={label} className={cn("flex items-center gap-2 rounded-md border border-border bg-secondary px-3 py-2 text-xs", isResult && "bg-emerald-50 border-emerald-200")}>
                <FileText size={14} className="text-muted-foreground" />
                <span className="font-medium text-foreground">{label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run UI tests**

Run:

```bash
bun test apps/desktop/ui/src/components/PlaybooksView.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/ui/src/components/PlaybookGuidedFlow.tsx apps/desktop/ui/src/components/PlaybooksView.test.tsx
git commit -m "Add same-flow playbook run states"
```

---

### Task 6: Replace PlaybooksView Container

**Files:**
- Modify: `apps/desktop/ui/src/components/PlaybooksView.tsx`
- Modify: `apps/desktop/ui/src/components/PlaybooksView.test.tsx`

- [ ] **Step 1: Add container integration tests**

Append to `apps/desktop/ui/src/components/PlaybooksView.test.tsx`. Do not use a static import for `PlaybooksView`; mock Tauri first, then dynamically import the component.

```tsx
mock.module("@tauri-apps/api/core", () => ({
  invoke: mock(async (command: string) => {
    if (command === "agent_profile_list") return { profiles: agents };
    if (command === "playbook_list") {
      return {
        playbooks: [
          playbook,
          {
            ...playbook,
            id: "demo.write-approval",
            name: "Demo Write Approval",
            businessUseCase: undefined,
            category: undefined,
            outputs: [],
          },
        ],
      };
    }
    if (command === "playbook_get") return detail;
    if (command === "playbook_run_list") return { runs: [] };
    if (command === "playbook_run_create") return completedRun;
    throw new Error(`Unexpected command ${command}`);
  }),
}));

const { PlaybooksView } = await import("./PlaybooksView");

describe("PlaybooksView guided container", () => {
  test("shows playbook catalog and guided intake instead of run console labels", async () => {
    render(<PlaybooksView workspaceRoot="/workspace/acme" />);

    expect(await screen.findByText("Sales Meeting Brief")).toBeTruthy();
    expect(await screen.findByText("What meeting should Tessera prepare for?")).toBeTruthy();
    expect(screen.queryByText("Demo Write Approval")).toBeNull();
    expect(screen.queryByText("Run console")).toBeNull();
    expect(screen.queryByText("Inspector")).toBeNull();
  });
});
```

- [ ] **Step 2: Run container tests and verify failure**

Run:

```bash
bun test apps/desktop/ui/src/components/PlaybooksView.test.tsx
```

Expected before implementation: FAIL if current `PlaybooksView` still renders `Run console`, `Inspector`, or bypasses intake.

- [ ] **Step 3: Replace PlaybooksView with guided container**

Edit `apps/desktop/ui/src/components/PlaybooksView.tsx` so its responsibilities are only:

- Load playbook list.
- Load selected playbook detail.
- Load runs for selected playbook.
- Start run with `playbook_run_create`.
- Resume run with `playbook_run_resume`.
- Render left playbook list/recent runs.
- Render `<PlaybookGuidedFlow />`.

Use this shape:

```tsx
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatPlaybookTime, runStatusLabel } from "@/lib/playbooks";
import { invoke } from "@tauri-apps/api/core";
import type { AgentProfile, AgentProfileListResult, PlaybookDetail, PlaybookListResult, PlaybookRunDetail, PlaybookSummary } from "@tessera/contracts";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { PlaybookGuidedFlow } from "./PlaybookGuidedFlow";

interface PlaybookRunListResult {
  runs: PlaybookRunDetail[];
}

interface PlaybooksViewProps {
  workspaceRoot: string | null;
}

export function PlaybooksView({ workspaceRoot }: PlaybooksViewProps) {
  const [playbooks, setPlaybooks] = useState<PlaybookSummary[]>([]);
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [selectedPlaybookDetail, setSelectedPlaybookDetail] = useState<PlaybookDetail | null>(null);
  const [runs, setRuns] = useState<PlaybookRunDetail[]>([]);
  const [selectedPlaybookId, setSelectedPlaybookId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedPlaybook = playbooks.find((playbook) => playbook.id === selectedPlaybookId) ?? playbooks[0] ?? null;
  const selectedRun = runs.find((run) => run.runId === selectedRunId) ?? null;

  const loadPlaybooks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<PlaybookListResult>("playbook_list");
      const businessPlaybooks = result.playbooks.filter((playbook) => playbook.businessUseCase);
      setPlaybooks(businessPlaybooks);
      setSelectedPlaybookId((current) => current ?? businessPlaybooks[0]?.id ?? null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAgents = useCallback(async () => {
    try {
      const result = await invoke<AgentProfileListResult>("agent_profile_list");
      setAgents(result.profiles);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, []);

  const loadRuns = useCallback(async (playbookId?: string | null) => {
    setError(null);
    try {
      const result = await invoke<PlaybookRunListResult>("playbook_run_list", {
        playbookId: playbookId ?? undefined,
      });
      setRuns(result.runs);
      setSelectedRunId((current) => {
        if (current && result.runs.some((run) => run.runId === current)) return current;
        return null;
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, []);

  const loadPlaybookDetail = useCallback(async (playbookId: string) => {
    try {
      const detail = await invoke<PlaybookDetail>("playbook_get", { playbookId });
      setSelectedPlaybookDetail(detail);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, []);

  useEffect(() => {
    void loadPlaybooks();
    void loadAgents();
  }, [loadAgents, loadPlaybooks]);

  useEffect(() => {
    void loadRuns(selectedPlaybookId);
    if (selectedPlaybookId) void loadPlaybookDetail(selectedPlaybookId);
  }, [loadPlaybookDetail, loadRuns, selectedPlaybookId]);

  async function startRun(input: Record<string, unknown>, agent: { agentId: string; agentLabel: string }) {
    if (!selectedPlaybook) return;
    setRunning(true);
    setError(null);
    try {
      const run = await invoke<PlaybookRunDetail>("playbook_run_create", {
        playbookId: selectedPlaybook.id,
        agentId: agent.agentId,
        agentLabel: agent.agentLabel,
        input,
      });
      setRuns((current) => [run, ...current.filter((item) => item.runId !== run.runId)]);
      setSelectedRunId(run.runId);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError));
    } finally {
      setRunning(false);
    }
  }

  async function resumeRun(decision: "approve" | "deny") {
    if (!selectedRun) return;
    setRunning(true);
    setError(null);
    try {
      const run = await invoke<PlaybookRunDetail>("playbook_run_resume", {
        runId: selectedRun.runId,
        decision,
        agentId: selectedRun.agentId ?? "default",
        agentLabel: selectedRun.agentLabel ?? "Tessera",
      });
      setRuns((current) => current.map((item) => (item.runId === run.runId ? run : item)));
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError));
    } finally {
      setRunning(false);
    }
  }

  return (
    <main className="flex min-w-0 flex-1 bg-background">
      <aside className="flex w-80 flex-shrink-0 flex-col border-r border-border bg-secondary">
        <div className="border-b border-border px-4 py-3">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-sm font-semibold text-foreground">Playbooks</h1>
              <p className="mt-0.5 text-xs text-muted-foreground">Repeatable business work</p>
            </div>
            <Button type="button" variant="ghost" size="icon" className="h-8 w-8 rounded-full" onClick={() => void loadRuns(selectedPlaybookId)} disabled={loading} title="Refresh">
              <RefreshCw size={14} />
            </Button>
          </div>
        </div>
        <div className="border-b border-border p-3">
          <div className="space-y-1">
            {playbooks.map((playbook) => (
              <button
                key={playbook.id}
                type="button"
                className={cn("w-full rounded-md px-3 py-2 text-left text-sm hover:bg-background", selectedPlaybook?.id === playbook.id && "bg-background shadow-sm")}
                onClick={() => {
                  setSelectedPlaybookId(playbook.id);
                  setSelectedRunId(null);
                }}
              >
                <div className="font-medium text-foreground">{playbook.name}</div>
                <div className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">{playbook.businessUseCase ?? playbook.description}</div>
              </button>
            ))}
          </div>
        </div>
        {error ? <div className="border-b border-destructive/20 bg-destructive/5 px-4 py-2 text-xs text-destructive">{error}</div> : null}
        <div className="min-h-0 flex-1 overflow-y-auto py-2">
          {runs.length === 0 ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">No runs for this playbook yet.</div>
          ) : (
            runs.map((run) => (
              <button key={run.runId} type="button" className={cn("w-full border-l-2 px-4 py-3 text-left hover:bg-background/70", selectedRun?.runId === run.runId ? "border-primary bg-background" : "border-transparent")} onClick={() => setSelectedRunId(run.runId)}>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-foreground">{run.playbook?.name ?? selectedPlaybook?.name ?? "Playbook run"}</span>
                  <span className="text-xs text-muted-foreground">{runStatusLabel(run.status)}</span>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">{formatPlaybookTime(run.updatedAt)}</div>
              </button>
            ))
          )}
        </div>
      </aside>
      <section className="min-w-0 flex-1 overflow-y-auto px-6">
        {selectedPlaybook ? (
          <PlaybookGuidedFlow
            playbook={selectedPlaybook}
            playbookDetail={selectedPlaybookDetail}
            agents={agents}
            run={selectedRun}
            running={running}
            workspaceRoot={workspaceRoot}
            onStart={startRun}
            onResume={resumeRun}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Select a playbook to get started.</div>
        )}
      </section>
    </main>
  );
}
```

- [ ] **Step 4: Run UI tests**

Run:

```bash
bun test apps/desktop/ui/src/components/PlaybooksView.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Run full UI tests**

Run:

```bash
bun test apps/desktop/ui/src/lib/playbooks.test.ts apps/desktop/ui/src/components/PlaybooksView.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/ui/src/components/PlaybooksView.tsx apps/desktop/ui/src/components/PlaybooksView.test.tsx
git commit -m "Replace playbook console with guided flow"
```

---

### Task 7: Final Verification

**Files:**
- Verify all modified files.

- [ ] **Step 1: Run focused workflow/store tests**

Run:

```bash
bun test packages/contracts/src/workflow.test.ts
bun test packages/core/src/workflow.test.ts
bun test apps/sidecar/src/workflow-store.test.ts
```

Expected: all PASS.

- [ ] **Step 2: Run focused UI tests**

Run:

```bash
bun test apps/desktop/ui/src/lib/playbooks.test.ts apps/desktop/ui/src/components/PlaybooksView.test.tsx
```

Expected: all PASS.

- [ ] **Step 3: Run repository check**

Run:

```bash
bun run check
```

Expected: Biome and all TypeScript project checks PASS.

- [ ] **Step 4: Run package tests**

Run:

```bash
bun run --filter '*' test
```

Expected: all package tests PASS. The plugin-sdk package may report "No tests found" and exit 0.

- [ ] **Step 5: Final review for forbidden business UI terms**

Run:

```bash
rg -n "\"Run console\"|\"Inspector\"|workspace.writeProbe|write-probe|JSON.stringify" apps/desktop/ui/src/components/PlaybooksView.tsx apps/desktop/ui/src/components/PlaybookGuidedFlow.tsx apps/desktop/ui/src/components/PlaybookIntakeForm.tsx
```

Expected: no matches.

- [ ] **Step 6: Commit verification cleanup if needed**

If formatting or test fixes were needed:

```bash
git add apps/desktop/ui/src/components/PlaybooksView.tsx apps/desktop/ui/src/components/PlaybookGuidedFlow.tsx apps/desktop/ui/src/components/PlaybookIntakeForm.tsx apps/desktop/ui/src/lib/playbooks.ts apps/desktop/ui/src/lib/playbooks.test.ts apps/desktop/ui/src/components/PlaybooksView.test.tsx
git commit -m "Polish guided playbook verification"
```

If no fixes were needed, do not create an empty commit.

---

## Self-Review Notes

Spec coverage:

- Same-flow four-state UX: Tasks 3, 4, 5.
- Business copy and hidden technical detail: Tasks 2, 4, 5, 6.
- Restored finalized playbook set: Task 1.
- Manifest-driven form controls: Tasks 2 and 3.
- Approval as business review: Task 4.
- Result as artifact-first view: Task 4.
- Empty/error/missing workspace states: Tasks 3 and 5.
- Testing requirements: Tasks 1 through 6.

No planned step requires broad internal `workflow` to `playbook` renaming. The plan preserves the internal workflow runner and replaces only the default Playbooks user experience.
