import { Button } from "@/components/ui/button";
import { integrationLabel, searchProviderLabel } from "@/lib/integrationSettings";
import { providerLabel } from "@/lib/modelSettings";
import { cn } from "@/lib/utils";
import { invoke } from "@tauri-apps/api/core";
import type {
  AgentProfile,
  AgentProfileListResult,
  IntegrationSettingsRead,
  ModelSettingsRead,
  PlaybookDetail,
  PlaybookListResult,
  PlaybookRunDetail,
  PlaybookSummary,
  WorkflowCapabilityInventory,
  WorkflowInputDefinition,
  WorkflowNodeAssignment,
  WorkflowResumeRequest,
  WorkflowRunEvent,
  WorkflowRunListResult,
  WorkflowRunRequest,
  WorkflowRunStepRecord,
} from "@tessera/contracts";
import { AlertTriangle, CheckCircle2, Clock3, FileText, Loader2, RefreshCw, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";

interface PlaybooksViewProps {
  workspaceRoot: string | null;
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

  const defaultProvider = modelSettings.providers[modelSettings.selectedProvider];
  const providerSettingsByProvider = new Map(
    Object.values(modelSettings.providers).map((provider) => [provider.provider, provider])
  );

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
      id: "integration.google-calendar",
      label: integrationLabel("google-calendar"),
      fingerprint: hashText(
        JSON.stringify({
          id: "integration.google-calendar",
          configured: integrationSettings.providers.googleCalendar.hasCredential,
        })
      ),
      capabilities: ["integration.calendar.events.read"],
      configured: integrationSettings.providers.googleCalendar.hasCredential,
      dataPolicies: [
        integrationSettings.providers.googleCalendar.hasCredential
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
  formValues,
  onFieldChange,
  onStart,
  formReady,
  running,
  workspaceRoot,
  capabilityInventory,
}: {
  playbook: PlaybookSummary;
  playbookDetail: PlaybookDetail | null;
  formValues: Record<string, unknown>;
  onFieldChange: (key: string, value: unknown) => void;
  onStart: () => void;
  formReady: boolean;
  running: boolean;
  workspaceRoot: string | null;
  capabilityInventory: WorkflowCapabilityInventory | null;
}) {
  const ctaCopy = ctaCopyMap[playbook.id] ?? "Start playbook";
  const inputs = playbookDetail?.inputs ?? {};

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

  const canSubmit = formReady && !!workspaceRoot && !running;

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
          {!workspaceRoot ? (
            <p className="text-sm text-muted-foreground">
              Select a workspace before starting this playbook.
            </p>
          ) : null}
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
  const preview = run.approval?.preview ?? "Tessera has prepared the next step.";

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
            <p className="mt-1">{preview}</p>
          </div>
          <div>
            <div className="font-medium">What happens if you approve</div>
            <p className="mt-1">Tessera will apply these changes to your workspace.</p>
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
  onStartAnother,
  onViewDetails,
}: {
  run: PlaybookRunDetail;
  playbook: PlaybookSummary | PlaybookDetail | null;
  playbookDetail: PlaybookDetail | null;
  onStartAnother: () => void;
  onViewDetails: () => void;
}) {
  const name = playbook?.name ?? "Your playbook";
  const headlineFn = resultHeadline[run.status];
  const headline = headlineFn ? headlineFn(name) : `${name} finished.`;
  const sub = resultSub[run.status] ?? "";
  const outputs = playbookDetail?.outputs ?? playbook?.outputs ?? [];
  const runOutputs = run.outputs ?? {};
  const latestEvent = run.events?.[run.events.length - 1];

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
        {run.status === "failed" && latestEvent ? (
          <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {latestEvent.message}
          </p>
        ) : null}
      </div>

      {outputs.length > 0 ? (
        <div className="mb-6 space-y-3">
          {outputs.map((output, index) => {
            const [, value] = Object.entries(runOutputs)[index] ?? [];
            const summary = value !== undefined ? summarizeValue(value) : null;
            return (
              <div key={output.kind} className="rounded-lg border border-border bg-background p-4">
                <div className="flex items-start gap-3">
                  <FileText size={18} className="mt-0.5 flex-shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-foreground">{output.label}</div>
                    {summary && summary !== "Not provided" ? (
                      <p className="mt-1 line-clamp-3 text-xs leading-5 text-muted-foreground">
                        {summary}
                      </p>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {run.sourceGaps.length > 0 ? (
        <div className="mb-6 rounded-md border border-amber-200 bg-amber-50 p-4">
          <div className="mb-2 text-xs font-semibold text-amber-800">
            Sources unavailable this run
          </div>
          <div className="space-y-1">
            {run.sourceGaps.map((gap) => (
              <div key={`${gap.stepId}:${gap.capability}`} className="text-sm text-amber-700">
                {gap.reason ??
                  `Tessera could not use ${formatCapabilityLabel(gap.capability)} this time.`}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <Button type="button" size="sm" className="rounded-md" onClick={onStartAnother}>
          Start another
        </Button>
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

            {run.sourceGaps.length > 0 ? (
              <Section title="Source gaps" subtitle="What Tessera could not reach">
                <div className="space-y-2">
                  {run.sourceGaps.map((gap) => (
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

export function PlaybooksView({ workspaceRoot }: PlaybooksViewProps) {
  const [playbooks, setPlaybooks] = useState<PlaybookSummary[]>([]);
  const [selectedPlaybookDetail, setSelectedPlaybookDetail] = useState<PlaybookDetail | null>(null);
  const [runs, setRuns] = useState<PlaybookRunDetail[]>([]);
  const [selectedPlaybookId, setSelectedPlaybookId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRunDetail, setSelectedRunDetail] = useState<PlaybookRunDetail | null>(null);
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
  const [error, setError] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);

  const businessPlaybooks = useMemo(
    () => playbooks.filter((p) => !!p.businessUseCase),
    [playbooks]
  );

  const selectedPlaybook =
    businessPlaybooks.find((p) => p.id === selectedPlaybookId) ?? businessPlaybooks[0] ?? null;
  const selectedPlaybookForUi = selectedPlaybookDetail ?? selectedPlaybook ?? null;
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
    return Object.entries(selectedPlaybookDetail.inputs).every(([key, spec]) => {
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
    setError(null);
    try {
      const result = await invoke<WorkflowRunListResult>("playbook_run_list", {
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
  }, [loadPlaybooks, loadSetup]);

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

  // Initialize form when detail loads
  useEffect(() => {
    if (!selectedPlaybookDetail) {
      setFormValues({});
      return;
    }
    setFormValues(initFormValues(selectedPlaybookDetail.inputs));
  }, [selectedPlaybookDetail]);

  const refreshAll = useCallback(() => {
    void loadPlaybooks();
    void loadSetup();
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
    loadRuns,
    loadSetup,
    selectedPlaybookId,
    selectedRunId,
  ]);

  async function startRun() {
    if (!selectedPlaybook || !workspaceRoot) return;
    setRunning(true);
    setShowStartForm(false);
    setError(null);
    try {
      const fullInput: Record<string, unknown> = { ...formValues, workspaceRoot };
      const request: WorkflowRunRequest = {
        workflowId: selectedPlaybook.id,
        input: fullInput,
        capabilityInventory: capabilityInventory ?? undefined,
      };
      const run = await invoke<PlaybookRunDetail>("playbook_run_create", {
        playbookId: selectedPlaybook.id,
        request,
      });
      setRuns((current) => [run, ...current.filter((item) => item.runId !== run.runId)]);
      setSelectedRunId(run.runId);
      setSelectedRunDetail(run);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError));
      setShowStartForm(true);
    } finally {
      setRunning(false);
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
      setSelectedRunDetail(run);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError));
    } finally {
      setRunning(false);
    }
  }

  return (
    <main className="flex min-w-0 flex-1 bg-background">
      <aside className="flex w-64 flex-shrink-0 flex-col border-r border-border bg-secondary">
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
          <div className="space-y-1">
            {businessPlaybooks.map((playbook) => (
              <button
                key={playbook.id}
                type="button"
                className={cn(
                  "w-full rounded-md px-3 py-2.5 text-left transition-colors hover:bg-background/70",
                  selectedPlaybook?.id === playbook.id ? "bg-background shadow-sm" : ""
                )}
                onClick={() => {
                  setSelectedPlaybookId(playbook.id);
                  setShowStartForm(true);
                  setSelectedRunId(null);
                  setSelectedRunDetail(null);
                }}
              >
                <div className="text-sm font-medium text-foreground">{playbook.name}</div>
                <div className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
                  {playbook.businessUseCase ?? playbook.description}
                </div>
              </button>
            ))}
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
            formValues={formValues}
            onFieldChange={(key, value) => setFormValues((prev) => ({ ...prev, [key]: value }))}
            onStart={() => void startRun()}
            formReady={formReady}
            running={running}
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
