import { stat } from "node:fs/promises";
import type {
  EffectExecutionRecord,
  PlaybookGraphArtifactVersion,
  PlaybookGraphBranchItem,
  PlaybookGraphNode,
  PlaybookGraphOperationRecord,
  PlaybookGraphQueueEntry,
  PlaybookGraphReviewEvent,
  PlaybookGraphRunListFilter,
  PlaybookGraphRunRecord,
} from "@tessera/contracts";
import {
  type PlaybookRunDiagnosticsInput,
  type PlaybookRunDiagnosticsIssue,
  type PlaybookRunDiagnosticsResult,
  createWorkspaceGuard,
  parsePinnedCompiledGraph,
} from "@tessera/core";
import {
  materializationFormatFromPath,
  renderGraphArtifactWritePath,
} from "./connectors/workspace-materialization.js";

export interface PlaybookRunDiagnosticsStore {
  getRun(runId: string): Promise<PlaybookGraphRunRecord | undefined>;
  listRuns(filter?: PlaybookGraphRunListFilter): Promise<PlaybookGraphRunRecord[]>;
  getQueue(runId: string): Promise<PlaybookGraphQueueEntry[]>;
  listArtifactVersions(runId: string): Promise<PlaybookGraphArtifactVersion[]>;
  listBranchItems(runId: string): Promise<PlaybookGraphBranchItem[]>;
  listReviewEvents(runId: string): Promise<PlaybookGraphReviewEvent[]>;
  listEffectExecutionRecords(runId: string): Promise<EffectExecutionRecord[]>;
  listOperationRecords(runId: string): Promise<PlaybookGraphOperationRecord[]>;
}

const DEFAULT_MAX_RUNS = 10;
const DEFAULT_MAX_ARTIFACTS = 12;
const MAX_RECENT_RUNS = 30;
const MAX_TEXT_FIELDS_PER_ARTIFACT = 8;
const MAX_PREVIEW_CHARS = 320;
const SMALL_OUTPUT_BYTES = 80;
const MATERIAL_ARTIFACT_CHARS = 200;

type DiagnosticDetail = {
  run: PlaybookGraphRunRecord;
  queue: PlaybookGraphQueueEntry[];
  artifacts: PlaybookGraphArtifactVersion[];
  branchItems: PlaybookGraphBranchItem[];
  reviews: PlaybookGraphReviewEvent[];
  effects: EffectExecutionRecord[];
  operations: PlaybookGraphOperationRecord[];
};

type TextField = { path: string; chars: number; preview?: string };

function trimString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function positiveInteger(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function normalizeWorkspacePath(path: string | undefined): string | undefined {
  const trimmed = trimString(path);
  if (!trimmed) return undefined;
  const normalized = trimmed
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/g, "");
  return normalized || undefined;
}

function leafName(path: string): string | undefined {
  return path.split("/").filter(Boolean).at(-1);
}

function runWorkspaceRoot(run: PlaybookGraphRunRecord): string | undefined {
  return run.materialization?.kind === "workspace" ? run.materialization.workspaceRoot : undefined;
}

function runMatchesScope(
  run: PlaybookGraphRunRecord,
  scope: { ownerUserKey?: string | undefined; workspaceRoot?: string | undefined }
): boolean {
  if (scope.ownerUserKey && run.ownerUserKey && run.ownerUserKey !== scope.ownerUserKey) {
    return false;
  }
  const storedWorkspaceRoot = runWorkspaceRoot(run);
  if (scope.workspaceRoot && storedWorkspaceRoot && storedWorkspaceRoot !== scope.workspaceRoot) {
    return false;
  }
  return true;
}

function uniqueRuns(runs: PlaybookGraphRunRecord[]): PlaybookGraphRunRecord[] {
  const byId = new Map<string, PlaybookGraphRunRecord>();
  for (const run of runs) {
    byId.set(run.runId, run);
  }
  return [...byId.values()].sort(
    (left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) || right.runId.localeCompare(left.runId)
  );
}

async function playbookIdsFromPackagePath(input: {
  packagePath?: string | undefined;
  workspaceRoot?: string | undefined;
}): Promise<string[]> {
  const packagePath = normalizeWorkspacePath(input.packagePath);
  if (!packagePath) return [];

  const ids = new Set<string>();
  const leaf = leafName(packagePath);
  if (leaf) {
    ids.add(leaf);
    ids.add(leaf.replaceAll("-", "."));
    ids.add(leaf.replaceAll(".", "-"));
  }

  if (input.workspaceRoot) {
    try {
      const guard = await createWorkspaceGuard(input.workspaceRoot);
      const manifestPath = await guard.resolveInsideWorkspace(`${packagePath}/manifest.json`);
      const raw = await Bun.file(manifestPath).text();
      const manifest = JSON.parse(raw) as { id?: unknown };
      if (typeof manifest.id === "string" && manifest.id.trim()) {
        ids.add(manifest.id.trim());
      }
    } catch {
      // Diagnostics should still work from recent runs even when the package path is stale.
    }
  }

  return [...ids];
}

async function listScopedRuns(input: {
  store: PlaybookRunDiagnosticsStore;
  ownerUserKey?: string | undefined;
  workspaceRoot?: string | undefined;
  playbookId?: string | undefined;
  limit: number;
}): Promise<PlaybookGraphRunRecord[]> {
  const filter: PlaybookGraphRunListFilter = {
    limit: input.limit,
    ...(input.ownerUserKey ? { ownerUserKey: input.ownerUserKey } : {}),
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
    ...(input.playbookId ? { playbookId: input.playbookId } : {}),
  };
  return input.store.listRuns(filter);
}

async function selectRuns(input: {
  request: PlaybookRunDiagnosticsInput;
  store: PlaybookRunDiagnosticsStore;
  ownerUserKey?: string | undefined;
  workspaceRoot?: string | undefined;
}): Promise<{ selectedRun?: PlaybookGraphRunRecord; recentRuns: PlaybookGraphRunRecord[] }> {
  const maxRuns = positiveInteger(input.request.maxRuns, DEFAULT_MAX_RUNS, MAX_RECENT_RUNS);
  const runId = trimString(input.request.runId);
  const playbookId = trimString(input.request.playbookId);
  const packageIds = await playbookIdsFromPackagePath({
    packagePath: input.request.packagePath,
    workspaceRoot: input.workspaceRoot,
  });
  const targetIds = [...new Set([playbookId, ...packageIds].filter(Boolean) as string[])];

  const recentRuns = await listScopedRuns({
    store: input.store,
    ownerUserKey: input.ownerUserKey,
    workspaceRoot: input.workspaceRoot,
    limit: maxRuns,
  });

  if (runId) {
    const run = await input.store.getRun(runId);
    const scopedRun =
      run &&
      runMatchesScope(run, { ownerUserKey: input.ownerUserKey, workspaceRoot: input.workspaceRoot })
        ? run
        : undefined;
    return {
      ...(scopedRun ? { selectedRun: scopedRun } : {}),
      recentRuns: uniqueRuns([...(scopedRun ? [scopedRun] : []), ...recentRuns]).slice(0, maxRuns),
    };
  }

  if (targetIds.length > 0) {
    const candidates: PlaybookGraphRunRecord[] = [];
    for (const id of targetIds) {
      candidates.push(
        ...(await listScopedRuns({
          store: input.store,
          ownerUserKey: input.ownerUserKey,
          workspaceRoot: input.workspaceRoot,
          playbookId: id,
          limit: maxRuns,
        }))
      );
    }
    const sorted = uniqueRuns(candidates);
    return {
      ...(sorted[0] ? { selectedRun: sorted[0] } : {}),
      recentRuns: uniqueRuns([...sorted, ...recentRuns]).slice(0, maxRuns),
    };
  }

  return {
    ...(recentRuns[0] ? { selectedRun: recentRuns[0] } : {}),
    recentRuns: recentRuns.slice(0, maxRuns),
  };
}

function truncate(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= MAX_PREVIEW_CHARS) return compact;
  return `${compact.slice(0, MAX_PREVIEW_CHARS - 1)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectTextFields(
  value: unknown,
  options: { includePreviews: boolean; path?: string; depth?: number } = { includePreviews: false }
): TextField[] {
  const path = options.path ?? "$";
  const depth = options.depth ?? 0;
  if (typeof value === "string" && value.trim()) {
    return [
      {
        path,
        chars: value.length,
        ...(options.includePreviews ? { preview: truncate(value) } : {}),
      },
    ];
  }
  if (depth >= 4) return [];
  if (Array.isArray(value)) {
    return value.slice(0, 10).flatMap((item, index) =>
      collectTextFields(item, {
        includePreviews: options.includePreviews,
        path: `${path}[${index}]`,
        depth: depth + 1,
      })
    );
  }
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    collectTextFields(child, {
      includePreviews: options.includePreviews,
      path: path === "$" ? key : `${path}.${key}`,
      depth: depth + 1,
    })
  );
}

function longestTextField(value: unknown): TextField | undefined {
  return collectTextFields(value, { includePreviews: false }).sort(
    (left, right) => right.chars - left.chars
  )[0];
}

function valueKind(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function countByStatus(entries: Array<{ status: string }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  }
  return counts;
}

function artifactKey(runId: string, artifactId: string, versionId: string): string {
  return `${runId}\u0000${artifactId}\u0000${versionId}`;
}

function artifactByRef(
  artifactsByRef: Map<string, PlaybookGraphArtifactVersion>,
  runId: string,
  ref: { artifactId: string; versionId: string }
): PlaybookGraphArtifactVersion | undefined {
  return artifactsByRef.get(artifactKey(runId, ref.artifactId, ref.versionId));
}

function consumedArtifactChars(input: {
  artifactsByRef: Map<string, PlaybookGraphArtifactVersion>;
  queueEntry?: PlaybookGraphQueueEntry | undefined;
  runId: string;
}): { artifactId?: string; chars?: number } {
  const fields = (input.queueEntry?.consumesArtifacts ?? [])
    .map((ref) => {
      const artifact = artifactByRef(input.artifactsByRef, input.runId, ref);
      const text = artifact ? longestTextField(artifact.value) : undefined;
      return {
        artifactId: ref.artifactId,
        chars: text?.chars ?? 0,
      };
    })
    .sort((left, right) => right.chars - left.chars);
  const first = fields[0];
  return first && first.chars > 0 ? first : {};
}

function summarizeRun(
  run: PlaybookGraphRunRecord
): PlaybookRunDiagnosticsResult["recentRuns"][number] {
  const workspaceRoot = runWorkspaceRoot(run);
  return {
    runId: run.runId,
    playbookId: run.playbookId,
    status: run.status,
    ...(workspaceRoot ? { workspaceRoot } : {}),
    updatedAt: run.updatedAt,
  };
}

async function readWorkspaceFileBytes(input: {
  workspaceRoot?: string | undefined;
  path?: string | undefined;
}): Promise<number | undefined> {
  if (!input.workspaceRoot || !input.path) return undefined;
  try {
    const guard = await createWorkspaceGuard(input.workspaceRoot);
    const absolute = await guard.resolveInsideWorkspace(input.path);
    return (await stat(absolute)).size;
  } catch {
    return undefined;
  }
}

function flattenNodes(nodes: PlaybookGraphNode[]): PlaybookGraphNode[] {
  return nodes.flatMap((node) =>
    node.kind === "parallelMap" ? [node, ...flattenNodes(node.branch.nodes)] : [node]
  );
}

function findGraphNodeByPath(
  nodes: PlaybookGraphNode[],
  nodePath: string
): PlaybookGraphNode | undefined {
  const nodeId = nodePath.split("/").at(-1);
  if (!nodeId) return undefined;
  return flattenNodes(nodes).find((node) => node.id === nodeId);
}

function sourceCollectionIssues(input: {
  nodes: PlaybookGraphNode[];
  artifactTextFields: TextField[];
  capabilities: string[];
}): PlaybookRunDiagnosticsIssue[] {
  const mailDeclared = input.capabilities.some((capability) =>
    /(^|[.:_-])mail($|[.:_-])/i.test(capability)
  );
  const mailToolPresent = input.nodes.some(
    (node) => node.kind === "tool" && /mail/i.test(node.capability)
  );
  const text = input.artifactTextFields
    .map((field) => field.preview ?? "")
    .join("\n")
    .toLowerCase();
  const draftReportedMissingSource =
    /\b(no|not|without)\b.{0,40}\b(source|email|mail|message|messages)\b/.test(text) ||
    /\b(source|email|mail|message|messages)\b.{0,40}\b(unavailable|empty|missing|not found)\b/.test(
      text
    );

  const issues: PlaybookRunDiagnosticsIssue[] = [];
  if (mailDeclared && !mailToolPresent) {
    issues.push({
      code: "playbook.missing_mail_tool_node",
      severity: "error",
      message:
        "The graph declares a mail capability but has no executable mail tool node, so the agent draft is not forced to read email before writing output.",
      evidence: [`capabilities=${input.capabilities.join(", ") || "(none)"}`],
      suggestedFix:
        "Add a tool node using integration.mail.messages.read that produces a raw mail artifact, and make the draft node consume that artifact.",
    });
  }
  if (draftReportedMissingSource) {
    issues.push({
      code: "artifact.source_unavailable",
      severity: mailToolPresent ? "warning" : "error",
      message: "A produced artifact appears to report missing or unavailable source material.",
      suggestedFix: mailToolPresent
        ? "Inspect the source tool query, filters, and capability result shape before changing the draft prompt."
        : "Add an executable source collection node instead of relying on prompt-only instructions.",
    });
  }
  return issues;
}

async function workspaceOutputRecords(input: {
  detail: DiagnosticDetail;
  nodes: PlaybookGraphNode[];
  artifactsByRef: Map<string, PlaybookGraphArtifactVersion>;
  queueById: Map<string, PlaybookGraphQueueEntry>;
}): Promise<PlaybookRunDiagnosticsResult["workspaceOutputSummary"]["records"]> {
  const runWorkspace = runWorkspaceRoot(input.detail.run);
  const effectRecords = input.detail.effects
    .filter((record) => record.output?.kind === "workspace")
    .map((record) => {
      const output = record.output?.kind === "workspace" ? record.output : undefined;
      const consumed = consumedArtifactChars({
        artifactsByRef: input.artifactsByRef,
        queueEntry: input.queueById.get(record.queueEntryId),
        runId: input.detail.run.runId,
      });
      return {
        nodePath: record.nodePath,
        nodeKind: "effect" as const,
        ...(output?.path ? { path: output.path } : {}),
        ...(output?.format ? { format: output.format } : {}),
        ...(typeof output?.bytes === "number" ? { bytes: output.bytes } : {}),
        ...(consumed.artifactId ? { artifactId: consumed.artifactId } : {}),
        ...(typeof consumed.chars === "number" ? { artifactChars: consumed.chars } : {}),
        status: record.status,
      };
    });

  const artifactWriteRecords = await Promise.all(
    input.detail.queue
      .filter((entry) => entry.nodeKind === "artifactWrite")
      .map(async (entry) => {
        const node = findGraphNodeByPath(input.nodes, entry.nodePath);
        const artifactWriteNode = node?.kind === "artifactWrite" ? node : undefined;
        const path = artifactWriteNode
          ? renderGraphArtifactWritePath(artifactWriteNode.path, input.detail.run.input)
          : undefined;
        const artifactRef =
          entry.consumesArtifacts.find((ref) => ref.artifactId === artifactWriteNode?.artifact) ??
          entry.consumesArtifacts[0];
        const artifact =
          artifactRef && artifactByRef(input.artifactsByRef, input.detail.run.runId, artifactRef);
        const text = artifact ? longestTextField(artifact.value) : undefined;
        const bytes = await readWorkspaceFileBytes({ workspaceRoot: runWorkspace, path });
        return {
          nodePath: entry.nodePath,
          nodeKind: "artifactWrite" as const,
          ...(path ? { path } : {}),
          ...(path ? { format: materializationFormatFromPath(path) } : {}),
          ...(typeof bytes === "number" ? { bytes } : {}),
          ...(artifactRef?.artifactId ? { artifactId: artifactRef.artifactId } : {}),
          ...(typeof text?.chars === "number" ? { artifactChars: text.chars } : {}),
          status: entry.status,
        };
      })
  );

  return [...effectRecords, ...artifactWriteRecords];
}

function outputIssues(
  records: PlaybookRunDiagnosticsResult["workspaceOutputSummary"]["records"]
): PlaybookRunDiagnosticsIssue[] {
  const issues: PlaybookRunDiagnosticsIssue[] = [];
  for (const record of records) {
    if (
      record.status === "succeeded" &&
      record.bytes === undefined &&
      record.nodeKind === "artifactWrite"
    ) {
      issues.push({
        code: "workspace_output.missing_file",
        severity: "error",
        message: `Artifact write ${record.nodePath} succeeded but the expected workspace output file was not found.`,
        ...(record.path ? { evidence: [`path=${record.path}`] } : {}),
        suggestedFix:
          "Check the artifactWrite path template and rerun after validating the package output path.",
      });
    }
    if (
      typeof record.bytes === "number" &&
      typeof record.artifactChars === "number" &&
      record.bytes <= SMALL_OUTPUT_BYTES &&
      record.artifactChars >= MATERIAL_ARTIFACT_CHARS
    ) {
      issues.push({
        code: "workspace_output.blank_or_truncated",
        severity: "error",
        message: `Workspace output ${record.path ?? record.nodePath} is tiny compared with the source artifact.`,
        evidence: [
          `outputBytes=${record.bytes}`,
          `artifactChars=${record.artifactChars}`,
          ...(record.artifactId ? [`artifactId=${record.artifactId}`] : []),
        ],
        suggestedFix:
          "Inspect workspace materialization or artifactWrite formatting and ensure the write node uses the markdown/content field, not only the title.",
      });
    }
  }
  return issues;
}

function runAndQueueIssues(detail: DiagnosticDetail): PlaybookRunDiagnosticsIssue[] {
  const issues: PlaybookRunDiagnosticsIssue[] = [];
  if (
    ["failed", "blocked", "needs_attention", "needs_repair", "interrupted"].includes(
      detail.run.status
    )
  ) {
    issues.push({
      code: `run.${detail.run.status}`,
      severity: detail.run.status === "interrupted" ? "warning" : "error",
      message: `Run status is ${detail.run.status}.`,
      evidence: [detail.run.error, detail.run.blockedReason, detail.run.repairReason].filter(
        (value): value is string => typeof value === "string" && value.length > 0
      ),
      suggestedFix:
        detail.run.status === "needs_repair"
          ? "Open the package graph and repair the validator/runtime error before rerunning."
          : "Inspect failed or blocked queue entries and repair the smallest package node, prompt, schema, or connector mismatch.",
    });
  }

  for (const entry of detail.queue) {
    if (!["failed", "blocked", "needs_attention", "interrupted"].includes(entry.status)) continue;
    const suggestedFix =
      entry.nodeKind === "tool"
        ? "Check the tool capability, adapter availability, and the node's args."
        : entry.nodeKind === "agent"
          ? "Check the prompt, input artifact bindings, and output schema."
          : undefined;
    issues.push({
      code: `queue.${entry.status}`,
      severity: entry.status === "interrupted" ? "warning" : "error",
      message: `${entry.nodeKind} node ${entry.nodePath} is ${entry.status}.`,
      evidence: [entry.error, entry.blockedReason, entry.attentionEvidence?.reason].filter(
        (value): value is string => typeof value === "string" && value.length > 0
      ),
      ...(suggestedFix ? { suggestedFix } : {}),
    });
  }

  if (detail.run.status === "completed" && detail.artifacts.length === 0) {
    issues.push({
      code: "run.completed_without_artifacts",
      severity: "warning",
      message: "Run completed without producing any artifact versions.",
      suggestedFix:
        "Check whether the graph has only join/effect nodes or missing outputArtifact declarations.",
    });
  }
  return issues;
}

function buildNextActions(issues: PlaybookRunDiagnosticsIssue[]): string[] {
  if (issues.length === 0) {
    return [
      "If the user still sees incorrect output, inspect package prompts, schemas, and workspace file contents for domain-specific mistakes.",
    ];
  }
  const actions = new Set<string>();
  for (const issue of issues) {
    if (issue.suggestedFix) actions.add(issue.suggestedFix);
  }
  actions.add(
    "After editing the playbook package, run playbook_package_validate for the package path."
  );
  return [...actions];
}

function uniqueIssues(issues: PlaybookRunDiagnosticsIssue[]): PlaybookRunDiagnosticsIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.code}\u0000${issue.message}\u0000${issue.evidence?.join("\u0000") ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function readDetail(
  store: PlaybookRunDiagnosticsStore,
  run: PlaybookGraphRunRecord
): Promise<DiagnosticDetail> {
  const [queue, artifacts, branchItems, reviews, effects, operations] = await Promise.all([
    store.getQueue(run.runId),
    store.listArtifactVersions(run.runId),
    store.listBranchItems(run.runId),
    store.listReviewEvents(run.runId),
    store.listEffectExecutionRecords(run.runId),
    store.listOperationRecords(run.runId),
  ]);
  return { run, queue, artifacts, branchItems, reviews, effects, operations };
}

export async function diagnosePlaybookRun(input: {
  request: PlaybookRunDiagnosticsInput;
  store: PlaybookRunDiagnosticsStore;
  ownerUserKey?: string | undefined;
  workspaceRoot?: string | undefined;
}): Promise<PlaybookRunDiagnosticsResult> {
  const request: PlaybookRunDiagnosticsInput = {};
  const runId = trimString(input.request.runId);
  const playbookId = trimString(input.request.playbookId);
  const packagePath = normalizeWorkspacePath(input.request.packagePath);
  if (runId) request.runId = runId;
  if (playbookId) request.playbookId = playbookId;
  if (packagePath) request.packagePath = packagePath;
  if (typeof input.request.includeArtifactPreviews === "boolean") {
    request.includeArtifactPreviews = input.request.includeArtifactPreviews;
  }
  if (typeof input.request.maxArtifacts === "number") {
    request.maxArtifacts = input.request.maxArtifacts;
  }
  if (typeof input.request.maxRuns === "number") {
    request.maxRuns = input.request.maxRuns;
  }
  const selected = await selectRuns({
    request,
    store: input.store,
    ownerUserKey: input.ownerUserKey,
    workspaceRoot: input.workspaceRoot,
  });

  if (!selected.selectedRun) {
    return {
      ok: false,
      request,
      recentRuns: selected.recentRuns.map(summarizeRun),
      queueSummary: { total: 0, byStatus: {}, entries: [] },
      artifactSummary: { total: 0, previews: [] },
      effectSummary: { total: 0, records: [] },
      workspaceOutputSummary: { total: 0, records: [] },
      reviewSummary: { total: 0, records: [] },
      operationSummary: { total: 0, records: [] },
      issues: [
        {
          code: "run.not_found",
          severity: "warning",
          message: "No playbook run matched the provided run id, playbook id, or package path.",
          suggestedFix:
            "Ask for the run id from the Playbooks view, or run the playbook once and retry diagnostics.",
        },
      ],
      nextActions: [
        "Ask for the run id or rerun the target playbook, then call diagnostics again.",
      ],
    };
  }

  const detail = await readDetail(input.store, selected.selectedRun);
  const maxArtifacts = positiveInteger(request.maxArtifacts, DEFAULT_MAX_ARTIFACTS, 50);
  const includePreviews = request.includeArtifactPreviews === true;
  const artifactPreviews = detail.artifacts.slice(0, maxArtifacts).map((artifact) => ({
    artifactId: artifact.artifactId,
    versionId: artifact.versionId,
    nodePath: artifact.nodePath,
    producerQueueEntryId: artifact.producerQueueEntryId,
    createdAt: artifact.createdAt,
    valueKind: valueKind(artifact.value),
    textFields: collectTextFields(artifact.value, { includePreviews }).slice(
      0,
      MAX_TEXT_FIELDS_PER_ARTIFACT
    ),
  }));
  const artifactTextFields = detail.artifacts.flatMap((artifact) =>
    collectTextFields(artifact.value, { includePreviews: true })
  );
  const artifactsByRef = new Map(
    detail.artifacts.map((artifact) => [
      artifactKey(artifact.runId, artifact.artifactId, artifact.versionId),
      artifact,
    ])
  );
  const queueById = new Map(detail.queue.map((entry) => [entry.queueEntryId, entry]));
  let nodes: PlaybookGraphNode[] = [];
  let capabilities: string[] = [];
  const snapshotIssues: PlaybookRunDiagnosticsIssue[] = [];
  try {
    const compiled = parsePinnedCompiledGraph(detail.run.snapshot);
    nodes = flattenNodes(compiled.graph.nodes);
    capabilities = compiled.graph.capabilities ?? [];
  } catch (error) {
    snapshotIssues.push({
      code: "snapshot.invalid",
      severity: "error",
      message: "The pinned compiled graph snapshot could not be parsed.",
      evidence: [error instanceof Error ? error.message : String(error)],
      suggestedFix:
        "Repair or re-import the playbook package so the run snapshot pins a valid compiled graph.",
    });
  }
  const outputs = await workspaceOutputRecords({
    detail,
    nodes,
    artifactsByRef,
    queueById,
  });
  const issues = uniqueIssues([
    ...snapshotIssues,
    ...runAndQueueIssues(detail),
    ...sourceCollectionIssues({ nodes, artifactTextFields, capabilities }),
    ...outputIssues(outputs),
  ]);

  const selectedWorkspaceRoot = runWorkspaceRoot(detail.run);
  return {
    ok: true,
    request,
    selectedRun: {
      runId: detail.run.runId,
      playbookId: detail.run.playbookId,
      packageVersion: detail.run.snapshot.packageVersion,
      status: detail.run.status,
      ...(selectedWorkspaceRoot ? { workspaceRoot: selectedWorkspaceRoot } : {}),
      startedAt: detail.run.startedAt,
      updatedAt: detail.run.updatedAt,
      ...(detail.run.completedAt ? { completedAt: detail.run.completedAt } : {}),
      ...(detail.run.currentQueueEntryId
        ? { currentQueueEntryId: detail.run.currentQueueEntryId }
        : {}),
      ...(detail.run.blockedReason ? { blockedReason: detail.run.blockedReason } : {}),
      ...(detail.run.repairReason ? { repairReason: detail.run.repairReason } : {}),
      ...(detail.run.error ? { error: detail.run.error } : {}),
    },
    recentRuns: selected.recentRuns.map(summarizeRun),
    queueSummary: {
      total: detail.queue.length,
      byStatus: countByStatus(detail.queue),
      entries: detail.queue.map((entry) => ({
        queueEntryId: entry.queueEntryId,
        nodeId: entry.nodeId,
        nodePath: entry.nodePath,
        nodeKind: entry.nodeKind,
        status: entry.status,
        producesArtifacts: entry.producesArtifacts,
        consumesArtifacts: entry.consumesArtifacts.map((artifact) => artifact.artifactId),
        ...(entry.blockedReason ? { blockedReason: entry.blockedReason } : {}),
        ...(entry.error ? { error: entry.error } : {}),
      })),
    },
    artifactSummary: {
      total: detail.artifacts.length,
      previews: artifactPreviews,
    },
    effectSummary: {
      total: detail.effects.length,
      records: detail.effects.map((record) => ({
        effectExecutionRecordId: record.effectExecutionRecordId,
        queueEntryId: record.queueEntryId,
        nodePath: record.nodePath,
        capability: record.capability,
        status: record.status,
        ...(record.commitStatus ? { commitStatus: record.commitStatus } : {}),
        ...(record.outputReference ? { outputReference: record.outputReference } : {}),
        ...(record.output ? { output: record.output } : {}),
        ...(record.error ? { error: record.error } : {}),
      })),
    },
    workspaceOutputSummary: {
      total: outputs.length,
      records: outputs,
    },
    reviewSummary: {
      total: detail.reviews.length,
      records: detail.reviews.map((review) => ({
        reviewEventId: review.reviewEventId,
        queueEntryId: review.queueEntryId,
        nodePath: review.nodePath,
        artifactId: review.artifactId,
        decision: review.decision,
        createdAt: review.createdAt,
      })),
    },
    operationSummary: {
      total: detail.operations.length,
      records: detail.operations.map((operation) => ({
        operationRecordId: operation.operationRecordId,
        kind: operation.kind,
        status: operation.status,
        operatorIntent: operation.operatorIntent,
        ...(operation.redactedPayloadSummary
          ? { redactedPayloadSummary: operation.redactedPayloadSummary }
          : {}),
        ...(operation.failureReason ? { failureReason: operation.failureReason } : {}),
        createdAt: operation.createdAt,
      })),
    },
    issues,
    nextActions: buildNextActions(issues),
  };
}
