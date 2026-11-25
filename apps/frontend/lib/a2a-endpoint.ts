import { a2aInterfaceUrl } from "@platypus/schemas";

export function a2aCardUrl(backendUrl: string, endpointId: string) {
  return `${a2aInterfaceUrl(backendUrl, endpointId)}/.well-known/agent-card.json`;
}
