import { a2aInterfaceUrl } from "@platypus/schemas";

/** The public Agent Card URL an A2A client is given (ADR-0032). */
export const a2aCardUrl = (backendUrl: string, endpointId: string) =>
  `${a2aInterfaceUrl(backendUrl, endpointId)}/.well-known/agent-card.json`;
