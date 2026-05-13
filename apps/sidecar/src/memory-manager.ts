import type {
  Memory,
  MemoryRecallItem,
  MemoryRecallMode,
  MemoryRecallResult,
  TaskDetail,
  TaskTurn,
  WorkflowRunResult,
} from "@tessera/contracts";
import {
  classifyMemoryContent,
  formatMemoryContext,
  memoryContentHash,
  workspaceKeyForRoot,
} from "@tessera/core";
import type { MemoryChunkSearchResult, MemoryStore } from "./memory-store.js";

export interface TaskRecallOutput {
  context: string;
  result: MemoryRecallResult;
}

export interface TesseraMemoryManager {
  recordTaskTurn(input: { task: TaskDetail; turn: TaskTurn }): Promise<void>;
  recordWorkflowRun(input: { run: WorkflowRunResult; workspaceRoot?: string }): Promise<void>;
  recallForTask(input: {
    task: TaskDetail;
    query: string;
    mode: MemoryRecallMode;
    maxCharacters: number;
  }): Promise<TaskRecallOutput>;
}

export interface CreateMemoryManagerOptions {
  store: MemoryStore;
  ownerId?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function emptyRecall(input: {
  task: TaskDetail;
  query: string;
  mode: MemoryRecallMode;
  startedAt?: number;
  omittedReasons?: string[];
}): TaskRecallOutput {
  return {
    context: "",
    result: {
      mode: input.mode,
      timedOut: false,
      items: [],
      trace: {
        query: input.query,
        workspaceKey: workspaceKeyForRoot(input.task.workspaceRoot),
        candidateCount: 0,
        selectedCount: 0,
        omittedReasons: input.omittedReasons ?? [],
        durationMs: input.startedAt ? Math.max(0, Date.now() - input.startedAt) : 0,
      },
    },
  };
}

function eventTypeForTurn(turn: TaskTurn): string | undefined {
  if (turn.status === "completed") return "task.turn.completed";
  if (turn.status === "failed") return "task.turn.failed";
  return undefined;
}

function memoryToRecallItem(memory: Memory): MemoryRecallItem {
  return {
    memoryId: memory.id,
    scope: memory.scope,
    type: memory.type,
    title: memory.title,
    body: memory.body,
    confidence: memory.confidence,
    freshness: memory.freshness,
    sourceRefs: [
      ...memory.sourceEventIds.map((id) => ({ type: "event", id })),
      ...memory.sourceDocumentIds.map((id) => ({ type: "document", id })),
    ],
    reason: "Active curated memory for this workspace.",
  };
}

function chunkToRecallItem(chunk: MemoryChunkSearchResult): MemoryRecallItem {
  const turnId = typeof chunk.metadata.turnId === "string" ? chunk.metadata.turnId : chunk.sourceId;
  return {
    memoryId: chunk.documentId,
    scope: chunk.scope,
    type: "fact",
    title: chunk.title ?? "Relevant task context",
    body: chunk.content,
    confidence: 0.65,
    freshness: "fresh",
    sourceRefs: [{ type: "turn", id: turnId }],
    reason: "Matched a previous turn in this task.",
  };
}

function taskDocumentTitle(turn: TaskTurn): string {
  return `${turn.role} turn ${turn.status}`;
}

function workflowWorkspaceRoot(input: {
  run: WorkflowRunResult;
  workspaceRoot?: string;
}): string | undefined {
  if (input.workspaceRoot?.trim()) return input.workspaceRoot;
  const workspaceRoot = input.run.input.workspaceRoot;
  return typeof workspaceRoot === "string" && workspaceRoot.trim() ? workspaceRoot : undefined;
}

function workflowProjection(run: WorkflowRunResult): string {
  const stepCount = run.steps?.length ?? 0;
  const outputKeys = run.outputs ? Object.keys(run.outputs).sort() : [];
  return [
    `Workflow: ${run.workflowId}`,
    `Status: ${run.status}`,
    `Step count: ${stepCount}`,
    `Output keys: ${outputKeys.length > 0 ? outputKeys.join(", ") : "none"}`,
    `Completed at: ${run.completedAt ?? run.updatedAt ?? "unknown"}`,
  ].join("\n");
}

export function createNoopMemoryManager(): TesseraMemoryManager {
  return {
    async recordTaskTurn() {},
    async recordWorkflowRun() {},
    async recallForTask(input) {
      return emptyRecall(input);
    },
  };
}

export function createMemoryManager(options: CreateMemoryManagerOptions): TesseraMemoryManager {
  const { store, ownerId } = options;

  return {
    async recordTaskTurn({ task, turn }) {
      try {
        const eventType = eventTypeForTurn(turn);
        if (!eventType) return;

        const workspaceKey = workspaceKeyForRoot(task.workspaceRoot);
        const classified = classifyMemoryContent(turn.content);
        const createdAt = turn.completedAt ?? nowIso();
        const eventKey = `task:${task.id}:turn:${turn.id}:${turn.status}`;
        const event =
          store.getEventByKey(eventKey) ??
          store.recordEvent({
            id: createId("memory-event"),
            eventKey,
            workspaceKey,
            ...(ownerId ? { ownerId } : {}),
            scope: "task",
            subjectType: "turn",
            subjectId: turn.id,
            eventType,
            content: classified.capturePolicy === "rejected" ? "" : classified.content,
            contentHash: memoryContentHash(classified.content),
            metadata: { taskId: task.id, turnId: turn.id, role: turn.role },
            sensitivity: classified.sensitivity,
            capturePolicy: classified.capturePolicy,
            schemaVersion: 1,
            createdAt,
          });

        if (classified.capturePolicy === "rejected" || !classified.content) return;

        store.indexDocument({
          id: `task-turn:${turn.id}`,
          workspaceKey,
          ...(ownerId ? { ownerId } : {}),
          scope: "task",
          kind: "event",
          sourceId: event.id,
          title: taskDocumentTitle(turn),
          content: classified.content,
          metadata: { taskId: task.id, turnId: turn.id, role: turn.role },
          createdAt,
          updatedAt: createdAt,
        });
      } catch {}
    },
    async recordWorkflowRun(input) {
      try {
        const workspaceRoot = workflowWorkspaceRoot(input);
        if (!workspaceRoot) return;

        const workspaceKey = workspaceKeyForRoot(workspaceRoot);
        const classified = classifyMemoryContent(workflowProjection(input.run));
        const content = classified.capturePolicy === "rejected" ? "" : classified.content;
        const createdAt = input.run.completedAt ?? input.run.updatedAt ?? nowIso();
        store.recordEvent({
          id: createId("memory-event"),
          eventKey: `workflow:${input.run.runId}:${input.run.status}`,
          workspaceKey,
          ...(ownerId ? { ownerId } : {}),
          scope: "playbook",
          subjectType: "workflow_run",
          subjectId: input.run.runId,
          eventType: `playbook.run.${input.run.status}`,
          content,
          contentHash: memoryContentHash(content),
          metadata: {
            runId: input.run.runId,
            workflowId: input.run.workflowId,
            status: input.run.status,
          },
          sensitivity: classified.sensitivity,
          capturePolicy: classified.capturePolicy,
          schemaVersion: 1,
          createdAt,
        });
      } catch {}
    },
    async recallForTask(input) {
      const startedAt = Date.now();
      if (input.mode === "none") return emptyRecall({ ...input, startedAt });

      try {
        const workspaceKey = workspaceKeyForRoot(input.task.workspaceRoot);
        const activeItems = store
          .listActiveMemories({ workspaceKey, ...(ownerId ? { ownerId } : {}), limit: 6 })
          .map(memoryToRecallItem);
        const sameTaskChunks = store
          .searchChunks({
            workspaceKey,
            ...(ownerId ? { ownerId } : {}),
            query: input.query,
            limit: 8,
          })
          .filter((chunk) => chunk.metadata.taskId === input.task.id)
          .map(chunkToRecallItem);
        const candidates = [...activeItems, ...sameTaskChunks];
        const items: MemoryRecallItem[] = [];
        const omittedReasons: string[] = [];

        for (const candidate of candidates) {
          const nextContext = formatMemoryContext([...items, candidate], {
            maxCharacters: input.maxCharacters,
          });
          if (!nextContext) {
            omittedReasons.push(`${candidate.memoryId} exceeded the prompt budget`);
            continue;
          }
          items.push(candidate);
        }

        const context = formatMemoryContext(items, { maxCharacters: input.maxCharacters });
        return {
          context,
          result: {
            mode: input.mode,
            timedOut: false,
            items,
            trace: {
              query: input.query,
              workspaceKey,
              candidateCount: candidates.length,
              selectedCount: items.length,
              omittedReasons,
              durationMs: Math.max(0, Date.now() - startedAt),
            },
          },
        };
      } catch {
        return emptyRecall({
          ...input,
          startedAt,
          omittedReasons: ["memory recall failed"],
        });
      }
    },
  };
}
