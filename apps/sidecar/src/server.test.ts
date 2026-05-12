import { afterAll, beforeAll, describe, expect, test } from "bun:test";

type RecordedFetchCall = {
  url: string;
  init: Parameters<typeof fetch>[1] | undefined;
};

const originalServe = Bun.serve;
let isPlaybookRunPreferenceAssignmentPlanValidationError:
  | typeof import("./server.js").isPlaybookRunPreferenceAssignmentPlanValidationError
  | undefined;
let buildPlaybookRunPreference: typeof import("./server.js").buildPlaybookRunPreference | undefined;
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

  try {
    const serverModule = await import("./server.js");
    buildPlaybookRunPreference = serverModule.buildPlaybookRunPreference;
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
});

describe("playbook run preference save error mapping", () => {
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
