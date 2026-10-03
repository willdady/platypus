import type { InboundTokenStatus } from "@platypus/schemas";

export const INBOUND_TOKEN_STATUS_LABELS: Record<InboundTokenStatus, string> = {
  none: "No token",
  active: "Active",
  expiring: "Expiring soon",
  expired: "Expired",
};

/** The badge variant each status reads as: the two that stop calls stand out. */
export const INBOUND_TOKEN_STATUS_VARIANTS: Record<
  InboundTokenStatus,
  "secondary" | "outline" | "destructive"
> = {
  none: "destructive",
  active: "outline",
  expiring: "secondary",
  expired: "destructive",
};

/** Whether the Organization gate lets a Workspace take Inbound Trigger calls. */
export const inboundGateAdmits = (
  gate: string | undefined,
  workspaceAllowed: boolean | undefined,
): boolean => gate === "all" || (gate === "selected" && !!workspaceAllowed);
