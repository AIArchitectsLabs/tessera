import { describe, expect, test } from "bun:test";
import type { AgentProfile } from "@tessera/contracts";
import { DEFAULT_AGENT_PROFILE } from "@tessera/core";
import { mergeDefaultAgentProfile } from "./default-agent-profile.js";

const override: AgentProfile = {
  ...DEFAULT_AGENT_PROFILE,
  instructions: "Use the saved operating contract.",
  skills: ["planning"],
  toolPolicyPreset: "read_only",
  updatedAt: "2026-05-07T00:00:00.000Z",
};

describe("mergeDefaultAgentProfile", () => {
  test("keeps protected default identity and persisted overrides", () => {
    const merged = mergeDefaultAgentProfile(DEFAULT_AGENT_PROFILE, {
      ...override,
      id: "default",
      name: "Renamed",
      model: {
        mode: "override",
        provider: { provider: "openai", model: "gpt-5.4", apiKeyEnv: "OPENAI_API_KEY" },
      },
    });

    expect(merged.id).toBe("default");
    expect(merged.name).toBe("Tessera");
    expect(merged.model).toEqual({ mode: "default" });
    expect(merged.instructions).toBe("Use the saved operating contract.");
    expect(merged.skills).toContain("planning");
    expect(merged.skills).toContain("tessera-playbook-builder");
    expect(merged.skills).toContain("tessera-playbook-debugger");
    expect(merged.toolPolicyPreset).toBe("read_only");
  });

  test("uses shipped default skills when a legacy default override has none", () => {
    const merged = mergeDefaultAgentProfile(DEFAULT_AGENT_PROFILE, {
      ...override,
      skills: [],
    });

    expect(merged.skills).toEqual(DEFAULT_AGENT_PROFILE.skills);
  });

  test("upgrades previously shipped default skill lists", () => {
    const merged = mergeDefaultAgentProfile(DEFAULT_AGENT_PROFILE, {
      ...override,
      skills: [
        "planning",
        "research-synthesis",
        "word-docs",
        "pdf-workflows",
        "slide-decks",
        "spreadsheets",
        "workspace-delivery",
        "decision-briefs",
      ],
    });

    expect(merged.skills).toEqual(DEFAULT_AGENT_PROFILE.skills);
  });

  test("upgrades previously shipped playbook-builder default skill lists", () => {
    const merged = mergeDefaultAgentProfile(DEFAULT_AGENT_PROFILE, {
      ...override,
      skills: [
        "planning",
        "research-synthesis",
        "word-docs",
        "pdf-workflows",
        "slide-decks",
        "spreadsheets",
        "workspace-delivery",
        "decision-briefs",
        "tessera-playbook-builder",
      ],
    });

    expect(merged.skills).toEqual(DEFAULT_AGENT_PROFILE.skills);
  });

  test("upgrades previously shipped builder+debugger default skill lists", () => {
    const merged = mergeDefaultAgentProfile(DEFAULT_AGENT_PROFILE, {
      ...override,
      skills: [
        "planning",
        "research-synthesis",
        "word-docs",
        "pdf-workflows",
        "slide-decks",
        "spreadsheets",
        "workspace-delivery",
        "decision-briefs",
        "tessera-playbook-builder",
        "tessera-playbook-debugger",
      ],
    });

    expect(merged.skills).toEqual(DEFAULT_AGENT_PROFILE.skills);
  });

  test("preserves custom skills and injects missing platform playbook skills", () => {
    const merged = mergeDefaultAgentProfile(DEFAULT_AGENT_PROFILE, {
      ...override,
      skills: [
        "planning",
        "research-synthesis",
        "word-docs",
        "pdf-workflows",
        "slide-decks",
        "spreadsheets",
        "workspace-delivery",
        "decision-briefs",
        "tessera-playbook-builder",
        "my-custom-skill",
      ],
    });

    expect(merged.skills).toContain("tessera-playbook-builder");
    expect(merged.skills).toContain("tessera-playbook-debugger");
    expect(merged.skills).toContain("my-custom-skill");
  });

  test("does not duplicate platform skills already in custom set", () => {
    const merged = mergeDefaultAgentProfile(DEFAULT_AGENT_PROFILE, {
      ...override,
      skills: ["tessera-playbook-builder", "tessera-playbook-debugger", "custom-skill"],
    });

    expect(merged.skills.filter((s) => s === "tessera-playbook-builder")).toHaveLength(1);
    expect(merged.skills.filter((s) => s === "tessera-playbook-debugger")).toHaveLength(1);
    expect(merged.skills).toContain("custom-skill");
  });
});
