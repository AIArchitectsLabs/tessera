# Guided Playbooks UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current Playbooks run-console UI with a guided same-flow business experience: intake, preparing, review, and result.

**Architecture:** Keep the existing workflow runner and Playbooks sidecar/Tauri APIs. Refactor the desktop UI into focused Playbooks helpers: business copy helpers, intake form rendering, guided state panels, and a slim Playbooks shell. The UI should consume manifest metadata and run display records without exposing workflow IDs, tool names, raw JSON, or event logs by default.

**Runtime Constraint:** Current playbook creation is synchronous. The guided Preparing state is a local pending state while `playbook_run_create` is in flight. Do not claim durable live checkpoint progress unless async launch or run subscriptions are added in a later plan.

**Default Catalog Constraint:** Sidecar may keep demo/internal workflows registered for compatibility, but the desktop Playbooks catalog must promote manifest-backed business playbooks by default. Hide workflows without business metadata from the primary catalog unless a later developer/debug toggle is added.

**Node Assignment Constraint:** Playbook manifests must not reference local agent ids, labels, skill ids, tool implementation names, or integration account ids. Each node declares capability requirements; Tessera resolves those requirements to local agents, models, skills, tools, and integrations at run time. Runs persist resolved non-secret node assignments; credentials stay request-scoped.

**Capability Registry Constraint:** Requirement strings are not free-form. Add a canonical capability registry for model, skill, tool, and integration capabilities. Unknown required capabilities block launch; unknown optional capabilities become source gaps.

**Validation Boundary Constraint:** Assignment plans are request inputs, not trusted facts. Run-create and resume requests must include the current sanitized inventory used to validate the assignment plan before any node executes.

**Tech Stack:** React + TypeScript, Tauri `invoke`, `@tessera/contracts`, lucide-react, Tailwind, Bun tests, Biome.

---

## File Structure

- Modify `packages/contracts/src/index.ts`
  Keep rich manifest metadata and run detail contracts. Add capability registry, node requirement, assignment plan, and resolver request/result contracts.

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
  Build sanitized capability inventory and attach request-scoped credentials to playbook run and resume commands for agent-backed playbooks.

- Create `apps/desktop/ui/src/lib/playbooks.ts`
  Business copy, formatting, hidden/system input filtering, default input normalization, output labels, and guided state helpers.

- Create `apps/desktop/ui/src/lib/playbooks.test.ts`
  Unit tests for copy/format/input helpers.

- Create `apps/desktop/ui/src/components/PlaybookIntakeForm.tsx`
  Renders manifest-driven user inputs and emits normalized input. It does not ask the user to pick an agent by default.

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

### Task 2: Add Node Capability Requirements And Runtime Assignment

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/workflow.test.ts`
- Modify: `packages/core/src/workflow.ts`
- Modify: `packages/core/src/workflow.test.ts`
- Modify: `apps/sidecar/src/server.ts`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Test: `packages/contracts/src/workflow.test.ts`

- [ ] **Step 1: Write contract tests for capability registry and node requirements**

Add tests proving a playbook can describe what a node needs without naming local resources:

```ts
test("accepts capability requirements on workflow nodes", () => {
  const parsed = WorkflowDefinitionSchema.parse({
    id: "sales.meeting-brief",
    version: 1,
    name: "Sales Meeting Brief",
    start: "draftBrief",
    inputs: {
      workspaceRoot: { type: "string", required: true },
      company: { type: "string", required: true },
    },
    steps: [
      {
        id: "draftBrief",
        kind: "agent",
        label: "Draft meeting brief",
        prompt: "Prepare a brief for {{inputs.company}}",
        workspaceRootInput: "workspaceRoot",
        requires: {
          model: {
            acceptableProviders: ["openai", "anthropic", "local"],
            capabilities: ["reasoning", "summarization"],
            minContextTokens: 32000,
            dataPolicy: "workspace-local-ok",
          },
          skills: [{ capability: "meeting-prep" }, { capability: "account-research" }],
          tools: [{ capability: "workspace.read" }],
          integrations: [{ capability: "calendar.events.read", optional: true }],
        },
      },
    ],
  });

  expect(parsed.steps[0].requires?.skills?.[0]?.capability).toBe("meeting-prep");
});

test("rejects local ids in workflow node requirements", () => {
  expect(() =>
    WorkflowDefinitionSchema.parse({
      id: "bad.local-id",
      version: 1,
      name: "Bad Local Id",
      start: "draft",
      inputs: { workspaceRoot: { type: "string", required: true } },
      steps: [
        {
          id: "draft",
          kind: "agent",
          label: "Draft",
          prompt: "Draft",
          workspaceRootInput: "workspaceRoot",
          requires: {
            agentId: "agent-1",
          },
        },
      ],
    })
  ).toThrow();
});

test("rejects unknown required capability ids", () => {
  expect(() =>
    WorkflowDefinitionSchema.parse({
      id: "bad.unknown-capability",
      version: 1,
      name: "Bad Unknown Capability",
      start: "draft",
      inputs: { workspaceRoot: { type: "string", required: true } },
      steps: [
        {
          id: "draft",
          kind: "agent",
          label: "Draft",
          prompt: "Draft",
          workspaceRootInput: "workspaceRoot",
          requires: {
            skills: [{ capability: "not-a-real-capability" }],
          },
        },
      ],
    })
  ).toThrow();
});
```

- [ ] **Step 2: Add canonical capability contracts**

Add a small canonical registry in `packages/contracts/src/index.ts`. Keep it intentionally small for the MVP and expand it only when concrete playbooks need more:

```ts
export const CapabilityKindSchema = z.enum(["model", "skill", "tool", "integration"]);
export type CapabilityKind = z.infer<typeof CapabilityKindSchema>;

export const CanonicalCapabilitySchema = z.object({
  id: z.string().min(1),
  kind: CapabilityKindSchema,
  label: z.string().min(1),
  description: z.string().min(1),
  version: z.number().int().positive().default(1),
  aliases: z.array(z.string().min(1)).default([]),
  deprecated: z.boolean().default(false),
});

export const CANONICAL_CAPABILITIES = [
  { id: "model.reasoning", kind: "model", label: "Reasoning", description: "Can reason across multi-step business context." },
  { id: "model.summarization", kind: "model", label: "Summarization", description: "Can summarize long source material." },
  { id: "skill.meeting-prep", kind: "skill", label: "Meeting prep", description: "Can prepare customer or prospect meeting material." },
  { id: "skill.account-research", kind: "skill", label: "Account research", description: "Can research account context." },
  { id: "tool.workspace.read", kind: "tool", label: "Read workspace", description: "Can inspect workspace files." },
  { id: "tool.workspace.write", kind: "tool", label: "Write workspace", description: "Can create or update workspace files." },
  { id: "integration.calendar.events.read", kind: "integration", label: "Calendar events", description: "Can read calendar events." },
  { id: "integration.crm.accounts.read", kind: "integration", label: "CRM accounts", description: "Can read account records." },
] satisfies CanonicalCapability[];
```

Provide helpers:

```ts
export function canonicalCapability(idOrAlias: string): CanonicalCapability | undefined;
export function assertKnownCapability(id: string, kind: CapabilityKind, optional: boolean): string;
```

`assertKnownCapability` normalizes aliases to canonical ids. It rejects unknown required capabilities and allows unknown optional capabilities only when callers explicitly want source-gap behavior.

Plugin, skill, and integration contributed capabilities must be namespaced and registered through metadata before they can satisfy a Playbook requirement. Treat unregistered contributed strings as unknown.

- [ ] **Step 3: Extend workflow requirement contracts**

Add schemas near the workflow step schemas:

```ts
export const WorkflowModelRequirementSchema = z.object({
  acceptableProviders: z.array(z.enum(["openai", "anthropic", "openrouter", "local"])).default([]),
  acceptableModelClasses: z.array(z.string().min(1)).default([]),
  acceptablePortableModelIds: z.array(z.string().min(1)).default([]),
  capabilities: z.array(z.string().min(1)).default([]),
  minContextTokens: z.number().int().positive().optional(),
  dataPolicy: z.enum(["cloud-ok", "workspace-local-ok", "local-only"]).default("cloud-ok"),
});

export const WorkflowCapabilityRequirementSchema = z.object({
  capability: z.string().min(1),
  optional: z.boolean().default(false),
});

export const WorkflowNodeRequirementsSchema = z
  .object({
    model: WorkflowModelRequirementSchema.optional(),
    skills: z.array(WorkflowCapabilityRequirementSchema).default([]),
    tools: z.array(WorkflowCapabilityRequirementSchema).default([]),
    integrations: z.array(WorkflowCapabilityRequirementSchema).default([]),
  })
  .strict();
```

Attach `requires: WorkflowNodeRequirementsSchema.optional()` to both agent and tool workflow step schemas. Do not add `agentId`, `agentLabel`, local skill ids, local tool ids, or integration account ids to manifest schemas.

Normalize every requirement capability through the canonical registry during `WorkflowDefinitionSchema` parsing. Model `capabilities` must be `model.*`, skill requirements must be `skill.*`, tool requirements must be `tool.*`, and integration requirements must be `integration.*`.

Do not allow local model aliases in manifests. `acceptablePortableModelIds` is only for public provider ids such as a hosted model id; local model names belong in the local inventory.

- [ ] **Step 4: Add capability metadata to local resource contracts**

Extend local resource summaries so the resolver has real inputs:

```ts
export const SkillSummarySchema = z.object({
  // existing fields...
  capabilities: z.array(z.string().min(1)).default([]),
});

export const ToolPolicyRuntimeSchema = z.object({
  // existing fields...
  capabilityIds: z.array(z.string().min(1)).default([]),
});

export const IntegrationCapabilitySummarySchema = z.object({
  provider: IntegrationProviderSchema,
  configured: z.boolean(),
  capabilities: z.array(z.string().min(1)).default([]),
  dataPolicies: z.array(z.enum(["cloud-ok", "workspace-local-ok", "local-only"])).default([]),
});

export const ModelCapabilitySummarySchema = z.object({
  provider: AgentProviderConfigSchema,
  credentialAvailable: z.boolean(),
  capabilities: z.array(z.string().min(1)).default([]),
  contextTokens: z.number().int().positive().optional(),
  dataPolicies: z.array(z.enum(["cloud-ok", "workspace-local-ok", "local-only"])).default([]),
  portableModelId: z.string().min(1).optional(),
  modelClass: z.string().min(1).optional(),
});
```

For existing resources without capability metadata, add explicit compatibility mappings:

- Tool policy presets map to `tool.workspace.read`, `tool.workspace.write`, and related canonical ids.
- Existing curated skill ids map to skill capabilities only when the mapping is explicit in the registry.
- Existing integration settings map to integration capabilities only when the provider is configured and authorized.
- Unknown model metadata remains unknown and cannot satisfy required context/data/capability constraints.

- [ ] **Step 5: Add resource inventory and resolved assignment contracts**

Resolved assignments are local run metadata, not manifest metadata:

```ts
export const WorkflowNodeAssignmentSchema = z.object({
  stepId: z.string().min(1),
  agentId: z.string().min(1).optional(),
  agentLabel: z.string().min(1).optional(),
  agentFingerprint: z.string().min(1).optional(),
  provider: AgentProviderConfigSchema.optional(),
  providerFingerprint: z.string().min(1).optional(),
  credentialRef: z.string().min(1).optional(),
  skillIds: z.array(z.string().min(1)).default([]),
  skillFingerprints: z.record(z.string().min(1)).default({}),
  toolCapabilities: z.array(z.string().min(1)).default([]),
  integrationIds: z.array(z.string().min(1)).default([]),
  integrationFingerprints: z.record(z.string().min(1)).default({}),
});

export const WorkflowRunAssignmentPlanSchema = z.object({
  assignments: z.record(WorkflowNodeAssignmentSchema),
  resolverVersion: z.number().int().positive(),
  createdAt: z.string().datetime(),
});
```

Add `assignmentPlan: WorkflowRunAssignmentPlanSchema.optional()` to `WorkflowRunRequestSchema`, `WorkflowResumeRequestSchema`, and `WorkflowRunResultSchema`. This is non-secret and may be checkpointed. Credentials are not part of the assignment plan.

Add `capabilityInventory: WorkflowCapabilityInventorySchema.optional()` to `WorkflowRunRequestSchema` and `WorkflowResumeRequestSchema`. This is request-scoped validation input and must not be checkpointed.

Add resolver input/output schemas. The resolver must receive a sanitized local inventory, not raw keychain contents:

```ts
export const WorkflowCapabilityInventorySchema = z.object({
  agents: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      fingerprint: z.string().min(1),
      model: AgentProviderConfigSchema.optional(),
      modelCapabilities: z.array(z.string().min(1)).default([]),
      contextTokens: z.number().int().positive().optional(),
      dataPolicies: z.array(z.enum(["cloud-ok", "workspace-local-ok", "local-only"])).default([]),
      skillCapabilities: z.array(z.string().min(1)).default([]),
      toolCapabilities: z.array(z.string().min(1)).default([]),
    })
  ),
  integrations: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      fingerprint: z.string().min(1),
      capabilities: z.array(z.string().min(1)),
      dataPolicies: z.array(z.enum(["cloud-ok", "workspace-local-ok", "local-only"])).default([]),
      configured: z.boolean(),
    })
  ),
});
```

Add a request-scoped credential map keyed by `credentialRef` from the assignment plan:

```ts
export const WorkflowExecutionConfigSchema = z.object({
  credentials: z.record(z.object({ apiKey: z.string().min(1) })).default({}),
});
```

- [ ] **Step 6: Implement capability resolution before launch**

Add a resolver in `apps/sidecar/src/server.ts` or a focused helper module. It should:

- Inspect each step's `requires`.
- Build candidate resources from the sanitized capability inventory.
- Match model requirements against explicit model capability metadata, context limits, and data policy. Unknown model metadata cannot satisfy a required constraint.
- Match skill requirements by canonical capability ids, not raw skill ids.
- Match tool requirements against profile runtime/tool policy capability classes.
- Match integration requirements against available connector capability metadata.
- Choose the highest-ranked valid candidate automatically when there is a clear winner.
- Return a short clarification prompt only when two candidates remain tied after ranking or when the choice changes material business risk.
- Return a business-readable error when a required capability has no candidate.

Expose the resolver through a sidecar endpoint used by Tauri before run creation/resume:

- `POST /playbooks/:id/resolve`
- Body: `{ input, capabilityInventory, existingAssignmentPlan? }`
- Response success: `{ assignmentPlan, sourceGaps: [], warnings: [] }`
- Response blocked: `{ error, missingCapabilities, sourceGaps, clarification? }`

The sidecar must also validate `assignmentPlan` against `capabilityInventory` again inside `POST /playbooks/:id/runs` and `POST /playbook-runs/:runId/resume`. A missing inventory, stale plan, tampered plan, or incomplete plan must fail before any node executes.

Ranking order for MVP:

1. Exact model/provider fit.
2. Agent profile already has all required skill capability tags.
3. Least-privilege tool policy that still satisfies the node.
4. Data policy fit: local-only > workspace-local-ok > cloud-ok when the node allows multiple.
5. User/default profile as tie-breaker.
6. If business-visible fields still differ, return a clarification instead of silently choosing.
7. Stable id sort only for indistinguishable duplicate candidates after all business-visible ranking fields match.

Do not show a default assignment selector in the intake form. Only surface a guided blocker if no valid assignment exists.

- [ ] **Step 7: Build sanitized inventory and attach credentials in Tauri**

Update `apps/desktop/src-tauri/src/lib.rs` playbook run/resume commands:

- Build a sanitized capability inventory from local agent profiles, model settings, skill metadata, tool policy metadata, integration settings, and credential availability booleans.
- Call the sidecar resolver before run creation/resume if the request lacks an assignment plan.
- Read provider credentials from the OS keychain for each `credentialRef` in the resolved plan.
- Send `assignmentPlan`, `capabilityInventory`, and request-scoped `execution.credentials` to sidecar.
- Return the existing business-readable model settings error if a required cloud credential is missing.

Do not store `execution.credentials` in checkpoints, events, or run result records.
Do not include raw integration tokens, API keys, refresh tokens, or keychain
aliases in the inventory. Only send capability ids, configured booleans,
fingerprints, data-policy metadata, and display labels.

- [ ] **Step 8: Pass per-node assignment into core agent steps**

In `packages/core/src/workflow.ts`, when executing an agent step:

- Find `assignmentPlan.assignments[step.id]`.
- Revalidate assignment fingerprints against the current sanitized inventory before running or resuming a node.
- If the assignment is stale, pause with a setup-changed error and require re-resolution before continuing.
- Resolve the assigned agent profile/runtime and provider from that assignment.
- Pass agent profile, runtime, provider, and credential to `runPiTaskTurn`.
- Preserve the assignment plan in checkpoints so approval resume is deterministic.
- Preserve `sourceGaps` from optional missing requirements in the run result so the Result view can show coverage gaps without treating them as failures.

Tool steps should use required tool capability classes for permission copy and validation, while still executing through the existing tool registry. Capability resolution is not a permission grant; write and integration mutations still use existing Action Inbox approval behavior.

- [ ] **Step 9: Add resolver tests**

Add focused tests for:

- A node resolves to different agents for different steps in the same playbook.
- Manifest requirements cannot name local agent ids or labels.
- Unknown required capability ids fail contract validation.
- Unknown optional capability ids become source gaps.
- Missing required model capability blocks launch before run creation.
- Missing optional integration is reported as a source gap, not a launch blocker.
- Resume reuses the checkpointed assignment plan.
- Resume blocks and re-resolves when an assigned agent/profile/integration fingerprint changes.
- Run creation rejects a client-provided assignment plan that does not satisfy manifest requirements.
- Run creation and resume reject an assignment plan when the request omits the sanitized inventory.
- `local-only` requirements reject cloud providers even when credentials exist.
- Capability resolution does not bypass Action Inbox approval for write/mutation steps.
- Credentials are accepted per request and never persisted in the run checkpoint.
- Optional missing requirements are persisted as `sourceGaps` for the Result view.

- [ ] **Step 10: Run focused checks**

Run:

```bash
bun test packages/contracts/src/workflow.test.ts
bun test packages/core/src/workflow.test.ts
bun run --filter './apps/sidecar' typecheck
```

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/src/workflow.test.ts packages/core/src/workflow.ts packages/core/src/workflow.test.ts apps/sidecar/src/server.ts apps/desktop/src-tauri/src/lib.rs
git commit -m "Resolve playbook nodes by capability requirements"
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
import type { PlaybookDetail, PlaybookSummary } from "@tessera/contracts";
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
    expect(screen.queryByLabelText("Run with")).toBeNull();
    expect(screen.getByRole("button", { name: "Prepare brief" })).toBeTruthy();
  });

  test("submits normalized input with hidden workspace root", async () => {
    const onStart = mock(() => {});
    render(
      <PlaybookIntakeForm
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

    expect(onStart).toHaveBeenCalledWith({
      company: "Globex",
      objective: "Agree next steps",
      sources: ["web"],
      workspaceRoot: "/workspace/acme",
    });
  });

  test("disables start when workspace is missing", () => {
    render(
      <PlaybookIntakeForm
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
        disabled={false}
        playbook={playbook}
        playbookDetail={null}
        workspaceRoot="/workspace/acme"
        onStart={() => {}}
      />
    );

    rerender(
      <PlaybookIntakeForm
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
import type { PlaybookDetail, PlaybookSummary, WorkflowInputDefinition } from "@tessera/contracts";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  defaultPlaybookInput,
  hasRequiredPlaybookInput,
  playbookActionLabel,
  userInputDefinitions,
} from "@/lib/playbooks";

interface PlaybookIntakeFormProps {
  disabled: boolean;
  playbook: PlaybookSummary;
  playbookDetail: PlaybookDetail | null;
  workspaceRoot: string | null;
  onStart: (input: Record<string, unknown>) => void;
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
          onClick={() => onStart({ ...input, workspaceRoot: workspaceRoot ?? "" })}
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
import type { PlaybookDetail, PlaybookRunDetail, PlaybookSummary } from "@tessera/contracts";
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
  playbook: PlaybookSummary;
  playbookDetail: PlaybookDetail | null;
  run: PlaybookRunDetail | null;
  running: boolean;
  workspaceRoot: string | null;
  onStart: (input: Record<string, unknown>) => void;
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
import type { PlaybookDetail, PlaybookListResult, PlaybookRunDetail, PlaybookSummary } from "@tessera/contracts";
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
  }, [loadPlaybooks]);

  useEffect(() => {
    void loadRuns(selectedPlaybookId);
    if (selectedPlaybookId) void loadPlaybookDetail(selectedPlaybookId);
  }, [loadPlaybookDetail, loadRuns, selectedPlaybookId]);

  async function startRun(input: Record<string, unknown>) {
    if (!selectedPlaybook) return;
    setRunning(true);
    setError(null);
    try {
      const run = await invoke<PlaybookRunDetail>("playbook_run_create", {
        playbookId: selectedPlaybook.id,
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
