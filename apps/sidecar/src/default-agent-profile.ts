import type { AgentProfile } from "@tessera/contracts";

export function mergeDefaultAgentProfile(
  base: AgentProfile,
  override: AgentProfile | undefined
): AgentProfile {
  if (!override) return base;

  return {
    ...override,
    id: base.id,
    name: base.name,
    model: base.model,
    skills: override.skills.length > 0 ? override.skills : base.skills,
  };
}
