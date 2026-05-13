import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  WorkflowCapabilityInventorySchema,
  WorkflowRunAssignmentPlanSchema,
} from "@tessera/contracts";

type RecordedFetchCall = {
  url: string;
  init: Parameters<typeof fetch>[1] | undefined;
};

const originalServe = Bun.serve;
const originalMemoryDisabled = process.env.TESSERA_MEMORY_DISABLED;
let isPlaybookRunPreferenceAssignmentPlanValidationError:
  | typeof import("./server.js").isPlaybookRunPreferenceAssignmentPlanValidationError
  | undefined;
let attachPlaybookMemoryShadow: typeof import("./server.js").attachPlaybookMemoryShadow | undefined;
let buildPlaybookRunPreference: typeof import("./server.js").buildPlaybookRunPreference | undefined;
let buildWorkflowExecutionOptions:
  | typeof import("./server.js").buildWorkflowExecutionOptions
  | undefined;
let createServerMemoryRuntime: typeof import("./server.js").createServerMemoryRuntime | undefined;
let handleMemoryForget: typeof import("./server.js").handleMemoryForget | undefined;
let handleMemoryReviewDecision: typeof import("./server.js").handleMemoryReviewDecision | undefined;
let handleMemoryReviewList: typeof import("./server.js").handleMemoryReviewList | undefined;
let handleMemoryStatus: typeof import("./server.js").handleMemoryStatus | undefined;
let pollCodexDeviceToken: typeof import("./server.js").pollCodexDeviceToken | undefined;
let requestCodexDeviceCode: typeof import("./server.js").requestCodexDeviceCode | undefined;
let refreshCodexOAuthCredential:
  | typeof import("./server.js").refreshCodexOAuthCredential
  | undefined;

beforeAll(async () => {
  (Bun as typeof Bun & { serve: typeof Bun.serve }).serve = ((options) => ({
    port: 0,
    stop() {},
  })) as typeof Bun.serve;
  process.env.TESSERA_MEMORY_DISABLED = "1";

  try {
    const serverModule = await import("./server.js");
    attachPlaybookMemoryShadow = serverModule.attachPlaybookMemoryShadow;
    buildPlaybookRunPreference = serverModule.buildPlaybookRunPreference;
    buildWorkflowExecutionOptions = serverModule.buildWorkflowExecutionOptions;
    createServerMemoryRuntime = serverModule.createServerMemoryRuntime;
    handleMemoryForget = serverModule.handleMemoryForget;
    handleMemoryReviewDecision = serverModule.handleMemoryReviewDecision;
    handleMemoryReviewList = serverModule.handleMemoryReviewList;
    handleMemoryStatus = serverModule.handleMemoryStatus;
    isPlaybookRunPreferenceAssignmentPlanValidationError =
      serverModule.isPlaybookRunPreferenceAssignmentPlanValidationError;
    pollCodexDeviceToken = serverModule.pollCodexDeviceToken;
    refreshCodexOAuthCredential = serverModule.refreshCodexOAuthCredential;
    requestCodexDeviceCode = serverModule.requestCodexDeviceCode;
  } finally {
    (Bun as typeof Bun & { serve: typeof Bun.serve }).serve = originalServe;
  }
});

afterAll(() => {
  (Bun as typeof Bun & { serve: typeof Bun.serve }).serve = originalServe;
  if (originalMemoryDisabled === undefined) {
    process.env.TESSERA_MEMORY_DISABLED = undefined;
  } else {
    process.env.TESSERA_MEMORY_DISABLED = originalMemoryDisabled;
  }
});

describe("playbook run preference save error mapping", () => {
  test("reports active memory runtime status", async () => {
    expect(createServerMemoryRuntime).toBeDefined();
    const runtime = createServerMemoryRuntime?.({
      dbPath: "/tmp/tessera-memory.sqlite",
      disabled: false,
      ownerId: "local-owner",
      createStore() {
        return {
          close() {},
          recordEvent(event) {
            return event;
          },
          getEventById() {
            return undefined;
          },
          getEventByKey() {
            return undefined;
          },
          getMemoryById() {
            return undefined;
          },
          indexDocument() {},
          searchChunks() {
            return [];
          },
          upsertMemory(memory) {
            return memory;
          },
          listActiveMemories() {
            return [];
          },
          listCandidateMemories() {
            return [];
          },
          isSourceForgotten() {
            return false;
          },
          forgetMemory() {},
        };
      },
    });

    expect(runtime?.memoryStatus).toEqual({
      enabled: true,
      mode: "active",
      dbPath: "/tmp/tessera-memory.sqlite",
    });
  });

  test("reports disabled and startup fallback memory runtime status", () => {
    expect(createServerMemoryRuntime).toBeDefined();
    const disabled = createServerMemoryRuntime?.({
      dbPath: "/unused/memory.sqlite",
      disabled: true,
      ownerId: "local-owner",
      createStore() {
        throw new Error("should not create store");
      },
    });
    const fallback = createServerMemoryRuntime?.({
      dbPath: "/unavailable/memory.sqlite",
      disabled: false,
      ownerId: "local-owner",
      createStore() {
        throw new Error("sqlite unavailable");
      },
    });

    expect(disabled?.memoryStatus).toEqual({
      enabled: false,
      mode: "disabled",
      dbPath: "/unused/memory.sqlite",
    });
    expect(fallback?.memoryStatus).toEqual({
      enabled: false,
      mode: "fallback",
      dbPath: "/unavailable/memory.sqlite",
      startupWarning: {
        type: "tessera.memory.startup_failed",
        message: "sqlite unavailable",
      },
    });
  });

  test("memory status handler is read only", async () => {
    expect(handleMemoryStatus).toBeDefined();
    const response = await handleMemoryStatus?.(
      new Request("http://localhost/memory/status", { method: "GET" }),
      {
        enabled: true,
        mode: "active",
        dbPath: "/tmp/tessera-memory.sqlite",
      }
    );
    const rejected = await handleMemoryStatus?.(
      new Request("http://localhost/memory/status", { method: "POST" }),
      {
        enabled: true,
        mode: "active",
        dbPath: "/tmp/tessera-memory.sqlite",
      }
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      enabled: true,
      mode: "active",
      dbPath: "/tmp/tessera-memory.sqlite",
    });
    expect(rejected?.status).toBe(405);
  });

  test("memory review handlers list and accept candidate memories", async () => {
    expect(handleMemoryReviewList).toBeDefined();
    expect(handleMemoryReviewDecision).toBeDefined();
    const activeMemory = {
      id: "memory-active",
      workspaceKey: "workspace:one",
      ownerId: "local-owner",
      scope: "workspace" as const,
      type: "preference" as const,
      title: "Weekly style",
      body: "Prefer concise bullets.",
      status: "active" as const,
      confidence: 0.92,
      freshness: "fresh" as const,
      sourceEventIds: ["event-1"],
      sourceDocumentIds: [],
      createdAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
    };
    const candidateMemory = {
      ...activeMemory,
      id: "memory-candidate",
      status: "candidate" as const,
      confidence: 0.62,
      rationale: {
        supportingEventIds: ["event-2"],
        conflictingMemoryIds: [],
        promotionReason: "Needs review.",
        riskFlags: ["low_confidence" as const],
      },
    };
    let storedCandidate = candidateMemory;
    const store = {
      close() {},
      recordEvent(event: never) {
        return event;
      },
      getEventById() {
        return undefined;
      },
      getEventByKey() {
        return undefined;
      },
      getMemoryById(id: string) {
        if (id === "memory-candidate") return storedCandidate;
        if (id === "memory-active") return activeMemory;
        return undefined;
      },
      indexDocument() {},
      searchChunks() {
        return [];
      },
      upsertMemory(memory: typeof activeMemory | typeof candidateMemory) {
        if (memory.id === "memory-candidate") {
          storedCandidate = memory as typeof candidateMemory;
        }
        return memory;
      },
      listActiveMemories() {
        return [activeMemory];
      },
      listCandidateMemories() {
        return [storedCandidate];
      },
      isSourceForgotten() {
        return false;
      },
      forgetMemory() {},
    };

    const listResponse = await handleMemoryReviewList?.(
      new Request("http://localhost/memory/review", { method: "GET" }),
      store
    );
    const decisionResponse = await handleMemoryReviewDecision?.(
      new Request("http://localhost/memory/review/decision", {
        method: "POST",
        body: JSON.stringify({
          memoryId: "memory-candidate",
          decision: "accept",
          reason: "User accepted.",
          decidedAt: "2026-05-13T00:10:00.000Z",
        }),
      }),
      store
    );

    expect(listResponse?.status).toBe(200);
    expect(await listResponse?.json()).toEqual({
      active: [activeMemory],
      candidates: [candidateMemory],
    });
    expect(decisionResponse?.status).toBe(200);
    expect(await decisionResponse?.json()).toMatchObject({
      id: "memory-candidate",
      status: "active",
      updatedAt: "2026-05-13T00:10:00.000Z",
    });
  });

  test("memory forget handler accepts explicit delete requests", async () => {
    expect(handleMemoryForget).toBeDefined();
    const requests: unknown[] = [];
    const store = {
      close() {},
      recordEvent(event: never) {
        return event;
      },
      getEventById() {
        return undefined;
      },
      getEventByKey() {
        return undefined;
      },
      getMemoryById() {
        return undefined;
      },
      indexDocument() {},
      searchChunks() {
        return [];
      },
      upsertMemory(memory: never) {
        return memory;
      },
      listActiveMemories() {
        return [];
      },
      listCandidateMemories() {
        return [];
      },
      isSourceForgotten() {
        return false;
      },
      forgetMemory(request: unknown) {
        requests.push(request);
      },
    };

    const response = await handleMemoryForget?.(
      new Request("http://localhost/memory/forget", {
        method: "POST",
        body: JSON.stringify({
          memoryId: "memory-active",
          action: "delete",
          reason: "User asked Tessera to forget this.",
          requestedAt: "2026-05-13T00:15:00.000Z",
        }),
      }),
      store
    );

    expect(response?.status).toBe(200);
    expect(requests).toEqual([
      {
        memoryId: "memory-active",
        action: "delete",
        reason: "User asked Tessera to forget this.",
        requestedAt: "2026-05-13T00:15:00.000Z",
      },
    ]);
    expect(await response?.json()).toEqual({ ok: true });
  });

  test("falls back to noop memory manager when memory store startup fails", async () => {
    expect(createServerMemoryRuntime).toBeDefined();
    const warnings: string[] = [];
    const runtime = createServerMemoryRuntime?.({
      dbPath: "/unavailable/memory.sqlite",
      disabled: false,
      ownerId: "local-owner",
      createStore() {
        throw new Error("sqlite unavailable");
      },
      warn(message) {
        warnings.push(message);
      },
    });

    expect(runtime?.memoryStore).toBeUndefined();
    expect(runtime?.memoryStatus.mode).toBe("fallback");
    const recalled = await runtime?.memoryManager.recallForTask({
      task: {
        id: "task-1",
        workspaceRoot: "/workspace/acme",
        title: "Task",
        status: "active",
        agentId: "default",
        turns: [],
        artifacts: [],
        notifications: [],
        auditRecords: [],
        activeSkills: [],
        createdAt: "2026-05-13T00:00:00.000Z",
        updatedAt: "2026-05-13T00:00:00.000Z",
      },
      query: "anything",
      mode: "task",
      maxCharacters: 800,
    });

    expect(recalled?.context).toBe("");
    expect(JSON.parse(warnings[0] ?? "{}")).toEqual({
      type: "tessera.memory.startup_failed",
      message: "sqlite unavailable",
    });
  });

  test("uses noop memory manager when memory is explicitly disabled", () => {
    expect(createServerMemoryRuntime).toBeDefined();
    const runtime = createServerMemoryRuntime?.({
      dbPath: "/unused/memory.sqlite",
      disabled: true,
      ownerId: "local-owner",
      createStore() {
        throw new Error("should not create store");
      },
    });

    expect(runtime?.memoryStore).toBeUndefined();
    expect(runtime?.memoryStatus.mode).toBe("disabled");
  });

  test("server stamps stored preference metadata from a save request", () => {
    expect(buildPlaybookRunPreference).toBeDefined();
    const preference = buildPlaybookRunPreference?.(
      "sales.meeting-brief",
      {
        workspaceRoot: "/tmp/workspace",
        assignmentPlan: {
          resolverVersion: 1,
          createdAt: "2026-05-11T00:00:00.000Z",
          assignments: {
            draftBrief: {
              stepId: "draftBrief",
              agentId: "default",
              agentLabel: "Tessera",
              skillCapabilities: [],
              toolCapabilities: ["tool.workspace.read", "tool.workspace.write"],
              integrationCapabilities: [],
            },
          },
        },
      },
      new Date("2026-05-12T00:00:00.000Z")
    );

    expect(preference).toMatchObject({
      workspaceRoot: "/tmp/workspace",
      playbookId: "sales.meeting-brief",
      updatedAt: "2026-05-12T00:00:00.000Z",
    });
  });

  test("treats assignment plan validation failures as client recoverable", () => {
    expect(isPlaybookRunPreferenceAssignmentPlanValidationError).toBeDefined();
    expect(
      isPlaybookRunPreferenceAssignmentPlanValidationError?.(
        new Error("Assignment for step draft is stale or does not match the current inventory")
      )
    ).toBe(true);
    expect(
      isPlaybookRunPreferenceAssignmentPlanValidationError?.(
        new Error("Assignment plan includes unknown step: draft")
      )
    ).toBe(true);
    expect(isPlaybookRunPreferenceAssignmentPlanValidationError?.(new Error("boom"))).toBe(false);
  });

  test("builds workflow execution options with the resolved assignment plan and runtime credential", () => {
    expect(buildWorkflowExecutionOptions).toBeDefined();
    const capabilityInventory = WorkflowCapabilityInventorySchema.parse({
      agents: [
        {
          id: "default",
          label: "Tessera",
          fingerprint: "ui-b58c78b6",
          model: { provider: "openai-codex", model: "gpt-5.4" },
          modelCapabilities: [],
          dataPolicies: [],
          skillCapabilities: ["skill.planning"],
          toolCapabilities: ["tool.workspace.read", "tool.workspace.write"],
        },
      ],
      integrations: [],
    });
    const assignmentPlan = WorkflowRunAssignmentPlanSchema.parse({
      resolverVersion: 1,
      createdAt: "2026-05-12T00:00:00.000Z",
      assignments: {
        draftBrief: {
          stepId: "draftBrief",
          provider: { provider: "openai-codex", model: "gpt-5.4" },
          skillCapabilities: [],
          toolCapabilities: [],
          integrationCapabilities: [],
        },
      },
    });
    const options = buildWorkflowExecutionOptions?.({
      assignmentPlan,
      capabilityInventory,
      credential: {
        authType: "codex-oauth",
        accessToken: "access-token",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
    });

    expect(options?.assignmentPlan).toEqual(assignmentPlan);
    expect(options?.capabilityInventory).toEqual(capabilityInventory);
    expect(options?.agentCredential).toEqual({
      authType: "codex-oauth",
      accessToken: "access-token",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });
  });

  test("attaches playbook memory shadow recall without changing run outputs", async () => {
    expect(attachPlaybookMemoryShadow).toBeDefined();
    const run = {
      runId: "run-shadow",
      workflowId: "ops.weekly-status-digest",
      status: "completed" as const,
      input: { workspaceRoot: "/workspace/acme" },
      outputs: { draft: "original output" },
      sourceGaps: [],
      events: [],
      completedAt: "2026-05-13T00:00:00.000Z",
    };

    const withShadow = await attachPlaybookMemoryShadow?.(run, {
      async recallForPlaybookRun() {
        return {
          mode: "workspace" as const,
          timedOut: false,
          items: [
            {
              memoryId: "memory-playbook-lesson",
              scope: "playbook" as const,
              type: "lesson" as const,
              title: "Prior lesson",
              body: "Check blocked items first.",
              confidence: 0.91,
              freshness: "fresh" as const,
              sourceRefs: [{ type: "event", id: "memory-event-1" }],
              reason: "Prior playbook memory for this workflow.",
            },
          ],
          trace: {
            query: "ops.weekly-status-digest",
            workspaceKey: "workspace:one",
            candidateCount: 1,
            selectedCount: 1,
            omittedReasons: [],
            durationMs: 1,
          },
        };
      },
    });

    expect(withShadow?.outputs).toEqual(run.outputs);
    const shadowEvent = withShadow?.events?.find(
      (event) => event.metadata && "memoryShadow" in event.metadata
    );
    expect(shadowEvent?.message).toBe("Playbook memory shadow recall evaluated");
    expect(shadowEvent?.metadata?.memoryShadow).toMatchObject({
      trace: {
        selectedCount: 1,
      },
      items: [{ memoryId: "memory-playbook-lesson" }],
    });
  });

  test("playbook memory shadow failure records an omitted reason instead of throwing", async () => {
    expect(attachPlaybookMemoryShadow).toBeDefined();
    const run = {
      runId: "run-shadow-failed",
      workflowId: "ops.weekly-status-digest",
      status: "completed" as const,
      input: { workspaceRoot: "/workspace/acme" },
      sourceGaps: [],
      events: [],
      completedAt: "2026-05-13T00:00:00.000Z",
    };

    const withShadow = await attachPlaybookMemoryShadow?.(run, {
      async recallForPlaybookRun() {
        throw new Error("memory unavailable");
      },
    });

    const shadowEvent = withShadow?.events?.find(
      (event) => event.metadata && "memoryShadow" in event.metadata
    );
    expect(shadowEvent?.metadata?.memoryShadow).toMatchObject({
      items: [],
      trace: {
        selectedCount: 0,
        omittedReasons: ["playbook memory shadow recall failed"],
      },
    });
  });
});

describe("Codex OAuth device flow", () => {
  test("requests device code and normalizes the upstream payload", async () => {
    expect(requestCodexDeviceCode).toBeDefined();
    const calls: RecordedFetchCall[] = [];
    const fakeFetch = (async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json({
        device_auth_id: "device-123",
        interval: 1,
        user_code: "ABCD-EFGH",
      });
    }) as typeof fetch;

    const result = await requestCodexDeviceCode?.(fakeFetch);

    expect(result).toEqual({
      deviceAuthId: "device-123",
      interval: 3,
      userCode: "ABCD-EFGH",
      verificationUri: "https://auth.openai.com/codex/device",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://auth.openai.com/api/accounts/deviceauth/usercode");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    });
  });

  test("reports pending while the user has not authorized the device code", async () => {
    expect(pollCodexDeviceToken).toBeDefined();
    const fakeFetch = (async () => new Response(null, { status: 403 })) as unknown as typeof fetch;

    await expect(
      pollCodexDeviceToken?.({ deviceAuthId: "device-123", userCode: "ABCD-EFGH" }, fakeFetch)
    ).resolves.toEqual({ status: "pending" });
  });

  test("exchanges authorized device code for a redacted credential bundle", async () => {
    expect(pollCodexDeviceToken).toBeDefined();
    const calls: RecordedFetchCall[] = [];
    const fakeFetch = (async (url, init) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return Response.json({
          authorization_code: "auth-code",
          code_verifier: "code-verifier",
        });
      }
      return Response.json({
        access_token: "access-token",
        refresh_token: "refresh-token",
      });
    }) as typeof fetch;

    const result = await pollCodexDeviceToken?.(
      { deviceAuthId: "device-123", userCode: "ABCD-EFGH" },
      fakeFetch
    );

    expect(result?.status).toBe("authorized");
    if (result?.status !== "authorized") {
      throw new Error("Expected authorized Codex OAuth result");
    }
    expect(result).toMatchObject({
      credential: {
        authMode: "chatgpt",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        tokens: {
          accessToken: "access-token",
          refreshToken: "refresh-token",
        },
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("https://auth.openai.com/api/accounts/deviceauth/token");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      device_auth_id: "device-123",
      user_code: "ABCD-EFGH",
    });
    expect(calls[1]?.url).toBe("https://auth.openai.com/oauth/token");
    const form = calls[1]?.init?.body as URLSearchParams;
    expect(form.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(form.get("code")).toBe("auth-code");
    expect(form.get("code_verifier")).toBe("code-verifier");
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("redirect_uri")).toBe("https://auth.openai.com/deviceauth/callback");
    expect(typeof result.credential.lastRefresh).toBe("string");
  });

  test("refreshes an existing token bundle with refresh_token grant", async () => {
    expect(refreshCodexOAuthCredential).toBeDefined();
    const calls: RecordedFetchCall[] = [];
    const fakeFetch = (async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json({
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
      });
    }) as typeof fetch;

    const credential = await refreshCodexOAuthCredential?.(
      {
        authMode: "chatgpt",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        tokens: {
          accessToken: "old-access-token",
          refreshToken: "old-refresh-token",
        },
      },
      fakeFetch
    );

    expect(credential).toMatchObject({
      authMode: "chatgpt",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      tokens: {
        accessToken: "new-access-token",
        refreshToken: "new-refresh-token",
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://auth.openai.com/oauth/token");
    const form = calls[0]?.init?.body as URLSearchParams;
    expect(form.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("old-refresh-token");
    expect(typeof credential?.lastRefresh).toBe("string");
  });
});
