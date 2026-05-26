import type {
  PlaybookGraphArtifactWriteAdapterInput,
  PlaybookGraphEffectAdapterInput,
  PlaybookGraphEffectAdapterResult,
  PlaybookGraphToolAdapterInput,
} from "./playbook-graph-runtime.js";

export interface GraphConnectorShellCommand {
  command: string;
  subcommand: string;
}

// adapterId is not declared here: effects are grouped under a GraphConnector, and the
// registry stamps the parent connector's adapterId into the derived effect policy key.
export interface GraphConnectorEffect<Ctx> {
  effectId: string;
  capability: string;
  sideEffect: "write" | "external";
  idempotent: boolean;
  previewRequired: boolean;
  approvalRequired: boolean;
  handler: (
    input: PlaybookGraphEffectAdapterInput,
    ctx: Ctx
  ) => Promise<PlaybookGraphEffectAdapterResult> | PlaybookGraphEffectAdapterResult;
}

export interface GraphConnectorTool<Ctx> {
  capability: string;
  sideEffect: "read" | "write" | "external";
  idempotent: boolean;
  shellAllowlist?: GraphConnectorShellCommand[];
  handler?: (input: PlaybookGraphToolAdapterInput, ctx: Ctx) => Promise<unknown> | unknown;
}

export interface GraphConnectorArtifactWrite<Ctx> {
  capability: string;
  handler: (input: PlaybookGraphArtifactWriteAdapterInput, ctx: Ctx) => Promise<unknown> | unknown;
}

export interface GraphConnector<Ctx> {
  adapterId: string;
  label: string;
  effects: GraphConnectorEffect<Ctx>[];
  tools: GraphConnectorTool<Ctx>[];
  artifactWrite?: GraphConnectorArtifactWrite<Ctx>;
}
