import { canonicalCapability } from "@tessera/contracts";
import type {
  GraphConnector,
  GraphConnectorArtifactWrite,
  GraphConnectorEffect,
  GraphConnectorShellCommand,
  GraphConnectorTool,
} from "./graph-connector.js";
import type {
  PlaybookGraphArtifactWriteAdapterInput,
  PlaybookGraphEffectAdapterInput,
  PlaybookGraphEffectAdapterResult,
  PlaybookGraphEffectExecutionPolicy,
  PlaybookGraphToolAdapterInput,
  PlaybookGraphToolExecutionPolicy,
} from "./playbook-graph-runtime.js";

export interface GraphConnectorRegistry {
  effectAdapter: (
    input: PlaybookGraphEffectAdapterInput
  ) => Promise<PlaybookGraphEffectAdapterResult>;
  toolAdapter: (input: PlaybookGraphToolAdapterInput) => Promise<unknown>;
  artifactWriteAdapter: (input: PlaybookGraphArtifactWriteAdapterInput) => Promise<unknown>;
  effectPolicies: Record<string, PlaybookGraphEffectExecutionPolicy>;
  toolPolicies: Record<string, PlaybookGraphToolExecutionPolicy>;
  shellAllowlist: Record<string, GraphConnectorShellCommand[]>;
  capabilities: string[];
}

export interface BuildConnectorRegistryOptions<Ctx> {
  connectors: GraphConnector<Ctx>[];
  ctx: Ctx;
  shellToolAdapter: (input: PlaybookGraphToolAdapterInput) => Promise<unknown> | unknown;
}

function assertCanonical(capability: string, where: string): void {
  if (canonicalCapability(capability) === undefined) {
    throw new Error(`Connector ${where} references unknown capability: ${capability}`);
  }
}

export function buildConnectorRegistry<Ctx>(
  options: BuildConnectorRegistryOptions<Ctx>
): GraphConnectorRegistry {
  const { connectors, ctx, shellToolAdapter } = options;

  const effects = new Map<string, GraphConnectorEffect<Ctx>>();
  const tools = new Map<string, GraphConnectorTool<Ctx>>();
  const toolAdapterIds = new Map<string, string>();
  const effectPolicies: Record<string, PlaybookGraphEffectExecutionPolicy> = {};
  const toolPolicies: Record<string, PlaybookGraphToolExecutionPolicy> = {};
  const shellAllowlist: Record<string, GraphConnectorShellCommand[]> = {};
  const capabilities = new Set<string>();
  let artifactWrite:
    | { adapterId: string; descriptor: GraphConnectorArtifactWrite<Ctx> }
    | undefined;

  for (const connector of connectors) {
    for (const effect of connector.effects) {
      const key = `${connector.adapterId}:${effect.effectId}`;
      if (effects.has(key)) {
        throw new Error(`Duplicate connector effect: ${key}`);
      }
      if (effect.approvalRequired && !effect.previewRequired) {
        throw new Error(`Connector effect ${key} requires approval but not preview`);
      }
      assertCanonical(effect.capability, `effect ${key}`);
      effects.set(key, effect);
      effectPolicies[key] = {
        effectId: effect.effectId,
        capability: effect.capability,
        adapterId: connector.adapterId,
        idempotent: effect.idempotent,
        sideEffect: effect.sideEffect,
        previewRequired: effect.previewRequired,
        approvalRequired: effect.approvalRequired,
      };
      capabilities.add(effect.capability);
    }

    for (const tool of connector.tools) {
      if (tools.has(tool.capability)) {
        const firstAdapterId = toolAdapterIds.get(tool.capability);
        throw new Error(
          `Duplicate connector tool capability: ${tool.capability} (first registered by ${firstAdapterId}, conflict in ${connector.adapterId})`
        );
      }
      if (!tool.handler && !(tool.shellAllowlist && tool.shellAllowlist.length > 0)) {
        throw new Error(
          `Connector tool ${tool.capability} has no handler and no shellAllowlist`
        );
      }
      assertCanonical(tool.capability, `tool ${tool.capability}`);
      tools.set(tool.capability, tool);
      toolAdapterIds.set(tool.capability, connector.adapterId);
      toolPolicies[tool.capability] = {
        capability: tool.capability,
        idempotent: tool.idempotent,
        sideEffect: tool.sideEffect,
      };
      if (tool.shellAllowlist) {
        shellAllowlist[tool.capability] = tool.shellAllowlist;
      }
      capabilities.add(tool.capability);
    }

    if (connector.artifactWrite) {
      if (artifactWrite) {
        throw new Error(
          `Multiple connectors declare artifactWrite: ${artifactWrite.adapterId}, ${connector.adapterId}`
        );
      }
      assertCanonical(
        connector.artifactWrite.capability,
        `artifactWrite (${connector.adapterId})`
      );
      artifactWrite = { adapterId: connector.adapterId, descriptor: connector.artifactWrite };
      capabilities.add(connector.artifactWrite.capability);
    }
  }

  return {
    effectAdapter: async (input) => {
      const key = `${input.node.adapterId}:${input.node.effectId}`;
      const effect = effects.get(key);
      if (!effect) {
        throw new Error(`Unsupported effect adapter: ${key}`);
      }
      return effect.handler(input, ctx);
    },
    toolAdapter: async (input) => {
      const tool = tools.get(input.node.capability);
      if (!tool) {
        throw new Error(
          `No graph tool adapter registered for capability: ${input.node.capability}`
        );
      }
      if (tool.handler) {
        return tool.handler(input, ctx);
      }
      return shellToolAdapter(input);
    },
    artifactWriteAdapter: async (input) => {
      if (!artifactWrite) {
        throw new Error("No connector declares an artifactWrite handler");
      }
      return artifactWrite.descriptor.handler(input, ctx);
    },
    effectPolicies,
    toolPolicies,
    shellAllowlist,
    capabilities: [...capabilities],
  };
}
