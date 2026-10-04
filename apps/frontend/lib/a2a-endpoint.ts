/** The public Agent Card URL an A2A client is given (ADR-0032). */
export const a2aCardUrl = (backendUrl: string, endpointId: string) =>
  `${backendUrl.replace(/\/+$/, "")}/a2a/${endpointId}/.well-known/agent-card.json`;

/** Whether the Organization's A2A gate lets a Workspace's endpoints answer. */
export const a2aGateAdmits = (
  gate: string | undefined,
  workspaceAllowed: boolean | undefined,
): boolean => gate === "all" || (gate === "selected" && !!workspaceAllowed);
