import { Button } from "@/components/ui/button";
import { integrationLabel, searchProviderLabel } from "@/lib/integrationSettings";
import { providerLabel } from "@/lib/modelSettings";
import { isDashboardPlaybook, playbookApprovalCopy } from "@/lib/playbooks";
import { cn } from "@/lib/utils";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  AgentProfile,
  AgentProfileListResult,
  DashboardLayout,
  GraphPlaybookImportResult,
  GraphRunStyleSelection,
  IntegrationSettingsRead,
  ModelSettingsRead,
  PlaybookAssignmentPreviewResult,
  PlaybookDetail,
  PlaybookGraphGitMilestonePreview,
  PlaybookGraphResumeActionSpec,
  PlaybookGraphRunCreateRequest,
  PlaybookGraphRunDetail,
  PlaybookGraphRunListResult,
  PlaybookGraphRunRecord,
  PlaybookGraphRunReviewSurface,
  PlaybookListResult,
  PlaybookRunDetail,
  PlaybookRunPreferenceReadResult,
  PlaybookSummary,
  TokenUsage,
  WorkflowCapabilityInventory,
  WorkflowInputDefinition,
  WorkflowNodeAssignment,
  WorkflowOutputDeclaration,
  WorkflowRunAssignmentPlan,
  WorkflowRunEvent,
  WorkflowRunStepRecord,
  WorkspaceStyleGuideReadResult,
} from "@tessera/contracts";
import {
  workflowStatusFromGraphRunDetail,
  workflowStatusFromGraphRunRecord,
} from "@tessera/contracts";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  FileText,
  FolderPlus,
  Loader2,
  RefreshCw,
  Upload,
  X,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DashboardView } from "./DashboardView";
import { PlaybookRefreshButton } from "./PlaybookRefreshButton";
import { WorkspacePicker } from "./WorkspacePicker";

interface PlaybooksViewProps {
  onWorkspaceSelect: (path: string) => void;
  userKey: string;
  workspaceRoot: string | null;
  initialPlaybooks?: PlaybookSummary[] | null;
}

const statusCopy: Record<PlaybookRunDetail["status"], string> = {
  running: "In progress",
  blocked: "Needs review",
  needs_attention: "Needs attention",
  completed: "Ready",
  denied: "Stopped",
  failed: "Needs attention",
};

const statusClass: Record<PlaybookRunDetail["status"], string> = {
  running: "border-blue-200 bg-blue-50 text-blue-700",
  blocked: "border-amber-200 bg-amber-50 text-amber-700",
  needs_attention: "border-orange-200 bg-orange-50 text-orange-700",
  completed: "border-emerald-200 bg-emerald-50 text-emerald-700",
  denied: "border-zinc-200 bg-zinc-100 text-zinc-600",
  failed: "border-red-200 bg-red-50 text-red-700",
};

const graphStatusCopy: Record<PlaybookGraphRunDetail["run"]["status"], string> = {
  queued: "Queued",
  running: "Running",
  blocked: "Blocked",
  interrupted: "Interrupted",
  needs_attention: "Needs attention",
  completed: "Completed",
  failed: "Failed",
  denied: "Denied",
  needs_repair: "Needs repair",
};

const graphStatusClass: Record<PlaybookGraphRunDetail["run"]["status"], string> = {
  queued: "border-zinc-200 bg-zinc-100 text-zinc-600",
  running: "border-blue-200 bg-blue-50 text-blue-700",
  blocked: "border-amber-200 bg-amber-50 text-amber-700",
  interrupted: "border-orange-200 bg-orange-50 text-orange-700",
  needs_attention: "border-orange-200 bg-orange-50 text-orange-700",
  completed: "border-emerald-200 bg-emerald-50 text-emerald-700",
  failed: "border-red-200 bg-red-50 text-red-700",
  denied: "border-zinc-200 bg-zinc-100 text-zinc-600",
  needs_repair: "border-red-200 bg-red-50 text-red-700",
};

const ctaCopyMap: Record<string, string> = {
  "sales.meeting-brief": "Prepare brief",
  "customer.renewal-risk-review": "Prepare risk review",
  "operations.weekly-status-digest": "Create digest",
  "ops.activity-snapshot": "Create snapshot",
};

const PLAYBOOK_RUN_LIST_LIMIT = 10;
const PLAYBOOK_HISTORY_LIMIT = 10;
const PLAYBOOK_ACTIVE_RUN_REFRESH_MS = 2_000;
const PLAYBOOK_RESULT_RENDERER_REVISION = 3;

const resultHeadline: Partial<Record<PlaybookRunDetail["status"], (name: string) => string>> = {
  completed: (name) => `${name} is ready.`,
  denied: () => "Run stopped.",
  failed: () => "Needs attention.",
  needs_attention: () => "Needs attention.",
  blocked: () => "Waiting for your review.",
};

const resultSub: Partial<Record<PlaybookRunDetail["status"], string>> = {
  completed: "Tessera finished preparing what you asked for.",
  denied: "You stopped the run before it finished. Nothing was changed.",
  failed: "Tessera ran into a problem and could not finish this run.",
  needs_attention: "This run needs a recovery decision before it can continue.",
  blocked: "This run needs a decision before it can continue.",
};

type GraphReviewArtifact = PlaybookGraphRunReviewSurface["activeArtifacts"][number];
type PlaybookRunProductView = NonNullable<PlaybookGraphRunReviewSurface["productView"]>;
type GraphQueueEntry = PlaybookGraphRunDetail["queue"][number];
type GraphWorkflowStepRecord = WorkflowRunStepRecord & {
  queueEntryId?: string;
  nodeKind?: GraphQueueEntry["nodeKind"];
  claimedAt?: string;
  lastHeartbeatAt?: string;
  updatedAt?: string;
};

interface ReviewScorecardSummary {
  overall?: number;
  pass?: boolean;
  findings: string[];
}

function normalizedStyleSelection(
  selection: GraphRunStyleSelection
): GraphRunStyleSelection | undefined {
  const copyType = selection.copyType?.trim();
  const override = selection.override?.trim();
  const toneNudges = (selection.toneNudges ?? [])
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const next: GraphRunStyleSelection = {
    toneNudges,
    ...(copyType ? { copyType } : {}),
    ...(override ? { override } : {}),
  };
  return copyType || override || toneNudges.length > 0 ? next : undefined;
}

function playbookRunErrorCopy(error: string | undefined): string | undefined {
  if (!error) return undefined;
  const message = error
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("Using keyring backend"))
    .join("\n");
  if (!message) return error;
  if (/scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication/i.test(message)) {
    return "Google Workspace needs additional access. Reconnect Google Workspace in Settings > Integrations and approve the requested Google access.";
  }
  if (/caller does not have permission|PERMISSION_DENIED|forbidden|access denied/i.test(message)) {
    return "Google Workspace denied this request. Reconnect Google Workspace in Settings > Integrations and make sure this account can use the requested Google service.";
  }
  return message;
}

const NODE_KIND_SOFT_MS: Record<GraphQueueEntry["nodeKind"], number | undefined> = {
  script: 30_000,
  condition: 5_000,
  join: 5_000,
  tool: 120_000,
  effect: 30_000,
  agent: 300_000,
  artifactWrite: 30_000,
  humanReview: undefined,
  parallelMap: undefined,
};

function softTimeoutCrossed(step: WorkflowRunStepRecord, now: number): boolean {
  const graphStep = step as GraphWorkflowStepRecord;
  if (
    graphStep.status !== "running" ||
    !graphStep.claimedAt ||
    !graphStep.lastHeartbeatAt ||
    !graphStep.nodeKind
  ) {
    return false;
  }
  const softMs = NODE_KIND_SOFT_MS[graphStep.nodeKind];
  if (!softMs) return false;
  return (
    now - Date.parse(graphStep.lastHeartbeatAt) <= 45_000 &&
    now - Date.parse(graphStep.claimedAt) >= softMs
  );
}

function attentionEvidenceCopy(entry: GraphQueueEntry): string | undefined {
  switch (entry.attentionEvidence?.code) {
    case "stale_lease":
      return "Tessera lost track of this step while it was running. You can retry or mark it failed.";
    case "stale_heartbeat":
      return "This step stopped reporting progress. It may be stuck inside a model or tool call.";
    case "hard_timeout":
      return "This step ran longer than its hard time limit. Retry or mark failed.";
    case "hard_timeout_observed":
      return "This step crossed its hard time limit.";
    case "lost_worker":
      return "The worker process for this step is no longer reachable.";
    case "ambiguous_recovery":
      return "Tessera could not determine how to recover this step automatically.";
    case "manual_mark_worker_lost":
      return "Marked as worker lost by a user.";
    case "cancellation_requested":
      return "Cancellation requested.";
    default:
      return undefined;
  }
}

interface ReviewEvidence {
  checkpointLabel: string;
  artifactLabel: string;
  artifactPreview: string | null;
  artifactPath: string | null;
  scorecardLabel: string | null;
  scorecard: ReviewScorecardSummary | null;
  preparedSummary: string;
  approveSummary: string;
  approveLabel: string;
}

interface SourceProvenanceSummary {
  artifactId: string;
  label: string;
  sourceKinds: string[];
  sourceCount: number | null;
  fixtureOnly: boolean | null;
  notes: string | null;
}

function stepIcon(status: WorkflowRunStepRecord["status"]) {
  if (status === "succeeded") return <CheckCircle2 size={16} className="text-emerald-600" />;
  if (status === "running") return <Loader2 size={16} className="animate-spin text-blue-600" />;
  if (status === "blocked") return <AlertTriangle size={16} className="text-amber-600" />;
  if (status === "needs_attention") return <AlertTriangle size={16} className="text-orange-600" />;
  return <Clock3 size={16} className="text-muted-foreground" />;
}

function stepStatusLabel(status: WorkflowRunStepRecord["status"]): string {
  if (status === "succeeded") return "Done";
  if (status === "running") return "Working";
  if (status === "blocked") return "Waiting for your review";
  if (status === "needs_attention") return "Needs attention";
  if (status === "failed") return "Needs attention";
  if (status === "denied") return "Stopped";
  return "Not started";
}

function progressStatusLabel(status: WorkflowRunStepRecord["status"]): string {
  if (status === "succeeded") return "Done";
  if (status === "running") return "Now";
  if (status === "blocked") return "Review";
  if (status === "needs_attention" || status === "failed") return "Attention";
  if (status === "denied") return "Stopped";
  if (status === "skipped") return "Skipped";
  return "Next";
}

function titleFromId(id: string): string {
  return id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
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

function packageVersionLabel(version: string | undefined): string | null {
  return version ? `Package ${version}` : null;
}

function runPackageVersion(run: PlaybookRunDetail | null): string | undefined {
  return run?.packageVersion;
}

function mergeRunById<T extends { runId: string }>(runs: T[], nextRun: T): T[] {
  const found = runs.some((run) => run.runId === nextRun.runId);
  return found
    ? runs.map((run) => (run.runId === nextRun.runId ? nextRun : run))
    : [nextRun, ...runs];
}

function formatCapabilityLabel(value: string): string {
  return titleFromId(value.replace(/^(?:skill|tool|integration)\./, ""));
}

function formatCapabilityBlockerMessage(blocker: {
  capability: string;
  reason?: string | null | undefined;
}): string {
  const label = formatCapabilityLabel(blocker.capability);
  if (!blocker.reason) return `Tessera could not use ${label}.`;
  if (blocker.reason.toLowerCase().includes(label.toLowerCase())) return blocker.reason;
  return `${label}: ${blocker.reason}`;
}

function formatSourceKindLabel(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "gmail" || normalized === "mail") return "Gmail";
  if (normalized === "web" || normalized === "web.search" || normalized === "web.fetch") {
    return "Web";
  }
  if (normalized === "feed" || normalized === "public-feed") return "Public feed";
  if (normalized === "cbp") return "CBP feed";
  return titleFromId(value);
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

function artifactLabel(artifactId: string): string {
  return artifactId
    .replace(/Scorecard$/i, " scorecard")
    .replace(/Brief$/i, " brief")
    .replace(/Draft$/i, " draft")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s._-]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function artifactPreviewText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of ["text", "markdown", "bodyMarkdown", "content", "body", "summary"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const thesis = typeof record.thesis === "string" ? record.thesis.trim() : "";
  const combined = [title, thesis].filter(Boolean).join("\n\n");
  if (combined) return combined;
  return null;
}

function compactReviewPreviewText(value: string): string {
  return value
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .trim();
}

function parseJsonObjectFromText(value: string): Record<string, unknown> | null {
  const trimmed = value.trim();
  const candidates = [
    trimmed,
    trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim(),
    trimmed.includes("{")
      ? trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1)
      : undefined,
  ].filter(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0
  );
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {}
  }
  return null;
}

function scorecardRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.overall === "number" ||
    typeof record.pass === "boolean" ||
    Array.isArray(record.findings)
  ) {
    return record;
  }
  return typeof record.text === "string" ? parseJsonObjectFromText(record.text) : null;
}

function isScorecardArtifact(artifact: GraphReviewArtifact): boolean {
  if (/scorecard/i.test(artifact.artifactId)) return true;
  const record = scorecardRecord(artifact.value);
  if (!record) return false;
  return typeof record.overall === "number" || typeof record.pass === "boolean";
}

function scorecardSummary(value: unknown): ReviewScorecardSummary | null {
  const record = scorecardRecord(value);
  if (!record) return null;
  const overall = typeof record.overall === "number" ? record.overall : undefined;
  const pass = typeof record.pass === "boolean" ? record.pass : undefined;
  const findings = Array.isArray(record.findings)
    ? record.findings.filter((finding): finding is string => typeof finding === "string")
    : [];
  if (overall === undefined && pass === undefined && findings.length === 0) return null;
  return {
    ...(overall !== undefined ? { overall } : {}),
    ...(pass !== undefined ? { pass } : {}),
    findings,
  };
}

function preferredReviewArtifact(artifacts: GraphReviewArtifact[]): GraphReviewArtifact | null {
  const withPreview = artifacts.filter((artifact) => artifactPreviewText(artifact.value));
  const businessArtifacts = withPreview.filter(
    (artifact) =>
      !/^(normalizedIntake|keywordClusters|researchPlan|researchResults)$/i.test(
        artifact.artifactId
      ) && !isScorecardArtifact(artifact)
  );
  return (
    businessArtifacts[0] ?? withPreview.find((artifact) => !isScorecardArtifact(artifact)) ?? null
  );
}

function reviewApproveLabel(artifact: GraphReviewArtifact | null): string {
  if (!artifact) return "Approve";
  const label = artifactLabel(artifact.artifactId).toLowerCase();
  if (label.includes("brief")) return "Approve brief";
  if (label.includes("article")) return "Approve article";
  if (label.includes("draft")) return "Approve draft";
  return "Approve";
}

function reviewEvidenceFromSurface(
  surface: PlaybookGraphRunReviewSurface | null
): ReviewEvidence | null {
  if (!surface) return null;
  const reviewEntry =
    surface.detail.queue.find(
      (entry) => entry.status === "blocked" && entry.nodeKind === "humanReview"
    ) ??
    surface.detail.queue.find(
      (entry) => entry.status === "blocked" && entry.nodeKind === "effect"
    ) ??
    null;
  if (!reviewEntry) return null;

  const consumedKeys = new Set(
    reviewEntry.consumesArtifacts.map((artifact) => `${artifact.artifactId}:${artifact.versionId}`)
  );
  const consumedArtifacts = surface.activeArtifacts.filter((artifact) =>
    consumedKeys.has(`${artifact.artifactId}:${artifact.versionId}`)
  );
  const scorecardArtifact =
    consumedArtifacts.find(isScorecardArtifact) ??
    surface.activeArtifacts.find(isScorecardArtifact);
  const preparedArtifact =
    preferredReviewArtifact(consumedArtifacts) ?? preferredReviewArtifact(surface.activeArtifacts);
  const scorecard = scorecardArtifact ? scorecardSummary(scorecardArtifact.value) : null;
  const artifact = preparedArtifact ?? scorecardArtifact ?? null;
  if (!artifact) return null;

  const artifactPaths = graphRunArtifactWritePaths(surface.detail);
  const label = artifactLabel(artifact.artifactId);
  const preview = artifactPreviewText(artifact.value);
  const scoreText =
    scorecard?.overall !== undefined
      ? ` Score ${scorecard.overall}/100${scorecard.pass === false ? "; needs improvement" : "."}`
      : scorecard?.pass === false
        ? " Needs improvement."
        : "";
  return {
    checkpointLabel: titleFromId(reviewEntry.nodeId),
    artifactLabel: label,
    artifactPreview: preview,
    artifactPath: artifactPaths.get(artifact.artifactId) ?? null,
    scorecardLabel: scorecardArtifact ? artifactLabel(scorecardArtifact.artifactId) : null,
    scorecard,
    preparedSummary: `Tessera prepared ${label.toLowerCase()} for review.${scoreText}`,
    approveSummary: `Tessera will continue this run using the ${label.toLowerCase()}.`,
    approveLabel: reviewApproveLabel(preparedArtifact),
  };
}

function runStatusCopy(run: PlaybookRunDetail): string {
  if (run.status === "blocked" && !run.approval) return "Blocked";
  return statusCopy[run.status];
}

function ReviewEvidenceBlock({
  evidence,
  compact,
  hideArtifactPreview,
}: {
  evidence: ReviewEvidence;
  compact?: boolean;
  hideArtifactPreview?: boolean;
}) {
  const score = evidence.scorecard;
  const scoreTone =
    score?.pass === false
      ? "text-amber-800"
      : score?.pass === true
        ? "text-emerald-700"
        : "text-muted-foreground";
  const previewText =
    evidence.artifactPreview && compact
      ? compactReviewPreviewText(evidence.artifactPreview)
      : evidence.artifactPreview;

  return (
    <div className={cn("space-y-3", compact ? "text-amber-900" : "text-foreground")}>
      <div>
        <div className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {evidence.checkpointLabel}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">{evidence.artifactLabel}</span>
          {score?.overall !== undefined ? (
            <span className={cn("rounded-full border px-2 py-0.5 text-xs", scoreTone)}>
              {score.overall}/100
            </span>
          ) : null}
          {score?.pass === false ? (
            <span className="rounded-full border border-amber-300 px-2 py-0.5 text-xs text-amber-800">
              Needs improvement
            </span>
          ) : score?.pass === true ? (
            <span className="rounded-full border border-emerald-200 px-2 py-0.5 text-xs text-emerald-700">
              Passed
            </span>
          ) : null}
        </div>
      </div>

      {score?.findings.length ? (
        <div
          className={cn("space-y-1 text-sm", compact ? "text-amber-800" : "text-muted-foreground")}
        >
          {score.findings.slice(0, compact ? 2 : 4).map((finding) => (
            <p key={finding}>{finding}</p>
          ))}
        </div>
      ) : null}

      {previewText && !hideArtifactPreview ? (
        <div
          className={cn(
            "whitespace-pre-wrap text-sm leading-6",
            compact ? "line-clamp-6 text-amber-900" : "max-h-80 overflow-y-auto text-foreground"
          )}
        >
          {previewText}
        </div>
      ) : null}
    </div>
  );
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

function graphArtifactPathValue(value: unknown): string {
  return String(value ?? "")
    .replace(/[\\/:\0]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function renderGraphArtifactWritePath(path: string, input: Record<string, unknown>): string {
  return path.replace(/\{\{\s*inputs\.([A-Za-z0-9_.:-]+)\s*\}\}/g, (_match, key: string) => {
    const value = key.split(".").reduce<unknown>((cursor, segment) => {
      if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
      return (cursor as Record<string, unknown>)[segment];
    }, input);
    return graphArtifactPathValue(value) || "untitled";
  });
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

  return runOutputs[kind];
}

function playbookOutputArtifactPath(kind: string, value: unknown): string | null {
  if (
    kind === "meetingBrief" ||
    kind === "businessBrief" ||
    kind === "statusDigest" ||
    filePathFromValue(value)
  ) {
    return filePathFromValue(value);
  }

  return null;
}

function visiblePlaybookOutputs(
  outputs: Array<{ kind: string; label: string }>,
  runOutputs: Record<string, unknown>,
  inferredOutputKinds?: ReadonlySet<string>
): Array<{ kind: string; label: string }> {
  const declaredOutputs = outputs.filter((output) =>
    shouldShowResultOutput(output.kind, playbookOutputValue(output.kind, runOutputs))
  );
  if (declaredOutputs.length > 0) return declaredOutputs;

  const declaredKinds = new Set(declaredOutputs.map((output) => output.kind));

  const materializedOutputs = Object.entries(runOutputs).flatMap(([kind, value]) => {
    if (
      declaredKinds.has(kind) ||
      (inferredOutputKinds && !inferredOutputKinds.has(kind)) ||
      !shouldShowInferredGraphOutput(kind, value)
    ) {
      return [];
    }
    return [{ kind, label: artifactLabel(kind) }];
  });

  return [...declaredOutputs, ...materializedOutputs];
}

function mergeOutputDeclarations(
  ...groups: Array<Array<{ kind: string; label: string }>>
): Array<{ kind: string; label: string }> {
  const merged = new Map<string, { kind: string; label: string }>();
  for (const group of groups) {
    for (const output of group) {
      if (!merged.has(output.kind)) {
        merged.set(output.kind, output);
      }
    }
  }
  return [...merged.values()];
}

function graphRunResultOutputDeclarations(
  detail: PlaybookGraphRunDetail | null
): WorkflowOutputDeclaration[] {
  if (!detail) return [];
  const declared = graphSnapshotOutputDeclarations(detail);
  if (declared.length > 0) return declared;

  const declaredKinds = new Set(declared.map((output) => output.kind));
  const runOutputs = graphRunOutputs(detail);
  const artifactIds = [...new Set(detail.artifacts.map((artifact) => artifact.artifactId))];
  const inferred = artifactIds.flatMap((kind): WorkflowOutputDeclaration[] => {
    const value = runOutputs[kind];
    if (declaredKinds.has(kind) || !shouldShowInferredGraphOutput(kind, value)) {
      return [];
    }
    return [{ kind, label: artifactLabel(kind) }];
  });
  return mergeOutputDeclarations(declared, inferred);
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

function shouldShowInferredGraphOutput(kind: string, value: unknown): boolean {
  if (!shouldShowResultOutput(kind, value)) return false;
  if (
    /^(normalizedIntake|keywordClusters|researchPlan|researchResults|searchResults|fetchCandidate|fetchedSource|articleReview)$/i.test(
      kind
    )
  ) {
    return false;
  }
  if (!playbookOutputArtifactPath(kind, value)) return false;
  return !/scorecard/i.test(kind);
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

function runNeedsLiveRefresh(
  run: PlaybookRunDetail | null,
  graphRun: PlaybookGraphRunDetail | null
): boolean {
  if (run?.status === "running") return true;
  return graphRun?.run.status === "queued" || graphRun?.run.status === "running";
}

function latestCompletedRunForPlaybook(
  runs: PlaybookRunDetail[],
  playbookId: string
): PlaybookRunDetail | null {
  let latestRun: PlaybookRunDetail | null = null;
  let latestTime = Number.NEGATIVE_INFINITY;

  for (const run of runs) {
    if (run.workflowId !== playbookId || run.status !== "completed") continue;
    const timestamp = Date.parse(run.updatedAt ?? "");
    const comparableTime = Number.isFinite(timestamp) ? timestamp : 0;
    if (!latestRun || comparableTime >= latestTime) {
      latestRun = run;
      latestTime = comparableTime;
    }
  }

  return latestRun;
}

function workflowStepStatusFromGraph(
  status: PlaybookGraphRunDetail["queue"][number]["status"]
): WorkflowRunStepRecord["status"] {
  if (status === "succeeded" || status === "memoized") return "succeeded";
  if (status === "blocked") return "blocked";
  if (status === "needs_attention") return "needs_attention";
  if (status === "failed" || status === "interrupted") return "failed";
  if (status === "skipped") return "skipped";
  return "running";
}

function graphRunHasQueuedRuntimeWork(detail: PlaybookGraphRunDetail): boolean {
  if (detail.run.status !== "queued" && detail.run.status !== "running") return false;
  return detail.queue.some(
    (entry) =>
      entry.status === "queued" &&
      (entry.nodeKind === "agent" || entry.nodeKind === "artifactWrite")
  );
}

function graphRunOutputs(detail: PlaybookGraphRunDetail | null): Record<string, unknown> {
  if (!detail) return {};
  const latestByArtifact = new Map<string, PlaybookGraphRunDetail["artifacts"][number]>();
  for (const artifact of detail.artifacts) {
    latestByArtifact.set(artifact.artifactId, artifact);
  }
  const outputs: Record<string, unknown> = {};
  for (const artifact of latestByArtifact.values()) {
    outputs[artifact.artifactId] = artifact.value;
    const segments = artifact.nodePath.split("/");
    const nodeKey = segments[segments.length - 1];
    if (nodeKey && !outputs[nodeKey]) outputs[nodeKey] = artifact.value;
  }
  for (const [artifactId, path] of graphRunArtifactWritePaths(detail)) {
    const value = outputs[artifactId];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      outputs[artifactId] = { path, ...(value !== undefined ? { value } : {}) };
      continue;
    }
    outputs[artifactId] = { ...value, path };
  }
  return outputs;
}

function recordFromValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sourceKindsFromValue(value: unknown): string[] {
  const record = recordFromValue(value);
  if (!record) return [];
  const provenance = recordFromValue(record.provenance);
  const sourceKinds = provenance?.sourceKinds ?? record.sourceKinds;
  if (Array.isArray(sourceKinds)) {
    return sourceKinds.filter((item): item is string => typeof item === "string" && !!item.trim());
  }
  const counts = recordFromValue(provenance?.sourceCounts) ?? recordFromValue(record.sourceCounts);
  if (counts) return Object.keys(counts).filter((key) => key.trim());
  const rows = Array.isArray(record.signals)
    ? record.signals
    : Array.isArray(record.items)
      ? record.items
      : Array.isArray(record.rows)
        ? record.rows
        : [];
  return [
    ...new Set(
      rows
        .map((row) => recordFromValue(row)?.sourceType)
        .filter((item): item is string => typeof item === "string" && !!item.trim())
    ),
  ].sort();
}

function sourceCountFromValue(value: unknown): number | null {
  const record = recordFromValue(value);
  if (!record) return null;
  const provenance = recordFromValue(record.provenance);
  const summary = recordFromValue(record.summary);
  const direct = provenance?.sourceCount ?? summary?.sourceCount ?? record.sourceCount;
  if (typeof direct === "number" && Number.isFinite(direct)) return direct;
  const sourceCounts =
    recordFromValue(provenance?.sourceCounts) ?? recordFromValue(record.sourceCounts);
  if (sourceCounts) {
    const total = Object.values(sourceCounts).reduce<number>(
      (sum, value) => (typeof value === "number" && Number.isFinite(value) ? sum + value : sum),
      0
    );
    if (total > 0) return total;
  }
  const rows = Array.isArray(record.signals)
    ? record.signals
    : Array.isArray(record.items)
      ? record.items
      : Array.isArray(record.rows)
        ? record.rows
        : [];
  return rows.length > 0 ? rows.length : null;
}

function sourceProvenanceSummaries(
  detail: PlaybookGraphRunDetail | null
): SourceProvenanceSummary[] {
  if (!detail) return [];
  const latestByArtifact = new Map<string, PlaybookGraphRunDetail["artifacts"][number]>();
  for (const artifact of detail.artifacts) latestByArtifact.set(artifact.artifactId, artifact);

  return [...latestByArtifact.values()].flatMap((artifact) => {
    const record = recordFromValue(artifact.value);
    const provenance = recordFromValue(record?.provenance);
    const sourceKinds = sourceKindsFromValue(artifact.value);
    const sourceCount = sourceCountFromValue(artifact.value);
    if (sourceKinds.length === 0 && sourceCount === null) return [];
    const fixtureOnly =
      typeof provenance?.fixtureOnly === "boolean"
        ? provenance.fixtureOnly
        : typeof record?.fixtureOnly === "boolean"
          ? record.fixtureOnly
          : null;
    return [
      {
        artifactId: artifact.artifactId,
        label: artifactLabel(artifact.artifactId),
        sourceKinds,
        sourceCount,
        fixtureOnly,
        notes: typeof provenance?.notes === "string" ? provenance.notes : null,
      },
    ];
  });
}

function graphNodeRecords(value: unknown): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const seen = new Set<object>();
  const stack: unknown[] = [value];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);

    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }

    const record = current as Record<string, unknown>;
    if (typeof record.id === "string" && typeof record.kind === "string") {
      records.push(record);
    }
    stack.push(...Object.values(record));
  }

  return records;
}

function graphNodeMetadata(
  detail: PlaybookGraphRunDetail
): Map<string, { label?: string; phase?: string }> {
  const metadata = new Map<string, { label?: string; phase?: string }>();
  const graph = graphSnapshotObject(detail);
  if (!graph) return metadata;

  for (const node of graphNodeRecords(graph)) {
    if (typeof node.id !== "string") continue;
    const label = typeof node.label === "string" ? node.label : undefined;
    const phase = typeof node.phase === "string" ? node.phase : undefined;
    if (label || phase) {
      metadata.set(node.id, {
        ...(label ? { label } : {}),
        ...(phase ? { phase } : {}),
      });
    }
  }

  return metadata;
}

function graphSnapshotObject(detail: PlaybookGraphRunDetail): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail.run.snapshot.snapshotJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const graph = record.graph && typeof record.graph === "object" ? record.graph : record;
  return graph && typeof graph === "object" && !Array.isArray(graph)
    ? (graph as Record<string, unknown>)
    : null;
}

function graphSnapshotOutputDeclarations(
  detail: PlaybookGraphRunDetail
): WorkflowOutputDeclaration[] {
  const graph = graphSnapshotObject(detail);
  const metadata = graph?.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const outputs = (metadata as Record<string, unknown>).outputs;
  if (!Array.isArray(outputs)) return [];

  return outputs.flatMap((output): WorkflowOutputDeclaration[] => {
    if (!output || typeof output !== "object" || Array.isArray(output)) return [];
    const record = output as Record<string, unknown>;
    if (typeof record.kind !== "string" || !record.kind.trim()) return [];
    if (typeof record.label !== "string" || !record.label.trim()) return [];
    return [
      {
        kind: record.kind,
        label: record.label,
        ...(typeof record.description === "string" && record.description.trim()
          ? { description: record.description }
          : {}),
        ...(typeof record.id === "string" && record.id.trim() ? { id: record.id } : {}),
        ...(typeof record.layoutScript === "string" && record.layoutScript.trim()
          ? { layoutScript: record.layoutScript }
          : {}),
        ...(typeof record.layout === "string" && record.layout.trim()
          ? { layout: record.layout }
          : {}),
        ...(record.layoutData &&
        typeof record.layoutData === "object" &&
        !Array.isArray(record.layoutData)
          ? { layoutData: record.layoutData as DashboardLayout }
          : {}),
      },
    ];
  });
}

function graphSnapshotText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function graphSnapshotTextArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && !!item.trim());
}

function graphSnapshotPlaybookSummary(
  detail: PlaybookGraphRunDetail,
  outputs: WorkflowOutputDeclaration[]
): PlaybookSummary | null {
  if (outputs.length === 0) return null;
  const graph = graphSnapshotObject(detail);
  if (!graph) return null;
  const metadata =
    graph.metadata && typeof graph.metadata === "object" && !Array.isArray(graph.metadata)
      ? (graph.metadata as Record<string, unknown>)
      : {};

  return {
    id: detail.run.playbookId,
    version: 1,
    packageVersion: detail.run.snapshot.packageVersion,
    name: graphSnapshotText(graph.name) ?? titleFromId(detail.run.playbookId),
    ...(graphSnapshotText(graph.description)
      ? { description: graphSnapshotText(graph.description) }
      : {}),
    graphHash: detail.run.snapshot.graphHash,
    sourceHash: detail.run.snapshot.sourceHash,
    ...(graphSnapshotText(metadata.category)
      ? { category: graphSnapshotText(metadata.category) }
      : {}),
    ...(graphSnapshotText(metadata.businessUseCase)
      ? { businessUseCase: graphSnapshotText(metadata.businessUseCase) }
      : {}),
    requiredCapabilities: [],
    optionalCapabilities: [],
    outputs,
    stepCount: graphNodeRecords(graph).length,
    phases: graphSnapshotTextArray(metadata.phases),
  };
}

function playbookWithRunSnapshotOutputs(
  detail: PlaybookGraphRunDetail,
  playbook: PlaybookSummary | PlaybookDetail | null
): PlaybookSummary | PlaybookDetail | null {
  const outputs = graphSnapshotOutputDeclarations(detail);
  if (outputs.length === 0) return playbook;
  if (!playbook || playbook.id !== detail.run.playbookId) {
    return graphSnapshotPlaybookSummary(detail, outputs) ?? playbook;
  }
  return { ...playbook, packageVersion: detail.run.snapshot.packageVersion, outputs };
}

function graphRunArtifactWritePaths(detail: PlaybookGraphRunDetail): Map<string, string> {
  const paths = new Map<string, string>();
  const graph = graphSnapshotObject(detail);
  if (!graph) return paths;
  const materializedArtifactIds = new Set(detail.artifacts.map((artifact) => artifact.artifactId));
  const artifactDeclarations = graph.artifacts;
  if (artifactDeclarations && typeof artifactDeclarations === "object") {
    for (const [artifactId, declaration] of Object.entries(
      artifactDeclarations as Record<string, unknown>
    )) {
      if (!materializedArtifactIds.has(artifactId)) continue;
      if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) continue;
      const materialize = (declaration as Record<string, unknown>).materialize;
      if (typeof materialize === "string" && materialize.trim()) {
        paths.set(artifactId, renderGraphArtifactWritePath(materialize, detail.run.input));
      }
    }
  }

  const nodes = graph.nodes;
  if (Array.isArray(nodes)) {
    const completedNodeIds = new Set(
      detail.queue
        .filter((entry) => entry.nodeKind === "artifactWrite" && entry.status === "succeeded")
        .map((entry) => entry.nodeId)
    );
    for (const node of nodes) {
      if (!node || typeof node !== "object" || Array.isArray(node)) continue;
      const candidate = node as Record<string, unknown>;
      if (
        candidate.kind !== "artifactWrite" ||
        typeof candidate.id !== "string" ||
        typeof candidate.artifact !== "string" ||
        typeof candidate.path !== "string" ||
        !completedNodeIds.has(candidate.id)
      ) {
        continue;
      }
      paths.set(candidate.artifact, renderGraphArtifactWritePath(candidate.path, detail.run.input));
    }
  }

  const effectNodeById = new Map<string, Record<string, unknown>>();
  for (const node of graphNodeRecords(graph)) {
    if (typeof node.id === "string" && node.kind === "effect") {
      effectNodeById.set(node.id, node);
    }
  }

  for (const effect of detail.effects) {
    if (
      effect.status !== "committed" &&
      effect.status !== "replayed" &&
      effect.commitStatus !== "committed" &&
      effect.commitStatus !== "replayed"
    ) {
      continue;
    }
    const artifactId =
      effect.outputArtifactId ??
      effectArtifactIdFromNode(effectNodeById.get(effect.nodeId)) ??
      effectArtifactIdFromNode(effectNodeById.get(lastNodePathSegment(effect.nodePath)));
    const outputPath =
      effect.output?.kind === "workspace" ? effect.output.path : effect.outputReference;
    if (!artifactId || !outputPath) continue;
    paths.set(artifactId, renderGraphArtifactWritePath(outputPath, detail.run.input));
  }
  return paths;
}

function lastNodePathSegment(nodePath: string): string {
  const segments = nodePath.split("/");
  return segments[segments.length - 1] ?? nodePath;
}

function effectArtifactIdFromNode(node: Record<string, unknown> | undefined): string | null {
  if (!node) return null;
  if (typeof node.outputArtifact === "string" && node.outputArtifact.trim()) {
    return node.outputArtifact;
  }
  const input = node.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const inputRecord = input as Record<string, unknown>;
  if (typeof inputRecord.sourceArtifact === "string" && inputRecord.sourceArtifact.trim()) {
    return inputRecord.sourceArtifact;
  }
  const value = inputRecord.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const valueRecord = value as Record<string, unknown>;
  return typeof valueRecord.artifact === "string" && valueRecord.artifact.trim()
    ? valueRecord.artifact
    : null;
}

function graphRunWorkspaceRoot(detail: PlaybookGraphRunDetail | null): string | null {
  return detail?.run.materialization?.kind === "workspace"
    ? detail.run.materialization.workspaceRoot
    : null;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function tokenUsageFromValue(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = (value as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return undefined;
  const candidate = usage as Record<string, unknown>;
  if (
    !isNonNegativeInteger(candidate.inputTokens) ||
    !isNonNegativeInteger(candidate.outputTokens) ||
    !isNonNegativeInteger(candidate.totalTokens)
  ) {
    return undefined;
  }
  const cachedInputTokens = isNonNegativeInteger(candidate.cachedInputTokens)
    ? candidate.cachedInputTokens
    : undefined;
  const reasoningTokens = isNonNegativeInteger(candidate.reasoningTokens)
    ? candidate.reasoningTokens
    : undefined;
  return {
    inputTokens: candidate.inputTokens,
    outputTokens: candidate.outputTokens,
    totalTokens: candidate.totalTokens,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}

function combineTokenUsage(current: TokenUsage, next: TokenUsage): TokenUsage {
  const cachedInputTokens =
    current.cachedInputTokens !== undefined || next.cachedInputTokens !== undefined
      ? (current.cachedInputTokens ?? 0) + (next.cachedInputTokens ?? 0)
      : undefined;
  const reasoningTokens =
    current.reasoningTokens !== undefined || next.reasoningTokens !== undefined
      ? (current.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0)
      : undefined;
  return {
    inputTokens: current.inputTokens + next.inputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
    totalTokens: current.totalTokens + next.totalTokens,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}

function graphRunUsage(detail: PlaybookGraphRunDetail | null): TokenUsage | undefined {
  if (!detail) return undefined;
  let usage: TokenUsage | undefined;
  for (const artifact of detail.artifacts) {
    const artifactUsage = tokenUsageFromValue(artifact.value);
    if (!artifactUsage) continue;
    usage = usage ? combineTokenUsage(usage, artifactUsage) : artifactUsage;
  }
  return usage;
}

function playbookRunHasModelStep(run: PlaybookRunDetail): boolean {
  return run.steps?.some((step) => step.kind === "agent") ?? false;
}

function dashboardLayoutFromPlaybook(
  playbook: PlaybookSummary | PlaybookDetail | null
): DashboardLayout | null {
  return playbook?.outputs?.find((output) => output.kind === "dashboard")?.layoutData ?? null;
}

function graphRunApproval(
  detail: PlaybookGraphRunDetail | null,
  playbook: PlaybookSummary | PlaybookDetail | null,
  productView?: PlaybookRunProductView | null
): PlaybookRunDetail["approval"] {
  if (
    !detail ||
    (detail.run.status !== "blocked" &&
      detail.run.status !== "interrupted" &&
      detail.run.status !== "needs_attention" &&
      detail.run.status !== "needs_repair")
  ) {
    return undefined;
  }
  const productAction = productView?.primaryAction;
  if (
    detail.run.status === "needs_repair" &&
    productAction &&
    (productAction.decision === "approve_repair" || productAction.decision === "retry_repair")
  ) {
    return {
      toolId: "graph.approveRepair",
      args: {
        playbookId: detail.run.playbookId,
        runId: detail.run.runId,
      },
      capability: "write",
      risk: {
        mutates: false,
        destructive: false,
        external: false,
        reversible: true,
        dryRunSupported: false,
      },
      preview:
        productView?.message ??
        detail.run.repairReason ??
        "Tessera needs to repair this run before continuing.",
      reasonCode: "graph_repair",
    };
  }
  if (
    productView?.state === "retry_available" &&
    productAction &&
    (productAction.decision === "retry_interrupted" ||
      productAction.decision === "retry_needs_attention")
  ) {
    const retryEntry = productAction.queueEntryId
      ? detail.queue.find((entry) => entry.queueEntryId === productAction.queueEntryId)
      : detail.queue.find(
          (entry) => entry.status === "interrupted" || entry.status === "needs_attention"
        );
    const stepLabel = retryEntry ? titleFromId(retryEntry.nodeId) : "this step";
    return {
      toolId:
        productAction.decision === "retry_interrupted"
          ? "graph.retryInterrupted"
          : "graph.retryNeedsAttention",
      args: {
        playbookId: detail.run.playbookId,
        runId: detail.run.runId,
        ...(retryEntry?.queueEntryId ? { queueEntryId: retryEntry.queueEntryId } : {}),
        stepLabel,
      },
      capability: "write",
      risk: {
        mutates: false,
        destructive: false,
        external: false,
        reversible: true,
        dryRunSupported: false,
      },
      preview: productView.message,
      reasonCode:
        productAction.decision === "retry_interrupted"
          ? "graph_interrupted_retry"
          : "graph_needs_attention_retry",
    };
  }
  if (detail.run.blockedReason?.includes("execution context changed")) {
    return {
      toolId: "graph.approveContextChange",
      args: {
        playbookId: detail.run.playbookId,
        runId: detail.run.runId,
      },
      capability: "write",
      risk: {
        mutates: false,
        destructive: false,
        external: false,
        reversible: true,
        dryRunSupported: false,
      },
      preview:
        detail.run.blockedReason ??
        "Tessera needs approval to continue this run after its setup changed.",
      reasonCode: "graph_context_change",
    };
  }
  const interruptedEntry = detail.queue.find((entry) => entry.status === "interrupted");
  if (interruptedEntry) {
    const stepLabel = titleFromId(interruptedEntry.nodeId);
    return {
      toolId: "graph.retryInterrupted",
      args: {
        playbookId: detail.run.playbookId,
        runId: detail.run.runId,
        queueEntryId: interruptedEntry.queueEntryId,
        stepLabel,
      },
      capability: "write",
      risk: {
        mutates: false,
        destructive: false,
        external: false,
        reversible: true,
        dryRunSupported: false,
      },
      preview:
        interruptedEntry.blockedReason ??
        `Tessera stopped while working on ${stepLabel}. This can happen if the app or sidecar restarted during the step.`,
      reasonCode: "graph_interrupted_retry",
    };
  }
  const attentionEntry = detail.queue.find((entry) => entry.status === "needs_attention");
  if (attentionEntry) {
    const stepLabel = titleFromId(attentionEntry.nodeId);
    return {
      toolId: "graph.retryNeedsAttention",
      args: {
        playbookId: detail.run.playbookId,
        runId: detail.run.runId,
        queueEntryId: attentionEntry.queueEntryId,
        stepLabel,
      },
      capability: "write",
      risk: {
        mutates: false,
        destructive: false,
        external: false,
        reversible: true,
        dryRunSupported: false,
      },
      preview:
        attentionEvidenceCopy(attentionEntry) ??
        attentionEntry.attentionEvidence?.reason ??
        attentionEntry.blockedReason ??
        `Tessera needs a recovery decision before retrying ${stepLabel}.`,
      reasonCode: "graph_needs_attention_retry",
    };
  }
  const reviewEntry = detail.queue.find(
    (entry) =>
      entry.status === "blocked" &&
      (entry.nodeKind === "humanReview" || entry.nodeKind === "effect")
  );
  if (!reviewEntry) return undefined;
  const isEffectApproval = reviewEntry.nodeKind === "effect";
  return {
    toolId: isEffectApproval ? "graph.effectApproval" : "graph.humanReview",
    args: {
      playbookId: detail.run.playbookId,
      runId: detail.run.runId,
      queueEntryId: reviewEntry.queueEntryId,
    },
    capability: "write",
    risk: {
      mutates: false,
      destructive: false,
      external: false,
      reversible: true,
      dryRunSupported: false,
    },
    preview: isEffectApproval
      ? "Tessera paused before writing to the workspace. Review what it prepared before continuing."
      : "Tessera paused at a review checkpoint. Review what it prepared before continuing.",
    reasonCode: isEffectApproval ? "graph_effect_approval" : "graph_human_review",
  };
}

function graphRunToPlaybookRunDetail(
  detail: PlaybookGraphRunDetail,
  playbook: PlaybookSummary | PlaybookDetail | null,
  productView?: PlaybookRunProductView | null
): PlaybookRunDetail {
  const outputs = graphRunOutputs(detail);
  const usage = graphRunUsage(detail);
  const playbookForRun = playbookWithRunSnapshotOutputs(detail, playbook);
  const detailSteps =
    playbookForRun && "steps" in playbookForRun
      ? new Map(playbookForRun.steps.map((step) => [step.id, step]))
      : new Map<string, PlaybookDetail["steps"][number]>();
  const snapshotMetadata = graphNodeMetadata(detail);
  const steps: GraphWorkflowStepRecord[] = detail.queue.map((entry) => ({
    id: entry.nodeId,
    queueEntryId: entry.queueEntryId,
    label:
      detailSteps.get(entry.nodeId)?.label ??
      snapshotMetadata.get(entry.nodeId)?.label ??
      titleFromId(entry.nodeId),
    kind: entry.nodeKind === "agent" ? ("agent" as const) : ("tool" as const),
    phase:
      detailSteps.get(entry.nodeId)?.phase ??
      snapshotMetadata.get(entry.nodeId)?.phase ??
      playbookForRun?.phases?.[0] ??
      "Run",
    status: workflowStepStatusFromGraph(entry.status),
    startedAt: entry.claimedAt ?? entry.createdAt,
    nodeKind: entry.nodeKind,
    ...(entry.completedAt ? { completedAt: entry.completedAt } : {}),
    ...(entry.error ? { error: playbookRunErrorCopy(entry.error) } : {}),
    ...(entry.claimedAt ? { claimedAt: entry.claimedAt } : {}),
    ...(entry.lastHeartbeatAt ? { lastHeartbeatAt: entry.lastHeartbeatAt } : {}),
    updatedAt: entry.updatedAt,
  }));

  return {
    runId: detail.run.runId,
    workflowId: detail.run.playbookId,
    packageVersion: detail.run.snapshot.packageVersion,
    status: workflowStatusFromGraphRunDetail(detail),
    currentStepId: detail.run.currentQueueEntryId,
    input: detail.run.input,
    outputs,
    assignmentPlan: detail.run.assignmentPlan,
    ...(usage ? { usage } : {}),
    dashboardLayout: dashboardLayoutFromPlaybook(playbookForRun) ?? undefined,
    approval: graphRunApproval(detail, playbookForRun, productView),
    error: playbookRunErrorCopy(
      detail.run.error ?? detail.run.repairReason ?? detail.run.blockedReason
    ),
    startedAt: detail.run.startedAt,
    updatedAt: detail.run.updatedAt,
    completedAt: detail.run.completedAt,
    steps,
    events: detail.operations.map((operation) => ({
      id: operation.operationRecordId,
      runId: operation.runId,
      workflowId: detail.run.playbookId,
      status: operation.status === "failed" ? ("failed" as const) : ("succeeded" as const),
      message: `${titleFromId(operation.kind)} ${operation.status}`,
      createdAt: operation.createdAt,
      metadata: {
        actionSpecId: operation.actionSpecId,
        kind: operation.kind,
      },
    })),
    sourceGaps: [],
    playbook: playbookForRun ?? undefined,
  };
}

function graphRunRecordToPlaybookRunDetail(
  run: PlaybookGraphRunRecord,
  playbook: PlaybookSummary | PlaybookDetail | null
): PlaybookRunDetail {
  return {
    runId: run.runId,
    workflowId: run.playbookId,
    packageVersion: run.snapshot.packageVersion,
    status: workflowStatusFromGraphRunRecord(run),
    currentStepId: run.currentQueueEntryId,
    input: run.input,
    outputs: {},
    assignmentPlan: run.assignmentPlan,
    error: playbookRunErrorCopy(run.error ?? run.repairReason ?? run.blockedReason),
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    sourceGaps: [],
    playbook: playbook ?? undefined,
  };
}

function outputLabels(playbook?: PlaybookSummary | PlaybookDetail): string[] {
  return playbook?.outputs?.map((output) => output.label) ?? ["Result"];
}

function PlaybookListSkeleton() {
  const rows = ["alpha", "bravo", "charlie", "delta", "echo"];

  return (
    <div className="space-y-4 px-3 py-1" aria-label="Loading playbooks">
      <div className="h-3 w-24 rounded bg-muted-foreground/15" />
      {rows.map((row) => (
        <div key={row} className="space-y-2 rounded-md py-2">
          <div className="h-4 w-4/5 rounded bg-muted-foreground/15" />
          <div className="h-3 w-full rounded bg-muted-foreground/10" />
          <div className="h-3 w-2/3 rounded bg-muted-foreground/10" />
        </div>
      ))}
    </div>
  );
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
        "integration.mail.drafts.write",
        "integration.mail.drafts.send",
        "integration.sheets.workbooks.write",
        "integration.sheets.rows.write",
        "integration.docs.documents.write",
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

function assignmentPlanWithCurrentCandidates(
  savedPlan: WorkflowRunAssignmentPlan,
  preview: PlaybookAssignmentPreviewResult
): WorkflowRunAssignmentPlan {
  const assignments: WorkflowRunAssignmentPlan["assignments"] = {
    ...(preview.assignmentPlan?.assignments ?? {}),
  };

  for (const nodePreview of preview.nodePreviews) {
    const savedAssignment = savedPlan.assignments[nodePreview.stepId];
    const currentCandidate = nodePreview.candidates.find(
      (candidate) => candidate.agentId === savedAssignment?.agentId && !candidate.disabled
    );
    if (currentCandidate) {
      assignments[nodePreview.stepId] = currentCandidate.assignment;
    }
  }

  return {
    resolverVersion: savedPlan.resolverVersion,
    createdAt: savedPlan.createdAt,
    assignments,
  };
}

function firstAssignedAgentId(
  assignmentPlan: WorkflowRunAssignmentPlan | null | undefined
): string | undefined {
  return Object.values(assignmentPlan?.assignments ?? {}).find((assignment) => assignment.agentId)
    ?.agentId;
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

function UsageSummary({
  usage,
  modelStepRan,
}: {
  usage: TokenUsage | undefined;
  modelStepRan: boolean;
}) {
  if (!usage) {
    return (
      <div className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
        {modelStepRan ? "Not reported by provider." : "No model token usage recorded for this run."}
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

type ProgressUpdateTone = "working" | "success" | "attention" | "waiting";

interface ProgressUpdate {
  key: string;
  title: string;
  detail: string;
  createdAt?: string;
  tone: ProgressUpdateTone;
}

interface ProgressDisplayStep {
  key: string;
  label: string;
  phase: string;
  status: WorkflowRunStepRecord["status"];
  count: number;
  active: boolean;
  softTimeout: boolean;
  latestAt?: string;
}

type ProgressDisplayRow =
  | { kind: "step"; step: ProgressDisplayStep }
  | { kind: "gap"; key: string; hiddenCount: number };

function timestampMs(value?: string): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function laterTimestamp(current: string | undefined, next: string | undefined): string | undefined {
  if (!current) return next;
  if (!next) return current;
  return timestampMs(next) > timestampMs(current) ? next : current;
}

function progressStepTimestamp(step: WorkflowRunStepRecord): string | undefined {
  const graphStep = step as GraphWorkflowStepRecord;
  return (
    graphStep.updatedAt ??
    step.completedAt ??
    graphStep.lastHeartbeatAt ??
    graphStep.claimedAt ??
    step.startedAt
  );
}

function isCurrentProgressStep(step: WorkflowRunStepRecord, currentStepId?: string): boolean {
  if (!currentStepId) return false;
  const graphStep = step as GraphWorkflowStepRecord;
  return graphStep.queueEntryId === currentStepId || step.id === currentStepId;
}

function activeProgressStep(
  steps: WorkflowRunStepRecord[],
  currentStepId?: string
): WorkflowRunStepRecord | null {
  const current = steps.find(
    (step) =>
      isCurrentProgressStep(step, currentStepId) &&
      step.status !== "succeeded" &&
      step.status !== "skipped"
  );
  if (current) return current;
  return (
    steps.find((step) => step.status === "running") ??
    steps.find((step) => step.status === "blocked" || step.status === "needs_attention") ??
    steps.find((step) => step.status === "failed") ??
    steps.find((step) => step.status === "queued") ??
    null
  );
}

function buildProgressDisplaySteps(
  steps: WorkflowRunStepRecord[],
  currentStepId: string | undefined,
  now: number
): ProgressDisplayStep[] {
  const rows: ProgressDisplayStep[] = [];

  for (const step of steps) {
    const label = step.label ?? titleFromId(step.id);
    const phase = step.phase ?? "Run";
    const latestAt = progressStepTimestamp(step);
    const active =
      isCurrentProgressStep(step, currentStepId) ||
      step.status === "running" ||
      step.status === "blocked" ||
      step.status === "needs_attention";
    const last = rows[rows.length - 1];
    if (last && last.label === label && last.phase === phase && last.status === step.status) {
      last.count += 1;
      last.active = last.active || active;
      last.softTimeout = last.softTimeout || softTimeoutCrossed(step, now);
      const nextLatestAt = laterTimestamp(last.latestAt, latestAt);
      if (nextLatestAt) last.latestAt = nextLatestAt;
      continue;
    }
    const displayStep: ProgressDisplayStep = {
      key: `${phase}:${label}:${step.status}:${rows.length}`,
      label,
      phase,
      status: step.status,
      count: 1,
      active,
      softTimeout: softTimeoutCrossed(step, now),
    };
    if (latestAt) displayStep.latestAt = latestAt;
    rows.push(displayStep);
  }

  return rows;
}

function visibleProgressRows(steps: ProgressDisplayStep[]): ProgressDisplayRow[] {
  if (steps.length <= 7) {
    return steps.map((step) => ({ kind: "step", step }));
  }

  const activeIndex = Math.max(
    0,
    steps.findIndex((step) => step.active)
  );
  const keep = new Set<number>([0, steps.length - 1]);
  for (let index = activeIndex - 2; index <= activeIndex + 2; index += 1) {
    if (index >= 0 && index < steps.length) keep.add(index);
  }

  const indexes = [...keep].sort((a, b) => a - b);
  const rows: ProgressDisplayRow[] = [];
  for (let index = 0; index < indexes.length; index += 1) {
    const current = indexes[index];
    const previous = indexes[index - 1];
    if (current === undefined) continue;
    if (previous !== undefined && current - previous > 1) {
      rows.push({
        kind: "gap",
        key: `gap:${previous}:${current}`,
        hiddenCount: current - previous - 1,
      });
    }
    const step = steps[current];
    if (step) rows.push({ kind: "step", step });
  }
  return rows;
}

function progressToneForStatus(status: WorkflowRunStepRecord["status"]): ProgressUpdateTone {
  if (status === "succeeded") return "success";
  if (status === "blocked" || status === "needs_attention" || status === "failed") {
    return "attention";
  }
  if (status === "queued") return "waiting";
  return "working";
}

function progressUpdateTitle(step: WorkflowRunStepRecord): string {
  const label = step.label ?? titleFromId(step.id);
  if (step.status === "succeeded") return `Finished ${label}`;
  if (step.status === "running") return `Working on ${label}`;
  if (step.status === "blocked") return `Waiting for review on ${label}`;
  if (step.status === "needs_attention" || step.status === "failed") {
    return `${label} needs attention`;
  }
  if (step.status === "denied") return `Stopped at ${label}`;
  if (step.status === "skipped") return `Skipped ${label}`;
  return `${label} is next`;
}

function progressTimelineTitle(row: PlaybookGraphRunReviewSurface["timeline"][number]): string {
  if (/human review required/i.test(row.message)) return "Review checkpoint reached";
  return row.message;
}

function progressUpdates(
  run: PlaybookRunDetail | null,
  surface: PlaybookGraphRunReviewSurface | null
): ProgressUpdate[] {
  const updates: ProgressUpdate[] = [];

  for (const row of surface?.timeline ?? []) {
    updates.push({
      key: `timeline:${row.timelineRowId}`,
      title: progressTimelineTitle(row),
      detail: titleFromId(row.kind),
      createdAt: row.createdAt,
      tone: "waiting",
    });
  }

  for (const event of run?.events ?? []) {
    updates.push({
      key: `event:${event.id}`,
      title: event.message,
      detail: stepStatusLabel(
        event.status === "completed"
          ? "succeeded"
          : event.status === "denied"
            ? "denied"
            : event.status === "failed"
              ? "failed"
              : event.status === "blocked"
                ? "blocked"
                : event.status === "queued"
                  ? "queued"
                  : "running"
      ),
      createdAt: event.createdAt,
      tone:
        event.status === "succeeded" || event.status === "completed"
          ? "success"
          : event.status === "failed" || event.status === "blocked"
            ? "attention"
            : "working",
    });
  }

  for (const step of run?.steps ?? []) {
    const createdAt = progressStepTimestamp(step);
    if (!createdAt) continue;
    updates.push({
      key: `step:${(step as GraphWorkflowStepRecord).queueEntryId ?? step.id}:${createdAt}`,
      title: progressUpdateTitle(step),
      detail: stepStatusLabel(step.status),
      createdAt,
      tone: progressToneForStatus(step.status),
    });
  }

  const seen = new Set<string>();
  return updates
    .sort((a, b) => timestampMs(b.createdAt) - timestampMs(a.createdAt))
    .filter((update) => {
      const key = `${update.title}:${update.detail}:${update.createdAt ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 4);
}

function progressIcon(step: ProgressDisplayStep) {
  if (step.status === "succeeded") return <CheckCircle2 size={15} className="text-emerald-600" />;
  if (step.status === "blocked" || step.status === "needs_attention" || step.status === "failed") {
    return <AlertTriangle size={15} className="text-amber-600" />;
  }
  if (step.status === "running") {
    return <span className="h-2.5 w-2.5 rounded-full bg-blue-600" aria-hidden="true" />;
  }
  return <Clock3 size={15} className="text-muted-foreground" />;
}

function progressStatusClass(status: WorkflowRunStepRecord["status"]): string {
  if (status === "succeeded") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "running") return "border-blue-200 bg-blue-50 text-blue-700";
  if (status === "blocked" || status === "needs_attention" || status === "failed") {
    return "border-amber-200 bg-amber-50 text-amber-800";
  }
  return "border-border bg-secondary text-muted-foreground";
}

function latestUpdateClass(tone: ProgressUpdateTone): string {
  if (tone === "success") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (tone === "attention") return "border-amber-200 bg-amber-50 text-amber-900";
  if (tone === "working") return "border-blue-200 bg-blue-50 text-blue-900";
  return "border-border bg-background text-foreground";
}

function parseGraphActionPayload(
  action: PlaybookGraphResumeActionSpec,
  drafts: Record<string, string> | undefined
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const field of action.requiredPayloadFields) {
    const raw = (drafts?.[field.path] ?? "").trim();
    if (!raw) {
      if (!field.required) continue;
      throw new Error(`${field.label} is required`);
    }
    if (field.kind === "string") {
      payload[field.path] = raw;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`${field.label} must be valid JSON`);
    }
    if (
      field.kind === "object" &&
      (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    ) {
      throw new Error(`${field.label} must be a JSON object`);
    }
    payload[field.path] = parsed;
  }
  return payload;
}

function reviewActionHelp(action: PlaybookGraphResumeActionSpec, approveCopy: string): string {
  if (action.description) return action.description;
  if (action.decision === "approve") return approveCopy;
  if (action.decision === "approve_repair" || action.decision === "retry_repair") {
    return "Repair the saved run state and continue from the pinned playbook snapshot.";
  }
  if (action.decision === "request_changes") {
    return "Tell Tessera what to revise before anything else happens.";
  }
  if (action.decision === "deny") {
    return "Stop this run here without applying workspace changes.";
  }
  return "Continue with this review decision.";
}

function reviewPayloadHeading(action: PlaybookGraphResumeActionSpec): string {
  if (action.decision === "request_changes") return "Tell Tessera what to change";
  if (action.decision === "deny") return "Add a reason before stopping";
  return action.label;
}

function reviewPayloadSubmitLabel(action: PlaybookGraphResumeActionSpec): string {
  if (action.decision === "request_changes") return "Send change request";
  if (action.decision === "deny") return "Stop run";
  return action.label;
}

function reviewPayloadPlaceholder(
  action: PlaybookGraphResumeActionSpec,
  field: PlaybookGraphResumeActionSpec["requiredPayloadFields"][number]
): string {
  const fieldName = field.label.toLowerCase();
  if (field.kind === "string") {
    if (action.decision === "request_changes") {
      return "Describe what should change before Tessera continues.";
    }
    if (fieldName.includes("reason")) return "Why should this run stop?";
    return field.label;
  }
  if (fieldName.includes("supplier")) return '["supplier-id"]';
  if (field.kind === "object") return "{ }";
  return "JSON value";
}

function GraphRuntimeSection({
  runs,
  detail,
  surface,
  error,
  onSelect,
  onResume,
  onPreviewGitMilestone,
}: {
  runs: PlaybookGraphRunDetail["run"][];
  detail: PlaybookGraphRunDetail | null;
  surface: PlaybookGraphRunReviewSurface | null;
  error: string | null;
  onSelect: (runId: string) => void;
  onResume: (action: PlaybookGraphResumeActionSpec, payload?: Record<string, unknown>) => void;
  onPreviewGitMilestone: (
    runId: string,
    workspaceRoot: string
  ) => Promise<PlaybookGraphGitMilestonePreview>;
}) {
  const [payloadDrafts, setPayloadDrafts] = useState<Record<string, Record<string, string>>>({});
  const [payloadError, setPayloadError] = useState<string | null>(null);
  const [gitPreview, setGitPreview] = useState<PlaybookGraphGitMilestonePreview | null>(null);
  const [gitPreviewError, setGitPreviewError] = useState<string | null>(null);
  const [openingArtifactPath, setOpeningArtifactPath] = useState<string | null>(null);
  const [artifactOpenError, setArtifactOpenError] = useState<string | null>(null);
  const selectedRunId = detail?.run.runId;
  const visibleActions = (surface?.actions ?? []).filter(
    (action) => action.decision !== "edit_input"
  );
  const workspaceRoot =
    detail?.run.materialization?.kind === "workspace"
      ? detail.run.materialization.workspaceRoot
      : undefined;
  const artifactPaths = detail ? graphRunArtifactWritePaths(detail) : new Map<string, string>();

  async function openGraphArtifact(path: string) {
    if (!workspaceRoot) return;
    setArtifactOpenError(null);
    setOpeningArtifactPath(path);
    try {
      await invoke("workspace_file_open", { workspaceRoot, path });
    } catch (openError) {
      setArtifactOpenError(openError instanceof Error ? openError.message : String(openError));
    } finally {
      setOpeningArtifactPath(null);
    }
  }

  const updatePayloadDraft = (actionId: string, path: string, value: string) => {
    setPayloadDrafts((current) => ({
      ...current,
      [actionId]: {
        ...(current[actionId] ?? {}),
        [path]: value,
      },
    }));
  };

  if (runs.length === 0 && !detail && !error) return null;

  return (
    <details className="rounded-md border border-border bg-background px-3 py-2 text-xs">
      <summary className="cursor-pointer select-none font-medium text-foreground">
        Advanced run log
      </summary>
      <div className="mt-3 space-y-3">
        {error ? (
          <div className="mb-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {error}
          </div>
        ) : null}
        <div className="space-y-2">
          {runs.map((run) => (
            <button
              key={run.runId}
              type="button"
              className={cn(
                "w-full rounded-md border border-border bg-background px-3 py-2 text-left text-xs hover:border-primary/40",
                selectedRunId === run.runId ? "border-primary/50" : ""
              )}
              onClick={() => onSelect(run.runId)}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-foreground">{run.playbookId}</span>
                <span
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[10px]",
                    graphStatusClass[run.status]
                  )}
                >
                  {graphStatusCopy[run.status]}
                </span>
              </div>
              <div className="mt-1 text-muted-foreground">
                {packageVersionLabel(run.snapshot.packageVersion)} · Updated{" "}
                {formatTime(run.updatedAt)}
              </div>
            </button>
          ))}
        </div>

        {detail ? (
          <div className="mt-3 space-y-3">
            {detail.run.blockedReason || detail.run.repairReason || detail.run.error ? (
              <div className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
                {playbookRunErrorCopy(
                  detail.run.blockedReason ?? detail.run.repairReason ?? detail.run.error
                )}
              </div>
            ) : null}

            {visibleActions.length > 0 ? (
              <div className="space-y-2">
                {payloadError ? (
                  <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                    {payloadError}
                  </div>
                ) : null}
                {visibleActions.map((action) => (
                  <div
                    key={action.actionId}
                    data-graph-action={action.actionId}
                    data-testid={`graph-review-action-${action.actionId}`}
                    className="rounded-md border border-border bg-background px-3 py-2 text-xs"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="font-medium text-foreground">{action.label}</div>
                        {action.description ? (
                          <div className="mt-0.5 text-muted-foreground">{action.description}</div>
                        ) : null}
                      </div>
                      <Button
                        size="sm"
                        variant={action.destructive ? "secondary" : "default"}
                        onClick={(event) => {
                          try {
                            setPayloadError(null);
                            if (action.destructive && !window.confirm(`${action.label}?`)) return;
                            const actionRoot = event.currentTarget.closest("[data-graph-action]");
                            const localDrafts = { ...(payloadDrafts[action.actionId] ?? {}) };
                            const fieldElements =
                              actionRoot?.querySelectorAll<HTMLTextAreaElement | HTMLSelectElement>(
                                "[data-payload-field]"
                              ) ?? [];
                            for (const fieldElement of fieldElements) {
                              const fieldPath = fieldElement.dataset.payloadField;
                              if (fieldPath) localDrafts[fieldPath] = fieldElement.value;
                            }
                            onResume(action, parseGraphActionPayload(action, localDrafts));
                          } catch (payloadParseError) {
                            setPayloadError(
                              payloadParseError instanceof Error
                                ? payloadParseError.message
                                : String(payloadParseError)
                            );
                          }
                        }}
                      >
                        {action.label}
                      </Button>
                    </div>
                    {action.requiredPayloadFields.length > 0 ? (
                      <div className="mt-2 space-y-2">
                        {action.requiredPayloadFields.map((field) => {
                          const value = payloadDrafts[action.actionId]?.[field.path] ?? "";
                          const activeArtifactIds =
                            surface?.activeArtifacts.map((artifact) => artifact.artifactId) ?? [];
                          if (field.path === "artifactId" && activeArtifactIds.length > 0) {
                            return (
                              <label
                                key={field.path}
                                className="block text-[11px] text-muted-foreground"
                              >
                                {field.label}
                                <select
                                  data-payload-field={field.path}
                                  className="mt-1 w-full rounded-md border border-border bg-muted px-2 py-1 text-foreground"
                                  value={value}
                                  onChange={(event) =>
                                    updatePayloadDraft(
                                      action.actionId,
                                      field.path,
                                      event.target.value
                                    )
                                  }
                                >
                                  <option value="">Select artifact</option>
                                  {activeArtifactIds.map((artifactId) => (
                                    <option key={artifactId} value={artifactId}>
                                      {artifactId}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            );
                          }
                          const isString = field.kind === "string";
                          return (
                            <label
                              key={field.path}
                              className="block text-[11px] text-muted-foreground"
                            >
                              {field.label}
                              <textarea
                                data-payload-field={field.path}
                                className={cn(
                                  "mt-1 w-full resize-y rounded-md border border-border bg-muted px-2 py-1 text-foreground",
                                  isString ? "min-h-16" : "min-h-20 font-mono"
                                )}
                                value={value}
                                placeholder={
                                  isString
                                    ? field.label
                                    : field.kind === "object"
                                      ? "{ }"
                                      : "JSON value"
                                }
                                onChange={(event) =>
                                  updatePayloadDraft(
                                    action.actionId,
                                    field.path,
                                    event.target.value
                                  )
                                }
                              />
                            </label>
                          );
                        })}
                      </div>
                    ) : null}
                    <div className="mt-1 text-muted-foreground">
                      {action.sideEffect.replace("_", " ")}
                      {action.invalidatesDownstream ? " · invalidates downstream" : ""}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            {workspaceRoot ? (
              <div className="rounded-md border border-border bg-background px-3 py-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="font-medium text-foreground">Git milestone</div>
                    <div className="mt-0.5 text-muted-foreground">
                      Git readiness is checked only when previewed.
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setGitPreviewError(null);
                      void onPreviewGitMilestone(detail.run.runId, workspaceRoot)
                        .then(setGitPreview)
                        .catch((previewError) =>
                          setGitPreviewError(
                            previewError instanceof Error
                              ? previewError.message
                              : String(previewError)
                          )
                        );
                    }}
                  >
                    Preview Git milestone
                  </Button>
                </div>
                {gitPreviewError ? (
                  <div className="mt-2 text-red-700">{gitPreviewError}</div>
                ) : gitPreview ? (
                  <div className="mt-2 text-muted-foreground">
                    {gitPreview.available
                      ? "Ready"
                      : (gitPreview.unavailableReason ?? "Unavailable")}{" "}
                    · {gitPreview.changedFiles.length} changed file
                    {gitPreview.changedFiles.length === 1 ? "" : "s"}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="divide-y divide-border overflow-hidden rounded-md border border-border bg-background">
              {detail.queue.map((entry) => (
                <div key={entry.queueEntryId} className="px-3 py-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-foreground">{entry.nodePath}</span>
                    <span className="text-muted-foreground">{entry.status}</span>
                  </div>
                  <div className="mt-0.5 text-muted-foreground">{entry.nodeKind}</div>
                </div>
              ))}
            </div>

            {(surface?.activeArtifacts.length ?? 0) > 0 ? (
              <div className="divide-y divide-border overflow-hidden rounded-md border border-border bg-background">
                {surface?.activeArtifacts.map((artifact) => {
                  const artifactPath = artifactPaths.get(artifact.artifactId) ?? null;
                  const canOpen = !!workspaceRoot && !!artifactPath;
                  const Container = canOpen ? "button" : "div";
                  return (
                    <Container
                      key={`${artifact.artifactId}:${artifact.versionId}`}
                      type={canOpen ? "button" : undefined}
                      disabled={canOpen ? openingArtifactPath === artifactPath : undefined}
                      title={canOpen ? "Open artifact" : undefined}
                      onClick={canOpen ? () => void openGraphArtifact(artifactPath) : undefined}
                      className={cn(
                        "block w-full px-3 py-2 text-left text-xs",
                        canOpen &&
                          "cursor-pointer transition-colors hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-foreground">{artifact.artifactId}</span>
                        <span className="text-muted-foreground">
                          {artifact.producerStatus ?? "unknown"}
                        </span>
                      </div>
                      {artifactPath ? (
                        <div className="mt-0.5 text-muted-foreground">{artifactPath}</div>
                      ) : null}
                    </Container>
                  );
                })}
                {artifactOpenError ? (
                  <div className="px-3 py-2 text-xs text-red-700">{artifactOpenError}</div>
                ) : null}
              </div>
            ) : null}

            {(surface?.artifactTimeline.length ?? 0) > 0 ? (
              <div className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
                Artifact timeline: {surface?.artifactTimeline.length} version
                {surface?.artifactTimeline.length === 1 ? "" : "s"} ·{" "}
                {surface?.artifactTimeline.filter((artifact) => artifact.active).length} active
              </div>
            ) : null}

            {(surface?.timeline.length ?? 0) > 0 ? (
              <div className="divide-y divide-border overflow-hidden rounded-md border border-border bg-background">
                {surface?.timeline.map((row) => (
                  <div key={row.timelineRowId} className="px-3 py-2 text-xs">
                    <div className="font-medium text-foreground">{row.message}</div>
                    <div className="mt-0.5 text-muted-foreground">
                      {row.kind.replace("_", " ")} · {formatTime(row.createdAt)}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            {detail.branchItems.length > 0 ? (
              <div className="divide-y divide-border overflow-hidden rounded-md border border-border bg-background">
                {detail.branchItems.map((item) => (
                  <div key={item.branchItemId} className="px-3 py-2 text-xs">
                    <div className="font-medium text-foreground">
                      Branch {item.index + 1} · {item.status}
                    </div>
                    <div className="mt-0.5 text-muted-foreground">{summarizeValue(item.value)}</div>
                  </div>
                ))}
              </div>
            ) : null}

            {(surface?.branches.length ?? 0) > 0 ? (
              <div className="divide-y divide-border overflow-hidden rounded-md border border-border bg-background">
                {surface?.branches.map((branch) => (
                  <div key={branch.parentQueueEntryId} className="px-3 py-2 text-xs">
                    <div className="font-medium text-foreground">
                      {branch.parentNodePath} · {branch.parentStatus}
                    </div>
                    <div className="mt-0.5 text-muted-foreground">
                      {branch.items.length} branch item{branch.items.length === 1 ? "" : "s"}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            {(detail.artifacts.length > 0 || detail.reviews.length > 0) && (
              <div className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
                {detail.artifacts.length} artifact version{detail.artifacts.length === 1 ? "" : "s"}{" "}
                · {detail.reviews.length} review event{detail.reviews.length === 1 ? "" : "s"}
              </div>
            )}
          </div>
        ) : null}
      </div>
    </details>
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
  onStyleSelectionChange,
  formReady,
  running,
  savingPreference,
  workspaceRoot,
  capabilityInventory,
  graphReady,
  styleGuideError,
  styleGuideLoading,
  styleGuideResult,
  styleSelection,
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
  onStyleSelectionChange: (selection: GraphRunStyleSelection) => void;
  formReady: boolean;
  running: boolean;
  savingPreference: boolean;
  workspaceRoot: string | null;
  capabilityInventory: WorkflowCapabilityInventory | null;
  graphReady: boolean;
  styleGuideError: string | null;
  styleGuideLoading: boolean;
  styleGuideResult: WorkspaceStyleGuideReadResult | null;
  styleSelection: GraphRunStyleSelection;
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
    (graphReady || (!!draftAssignmentPlan && agentsConfirmed));
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
  const writingStyle =
    playbookDetail?.writingStyle?.enabled || playbook.writingStyle?.enabled
      ? (playbookDetail?.writingStyle ?? playbook.writingStyle)
      : null;
  const styleGuide = styleGuideResult?.config.styleGuide ?? null;
  const supportedCopyTypes =
    writingStyle?.supportedCopyTypes.length && styleGuide
      ? writingStyle.supportedCopyTypes.filter((copyType) => styleGuide.copyTypes[copyType])
      : Object.keys(styleGuide?.copyTypes ?? {});
  const selectedCopyType =
    styleSelection.copyType ??
    writingStyle?.defaultCopyType ??
    styleGuide?.profile.defaultCopyType ??
    supportedCopyTypes[0] ??
    "";
  const copyTypeOptions = [...new Set([selectedCopyType, ...supportedCopyTypes].filter(Boolean))];

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
  const playbookPackageLabel = packageVersionLabel(playbook.packageVersion);
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
        Change setup
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
              {formatCapabilityBlockerMessage(blocker)}
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
          {graphReady ? "Save selection" : agentsConfirmed ? "Save setup" : "Use this setup"}
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
  const styleGuidePanel =
    writingStyle && workspaceRoot ? (
      <div className="rounded-lg border border-border bg-secondary/30 p-4">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-foreground">Writing style</div>
            <p className="mt-1 text-xs text-muted-foreground">
              {styleGuide
                ? `${styleGuide.profile.name} will guide this run.`
                : "No workspace style guide is configured yet."}
            </p>
          </div>
          {styleGuide ? (
            <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
              Active
            </span>
          ) : (
            <span className="rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              Optional
            </span>
          )}
        </div>

        {styleGuideLoading ? (
          <p className="text-xs text-muted-foreground">Loading workspace style guide...</p>
        ) : styleGuideError ? (
          <p className="text-xs text-destructive">{styleGuideError}</p>
        ) : styleGuide ? (
          <div className="space-y-3">
            <label className="block">
              <span className="text-xs font-medium text-foreground">Copy type</span>
              <select
                className="mt-1 w-full rounded-md border border-border bg-background px-2 py-2 text-sm text-foreground outline-none"
                value={selectedCopyType}
                disabled={running || copyTypeOptions.length === 0}
                onChange={(event) =>
                  onStyleSelectionChange({
                    ...styleSelection,
                    copyType: event.target.value,
                  })
                }
              >
                {copyTypeOptions.map((copyType) => (
                  <option key={copyType} value={copyType}>
                    {styleGuide.copyTypes[copyType]?.label ?? copyType}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium text-foreground">Run note</span>
              <textarea
                className="mt-1 min-h-20 w-full resize-y rounded-md border border-border bg-background px-2 py-2 text-sm text-foreground outline-none"
                value={styleSelection.override ?? ""}
                disabled={running}
                placeholder="Optional voice or tone adjustment for this run"
                onChange={(event) =>
                  onStyleSelectionChange({
                    ...styleSelection,
                    override: event.target.value,
                  })
                }
              />
            </label>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Add a style guide from Settings to pass voice, tone, language, and review rules into
            this playbook.
          </p>
        )}
      </div>
    ) : null;

  return (
    <div className="mx-auto w-full max-w-xl py-10">
      <div className="mb-8">
        {playbook.businessUseCase ? (
          <div className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            {playbook.businessUseCase}
          </div>
        ) : null}
        <h2 className="text-2xl font-semibold text-foreground">{playbook.name}</h2>
        {playbookPackageLabel ? (
          <div className="mt-2 text-xs font-medium text-muted-foreground">
            {playbookPackageLabel}
          </div>
        ) : null}
        {playbook.description ? (
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{playbook.description}</p>
        ) : null}
      </div>

      {playbook.requiredCapabilities.length > 0 ? (
        <div className="mb-5">
          <div className="mb-2 text-xs text-muted-foreground">
            Tessera needs these capabilities to run
          </div>
          <div className="flex flex-wrap gap-2">
            {playbook.requiredCapabilities.map((cap) => (
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

      {playbook.optionalCapabilities.length > 0 ? (
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
          {styleGuidePanel}

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
          {styleGuidePanel}
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
  selectedGraphRunSurface,
  onViewDetails,
}: {
  run: PlaybookRunDetail | null;
  playbook: PlaybookSummary | PlaybookDetail | null;
  selectedGraphRunSurface: PlaybookGraphRunReviewSurface | null;
  onViewDetails: () => void;
}) {
  const name = playbook?.name ?? "this playbook";
  const steps = run?.steps ?? [];
  const phases = playbook?.phases ?? [];
  const currentTime = Date.now();
  const totalSteps = steps.filter((step) => step.status !== "skipped").length;
  const completedSteps = steps.filter(
    (step) => step.status === "succeeded" || step.status === "skipped"
  ).length;
  const progressPercent =
    totalSteps > 0
      ? Math.max(4, Math.min(100, Math.round((completedSteps / totalSteps) * 100)))
      : 8;
  const currentStep = activeProgressStep(steps, run?.currentStepId);
  const currentStepLabel = currentStep ? (currentStep.label ?? titleFromId(currentStep.id)) : null;
  const currentPhase = currentStep?.phase ?? null;
  const workflowRows = visibleProgressRows(
    buildProgressDisplaySteps(steps, run?.currentStepId, currentTime)
  );
  const updates = progressUpdates(run, selectedGraphRunSurface);
  const latestUpdate =
    updates[0] ??
    (currentStep
      ? {
          key: "current-step",
          title: progressUpdateTitle(currentStep),
          detail: stepStatusLabel(currentStep.status),
          createdAt: progressStepTimestamp(currentStep),
          tone: progressToneForStatus(currentStep.status),
        }
      : null);
  const phaseSummaries = [...new Set([...phases, ...steps.map((step) => step.phase ?? "Run")])]
    .filter(Boolean)
    .map((phase) => {
      const phaseSteps = steps.filter((step) => (step.phase ?? "Run") === phase);
      const phaseTotal = phaseSteps.filter((step) => step.status !== "skipped").length;
      const phaseDone = phaseSteps.filter(
        (step) => step.status === "succeeded" || step.status === "skipped"
      ).length;
      const phaseActive =
        phase === currentPhase ||
        phaseSteps.some((step) => isCurrentProgressStep(step, run?.currentStepId));
      return {
        phase,
        total: phaseTotal,
        done: phaseDone,
        label:
          phaseTotal > 0 && phaseDone >= phaseTotal
            ? "Done"
            : phaseActive
              ? "Now"
              : phaseDone > 0
                ? "Started"
                : "Next",
      };
    });
  const showPhaseStrip = phaseSummaries.length > 1;
  const softTimeout =
    currentStep !== null &&
    steps.some((step) => step === currentStep && softTimeoutCrossed(step, currentTime));

  return (
    <div className="mx-auto w-full max-w-3xl py-10">
      <div className="mb-8 max-w-2xl">
        <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          <Loader2 size={13} className="animate-spin" />
          Working
        </div>
        <h2 className="text-2xl font-semibold text-foreground">Preparing {name}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Tessera is moving through the playbook and will pause only if a business review is needed.
        </p>
      </div>

      {steps.length > 0 ? (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="min-w-0 space-y-5">
            <div>
              <div className="mb-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                <span>
                  {completedSteps} of {totalSteps} step{totalSteps === 1 ? "" : "s"} complete
                </span>
                {run?.updatedAt ? <span>Updated {formatTime(run.updatedAt)}</span> : null}
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-secondary" aria-hidden="true">
                <div
                  className="h-full rounded-full bg-emerald-500"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>

            <div className="rounded-lg border border-blue-200 bg-blue-50/70 p-4">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-blue-700">
                Current focus
              </div>
              <div className="mt-2 flex items-start gap-3">
                <Loader2 size={16} className="mt-0.5 flex-shrink-0 animate-spin text-blue-700" />
                <div className="min-w-0">
                  <h3 className="text-base font-semibold text-foreground">
                    {currentStepLabel ?? "Starting the next step"}
                  </h3>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    {currentStep
                      ? stepStatusLabel(currentStep.status)
                      : "Tessera is preparing the run."}
                    {currentStep?.phase ? ` in ${currentStep.phase}.` : ""}
                  </p>
                  {softTimeout ? (
                    <p className="mt-2 text-xs font-medium text-amber-800">
                      Running longer than expected
                    </p>
                  ) : null}
                </div>
              </div>
            </div>

            {showPhaseStrip ? (
              <div className="flex flex-wrap gap-2">
                {phaseSummaries.map((phase) => (
                  <div
                    key={phase.phase}
                    aria-current={phase.label === "Now" ? "step" : undefined}
                    className={cn(
                      "rounded-full border px-3 py-1 text-xs",
                      phase.label === "Done"
                        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                        : phase.label === "Now"
                          ? "border-blue-200 bg-blue-50 text-blue-700"
                          : "border-border bg-background text-muted-foreground"
                    )}
                  >
                    <span className="font-medium text-foreground">{phase.phase}</span>
                    <span className="ml-1">{phase.label}</span>
                  </div>
                ))}
              </div>
            ) : null}

            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                Workflow
              </div>
              <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-background">
                {workflowRows.map((row) =>
                  row.kind === "gap" ? (
                    <div key={row.key} className="px-4 py-2 text-xs text-muted-foreground">
                      {row.hiddenCount} earlier step{row.hiddenCount === 1 ? "" : "s"} summarized
                    </div>
                  ) : (
                    <div
                      key={row.step.key}
                      className="grid grid-cols-[1.25rem_1fr_auto] gap-3 px-4 py-3"
                    >
                      <div className="mt-0.5 flex h-5 items-center justify-center">
                        {progressIcon(row.step)}
                      </div>
                      <div className="min-w-0">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-medium text-foreground">
                            {row.step.label}
                          </span>
                          {row.step.count > 1 ? (
                            <span className="rounded-full border border-border bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground">
                              x{row.step.count}
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {row.step.phase}
                          {row.step.latestAt ? ` · ${formatTime(row.step.latestAt)}` : ""}
                        </div>
                        {row.step.softTimeout && !row.step.active ? (
                          <div className="mt-1 text-xs font-medium text-amber-700">
                            Running longer than expected
                          </div>
                        ) : null}
                      </div>
                      <div
                        className={cn(
                          "h-fit rounded-full border px-2 py-0.5 text-[10px] font-medium",
                          progressStatusClass(row.step.status)
                        )}
                      >
                        {progressStatusLabel(row.step.status)}
                      </div>
                    </div>
                  )
                )}
              </div>
            </div>
          </div>

          <aside className="order-first space-y-3 xl:order-none xl:sticky xl:top-4 xl:self-start">
            <div
              aria-live="polite"
              className={cn(
                "rounded-lg border p-4",
                latestUpdate ? latestUpdateClass(latestUpdate.tone) : "border-border bg-background"
              )}
            >
              <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                Latest update
              </div>
              <div className="mt-2 text-sm font-semibold text-foreground">
                {latestUpdate?.title ?? "Run is starting"}
              </div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {latestUpdate?.detail ?? "Tessera is getting the playbook ready."}
              </p>
              {latestUpdate?.createdAt ? (
                <div className="mt-3 text-xs text-muted-foreground">
                  {formatTime(latestUpdate.createdAt)}
                </div>
              ) : null}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full rounded-md"
              onClick={onViewDetails}
            >
              View run details
            </Button>
          </aside>
        </div>
      ) : phases.length > 0 ? (
        <div className="space-y-2 rounded-lg border border-border bg-background p-4">
          {phases.map((phase) => (
            <div key={phase} className="flex items-center gap-3 py-2">
              <span className="h-2.5 w-2.5 rounded-full bg-blue-600" aria-hidden="true" />
              <div className="text-sm font-medium text-foreground">{phase}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-3 rounded-lg border border-border bg-background px-4 py-3">
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
  reviewEvidence,
  productView,
  reviewActions,
  styleCompliance,
  workspaceRoot,
  artifactWorkspaceRoot,
  onApprove,
  onStop,
  onAction,
  onViewDetails,
  running,
}: {
  run: PlaybookRunDetail;
  playbook: PlaybookSummary | PlaybookDetail | null;
  reviewEvidence: ReviewEvidence | null;
  productView: PlaybookRunProductView | null;
  reviewActions: PlaybookGraphResumeActionSpec[];
  styleCompliance: PlaybookGraphRunReviewSurface["styleCompliance"];
  workspaceRoot: string | null;
  artifactWorkspaceRoot: string | null;
  onApprove: () => void;
  onStop: () => void;
  onAction: (action: PlaybookGraphResumeActionSpec, payload?: Record<string, unknown>) => void;
  onViewDetails: () => void;
  running: boolean;
}) {
  const approvalCopy = playbookApprovalCopy(run, playbook);
  const productState = productView?.state ?? null;
  const showReviewCopy = !productView || productState === "waiting_for_review";
  const heading = productView?.title ?? "Your review is needed";
  const preparedCopy =
    reviewEvidence?.preparedSummary ??
    (showReviewCopy ? (productView?.message ?? approvalCopy.prepared) : approvalCopy.prepared);
  const approveCopy = reviewEvidence?.approveSummary ?? approvalCopy.approve;
  const primaryAction =
    (productView?.primaryAction
      ? reviewActions.find((action) => action.actionId === productView.primaryAction?.actionId)
      : undefined) ?? reviewActions.find((action) => action.decision === "approve");
  const secondaryActions =
    productView?.secondaryActions
      .map((action) => reviewActions.find((candidate) => candidate.actionId === action.actionId))
      .filter((action): action is PlaybookGraphResumeActionSpec => action !== undefined) ??
    reviewActions.filter(
      (action) =>
        action.actionId !== primaryAction?.actionId &&
        (action.decision === "request_changes" || action.decision === "deny")
    );
  const primaryActionLabel =
    productView?.primaryAction?.label ??
    primaryAction?.label ??
    reviewEvidence?.approveLabel ??
    "Approve";
  const recoveryNextCopy =
    productState === "retry_available"
      ? "Tessera will retry this step and continue the run."
      : productView?.primaryAction?.decision === "approve_repair" ||
          productView?.primaryAction?.decision === "retry_repair"
        ? "Tessera will repair the saved run state and continue from the pinned playbook snapshot."
        : productState === "restart_required"
          ? "Restart Tessera, then start the playbook again."
          : approveCopy;
  const recoveryNextLabel =
    productState === "retry_available" ? "What happens if you retry" : "What happens next";
  const [openingArtifact, setOpeningArtifact] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [payloadDrafts, setPayloadDrafts] = useState<Record<string, Record<string, string>>>({});
  const [payloadError, setPayloadError] = useState<string | null>(null);
  const [activePayloadActionId, setActivePayloadActionId] = useState<string | null>(null);
  const reviewRootRef = useRef<HTMLDivElement | null>(null);
  const openWorkspaceRoot = artifactWorkspaceRoot ?? workspaceRoot;
  const canOpenArtifact = !!openWorkspaceRoot && !!reviewEvidence?.artifactPath;
  const reviewActionOptions = [primaryAction, ...secondaryActions].filter(
    (action): action is PlaybookGraphResumeActionSpec => action !== undefined
  );
  const activePayloadAction =
    reviewActionOptions.find(
      (action) =>
        action.actionId === activePayloadActionId && action.requiredPayloadFields.length > 0
    ) ?? null;
  const hasStopAction = secondaryActions.some((action) => action.decision === "deny");

  function reviewActionLabel(action: PlaybookGraphResumeActionSpec): string {
    if (action.actionId === primaryAction?.actionId) return primaryActionLabel;
    return (
      productView?.secondaryActions.find((candidate) => candidate.actionId === action.actionId)
        ?.label ?? action.label
    );
  }

  async function openReviewArtifact() {
    if (!openWorkspaceRoot || !reviewEvidence?.artifactPath) return;
    setOpeningArtifact(true);
    setOpenError(null);
    try {
      await invoke("workspace_file_open", {
        workspaceRoot: openWorkspaceRoot,
        path: reviewEvidence.artifactPath,
      });
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : String(error));
    } finally {
      setOpeningArtifact(false);
    }
  }

  const updatePayloadDraft = (actionId: string, path: string, value: string) => {
    setPayloadDrafts((current) => ({
      ...current,
      [actionId]: {
        ...(current[actionId] ?? {}),
        [path]: value,
      },
    }));
  };

  function submitReviewAction(action: PlaybookGraphResumeActionSpec) {
    try {
      setPayloadError(null);
      const localDrafts = { ...(payloadDrafts[action.actionId] ?? {}) };
      const fieldElements =
        reviewRootRef.current?.querySelectorAll<HTMLTextAreaElement>(
          "[data-guided-review-action][data-payload-field]"
        ) ?? [];
      for (const fieldElement of fieldElements) {
        if (fieldElement.dataset.guidedReviewAction !== action.actionId) continue;
        const fieldPath = fieldElement.dataset.payloadField;
        if (fieldPath) localDrafts[fieldPath] = fieldElement.value;
      }
      onAction(action, parseGraphActionPayload(action, localDrafts));
    } catch (payloadParseError) {
      setPayloadError(
        payloadParseError instanceof Error ? payloadParseError.message : String(payloadParseError)
      );
    }
  }

  function handleReviewAction(action: PlaybookGraphResumeActionSpec) {
    if (action.requiredPayloadFields.length > 0) {
      setPayloadError(null);
      setActivePayloadActionId(action.actionId);
      return;
    }
    submitReviewAction(action);
  }

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

      <div ref={reviewRootRef} className="rounded-lg border border-amber-200 bg-amber-50 p-6">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-amber-900">
          <AlertTriangle size={16} />
          {heading}
        </div>

        <div className="space-y-4 text-sm text-amber-800">
          {showReviewCopy ? (
            <>
              <div>
                <div className="font-medium">What Tessera prepared</div>
                <p className="mt-1">{preparedCopy}</p>
              </div>
              {reviewEvidence ? (
                <div className="border-t border-amber-200 pt-4">
                  <ReviewEvidenceBlock evidence={reviewEvidence} compact />
                </div>
              ) : null}
              {styleCompliance ? (
                <div className="border-t border-amber-200 pt-4">
                  <div className="font-medium">Style guide check</div>
                  <p className="mt-1">
                    {styleCompliance.severity === "pass"
                      ? "No style issues found."
                      : `${styleCompliance.findings.length} style ${
                          styleCompliance.findings.length === 1 ? "issue" : "issues"
                        } found for ${styleCompliance.profileName ?? "this profile"}.`}
                  </p>
                  {styleCompliance.findings.length > 0 ? (
                    <ul className="mt-2 space-y-1">
                      {styleCompliance.findings.slice(0, 3).map((finding) => (
                        <li key={`${finding.nodePath}:${finding.ruleId}`} className="text-xs">
                          {finding.message}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
              <div>
                <div className="font-medium">What happens if you approve</div>
                <p className="mt-1">{approveCopy}</p>
              </div>
            </>
          ) : (
            <>
              <div>
                <div className="font-medium">What happened</div>
                <p className="mt-1">{productView?.message ?? approvalCopy.prepared}</p>
              </div>
              <div>
                <div className="font-medium">{recoveryNextLabel}</div>
                <p className="mt-1">{recoveryNextCopy}</p>
              </div>
            </>
          )}
          <div className="border-t border-amber-200 pt-4">
            <div className="font-medium">Choose next step</div>
            <p className="mt-1">Nothing else happens until you choose one of these actions.</p>
            <div className="mt-3 space-y-2">
              {!primaryAction ? (
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-amber-100 pt-3 first:border-t-0 first:pt-0">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{primaryActionLabel}</div>
                    <p className="mt-0.5 text-xs text-amber-700">{approveCopy}</p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    className="h-9 rounded-md px-5"
                    onClick={onApprove}
                    disabled={running}
                  >
                    {running ? <Loader2 size={14} className="animate-spin" /> : null}
                    {primaryActionLabel}
                  </Button>
                </div>
              ) : null}
              {reviewActionOptions.map((action) => (
                <div
                  key={action.actionId}
                  className="flex flex-wrap items-center justify-between gap-3 border-t border-amber-100 pt-3 first:border-t-0 first:pt-0"
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{reviewActionLabel(action)}</div>
                    <p className="mt-0.5 text-xs text-amber-700">
                      {reviewActionHelp(action, approveCopy)}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant={
                      action.actionId === primaryAction?.actionId || action.decision === "approve"
                        ? "default"
                        : action.decision === "deny"
                          ? "outline"
                          : "secondary"
                    }
                    className="h-9 rounded-md px-5"
                    onClick={() => handleReviewAction(action)}
                    disabled={running}
                  >
                    {running &&
                    (action.actionId === primaryAction?.actionId ||
                      action.decision === "approve") ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : null}
                    {reviewActionLabel(action)}
                  </Button>
                </div>
              ))}
              {!hasStopAction ? (
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-amber-100 pt-3 first:border-t-0 first:pt-0">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">Stop run</div>
                    <p className="mt-0.5 text-xs text-amber-700">
                      Stop this run here without applying workspace changes.
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-9 rounded-md px-5"
                    onClick={onStop}
                    disabled={running}
                  >
                    Stop run
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
          {activePayloadAction ? (
            <div className="border-t border-amber-200 pt-4">
              <div className="font-medium">{reviewPayloadHeading(activePayloadAction)}</div>
              <p className="mt-1 text-xs text-amber-700">
                {reviewActionHelp(activePayloadAction, approveCopy)}
              </p>
              <div className="mt-3 space-y-3">
                {activePayloadAction.requiredPayloadFields.map((field) => {
                  const value = payloadDrafts[activePayloadAction.actionId]?.[field.path] ?? "";
                  return (
                    <label key={field.path} className="block">
                      <span className="font-medium">{field.label}</span>
                      <textarea
                        data-guided-review-action={activePayloadAction.actionId}
                        data-payload-field={field.path}
                        className="mt-1 min-h-20 w-full resize-y rounded-md border border-amber-200 bg-white px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground"
                        value={value}
                        placeholder={reviewPayloadPlaceholder(activePayloadAction, field)}
                        onChange={(event) =>
                          updatePayloadDraft(
                            activePayloadAction.actionId,
                            field.path,
                            event.target.value
                          )
                        }
                      />
                      {field.kind !== "string" ? (
                        <span className="mt-1 block text-xs text-amber-700">Enter valid JSON.</span>
                      ) : null}
                    </label>
                  );
                })}
              </div>
              {payloadError ? <p className="mt-2 text-xs text-red-700">{payloadError}</p> : null}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={activePayloadAction.decision === "deny" ? "outline" : "default"}
                  className="h-9 rounded-md px-5"
                  onClick={() => submitReviewAction(activePayloadAction)}
                  disabled={running}
                >
                  {running ? <Loader2 size={14} className="animate-spin" /> : null}
                  {reviewPayloadSubmitLabel(activePayloadAction)}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-9 rounded-md px-5"
                  onClick={() => {
                    setPayloadError(null);
                    setActivePayloadActionId(null);
                  }}
                  disabled={running}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}
        </div>

        <div className="mt-6 flex flex-wrap gap-3">
          {canOpenArtifact ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-9 rounded-md px-5"
              onClick={() => void openReviewArtifact()}
              disabled={openingArtifact}
            >
              {openingArtifact ? <Loader2 size={14} className="animate-spin" /> : null}
              Open {reviewEvidence.artifactLabel.toLowerCase()}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-9 rounded-md px-5"
            onClick={onViewDetails}
          >
            View details
          </Button>
        </div>
        {openError ? <p className="mt-3 text-xs text-red-700">{openError}</p> : null}
      </div>
    </div>
  );
}

function GuidedResult({
  run,
  playbook,
  playbookDetail,
  graphRunDetail,
  workspaceRoot,
  artifactWorkspaceRoot,
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
  graphRunDetail: PlaybookGraphRunDetail | null;
  workspaceRoot: string | null;
  artifactWorkspaceRoot: string | null;
  dashboardLayout: DashboardLayout | null;
  refreshing: boolean;
  refreshNotice: string | null;
  onRefresh: () => void;
  onStartAnother: () => void;
  onViewDetails: () => void;
}) {
  const graphRunResult = useMemo(
    () =>
      graphRunDetail?.run.runId === run.runId
        ? graphRunToPlaybookRunDetail(graphRunDetail, run.playbook ?? playbookDetail ?? playbook)
        : null,
    [graphRunDetail, playbook, playbookDetail, run.playbook, run.runId]
  );
  const resultRun = graphRunResult ?? run;
  const graphOutputDeclarations =
    graphRunDetail?.run.runId === run.runId ? graphRunResultOutputDeclarations(graphRunDetail) : [];
  const inferredOutputKinds =
    graphRunDetail?.run.runId === run.runId
      ? new Set(graphRunDetail.artifacts.map((artifact) => artifact.artifactId))
      : undefined;
  const playbookForResult = resultRun.playbook ?? run.playbook ?? playbookDetail ?? playbook;
  const name = playbookForResult?.name ?? "Your playbook";
  const runVersionLabel = packageVersionLabel(runPackageVersion(resultRun));
  const latestVersionLabel = packageVersionLabel(playbookForResult?.packageVersion);
  const blockedWithoutApproval = resultRun.status === "blocked" && !resultRun.approval;
  const headlineFn = blockedWithoutApproval ? undefined : resultHeadline[resultRun.status];
  const headline = blockedWithoutApproval
    ? "Needs setup attention."
    : headlineFn
      ? headlineFn(name)
      : `${name} finished.`;
  const outputs = mergeOutputDeclarations(
    playbookForResult?.outputs ?? [],
    graphOutputDeclarations
  );
  const runOutputs = { ...(run.outputs ?? {}), ...(graphRunResult?.outputs ?? {}) };
  const latestEvent = resultRun.events?.[resultRun.events.length - 1];
  const sourceGaps = resultRun.sourceGaps ?? [];
  const runInput = resultRun.input ?? {};
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const openWorkspaceRoot = artifactWorkspaceRoot ?? workspaceRoot;
  const isDashboard = isDashboardPlaybook(playbookForResult);
  const sub = blockedWithoutApproval
    ? "Tessera cannot continue this run until the underlying setup problem is fixed."
    : resultRun.status === "completed" && isDashboard
      ? "Here's what changed, what's at risk, and what needs follow-up."
      : (resultSub[resultRun.status] ?? "");
  const visibleOutputs = visiblePlaybookOutputs(outputs, runOutputs, inferredOutputKinds);
  const failureMessage =
    resultRun.status === "failed" ? (resultRun.error ?? latestEvent?.message) : null;

  async function openArtifact(path: string) {
    if (!openWorkspaceRoot) return;
    setOpenError(null);
    setOpeningPath(path);
    try {
      await invoke("workspace_file_open", { workspaceRoot: openWorkspaceRoot, path });
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : String(error));
    } finally {
      setOpeningPath(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl py-4">
      <div className="mb-5">
        {playbookForResult?.businessUseCase ? (
          <div className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            {playbookForResult.businessUseCase}
          </div>
        ) : null}
        <h2 className="text-2xl font-semibold text-foreground">{headline}</h2>
        {runVersionLabel ? (
          <p className="mt-2 text-xs font-medium text-muted-foreground">
            {runVersionLabel}
            {latestVersionLabel && latestVersionLabel !== runVersionLabel
              ? ` · Latest package ${playbookForResult?.packageVersion}`
              : ""}
          </p>
        ) : null}
        {sub ? <p className="mt-2 text-sm text-muted-foreground">{sub}</p> : null}
        {resultRun.status === "completed" ? (
          <div className="mt-3">
            <UsageSummary
              usage={resultRun.usage}
              modelStepRan={playbookRunHasModelStep(resultRun)}
            />
          </div>
        ) : null}
        {failureMessage ? (
          <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {failureMessage}
          </p>
        ) : null}
        {blockedWithoutApproval ? (
          <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {resultRun.error ?? "The run is blocked by a runtime setup problem."}
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-3">
          {isDashboard && resultRun.status === "completed" ? (
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
            View run details
          </Button>
        </div>
      </div>

      {isDashboard && resultRun.status === "completed" ? (
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
        <div className="mb-5 grid content-start gap-2" data-testid="result-output-list">
          {visibleOutputs.map((output) => {
            const value = playbookOutputValue(output.kind, runOutputs);
            const artifactPath = playbookOutputArtifactPath(output.kind, value);
            const summary = playbookOutputSummary(
              output.kind,
              value,
              sourceGaps.length,
              artifactPath
            );
            const canOpen = !!artifactPath && !!openWorkspaceRoot;
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
                  "m-0 w-full rounded-md border border-border bg-background p-3 text-left",
                  canOpen &&
                    "cursor-pointer transition-colors hover:border-foreground/30 hover:bg-secondary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                )}
              >
                <div className="flex items-start gap-3">
                  <FileText size={18} className="mt-0.5 flex-shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-foreground">{output.label}</div>
                    {artifactPath ? (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {artifactPath}
                      </p>
                    ) : null}
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
    </div>
  );
}

function DetailsPanel({
  run,
  playbookDetail,
  graphRuns,
  selectedGraphRun,
  selectedGraphRunSurface,
  graphRunError,
  onSelectGraphRun,
  onResumeGraphRun,
  onPreviewGraphRunGitMilestone,
  onClose,
}: {
  run: PlaybookRunDetail | null;
  playbookDetail: PlaybookDetail | null;
  graphRuns: PlaybookGraphRunDetail["run"][];
  selectedGraphRun: PlaybookGraphRunDetail | null;
  selectedGraphRunSurface: PlaybookGraphRunReviewSurface | null;
  graphRunError: string | null;
  onSelectGraphRun: (runId: string) => void;
  onResumeGraphRun: (
    action: PlaybookGraphResumeActionSpec,
    payload?: Record<string, unknown>
  ) => void;
  onPreviewGraphRunGitMilestone: (
    runId: string,
    workspaceRoot: string
  ) => Promise<PlaybookGraphGitMilestonePreview>;
  onClose: () => void;
}) {
  const playbookForRun = run?.playbook ?? playbookDetail ?? null;
  const runVersionLabel = packageVersionLabel(runPackageVersion(run));
  const latestVersionLabel = packageVersionLabel(playbookForRun?.packageVersion);
  const runInput = run?.input ?? {};
  const sourceGaps = run?.sourceGaps ?? [];
  const visibleInputs = useMemo(() => {
    const definitions = playbookDetail?.inputs ?? {};
    return Object.entries(runInput)
      .filter(([key]) => key !== "workspaceRoot")
      .map(([key, value]) => ({
        key,
        label: definitions[key]?.label ?? titleFromId(key),
        value: inputDisplayValue(value),
      }));
  }, [playbookDetail?.inputs, runInput]);

  const outputRows = useMemo(() => {
    const graphRunForOutput = selectedGraphRun?.run.runId === run?.runId ? selectedGraphRun : null;
    const outputs = mergeOutputDeclarations(
      playbookForRun?.outputs ?? [],
      graphRunResultOutputDeclarations(graphRunForOutput)
    );
    const runOutputs = { ...(run?.outputs ?? {}), ...graphRunOutputs(graphRunForOutput) };
    const inferredOutputKinds = graphRunForOutput
      ? new Set(graphRunForOutput.artifacts.map((artifact) => artifact.artifactId))
      : undefined;
    return visiblePlaybookOutputs(outputs, runOutputs, inferredOutputKinds).map((output) => {
      const value = playbookOutputValue(output.kind, runOutputs);
      const artifactPath = playbookOutputArtifactPath(output.kind, value);
      return {
        key: output.kind,
        label: output.label,
        path: artifactPath,
      };
    });
  }, [playbookForRun?.outputs, run?.outputs, run?.runId, selectedGraphRun]);

  const runStepGroups = useMemo(() => {
    if (!run?.steps?.length) return [];
    return orderedPhases(playbookForRun, run).map((phase) => ({
      phase,
      steps: (run.steps ?? []).filter((step) => step.phase === phase),
    }));
  }, [run, playbookForRun]);
  const reviewEvidence = useMemo(
    () => reviewEvidenceFromSurface(selectedGraphRunSurface),
    [selectedGraphRunSurface]
  );
  const sourceProvenance = useMemo(
    () => sourceProvenanceSummaries(selectedGraphRun),
    [selectedGraphRun]
  );
  const reviewEvents =
    selectedGraphRun?.reviews.filter((review) => review.decision !== "requested") ?? [];

  return (
    <aside className="flex w-80 flex-shrink-0 flex-col border-l border-border bg-secondary">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Run summary</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">What Tessera did and produced</p>
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
            <div className="rounded-md border border-border bg-background px-3 py-3 text-xs">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-medium text-foreground">
                    {playbookForRun?.name ?? titleFromId(run.workflowId)}
                  </div>
                  {runVersionLabel ? (
                    <div className="mt-1 text-muted-foreground">
                      {runVersionLabel}
                      {latestVersionLabel && latestVersionLabel !== runVersionLabel
                        ? ` · Latest package ${playbookForRun?.packageVersion}`
                        : ""}
                    </div>
                  ) : null}
                  <div className="mt-1 text-muted-foreground">
                    {resultSub[run.status] ?? "Tessera updated this run."}
                  </div>
                  <div className="mt-1 text-muted-foreground">
                    Updated {formatTime(run.updatedAt)}
                  </div>
                </div>
                <span
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[10px]",
                    statusClass[run.status]
                  )}
                >
                  {runStatusCopy(run)}
                </span>
              </div>
            </div>

            {reviewEvidence ? (
              <Section title="Needs review" subtitle="What Tessera is asking you to approve">
                <div className="rounded-md border border-border bg-background px-3 py-3 text-xs">
                  <ReviewEvidenceBlock evidence={reviewEvidence} hideArtifactPreview />
                </div>
              </Section>
            ) : run.status === "blocked" && !run.approval ? (
              <Section title="Blocked" subtitle="Why this run cannot continue yet">
                <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                  {run.error ??
                    selectedGraphRun?.run.blockedReason ??
                    "Tessera cannot continue this run until its setup is fixed."}
                </div>
              </Section>
            ) : null}

            {outputRows.length > 0 ? (
              <Section title="Output" subtitle="What Tessera produced">
                <div className="divide-y divide-border overflow-hidden rounded-md border border-border bg-background">
                  {outputRows.map((output) => (
                    <div key={output.key} className="px-3 py-2 text-xs">
                      <div className="font-medium text-foreground">{output.label}</div>
                      {output.path ? (
                        <div className="mt-0.5 text-muted-foreground">{output.path}</div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </Section>
            ) : null}

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

            {reviewEvents.length > 0 ? (
              <Section title="Review" subtitle="Your decisions on this run">
                <div className="divide-y divide-border overflow-hidden rounded-md border border-border bg-background">
                  {reviewEvents.map((review) => (
                    <div key={review.reviewEventId} className="px-3 py-2 text-xs">
                      <div className="font-medium text-foreground">
                        {review.decision === "approved"
                          ? "Approved"
                          : review.decision === "denied"
                            ? "Denied"
                            : review.decision === "request_changes"
                              ? "Changes requested"
                              : "Edited"}
                      </div>
                      <div className="mt-0.5 text-muted-foreground">
                        {formatTime(review.createdAt)}
                      </div>
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

            {sourceProvenance.length > 0 ? (
              <Section title="Source provenance" subtitle="Evidence used by this run">
                <div className="divide-y divide-border overflow-hidden rounded-md border border-border bg-background">
                  {sourceProvenance.map((source) => (
                    <div key={source.artifactId} className="px-3 py-2 text-xs">
                      <div className="font-medium text-foreground">{source.label}</div>
                      <div className="mt-0.5 text-muted-foreground">
                        {source.sourceKinds.length > 0
                          ? source.sourceKinds.map(formatSourceKindLabel).join(", ")
                          : "Source count recorded"}
                        {source.sourceCount !== null
                          ? ` · ${source.sourceCount} source${source.sourceCount === 1 ? "" : "s"}`
                          : ""}
                        {source.fixtureOnly ? " · fixture run" : ""}
                      </div>
                      {source.notes ? (
                        <div className="mt-0.5 text-muted-foreground">{source.notes}</div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </Section>
            ) : null}

            {runStepGroups.length > 0 ? (
              <Section title="Progress" subtitle="How the run completed">
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

            <GraphRuntimeSection
              runs={graphRuns}
              detail={selectedGraphRun}
              surface={selectedGraphRunSurface}
              error={graphRunError}
              onSelect={onSelectGraphRun}
              onResume={onResumeGraphRun}
              onPreviewGitMilestone={onPreviewGraphRunGitMilestone}
            />
          </div>
        ) : (
          <GraphRuntimeSection
            runs={graphRuns}
            detail={selectedGraphRun}
            surface={selectedGraphRunSurface}
            error={graphRunError}
            onSelect={onSelectGraphRun}
            onResume={onResumeGraphRun}
            onPreviewGitMilestone={onPreviewGraphRunGitMilestone}
          />
        )}
      </div>
    </aside>
  );
}

export function PlaybooksView({
  workspaceRoot,
  onWorkspaceSelect,
  userKey,
  initialPlaybooks,
}: PlaybooksViewProps) {
  const [playbooks, setPlaybooks] = useState<PlaybookSummary[]>(() => initialPlaybooks ?? []);
  const [selectedPlaybookDetail, setSelectedPlaybookDetail] = useState<PlaybookDetail | null>(null);
  const [runs, setRuns] = useState<PlaybookRunDetail[]>([]);
  const [runHistory, setRunHistory] = useState<PlaybookRunDetail[]>([]);
  const [selectedPlaybookId, setSelectedPlaybookId] = useState<string | null>(
    () => initialPlaybooks?.find((p) => p.businessUseCase)?.id ?? null
  );
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRunDetail, setSelectedRunDetail] = useState<PlaybookRunDetail | null>(null);
  const [graphRuns, setGraphRuns] = useState<PlaybookGraphRunDetail["run"][]>([]);
  const [selectedGraphRunId, setSelectedGraphRunId] = useState<string | null>(null);
  const [selectedGraphRunDetail, setSelectedGraphRunDetail] =
    useState<PlaybookGraphRunDetail | null>(null);
  const [selectedGraphRunSurface, setSelectedGraphRunSurface] =
    useState<PlaybookGraphRunReviewSurface | null>(null);
  const [graphRunError, setGraphRunError] = useState<string | null>(null);
  const [dashboardLayout, setDashboardLayout] = useState<DashboardLayout | null>(null);
  const [modelSettings, setModelSettings] = useState<ModelSettingsRead | null>(null);
  const [integrationSettings, setIntegrationSettings] = useState<IntegrationSettingsRead | null>(
    null
  );
  const [agentProfiles, setAgentProfiles] = useState<AgentProfile[]>([]);
  const [formValues, setFormValues] = useState<Record<string, unknown>>({});
  const [styleGuideResult, setStyleGuideResult] = useState<WorkspaceStyleGuideReadResult | null>(
    null
  );
  const [styleGuideLoading, setStyleGuideLoading] = useState(false);
  const [styleGuideError, setStyleGuideError] = useState<string | null>(null);
  const [styleSelection, setStyleSelection] = useState<GraphRunStyleSelection>({
    toneNudges: [],
  });
  const [showStartForm, setShowStartForm] = useState(true);
  const [showDetails, setShowDetails] = useState(false);
  const hasInitialPlaybooks = initialPlaybooks != null && initialPlaybooks.length > 0;
  const [loadingPlaybooks, setLoadingPlaybooks] = useState(!hasInitialPlaybooks);
  const [playbooksLoaded, setPlaybooksLoaded] = useState(hasInitialPlaybooks);
  const [running, setRunning] = useState(false);
  const [importingPlaybook, setImportingPlaybook] = useState(false);
  const [importEvents, setImportEvents] = useState<string[]>([]);
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
  const assignmentPreferenceRequestRef = useRef(0);
  const liveRunRefreshInFlightRef = useRef(false);
  const graphRunDrainInFlightRef = useRef(new Map<string, Promise<PlaybookGraphRunDetail>>());
  const selectedRunIdRef = useRef<string | null>(selectedRunId);
  const selectedGraphRunIdRef = useRef<string | null>(selectedGraphRunId);
  const selectedRunDetailRefreshRef = useRef<string | null>(null);
  const contentScrollRef = useRef<HTMLElement | null>(null);

  const businessPlaybooks = useMemo(
    () => playbooks.filter((p) => !!p.businessUseCase || !!p.graphHash),
    [playbooks]
  );
  const completedRunForPlaybook = useCallback(
    (playbookId: string) => latestCompletedRunForPlaybook([...runs, ...runHistory], playbookId),
    [runHistory, runs]
  );
  const hasCompletedRun = useCallback(
    (playbookId: string) => completedRunForPlaybook(playbookId) !== null,
    [completedRunForPlaybook]
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
  const selectedGraphHash = selectedPlaybookForUi?.graphHash;
  const selectedSourceHash = selectedPlaybookForUi?.sourceHash;
  const selectedWritingStyle = selectedPlaybookForUi?.writingStyle?.enabled
    ? selectedPlaybookForUi.writingStyle
    : null;
  const selectedStyleGuide = styleGuideResult?.config.styleGuide ?? null;
  const selectedRun = useMemo(() => {
    if (selectedGraphRunDetail?.run.runId === selectedRunId) {
      return graphRunToPlaybookRunDetail(
        selectedGraphRunDetail,
        selectedPlaybookForUi,
        selectedGraphRunSurface?.productView
      );
    }
    return (
      selectedRunDetail ??
      (selectedRunId ? (runs.find((run) => run.runId === selectedRunId) ?? null) : null)
    );
  }, [
    runs,
    selectedGraphRunDetail,
    selectedGraphRunSurface?.productView,
    selectedPlaybookForUi,
    selectedRunDetail,
    selectedRunId,
  ]);
  const selectedRunNeedsRefresh = runNeedsLiveRefresh(selectedRun, selectedGraphRunDetail);
  const selectedReviewEvidence = useMemo(
    () => reviewEvidenceFromSurface(selectedGraphRunSurface),
    [selectedGraphRunSurface]
  );

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
  const contentScrollResetKey = `${guidedState}:${selectedPlaybookId ?? ""}:${selectedRunId ?? ""}`;

  useEffect(() => {
    if (!selectedPlaybookForUi || selectedRunId || !isDashboardPlaybook(selectedPlaybookForUi)) {
      return;
    }
    const latestDashboardRun = completedRunForPlaybook(selectedPlaybookForUi.id);
    if (!latestDashboardRun) return;

    selectedRunIdRef.current = latestDashboardRun.runId;
    selectedGraphRunIdRef.current = null;
    setSelectedRunId(latestDashboardRun.runId);
    setSelectedRunDetail(latestDashboardRun);
    setSelectedGraphRunId(null);
    setSelectedGraphRunDetail(null);
    setSelectedGraphRunSurface(null);
    setShowStartForm(false);
  }, [completedRunForPlaybook, selectedPlaybookForUi, selectedRunId]);

  useEffect(() => {
    const contentPane = contentScrollRef.current;
    if (!contentPane) return;
    contentPane.dataset.scrollResetKey = contentScrollResetKey;
    contentPane.scrollTop = 0;
    contentPane.scrollLeft = 0;
  }, [contentScrollResetKey]);

  useEffect(() => {
    let active = true;
    if (!workspaceRoot) {
      setStyleGuideResult(null);
      setStyleGuideError(null);
      setStyleGuideLoading(false);
      return () => {
        active = false;
      };
    }

    setStyleGuideLoading(true);
    setStyleGuideError(null);
    void invoke<WorkspaceStyleGuideReadResult>("workspace_style_guide_get", { workspaceRoot })
      .then((result) => {
        if (!active) return;
        setStyleGuideResult(result);
      })
      .catch((loadError: unknown) => {
        if (!active) return;
        setStyleGuideResult(null);
        setStyleGuideError(loadError instanceof Error ? loadError.message : String(loadError));
      })
      .finally(() => {
        if (active) {
          setStyleGuideLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [workspaceRoot]);

  useEffect(() => {
    if (!selectedWritingStyle) {
      setStyleSelection({ toneNudges: [] });
      return;
    }
    const guide = selectedStyleGuide;
    const availableCopyTypes = guide ? Object.keys(guide.copyTypes) : [];
    const supportedCopyTypes =
      selectedWritingStyle.supportedCopyTypes.length > 0
        ? selectedWritingStyle.supportedCopyTypes.filter((copyType) =>
            availableCopyTypes.includes(copyType)
          )
        : availableCopyTypes;
    const copyType =
      selectedWritingStyle.defaultCopyType &&
      supportedCopyTypes.includes(selectedWritingStyle.defaultCopyType)
        ? selectedWritingStyle.defaultCopyType
        : (guide?.profile.defaultCopyType ?? supportedCopyTypes[0]);
    setStyleSelection(copyType ? { copyType, toneNudges: [] } : { toneNudges: [] });
  }, [selectedWritingStyle, selectedStyleGuide]);

  useEffect(() => {
    const requestId = ++assignmentPreferenceRequestRef.current;
    if (!selectedPlaybookId || !workspaceRoot || !capabilityInventory) {
      setAssignmentPreview(null);
      setDraftAssignmentPlan(null);
      setAgentsConfirmed(false);
      return;
    }

    if (selectedGraphHash) {
      setSetupError(null);
      setAssignmentPreview(null);
      setDraftAssignmentPlan(null);
      setAgentsConfirmed(false);
      void (async () => {
        try {
          const preference = await invoke<PlaybookRunPreferenceReadResult>(
            "playbook_run_preference_get",
            {
              playbookId: selectedPlaybookId,
              workspaceRoot,
              userKey,
            }
          );
          if (assignmentPreferenceRequestRef.current !== requestId) return;

          const previousPlan = preference.preference?.assignmentPlan;
          const preview = await invoke<PlaybookAssignmentPreviewResult>("playbook_preflight", {
            playbookId: selectedPlaybookId,
            request: {
              workspaceRoot,
              capabilityInventory,
              ...(previousPlan ? { previousPlan } : {}),
            },
            userKey,
          });
          if (assignmentPreferenceRequestRef.current !== requestId) return;

          setAssignmentPreview(preview);
          setDraftAssignmentPlan(
            previousPlan
              ? assignmentPlanWithCurrentCandidates(previousPlan, preview)
              : (preview.assignmentPlan ?? null)
          );
          setAgentsConfirmed((preview.blockers ?? []).length === 0);
        } catch (loadError) {
          if (assignmentPreferenceRequestRef.current !== requestId) return;
          setSetupError(loadError instanceof Error ? loadError.message : String(loadError));
          setAssignmentPreview(null);
          setDraftAssignmentPlan(null);
          setAgentsConfirmed(false);
        }
      })();
      return;
    }

    setAssignmentPreview(null);
    setDraftAssignmentPlan(null);
    setAgentsConfirmed(false);
  }, [capabilityInventory, selectedGraphHash, selectedPlaybookId, userKey, workspaceRoot]);

  const loadPlaybooks = useCallback(async () => {
    setLoadingPlaybooks(true);
    setError(null);
    try {
      const result = await invoke<PlaybookListResult>("playbook_list", { userKey });
      setPlaybooks(result.playbooks);
      setSelectedPlaybookId((current) => {
        const next =
          current && result.playbooks.some((playbook) => playbook.id === current)
            ? current
            : (result.playbooks.find((p) => p.businessUseCase)?.id ?? null);
        if (next !== current) {
          setSelectedPlaybookDetail(null);
          setSelectedRunId(null);
          setSelectedRunDetail(null);
          setSelectedGraphRunId(null);
          setSelectedGraphRunDetail(null);
          setSelectedGraphRunSurface(null);
        }
        return next;
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setPlaybooksLoaded(true);
      setLoadingPlaybooks(false);
    }
  }, [userKey]);

  const loadSetup = useCallback(async () => {
    setSetupError(null);
    try {
      const [loadedModelSettings, loadedIntegrationSettings, loadedAgentProfiles] =
        await Promise.all([
          invoke<ModelSettingsRead>("model_settings_get", { userKey }),
          invoke<IntegrationSettingsRead>("integration_settings_get", { userKey }),
          invoke<AgentProfileListResult>("agent_profile_list", { userKey }),
        ]);
      setModelSettings(loadedModelSettings);
      setIntegrationSettings(loadedIntegrationSettings);
      setAgentProfiles(loadedAgentProfiles.profiles);
    } catch (loadError) {
      setSetupError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, [userKey]);

  const loadPlaybookDetail = useCallback(
    async (playbookId: string) => {
      try {
        const detail = await invoke<PlaybookDetail>("playbook_get", { playbookId, userKey });
        setSelectedPlaybookDetail(detail);
      } catch (loadError) {
        setSelectedPlaybookDetail(null);
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    },
    [userKey]
  );

  const loadRuns = useCallback(
    async (playbookId?: string | null) => {
      const requestId = ++runListRequestRef.current;
      setError(null);
      setGraphRunError(null);
      if (!playbookId || !workspaceRoot) {
        setRuns([]);
        setGraphRuns([]);
        setSelectedRunId(null);
        setSelectedRunDetail(null);
        setSelectedGraphRunId(null);
        setSelectedGraphRunDetail(null);
        setSelectedGraphRunSurface(null);
        return;
      }

      try {
        const result = await invoke<PlaybookGraphRunListResult>("graph_run_list", {
          playbookId,
          limit: PLAYBOOK_RUN_LIST_LIMIT,
          userKey,
          workspaceRoot,
        });
        if (requestId !== runListRequestRef.current) return;

        const nextGraphRuns = result.runs.filter((run) => run.playbookId === playbookId);
        const playbookRuns = nextGraphRuns.map((run) =>
          graphRunRecordToPlaybookRunDetail(run, null)
        );
        setGraphRuns(nextGraphRuns);
        setRuns(playbookRuns);
        setSelectedRunId((current) => {
          if (current && playbookRuns.some((run) => run.runId === current)) return current;
          setSelectedRunDetail(null);
          return null;
        });
        setSelectedGraphRunId((current) => {
          if (current && nextGraphRuns.some((run) => run.runId === current)) return current;
          setSelectedGraphRunDetail(null);
          setSelectedGraphRunSurface(null);
          return null;
        });
      } catch (loadError) {
        if (requestId !== runListRequestRef.current) return;
        setRuns([]);
        setGraphRuns([]);
        setSelectedRunDetail(null);
        setSelectedGraphRunDetail(null);
        setSelectedGraphRunSurface(null);
        setError(loadError instanceof Error ? loadError.message : String(loadError));
        setGraphRunError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    },
    [userKey, workspaceRoot]
  );

  const loadRunHistory = useCallback(async () => {
    if (!workspaceRoot) {
      setRunHistory([]);
      return;
    }
    try {
      const result = await invoke<PlaybookGraphRunListResult>("graph_run_list", {
        status: "completed",
        limit: PLAYBOOK_HISTORY_LIMIT,
        userKey,
        workspaceRoot,
      });
      setRunHistory(result.runs.map((run) => graphRunRecordToPlaybookRunDetail(run, null)));
    } catch {
      setRunHistory([]);
    }
  }, [userKey, workspaceRoot]);

  const loadRunDetail = useCallback(
    async (runId: string) => {
      try {
        let surface = await invoke<PlaybookGraphRunReviewSurface>("graph_run_review_surface", {
          runId,
          userKey,
          workspaceRoot,
        });
        const queuedRunId = surface.detail.run.runId;
        if (graphRunHasQueuedRuntimeWork(surface.detail)) {
          const existingDrain = graphRunDrainInFlightRef.current.get(queuedRunId);
          const drain =
            existingDrain ??
            invoke<PlaybookGraphRunDetail>("graph_run_drain", {
              runId: queuedRunId,
              userKey,
              workspaceRoot,
            }).finally(() => {
              graphRunDrainInFlightRef.current.delete(queuedRunId);
            });
          if (!existingDrain) graphRunDrainInFlightRef.current.set(queuedRunId, drain);
          await drain;
          surface = await invoke<PlaybookGraphRunReviewSurface>("graph_run_review_surface", {
            runId,
            userKey,
            workspaceRoot,
          });
        }
        const detail = graphRunToPlaybookRunDetail(
          surface.detail,
          selectedPlaybookForUi,
          surface.productView
        );
        if (selectedRunIdRef.current !== runId) return;
        const selectedGraphRunId = selectedGraphRunIdRef.current;
        if (!selectedGraphRunId || selectedGraphRunId === runId) {
          setSelectedGraphRunSurface(surface);
          setSelectedGraphRunDetail(surface.detail);
        }
        setSelectedRunDetail(detail);
        setRuns((current) => mergeRunById(current, detail));
        setGraphRuns((current) => mergeRunById(current, surface.detail.run));
      } catch (loadError) {
        if (selectedRunIdRef.current !== runId) return;
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    },
    [selectedPlaybookForUi, userKey, workspaceRoot]
  );

  const selectRun = useCallback(
    (runId: string) => {
      const alreadySelected = selectedRunId === runId;
      if (contentScrollRef.current) {
        contentScrollRef.current.scrollTop = 0;
        contentScrollRef.current.scrollLeft = 0;
      }
      selectedRunIdRef.current = runId;
      selectedGraphRunIdRef.current = null;
      setSelectedRunId(runId);
      setSelectedGraphRunId(null);
      setShowStartForm(false);
      setSelectedRunDetail(null);
      setSelectedGraphRunDetail(null);
      setSelectedGraphRunSurface(null);
      if (alreadySelected) {
        void loadRunDetail(runId);
      }
    },
    [loadRunDetail, selectedRunId]
  );

  const loadGraphRunDetail = useCallback(
    async (runId: string) => {
      try {
        let surface = await invoke<PlaybookGraphRunReviewSurface>("graph_run_review_surface", {
          runId,
          userKey,
          workspaceRoot,
        });
        const queuedRunId = surface.detail.run.runId;
        if (graphRunHasQueuedRuntimeWork(surface.detail)) {
          const existingDrain = graphRunDrainInFlightRef.current.get(queuedRunId);
          const drain =
            existingDrain ??
            invoke<PlaybookGraphRunDetail>("graph_run_drain", {
              runId: queuedRunId,
              userKey,
              workspaceRoot,
            }).finally(() => {
              graphRunDrainInFlightRef.current.delete(queuedRunId);
            });
          if (!existingDrain) graphRunDrainInFlightRef.current.set(queuedRunId, drain);
          await drain;
          surface = await invoke<PlaybookGraphRunReviewSurface>("graph_run_review_surface", {
            runId,
            userKey,
            workspaceRoot,
          });
        }
        const detailRun = graphRunToPlaybookRunDetail(
          surface.detail,
          selectedPlaybookForUi,
          surface.productView
        );
        const selectedGraphRunId = selectedGraphRunIdRef.current;
        if (selectedGraphRunId && selectedGraphRunId !== runId) return;
        setSelectedGraphRunSurface(surface);
        setSelectedGraphRunDetail(surface.detail);
        setSelectedRunDetail(detailRun);
        setRuns((current) => mergeRunById(current, detailRun));
        setGraphRuns((current) => mergeRunById(current, surface.detail.run));
      } catch (loadError) {
        setGraphRunError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    },
    [selectedPlaybookForUi, userKey, workspaceRoot]
  );

  useEffect(() => {
    selectedRunIdRef.current = selectedRunId;
  }, [selectedRunId]);

  useEffect(() => {
    selectedGraphRunIdRef.current = selectedGraphRunId;
  }, [selectedGraphRunId]);

  useEffect(() => {
    void loadPlaybooks();
  }, [loadPlaybooks]);

  useEffect(() => {
    if (!playbooksLoaded) return;
    void loadSetup();
    const timeout = setTimeout(() => {
      void loadRunHistory();
    }, 0);
    return () => clearTimeout(timeout);
  }, [loadRunHistory, loadSetup, playbooksLoaded]);

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
      setSelectedGraphRunDetail(null);
      setSelectedGraphRunSurface(null);
      return;
    }
    void loadRunDetail(selectedRunId);
  }, [loadRunDetail, selectedRunId]);

  useEffect(() => {
    if (!selectedRunId) {
      selectedRunDetailRefreshRef.current = null;
      return;
    }
    const refreshKey = `${PLAYBOOK_RESULT_RENDERER_REVISION}:${selectedRunId}`;
    if (selectedRunDetailRefreshRef.current === refreshKey) return;
    selectedRunDetailRefreshRef.current = refreshKey;
    void loadRunDetail(selectedRunId);
  });

  useEffect(() => {
    if (!selectedPlaybookId || !selectedRunId || !selectedRunNeedsRefresh) return;

    const interval = window.setInterval(() => {
      if (liveRunRefreshInFlightRef.current) return;
      liveRunRefreshInFlightRef.current = true;
      void (async () => {
        try {
          await loadRuns(selectedPlaybookId);
          await loadRunDetail(selectedRunId);
        } finally {
          liveRunRefreshInFlightRef.current = false;
        }
      })();
    }, PLAYBOOK_ACTIVE_RUN_REFRESH_MS);

    return () => window.clearInterval(interval);
  }, [loadRunDetail, loadRuns, selectedPlaybookId, selectedRunId, selectedRunNeedsRefresh]);

  useEffect(() => {
    if (!showDetails) return;
    if (!selectedGraphRunId) {
      return;
    }
    void loadGraphRunDetail(selectedGraphRunId);
  }, [loadGraphRunDetail, selectedGraphRunId, showDetails]);

  useEffect(() => {
    if (!refreshNotice) return;
    const timeout = setTimeout(() => setRefreshNotice(null), 2500);
    return () => clearTimeout(timeout);
  }, [refreshNotice]);

  useEffect(() => {
    if (importingPlaybook || importEvents.length === 0) return;
    const timeout = setTimeout(() => setImportEvents([]), 5000);
    return () => clearTimeout(timeout);
  }, [importEvents.length, importingPlaybook]);

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
      return;
    }

    if (!cancelled) {
      setDashboardLayout(dashboardLayoutFromPlaybook(selectedPlaybookForUi));
    }

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
    if (selectedGraphRunId) {
      void loadGraphRunDetail(selectedGraphRunId);
    }
  }, [
    loadGraphRunDetail,
    loadPlaybookDetail,
    loadPlaybooks,
    loadRunDetail,
    loadRunHistory,
    loadRuns,
    loadSetup,
    selectedGraphRunId,
    selectedPlaybookId,
    selectedRunId,
  ]);

  const importPlaybook = useCallback(
    async (kind: "archive" | "folder") => {
      setError(null);
      setRefreshNotice(null);
      setImportEvents([]);
      let selectedPath: string | string[] | null;
      try {
        selectedPath =
          kind === "folder"
            ? await open({ multiple: false, directory: true })
            : await open({
                multiple: false,
                filters: [{ name: "Playbook archive", extensions: ["playbook", "zip"] }],
              });
      } catch (dialogError) {
        setError(dialogError instanceof Error ? dialogError.message : String(dialogError));
        return;
      }
      if (!selectedPath || typeof selectedPath !== "string") {
        return;
      }

      setImportingPlaybook(true);
      setImportEvents([
        kind === "folder" ? "Folder selected" : "Archive selected",
        "Installing playbook package",
      ]);
      try {
        const imported = await invoke<GraphPlaybookImportResult>("playbook_import", {
          ...(kind === "folder" ? { sourcePath: selectedPath } : { zipPath: selectedPath }),
          userKey,
        });
        setImportEvents((current) => [
          ...current,
          `${imported.name} ${imported.version} ${imported.status}`,
          "Refreshing playbooks and run history",
        ]);
        const result = await invoke<PlaybookListResult>("playbook_list", { userKey });
        setPlaybooks(result.playbooks);
        setSelectedPlaybookId(imported.id);
        setSelectedRunId(null);
        setSelectedRunDetail(null);
        setSelectedGraphRunId(null);
        setSelectedGraphRunDetail(null);
        await Promise.all([
          loadPlaybookDetail(imported.id),
          loadRuns(imported.id),
          loadRunHistory(),
        ]);
        setImportEvents((current) => [...current, "Ready to run"]);
        const warningCopy = imported.warnings.length > 0 ? ` ${imported.warnings.join(" ")}` : "";
        setRefreshNotice(
          `${imported.name} ${imported.version} ${imported.status}.${warningCopy}`.trim()
        );
      } catch (importError) {
        setImportEvents((current) => [...current, "Import failed"]);
        setError(importError instanceof Error ? importError.message : String(importError));
      } finally {
        setImportingPlaybook(false);
      }
    },
    [loadPlaybookDetail, loadRunHistory, loadRuns, userKey]
  );

  async function startRun(
    inputOverride?: Record<string, unknown>,
    assignmentPlanOverride?: WorkflowRunAssignmentPlan
  ) {
    const assignmentPlan = assignmentPlanOverride ?? draftAssignmentPlan ?? undefined;
    if (!selectedPlaybook || !workspaceRoot) return;
    if (!selectedGraphHash && !assignmentPlan) {
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
      if (!selectedGraphHash) {
        throw new Error("This playbook is not available in the graph runtime.");
      }
      if (!selectedSourceHash) {
        throw new Error("This playbook is missing a graph source hash.");
      }
      const runStyleSelection =
        selectedWritingStyle && styleGuideResult?.config.styleGuide
          ? normalizedStyleSelection(styleSelection)
          : undefined;
      const request: PlaybookGraphRunCreateRequest = {
        playbookId: selectedPlaybook.id,
        graphHash: selectedGraphHash,
        sourceHash: selectedSourceHash,
        agentId: firstAssignedAgentId(assignmentPlan) ?? "default",
        ...(assignmentPlan ? { assignmentPlan } : {}),
        ...(runStyleSelection ? { styleGuideSelection: runStyleSelection } : {}),
        input: fullInput,
        workspaceRoot,
        drainDeterministic: true,
      };
      const detail = await invoke<PlaybookGraphRunDetail>("graph_run_create", {
        request,
        userKey,
      });
      const run = graphRunToPlaybookRunDetail(detail, selectedPlaybookForUi);
      setRuns((current) => [run, ...current.filter((item) => item.runId !== run.runId)]);
      setRunHistory((current) => [run, ...current.filter((item) => item.runId !== run.runId)]);
      setGraphRuns((current) => [
        detail.run,
        ...current.filter((item) => item.runId !== detail.run.runId),
      ]);
      setSelectedRunId(run.runId);
      setSelectedRunDetail(run);
      setSelectedGraphRunDetail(detail);
      await loadGraphRunDetail(detail.run.runId);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError));
      setShowStartForm(true);
    } finally {
      setRunning(false);
    }
  }

  async function confirmAgents() {
    if (!selectedPlaybookId || !workspaceRoot || !draftAssignmentPlan) return;
    setSavingPreference(true);
    setSetupError(null);
    try {
      await invoke("playbook_run_preference_save", {
        playbookId: selectedPlaybookId,
        request: {
          workspaceRoot,
          assignmentPlan: draftAssignmentPlan,
          ...(capabilityInventory ? { capabilityInventory } : {}),
        },
        userKey,
      });
      setAgentsConfirmed(true);
    } catch (saveError) {
      setSetupError(saveError instanceof Error ? saveError.message : String(saveError));
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
    if (!selectedGraphHash && !assignmentPlan) {
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

  async function resumeRun(
    decision: "approve" | "deny",
    action?: PlaybookGraphResumeActionSpec,
    payload?: Record<string, unknown>
  ) {
    if (!selectedRun) return;
    setRunning(true);
    setError(null);
    try {
      const approvalDecision =
        selectedRun.approval?.reasonCode === "graph_context_change"
          ? "approve_context_change"
          : selectedRun.approval?.reasonCode === "graph_interrupted_retry"
            ? "retry_interrupted"
            : selectedRun.approval?.reasonCode === "graph_needs_attention_retry"
              ? "retry_needs_attention"
              : selectedRun.approval?.reasonCode === "graph_repair"
                ? "approve_repair"
                : "approve";
      const actionDecision =
        action?.decision ?? (decision === "approve" ? approvalDecision : "deny");
      const productActionId =
        action?.actionId ??
        (decision === "approve"
          ? selectedGraphRunSurface?.productView?.primaryAction?.actionId
          : null);
      const selectedAction =
        action ??
        (productActionId
          ? selectedGraphRunSurface?.actions.find((item) => item.actionId === productActionId)
          : undefined) ??
        selectedGraphRunSurface?.actions.find((item) => item.decision === actionDecision);
      const detail = await invoke<PlaybookGraphRunDetail>("graph_run_resume", {
        runId: selectedRun.runId,
        request: {
          runId: selectedRun.runId,
          ...(selectedAction?.actionId ? { actionId: selectedAction.actionId } : {}),
          decision: actionDecision,
          ...(selectedAction?.queueEntryId ? { queueEntryId: selectedAction.queueEntryId } : {}),
          ...(payload && Object.keys(payload).length > 0 ? { payload } : {}),
        },
        userKey,
        workspaceRoot,
      });
      const run = graphRunToPlaybookRunDetail(detail, selectedPlaybookForUi);
      setRuns((current) => current.map((item) => (item.runId === run.runId ? run : item)));
      setRunHistory((current) => current.map((item) => (item.runId === run.runId ? run : item)));
      setGraphRuns((current) =>
        current.map((item) => (item.runId === detail.run.runId ? detail.run : item))
      );
      setSelectedGraphRunSurface(null);
      setSelectedGraphRunDetail(detail);
      setSelectedRunDetail(run);
      await loadGraphRunDetail(detail.run.runId);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError));
    } finally {
      setRunning(false);
    }
  }

  async function resumeGraphRun(
    action: PlaybookGraphResumeActionSpec,
    payload?: Record<string, unknown>
  ) {
    if (!selectedGraphRunDetail) return;
    setRunning(true);
    setGraphRunError(null);
    try {
      const detail = await invoke<PlaybookGraphRunDetail>("graph_run_resume", {
        runId: selectedGraphRunDetail.run.runId,
        request: {
          runId: selectedGraphRunDetail.run.runId,
          actionId: action.actionId,
          decision: action.decision,
          ...(action.queueEntryId ? { queueEntryId: action.queueEntryId } : {}),
          ...(payload && Object.keys(payload).length > 0 ? { payload } : {}),
        },
        userKey,
        workspaceRoot,
      });
      setSelectedGraphRunDetail(detail);
      setGraphRuns((current) =>
        current.map((run) => (run.runId === detail.run.runId ? detail.run : run))
      );
      setSelectedRunDetail(graphRunToPlaybookRunDetail(detail, selectedPlaybookForUi));
      await loadGraphRunDetail(detail.run.runId);
    } catch (runError) {
      setGraphRunError(runError instanceof Error ? runError.message : String(runError));
    } finally {
      setRunning(false);
    }
  }

  async function previewGraphRunGitMilestone(
    runId: string,
    workspaceRoot: string
  ): Promise<PlaybookGraphGitMilestonePreview> {
    return invoke<PlaybookGraphGitMilestonePreview>("graph_run_git_milestone_preview", {
      runId,
      request: {
        runId,
        actionSpecId: `${runId}:git_milestone`,
        workspaceRoot,
      },
      userKey,
      workspaceRoot,
    });
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
        const latestDashboardRun = isDashboardPlaybook(playbook)
          ? completedRunForPlaybook(playbook.id)
          : null;
        setSelectedPlaybookId(playbook.id);
        setShowStartForm(latestDashboardRun === null);
        selectedRunIdRef.current = latestDashboardRun?.runId ?? null;
        selectedGraphRunIdRef.current = null;
        setSelectedRunId(latestDashboardRun?.runId ?? null);
        setSelectedRunDetail(latestDashboardRun);
        setSelectedGraphRunId(null);
        setSelectedGraphRunDetail(null);
        setSelectedGraphRunSurface(null);
        if (!isSamePlaybook) {
          setRuns([]);
          setGraphRuns([]);
        }
      }}
    >
      <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
        <span>{playbook.name}</span>
        {isDashboardPlaybook(playbook) ? (
          <span className="rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-800">Dashboard</span>
        ) : null}
      </div>
      {packageVersionLabel(playbook.packageVersion) ? (
        <div className="mt-1 text-xs font-medium text-muted-foreground">
          {packageVersionLabel(playbook.packageVersion)}
        </div>
      ) : null}
      <div className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
        {playbook.businessUseCase ?? playbook.description}
      </div>
    </button>
  );

  const playbookCatalogLoading =
    (!playbooksLoaded || loadingPlaybooks) && businessPlaybooks.length === 0;

  return (
    <main className="flex min-w-0 flex-1 bg-background">
      <aside className="flex w-64 flex-shrink-0 flex-col border-r border-border bg-secondary">
        <WorkspacePicker currentWorkspace={workspaceRoot} onWorkspaceSelect={onWorkspaceSelect} />

        <div className="border-b border-border px-4 py-3">
          <div className="flex items-center justify-between">
            <h1 className="text-sm font-semibold text-foreground">Playbooks</h1>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-full"
                onClick={() => void importPlaybook("archive")}
                disabled={loadingPlaybooks || running || importingPlaybook}
                title="Import playbook archive"
              >
                {importingPlaybook ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Upload size={14} />
                )}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-full"
                onClick={() => void importPlaybook("folder")}
                disabled={loadingPlaybooks || running || importingPlaybook}
                title="Import playbook folder"
              >
                <FolderPlus size={14} />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-full"
                onClick={refreshAll}
                disabled={loadingPlaybooks || running || importingPlaybook}
                title="Refresh"
              >
                <RefreshCw size={14} />
              </Button>
            </div>
          </div>
        </div>

        <div
          className="min-h-0 flex-1 overflow-y-auto border-b border-border p-2 scrollbar-subtle"
          data-testid="playbook-catalog"
        >
          {playbookCatalogLoading ? (
            <PlaybookListSkeleton />
          ) : (
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
                <div className="mb-1.5 flex items-center justify-between px-3">
                  <h2 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                    Playbooks
                  </h2>
                  {loadingPlaybooks ? (
                    <Loader2
                      size={12}
                      className="animate-spin text-muted-foreground"
                      aria-label="Refreshing playbooks"
                    />
                  ) : null}
                </div>
                <div className="space-y-1">
                  {regularPlaybooks.length > 0 ? (
                    regularPlaybooks.map(renderPlaybookButton)
                  ) : (
                    <div className="px-3 py-4 text-xs text-muted-foreground">
                      No playbooks available.
                    </div>
                  )}
                </div>
              </section>
            </div>
          )}
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

        {refreshNotice ? (
          <div className="border-b border-blue-200 bg-blue-50 px-4 py-2 text-xs text-blue-700">
            {refreshNotice}
          </div>
        ) : null}

        {importEvents.length > 0 ? (
          <div className="border-b border-border bg-background px-4 py-3 text-xs">
            <div className="mb-2 flex items-center gap-2 font-medium text-foreground">
              {importingPlaybook ? <Loader2 size={13} className="animate-spin" /> : null}
              {importingPlaybook ? "Importing playbook" : "Import complete"}
            </div>
            <div className="space-y-1 text-muted-foreground">
              {importEvents.map((event) => (
                <div key={event}>{event}</div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="max-h-56 flex-shrink-0 overflow-y-auto py-2 scrollbar-subtle">
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
              onClick={() => selectRun(run.runId)}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">{formatTime(run.updatedAt)}</span>
                <span
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[10px]",
                    statusClass[run.status]
                  )}
                >
                  {runStatusCopy(run)}
                </span>
              </div>
              {packageVersionLabel(runPackageVersion(run)) ? (
                <div className="mt-1 text-xs font-medium text-muted-foreground">
                  {packageVersionLabel(runPackageVersion(run))}
                  {selectedPlaybookForUi?.packageVersion &&
                  selectedPlaybookForUi.packageVersion !== runPackageVersion(run)
                    ? ` · Latest package ${selectedPlaybookForUi.packageVersion}`
                    : ""}
                </div>
              ) : null}
              {run.usage ? (
                <div className="mt-1 text-xs text-muted-foreground">
                  {formatTokens(run.usage.totalTokens)} tokens
                </div>
              ) : null}
            </button>
          ))}
        </div>
      </aside>

      <section
        ref={contentScrollRef}
        data-testid="playbook-content-pane"
        className="flex min-w-0 flex-1 overflow-y-auto px-8 py-5"
      >
        {playbookCatalogLoading ? (
          <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
            Loading playbooks...
          </div>
        ) : !selectedPlaybook ? (
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
            onAssignmentPlanChange={(plan) => {
              setDraftAssignmentPlan(plan);
              setAgentsConfirmed(false);
            }}
            onStyleSelectionChange={setStyleSelection}
            formReady={formReady}
            running={running || importingPlaybook}
            savingPreference={savingPreference}
            workspaceRoot={workspaceRoot}
            capabilityInventory={capabilityInventory}
            graphReady={!!selectedGraphHash}
            styleGuideError={styleGuideError}
            styleGuideLoading={styleGuideLoading}
            styleGuideResult={styleGuideResult}
            styleSelection={styleSelection}
          />
        ) : guidedState === "preparing" ? (
          <GuidedPreparing
            run={selectedRun}
            playbook={selectedPlaybookForUi}
            selectedGraphRunSurface={selectedGraphRunSurface}
            onViewDetails={() => setShowDetails(true)}
          />
        ) : guidedState === "review" && selectedRun ? (
          <GuidedReview
            run={selectedRun}
            playbook={selectedPlaybookForUi}
            reviewEvidence={selectedReviewEvidence}
            productView={selectedGraphRunSurface?.productView ?? null}
            reviewActions={selectedGraphRunSurface?.actions ?? []}
            styleCompliance={selectedGraphRunSurface?.styleCompliance}
            workspaceRoot={workspaceRoot}
            artifactWorkspaceRoot={graphRunWorkspaceRoot(selectedGraphRunDetail)}
            onApprove={() => void resumeRun("approve")}
            onStop={() => void resumeRun("deny")}
            onAction={(action, payload) =>
              void resumeRun(action.decision === "deny" ? "deny" : "approve", action, payload)
            }
            onViewDetails={() => setShowDetails(true)}
            running={running}
          />
        ) : guidedState === "result" && selectedRun ? (
          <GuidedResult
            run={selectedRun}
            playbook={selectedPlaybookForUi}
            playbookDetail={selectedPlaybookDetail}
            graphRunDetail={selectedGraphRunDetail}
            workspaceRoot={workspaceRoot}
            artifactWorkspaceRoot={graphRunWorkspaceRoot(selectedGraphRunDetail)}
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
          graphRuns={graphRuns}
          selectedGraphRun={selectedGraphRunDetail}
          selectedGraphRunSurface={selectedGraphRunSurface}
          graphRunError={graphRunError}
          onSelectGraphRun={setSelectedGraphRunId}
          onResumeGraphRun={(action, payload) => void resumeGraphRun(action, payload)}
          onPreviewGraphRunGitMilestone={previewGraphRunGitMilestone}
          onClose={() => setShowDetails(false)}
        />
      ) : null}
    </main>
  );
}
