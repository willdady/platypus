export type SelectionReference =
  | { type: "agent"; agentId: string }
  | { type: "provider"; providerId: string; modelReference: string };

export function encodeAgentSelection(agentId: string): string {
  return `agent:${agentId}`;
}

export function encodeProviderSelection(
  providerId: string,
  modelReference: string,
): string {
  return `provider:${providerId}:${modelReference}`;
}

export function decodeSelectionReference(
  value: string,
): SelectionReference | null {
  if (value.startsWith("agent:")) {
    return { type: "agent", agentId: value.slice("agent:".length) };
  }
  if (value.startsWith("provider:")) {
    const [, providerId, ...modelReferenceParts] = value.split(":");
    return {
      type: "provider",
      providerId,
      modelReference: modelReferenceParts.join(":"),
    };
  }
  return null;
}
