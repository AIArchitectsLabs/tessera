import { createHash, randomUUID } from "node:crypto";
import type {
  CompiledPlaybookGraph,
  PlaybookGraphArtifactVersion,
  PlaybookGraphArtifactVersionRef,
  PlaybookGraphBranchItem,
  PlaybookGraphExecutionContext,
  PlaybookGraphMaterializationTarget,
  PlaybookGraphMemoKeyParts,
  PlaybookGraphNode,
  PlaybookGraphNodeMemo,
  PlaybookGraphOperationRecord,
  PlaybookGraphQueueEntry,
  PlaybookGraphReviewEvent,
  PlaybookGraphRunListFilter,
  PlaybookGraphRunRecord,
  PlaybookGraphSnapshot,
} from "@tessera/contracts";
import {
  CompiledPlaybookGraphSchema,
  PlaybookGraphBranchItemSchema,
  PlaybookGraphExecutionContextSchema,
  PlaybookGraphQueueEntrySchema,
  PlaybookGraphRunRecordSchema,
} from "@tessera/contracts";
import { hashPlaybookSourceFiles, stableJsonStringify } from "./playbook-graph.js";

const TERMINAL_SUCCESS_QUEUE_STATUSES = new Set(["succeeded", "memoized", "skipped"]);
const TERMINAL_GRAPH_TARGETS = new Set(["completed", "failed", "denied"]);
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "denied", "needs_repair"]);

export interface GraphRunStaleLeaseRecoveryResult {
  inspected: number;
  autoRequeued: number;
  needsAttention: number;
  interrupted: number;
}

export interface GraphRunStore {
  createRun(run: PlaybookGraphRunRecord): Promise<void>;
  createRunWithQueue(input: {
    run: PlaybookGraphRunRecord;
    queueEntries: PlaybookGraphQueueEntry[];
  }): Promise<void>;
  getRun(runId: string): Promise<PlaybookGraphRunRecord | undefined>;
  updateRun(run: PlaybookGraphRunRecord): Promise<void>;
  listRuns(filter?: PlaybookGraphRunListFilter): Promise<PlaybookGraphRunRecord[]>;

  getQueue(runId: string): Promise<PlaybookGraphQueueEntry[]>;
  upsertQueueEntry(entry: PlaybookGraphQueueEntry): Promise<void>;
  updateQueueEntry(entry: PlaybookGraphQueueEntry): Promise<void>;
  claimNextQueuedEntry(input: {
    runId: string;
    runtimeId: string;
    leaseId: string;
    leaseExpiresAt: string;
    now: string;
  }): Promise<PlaybookGraphQueueEntry | undefined>;
  renewQueueLease(input: {
    runId: string;
    queueEntryId: string;
    runtimeId: string;
    leaseId: string;
    leaseExpiresAt: string;
    now: string;
  }): Promise<boolean>;
  releaseQueueLease(input: {
    runId: string;
    queueEntryId: string;
    runtimeId: string;
    leaseId: string;
    now: string;
  }): Promise<boolean>;

  listArtifactVersions(runId: string): Promise<PlaybookGraphArtifactVersion[]>;
  addArtifactVersion(version: PlaybookGraphArtifactVersion): Promise<void>;
  getArtifactVersion(
    runId: string,
    artifactId: string,
    versionId: string
  ): Promise<PlaybookGraphArtifactVersion | undefined>;

  listBranchItems(runId: string): Promise<PlaybookGraphBranchItem[]>;
  upsertBranchItem(item: PlaybookGraphBranchItem): Promise<void>;

  listReviewEvents(runId: string): Promise<PlaybookGraphReviewEvent[]>;
  addReviewEvent(event: PlaybookGraphReviewEvent): Promise<void>;
  listOperationRecords(runId: string): Promise<PlaybookGraphOperationRecord[]>;
  addOperationRecord(record: PlaybookGraphOperationRecord): Promise<void>;
  applyGraphMutationWithOperationRecord(input: {
    run?: PlaybookGraphRunRecord;
    queueEntries?: PlaybookGraphQueueEntry[];
    branchItems?: PlaybookGraphBranchItem[];
    artifactVersions?: PlaybookGraphArtifactVersion[];
    reviewEvents?: PlaybookGraphReviewEvent[];
    operationRecord: PlaybookGraphOperationRecord;
  }): Promise<void>;

  getMemo(runId: string, nodeMemoKey: string): Promise<PlaybookGraphNodeMemo | undefined>;
  putMemo(memo: PlaybookGraphNodeMemo): Promise<void>;

  markStaleQueueLeasesInterrupted(input: {
    runId: string;
    runtimeId: string;
    now: string;
    interruptedAt: string;
  }): Promise<number>;
  recoverStaleQueueLeases(input: {
    runId: string;
    runtimeId: string;
    now: string;
  }): Promise<GraphRunStaleLeaseRecoveryResult>;

  checkpointNodeSuccess(input: {
    run: PlaybookGraphRunRecord;
    queueEntry: PlaybookGraphQueueEntry;
    queueEntries?: PlaybookGraphQueueEntry[];
    branchItems?: PlaybookGraphBranchItem[];
    memo?: PlaybookGraphNodeMemo;
    artifactVersions?: PlaybookGraphArtifactVersion[];
  }): Promise<void>;
  checkpointNodeFailure(input: {
    run: PlaybookGraphRunRecord;
    queueEntry: PlaybookGraphQueueEntry;
  }): Promise<void>;
}

export interface CreatePlaybookGraphRunOptions {
  compiledGraph: CompiledPlaybookGraph;
  sourceFiles?: Record<string, string>;
  input?: Record<string, unknown>;
  materialization?: PlaybookGraphMaterializationTarget;
  executionContext?: unknown;
  now?: string;
  runId?: string;
  store: GraphRunStore;
}

export interface PlaybookGraphScriptAdapterInput {
  run: PlaybookGraphRunRecord;
  node: Extract<PlaybookGraphNode, { kind: "script" }>;
  queueEntry: PlaybookGraphQueueEntry;
  input: Record<string, unknown>;
  artifacts: Record<string, unknown>;
  branchItem?: PlaybookGraphBranchItem;
}

export interface PlaybookGraphAgentAdapterInput {
  run: PlaybookGraphRunRecord;
  node: Extract<PlaybookGraphNode, { kind: "agent" }>;
  queueEntry: PlaybookGraphQueueEntry;
  input: Record<string, unknown>;
  artifacts: Record<string, unknown>;
  prompt?: string;
  branchItem?: PlaybookGraphBranchItem;
}

export interface PlaybookGraphToolAdapterInput {
  run: PlaybookGraphRunRecord;
  node: Extract<PlaybookGraphNode, { kind: "tool" }>;
  queueEntry: PlaybookGraphQueueEntry;
  input: Record<string, unknown>;
  artifacts: Record<string, unknown>;
  branchItem?: PlaybookGraphBranchItem;
}

export interface PlaybookGraphArtifactWriteAdapterInput {
  run: PlaybookGraphRunRecord;
  node: Extract<PlaybookGraphNode, { kind: "artifactWrite" }>;
  queueEntry: PlaybookGraphQueueEntry;
  artifactVersion: PlaybookGraphArtifactVersion;
  value: unknown;
}

export interface PlaybookGraphToolExecutionPolicy {
  capability: string;
  idempotent: boolean;
  sideEffect: "read" | "write" | "external";
}

export interface PlaybookGraphRuntimeOptions {
  runId: string;
  runtimeId: string;
  store: GraphRunStore;
  now?: () => string;
  leaseMs?: number;
  leaseRenewalMs?: number;
  maxSteps?: number;
  executionContext?: unknown;
  blockOnMissingAdapters?: boolean;
  scriptAdapter?: (input: PlaybookGraphScriptAdapterInput) => Promise<unknown> | unknown;
  agentAdapter?: (input: PlaybookGraphAgentAdapterInput) => Promise<unknown> | unknown;
  toolAdapter?: (input: PlaybookGraphToolAdapterInput) => Promise<unknown> | unknown;
  toolPolicies?: Record<string, PlaybookGraphToolExecutionPolicy>;
  toolCapabilities?: string[];
  artifactWriteAdapter?: (
    input: PlaybookGraphArtifactWriteAdapterInput
  ) => Promise<unknown> | unknown;
}

export interface PlaybookGraphRuntimeResult {
  run: PlaybookGraphRunRecord;
  executed: number;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

async function withQueueLeaseRenewal<T>(
  options: PlaybookGraphRuntimeOptions,
  queueEntry: PlaybookGraphQueueEntry,
  leaseMs: number,
  now: () => string,
  work: () => Promise<T> | T
): Promise<T> {
  const leaseRenewalMs = options.leaseRenewalMs ?? 0;
  if (
    leaseRenewalMs <= 0 ||
    !queueEntry.runtimeId ||
    !queueEntry.leaseId ||
    queueEntry.status !== "running"
  ) {
    return work();
  }

  const runtimeId = queueEntry.runtimeId;
  const leaseId = queueEntry.leaseId;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    const renewedAt = now();
    void options.store
      .renewQueueLease({
        runId: queueEntry.runId,
        queueEntryId: queueEntry.queueEntryId,
        runtimeId,
        leaseId,
        leaseExpiresAt: addMs(renewedAt, leaseMs),
        now: renewedAt,
      })
      .catch(() => {
        // The final checkpoint is the authoritative stale-claim guard.
      });
  }, leaseRenewalMs);

  try {
    return await work();
  } finally {
    stopped = true;
    clearInterval(timer);
  }
}

function hashUnknown(value: unknown): string {
  return sha256(stableJsonStringify(value));
}

function normalizeExecutionContext(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function agentAdapterStatus(
  output: unknown
): "completed" | "blocked" | "denied" | "error" | undefined {
  if (!output || typeof output !== "object" || Array.isArray(output)) return undefined;
  const status = (output as { status?: unknown }).status;
  if (status === "completed" || status === "blocked" || status === "denied" || status === "error") {
    return status;
  }
  return undefined;
}

export function createPlaybookGraphExecutionContextPin(
  executionContext: unknown = {}
): PlaybookGraphExecutionContext {
  const fingerprints = normalizeExecutionContext(executionContext);
  return PlaybookGraphExecutionContextSchema.parse({
    schemaVersion: 1,
    executionContextHash: hashUnknown(fingerprints),
    fingerprints,
  });
}

export function playbookGraphExecutionContextDriftReason(
  run: PlaybookGraphRunRecord,
  executionContext: unknown | undefined
): string | undefined {
  if (
    executionContext === undefined ||
    !run.executionContext ||
    TERMINAL_RUN_STATUSES.has(run.status)
  ) {
    return undefined;
  }
  const active = createPlaybookGraphExecutionContextPin(executionContext);
  if (active.executionContextHash === run.executionContext.executionContextHash) return undefined;
  return `Graph execution context changed; expected ${run.executionContext.executionContextHash}, got ${active.executionContextHash}. Approval is required before continuing.`;
}

export function createPlaybookGraphSnapshot(input: {
  compiledGraph: CompiledPlaybookGraph;
  sourceFiles?: Record<string, string>;
}): PlaybookGraphSnapshot {
  const compiled = CompiledPlaybookGraphSchema.parse(input.compiledGraph);
  const snapshotJson = stableJsonStringify(compiled);
  const sourceFiles =
    input.sourceFiles === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(input.sourceFiles).sort(([left], [right]) => left.localeCompare(right))
        );
  const sourceFileHashes = Object.fromEntries(
    Object.entries(sourceFiles ?? {}).map(([path, content]) => [path, sha256(content)])
  );
  const sourceHash = sourceFiles
    ? hashPlaybookSourceFiles(sourceFiles)
    : compiled.metadata.sourceHash;
  if (sourceFiles && sourceHash !== compiled.metadata.sourceHash) {
    throw new Error("Graph run source files do not match compiled graph source hash");
  }

  return {
    schemaVersion: 1,
    snapshotJson,
    snapshotHash: sha256(snapshotJson),
    graphHash: compiled.metadata.graphHash,
    sourceHash,
    sourceFileHashes,
    ...(sourceFiles ? { sourceFiles } : {}),
    playbookId: compiled.metadata.playbookId,
    packageVersion: compiled.metadata.packageVersion,
    compilerVersion: compiled.metadata.compilerVersion,
    graphSchemaVersion: compiled.metadata.graphSchemaVersion,
    scriptSdkVersion: compiled.metadata.scriptSdkVersion,
    compiledAt: compiled.metadata.compiledAt,
  };
}

export function parsePinnedCompiledGraph(snapshot: PlaybookGraphSnapshot): CompiledPlaybookGraph {
  if (sha256(snapshot.snapshotJson) !== snapshot.snapshotHash) {
    throw new Error("Pinned graph snapshot hash mismatch");
  }
  const compiled = CompiledPlaybookGraphSchema.parse(JSON.parse(snapshot.snapshotJson) as unknown);
  if (compiled.metadata.graphHash !== snapshot.graphHash) {
    throw new Error("Pinned graph metadata does not match run snapshot graph hash");
  }
  return compiled;
}

export function createPlaybookGraphMemoKey(parts: PlaybookGraphMemoKeyParts): string {
  return hashUnknown(parts);
}

function outputArtifacts(node: PlaybookGraphNode): string[] {
  if ("outputArtifact" in node && typeof node.outputArtifact === "string") {
    return [node.outputArtifact];
  }
  if (node.kind === "agent" && node.output?.artifact) {
    return [node.output.artifact];
  }
  return [];
}

async function materializeDeclaredArtifacts(
  compiled: CompiledPlaybookGraph,
  options: PlaybookGraphRuntimeOptions,
  run: PlaybookGraphRunRecord,
  queueEntry: PlaybookGraphQueueEntry,
  versions: PlaybookGraphArtifactVersion[]
): Promise<void> {
  if (!options.artifactWriteAdapter || versions.length === 0) return;

  for (const artifactVersion of versions) {
    const declaration = compiled.graph.artifacts[artifactVersion.artifactId];
    if (!declaration?.materialize) continue;
    await options.artifactWriteAdapter({
      run,
      queueEntry,
      artifactVersion,
      value: artifactVersion.value,
      node: {
        id: `${queueEntry.nodeId}.${artifactVersion.artifactId}.materialize`,
        kind: "artifactWrite",
        artifact: artifactVersion.artifactId,
        path: declaration.materialize,
      },
    });
  }
}

function shouldMemoizeNode(
  node: PlaybookGraphNode,
  toolPolicy: PlaybookGraphToolExecutionPolicy | undefined
): boolean {
  if (node.kind === "humanReview" || node.kind === "parallelMap") return false;
  if (node.kind !== "tool") return true;
  return toolPolicy?.idempotent === true;
}

function collectArtifactIds(value: unknown, refs: Set<string>): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(/\{\{\s*artifacts\.([A-Za-z0-9_.:-]+)/g)) {
      const artifactId = match[1]?.split(".")[0];
      if (artifactId) refs.add(artifactId);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectArtifactIds(item, refs);
    return;
  }
  if (!value || typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  if (typeof record.artifact === "string") {
    refs.add(record.artifact);
  }
  for (const nested of Object.values(record)) {
    collectArtifactIds(nested, refs);
  }
}

function inputArtifactIds(node: PlaybookGraphNode): string[] {
  const refs = new Set<string>();
  if (node.kind === "script" || node.kind === "agent") {
    collectArtifactIds(node.inputs, refs);
  } else if (node.kind === "tool") {
    collectArtifactIds(node.args, refs);
  } else if (node.kind === "parallelMap") {
    collectArtifactIds(node.items, refs);
  } else if (node.kind === "humanReview") {
    refs.add(node.artifact);
  } else if (node.kind === "condition") {
    refs.add(node.when.artifact);
  } else if (node.kind === "artifactWrite") {
    refs.add(node.artifact);
  } else if (node.kind === "join") {
    for (const artifact of node.inputs) refs.add(artifact);
  }
  return [...refs].sort();
}

function artifactBindingState(
  declaredConsumesArtifacts: string[],
  consumesArtifacts: PlaybookGraphArtifactVersionRef[]
): PlaybookGraphQueueEntry["artifactBindingState"] {
  if (declaredConsumesArtifacts.length === 0) return "resolved";
  const resolvedIds = new Set(consumesArtifacts.map((artifact) => artifact.artifactId));
  return declaredConsumesArtifacts.every((artifactId) => resolvedIds.has(artifactId))
    ? "resolved"
    : "unresolved";
}

function latestArtifactRefsById(
  versions: PlaybookGraphArtifactVersion[]
): Map<string, PlaybookGraphArtifactVersionRef> {
  const refs = new Map<string, PlaybookGraphArtifactVersionRef>();
  for (const version of versions) {
    refs.set(version.artifactId, {
      artifactId: version.artifactId,
      versionId: version.versionId,
      contentHash: version.contentHash,
    });
  }
  return refs;
}

function findNodeInList(nodes: PlaybookGraphNode[], nodeId: string): PlaybookGraphNode | undefined {
  for (const node of nodes) {
    if (node.id === nodeId) return node;
    if (node.kind === "parallelMap") {
      const nested = findNodeInList(node.branch.nodes, nodeId);
      if (nested) return nested;
    }
  }
  return undefined;
}

function findNode(graph: CompiledPlaybookGraph["graph"], nodeId: string): PlaybookGraphNode {
  const node = findNodeInList(graph.nodes, nodeId);
  if (!node) {
    throw new Error(`Unknown graph node: ${nodeId}`);
  }
  return node;
}

function branchStartNode(
  node: Extract<PlaybookGraphNode, { kind: "parallelMap" }>
): PlaybookGraphNode {
  const startNode = node.branch.nodes.find((candidate) => candidate.id === node.branch.start);
  if (!startNode) {
    throw new Error(`Unknown parallelMap branch start node: ${node.branch.start}`);
  }
  return startNode;
}

export function childPlaybookGraphNodePath(parentNodePath: string, targetNodeId: string): string {
  return `${parentNodePath}/${targetNodeId}`;
}

function branchItemNodePath(parentNodePath: string, index: number): string {
  return `${parentNodePath}/item:${index}`;
}

function branchItemForNodePath(
  nodePath: string,
  branchItems: PlaybookGraphBranchItem[]
): PlaybookGraphBranchItem | undefined {
  return branchItems
    .filter((item) => nodePath === item.nodePath || nodePath.startsWith(`${item.nodePath}/`))
    .sort((left, right) => right.nodePath.length - left.nodePath.length)[0];
}

function branchInput(
  runInput: Record<string, unknown>,
  branchItem: PlaybookGraphBranchItem | undefined
): Record<string, unknown> {
  return branchItem ? { ...runInput, branchItem: branchItem.value } : runInput;
}

export function createPlaybookGraphQueueEntry(input: {
  runId: string;
  node: PlaybookGraphNode;
  nodePath: string;
  now: string;
  dependsOn?: string[];
  artifactVersions?: PlaybookGraphArtifactVersion[];
}): PlaybookGraphQueueEntry {
  const latestRefs = latestArtifactRefsById(input.artifactVersions ?? []);
  const declaredConsumesArtifacts = inputArtifactIds(input.node);
  const consumesArtifacts = declaredConsumesArtifacts.flatMap((artifactId) => {
    const ref = latestRefs.get(artifactId);
    return ref ? [ref] : [];
  });

  return PlaybookGraphQueueEntrySchema.parse({
    schemaVersion: 1,
    queueEntryId: `${input.runId}:${input.nodePath}`,
    runId: input.runId,
    nodeId: input.node.id,
    nodePath: input.nodePath,
    nodeKind: input.node.kind,
    status: "queued",
    dependsOn: input.dependsOn ?? [],
    producesArtifacts: outputArtifacts(input.node),
    declaredConsumesArtifacts,
    consumesArtifacts,
    artifactBindingState: artifactBindingState(declaredConsumesArtifacts, consumesArtifacts),
    recoveryPolicy:
      input.node.kind === "script" || input.node.kind === "condition" || input.node.kind === "join"
        ? "rerun_if_no_success_memo"
        : "block_for_review",
    createdAt: input.now,
    updatedAt: input.now,
  });
}

function artifactRefsEqual(
  left: PlaybookGraphArtifactVersionRef[],
  right: PlaybookGraphArtifactVersionRef[]
): boolean {
  return stableJsonStringify(left) === stableJsonStringify(right);
}

function stringArraysEqual(left: string[], right: string[]): boolean {
  return stableJsonStringify(left) === stableJsonStringify(right);
}

function refreshQueueEntryArtifactRefs(input: {
  entry: PlaybookGraphQueueEntry;
  node: PlaybookGraphNode;
  artifactVersions: PlaybookGraphArtifactVersion[];
  now: string;
}): PlaybookGraphQueueEntry {
  const fresh = createPlaybookGraphQueueEntry({
    runId: input.entry.runId,
    node: input.node,
    nodePath: input.entry.nodePath,
    dependsOn: input.entry.dependsOn,
    artifactVersions: input.artifactVersions,
    now: input.entry.createdAt,
  });
  if (
    stringArraysEqual(input.entry.declaredConsumesArtifacts, fresh.declaredConsumesArtifacts) &&
    artifactRefsEqual(input.entry.consumesArtifacts, fresh.consumesArtifacts) &&
    stringArraysEqual(input.entry.producesArtifacts, fresh.producesArtifacts) &&
    input.entry.recoveryPolicy === fresh.recoveryPolicy &&
    input.entry.artifactBindingState === fresh.artifactBindingState
  ) {
    return input.entry;
  }
  return PlaybookGraphQueueEntrySchema.parse({
    ...input.entry,
    producesArtifacts: fresh.producesArtifacts,
    declaredConsumesArtifacts: fresh.declaredConsumesArtifacts,
    consumesArtifacts: fresh.consumesArtifacts,
    artifactBindingState: fresh.artifactBindingState,
    recoveryPolicy: fresh.recoveryPolicy,
    nodeMemoKey: undefined,
    updatedAt: input.now,
  });
}

async function preserveExistingQueueDurability(input: {
  store: GraphRunStore;
  runId: string;
  entries: PlaybookGraphQueueEntry[];
}): Promise<PlaybookGraphQueueEntry[]> {
  if (input.entries.length === 0) return [];
  const existingById = new Map(
    (await input.store.getQueue(input.runId)).map((entry) => [entry.queueEntryId, entry])
  );
  return input.entries.map((entry) => {
    const existing = existingById.get(entry.queueEntryId);
    if (!existing) return entry;
    return PlaybookGraphQueueEntrySchema.parse({
      ...entry,
      createdAt: existing.createdAt,
      attempt: existing.attempt,
      nodeMemoKey: undefined,
    });
  });
}

async function refreshQueuedArtifactBindings(input: {
  store: GraphRunStore;
  compiled: CompiledPlaybookGraph;
  run: PlaybookGraphRunRecord;
  now: string;
}): Promise<number> {
  const queue = await input.store.getQueue(input.run.runId);
  const artifactVersions = activeArtifactVersions(
    await input.store.listArtifactVersions(input.run.runId),
    queue
  );
  let updated = 0;
  for (const entry of queue) {
    if (entry.status !== "queued") continue;
    const refreshed = refreshQueueEntryArtifactRefs({
      entry,
      node: findNode(input.compiled.graph, entry.nodeId),
      artifactVersions,
      now: input.now,
    });
    if (refreshed === entry) continue;
    await input.store.updateQueueEntry(refreshed);
    updated += 1;
  }
  return updated;
}

function latestArtifactValues(versions: PlaybookGraphArtifactVersion[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const version of versions) {
    values[version.artifactId] = version.value;
  }
  return values;
}

function activeArtifactVersions(
  versions: PlaybookGraphArtifactVersion[],
  queue: PlaybookGraphQueueEntry[]
): PlaybookGraphArtifactVersion[] {
  const skippedProducerIds = new Set(
    queue.filter((entry) => entry.status === "skipped").map((entry) => entry.queueEntryId)
  );
  if (skippedProducerIds.size === 0) return versions;
  return versions.filter((version) => !skippedProducerIds.has(version.producerQueueEntryId));
}

function latestArtifactVersion(
  versions: PlaybookGraphArtifactVersion[],
  artifactId: string
): PlaybookGraphArtifactVersion | undefined {
  for (const version of [...versions].reverse()) {
    if (version.artifactId === artifactId) return version;
  }
  return undefined;
}

function artifactRefs(versions: PlaybookGraphArtifactVersion[]) {
  return versions.map((version) => ({
    artifactId: version.artifactId,
    versionId: version.versionId,
    contentHash: version.contentHash,
  }));
}

function consumedArtifactVersions(
  queueEntry: PlaybookGraphQueueEntry,
  versions: PlaybookGraphArtifactVersion[]
): PlaybookGraphArtifactVersion[] {
  if (queueEntry.consumesArtifacts.length === 0) return [];
  const consumedKeys = new Set(
    queueEntry.consumesArtifacts.map((ref) => `${ref.artifactId}:${ref.versionId}`)
  );
  return versions.filter((version) =>
    consumedKeys.has(`${version.artifactId}:${version.versionId}`)
  );
}

function readJsonPath(value: unknown, path: string): unknown {
  if (path === "$") return value;
  if (!path.startsWith("$.")) return undefined;
  let cursor = value;
  for (const segment of path.slice(2).split(".")) {
    if (Array.isArray(cursor)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0) return undefined;
      cursor = cursor[index];
      continue;
    }
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function valueAtPath(value: unknown, path: string): unknown {
  return readJsonPath(value, path === "" ? "$" : `$.${path}`);
}

function templateValue(input: {
  expression: string;
  runInput: Record<string, unknown>;
  artifacts: Record<string, unknown>;
  branchItem?: PlaybookGraphBranchItem;
}): unknown {
  if (input.expression === "branchItem") return input.branchItem?.value;
  if (input.expression.startsWith("branchItem.")) {
    return valueAtPath(input.branchItem?.value, input.expression.slice("branchItem.".length));
  }
  if (input.expression === "inputs") return input.runInput;
  if (input.expression.startsWith("inputs.")) {
    return valueAtPath(input.runInput, input.expression.slice("inputs.".length));
  }
  if (input.expression === "artifacts") return input.artifacts;
  if (input.expression.startsWith("artifacts.")) {
    const [, artifactId, ...path] = input.expression.split(".");
    return valueAtPath(input.artifacts[artifactId ?? ""], path.join("."));
  }
  return undefined;
}

function resolveGraphValue(input: {
  value: unknown;
  runInput: Record<string, unknown>;
  artifacts: Record<string, unknown>;
  branchItem?: PlaybookGraphBranchItem;
}): unknown {
  if (typeof input.value === "string") {
    const exact = input.value.match(/^\{\{\s*([A-Za-z0-9_.:-]+)\s*\}\}$/);
    if (exact?.[1]) {
      return templateValue({ ...input, expression: exact[1] });
    }
    return input.value.replace(/\{\{\s*([A-Za-z0-9_.:-]+)\s*\}\}/g, (_match, expression) => {
      const resolved = templateValue({ ...input, expression });
      return resolved === undefined || resolved === null ? "" : String(resolved);
    });
  }
  if (Array.isArray(input.value)) {
    return input.value.map((value) => resolveGraphValue({ ...input, value }));
  }
  if (!input.value || typeof input.value !== "object") return input.value;

  const record = input.value as Record<string, unknown>;
  if (typeof record.artifact === "string") {
    return readJsonPath(input.artifacts[record.artifact], String(record.path ?? "$"));
  }

  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, resolveGraphValue({ ...input, value })])
  );
}

function resolveNodePayload<T extends PlaybookGraphNode>(input: {
  node: T;
  runInput: Record<string, unknown>;
  artifacts: Record<string, unknown>;
  branchItem?: PlaybookGraphBranchItem;
}): T {
  if (input.node.kind === "script") {
    return {
      ...input.node,
      inputs: resolveGraphValue({ ...input, value: input.node.inputs }) as Record<string, unknown>,
    };
  }
  if (input.node.kind === "tool") {
    return {
      ...input.node,
      args: resolveGraphValue({ ...input, value: input.node.args }) as Record<string, unknown>,
    };
  }
  if (input.node.kind === "agent") {
    return {
      ...input.node,
      inputs: resolveGraphValue({ ...input, value: input.node.inputs }) as Record<string, unknown>,
    };
  }
  return input.node;
}

function successTarget(node: PlaybookGraphNode, artifacts: Record<string, unknown>): string {
  if (node.kind === "condition") {
    const value = readJsonPath(artifacts[node.when.artifact], node.when.path);
    return Object.is(value, node.when.equals) ? node.onTrue : node.onFalse;
  }
  if (node.kind === "humanReview") {
    return node.onApprove ?? node.onSuccess ?? "completed";
  }
  return node.onSuccess ?? "completed";
}

function parallelMapItems(
  node: Extract<PlaybookGraphNode, { kind: "parallelMap" }>,
  artifacts: Record<string, unknown>
): unknown[] {
  const value = readJsonPath(artifacts[node.items.artifact], node.items.path);
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`parallelMap items must resolve to an array: ${node.id}`);
  }
  return value;
}

async function releaseMissingAdapterQueueEntry(input: {
  options: PlaybookGraphRuntimeOptions;
  run: PlaybookGraphRunRecord;
  queueEntry: PlaybookGraphQueueEntry;
  now: string;
}): Promise<PlaybookGraphRunRecord> {
  await input.options.store.updateQueueEntry({
    ...input.queueEntry,
    status: "queued",
    runtimeId: undefined,
    leaseId: undefined,
    claimedAt: undefined,
    leaseExpiresAt: undefined,
    updatedAt: input.now,
  });
  const run = {
    ...input.run,
    status: "running" as const,
    currentQueueEntryId: input.queueEntry.queueEntryId,
    updatedAt: input.now,
  };
  await input.options.store.updateRun(run);
  return run;
}

function createParallelMapBranchWork(input: {
  compiled: CompiledPlaybookGraph;
  run: PlaybookGraphRunRecord;
  node: Extract<PlaybookGraphNode, { kind: "parallelMap" }>;
  queueEntry: PlaybookGraphQueueEntry;
  artifactVersions: PlaybookGraphArtifactVersion[];
  artifacts: Record<string, unknown>;
  now: string;
}): {
  branchItems: PlaybookGraphBranchItem[];
  queueEntries: PlaybookGraphQueueEntry[];
} {
  const startNode = branchStartNode(input.node);
  const items = parallelMapItems(input.node, input.artifacts);
  assertParallelMapLimits({
    compiled: input.compiled,
    node: input.node,
    itemCount: items.length,
  });
  const branchItems = items.map((value, index) =>
    PlaybookGraphBranchItemSchema.parse({
      schemaVersion: 1,
      runId: input.run.runId,
      parentQueueEntryId: input.queueEntry.queueEntryId,
      branchItemId: `${input.queueEntry.queueEntryId}:item:${index}`,
      nodePath: branchItemNodePath(input.queueEntry.nodePath, index),
      index,
      itemHash: hashUnknown(value),
      value,
      status: "queued",
      createdAt: input.now,
      updatedAt: input.now,
    })
  );
  return {
    branchItems,
    queueEntries: branchItems.map((branchItem) =>
      createPlaybookGraphQueueEntry({
        runId: input.run.runId,
        node: startNode,
        nodePath: childPlaybookGraphNodePath(branchItem.nodePath, startNode.id),
        dependsOn: [input.queueEntry.queueEntryId],
        artifactVersions: input.artifactVersions,
        now: input.now,
      })
    ),
  };
}

function assertParallelMapLimits(input: {
  compiled: CompiledPlaybookGraph;
  node: Extract<PlaybookGraphNode, { kind: "parallelMap" }>;
  itemCount: number;
}): void {
  const limits = input.compiled.graph.limits;
  const checks = [
    ["maxGeneratedItems", limits.maxGeneratedItems],
    ["maxTotalBranches", limits.maxTotalBranches],
    ["maxConcurrentBranches", limits.maxConcurrentBranches],
  ] as const;
  for (const [name, limit] of checks) {
    if (limit === undefined || input.itemCount <= limit) continue;
    throw new Error(
      `parallelMap ${input.node.id} produced ${input.itemCount} branch items, exceeding graph limit ${name} (${limit})`
    );
  }
}

function completeBranchItem(
  branchItem: PlaybookGraphBranchItem,
  status: "completed" | "failed" | "skipped",
  now: string
): PlaybookGraphBranchItem {
  return PlaybookGraphBranchItemSchema.parse({
    ...branchItem,
    status,
    updatedAt: now,
  });
}

function parallelMapFanInValue(input: {
  parent: PlaybookGraphQueueEntry;
  children: PlaybookGraphBranchItem[];
  artifactVersions: PlaybookGraphArtifactVersion[];
}): unknown {
  return [...input.children]
    .sort(
      (left, right) =>
        left.index - right.index || left.branchItemId.localeCompare(right.branchItemId)
    )
    .map((child) => {
      const branchVersions = input.artifactVersions.filter((version) =>
        version.nodePath.startsWith(`${child.nodePath}/`)
      );
      const output = branchVersions.at(-1);
      return {
        branchItem: {
          branchItemId: child.branchItemId,
          index: child.index,
          itemHash: child.itemHash,
          nodePath: child.nodePath,
          status: child.status,
          value: child.value,
        },
        output: output?.value ?? null,
        artifactVersion: output
          ? {
              artifactId: output.artifactId,
              versionId: output.versionId,
              producerQueueEntryId: output.producerQueueEntryId,
              contentHash: output.contentHash,
            }
          : null,
        parentQueueEntryId: input.parent.queueEntryId,
      };
    });
}

function advanceTarget(input: {
  compiled: CompiledPlaybookGraph;
  run: PlaybookGraphRunRecord;
  queueEntry: PlaybookGraphQueueEntry;
  target: string;
  artifactVersions: PlaybookGraphArtifactVersion[];
  now: string;
  branchItem?: PlaybookGraphBranchItem;
}): { run: PlaybookGraphRunRecord; queueEntry?: PlaybookGraphQueueEntry } {
  if (input.branchItem && input.target === "completed") {
    return {
      run: {
        ...input.run,
        status: "running",
        currentQueueEntryId: undefined,
        updatedAt: input.now,
      },
    };
  }
  if (input.target === "completed") {
    return {
      run: {
        ...input.run,
        status: "completed",
        currentQueueEntryId: undefined,
        updatedAt: input.now,
        completedAt: input.now,
      },
    };
  }
  if (input.target === "failed" || input.target === "denied") {
    return {
      run: {
        ...input.run,
        status: input.target,
        currentQueueEntryId: undefined,
        updatedAt: input.now,
        completedAt: input.now,
      },
    };
  }
  if (!TERMINAL_GRAPH_TARGETS.has(input.target)) {
    const targetNode = findNode(input.compiled.graph, input.target);
    const nextQueueEntry = createPlaybookGraphQueueEntry({
      runId: input.run.runId,
      node: targetNode,
      nodePath: childPlaybookGraphNodePath(input.queueEntry.nodePath, targetNode.id),
      dependsOn: [input.queueEntry.queueEntryId],
      artifactVersions: input.artifactVersions,
      now: input.now,
    });
    return {
      run: {
        ...input.run,
        status: "running",
        currentQueueEntryId: nextQueueEntry.queueEntryId,
        updatedAt: input.now,
      },
      queueEntry: nextQueueEntry,
    };
  }
  return {
    run: {
      ...input.run,
      status: "running",
      currentQueueEntryId: input.queueEntry.queueEntryId,
      updatedAt: input.now,
    },
  };
}

async function enqueueReadyParallelMapFanIns(input: {
  store: GraphRunStore;
  compiled: CompiledPlaybookGraph;
  run: PlaybookGraphRunRecord;
  now: string;
}): Promise<PlaybookGraphRunRecord> {
  let run = input.run;
  const queue = await input.store.getQueue(run.runId);
  const branchItems = await input.store.listBranchItems(run.runId);
  const artifactVersions = activeArtifactVersions(
    await input.store.listArtifactVersions(run.runId),
    queue
  );
  const artifacts = latestArtifactValues(artifactVersions);

  for (const parent of queue) {
    if (parent.nodeKind !== "parallelMap") continue;
    if (parent.status !== "succeeded" && parent.status !== "memoized") continue;

    const node = findNode(input.compiled.graph, parent.nodeId);
    if (node.kind !== "parallelMap") continue;
    const children = branchItems.filter((item) => item.parentQueueEntryId === parent.queueEntryId);
    const branchWorkStillActive = queue.some(
      (entry) =>
        entry.nodePath.startsWith(`${parent.nodePath}/item:`) &&
        ["queued", "running", "blocked", "interrupted"].includes(entry.status)
    );
    if (branchWorkStillActive) continue;
    if (children.some((item) => item.status === "queued" || item.status === "running")) continue;
    if (children.some((item) => item.status === "failed")) {
      const updatedAt = input.now;
      run = {
        ...run,
        status: "failed",
        currentQueueEntryId: parent.queueEntryId,
        error: `parallelMap branch failed: ${parent.nodeId}`,
        updatedAt,
        completedAt: updatedAt,
      };
      await input.store.updateRun(run);
      return run;
    }

    const target = successTarget(node, artifacts);
    const existingFanInArtifact =
      node.outputArtifact === undefined
        ? undefined
        : artifactVersions.find(
            (version) =>
              version.artifactId === node.outputArtifact &&
              version.producerQueueEntryId === parent.queueEntryId &&
              version.versionId ===
                `${parent.queueEntryId}:${node.outputArtifact}:fan-in:v${parent.attempt}`
          );
    const existingFanIn = queue.some((entry) =>
      target === "completed" || target === "failed" || target === "denied"
        ? false
        : entry.nodePath === childPlaybookGraphNodePath(parent.nodePath, target)
    );
    if (existingFanIn || existingFanInArtifact) continue;

    const fanInValue = parallelMapFanInValue({ parent, children, artifactVersions });
    const fanInArtifactVersions: PlaybookGraphArtifactVersion[] =
      node.outputArtifact === undefined
        ? []
        : [
            {
              schemaVersion: 1 as const,
              runId: run.runId,
              artifactId: node.outputArtifact,
              versionId: `${parent.queueEntryId}:${node.outputArtifact}:fan-in:v${parent.attempt}`,
              producerQueueEntryId: parent.queueEntryId,
              nodePath: parent.nodePath,
              contentHash: hashUnknown(fanInValue),
              value: fanInValue,
              createdAt: input.now,
            },
          ];
    for (const version of fanInArtifactVersions) {
      await input.store.addArtifactVersion(version);
    }
    const artifactVersionsAfterFanIn = [...artifactVersions, ...fanInArtifactVersions];
    const advanced = advanceTarget({
      compiled: input.compiled,
      run,
      queueEntry: parent,
      target,
      artifactVersions: artifactVersionsAfterFanIn,
      now: input.now,
    });
    if (advanced.queueEntry) {
      await input.store.upsertQueueEntry({
        ...advanced.queueEntry,
        dependsOn: [parent.queueEntryId],
      });
    }
    run = advanced.run;
    await input.store.updateRun(run);
    return run;
  }

  return run;
}

export async function createPlaybookGraphRun(
  options: CreatePlaybookGraphRunOptions
): Promise<PlaybookGraphRunRecord> {
  const now = options.now ?? nowIso();
  const runId = options.runId ?? randomUUID();
  const snapshot = createPlaybookGraphSnapshot({
    compiledGraph: options.compiledGraph,
    ...(options.sourceFiles ? { sourceFiles: options.sourceFiles } : {}),
  });
  const compiled = parsePinnedCompiledGraph(snapshot);
  const startNode = findNode(compiled.graph, compiled.graph.start);
  const run = PlaybookGraphRunRecordSchema.parse({
    schemaVersion: 1,
    runId,
    playbookId: compiled.graph.id,
    status: "queued",
    input: options.input ?? {},
    ...(options.materialization ? { materialization: options.materialization } : {}),
    ...(options.executionContext !== undefined
      ? { executionContext: createPlaybookGraphExecutionContextPin(options.executionContext) }
      : {}),
    snapshot,
    startedAt: now,
    updatedAt: now,
  });
  const startQueueEntry = createPlaybookGraphQueueEntry({
    runId,
    node: startNode,
    nodePath: startNode.id,
    now,
  });

  await options.store.createRunWithQueue({ run, queueEntries: [startQueueEntry] });
  return run;
}

export function createGraphNodeMemoKeyParts(input: {
  run: PlaybookGraphRunRecord;
  node: PlaybookGraphNode;
  queueEntry: PlaybookGraphQueueEntry;
  executionContext?: unknown;
  artifacts: PlaybookGraphArtifactVersion[];
  branchItem?: PlaybookGraphBranchItem;
}): PlaybookGraphMemoKeyParts {
  return {
    schemaVersion: 1,
    runId: input.run.runId,
    snapshotHash: input.run.snapshot.snapshotHash,
    graphHash: input.run.snapshot.graphHash,
    nodePath: input.queueEntry.nodePath,
    nodeSpecHash: hashUnknown({
      node: input.node,
      sourceFileHashes: input.run.snapshot.sourceFileHashes,
      scriptSdkVersion: input.run.snapshot.scriptSdkVersion,
    }),
    executionContextHash: hashUnknown(input.executionContext ?? {}),
    inputSnapshotHash: hashUnknown({
      input: input.run.input,
      branchItem: input.branchItem
        ? {
            branchItemId: input.branchItem.branchItemId,
            nodePath: input.branchItem.nodePath,
            index: input.branchItem.index,
            itemHash: input.branchItem.itemHash,
            value: input.branchItem.value,
          }
        : undefined,
      artifactRefs: artifactRefs(input.artifacts),
    }),
  };
}

export async function drainPlaybookGraphRun(
  options: PlaybookGraphRuntimeOptions
): Promise<PlaybookGraphRuntimeResult> {
  const now = options.now ?? nowIso;
  const leaseMs = options.leaseMs ?? 30_000;
  const initialRun = await options.store.getRun(options.runId);
  if (!initialRun) throw new Error(`Unknown graph run: ${options.runId}`);
  let run: PlaybookGraphRunRecord = initialRun;

  let compiled: CompiledPlaybookGraph;
  try {
    compiled = parsePinnedCompiledGraph(run.snapshot);
  } catch (error) {
    const updatedAt = now();
    run = {
      ...run,
      status: "needs_repair",
      repairReason: error instanceof Error ? error.message : String(error),
      updatedAt,
    };
    await options.store.updateRun(run);
    return { run, executed: 0 };
  }

  const maxSteps = options.maxSteps ?? compiled.graph.limits.maxTotalAgentSteps ?? 1_000;
  const driftReason = playbookGraphExecutionContextDriftReason(run, options.executionContext);
  if (driftReason) {
    const updatedAt = now();
    run = { ...run, status: "blocked", blockedReason: driftReason, updatedAt };
    await options.store.updateRun(run);
    return { run, executed: 0 };
  }

  const recoveredAt = now();
  await options.store.recoverStaleQueueLeases({
    runId: run.runId,
    runtimeId: options.runtimeId,
    now: recoveredAt,
  });

  let executed = 0;
  while (true) {
    if (executed >= maxSteps) {
      const updatedAt = now();
      run = {
        ...run,
        status: "failed",
        error: `Graph runtime step limit exceeded (${maxSteps})`,
        updatedAt,
        completedAt: updatedAt,
      };
      await options.store.updateRun(run);
      return { run, executed };
    }

    const bindingRefreshes = await refreshQueuedArtifactBindings({
      store: options.store,
      compiled,
      run,
      now: now(),
    });
    if (bindingRefreshes > 0) {
      continue;
    }

    const claimedAt = now();
    let queueEntry = await options.store.claimNextQueuedEntry({
      runId: run.runId,
      runtimeId: options.runtimeId,
      leaseId: randomUUID(),
      leaseExpiresAt: addMs(claimedAt, leaseMs),
      now: claimedAt,
    });
    if (!queueEntry) {
      const fanInRun = await enqueueReadyParallelMapFanIns({
        store: options.store,
        compiled,
        run,
        now: now(),
      });
      if (
        fanInRun.updatedAt !== run.updatedAt ||
        fanInRun.status !== run.status ||
        fanInRun.currentQueueEntryId !== run.currentQueueEntryId ||
        fanInRun.completedAt !== run.completedAt ||
        fanInRun.error !== run.error
      ) {
        run = fanInRun;
        continue;
      }
      const queue = await options.store.getQueue(run.runId);
      const hasNeedsAttention = queue.some((entry) => entry.status === "needs_attention");
      const hasBlocked = queue.some((entry) => entry.status === "blocked");
      const hasInterrupted = queue.some((entry) => entry.status === "interrupted");
      const hasActive = queue.some(
        (entry) =>
          entry.status === "queued" ||
          entry.status === "running" ||
          entry.status === "blocked" ||
          entry.status === "interrupted" ||
          entry.status === "needs_attention"
      );
      if (hasNeedsAttention && run.status !== "needs_attention") {
        run = { ...run, status: "needs_attention", updatedAt: now() };
        await options.store.updateRun(run);
      } else if (hasBlocked && run.status !== "blocked") {
        run = { ...run, status: "blocked", updatedAt: now() };
        await options.store.updateRun(run);
      } else if (hasInterrupted && run.status !== "interrupted") {
        run = { ...run, status: "interrupted", updatedAt: now() };
        await options.store.updateRun(run);
      } else if (!hasActive && run.status !== "completed") {
        const completedAt = now();
        run = { ...run, status: "completed", updatedAt: completedAt, completedAt };
        await options.store.updateRun(run);
      }
      return { run, executed };
    }

    run = {
      ...run,
      status: "running",
      currentQueueEntryId: queueEntry.queueEntryId,
      updatedAt: now(),
    };
    await options.store.updateRun(run);
    const node = findNode(compiled.graph, queueEntry.nodeId);
    const queueSnapshot = await options.store.getQueue(run.runId);
    const artifactVersions = activeArtifactVersions(
      await options.store.listArtifactVersions(run.runId),
      queueSnapshot
    );
    const refreshedQueueEntry = refreshQueueEntryArtifactRefs({
      entry: queueEntry,
      node,
      artifactVersions,
      now: now(),
    });
    if (refreshedQueueEntry !== queueEntry) {
      queueEntry = refreshedQueueEntry;
      await options.store.updateQueueEntry(queueEntry);
    }
    const branchItems = await options.store.listBranchItems(run.runId);
    const branchItem = branchItemForNodePath(queueEntry.nodePath, branchItems);
    const toolPolicy = node.kind === "tool" ? options.toolPolicies?.[node.capability] : undefined;
    if (node.kind === "tool" && !toolPolicy) {
      const updatedAt = now();
      const blocked = {
        ...queueEntry,
        status: "blocked" as const,
        blockedReason: `Tool execution policy is required for ${node.capability}`,
        runtimeId: undefined,
        leaseId: undefined,
        claimedAt: undefined,
        leaseExpiresAt: undefined,
        updatedAt,
      };
      await options.store.updateQueueEntry(blocked);
      run = {
        ...run,
        status: "blocked",
        currentQueueEntryId: blocked.queueEntryId,
        blockedReason: blocked.blockedReason,
        updatedAt,
      };
      await options.store.updateRun(run);
      return { run, executed };
    }
    if (
      node.kind === "tool" &&
      options.toolCapabilities &&
      !options.toolCapabilities.includes(node.capability)
    ) {
      const updatedAt = now();
      const blocked = {
        ...queueEntry,
        status: "blocked" as const,
        blockedReason: `Tool capability is not allowed: ${node.capability}`,
        runtimeId: undefined,
        leaseId: undefined,
        claimedAt: undefined,
        leaseExpiresAt: undefined,
        updatedAt,
      };
      await options.store.updateQueueEntry(blocked);
      run = {
        ...run,
        status: "blocked",
        currentQueueEntryId: blocked.queueEntryId,
        blockedReason: blocked.blockedReason,
        updatedAt,
      };
      await options.store.updateRun(run);
      return { run, executed };
    }
    const memoKeyParts = createGraphNodeMemoKeyParts({
      run,
      node,
      queueEntry,
      executionContext: options.executionContext,
      artifacts: consumedArtifactVersions(queueEntry, artifactVersions),
      ...(branchItem ? { branchItem } : {}),
    });
    const nodeMemoKey = createPlaybookGraphMemoKey(memoKeyParts);
    const memo = shouldMemoizeNode(node, toolPolicy)
      ? await options.store.getMemo(run.runId, nodeMemoKey)
      : undefined;
    if (memo) {
      const completedAt = now();
      const memoized = {
        ...queueEntry,
        status: "memoized" as const,
        nodeMemoKey,
        runtimeId: undefined,
        leaseId: undefined,
        claimedAt: undefined,
        leaseExpiresAt: undefined,
        updatedAt: completedAt,
        completedAt,
      };
      await options.store.updateQueueEntry(memoized);
      const advanced = advanceTarget({
        compiled,
        run,
        queueEntry: memoized,
        target: successTarget(node, latestArtifactValues(artifactVersions)),
        artifactVersions,
        now: completedAt,
      });
      if (advanced.queueEntry) {
        await options.store.upsertQueueEntry(advanced.queueEntry);
      }
      run = advanced.run;
      await options.store.updateRun(run);
      continue;
    }

    if (node.kind === "humanReview") {
      const updatedAt = now();
      const blocked = {
        ...queueEntry,
        status: "blocked" as const,
        nodeMemoKey,
        blockedReason: "human review required",
        runtimeId: undefined,
        leaseId: undefined,
        claimedAt: undefined,
        leaseExpiresAt: undefined,
        updatedAt,
      };
      await options.store.updateQueueEntry(blocked);
      run = {
        ...run,
        status: "blocked",
        currentQueueEntryId: blocked.queueEntryId,
        blockedReason: "human review required",
        updatedAt,
      };
      await options.store.updateRun(run);
      return { run, executed };
    }

    if (node.kind === "artifactWrite" && !options.artifactWriteAdapter) {
      if (options.blockOnMissingAdapters === false) {
        const updatedAt = now();
        run = await releaseMissingAdapterQueueEntry({
          options,
          run,
          queueEntry,
          now: updatedAt,
        });
        return { run, executed };
      }
      const updatedAt = now();
      const blocked = {
        ...queueEntry,
        status: "blocked" as const,
        nodeMemoKey,
        blockedReason: "artifactWrite execution requires an artifact write adapter",
        runtimeId: undefined,
        leaseId: undefined,
        claimedAt: undefined,
        leaseExpiresAt: undefined,
        updatedAt,
      };
      await options.store.updateQueueEntry(blocked);
      run = {
        ...run,
        status: "blocked",
        currentQueueEntryId: blocked.queueEntryId,
        blockedReason: blocked.blockedReason,
        updatedAt,
      };
      await options.store.updateRun(run);
      return { run, executed };
    }

    if (node.kind === "agent" && !options.agentAdapter) {
      if (options.blockOnMissingAdapters === false) {
        const updatedAt = now();
        run = await releaseMissingAdapterQueueEntry({
          options,
          run,
          queueEntry,
          now: updatedAt,
        });
        return { run, executed };
      }
      const updatedAt = now();
      const blocked = {
        ...queueEntry,
        status: "blocked" as const,
        nodeMemoKey,
        blockedReason: "agent execution requires an agent adapter",
        runtimeId: undefined,
        leaseId: undefined,
        claimedAt: undefined,
        leaseExpiresAt: undefined,
        updatedAt,
      };
      await options.store.updateQueueEntry(blocked);
      run = {
        ...run,
        status: "blocked",
        currentQueueEntryId: blocked.queueEntryId,
        blockedReason: blocked.blockedReason,
        updatedAt,
      };
      await options.store.updateRun(run);
      return { run, executed };
    }

    if (node.kind === "tool" && !options.toolAdapter) {
      const updatedAt = now();
      const blocked = {
        ...queueEntry,
        status: "blocked" as const,
        nodeMemoKey,
        blockedReason: "tool execution requires a tool adapter",
        runtimeId: undefined,
        leaseId: undefined,
        claimedAt: undefined,
        leaseExpiresAt: undefined,
        updatedAt,
      };
      await options.store.updateQueueEntry(blocked);
      run = {
        ...run,
        status: "blocked",
        currentQueueEntryId: blocked.queueEntryId,
        blockedReason: blocked.blockedReason,
        updatedAt,
      };
      await options.store.updateRun(run);
      return { run, executed };
    }

    const artifacts = latestArtifactValues(artifactVersions);
    const claimedRun = run;
    const resolvedNode = resolveNodePayload({
      node,
      runInput: claimedRun.input,
      artifacts,
      ...(branchItem ? { branchItem } : {}),
    });
    let output: unknown;
    let branchUpdates: PlaybookGraphBranchItem[] = [];
    let extraQueueEntries: PlaybookGraphQueueEntry[] = [];
    try {
      output = await withQueueLeaseRenewal(options, queueEntry, leaseMs, now, async () => {
        if (node.kind === "script") {
          if (!options.scriptAdapter) {
            throw new Error("Script adapter is required for graph script nodes");
          }
          return options.scriptAdapter({
            run: claimedRun,
            node: resolvedNode as Extract<PlaybookGraphNode, { kind: "script" }>,
            queueEntry,
            input: branchInput(claimedRun.input, branchItem),
            artifacts,
            ...(branchItem ? { branchItem } : {}),
          });
        }
        if (node.kind === "agent") {
          if (!options.agentAdapter) {
            throw new Error("Agent adapter is required for graph agent nodes");
          }
          return options.agentAdapter({
            run: claimedRun,
            node: resolvedNode as Extract<PlaybookGraphNode, { kind: "agent" }>,
            queueEntry,
            input: branchInput(claimedRun.input, branchItem),
            artifacts,
            ...(claimedRun.snapshot.sourceFiles?.[node.prompt] === undefined
              ? {}
              : { prompt: claimedRun.snapshot.sourceFiles[node.prompt] }),
            ...(branchItem ? { branchItem } : {}),
          });
        }
        if (node.kind === "tool") {
          if (!options.toolAdapter) {
            throw new Error("Tool adapter is required for graph tool nodes");
          }
          return options.toolAdapter({
            run: claimedRun,
            node: resolvedNode as Extract<PlaybookGraphNode, { kind: "tool" }>,
            queueEntry,
            input: branchInput(claimedRun.input, branchItem),
            artifacts,
            ...(branchItem ? { branchItem } : {}),
          });
        }
        if (node.kind === "parallelMap") {
          const work = createParallelMapBranchWork({
            compiled,
            run: claimedRun,
            node,
            queueEntry,
            artifactVersions,
            artifacts,
            now: now(),
          });
          branchUpdates = work.branchItems;
          extraQueueEntries = work.queueEntries;
          return { branchCount: work.branchItems.length };
        }
        if (node.kind === "artifactWrite") {
          const artifactVersion = latestArtifactVersion(artifactVersions, node.artifact);
          if (!artifactVersion) {
            throw new Error(`Missing artifact version for artifactWrite: ${node.artifact}`);
          }
          return options.artifactWriteAdapter?.({
            run: claimedRun,
            node,
            queueEntry,
            artifactVersion,
            value: artifactVersion.value,
          });
        }
        if (node.kind === "condition") {
          return {
            result: Object.is(
              readJsonPath(artifacts[node.when.artifact], node.when.path),
              node.when.equals
            ),
          };
        }
        return {};
      });
    } catch (error) {
      const updatedAt = now();
      const failed = {
        ...queueEntry,
        status: "failed" as const,
        error: error instanceof Error ? error.message : String(error),
        updatedAt,
        completedAt: updatedAt,
      };
      run = {
        ...run,
        status: "failed",
        error: failed.error,
        currentQueueEntryId: failed.queueEntryId,
        updatedAt,
        completedAt: updatedAt,
      };
      try {
        await options.store.checkpointNodeFailure({
          run,
          queueEntry: failed,
        });
      } catch (checkpointError) {
        const message =
          checkpointError instanceof Error ? checkpointError.message : String(checkpointError);
        if (/active queue claim|stale queue claim|lease expired/.test(message)) {
          return { run: (await options.store.getRun(run.runId)) ?? run, executed };
        }
        throw checkpointError;
      }
      return { run, executed };
    }

    const adapterStatus = node.kind === "agent" ? agentAdapterStatus(output) : undefined;
    if (adapterStatus && adapterStatus !== "completed") {
      const updatedAt = now();
      const blockedReason =
        adapterStatus === "blocked"
          ? "Agent execution is waiting on external approval"
          : adapterStatus === "denied"
            ? "Agent execution was denied"
            : output && typeof output === "object" && "error" in output
              ? String((output as { error?: unknown }).error)
              : "Agent execution failed";
      const queueStatus: PlaybookGraphQueueEntry["status"] =
        adapterStatus === "blocked" ? "blocked" : "failed";
      const terminalRunStatus =
        adapterStatus === "blocked" ? "blocked" : adapterStatus === "denied" ? "denied" : "failed";
      const updatedQueue = {
        ...queueEntry,
        status: queueStatus,
        nodeMemoKey,
        runtimeId: undefined,
        leaseId: undefined,
        claimedAt: undefined,
        leaseExpiresAt: undefined,
        blockedReason: adapterStatus === "blocked" ? blockedReason : undefined,
        error: adapterStatus === "blocked" ? undefined : blockedReason,
        updatedAt,
        completedAt: adapterStatus === "blocked" ? undefined : updatedAt,
      };
      run = {
        ...run,
        status: terminalRunStatus,
        currentQueueEntryId: updatedQueue.queueEntryId,
        blockedReason: adapterStatus === "blocked" ? blockedReason : undefined,
        error: adapterStatus === "blocked" ? undefined : blockedReason,
        updatedAt,
        completedAt: adapterStatus === "blocked" ? undefined : updatedAt,
      };
      await options.store.updateQueueEntry(updatedQueue);
      await options.store.updateRun(run);
      return { run, executed };
    }

    const completedAt = now();
    if (branchItem && successTarget(node, artifacts) === "completed") {
      branchUpdates = [...branchUpdates, completeBranchItem(branchItem, "completed", completedAt)];
    }
    const activeRunId = run.runId;
    const newArtifactVersions = (node.kind === "parallelMap" ? [] : outputArtifacts(node)).map(
      (artifactId) => {
        const value = output;
        return {
          schemaVersion: 1 as const,
          runId: activeRunId,
          artifactId,
          versionId: `${queueEntry.queueEntryId}:${artifactId}:v${queueEntry.attempt}`,
          producerQueueEntryId: queueEntry.queueEntryId,
          nodePath: queueEntry.nodePath,
          contentHash: hashUnknown(value),
          value,
          createdAt: completedAt,
        };
      }
    );
    const artifactRefsForMemo = newArtifactVersions.map((version) => ({
      artifactId: version.artifactId,
      versionId: version.versionId,
      contentHash: version.contentHash,
    }));
    await materializeDeclaredArtifacts(compiled, options, run, queueEntry, newArtifactVersions);
    const nodeMemo: PlaybookGraphNodeMemo | undefined = shouldMemoizeNode(node, toolPolicy)
      ? {
          schemaVersion: 1,
          runId: run.runId,
          nodeMemoKey,
          queueEntryId: queueEntry.queueEntryId,
          nodePath: queueEntry.nodePath,
          status: "succeeded",
          memoKeyParts,
          artifactRefs: artifactRefsForMemo,
          outputPreview:
            typeof output === "string"
              ? output.slice(0, 240)
              : stableJsonStringify(output).slice(0, 240),
          createdAt: completedAt,
        }
      : undefined;
    const succeeded = {
      ...queueEntry,
      status: "succeeded" as const,
      nodeMemoKey,
      updatedAt: completedAt,
      completedAt,
    };
    const artifactVersionsAfterSuccess = [...artifactVersions, ...newArtifactVersions];
    const advanced =
      node.kind === "parallelMap"
        ? { run }
        : advanceTarget({
            compiled,
            run,
            queueEntry: succeeded,
            target: successTarget(node, {
              ...artifacts,
              ...Object.fromEntries(newArtifactVersions.map((v) => [v.artifactId, v.value])),
            }),
            artifactVersions: artifactVersionsAfterSuccess,
            now: completedAt,
            ...(branchItem ? { branchItem } : {}),
          });
    run = advanced.run;
    const queueEntriesForCheckpoint = await preserveExistingQueueDurability({
      store: options.store,
      runId: run.runId,
      entries: [...extraQueueEntries, ...(advanced.queueEntry ? [advanced.queueEntry] : [])],
    });
    try {
      await options.store.checkpointNodeSuccess({
        run,
        queueEntry: succeeded,
        ...(queueEntriesForCheckpoint.length > 0
          ? { queueEntries: queueEntriesForCheckpoint }
          : {}),
        ...(branchUpdates.length > 0 ? { branchItems: branchUpdates } : {}),
        ...(nodeMemo ? { memo: nodeMemo } : {}),
        artifactVersions: newArtifactVersions,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/active queue claim|stale queue claim|lease expired/.test(message)) {
        return { run: (await options.store.getRun(run.runId)) ?? run, executed };
      }
      throw error;
    }
    executed += 1;
  }
}

export function isQueueDependencySatisfied(entry: PlaybookGraphQueueEntry): boolean {
  return TERMINAL_SUCCESS_QUEUE_STATUSES.has(entry.status);
}
