import type { IpcEnvelope } from "@tessera/contracts";

// Public contract for Tessera plugins and MCP servers.
// This is the only package external plugin authors should depend on.

export { definePlaybook } from "./playbook.js";
export type { PlaybookGraph } from "@tessera/contracts";

export interface Plugin {
  name: string;
  version: string;
  onMessage?: (envelope: IpcEnvelope) => Promise<IpcEnvelope | undefined>;
}
