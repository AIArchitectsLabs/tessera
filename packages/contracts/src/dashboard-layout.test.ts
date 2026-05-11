import { describe, expect, test } from "bun:test";
import { DashboardLayoutSchema, WorkflowOutputDeclarationSchema } from "./index.js";

describe("DashboardLayoutSchema", () => {
  test("accepts a layout with one metrics section", () => {
    const layout = DashboardLayoutSchema.parse({
      sections: [
        {
          type: "metrics",
          title: "Pipeline",
          items: [
            { label: "Open deals", binding: "draftSnapshot.openDeals" },
            { label: "At risk", binding: "draftSnapshot.atRisk", unit: "deals" },
          ],
        },
      ],
    });
    expect(layout.sections).toHaveLength(1);
  });

  test("accepts all four section types", () => {
    const layout = DashboardLayoutSchema.parse({
      refreshLabel: "Refresh pipeline",
      sections: [
        { type: "metrics", items: [{ label: "x", binding: "a" }] },
        { type: "list", title: "Risks", binding: "b" },
        { type: "text", title: "Summary", binding: "c" },
        { type: "table", title: "Deals", binding: "d", columns: [{ key: "name", label: "Name" }] },
      ],
    });
    expect(layout.sections).toHaveLength(4);
  });

  test("rejects layouts with no sections", () => {
    expect(() => DashboardLayoutSchema.parse({ sections: [] })).toThrow();
  });

  test("rejects unknown section type", () => {
    expect(() =>
      DashboardLayoutSchema.parse({
        sections: [{ type: "chart", binding: "a", title: "x" }],
      })
    ).toThrow();
  });
});

describe("WorkflowOutputDeclarationSchema extensions", () => {
  test("accepts dashboard kind with layoutScript", () => {
    const decl = WorkflowOutputDeclarationSchema.parse({
      id: "main",
      kind: "dashboard",
      label: "Pipeline",
      layoutScript: "scripts/render.ts",
    });
    expect(decl.kind).toBe("dashboard");
    expect(decl.layoutScript).toBe("scripts/render.ts");
  });

  test("accepts dashboard kind with static layout path", () => {
    const decl = WorkflowOutputDeclarationSchema.parse({
      kind: "dashboard",
      label: "Pipeline",
      layout: "layouts/dashboard.json",
    });
    expect(decl.layout).toBe("layouts/dashboard.json");
  });

  test("still accepts existing document output kinds", () => {
    const decl = WorkflowOutputDeclarationSchema.parse({
      kind: "meetingBrief",
      label: "Meeting brief",
    });
    expect(decl.kind).toBe("meetingBrief");
  });
});
