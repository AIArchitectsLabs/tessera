import { describe, expect, test } from "bun:test";
import {
  formatGraphMaterializationContent,
  textValueFromArtifact,
} from "./workspace-materialization.js";

describe("workspace materialization", () => {
  test("uses summaryMarkdown for markdown output before title fallback", () => {
    const content = formatGraphMaterializationContent(
      {
        title: "Weekly Email Summary",
        summaryMarkdown:
          "# Weekly Email Summary\n\nGenerated body with workflow trace and diagnostics.",
      },
      "markdown"
    );

    expect(content).toBe(
      "# Weekly Email Summary\n\nGenerated body with workflow trace and diagnostics.\n"
    );
  });

  test("returns key-value markdown for an artifact with unknown field names", () => {
    const result = textValueFromArtifact({ report: "My report content", score: 42 });
    expect(result).not.toBeUndefined();
    expect(result).toContain("report");
    expect(result).toContain("My report content");
  });

  test("returns undefined for an empty object", () => {
    const result = textValueFromArtifact({});
    expect(result).toBeUndefined();
  });

  test("does not use key-value fallback when known fields are present", () => {
    const result = textValueFromArtifact({ title: "T", unknownField: "X" });
    expect(result).not.toBeUndefined();
    expect(result).toContain("# T");
    expect(result).not.toContain("**title:**");
    expect(result).not.toContain("**unknownField:**");
  });
});
