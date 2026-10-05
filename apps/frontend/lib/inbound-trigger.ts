/** Whether the Organization gate lets a Workspace take Inbound Trigger calls. */
export const inboundGateAdmits = (
  gate: string | undefined,
  workspaceAllowed: boolean | undefined,
): boolean => gate === "all" || (gate === "selected" && !!workspaceAllowed);
