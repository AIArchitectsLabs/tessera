import type { InboxAction, InboxMessageType, InboxSeverity, InboxStatus } from "@tessera/contracts";

const TYPE_LABELS: Record<InboxMessageType, string> = {
  approval: "Approval",
  input_required: "Input required",
  review: "Review",
  exception: "Exception",
  credential: "Credential",
  policy_override: "Policy override",
  artifact_review: "Artifact review",
  production_promotion: "Production promotion",
};

const STATUS_LABELS: Record<InboxStatus, string> = {
  open: "Open",
  snoozed: "Snoozed",
  resolved: "Resolved",
  expired: "Expired",
  cancelled: "Cancelled",
  consumed: "Consumed",
};

export function inboxTypeLabel(type: InboxMessageType): string {
  return TYPE_LABELS[type];
}

export function inboxStatusLabel(status: InboxStatus): string {
  return STATUS_LABELS[status];
}

export function inboxSeverityClass(severity: InboxSeverity): string {
  if (severity === "critical") return "text-destructive bg-destructive/10 border-destructive/20";
  if (severity === "warning") return "text-amber-700 bg-amber-500/10 border-amber-500/20";
  return "text-muted-foreground bg-secondary border-border";
}

export function inboxActionLabel(action: InboxAction): string {
  return action.label.trim() || action.id;
}
