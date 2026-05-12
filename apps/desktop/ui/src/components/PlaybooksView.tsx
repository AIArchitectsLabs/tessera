import { Button } from "@/components/ui/button";
import { integrationLabel, searchProviderLabel } from "@/lib/integrationSettings";
import { providerLabel } from "@/lib/modelSettings";
import { isDashboardPlaybook, playbookApprovalCopy } from "@/lib/playbooks";
import { cn } from "@/lib/utils";
import { invoke } from "@tauri-apps/api/core";
import type {
  AgentProfile,
  AgentProfileListResult,
  DashboardLayout,
  IntegrationSettingsRead,
  ModelSettingsRead,
  PlaybookAssignmentPreviewResult,
  PlaybookDetail,
  PlaybookListResult,
  PlaybookRunDetail,
  PlaybookRunPreferenceReadResult,
  PlaybookSummary,
  TokenUsage,
  WorkflowCapabilityInventory,
  WorkflowInputDefinition,
  WorkflowNodeAssignment,
  WorkflowResumeRequest,
  WorkflowRunAssignmentPlan,
  WorkflowRunEvent,
  WorkflowRunListResult,
  WorkflowRunRequest,
  WorkflowRunStepRecord,
} from "@tessera/contracts";
import { AlertTriangle, CheckCircle2, Clock3, FileText, Loader2, RefreshCw, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DashboardView } from "./DashboardView";
import { PlaybookRefreshButton } from "./PlaybookRefreshButton";
import { WorkspacePicker } from "./WorkspacePicker";

interface PlaybooksViewProps {
  workspaceRoot: string | null;
  onWorkspaceSelect: (path: string) => void;
}

const statusCopy: Record<PlaybookRunDetail["status"], string> = {
  running: "In progress",
  blocked: "Needs review",
  completed: "Ready",
  denied: "Stopped",
  failed: "Needs attention",
};

const statusClass: Record<PlaybookRunDetail["status"], string> = {
  running: "border-blue-200 bg-blue-50 text-blue-700",
  blocked: "border-amber-200 bg-amber-50 text-amber-700",
  completed: "border-emerald-200 bg-emerald-50 text-emerald-700",
  denied: "border-zinc-200 bg-zinc-100 text-zinc-600",
  failed: "border-red-200 bg-red-50 text-red-700",
};

const ctaCopyMap: Record<string, string> = {
  "sales.meeting-brief": "Prepare brief",
  "customer.renewal-risk-review": "Prepare risk review",
  "operations.weekly-status-digest": "Create digest",
  "ops.activity-snapshot": "Create snapshot",
  "demo.write-approval": "Start demo",
  "weekly-update": "Prepare update",
};

const resultHeadline: Partial<Record<PlaybookRunDetail["status"], (name: string) => string>> = {
  completed: (name) => `${name} is ready.`,
  denied: () => "Run stopped.",
  failed: () => "Needs attention.",
  blocked: () => "Waiting for your review.",
};

const resultSub: Partial<Record<PlaybookRunDetail["status"], string>> = {
  completed: "Tessera finished preparing what you asked for.",
  denied: "You stopped the run before it finished. Nothing was changed.",
  failed: "Tessera ran into a problem and could not finish this run.",
  blocked: "This run needs a decision before it can continue.",
};

function stepIcon(status: WorkflowRunStepRecord["status"]) {
  if (status === "succeeded") return <CheckCircle2 size={16} className="text-emerald-600" />;
  if (status === "running") return <Loader2 size={16} className="animate-spin text-blue-600" />;
  if (status === "blocked") return <AlertTriangle size={16} className="text-amber-600" />;
  return <Clock3 size={16} className="text-muted-foreground" />;
}

function stepStatusLabel(status: WorkflowRunStepRecord["status"]): string {
  if (status === "succeeded") return "Done";
  if (status === "running") return "Working";
  if (status === "blocked") return "Waiting for your review";
  if (status === "failed") return "Needs attention";
  if (status === "denied") return "Stopped";
  return "Not started";
}

function titleFromId(id: string): string {
  return id
    .split(/[._-]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatTime(value?: string): string {
  if (!value) return "Not started";
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatTokens(value: number): string {
  if (value < 1000) return new Intl.NumberFormat("en-US").format(value);
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  })
    .format(value)
    .replace(/[A-Z]/g, (char) => char.toLowerCase());
}

function formatCapabilityLabel(value: string): string {
  return titleFromId(value.replace(/^(?:skill|tool|integration)\./, ""));
}

function joinLabels(values: string[]): string {
  if (values.length === 0) return "";
  if (values.length === 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  const last = values[values.length - 1];
  return `${values.slice(0, -1).join(", ")}, and ${last}`;
}

function summarizeAssignment(assignment: WorkflowNodeAssignment | undefined): string {
  if (!assignment) return "Not matched yet";
  const parts: string[] = [];
  if (assignment.agentLabel) {
    parts.push(`Assigned to ${assignment.agentLabel}`);
  }
  if (assignment.provider) {
    parts.push(`${providerLabel(assignment.provider.provider)} · ${assignment.provider.model}`);
  }
  if (assignment.skillCapabilities.length > 0) {
    parts.push(`Skills: ${joinLabels(assignment.skillCapabilities.map(formatCapabilityLabel))}`);
  }
  if (assignment.toolCapabilities.length > 0) {
    parts.push(`Tools: ${joinLabels(assignment.toolCapabilities.map(formatCapabilityLabel))}`);
  }
  if (assignment.integrationCapabilities.length > 0) {
    parts.push(
      `Integrations: ${joinLabels(assignment.integrationCapabilities.map(formatCapabilityLabel))}`
    );
  }
  return parts.length > 0 ? parts.join(" • ") : "Matched";
}

function roleLabelFromStep(label: string): string {
  const normalized = label.toLowerCase();
  if (normalized.includes("brief")) return "Brief writer";
  if (normalized.includes("digest")) return "Digest writer";
  if (normalized.includes("snapshot")) return "Snapshot analyst";
  if (normalized.includes("review")) return "Review specialist";
  if (normalized.includes("research")) return "Research specialist";
  return "Playbook specialist";
}

function summarizeValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "Not provided";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => summarizeValue(item)).join(", ");
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "Empty";
    return entries
      .slice(0, 2)
      .map(([key, nested]) => `${formatCapabilityLabel(key)}: ${summarizeValue(nested)}`)
      .join(" • ");
  }
  return String(value);
}

function valueString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function filePathFromValue(value: unknown): string | null {
  const direct = valueString(value);
  if (direct) {
    const savedPath =
      direct.match(/(?:saved|written|created)(?:\s+\w+){0,4}\s+(?:to|at):?\s+`([^`]+)`/i)?.[1] ??
      direct.match(/(?:file|path):\s+`([^`]+)`/i)?.[1];
    if (savedPath) return savedPath.trim();

    const codePath = [...direct.matchAll(/`([^`]+\.[A-Za-z0-9]{1,8})`/g)][0]?.[1];
    return codePath?.trim() ?? null;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  for (const key of ["path", "filePath", "filepath", "outputPath", "artifactPath"]) {
    const candidate = valueString(record[key]);
    if (candidate) return candidate;
  }

  return filePathFromValue(record.text);
}

function displayPath(path: string | null): string | null {
  if (!path) return null;
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function isAgentDraftOutput(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.text === "string" && typeof record.boundaryViolations === "number";
}

function isApprovalOutput(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.target === "string" && typeof record.mutated === "boolean";
}

function playbookOutputValue(kind: string, runOutputs: Record<string, unknown>): unknown {
  const values = Object.values(runOutputs);

  if (kind === "approvalRequest") {
    return values.find(isApprovalOutput);
  }

  if (
    kind === "meetingBrief" ||
    kind === "businessBrief" ||
    kind === "statusDigest" ||
    kind === "sourceSummary"
  ) {
    return values.find(isAgentDraftOutput) ?? values.find((value) => filePathFromValue(value));
  }

  return undefined;
}

function playbookOutputSummary(
  kind: string,
  value: unknown,
  sourceGapCount: number,
  artifactPath: string | null
): string | null {
  if (kind === "meetingBrief" || kind === "businessBrief") {
    const fileName = displayPath(artifactPath);
    return fileName
      ? `Brief created and saved as ${fileName}.`
      : "Brief created and ready to review.";
  }

  if (kind === "statusDigest") {
    const fileName = displayPath(artifactPath);
    return fileName
      ? `Digest created and saved as ${fileName}.`
      : "Digest created and ready to review.";
  }

  if (kind === "sourceSummary") {
    if (sourceGapCount === 0) {
      return "Tessera used the available selected sources and noted its assumptions in the brief.";
    }
    return `${sourceGapCount} selected source${sourceGapCount === 1 ? "" : "s"} could not be used. The brief includes the gap${sourceGapCount === 1 ? "" : "s"}.`;
  }

  if (kind === "approvalRequest") {
    if (!isApprovalOutput(value)) return "Workspace preparation review is complete.";
    const record = value as Record<string, unknown>;
    return record.mutated === true
      ? "Workspace preparation was approved and applied."
      : "Workspace preparation was reviewed. No workspace files were changed.";
  }

  return value !== undefined ? summarizeValue(value) : null;
}

function sourceLabels(input: Record<string, unknown>): string[] {
  const sources = input.sources;
  if (!Array.isArray(sources)) return [];
  return sources.filter((source): source is string => typeof source === "string").map(titleFromId);
}

function playbookSourceSummary(input: Record<string, unknown>, sourceGapCount: number): string {
  const labels = sourceLabels(input);
  const selected = labels.length > 0 ? joinLabels(labels) : "selected research sources";

  if (sourceGapCount === 0) {
    return `Research requested: ${selected}. Source notes and assumptions are included in the brief.`;
  }

  return `Research requested: ${selected}. ${sourceGapCount} selected source${sourceGapCount === 1 ? "" : "s"} unavailable; gaps are included in the brief.`;
}

function shouldShowResultOutput(kind: string, value: unknown): boolean {
  if (kind === "sourceSummary") return false;
  if (kind !== "approvalRequest") return true;
  return isApprovalOutput(value) && (value as Record<string, unknown>).mutated === true;
}

function inputDisplayValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => summarizeValue(item)).join(", ");
  return summarizeValue(value);
}

function orderedPhases(
  playbook: PlaybookSummary | PlaybookDetail | null,
  run: PlaybookRunDetail | null
): string[] {
  const phaseOrder = playbook?.phases ?? [];
  const runPhases = run?.steps?.map((step) => step.phase).filter((p): p is string => !!p) ?? [];
  return [...new Set([...phaseOrder, ...runPhases])];
}

function outputLabels(playbook?: PlaybookSummary | PlaybookDetail): string[] {
  return playbook?.outputs?.map((output) => output.label) ?? ["Result"];
}

function stepAssignment(
  step: WorkflowRunStepRecord,
  run: PlaybookRunDetail | null
): WorkflowNodeAssignment | undefined {
  return step.assignment ?? run?.assignmentPlan?.assignments[step.id];
}

function hashText(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `ui-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function buildCapabilityInventory(
  modelSettings: ModelSettingsRead | null,
  integrationSettings: IntegrationSettingsRead | null,
  agentProfiles: AgentProfile[],
  workspaceRoot: string | null
): WorkflowCapabilityInventory | null {
  if (!modelSettings || !integrationSettings) return null;

  const providerSettingsByProvider = new Map(
    Object.values(modelSettings.providers).map((provider) => [provider.provider, provider])
  );
  const defaultProvider =
    modelSettings.providers[modelSettings.selectedProvider] ??
    modelSettings.providers.openai ??
    Object.values(modelSettings.providers)[0];
  if (!defaultProvider) return null;

  const agents = agentProfiles.map((profile) => {
    const model =
      profile.model.mode === "override"
        ? (providerSettingsByProvider.get(profile.model.provider.provider) ?? defaultProvider)
        : defaultProvider;
    const loweredModel = model.model.toLowerCase();
    const loweredName = profile.name.toLowerCase();
    const modelCapabilities = [
      ...(loweredModel.includes("gpt-5.4") ||
      loweredModel.includes("gpt-4.1") ||
      loweredModel.includes("sonnet") ||
      loweredName.includes("reason")
        ? ["model.reasoning"]
        : []),
      ...(loweredModel.includes("summary") || loweredName.includes("summary")
        ? ["model.summarization"]
        : []),
    ];

    return {
      id: profile.id,
      label: profile.name,
      fingerprint: hashText(
        JSON.stringify({
          id: profile.id,
          model: profile.model,
          skills: profile.skills,
          toolPolicyPreset: profile.toolPolicyPreset,
          updatedAt: profile.updatedAt,
        })
      ),
      model,
      modelCapabilities,
      dataPolicies: [model.provider === "local" ? "local-only" : "cloud-ok"] as (
        | "cloud-ok"
        | "workspace-local-ok"
        | "local-only"
      )[],
      skillCapabilities: profile.skills.map((skillId) =>
        skillId.startsWith("skill.") ? skillId : `skill.${skillId}`
      ),
      toolCapabilities:
        profile.toolPolicyPreset === "read_only"
          ? ["tool.workspace.read"]
          : ["tool.workspace.read", "tool.workspace.write"],
    };
  });

  const integrations = [
    {
      id: "integration.google-workspace",
      label: integrationLabel("google-workspace"),
      fingerprint: hashText(
        JSON.stringify({
          id: "integration.google-workspace",
          configured: integrationSettings.providers.googleWorkspace.hasCredential,
        })
      ),
      capabilities: [
        "integration.calendar.events.read",
        "integration.mail.read",
        "integration.drive.read",
        "integration.contacts.read",
      ],
      configured: integrationSettings.providers.googleWorkspace.hasCredential,
      dataPolicies: [
        integrationSettings.providers.googleWorkspace.hasCredential
          ? "cloud-ok"
          : "workspace-local-ok",
      ] as ("cloud-ok" | "workspace-local-ok" | "local-only")[],
    },
    {
      id: "integration.brave-search",
      label: "Brave Search",
      fingerprint: hashText(
        JSON.stringify({
          id: "integration.brave-search",
          configured: integrationSettings.providers.braveSearch.hasCredential,
        })
      ),
      capabilities: ["integration.search.read"],
      configured: integrationSettings.providers.braveSearch.hasCredential,
      dataPolicies: [
        integrationSettings.providers.braveSearch.hasCredential ? "cloud-ok" : "workspace-local-ok",
      ] as ("cloud-ok" | "workspace-local-ok" | "local-only")[],
    },
    {
      id: "integration.tavily",
      label: searchProviderLabel("tavily"),
      fingerprint: hashText(
        JSON.stringify({
          id: "integration.tavily",
          configured: integrationSettings.search.providers.tavily.hasCredential,
        })
      ),
      capabilities: ["integration.search.read"],
      configured: integrationSettings.search.providers.tavily.hasCredential,
      dataPolicies: [
        integrationSettings.search.providers.tavily.hasCredential
          ? "cloud-ok"
          : "workspace-local-ok",
      ] as ("cloud-ok" | "workspace-local-ok" | "local-only")[],
    },
    {
      id: "integration.duckduckgo",
      label: searchProviderLabel("duckduckgo"),
      fingerprint: hashText(
        JSON.stringify({
          id: "integration.duckduckgo",
          configured: integrationSettings.search.providers.duckduckgo.hasCredential,
        })
      ),
      capabilities: ["integration.search.read"],
      configured: integrationSettings.search.providers.duckduckgo.hasCredential,
      dataPolicies: [
        integrationSettings.search.providers.duckduckgo.hasCredential
          ? "cloud-ok"
          : "workspace-local-ok",
      ] as ("cloud-ok" | "workspace-local-ok" | "local-only")[],
    },
  ];

  const base = {
    agents,
    integrations,
    models: Object.values(modelSettings.providers).map((provider) => ({
      provider: provider.provider,
      model: provider.model,
      label: providerLabel(provider.provider),
      hasCredential: provider.hasCredential,
      capabilities:
        provider.provider === "local"
          ? ["model.reasoning"]
          : ["model.reasoning", "model.summarization"],
      dataPolicy: (provider.provider === "local" ? "local-only" : "cloud-ok") as
        | "cloud-ok"
        | "workspace-local-ok"
        | "local-only",
    })),
    skills: [...new Set(agentProfiles.flatMap((profile) => profile.skills))].map((skillId) => ({
      id: skillId,
      label: formatCapabilityLabel(skillId),
    })),
    tools: [
      { id: "tool.workspace.read", label: "Read workspace" },
      { id: "tool.workspace.write", label: "Write workspace" },
    ],
  };
  return {
    fingerprint: hashText(
      JSON.stringify({
        workspaceRoot,
        ...base,
      })
    ),
    ...base,
  };
}

function initFormValues(inputs: Record<string, WorkflowInputDefinition>): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(inputs)) {
    if (key === "workspaceRoot" || spec.group === "System") continue;
    if (spec.default !== undefined) {
      values[key] = spec.default;
    } else if (spec.ui?.control === "date") {
      values[key] = new Date().toISOString().slice(0, 10);
    } else if (spec.type === "string[]") {
      values[key] = [];
    } else if (spec.type === "boolean") {
      values[key] = false;
    } else if (spec.type === "number") {
      values[key] = 0;
    } else {
      values[key] = "";
    }
  }
  return values;
}

function Section({
  title,
  children,
  subtitle,
}: {
  title: string;
  children: ReactNode;
  subtitle?: string;
}) {
  return (
    <section>
      <div className="mb-2">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {title}
        </h3>
        {subtitle ? <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p> : null}
      </div>
      {children}
    </section>
  );
}

function UsageSummary({ usage }: { usage: TokenUsage | undefined }) {
  if (!usage) {
    return (
      <div className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
        Not reported by provider.
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border bg-background px-3 py-2">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        Usage
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>Input {formatTokens(usage.inputTokens)} tokens</span>
        <span>Output {formatTokens(usage.outputTokens)} tokens</span>
        <span>Total {formatTokens(usage.totalTokens)} tokens</span>
        {usage.cachedInputTokens !== undefined ? (
          <span>Cached {formatTokens(usage.cachedInputTokens)} tokens</span>
        ) : null}
        {usage.reasoningTokens !== undefined ? (
          <span>Reasoning {formatTokens(usage.reasoningTokens)} tokens</span>
        ) : null}
      </div>
    </div>
  );
}

function RunEventItem({ event }: { event: WorkflowRunEvent }) {
  return (
    <div className="rounded-md border border-border bg-background px-3 py-2">
      <div className="text-sm font-medium text-foreground">{event.message}</div>
      <div className="mt-1 text-xs text-muted-foreground">{formatTime(event.createdAt)}</div>
    </div>
  );
}

function IntakeField({
  fieldKey,
  spec,
  value,
  onChange,
  disabled,
}: {
  fieldKey: string;
  spec: WorkflowInputDefinition;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled: boolean;
}) {
  const control = spec.ui?.control ?? (spec.type === "boolean" ? "checkbox" : "text");
  const fieldId = `intake-${fieldKey}`;
  const inputClass =
    "w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-primary/30";

  return (
    <div>
      {control !== "checkbox" && (
        <label htmlFor={fieldId} className="mb-1.5 block text-sm font-medium text-foreground">
          {spec.label ?? titleFromId(fieldKey)}
          {spec.required ? <span className="ml-1 text-muted-foreground">*</span> : null}
        </label>
      )}
      {spec.description ? (
        <p className="mb-2 text-xs text-muted-foreground">{spec.description}</p>
      ) : null}

      {control === "textarea" ? (
        <textarea
          id={fieldId}
          className={cn(inputClass, "min-h-[80px]")}
          placeholder={spec.placeholder}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
        />
      ) : control === "date" ? (
        <input
          id={fieldId}
          type="date"
          className={inputClass}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
        />
      ) : control === "checkbox" ? (
        <label className="flex cursor-pointer items-center gap-2">
          <input
            id={fieldId}
            type="checkbox"
            className="h-4 w-4 rounded border-border"
            checked={typeof value === "boolean" ? value : false}
            onChange={(e) => onChange(e.target.checked)}
            disabled={disabled}
          />
          <span className="text-sm font-medium text-foreground">
            {spec.label ?? titleFromId(fieldKey)}
          </span>
        </label>
      ) : control === "multiselect" ? (
        <div className="flex flex-wrap gap-2">
          {(spec.options ?? []).map((option) => {
            const currentValues = Array.isArray(value) ? (value as string[]) : [];
            const selected = currentValues.includes(option.value);
            return (
              <button
                key={option.value}
                type="button"
                disabled={disabled}
                className={cn(
                  "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50",
                  selected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background text-foreground hover:border-primary/40"
                )}
                onClick={() => {
                  onChange(
                    selected
                      ? currentValues.filter((v) => v !== option.value)
                      : [...currentValues, option.value]
                  );
                }}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      ) : (
        <input
          id={fieldId}
          type="text"
          className={inputClass}
          placeholder={spec.placeholder}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
        />
      )}
    </div>
  );
}

function GuidedStart({
  playbook,
  playbookDetail,
  assignmentPreview,
  draftAssignmentPlan,
  agentsConfirmed,
  formValues,
  onFieldChange,
  onStart,
  onConfirmAgents,
  onAssignmentPlanChange,
  formReady,
  running,
  savingPreference,
  workspaceRoot,
  capabilityInventory,
}: {
  playbook: PlaybookSummary;
  playbookDetail: PlaybookDetail | null;
  assignmentPreview: PlaybookAssignmentPreviewResult | null;
  draftAssignmentPlan: WorkflowRunAssignmentPlan | null;
  agentsConfirmed: boolean;
  formValues: Record<string, unknown>;
  onFieldChange: (key: string, value: unknown) => void;
  onStart: () => void;
  onConfirmAgents: () => void;
  onAssignmentPlanChange: (plan: WorkflowRunAssignmentPlan) => void;
  formReady: boolean;
  running: boolean;
  savingPreference: boolean;
  workspaceRoot: string | null;
  capabilityInventory: WorkflowCapabilityInventory | null;
}) {
  const ctaCopy = ctaCopyMap[playbook.id] ?? "Start playbook";
  const [setupEditorOpen, setSetupEditorOpen] = useState(false);
  const [workflowDetailsOpen, setWorkflowDetailsOpen] = useState(false);
  const detail = playbookDetail?.id === playbook.id ? playbookDetail : null;
  const inputs = detail?.inputs ?? {};
  const workflowSteps = detail?.steps ?? [];
  const nodePreviews = useMemo(() => {
    const previews = new Map<
      string,
      NonNullable<PlaybookAssignmentPreviewResult["nodePreviews"]>[number]
    >();
    for (const nodePreview of assignmentPreview?.nodePreviews ?? []) {
      previews.set(nodePreview.stepId, nodePreview);
    }
    return previews;
  }, [assignmentPreview]);
  const blockers = assignmentPreview?.blockers ?? [];
  const canConfirmAgents =
    !!workspaceRoot &&
    !!draftAssignmentPlan &&
    !running &&
    !savingPreference &&
    blockers.length === 0 &&
    !!assignmentPreview;
  const canSubmit =
    formReady &&
    !!workspaceRoot &&
    !running &&
    blockers.length === 0 &&
    !!draftAssignmentPlan &&
    agentsConfirmed;
  const agentSteps = workflowSteps.filter((step) => step.kind === "agent");
  const savedAgentLabels = [
    ...new Set(
      agentSteps
        .map((step) => draftAssignmentPlan?.assignments[step.id]?.agentLabel)
        .filter((label): label is string => !!label)
    ),
  ];
  const savedSetupSummary =
    savedAgentLabels.length > 0 ? `Using saved setup: ${joinLabels(savedAgentLabels)}` : null;

  function selectCandidate(stepId: string, agentId: string) {
    if (!draftAssignmentPlan) return;
    const candidate = nodePreviews
      .get(stepId)
      ?.candidates.find((item) => item.agentId === agentId && !item.disabled);
    if (!candidate) return;
    onAssignmentPlanChange({
      ...draftAssignmentPlan,
      assignments: {
        ...draftAssignmentPlan.assignments,
        [stepId]: candidate.assignment,
      },
    });
  }

  const fields = Object.entries(inputs)
    .filter(([key, spec]) => key !== "workspaceRoot" && spec.group !== "System")
    .sort(([, a], [, b]) => (a.order ?? 99) - (b.order ?? 99));

  const groups = new Map<string, [string, WorkflowInputDefinition][]>();
  for (const field of fields) {
    const group = field[1].group ?? "";
    const list = groups.get(group) ?? [];
    list.push(field);
    groups.set(group, list);
  }

  const showSetupEditor = setupEditorOpen || !agentsConfirmed;
  const preflightPanel = !showSetupEditor ? (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-secondary/30 px-4 py-3">
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">
          {savedSetupSummary ?? "Using saved setup"}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Tessera will use this setup for this workspace.
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="rounded-md"
        onClick={() => setSetupEditorOpen(true)}
      >
        Setup
      </Button>
    </div>
  ) : (
    <div className="rounded-lg border border-border bg-secondary/30 p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-foreground">Playbook setup</div>
          <p className="mt-1 text-xs text-muted-foreground">
            {agentsConfirmed
              ? "Update who Tessera should use for this playbook."
              : "Tessera is selected for this playbook. You can keep this setup or change it before running."}
          </p>
        </div>
        {blockers.length > 0 ? (
          <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700">
            Blocked
          </span>
        ) : agentsConfirmed ? (
          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
            Confirmed
          </span>
        ) : (
          <span className="rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            Needs setup
          </span>
        )}
      </div>

      {!workspaceRoot ? (
        <p className="text-xs text-muted-foreground">
          Select a workspace to load the assignment preview.
        </p>
      ) : !capabilityInventory ? (
        <p className="text-xs text-muted-foreground">
          Loading setup before the assignment preview can run.
        </p>
      ) : assignmentPreview ? (
        agentSteps.length > 0 ? (
          <div className="space-y-2">
            {agentSteps.map((step) => {
              const preview = nodePreviews.get(step.id);
              const assignment = draftAssignmentPlan?.assignments[step.id];
              const recommendedLabel =
                preview?.recommendedAgentLabel ?? preview?.candidates[0]?.agentLabel ?? null;
              const selectedAgentId =
                assignment?.agentId ??
                preview?.recommendedAgentId ??
                preview?.candidates[0]?.agentId ??
                "";
              const stepLabel = step.label ?? preview?.stepLabel ?? titleFromId(step.id);
              return (
                <div
                  key={step.id}
                  className="flex items-start justify-between gap-4 rounded-md border border-border bg-background px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-foreground">
                      {roleLabelFromStep(stepLabel)}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{stepLabel}</div>
                  </div>
                  <div className="max-w-[50%] text-right text-xs text-muted-foreground">
                    {setupEditorOpen && preview?.candidates.length ? (
                      <select
                        className="min-w-32 rounded-md border border-border bg-background px-2 py-1 text-sm font-medium text-foreground outline-none"
                        value={selectedAgentId}
                        onChange={(event) => selectCandidate(step.id, event.target.value)}
                        disabled={running || savingPreference}
                        aria-label={`Agent for ${roleLabelFromStep(stepLabel)}`}
                      >
                        {preview.candidates.map((candidate) => (
                          <option
                            key={candidate.agentId}
                            value={candidate.agentId}
                            disabled={candidate.disabled}
                          >
                            {candidate.agentLabel}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <div className="font-medium text-foreground">
                        {assignment?.agentLabel ?? recommendedLabel ?? "Not assigned"}
                      </div>
                    )}
                    {recommendedLabel ? (
                      <div className="mt-0.5">Recommended: {recommendedLabel}</div>
                    ) : null}
                  </div>
                </div>
              );
            })}
            {setupEditorOpen ? (
              <div className="pt-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-auto rounded-md px-0 text-xs text-muted-foreground hover:bg-transparent hover:text-foreground"
                  onClick={() => setWorkflowDetailsOpen((open) => !open)}
                >
                  Workflow details
                </Button>
                {workflowDetailsOpen ? (
                  <div className="mt-2 space-y-2 rounded-md border border-border bg-background p-3">
                    {workflowSteps.map((step) => {
                      const assignment = draftAssignmentPlan?.assignments[step.id];
                      return (
                        <div
                          key={step.id}
                          className="flex items-start justify-between gap-4 text-xs"
                        >
                          <div>
                            <div className="font-medium text-foreground">
                              {step.label ?? titleFromId(step.id)}
                            </div>
                            <div className="mt-0.5 text-muted-foreground">
                              {step.kind === "agent" ? "Agent step" : "Tool step"}
                              {step.phase ? ` · ${step.phase}` : ""}
                            </div>
                          </div>
                          <div className="max-w-[50%] text-right text-muted-foreground">
                            {step.kind === "agent"
                              ? (assignment?.agentLabel ?? "Not assigned")
                              : "Handled by workflow"}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : workflowSteps.length > 0 ? (
          <div className="space-y-2">
            {workflowSteps.map((step) => (
              <div
                key={step.id}
                className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
              >
                {step.label ?? titleFromId(step.id)}
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {step.kind === "tool" ? "Handled by workflow" : "Ready"}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No workflow steps are available yet.</p>
        )
      ) : (
        <p className="text-xs text-muted-foreground">Loading assignment preview...</p>
      )}

      {blockers.length > 0 ? (
        <div className="mt-3 space-y-2">
          {blockers.map((blocker) => (
            <div
              key={`${blocker.stepId}:${blocker.capability}`}
              className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
            >
              {blocker.reason ??
                `Tessera could not use ${formatCapabilityLabel(blocker.capability)}.`}
            </div>
          ))}
        </div>
      ) : assignmentPreview ? (
        <p className="mt-3 text-xs text-muted-foreground">
          {agentsConfirmed
            ? "This setup is saved for future runs in this workspace."
            : "Use this setup to save it for next time."}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-3">
        <Button
          type="button"
          size="sm"
          className="rounded-md"
          onClick={onConfirmAgents}
          disabled={!canConfirmAgents}
        >
          {savingPreference ? <Loader2 size={14} className="animate-spin" /> : null}
          {agentsConfirmed ? "Save setup" : "Use this setup"}
        </Button>
        {!setupEditorOpen && assignmentPreview ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="rounded-md"
            onClick={() => setSetupEditorOpen(true)}
          >
            Change setup
          </Button>
        ) : null}
        {setupEditorOpen && agentsConfirmed ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="rounded-md"
            onClick={() => {
              setSetupEditorOpen(false);
              setWorkflowDetailsOpen(false);
            }}
          >
            Done
          </Button>
        ) : null}
      </div>
    </div>
  );

  return (
    <div className="mx-auto w-full max-w-xl py-10">
      <div className="mb-8">
        {playbook.businessUseCase ? (
          <div className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            {playbook.businessUseCase}
          </div>
        ) : null}
        <h2 className="text-2xl font-semibold text-foreground">{playbook.name}</h2>
        {playbook.description ? (
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{playbook.description}</p>
        ) : null}
      </div>

      {capabilityInventory && playbook.optionalCapabilities.length > 0 ? (
        <div className="mb-8">
          <div className="mb-2 text-xs text-muted-foreground">
            Tessera uses these sources when available
          </div>
          <div className="flex flex-wrap gap-2">
            {playbook.optionalCapabilities.map((cap) => (
              <span
                key={cap}
                className="rounded-full border border-border bg-secondary px-3 py-1 text-xs text-foreground"
              >
                {formatCapabilityLabel(cap)}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {fields.length > 0 ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) onStart();
          }}
          className="space-y-7"
        >
          {[...groups.entries()].map(([group, groupFields]) => (
            <div key={group || "__default"}>
              {group ? (
                <div className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                  {group}
                </div>
              ) : null}
              <div className="space-y-4">
                {groupFields.map(([key, spec]) => (
                  <IntakeField
                    key={key}
                    fieldKey={key}
                    spec={spec}
                    value={formValues[key]}
                    onChange={(val) => onFieldChange(key, val)}
                    disabled={!workspaceRoot || running}
                  />
                ))}
              </div>
            </div>
          ))}

          {preflightPanel}

          {!workspaceRoot ? (
            <p className="text-sm text-muted-foreground">
              Select a workspace before starting this playbook.
            </p>
          ) : null}

          <Button type="submit" size="lg" className="w-full rounded-md" disabled={!canSubmit}>
            {running ? <Loader2 size={16} className="animate-spin" /> : null}
            {ctaCopy}
          </Button>
        </form>
      ) : (
        <div className="space-y-4">
          {preflightPanel}
          <Button
            type="button"
            size="lg"
            className="w-full rounded-md"
            onClick={onStart}
            disabled={!canSubmit}
          >
            {running ? <Loader2 size={16} className="animate-spin" /> : null}
            {ctaCopy}
          </Button>
        </div>
      )}
    </div>
  );
}

function GuidedPreparing({
  run,
  playbook,
}: {
  run: PlaybookRunDetail | null;
  playbook: PlaybookSummary | PlaybookDetail | null;
}) {
  const name = playbook?.name ?? "this playbook";
  const steps = run?.steps ?? [];
  const phases = playbook?.phases ?? [];

  return (
    <div className="mx-auto w-full max-w-xl py-10">
      <div className="mb-8">
        <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          <Loader2 size={13} className="animate-spin" />
          Working
        </div>
        <h2 className="text-2xl font-semibold text-foreground">Preparing {name}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          You can come back later — Tessera will keep this run ready.
        </p>
      </div>

      {steps.length > 0 ? (
        <div className="space-y-2">
          {steps.map((step) => (
            <div
              key={step.id}
              className="flex items-center gap-3 rounded-md border border-border bg-background px-4 py-3"
            >
              <div className="flex-shrink-0">{stepIcon(step.status)}</div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-foreground">
                  {step.label ?? titleFromId(step.id)}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {stepStatusLabel(step.status)}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : phases.length > 0 ? (
        <div className="space-y-2">
          {phases.map((phase) => (
            <div
              key={phase}
              className="flex items-center gap-3 rounded-md border border-border bg-background px-4 py-3"
            >
              <Loader2 size={15} className="animate-spin text-blue-500" />
              <div className="text-sm font-medium text-foreground">{phase}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-3 rounded-md border border-border bg-background px-4 py-3">
          <Loader2 size={15} className="animate-spin text-blue-500" />
          <div className="text-sm font-medium text-foreground">Working…</div>
        </div>
      )}
    </div>
  );
}

function GuidedReview({
  run,
  playbook,
  onApprove,
  onStop,
  running,
}: {
  run: PlaybookRunDetail;
  playbook: PlaybookSummary | PlaybookDetail | null;
  onApprove: () => void;
  onStop: () => void;
  running: boolean;
}) {
  const approvalCopy = playbookApprovalCopy(run, playbook);

  return (
    <div className="mx-auto w-full max-w-xl py-10">
      <div className="mb-8">
        {playbook?.businessUseCase ? (
          <div className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            {playbook.businessUseCase}
          </div>
        ) : null}
        <h2 className="text-2xl font-semibold text-foreground">{playbook?.name ?? "Playbook"}</h2>
      </div>

      <div className="rounded-lg border border-amber-200 bg-amber-50 p-6">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-amber-900">
          <AlertTriangle size={16} />
          Your review is needed
        </div>

        <div className="space-y-4 text-sm text-amber-800">
          <div>
            <div className="font-medium">What Tessera prepared</div>
            <p className="mt-1">{approvalCopy.prepared}</p>
          </div>
          <div>
            <div className="font-medium">What happens if you approve</div>
            <p className="mt-1">{approvalCopy.approve}</p>
          </div>
          <div>
            <div className="font-medium">What happens if you stop</div>
            <p className="mt-1">The run stops here and nothing changes in your workspace.</p>
          </div>
        </div>

        <div className="mt-6 flex gap-3">
          <Button
            type="button"
            size="sm"
            className="h-9 rounded-md px-5"
            onClick={onApprove}
            disabled={running}
          >
            {running ? <Loader2 size={14} className="animate-spin" /> : null}
            Approve
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-9 rounded-md px-5"
            onClick={onStop}
            disabled={running}
          >
            Stop
          </Button>
        </div>
      </div>
    </div>
  );
}

function GuidedResult({
  run,
  playbook,
  playbookDetail,
  workspaceRoot,
  dashboardLayout,
  refreshing,
  refreshNotice,
  onRefresh,
  onStartAnother,
  onViewDetails,
}: {
  run: PlaybookRunDetail;
  playbook: PlaybookSummary | PlaybookDetail | null;
  playbookDetail: PlaybookDetail | null;
  workspaceRoot: string | null;
  dashboardLayout: DashboardLayout | null;
  refreshing: boolean;
  refreshNotice: string | null;
  onRefresh: () => void;
  onStartAnother: () => void;
  onViewDetails: () => void;
}) {
  const name = playbook?.name ?? "Your playbook";
  const headlineFn = resultHeadline[run.status];
  const headline = headlineFn ? headlineFn(name) : `${name} finished.`;
  const outputs = playbookDetail?.outputs ?? playbook?.outputs ?? [];
  const runOutputs = run.outputs ?? {};
  const latestEvent = run.events?.[run.events.length - 1];
  const sourceGaps = run.sourceGaps ?? [];
  const runInput = run.input ?? {};
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const isDashboard = isDashboardPlaybook(playbookDetail ?? playbook);
  const sub =
    run.status === "completed" && isDashboard
      ? "Here's what changed, what's at risk, and what needs follow-up."
      : (resultSub[run.status] ?? "");
  const visibleOutputs = outputs.filter((output) =>
    shouldShowResultOutput(output.kind, playbookOutputValue(output.kind, runOutputs))
  );

  async function openArtifact(path: string) {
    if (!workspaceRoot) return;
    setOpenError(null);
    setOpeningPath(path);
    try {
      await invoke("workspace_file_open", { workspaceRoot, path });
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : String(error));
    } finally {
      setOpeningPath(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-xl py-10">
      <div className="mb-8">
        {playbook?.businessUseCase ? (
          <div className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            {playbook.businessUseCase}
          </div>
        ) : null}
        <h2 className="text-2xl font-semibold text-foreground">{headline}</h2>
        {sub ? <p className="mt-2 text-sm text-muted-foreground">{sub}</p> : null}
        {run.status === "completed" ? (
          <div className="mt-3">
            <UsageSummary usage={run.usage} />
          </div>
        ) : null}
        {run.status === "failed" && latestEvent ? (
          <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {latestEvent.message}
          </p>
        ) : null}
      </div>

      {isDashboard && run.status === "completed" ? (
        <div className="mb-6 space-y-4">
          {dashboardLayout ? (
            <DashboardView layout={dashboardLayout} outputs={runOutputs} />
          ) : (
            <div className="rounded-md border border-border bg-background p-4 text-sm text-muted-foreground">
              Dashboard layout is not available for this run.
            </div>
          )}
          {refreshNotice ? (
            <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700">
              {refreshNotice}
            </div>
          ) : null}
        </div>
      ) : visibleOutputs.length > 0 ? (
        <div className="mb-6 space-y-3">
          {visibleOutputs.map((output) => {
            const value = playbookOutputValue(output.kind, runOutputs);
            const artifactPath =
              output.kind === "meetingBrief" ||
              output.kind === "businessBrief" ||
              output.kind === "statusDigest"
                ? filePathFromValue(value)
                : null;
            const summary = playbookOutputSummary(
              output.kind,
              value,
              sourceGaps.length,
              artifactPath
            );
            const canOpen = !!artifactPath && !!workspaceRoot;
            const Container = canOpen ? "button" : "div";
            const includeSourceNote =
              output.kind === "meetingBrief" ||
              output.kind === "businessBrief" ||
              output.kind === "statusDigest";
            return (
              <Container
                key={output.kind}
                type={canOpen ? "button" : undefined}
                disabled={canOpen ? openingPath === artifactPath : undefined}
                title={canOpen ? "Open artifact" : undefined}
                onClick={canOpen ? () => void openArtifact(artifactPath) : undefined}
                className={cn(
                  "w-full rounded-lg border border-border bg-background p-4 text-left",
                  canOpen &&
                    "cursor-pointer transition-colors hover:border-foreground/30 hover:bg-secondary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                )}
              >
                <div className="flex items-start gap-3">
                  <FileText size={18} className="mt-0.5 flex-shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-foreground">{output.label}</div>
                    {summary && summary !== "Not provided" ? (
                      <p className="mt-1 line-clamp-3 text-xs leading-5 text-muted-foreground">
                        {summary}
                      </p>
                    ) : null}
                    {includeSourceNote ? (
                      <p className="mt-2 text-xs leading-5 text-muted-foreground">
                        {playbookSourceSummary(runInput, sourceGaps.length)}
                      </p>
                    ) : null}
                  </div>
                </div>
              </Container>
            );
          })}
          {openError ? <p className="text-xs text-red-700">{openError}</p> : null}
        </div>
      ) : null}

      {sourceGaps.length > 0 ? (
        <div className="mb-6 rounded-md border border-amber-200 bg-amber-50 p-4">
          <div className="mb-2 text-xs font-semibold text-amber-800">
            Sources unavailable this run
          </div>
          <div className="space-y-1">
            {sourceGaps.map((gap) => (
              <div key={`${gap.stepId}:${gap.capability}`} className="text-sm text-amber-700">
                {gap.reason ??
                  `Tessera could not use ${formatCapabilityLabel(gap.capability)} this time.`}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-3">
        {isDashboard && run.status === "completed" ? (
          <PlaybookRefreshButton
            label={dashboardLayout?.refreshLabel ?? `Refresh ${name}`}
            isRefreshing={refreshing}
            onRefresh={onRefresh}
          />
        ) : (
          <Button type="button" size="sm" className="rounded-md" onClick={onStartAnother}>
            Start another
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="rounded-md"
          onClick={onViewDetails}
        >
          View details
        </Button>
      </div>
    </div>
  );
}

function DetailsPanel({
  run,
  playbookDetail,
  onClose,
}: {
  run: PlaybookRunDetail | null;
  playbookDetail: PlaybookDetail | null;
  onClose: () => void;
}) {
  const visibleInputs = useMemo(() => {
    const definitions = playbookDetail?.inputs ?? {};
    return Object.entries(run?.input ?? {})
      .filter(([key]) => key !== "workspaceRoot")
      .map(([key, value]) => ({
        key,
        label: definitions[key]?.label ?? titleFromId(key),
        value: inputDisplayValue(value),
      }));
  }, [playbookDetail?.inputs, run?.input]);

  const runStepGroups = useMemo(() => {
    if (!run?.steps?.length) return [];
    return orderedPhases(playbookDetail, run).map((phase) => ({
      phase,
      steps: (run.steps ?? []).filter((step) => step.phase === phase),
    }));
  }, [run, playbookDetail]);
  const sourceGaps = run?.sourceGaps ?? [];

  return (
    <aside className="flex w-80 flex-shrink-0 flex-col border-l border-border bg-secondary">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Details</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Run inputs, steps, and events</p>
        </div>
        <button
          type="button"
          className="rounded-full p-1 text-muted-foreground hover:bg-background hover:text-foreground"
          onClick={onClose}
          aria-label="Close details"
        >
          <X size={14} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {run ? (
          <div className="space-y-5">
            {visibleInputs.length > 0 ? (
              <Section title="Inputs" subtitle="What Tessera was asked to do">
                <div className="divide-y divide-border overflow-hidden rounded-md border border-border bg-background">
                  {visibleInputs.map((input) => (
                    <div key={input.key} className="px-3 py-2 text-xs">
                      <div className="font-medium text-foreground">{input.label}</div>
                      <div className="mt-0.5 text-muted-foreground">{input.value}</div>
                    </div>
                  ))}
                </div>
              </Section>
            ) : null}

            {sourceGaps.length > 0 ? (
              <Section title="Source gaps" subtitle="What Tessera could not reach">
                <div className="space-y-2">
                  {sourceGaps.map((gap) => (
                    <div
                      key={`${gap.stepId}:${gap.capability}`}
                      className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
                    >
                      {gap.reason ?? formatCapabilityLabel(gap.capability)}
                    </div>
                  ))}
                </div>
              </Section>
            ) : null}

            {runStepGroups.length > 0 ? (
              <Section title="Steps" subtitle="What each step did">
                <div className="space-y-3">
                  {runStepGroups.map((group) => (
                    <div key={group.phase}>
                      <div className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                        {group.phase}
                      </div>
                      <div className="divide-y divide-border overflow-hidden rounded-md border border-border bg-background">
                        {group.steps.map((step) => {
                          const assignment = stepAssignment(step, run);
                          return (
                            <div key={step.id} className="px-3 py-2 text-xs">
                              <div className="flex items-center gap-2">
                                {stepIcon(step.status)}
                                <span className="font-medium text-foreground">
                                  {step.label ?? titleFromId(step.id)}
                                </span>
                              </div>
                              <div className="ml-6 mt-0.5 text-muted-foreground">
                                {stepStatusLabel(step.status)}
                              </div>
                              {assignment ? (
                                <div className="ml-6 mt-0.5 text-muted-foreground">
                                  {summarizeAssignment(assignment)}
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            ) : null}

            {(run.events ?? []).length > 0 ? (
              <Section title="Events" subtitle="Run activity log">
                <div className="space-y-2">
                  {(run.events ?? []).map((event) => (
                    <RunEventItem key={event.id} event={event} />
                  ))}
                </div>
              </Section>
            ) : null}
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">No run selected.</div>
        )}
      </div>
    </aside>
  );
}

export function PlaybooksView({ workspaceRoot, onWorkspaceSelect }: PlaybooksViewProps) {
  const [playbooks, setPlaybooks] = useState<PlaybookSummary[]>([]);
  const [selectedPlaybookDetail, setSelectedPlaybookDetail] = useState<PlaybookDetail | null>(null);
  const [runs, setRuns] = useState<PlaybookRunDetail[]>([]);
  const [runHistory, setRunHistory] = useState<PlaybookRunDetail[]>([]);
  const [selectedPlaybookId, setSelectedPlaybookId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRunDetail, setSelectedRunDetail] = useState<PlaybookRunDetail | null>(null);
  const [dashboardLayout, setDashboardLayout] = useState<DashboardLayout | null>(null);
  const [modelSettings, setModelSettings] = useState<ModelSettingsRead | null>(null);
  const [integrationSettings, setIntegrationSettings] = useState<IntegrationSettingsRead | null>(
    null
  );
  const [agentProfiles, setAgentProfiles] = useState<AgentProfile[]>([]);
  const [formValues, setFormValues] = useState<Record<string, unknown>>({});
  const [showStartForm, setShowStartForm] = useState(true);
  const [showDetails, setShowDetails] = useState(false);
  const [loadingPlaybooks, setLoadingPlaybooks] = useState(false);
  const [loadingSetup, setLoadingSetup] = useState(false);
  const [running, setRunning] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNotice, setRefreshNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [assignmentPreview, setAssignmentPreview] =
    useState<PlaybookAssignmentPreviewResult | null>(null);
  const [draftAssignmentPlan, setDraftAssignmentPlan] = useState<WorkflowRunAssignmentPlan | null>(
    null
  );
  const [agentsConfirmed, setAgentsConfirmed] = useState(false);
  const [savingPreference, setSavingPreference] = useState(false);
  const runListRequestRef = useRef(0);

  const businessPlaybooks = useMemo(
    () => playbooks.filter((p) => !!p.businessUseCase),
    [playbooks]
  );
  const hasCompletedRun = useCallback(
    (playbookId: string) =>
      runHistory.some((run) => run.workflowId === playbookId && run.status === "completed"),
    [runHistory]
  );
  const pinnedDashboards = useMemo(
    () =>
      businessPlaybooks.filter(
        (playbook) => isDashboardPlaybook(playbook) && hasCompletedRun(playbook.id)
      ),
    [businessPlaybooks, hasCompletedRun]
  );
  const regularPlaybooks = useMemo(
    () =>
      businessPlaybooks.filter(
        (playbook) => !pinnedDashboards.some((item) => item.id === playbook.id)
      ),
    [businessPlaybooks, pinnedDashboards]
  );

  const selectedPlaybook =
    businessPlaybooks.find((p) => p.id === selectedPlaybookId) ?? businessPlaybooks[0] ?? null;
  const selectedPlaybookForUi =
    selectedPlaybookDetail?.id === selectedPlaybook?.id ? selectedPlaybookDetail : selectedPlaybook;
  const selectedRun =
    selectedRunDetail ??
    (selectedRunId ? (runs.find((run) => run.runId === selectedRunId) ?? null) : null);

  const capabilityInventory = useMemo(
    () =>
      buildCapabilityInventory(modelSettings, integrationSettings, agentProfiles, workspaceRoot),
    [agentProfiles, integrationSettings, modelSettings, workspaceRoot]
  );

  const formReady = useMemo(() => {
    if (!selectedPlaybookDetail) return false;
    return Object.entries(selectedPlaybookDetail.inputs ?? {}).every(([key, spec]) => {
      if (key === "workspaceRoot" || spec.group === "System") return true;
      if (!spec.required) return true;
      const val = formValues[key];
      if (Array.isArray(val)) return val.length > 0;
      if (typeof val === "string") return val.trim().length > 0;
      return val !== undefined && val !== null;
    });
  }, [formValues, selectedPlaybookDetail]);

  const guidedState = useMemo((): "start" | "preparing" | "review" | "result" => {
    if (showStartForm) return "start";
    if (running && !selectedRun) return "preparing";
    if (!selectedRun) return "start";
    if (selectedRun.approval) return "review";
    if (selectedRun.status === "running") return "preparing";
    return "result";
  }, [showStartForm, running, selectedRun]);

  useEffect(() => {
    let cancelled = false;
    if (!selectedPlaybookId || !workspaceRoot || !capabilityInventory) {
      setAssignmentPreview(null);
      setDraftAssignmentPlan(null);
      setAgentsConfirmed(false);
      return;
    }

    setAssignmentPreview(null);
    setDraftAssignmentPlan(null);
    setAgentsConfirmed(false);

    void (async () => {
      try {
        const preference = await invoke<PlaybookRunPreferenceReadResult>(
          "playbook_run_preference_get",
          {
            playbookId: selectedPlaybookId,
            request: { workspaceRoot },
          }
        );
        if (cancelled) return;

        const preview = await invoke<PlaybookAssignmentPreviewResult>(
          "playbook_assignment_preview",
          {
            playbookId: selectedPlaybookId,
            request: {
              workspaceRoot,
              capabilityInventory,
              previousPlan: preference.preference?.assignmentPlan,
            },
          }
        );
        if (cancelled) return;

        setAssignmentPreview(preview);
        setDraftAssignmentPlan(
          preview.assignmentPlan ??
            (preview.blockers.length > 0 ? null : (preference.preference?.assignmentPlan ?? null))
        );
        setAgentsConfirmed(!!preference.preference && preview.blockers.length === 0);
      } catch (loadError) {
        if (cancelled) return;
        setAssignmentPreview(null);
        setDraftAssignmentPlan(null);
        setAgentsConfirmed(false);
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [capabilityInventory, selectedPlaybookId, workspaceRoot]);

  const loadPlaybooks = useCallback(async () => {
    setLoadingPlaybooks(true);
    setError(null);
    try {
      const result = await invoke<PlaybookListResult>("playbook_list");
      setPlaybooks(result.playbooks);
      setSelectedPlaybookId((current) => {
        if (current) return current;
        return result.playbooks.find((p) => p.businessUseCase)?.id ?? null;
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoadingPlaybooks(false);
    }
  }, []);

  const loadSetup = useCallback(async () => {
    setLoadingSetup(true);
    setSetupError(null);
    try {
      const [loadedModelSettings, loadedIntegrationSettings, loadedAgentProfiles] =
        await Promise.all([
          invoke<ModelSettingsRead>("model_settings_get"),
          invoke<IntegrationSettingsRead>("integration_settings_get"),
          invoke<AgentProfileListResult>("agent_profile_list"),
        ]);
      setModelSettings(loadedModelSettings);
      setIntegrationSettings(loadedIntegrationSettings);
      setAgentProfiles(loadedAgentProfiles.profiles);
    } catch (loadError) {
      setSetupError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoadingSetup(false);
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

  const loadRuns = useCallback(async (playbookId?: string | null) => {
    const requestId = ++runListRequestRef.current;
    setError(null);
    if (!playbookId) {
      setRuns([]);
      setSelectedRunId(null);
      setSelectedRunDetail(null);
      return;
    }

    try {
      const result = await invoke<WorkflowRunListResult>("playbook_run_list", {
        playbookId,
      });
      if (requestId !== runListRequestRef.current) return;

      const playbookRuns = result.runs.filter((run) => run.workflowId === playbookId);
      setRuns(playbookRuns);
      setSelectedRunId((current) => {
        if (current && playbookRuns.some((run) => run.runId === current)) return current;
        setSelectedRunDetail(null);
        return null;
      });
    } catch (loadError) {
      if (requestId !== runListRequestRef.current) return;
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, []);

  const loadRunHistory = useCallback(async () => {
    try {
      const result = await invoke<WorkflowRunListResult>("playbook_run_list");
      setRunHistory(result.runs);
    } catch {
      setRunHistory([]);
    }
  }, []);

  const loadRunDetail = useCallback(async (runId: string) => {
    try {
      const detail = await invoke<PlaybookRunDetail>("playbook_run_get", { runId });
      setSelectedRunDetail(detail);
      setRuns((current) => current.map((run) => (run.runId === detail.runId ? detail : run)));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, []);

  useEffect(() => {
    void loadPlaybooks();
    void loadSetup();
    void loadRunHistory();
  }, [loadPlaybooks, loadRunHistory, loadSetup]);

  useEffect(() => {
    if (selectedPlaybookId) {
      void loadPlaybookDetail(selectedPlaybookId);
    } else {
      setSelectedPlaybookDetail(null);
    }
  }, [loadPlaybookDetail, selectedPlaybookId]);

  useEffect(() => {
    void loadRuns(selectedPlaybookId);
  }, [loadRuns, selectedPlaybookId]);

  useEffect(() => {
    if (!selectedRunId) {
      setSelectedRunDetail(null);
      return;
    }
    void loadRunDetail(selectedRunId);
  }, [loadRunDetail, selectedRunId]);

  useEffect(() => {
    if (!refreshNotice) return;
    const timeout = setTimeout(() => setRefreshNotice(null), 2500);
    return () => clearTimeout(timeout);
  }, [refreshNotice]);

  useEffect(() => {
    let cancelled = false;
    setDashboardLayout(null);
    if (
      !selectedRun ||
      selectedRun.status !== "completed" ||
      !isDashboardPlaybook(selectedPlaybookForUi)
    ) {
      return;
    }

    if (selectedRun.dashboardLayout) {
      setDashboardLayout(selectedRun.dashboardLayout);
    }

    void invoke<{ layout: DashboardLayout | null }>("playbook_get_dashboard_layout", {
      runId: selectedRun.runId,
    })
      .then((result) => {
        if (!cancelled) setDashboardLayout(result.layout);
      })
      .catch(() => {
        if (!cancelled) setDashboardLayout(selectedRun.dashboardLayout ?? null);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedPlaybookForUi, selectedRun]);

  // Initialize form when detail loads
  useEffect(() => {
    if (!selectedPlaybookDetail) {
      setFormValues({});
      return;
    }
    const defaults = initFormValues(selectedPlaybookDetail.inputs ?? {});
    const latestCompletedRun = runs.find(
      (run) => run.workflowId === selectedPlaybookDetail.id && run.status === "completed"
    );
    if (isDashboardPlaybook(selectedPlaybookDetail) && latestCompletedRun?.input) {
      const previousInput = Object.fromEntries(
        Object.entries(latestCompletedRun.input).filter(([key]) => key !== "workspaceRoot")
      );
      setFormValues({ ...defaults, ...previousInput });
      return;
    }
    setFormValues(defaults);
  }, [runs, selectedPlaybookDetail]);

  const refreshAll = useCallback(() => {
    void loadPlaybooks();
    void loadSetup();
    void loadRunHistory();
    void loadRuns(selectedPlaybookId);
    if (selectedPlaybookId) {
      void loadPlaybookDetail(selectedPlaybookId);
    }
    if (selectedRunId) {
      void loadRunDetail(selectedRunId);
    }
  }, [
    loadPlaybookDetail,
    loadPlaybooks,
    loadRunDetail,
    loadRunHistory,
    loadRuns,
    loadSetup,
    selectedPlaybookId,
    selectedRunId,
  ]);

  async function startRun(
    inputOverride?: Record<string, unknown>,
    assignmentPlanOverride?: WorkflowRunAssignmentPlan
  ) {
    const assignmentPlan = assignmentPlanOverride ?? draftAssignmentPlan ?? undefined;
    if (!selectedPlaybook || !workspaceRoot) return;
    if (!assignmentPlan) {
      setError("Confirm agents before starting this playbook.");
      setShowStartForm(true);
      return;
    }
    setRunning(true);
    setShowStartForm(false);
    setError(null);
    try {
      const fullInput: Record<string, unknown> = {
        ...(inputOverride ?? formValues),
        workspaceRoot,
      };
      const request: WorkflowRunRequest = {
        workflowId: selectedPlaybook.id,
        input: fullInput,
        capabilityInventory: capabilityInventory ?? undefined,
        assignmentPlan,
      };
      const run = await invoke<PlaybookRunDetail>("playbook_run_create", {
        playbookId: selectedPlaybook.id,
        request,
      });
      setRuns((current) => [run, ...current.filter((item) => item.runId !== run.runId)]);
      setRunHistory((current) => [run, ...current.filter((item) => item.runId !== run.runId)]);
      setSelectedRunId(run.runId);
      setSelectedRunDetail(run);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError));
      setShowStartForm(true);
    } finally {
      setRunning(false);
    }
  }

  async function confirmAgents() {
    if (!selectedPlaybook || !workspaceRoot || !draftAssignmentPlan || savingPreference) return;
    setSavingPreference(true);
    setError(null);
    try {
      const saved = await invoke<PlaybookRunPreferenceReadResult>("playbook_run_preference_save", {
        playbookId: selectedPlaybook.id,
        request: {
          workspaceRoot,
          assignmentPlan: draftAssignmentPlan,
          ...(capabilityInventory ? { capabilityInventory } : {}),
        },
      });
      setDraftAssignmentPlan(saved.preference?.assignmentPlan ?? draftAssignmentPlan);
      setAgentsConfirmed(true);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
      setAgentsConfirmed(false);
    } finally {
      setSavingPreference(false);
    }
  }

  async function refreshDashboardRun() {
    if (!selectedRun || !selectedPlaybook || refreshing) {
      setRefreshNotice("Refresh already in progress");
      return;
    }
    const assignmentPlan = selectedRun.assignmentPlan ?? draftAssignmentPlan ?? undefined;
    if (!assignmentPlan) {
      setRefreshNotice("Agent setup is still loading");
      return;
    }
    setRefreshing(true);
    setRefreshNotice(null);
    try {
      const previousInput = Object.fromEntries(
        Object.entries(selectedRun.input ?? {}).filter(([key]) => key !== "workspaceRoot")
      );
      await startRun({ ...previousInput, ...formValues }, assignmentPlan);
    } finally {
      setRefreshing(false);
    }
  }

  async function resumeRun(decision: "approve" | "deny") {
    if (!selectedRun) return;
    setRunning(true);
    setError(null);
    try {
      const request: WorkflowResumeRequest = {
        runId: selectedRun.runId,
        decision,
        capabilityInventory: capabilityInventory ?? undefined,
        assignmentPlan: selectedRun.assignmentPlan,
      };
      const run = await invoke<PlaybookRunDetail>("playbook_run_resume", {
        runId: selectedRun.runId,
        request,
      });
      setRuns((current) => current.map((item) => (item.runId === run.runId ? run : item)));
      setRunHistory((current) => current.map((item) => (item.runId === run.runId ? run : item)));
      setSelectedRunDetail(run);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError));
    } finally {
      setRunning(false);
    }
  }

  const renderPlaybookButton = (playbook: PlaybookSummary) => (
    <button
      key={playbook.id}
      type="button"
      className={cn(
        "w-full rounded-md px-3 py-2.5 text-left transition-colors hover:bg-background/70",
        selectedPlaybook?.id === playbook.id ? "bg-background shadow-sm" : ""
      )}
      onClick={() => {
        const isSamePlaybook = selectedPlaybookId === playbook.id;
        setSelectedPlaybookId(playbook.id);
        setShowStartForm(true);
        setSelectedRunId(null);
        setSelectedRunDetail(null);
        if (!isSamePlaybook) {
          setRuns([]);
        }
      }}
    >
      <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
        <span>{playbook.name}</span>
        {isDashboardPlaybook(playbook) ? (
          <span className="rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-800">Dashboard</span>
        ) : null}
      </div>
      <div className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
        {playbook.businessUseCase ?? playbook.description}
      </div>
    </button>
  );

  return (
    <main className="flex min-w-0 flex-1 bg-background">
      <aside className="flex w-64 flex-shrink-0 flex-col border-r border-border bg-secondary">
        <WorkspacePicker currentWorkspace={workspaceRoot} onWorkspaceSelect={onWorkspaceSelect} />

        <div className="border-b border-border px-4 py-3">
          <div className="flex items-center justify-between">
            <h1 className="text-sm font-semibold text-foreground">Playbooks</h1>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-full"
              onClick={refreshAll}
              disabled={loadingPlaybooks || loadingSetup || running}
              title="Refresh"
            >
              <RefreshCw size={14} />
            </Button>
          </div>
        </div>

        <div className="border-b border-border p-2">
          <div className="space-y-4">
            {pinnedDashboards.length > 0 ? (
              <section>
                <h2 className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                  Dashboards
                </h2>
                <div className="space-y-1">{pinnedDashboards.map(renderPlaybookButton)}</div>
              </section>
            ) : null}
            <section>
              <h2 className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                Playbooks
              </h2>
              <div className="space-y-1">{regularPlaybooks.map(renderPlaybookButton)}</div>
            </section>
          </div>
        </div>

        {error ? (
          <div className="border-b border-destructive/20 bg-destructive/5 px-4 py-2 text-xs text-destructive">
            {error}
          </div>
        ) : null}

        {setupError ? (
          <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-700">
            {setupError}
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto py-2">
          {runs.map((run) => (
            <button
              key={run.runId}
              type="button"
              className={cn(
                "w-full border-l-2 px-4 py-3 text-left hover:bg-background/70",
                selectedRun?.runId === run.runId && !showStartForm
                  ? "border-primary bg-background"
                  : "border-transparent"
              )}
              onClick={() => {
                setSelectedRunId(run.runId);
                setShowStartForm(false);
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">{formatTime(run.updatedAt)}</span>
                <span
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[10px]",
                    statusClass[run.status]
                  )}
                >
                  {statusCopy[run.status]}
                </span>
              </div>
              {run.usage ? (
                <div className="mt-1 text-xs text-muted-foreground">
                  {formatTokens(run.usage.totalTokens)} tokens
                </div>
              ) : null}
            </button>
          ))}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 overflow-y-auto px-8 py-5">
        {!selectedPlaybook ? (
          <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
            Choose a playbook to get started.
          </div>
        ) : guidedState === "start" ? (
          <GuidedStart
            playbook={selectedPlaybook}
            playbookDetail={selectedPlaybookDetail}
            assignmentPreview={assignmentPreview}
            draftAssignmentPlan={draftAssignmentPlan}
            agentsConfirmed={agentsConfirmed}
            formValues={formValues}
            onFieldChange={(key, value) => setFormValues((prev) => ({ ...prev, [key]: value }))}
            onStart={() => void startRun()}
            onConfirmAgents={() => void confirmAgents()}
            onAssignmentPlanChange={setDraftAssignmentPlan}
            formReady={formReady}
            running={running}
            savingPreference={savingPreference}
            workspaceRoot={workspaceRoot}
            capabilityInventory={capabilityInventory}
          />
        ) : guidedState === "preparing" ? (
          <GuidedPreparing run={selectedRun} playbook={selectedPlaybookForUi} />
        ) : guidedState === "review" && selectedRun ? (
          <GuidedReview
            run={selectedRun}
            playbook={selectedPlaybookForUi}
            onApprove={() => void resumeRun("approve")}
            onStop={() => void resumeRun("deny")}
            running={running}
          />
        ) : guidedState === "result" && selectedRun ? (
          <GuidedResult
            run={selectedRun}
            playbook={selectedPlaybookForUi}
            playbookDetail={selectedPlaybookDetail}
            workspaceRoot={workspaceRoot}
            dashboardLayout={dashboardLayout}
            refreshing={refreshing}
            refreshNotice={refreshNotice}
            onRefresh={() => void refreshDashboardRun()}
            onStartAnother={() => {
              setShowStartForm(true);
              setSelectedRunId(null);
              setSelectedRunDetail(null);
            }}
            onViewDetails={() => setShowDetails(true)}
          />
        ) : null}
      </section>

      {showDetails ? (
        <DetailsPanel
          run={selectedRun}
          playbookDetail={selectedPlaybookDetail}
          onClose={() => setShowDetails(false)}
        />
      ) : null}
    </main>
  );
}
