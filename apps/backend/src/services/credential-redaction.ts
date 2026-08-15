/**
 * The single home for "which fields of a Scoped resource may this caller read?".
 *
 * Providers and MCPs are the credential- and reach-bearing resources of ADR-0006:
 * an Org Admin configures them, and a Workspace Owner may self-manage them only
 * where the Organization delegated it. That rule gated every *write* route and no
 * *read* route, so the stored credential was returned to any caller who could see
 * the resource at all — including a plain Organization member on the Organization
 * surface, where the read routes take `requireOrgAccess()` with no role.
 *
 * Redaction, not gating, is the fix: a Workspace Owner has to list Providers and
 * MCPs to select one on an Agent or Chat whether or not credentials were delegated
 * to them, so the rows must keep flowing with the secrets removed.
 *
 * `reveal` defaults to `false` on both helpers so a new call site fails closed.
 *
 * *Who* may reveal is decided once per surface, not per route:
 * `workspaceCredentialsVisible` and `orgCredentialsVisible`
 * (`middleware/authorization.ts`), which are where these helpers' `reveal`
 * argument comes from.
 */

/** Replaces a redacted secret so a caller can tell "unset" from "not shown". */
export type SecretPresence = {
  /** True when a value is stored, whatever it is. Never the value itself. */
  configured: boolean;
};

const presence = (value: unknown): SecretPresence => ({
  configured:
    value !== null &&
    value !== undefined &&
    value !== "" &&
    !(typeof value === "object" && Object.keys(value).length === 0),
});

type ProviderSecretFields = {
  apiKey: string;
  headers?: Record<string, string> | null;
};

/**
 * Strips a Provider's stored credentials unless the caller may manage it.
 *
 * `headers` goes with `apiKey`: a custom header block is where a self-hosted or
 * proxied Provider carries its own `Authorization`, so revealing it while hiding
 * `apiKey` would leak the same class of secret through the other field.
 */
export const redactProviderSecrets = <T extends ProviderSecretFields>(
  row: T,
  opts: { reveal?: boolean } = {},
):
  | T
  | (Omit<T, "apiKey" | "headers"> & {
      apiKeySet: SecretPresence;
      headersSet: SecretPresence;
    }) => {
  if (opts.reveal) return row;
  const { apiKey, headers, ...rest } = row;
  return {
    ...rest,
    apiKeySet: presence(apiKey),
    headersSet: presence(headers),
  };
};

type McpSecretFields = {
  bearerToken?: string | null;
  headers?: Record<string, string> | null;
};

/**
 * Strips an MCP's stored request credentials unless the caller may manage it.
 *
 * Distinct from the OAuth token strip in `sanitizeMcpResponse`, which is
 * unconditional: those tokens are minted by Platypus and never belong in a
 * response, whereas `bearerToken` and `headers` are Operator-entered config that
 * the edit form legitimately reads back for whoever may edit it.
 */
export const redactMcpSecrets = <T extends McpSecretFields>(
  row: T,
  opts: { reveal?: boolean } = {},
):
  | T
  | (Omit<T, "bearerToken" | "headers"> & {
      bearerTokenSet: SecretPresence;
      headersSet: SecretPresence;
    }) => {
  if (opts.reveal) return row;
  const { bearerToken, headers, ...rest } = row;
  return {
    ...rest,
    bearerTokenSet: presence(bearerToken),
    headersSet: presence(headers),
  };
};
