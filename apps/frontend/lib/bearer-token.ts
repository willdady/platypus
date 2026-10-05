import type { BearerTokenStatus } from "@platypus/schemas";

export const TOKEN_STATUS_LABELS: Record<BearerTokenStatus, string> = {
  none: "No token",
  active: "Active",
  expiring: "Expiring soon",
  expired: "Expired",
};

/** The badge variant each status reads as: the two that stop calls stand out. */
export const TOKEN_STATUS_VARIANTS: Record<
  BearerTokenStatus,
  "secondary" | "outline" | "destructive"
> = {
  none: "destructive",
  active: "outline",
  expiring: "secondary",
  expired: "destructive",
};
