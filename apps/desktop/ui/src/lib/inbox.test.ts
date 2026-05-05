/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { inboxActionLabel, inboxSeverityClass, inboxStatusLabel, inboxTypeLabel } from "./inbox";

describe("inbox UI helpers", () => {
  test("maps statuses to compact labels", () => {
    expect(inboxStatusLabel("open")).toBe("Open");
    expect(inboxStatusLabel("snoozed")).toBe("Snoozed");
    expect(inboxStatusLabel("resolved")).toBe("Resolved");
  });

  test("maps message types to readable labels", () => {
    expect(inboxTypeLabel("input_required")).toBe("Input required");
    expect(inboxTypeLabel("artifact_review")).toBe("Artifact review");
  });

  test("maps severity to stable classes", () => {
    expect(inboxSeverityClass("info")).toContain("text-muted-foreground");
    expect(inboxSeverityClass("warning")).toContain("text-amber");
    expect(inboxSeverityClass("critical")).toContain("text-destructive");
  });

  test("uses action label with id fallback", () => {
    expect(inboxActionLabel({ id: "approve", label: "Approve", style: "primary" })).toBe("Approve");
    expect(inboxActionLabel({ id: "open-settings", label: "", style: "secondary" })).toBe(
      "open-settings"
    );
  });
});
