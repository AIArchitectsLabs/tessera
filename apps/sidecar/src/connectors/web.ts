import type { GraphConnector } from "@tessera/core";
import type { ConnectorContext } from "./context.js";

export const webConnector: GraphConnector<ConnectorContext> = {
  adapterId: "web",
  label: "Web",
  effects: [],
  tools: [
    {
      capability: "web.search",
      sideEffect: "read",
      idempotent: true,
      shellAllowlist: [{ command: "web-search", subcommand: "search" }],
    },
    {
      capability: "web.fetch",
      sideEffect: "read",
      idempotent: true,
      shellAllowlist: [{ command: "web-fetch", subcommand: "fetch" }],
    },
    {
      capability: "integration.web.search",
      sideEffect: "read",
      idempotent: true,
      shellAllowlist: [{ command: "web-search", subcommand: "search" }],
    },
    {
      capability: "integration.web.fetch",
      sideEffect: "read",
      idempotent: true,
      shellAllowlist: [{ command: "web-fetch", subcommand: "fetch" }],
    },
  ],
};
