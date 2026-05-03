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
