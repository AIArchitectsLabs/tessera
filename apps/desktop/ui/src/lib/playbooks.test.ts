import { describe, expect, test } from "bun:test";
import type { PlaybookRunDetail, PlaybookSummary } from "@tessera/contracts";
import { playbookApprovalCopy } from "./playbooks";

describe("playbook UI helpers", () => {
  test("turns Sales Meeting Brief approval previews into business copy", () => {
    const playbook: PlaybookSummary = {
      id: "sales.meeting-brief",
      version: 1,
      name: "Sales Meeting Brief",
      description: "Creates a source-aware customer meeting brief.",
      businessUseCase: "Prepare for a customer or prospect meeting",
      optionalCapabilities: [],
      requiredCapabilities: [],
      outputs: [],
      phases: ["Prepare", "Review"],
      stepCount: 2,
    };
    const run = {
      runId: "run-1",
      workflowId: "sales.meeting-brief",
      status: "blocked",
      input: {
        company: "Fomora",
        stakeholder: "Yumi AI",
        objective: "Understand core capabilities and pricing.",
        approvalTarget: "meeting-prep",
      },
      approval: {
        toolId: "workspace.writeProbe",
        args: {
          target: "meeting-prep",
          value: "Understand core capabilities and pricing.",
        },
        capability: "write",
        risk: {
          mutates: true,
          destructive: false,
          external: false,
          reversible: true,
          dryRunSupported: true,
        },
        preview: "write-probe target=meeting-prep value=Understand core capabilities and pricing.",
        reasonCode: "write_requires_approval",
      },
      sourceGaps: [],
    } satisfies PlaybookRunDetail;

    expect(playbookApprovalCopy(run, playbook)).toEqual({
      prepared:
        'Tessera drafted the meeting brief for Fomora with Yumi AI and is ready to prepare "meeting-prep" in your workspace. Objective: Understand core capabilities and pricing.',
      approve: 'Tessera will add the meeting preparation item "meeting-prep" to your workspace.',
    });
  });

  test("keeps non-playbook approval previews readable", () => {
    const run = {
      runId: "run-1",
      workflowId: "demo.write-approval",
      status: "blocked",
      input: {},
      approval: {
        toolId: "workspace.writeProbe",
        args: { target: "lead", value: "qualified" },
        capability: "write",
        risk: {
          mutates: true,
          destructive: false,
          external: false,
          reversible: true,
          dryRunSupported: true,
        },
        preview: "write-probe target=lead value=qualified",
        reasonCode: "write_requires_approval",
      },
      sourceGaps: [],
    } satisfies PlaybookRunDetail;

    expect(playbookApprovalCopy(run, null)).toEqual({
      prepared: 'Tessera is ready to prepare "lead" in your workspace using "qualified".',
      approve: "Tessera will add this preparation step to your workspace.",
    });
  });
});
