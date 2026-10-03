/**
 * How an Inbound Trigger's token stands (ADR-0030), with the same words the
 * backend's Org Admin list uses: no token (never issued, or revoked), active,
 * expiring within 7 days, or expired.
 */
export type InboundTokenStatus = "none" | "active" | "expiring" | "expired";

const EXPIRING_WITHIN_MS = 7 * 24 * 60 * 60 * 1000;

export const inboundTokenStatus = (
  trigger: {
    hasToken?: boolean;
    tokenExpiresAt?: Date | string | null;
  },
  now: number,
): InboundTokenStatus => {
  if (!trigger.hasToken || !trigger.tokenExpiresAt) return "none";
  const left = new Date(trigger.tokenExpiresAt).getTime() - now;
  if (left <= 0) return "expired";
  return left <= EXPIRING_WITHIN_MS ? "expiring" : "active";
};

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
