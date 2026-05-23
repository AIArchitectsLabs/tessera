import type { ShellCommandName, ShellToolCall } from "@tessera/contracts";

export interface CliSubcommandPolicy {
  subcommand: string;
  approval: "allow" | "ask";
  help: string;
}

export interface CliCommandCatalogEntry {
  command: ShellCommandName;
  help: string;
  subcommands: CliSubcommandPolicy[];
}

export const CLI_CATALOG: CliCommandCatalogEntry[] = [
  {
    command: "web-search",
    help: "Search the web with a configured search backend.",
    subcommands: [{ subcommand: "search", approval: "allow", help: "Run a search query." }],
  },
  {
    command: "web-fetch",
    help: "Fetch and extract a specific web page.",
    subcommands: [{ subcommand: "fetch", approval: "allow", help: "Fetch a URL." }],
  },
  {
    command: "gcal",
    help: "Read and manage calendar events.",
    subcommands: [
      { subcommand: "list", approval: "allow", help: "List events." },
      { subcommand: "read", approval: "allow", help: "Read one event." },
      { subcommand: "create", approval: "ask", help: "Create an event." },
      { subcommand: "update", approval: "ask", help: "Update an event." },
      { subcommand: "delete", approval: "ask", help: "Delete an event." },
    ],
  },
  {
    command: "mail",
    help: "Read and draft email.",
    subcommands: [
      { subcommand: "list", approval: "allow", help: "List recent mail." },
      { subcommand: "read", approval: "allow", help: "Read one message." },
      { subcommand: "search", approval: "allow", help: "Search mail." },
      { subcommand: "draft", approval: "ask", help: "Draft a reply." },
    ],
  },
  {
    command: "drive",
    help: "Search and read drive content.",
    subcommands: [
      { subcommand: "search", approval: "allow", help: "Search drive files." },
      { subcommand: "read", approval: "allow", help: "Read a drive file." },
    ],
  },
  {
    command: "sheets",
    help: "Preview and request approved Google Sheets workbook and row writes.",
    subcommands: [
      {
        subcommand: "rows.upsert",
        approval: "ask",
        help: "Preview or execute an approved row upsert.",
      },
      {
        subcommand: "rows.append",
        approval: "ask",
        help: "Preview or execute an approved idempotent row append.",
      },
      {
        subcommand: "rows.updateStatus",
        approval: "ask",
        help: "Preview or execute an approved status update.",
      },
      {
        subcommand: "workbook.create",
        approval: "ask",
        help: "Preview or execute an approved supplier workbook creation.",
      },
    ],
  },
  {
    command: "docs",
    help: "Preview and request approved Google Docs document writes.",
    subcommands: [
      {
        subcommand: "documents.create",
        approval: "ask",
        help: "Preview or execute an approved document creation.",
      },
      {
        subcommand: "documents.appendText",
        approval: "ask",
        help: "Preview or execute an approved text append.",
      },
      {
        subcommand: "documents.replacePlaceholders",
        approval: "ask",
        help: "Preview or execute approved placeholder replacement.",
      },
    ],
  },
  {
    command: "contacts",
    help: "Look up contacts.",
    subcommands: [{ subcommand: "lookup", approval: "allow", help: "Look up a contact." }],
  },
];

export function findCliCommand(call: ShellToolCall): CliSubcommandPolicy | undefined {
  return CLI_CATALOG.find((entry) => entry.command === call.command)?.subcommands.find(
    (subcommand) => subcommand.subcommand === call.subcommand
  );
}

export function formatCliCatalogLine(entry: CliCommandCatalogEntry): string {
  const subcommands = entry.subcommands.map((item) => item.subcommand).join(", ");
  return `${entry.command}: ${subcommands}`;
}

export function formatShellPreview(call: ShellToolCall): string {
  return [call.command, call.subcommand, ...call.args].join(" ").trim();
}
