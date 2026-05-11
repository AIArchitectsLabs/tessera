import type { PlaybookDetail, PlaybookRunDetail, PlaybookSummary } from "@tessera/contracts";

export interface PlaybookApprovalCopy {
  approve: string;
  prepared: string;
}

export function isDashboardPlaybook(playbook: PlaybookSummary | PlaybookDetail | null): boolean {
  return playbook?.outputs?.some((output) => output.kind === "dashboard") ?? false;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function quoted(value: string): string {
  return `"${value}"`;
}

function approvalArg(run: PlaybookRunDetail, key: string): string | undefined {
  return stringValue(run.approval?.args?.[key]);
}

function inputValue(run: PlaybookRunDetail, key: string): string | undefined {
  return stringValue(run.input?.[key]);
}

export function playbookApprovalCopy(
  run: PlaybookRunDetail,
  playbook: PlaybookSummary | PlaybookDetail | null
): PlaybookApprovalCopy {
  if (playbook?.id === "sales.meeting-brief" && run.approval?.toolId === "workspace.writeProbe") {
    const company = inputValue(run, "company");
    const stakeholder = inputValue(run, "stakeholder");
    const target = approvalArg(run, "target") ?? inputValue(run, "approvalTarget");
    const objective = approvalArg(run, "value") ?? inputValue(run, "objective");
    const meetingFor = [company, stakeholder].filter(Boolean).join(" with ");
    const preparedSubject = meetingFor ? ` for ${meetingFor}` : "";
    const targetCopy = target ? ` and is ready to prepare ${quoted(target)} in your workspace` : "";
    const objectiveCopy = objective ? ` Objective: ${objective}` : "";

    return {
      prepared: `Tessera drafted the meeting brief${preparedSubject}${targetCopy}.${objectiveCopy}`,
      approve: target
        ? `Tessera will add the meeting preparation item ${quoted(target)} to your workspace.`
        : "Tessera will add the meeting preparation item to your workspace.",
    };
  }

  if (run.approval?.toolId === "workspace.writeProbe") {
    const target = approvalArg(run, "target");
    const value = approvalArg(run, "value");
    return {
      prepared: target
        ? `Tessera is ready to prepare ${quoted(target)} in your workspace${
            value ? ` using ${quoted(value)}` : ""
          }.`
        : "Tessera is ready to prepare the next workspace step.",
      approve: "Tessera will add this preparation step to your workspace.",
    };
  }

  return {
    prepared: run.approval?.preview ?? "Tessera has prepared the next step.",
    approve: "Tessera will apply these changes to your workspace.",
  };
}
