import type {
  BrowserAction,
  BrowserRecipePermission,
  BrowserRecipeProposal,
  BrowserRecipeStep,
} from "@tessera/contracts";
import { BrowserRecipeProposalSchema } from "@tessera/contracts";

export interface BrowserRecipeActionInput {
  action: BrowserAction;
  url?: string;
  selector?: string;
  text?: string;
  expectedState?: string;
  fallbackLabel?: string;
}

export interface BuildBrowserRecipeProposalInput {
  goal: string;
  sessionId?: string;
  taskId?: string;
  createdAt?: string;
  actions: BrowserRecipeActionInput[];
  artifacts: Array<{ title: string; path: string }>;
}

const ACTION_PERMISSIONS = new Set<BrowserAction>(["click", "type", "select"]);

function domainFromActions(actions: BrowserRecipeActionInput[]): string {
  const firstUrl = actions.find((action) => action.url)?.url;
  if (!firstUrl) return "unknown";
  return new URL(firstUrl).hostname;
}

function permissionsFor(actions: BrowserRecipeActionInput[]): BrowserRecipePermission[] {
  const permissions: BrowserRecipePermission[] = ["browser.read"];
  if (actions.some((action) => ACTION_PERMISSIONS.has(action.action))) {
    permissions.push("browser.action");
  }
  if (actions.some((action) => action.action === "eval")) {
    permissions.push("browser.eval");
  }
  return permissions;
}

function stepFromAction(action: BrowserRecipeActionInput): BrowserRecipeStep {
  const step: BrowserRecipeStep = { action: action.action };
  if (action.url) step.url = action.url;
  if (action.selector) step.selector = action.selector;
  if (action.text !== undefined) step.text = action.text;
  if (action.expectedState) step.expectedState = action.expectedState;
  if (action.fallbackLabel) step.fallbackLabel = action.fallbackLabel;
  return step;
}

export function buildBrowserRecipeProposal(
  input: BuildBrowserRecipeProposalInput
): BrowserRecipeProposal {
  const domain = domainFromActions(input.actions);
  const sessionSuffix = input.sessionId ?? "session";
  return BrowserRecipeProposalSchema.parse({
    id: `recipe-${domain}-${sessionSuffix}`.replace(/[^a-zA-Z0-9._-]/g, "-"),
    status: "draft",
    domain,
    goal: input.goal.trim(),
    source: {
      taskId: input.taskId,
      sessionId: input.sessionId,
    },
    permissions: permissionsFor(input.actions),
    steps: input.actions.map(stepFromAction),
    artifacts: input.artifacts,
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
}
