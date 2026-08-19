/**
 * The composite value the model picker (chat composer, Agent form) submits:
 * either an Agent by id, or a Provider paired with the model reference it
 * resolves through (which may itself be a Model alias reference, e.g.
 * `alias:flagship` — see ADR-0017). One codec, so the encode/decode pair is
 * defined once instead of reassembled at each call site.
 */
export type SelectionReference =
  | { type: "agent"; agentId: string }
  | { type: "provider"; providerId: string; modelReference: string };

export const encodeAgentSelection = (agentId: string): string =>
  `agent:${agentId}`;

export const encodeProviderSelection = (
  providerId: string,
  modelReference: string,
): string => `provider:${providerId}:${modelReference}`;

/**
 * Parses a value built by `encodeAgentSelection` / `encodeProviderSelection`.
 *
 * A provider reference splits on `:` with a rest element rather than a fixed
 * split(":")[n] — a Model alias reference is itself `alias:<name>`, so the
 * model segment can contain its own colon. Anything not matching either shape
 * (an empty string, a bare model id with no prefix) decodes to `null`.
 */
export const decodeSelectionReference = (
  value: string,
): SelectionReference | null => {
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
};
