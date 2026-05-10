import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCliCommand } from "./shell.js";
import type { ExecuteCliCommandOptions } from "./shell.js";

describe("workspace cli shell commands", () => {
  test("returns normalized web search results", async () => {
    const result = await executeCliCommand(["web-search", "search", "tessera"], {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            web: {
              results: [
                {
                  title: "Tessera",
                  url: "https://example.com",
                  description: "Agent workspace",
                },
              ],
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        ),
      getBraveApiKey: async () => "brave-test",
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      query: "tessera",
      provider: "brave-search",
      capability: "search",
      cached: false,
      results: [
        {
          title: "Tessera",
          url: "https://example.com",
          snippet: "Agent workspace",
          source: "example.com",
          position: 1,
        },
      ],
    });
    expect(payload.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("uses the configured tavily provider when brave is unavailable", async () => {
    const options: ExecuteCliCommandOptions = {
      fetchImpl: async (input: string | URL | Request) => {
        expect(input instanceof Request ? input.url : String(input)).toContain("tavily");
        return new Response(
          JSON.stringify({
            query: "tessera",
            results: [
              {
                title: "Tessera",
                url: "https://example.com/tavily",
                content: "Tavily result",
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      },
      getBraveApiKey: async () => null,
      getTavilyApiKey: async () => "tavily-test",
      getSearchSettings: async () => ({
        mode: "tavily",
        allowKeylessFallback: false,
        providers: {
          braveSearch: { provider: "brave-search", hasCredential: false },
          tavily: { provider: "tavily", hasCredential: true },
          duckduckgo: { provider: "duckduckgo", hasCredential: false },
        },
      }),
    };

    const result = await executeCliCommand(["web-search", "search", "tessera"], options);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      query: "tessera",
      provider: "tavily",
      capability: "search",
      cached: false,
      results: [
        {
          title: "Tessera",
          url: "https://example.com/tavily",
          snippet: "Tavily result",
          source: "example.com",
          position: 1,
        },
      ],
    });
    expect(payload.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("returns a stable missing-search error when no provider is configured", async () => {
    const result = await executeCliCommand(["web-search", "search", "tessera"], {
      fetchImpl: async () => new Response("", { status: 500 }),
      getBraveApiKey: async () => null,
      getTavilyApiKey: async () => null,
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("No search provider is configured.");
  });

  test("loads persisted search settings for keyless fallback when none are injected", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tessera-search-settings-"));
    const previousConfigDir = process.env.TESSERA_APP_CONFIG_DIR;
    process.env.TESSERA_APP_CONFIG_DIR = dir;

    try {
      await writeFile(
        join(dir, "integration-settings.json"),
        JSON.stringify({
          providers: {
            braveSearch: { provider: "brave-search" },
            googleCalendar: { provider: "google-calendar" },
          },
          search: {
            mode: "duckduckgo",
            allowKeylessFallback: true,
          },
        })
      );

      const result = await executeCliCommand(["web-search", "search", "tessera"], {
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              AbstractText: "Tessera summary",
              AbstractURL: "https://example.com/tessera",
              Heading: "Tessera",
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            }
          ),
        getBraveApiKey: async () => null,
        getTavilyApiKey: async () => null,
      });

      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload).toMatchObject({
        query: "tessera",
        provider: "duckduckgo",
        capability: "search",
        cached: false,
      });
    } finally {
      if (previousConfigDir === undefined) {
        process.env.TESSERA_APP_CONFIG_DIR = undefined;
      } else {
        process.env.TESSERA_APP_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  test("returns markdown extraction for fetched html pages", async () => {
    const result = await executeCliCommand(["web-fetch", "fetch", "https://example.com/post"], {
      fetchImpl: async () =>
        new Response(
          `<!doctype html><html><head><title>Example Post</title><meta name="author" content="A. Writer"></head><body><main><h1>Example Post</h1><p>Hello world.</p></main></body></html>`,
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          }
        ),
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      url: "https://example.com/post",
      title: "Example Post",
      markdown: "# Example Post\n\nHello world.",
      author: "A. Writer",
      diagnostics: {
        status: 200,
        contentType: "text/html; charset=utf-8",
      },
    });
  });

  test("fails clearly on unsupported content types", async () => {
    const result = await executeCliCommand(["web-fetch", "fetch", "https://example.com/file.pdf"], {
      fetchImpl: async () =>
        new Response("%PDF", {
          status: 200,
          headers: { "content-type": "application/pdf" },
        }),
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unsupported content type");
  });

  test("returns normalized gcal list results", async () => {
    let capturedArgs: string[] = [];
    const result = await executeCliCommand(["gcal", "list", "--limit", "1"], {
      runGwsCli: async (args) => {
        capturedArgs = args;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            items: [
              {
                id: "evt-1",
                summary: "Weekly review",
                start: { dateTime: "2026-05-04T09:00:00Z" },
                end: { dateTime: "2026-05-04T09:30:00Z" },
              },
            ],
          }),
          stderr: "",
        };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(capturedArgs.slice(0, 3)).toEqual(["calendar", "events", "list"]);
    expect(capturedArgs).toContain("--params");
    const params = JSON.parse(capturedArgs[capturedArgs.indexOf("--params") + 1] ?? "{}");
    expect(params).toMatchObject({
      calendarId: "primary",
      maxResults: 1,
      orderBy: "startTime",
      singleEvents: true,
    });
    expect(JSON.parse(result.stdout)).toEqual({
      calendarId: "primary",
      events: [
        {
          id: "evt-1",
          title: "Weekly review",
          start: "2026-05-04T09:00:00Z",
          end: "2026-05-04T09:30:00Z",
          isAllDay: false,
        },
      ],
    });
  });

  test("returns normalized gcal read results", async () => {
    let capturedArgs: string[] = [];
    const result = await executeCliCommand(["gcal", "read", "evt-1"], {
      runGwsCli: async (args) => {
        capturedArgs = args;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            id: "evt-1",
            summary: "Weekly review",
            start: { date: "2026-05-04" },
            end: { date: "2026-05-05" },
            attendees: [{ email: "owner@example.com", responseStatus: "accepted" }],
          }),
          stderr: "",
        };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(capturedArgs.slice(0, 3)).toEqual(["calendar", "events", "get"]);
    const params = JSON.parse(capturedArgs[capturedArgs.indexOf("--params") + 1] ?? "{}");
    expect(params).toEqual({
      calendarId: "primary",
      eventId: "evt-1",
    });
    expect(JSON.parse(result.stdout)).toEqual({
      calendarId: "primary",
      event: {
        id: "evt-1",
        title: "Weekly review",
        start: "2026-05-04",
        end: "2026-05-05",
        isAllDay: true,
        attendees: [{ email: "owner@example.com", responseStatus: "accepted" }],
      },
    });
  });

  test("returns normalized mail list results with query filters", async () => {
    const calls: string[][] = [];
    const result = await executeCliCommand(["mail", "list", "--limit", "3", "--query", "project"], {
      runGwsCli: async (args) => {
        calls.push(args);
        if (args.includes("list")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              messages: [{ id: "msg-1" }],
            }),
            stderr: "",
          };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            id: "msg-1",
            threadId: "thread-1",
            payload: {
              headers: [
                { name: "Subject", value: "Project update" },
                { name: "From", value: "Alex <alex@example.com>" },
                { name: "Date", value: "2026-05-09T09:00:00Z" },
              ],
            },
            snippet: "Status is green.",
            labelIds: ["INBOX"],
          }),
          stderr: "",
        };
      },
    });

    expect(result.exitCode).toBe(0);
    const listArgs = calls.find((call) => call.includes("list")) ?? [];
    const getArgs = calls.find((call) => call.includes("get")) ?? [];
    expect(listArgs.slice(0, 4)).toEqual(["gmail", "users", "messages", "list"]);
    const params = JSON.parse(listArgs[listArgs.indexOf("--params") + 1] ?? "{}");
    expect(params).toEqual({
      userId: "me",
      maxResults: 3,
      q: "project",
    });
    expect(getArgs.slice(0, 4)).toEqual(["gmail", "users", "messages", "get"]);
    const getParams = JSON.parse(getArgs[getArgs.indexOf("--params") + 1] ?? "{}");
    expect(getParams).toMatchObject({
      userId: "me",
      id: "msg-1",
      format: "metadata",
      metadataHeaders: ["Subject", "From", "Date", "To", "Cc"],
    });
    expect(JSON.parse(result.stdout)).toEqual({
      messages: [
        {
          id: "msg-1",
          threadId: "thread-1",
          subject: "Project update",
          from: "Alex <alex@example.com>",
          date: "2026-05-09T09:00:00Z",
          snippet: "Status is green.",
          labels: ["INBOX"],
        },
      ],
    });
  });

  test("hydrates mail list summaries with metadata", async () => {
    const calls: string[][] = [];
    const result = await executeCliCommand(["mail", "list", "--limit", "2"], {
      runGwsCli: async (args) => {
        calls.push(args);
        if (args.includes("list")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ messages: [{ id: "m1" }, { id: "m2" }] }),
            stderr: "",
          };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            id: args[args.indexOf("--params") + 1]?.includes("m1") ? "m1" : "m2",
            threadId: "t1",
            payload: {
              headers: [
                { name: "Subject", value: "Meeting prep" },
                { name: "From", value: "Alex <alex@example.com>" },
                { name: "Date", value: "Sat, 09 May 2026 09:00:00 +0000" },
              ],
            },
            snippet: "Review pricing",
            labelIds: ["INBOX"],
          }),
          stderr: "",
        };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(calls.filter((call) => call.includes("get"))).toHaveLength(2);
    expect(JSON.parse(result.stdout).messages[0]).toMatchObject({
      id: "m1",
      subject: "Meeting prep",
      from: "Alex <alex@example.com>",
    });
  });

  test("returns normalized mail search results", async () => {
    const calls: string[][] = [];
    const result = await executeCliCommand(["mail", "search", "project update", "--limit", "5"], {
      runGwsCli: async (args) => {
        calls.push(args);
        if (args.includes("list")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              messages: [{ id: "msg-2" }],
            }),
            stderr: "",
          };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            id: "msg-2",
            threadId: "thread-2",
            payload: {
              headers: [
                { name: "Subject", value: "Project update" },
                { name: "From", value: "Alex <alex@example.com>" },
                { name: "Date", value: "2026-05-09T09:00:00Z" },
              ],
            },
            snippet: "Status is green.",
            labelIds: ["INBOX", "UNREAD"],
          }),
          stderr: "",
        };
      },
    });

    expect(result.exitCode).toBe(0);
    const listArgs = calls.find((call) => call.includes("list")) ?? [];
    expect(listArgs.slice(0, 4)).toEqual(["gmail", "users", "messages", "list"]);
    const params = JSON.parse(listArgs[listArgs.indexOf("--params") + 1] ?? "{}");
    expect(params).toEqual({
      userId: "me",
      maxResults: 5,
      q: "project update",
    });
    expect(JSON.parse(result.stdout)).toEqual({
      messages: [
        {
          id: "msg-2",
          threadId: "thread-2",
          subject: "Project update",
          from: "Alex <alex@example.com>",
          date: "2026-05-09T09:00:00Z",
          snippet: "Status is green.",
          labels: ["INBOX", "UNREAD"],
        },
      ],
    });
  });

  test("returns normalized mail read results without splitting quoted recipients", async () => {
    let capturedArgs: string[] = [];
    const result = await executeCliCommand(["mail", "read", "msg-1"], {
      runGwsCli: async (args) => {
        capturedArgs = args;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            id: "msg-1",
            threadId: "thread-1",
            payload: {
              headers: [
                { name: "Subject", value: "Project update" },
                { name: "From", value: "Alex <alex@example.com>" },
                {
                  name: "To",
                  value: '"Doe, Jane" <jane@example.com>, ops@example.com',
                },
              ],
              body: {
                data: "SGVsbG8gdGVhbQ",
              },
            },
            labelIds: ["INBOX"],
          }),
          stderr: "",
        };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(capturedArgs.slice(0, 4)).toEqual(["gmail", "users", "messages", "get"]);
    const params = JSON.parse(capturedArgs[capturedArgs.indexOf("--params") + 1] ?? "{}");
    expect(params).toEqual({
      userId: "me",
      id: "msg-1",
      format: "full",
    });
    expect(JSON.parse(result.stdout)).toEqual({
      message: {
        id: "msg-1",
        threadId: "thread-1",
        subject: "Project update",
        from: "Alex <alex@example.com>",
        date: "",
        to: ['"Doe, Jane" <jane@example.com>', "ops@example.com"],
        cc: [],
        snippet: "",
        text: "Hello team",
        labels: ["INBOX"],
      },
    });
  });

  test("returns normalized drive search results", async () => {
    let capturedArgs: string[] = [];
    const result = await executeCliCommand(["drive", "search", "roadmap", "--limit", "4"], {
      runGwsCli: async (args) => {
        capturedArgs = args;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            files: [
              {
                id: "file-1",
                name: "Roadmap",
                mimeType: "application/vnd.google-apps.document",
                modifiedTime: "2026-05-08T12:00:00Z",
                webViewLink: "https://docs.google.com/document/d/file-1/edit",
              },
            ],
          }),
          stderr: "",
        };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(capturedArgs.slice(0, 4)).toEqual(["drive", "files", "list", "--params"]);
    const params = JSON.parse(capturedArgs[capturedArgs.indexOf("--params") + 1] ?? "{}");
    expect(params).toEqual({
      pageSize: 4,
      q: "name contains 'roadmap' or fullText contains 'roadmap'",
      fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
    });
    expect(JSON.parse(result.stdout)).toEqual({
      files: [
        {
          id: "file-1",
          name: "Roadmap",
          mimeType: "application/vnd.google-apps.document",
          modifiedTime: "2026-05-08T12:00:00Z",
          webViewLink: "https://docs.google.com/document/d/file-1/edit",
        },
      ],
    });
  });

  test("returns Google Doc content through drive read routing", async () => {
    const capturedArgs: string[][] = [];
    const result = await executeCliCommand(["drive", "read", "doc-1", "--format", "markdown"], {
      runGwsCli: async (args) => {
        capturedArgs.push(args);
        if (args[0] === "drive") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              id: "doc-1",
              name: "Notes",
              mimeType: "application/vnd.google-apps.document",
              modifiedTime: "2026-05-08T12:00:00Z",
              webViewLink: "https://docs.google.com/document/d/doc-1/edit",
            }),
            stderr: "",
          };
        }

        return {
          exitCode: 0,
          stdout: JSON.stringify({
            tabs: [
              {
                documentTab: {
                  body: {
                    content: [
                      {
                        paragraph: {
                          elements: [
                            {
                              textRun: {
                                content: "Discovery notes",
                              },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
              {
                documentTab: {
                  body: {
                    content: [
                      {
                        paragraph: {
                          elements: [
                            {
                              textRun: {
                                content: "Follow-up actions",
                              },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            ],
            body: {
              content: [
                {
                  paragraph: {
                    elements: [
                      {
                        textRun: {
                          content: "Discovery notes",
                        },
                      },
                    ],
                  },
                },
              ],
            },
          }),
          stderr: "",
        };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(capturedArgs[0]?.slice(0, 4)).toEqual(["drive", "files", "get", "--params"]);
    expect(capturedArgs[1]?.slice(0, 4)).toEqual(["docs", "documents", "get", "--params"]);
    const docParams = JSON.parse(
      capturedArgs[1]?.[(capturedArgs[1]?.indexOf("--params") ?? -1) + 1] ?? "{}"
    );
    expect(docParams).toEqual({
      documentId: "doc-1",
      includeTabsContent: true,
    });
    expect(JSON.parse(result.stdout)).toEqual({
      file: {
        id: "doc-1",
        name: "Notes",
        mimeType: "application/vnd.google-apps.document",
        modifiedTime: "2026-05-08T12:00:00Z",
        webViewLink: "https://docs.google.com/document/d/doc-1/edit",
        text: "Discovery notes\n\nFollow-up actions",
      },
    });
  });

  test("falls back to legacy Google Doc body content when tabs are absent", async () => {
    const result = await executeCliCommand(["drive", "read", "doc-legacy"], {
      runGwsCli: async (args) => {
        if (args[0] === "drive") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              id: "doc-legacy",
              name: "Legacy Notes",
              mimeType: "application/vnd.google-apps.document",
            }),
            stderr: "",
          };
        }

        return {
          exitCode: 0,
          stdout: JSON.stringify({
            body: {
              content: [
                {
                  paragraph: {
                    elements: [
                      {
                        textRun: {
                          content: "Legacy body notes",
                        },
                      },
                    ],
                  },
                },
              ],
            },
          }),
          stderr: "",
        };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      file: {
        id: "doc-legacy",
        name: "Legacy Notes",
        mimeType: "application/vnd.google-apps.document",
        text: "Legacy body notes",
      },
    });
  });

  test("returns Google Sheet rows as json through drive read routing", async () => {
    const capturedArgs: string[][] = [];
    const result = await executeCliCommand(["drive", "read", "sheet-1", "--format", "json"], {
      runGwsCli: async (args) => {
        capturedArgs.push(args);
        if (capturedArgs.length === 1) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              id: "sheet-1",
              name: "Planning",
              mimeType: "application/vnd.google-apps.spreadsheet",
              modifiedTime: "2026-05-08T12:00:00Z",
              webViewLink: "https://docs.google.com/spreadsheets/d/sheet-1/edit",
            }),
            stderr: "",
          };
        }

        if (capturedArgs.length === 2) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              sheets: [
                {
                  properties: {
                    title: "Sheet1",
                    gridProperties: {
                      rowCount: 2,
                      columnCount: 2,
                    },
                  },
                },
              ],
            }),
            stderr: "",
          };
        }

        return {
          exitCode: 0,
          stdout: JSON.stringify({
            values: [
              ["Name", "Status"],
              ["Tessera", "Ready"],
            ],
          }),
          stderr: "",
        };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(capturedArgs[0]?.slice(0, 4)).toEqual(["drive", "files", "get", "--params"]);
    expect(capturedArgs[1]?.slice(0, 4)).toEqual(["sheets", "spreadsheets", "get", "--params"]);
    expect(capturedArgs[2]?.slice(0, 4)).toEqual(["sheets", "spreadsheets", "values", "get"]);
    expect(JSON.parse(result.stdout)).toEqual({
      file: {
        id: "sheet-1",
        name: "Planning",
        mimeType: "application/vnd.google-apps.spreadsheet",
        modifiedTime: "2026-05-08T12:00:00Z",
        webViewLink: "https://docs.google.com/spreadsheets/d/sheet-1/edit",
        rows: [
          ["Name", "Status"],
          ["Tessera", "Ready"],
        ],
      },
    });
  });

  test("reads a requested Google Sheets range", async () => {
    const capturedArgs: string[][] = [];
    const result = await executeCliCommand(
      ["drive", "read", "sheet-1", "--format", "json", "--sheet", "Pipeline", "--range", "A1:C3"],
      {
        runGwsCli: async (args) => {
          capturedArgs.push(args);
          if (capturedArgs.length === 1) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                id: "sheet-1",
                name: "Pipeline",
                mimeType: "application/vnd.google-apps.spreadsheet",
              }),
              stderr: "",
            };
          }

          if (capturedArgs.length === 2) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                sheets: [
                  {
                    properties: {
                      title: "Pipeline",
                      gridProperties: { rowCount: 20, columnCount: 8 },
                    },
                  },
                  {
                    properties: {
                      title: "Archive",
                      gridProperties: { rowCount: 10, columnCount: 4 },
                    },
                  },
                ],
              }),
              stderr: "",
            };
          }

          return {
            exitCode: 0,
            stdout: JSON.stringify({
              values: [
                ["Account", "Stage", "Owner"],
                ["Fomora", "Discovery", "Yumi"],
              ],
            }),
            stderr: "",
          };
        },
      }
    );

    expect(result.exitCode).toBe(0);
    expect(capturedArgs[2]?.slice(0, 4)).toEqual(["sheets", "spreadsheets", "values", "get"]);
    const valuesArgs = capturedArgs[2] ?? [];
    const params = JSON.parse(valuesArgs[valuesArgs.indexOf("--params") + 1] ?? "{}");
    expect(params).toEqual({
      spreadsheetId: "sheet-1",
      range: "'Pipeline'!A1:C3",
    });
  });

  test("returns normalized contacts lookup results", async () => {
    const capturedArgs: string[][] = [];
    const result = await executeCliCommand(["contacts", "lookup", "Alex", "--limit", "2"], {
      runGwsCli: async (args) => {
        capturedArgs.push(args);
        if (capturedArgs.length === 1) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ results: [] }),
            stderr: "",
          };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            results: [
              {
                person: {
                  resourceName: "people/c1",
                  names: [{ displayName: "Alex Rivera" }],
                  emailAddresses: [{ value: "alex@example.com" }],
                  phoneNumbers: [{ value: "+1 555 0100" }],
                  organizations: [{ name: "Fomora" }],
                },
              },
            ],
          }),
          stderr: "",
        };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(capturedArgs).toHaveLength(2);
    expect(capturedArgs[0]?.slice(0, 4)).toEqual([
      "people",
      "people",
      "searchContacts",
      "--params",
    ]);
    const warmupParams = JSON.parse(
      capturedArgs[0]?.[(capturedArgs[0]?.indexOf("--params") ?? -1) + 1] ?? "{}"
    );
    expect(warmupParams).toMatchObject({
      query: "",
      pageSize: 1,
      readMask: "names,emailAddresses,phoneNumbers,organizations",
    });
    expect(capturedArgs[1]?.slice(0, 4)).toEqual([
      "people",
      "people",
      "searchContacts",
      "--params",
    ]);
    const params = JSON.parse(
      capturedArgs[1]?.[(capturedArgs[1]?.indexOf("--params") ?? -1) + 1] ?? "{}"
    );
    expect(params).toEqual({
      query: "Alex",
      pageSize: 2,
      readMask: "names,emailAddresses,phoneNumbers,organizations",
    });
    expect(JSON.parse(result.stdout)).toEqual({
      contacts: [
        {
          resourceName: "people/c1",
          displayName: "Alex Rivera",
          emailAddresses: ["alex@example.com"],
          phoneNumbers: ["+1 555 0100"],
          organizations: ["Fomora"],
        },
      ],
    });
  });

  test("returns usage errors for missing mail search query", async () => {
    const result = await executeCliCommand(["mail", "search"], {
      runGwsCli: async () => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
      }),
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Usage: mail search <query> [--limit <n>]");
  });

  test("returns a stable missing-connection error for gcal", async () => {
    const result = await executeCliCommand(["gcal", "list"], {
      runGwsCli: async () => ({
        exitCode: 2,
        stdout: "",
        stderr: "auth token expired",
      }),
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Settings > Integrations");
  });
});
