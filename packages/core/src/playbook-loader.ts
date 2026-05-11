import { type PlaybookManifest, PlaybookManifestSchema } from "@tessera/contracts";
import { TERMINAL_STEPS } from "./workflow-constants.js";

const FILE_PREFIX = "file:";

export interface LoadPlaybookManifestOptions {
  manifestJson: unknown;
  prompts?: Record<string, string>;
}

export function loadPlaybookManifest(options: LoadPlaybookManifestOptions): PlaybookManifest {
  const promptsMap = options.prompts ?? {};
  const manifest = PlaybookManifestSchema.parse(options.manifestJson);

  const resolvedSteps = manifest.workflow.steps.map((step) => {
    if (step.kind !== "agent") return step;
    if (!step.prompt.startsWith(FILE_PREFIX)) return step;

    const relativePath = step.prompt.slice(FILE_PREFIX.length);
    if (!relativePath.startsWith("prompts/") || relativePath.includes("..")) {
      throw new Error(`Prompt reference must point inside prompts/: ${step.prompt}`);
    }

    const promptText = promptsMap[relativePath];
    if (promptText === undefined) {
      throw new Error(`Missing prompt file referenced by step ${step.id}: ${relativePath}`);
    }

    return { ...step, prompt: promptText };
  });

  const resolved: PlaybookManifest = {
    ...manifest,
    workflow: { ...manifest.workflow, steps: resolvedSteps },
  };

  const stepIds = new Set(resolved.workflow.steps.map((step) => step.id));
  if (!stepIds.has(resolved.workflow.start)) {
    throw new Error(`Unknown workflow start step: ${resolved.workflow.start}`);
  }
  for (const step of resolved.workflow.steps) {
    for (const next of [step.onSuccess, step.onFailure]) {
      if (next && !stepIds.has(next) && !TERMINAL_STEPS.has(next)) {
        throw new Error(`Unknown workflow transition from ${step.id}: ${next}`);
      }
    }
  }

  return resolved;
}
