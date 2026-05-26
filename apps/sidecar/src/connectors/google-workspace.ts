import { ShellToolCallSchema } from "@tessera/contracts";
import type { GraphConnector } from "@tessera/core";
import type { ConnectorContext } from "./context.js";
import { isPlainRecord } from "./workspace-materialization.js";

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function gmailDraftEffectRequests(input: Record<string, unknown>): Array<{
  supplierId?: string;
  to: string;
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
}> {
  const value = isPlainRecord(input.value) ? input.value : input;
  const requests = Array.isArray(value.requests) ? value.requests : [];
  return requests.map((item, index) => {
    if (!isPlainRecord(item)) {
      throw new Error(`mail.draft effect request ${index + 1} must be an object`);
    }
    if (item.command !== "mail" || item.subcommand !== "draft") {
      throw new Error(`mail.draft effect request ${index + 1} must use mail draft`);
    }
    const to = typeof item.to === "string" ? item.to.trim() : "";
    const subject = typeof item.subject === "string" ? item.subject : "";
    const body = typeof item.body === "string" ? item.body : "";
    if (!to || !subject || !body) {
      throw new Error(`mail.draft effect request ${index + 1} requires to, subject, and body`);
    }
    return {
      ...(typeof item.supplierId === "string" ? { supplierId: item.supplierId } : {}),
      to,
      cc: stringArray(item.cc),
      bcc: stringArray(item.bcc),
      subject,
      body,
    };
  });
}

function mailDraftShellArgs(
  request: ReturnType<typeof gmailDraftEffectRequests>[number]
): string[] {
  const args = ["--to", request.to, "--subject", request.subject, "--body", request.body];
  if (request.cc.length > 0) args.push("--cc", request.cc.join(", "));
  if (request.bcc.length > 0) args.push("--bcc", request.bcc.join(", "));
  return args;
}

function gmailDraftIdFromParsed(value: unknown): string {
  const draft = isPlainRecord(value) && isPlainRecord(value.draft) ? value.draft : undefined;
  const id = typeof draft?.id === "string" ? draft.id : undefined;
  if (!id) throw new Error("mail.draft effect did not return a Gmail draft id");
  return id;
}

function gmailDraftReference(input: Record<string, unknown>, draftIds: string[]): string {
  const target = isPlainRecord(input.target) ? input.target : undefined;
  if (target?.kind === "external" && typeof target.reference === "string") {
    return draftIds.length > 0 ? `${target.reference}:${draftIds.join(",")}` : target.reference;
  }
  return draftIds.length > 0 ? `gmail:drafts:${draftIds.join(",")}` : "gmail:drafts:none";
}

type SheetsEffectOperation = {
  id: string;
  subcommand: "workbook.create" | "rows.upsert" | "rows.append" | "rows.updateStatus";
  idempotencyKey: string;
  table?: string;
  row?: Record<string, unknown>;
  args?: Record<string, unknown>;
};

function sheetsEffectPlan(input: Record<string, unknown>): {
  workbook: { spreadsheetId: string; title: string };
  operations: SheetsEffectOperation[];
} {
  const value = isPlainRecord(input.value) ? input.value : input;
  const workbookValue = isPlainRecord(value.workbook) ? value.workbook : {};
  const workbook = {
    spreadsheetId:
      typeof workbookValue.spreadsheetId === "string" ? workbookValue.spreadsheetId : "",
    title: typeof workbookValue.title === "string" ? workbookValue.title : "Supplier RFQ Ledger",
  };
  const operations = Array.isArray(value.operations) ? value.operations : [];
  return {
    workbook,
    operations: operations.map((item, index) => {
      if (!isPlainRecord(item)) {
        throw new Error(`sheets effect operation ${index + 1} must be an object`);
      }
      if (item.command !== "sheets") {
        throw new Error(`sheets effect operation ${index + 1} must use sheets`);
      }
      if (
        item.subcommand !== "workbook.create" &&
        item.subcommand !== "rows.upsert" &&
        item.subcommand !== "rows.append" &&
        item.subcommand !== "rows.updateStatus"
      ) {
        throw new Error(`Unsupported sheets effect operation: ${String(item.subcommand)}`);
      }
      const id = typeof item.id === "string" ? item.id : `operation-${index + 1}`;
      const idempotencyKey =
        typeof item.idempotencyKey === "string" ? item.idempotencyKey : undefined;
      if (!idempotencyKey) {
        throw new Error(`sheets effect operation ${id} requires idempotencyKey`);
      }
      return {
        id,
        subcommand: item.subcommand,
        idempotencyKey,
        ...(typeof item.table === "string" ? { table: item.table } : {}),
        ...(isPlainRecord(item.row) ? { row: item.row } : {}),
        ...(isPlainRecord(item.args) ? { args: item.args } : {}),
      };
    }),
  };
}

function sheetRowKey(operation: SheetsEffectOperation): { column: string; value: string } {
  const keyColumn = typeof operation.args?.keyColumn === "string" ? operation.args.keyColumn : "";
  const keyValue = typeof operation.args?.keyValue === "string" ? operation.args.keyValue : "";
  if (keyColumn && keyValue) return { column: keyColumn, value: keyValue };
  const table = operation.table;
  const row = operation.row ?? {};
  if (table === "RFQs" && typeof row["batch id"] === "string") {
    return { column: "batch id", value: row["batch id"] };
  }
  if (typeof row["supplier id"] === "string") {
    return { column: "supplier id", value: row["supplier id"] };
  }
  throw new Error(`sheets ${operation.subcommand} operation ${operation.id} needs a row key`);
}

function sheetsOperationArgs(
  operation: SheetsEffectOperation,
  spreadsheetId: string,
  approvalId: string
): string[] {
  const base = [
    "--execute",
    "--approval",
    approvalId,
    "--idempotency-key",
    operation.idempotencyKey,
  ];
  if (operation.subcommand === "workbook.create") {
    const title =
      typeof operation.args?.title === "string" ? operation.args.title : "Supplier RFQ Ledger";
    return ["--title", title, ...base];
  }
  if (!spreadsheetId) {
    throw new Error(`sheets ${operation.subcommand} operation ${operation.id} needs spreadsheetId`);
  }
  const table = operation.table;
  if (!table)
    throw new Error(`sheets ${operation.subcommand} operation ${operation.id} needs table`);
  if (operation.subcommand === "rows.upsert") {
    const row = operation.row;
    if (!row) throw new Error(`sheets rows.upsert operation ${operation.id} needs row`);
    const key = sheetRowKey(operation);
    return [
      "--spreadsheet",
      spreadsheetId,
      "--table",
      table,
      "--key-column",
      key.column,
      "--key-value",
      key.value,
      "--row-json",
      JSON.stringify(row),
      ...base,
    ];
  }
  if (operation.subcommand === "rows.append") {
    const row = operation.row;
    if (!row) throw new Error(`sheets rows.append operation ${operation.id} needs row`);
    const clientRowId =
      typeof operation.args?.clientRowId === "string" ? operation.args.clientRowId : operation.id;
    return [
      "--spreadsheet",
      spreadsheetId,
      "--table",
      table,
      "--row-json",
      JSON.stringify(row),
      "--client-row-id",
      clientRowId,
      ...base,
    ];
  }
  const key = sheetRowKey(operation);
  const status = typeof operation.args?.status === "string" ? operation.args.status : "";
  if (!status) throw new Error(`sheets rows.updateStatus operation ${operation.id} needs status`);
  return [
    "--spreadsheet",
    spreadsheetId,
    "--table",
    table,
    "--key-column",
    key.column,
    "--key-value",
    key.value,
    "--status",
    status,
    ...base,
  ];
}

function spreadsheetIdFromParsed(value: unknown): string | undefined {
  return isPlainRecord(value) && typeof value.spreadsheetId === "string"
    ? value.spreadsheetId
    : undefined;
}

function sheetsReference(input: Record<string, unknown>, spreadsheetId: string): string {
  const target = isPlainRecord(input.target) ? input.target : undefined;
  if (target?.kind === "external" && typeof target.reference === "string") {
    return spreadsheetId ? `${target.reference}:${spreadsheetId}` : target.reference;
  }
  return spreadsheetId ? `google-sheets:${spreadsheetId}` : "google-sheets:unknown";
}

type DocsEffectOperation = {
  id: string;
  subcommand: "documents.create" | "documents.appendText" | "documents.replacePlaceholders";
  idempotencyKey: string;
  documentId?: string;
  title?: string;
  text?: string;
  replacements?: Record<string, string>;
};

function docsEffectPlan(input: Record<string, unknown>): { operations: DocsEffectOperation[] } {
  const value = isPlainRecord(input.value) ? input.value : input;
  const operationsValue = Array.isArray(value.operations) ? value.operations : [value];
  return {
    operations: operationsValue.map((item, index) => {
      if (!isPlainRecord(item)) {
        throw new Error(`docs effect operation ${index + 1} must be an object`);
      }
      if (item.command !== undefined && item.command !== "docs") {
        throw new Error(`docs effect operation ${index + 1} must use docs`);
      }
      if (
        item.subcommand !== "documents.create" &&
        item.subcommand !== "documents.appendText" &&
        item.subcommand !== "documents.replacePlaceholders"
      ) {
        throw new Error(`Unsupported docs effect operation: ${String(item.subcommand)}`);
      }
      const args = isPlainRecord(item.args) ? item.args : {};
      const id = typeof item.id === "string" ? item.id : `operation-${index + 1}`;
      const idempotencyKey =
        typeof item.idempotencyKey === "string" ? item.idempotencyKey : undefined;
      if (!idempotencyKey) {
        throw new Error(`docs effect operation ${id} requires idempotencyKey`);
      }
      const replacementsValue = item.replacements ?? args.replacements;
      const replacements = isPlainRecord(replacementsValue)
        ? Object.fromEntries(
            Object.entries(replacementsValue).filter(
              (entry): entry is [string, string] =>
                typeof entry[0] === "string" && typeof entry[1] === "string"
            )
          )
        : undefined;
      return {
        id,
        subcommand: item.subcommand,
        idempotencyKey,
        ...(typeof item.documentId === "string"
          ? { documentId: item.documentId }
          : typeof args.documentId === "string"
            ? { documentId: args.documentId }
            : {}),
        ...(typeof item.title === "string"
          ? { title: item.title }
          : typeof args.title === "string"
            ? { title: args.title }
            : {}),
        ...(typeof item.text === "string"
          ? { text: item.text }
          : typeof args.text === "string"
            ? { text: args.text }
            : {}),
        ...(replacements && Object.keys(replacements).length > 0 ? { replacements } : {}),
      };
    }),
  };
}

function docsOperationArgs(
  operation: DocsEffectOperation,
  documentId: string,
  approvalId: string
): string[] {
  const base = [
    "--execute",
    "--approval",
    approvalId,
    "--idempotency-key",
    operation.idempotencyKey,
  ];
  if (operation.subcommand === "documents.create") {
    const title = operation.title;
    if (!title) throw new Error(`docs documents.create operation ${operation.id} needs title`);
    const args = ["--title", title];
    if (operation.text) args.push("--text", operation.text);
    return [...args, ...base];
  }
  const resolvedDocumentId = operation.documentId ?? documentId;
  if (!resolvedDocumentId) {
    throw new Error(`docs ${operation.subcommand} operation ${operation.id} needs documentId`);
  }
  if (operation.subcommand === "documents.appendText") {
    const text = operation.text;
    if (!text) throw new Error(`docs documents.appendText operation ${operation.id} needs text`);
    return ["--document", resolvedDocumentId, "--text", text, ...base];
  }
  const replacements = operation.replacements;
  if (!replacements || Object.keys(replacements).length === 0) {
    throw new Error(
      `docs documents.replacePlaceholders operation ${operation.id} needs replacements`
    );
  }
  return [
    "--document",
    resolvedDocumentId,
    "--replacements-json",
    JSON.stringify(replacements),
    ...base,
  ];
}

function documentIdFromParsed(value: unknown): string | undefined {
  return isPlainRecord(value) && typeof value.documentId === "string"
    ? value.documentId
    : undefined;
}

function docsReference(input: Record<string, unknown>, documentId: string): string {
  const target = isPlainRecord(input.target) ? input.target : undefined;
  if (target?.kind === "external" && typeof target.reference === "string") {
    return documentId ? `${target.reference}:${documentId}` : target.reference;
  }
  return documentId ? `google-docs:${documentId}` : "google-docs:unknown";
}

export const googleWorkspaceConnector: GraphConnector<ConnectorContext> = {
  adapterId: "google-workspace",
  label: "Google Workspace",
  effects: [
    {
      effectId: "mail.draft",
      capability: "integration.mail.drafts.write",
      sideEffect: "external",
      idempotent: true,
      previewRequired: true,
      approvalRequired: true,
      handler: async ({ node }, ctx) => {
        const requests = gmailDraftEffectRequests(node.input);
        const draftIds: string[] = [];
        for (const request of requests) {
          const result = await ctx.shell.executeShell(
            ShellToolCallSchema.parse({
              command: "mail",
              subcommand: "draft",
              args: mailDraftShellArgs(request),
            })
          );
          draftIds.push(gmailDraftIdFromParsed(result.parsed));
        }
        const reference = gmailDraftReference(node.input, draftIds);
        return {
          outputReference: reference,
          output: {
            kind: "external",
            reference,
            connectorId: "google-workspace",
            label:
              draftIds.length === 1
                ? "1 Gmail draft created"
                : `${draftIds.length} Gmail drafts created`,
          },
        };
      },
    },
    {
      effectId: "sheets.ledger.write",
      capability: "integration.sheets.rows.write",
      sideEffect: "external",
      idempotent: true,
      previewRequired: true,
      approvalRequired: true,
      handler: async ({ node, queueEntry }, ctx) => {
        const plan = sheetsEffectPlan(node.input);
        let spreadsheetId = plan.workbook.spreadsheetId;
        let operationCount = 0;
        for (const operation of plan.operations) {
          const approvalId = `${queueEntry.queueEntryId}:${operation.id}`;
          const result = await ctx.shell.executeShell(
            ShellToolCallSchema.parse({
              command: "sheets",
              subcommand: operation.subcommand,
              args: sheetsOperationArgs(operation, spreadsheetId, approvalId),
            }),
            {
              TESSERA_GWS_WRITE_EXECUTION_TOKEN: ctx.mintWriteToken(
                approvalId,
                operation.idempotencyKey
              ),
            }
          );
          spreadsheetId = spreadsheetIdFromParsed(result.parsed) ?? spreadsheetId;
          operationCount += 1;
        }
        const reference = sheetsReference(node.input, spreadsheetId);
        return {
          outputReference: reference,
          output: {
            kind: "external",
            reference,
            connectorId: "google-workspace",
            label: `${operationCount} Google Sheets operations completed`,
          },
        };
      },
    },
    {
      effectId: "docs.document.write",
      capability: "integration.docs.documents.write",
      sideEffect: "external",
      idempotent: true,
      previewRequired: true,
      approvalRequired: true,
      handler: async ({ node, queueEntry }, ctx) => {
        const plan = docsEffectPlan(node.input);
        let documentId = "";
        let operationCount = 0;
        for (const operation of plan.operations) {
          const approvalId = `${queueEntry.queueEntryId}:${operation.id}`;
          const result = await ctx.shell.executeShell(
            ShellToolCallSchema.parse({
              command: "docs",
              subcommand: operation.subcommand,
              args: docsOperationArgs(operation, documentId, approvalId),
            }),
            {
              TESSERA_GWS_WRITE_EXECUTION_TOKEN: ctx.mintWriteToken(
                approvalId,
                operation.idempotencyKey
              ),
            }
          );
          documentId = documentIdFromParsed(result.parsed) ?? documentId;
          operationCount += 1;
        }
        const reference = docsReference(node.input, documentId);
        return {
          outputReference: reference,
          output: {
            kind: "external",
            reference,
            connectorId: "google-workspace",
            label:
              operationCount === 1
                ? "1 Google Docs operation completed"
                : `${operationCount} Google Docs operations completed`,
          },
        };
      },
    },
  ],
  tools: [
    {
      capability: "integration.calendar.events.read",
      sideEffect: "read",
      idempotent: true,
      shellAllowlist: [
        { command: "gcal", subcommand: "list" },
        { command: "gcal", subcommand: "read" },
      ],
    },
    {
      capability: "integration.mail.messages.read",
      sideEffect: "read",
      idempotent: true,
      shellAllowlist: [
        { command: "mail", subcommand: "list" },
        { command: "mail", subcommand: "search" },
        { command: "mail", subcommand: "read" },
      ],
    },
    {
      capability: "integration.drive.files.read",
      sideEffect: "read",
      idempotent: true,
      shellAllowlist: [
        { command: "drive", subcommand: "search" },
        { command: "drive", subcommand: "read" },
      ],
    },
    {
      capability: "integration.contacts.read",
      sideEffect: "read",
      idempotent: true,
      shellAllowlist: [{ command: "contacts", subcommand: "lookup" }],
    },
  ],
};
