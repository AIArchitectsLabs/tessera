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
let buildPlaybookRunPreference: typeof import("./server.js").buildPlaybookRunPreference | undefined;
let buildWorkflowExecutionOptions:
  | typeof import("./server.js").buildWorkflowExecutionOptions
  | undefined;
let createServerMemoryRuntime: typeof import("./server.js").createServerMemoryRuntime | undefined;
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
    buildPlaybookRunPreference = serverModule.buildPlaybookRunPreference;
    buildWorkflowExecutionOptions = serverModule.buildWorkflowExecutionOptions;
    createServerMemoryRuntime = serverModule.createServerMemoryRuntime;
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
