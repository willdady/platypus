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

import type { Scope } from "./scoped-resource.ts";
import type { McpRecord } from "./mcp-oauth-provider.ts";
import type { provider as providerTable } from "../db/schema.ts";

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

/**
 * Strips the OAuth secrets Platypus mints for an MCP and reports only whether
 * the server is authorized. Unconditional — unlike {@link redactMcpSecrets},
 * these are never Operator-entered and belong in no response, so every route
 * returning an MCP row runs it, writes included.
 */
export const sanitizeMcpResponse = (record: McpRecord) => {
  const {
    oauthAccessToken,
    oauthRefreshToken,
    oauthClientSecret,
    oauthTokenExpiresAt,
    oauthScope,
    ...rest
  } = record;
  return {
    ...rest,
    oauthAuthorized:
      record.authType === "OAuth" ? !!oauthAccessToken : undefined,
  };
};

/** What a read route adds to a row: who may see secrets, and the resolved scope. */
type ReadModelOptions = {
  /** Decided per surface by `workspaceCredentialsVisible`/`orgCredentialsVisible`. */
  reveal?: boolean;
  /**
   * The scope the Scoped-resource module resolved the row at, which the frontend
   * uses to mark a Shared row read-only. Omitted on the Organization surface,
   * where every row is Organization-scoped by construction.
   */
  scope?: Scope;
};

const withScope = <T extends object>(model: T, scope?: Scope) =>
  scope ? { ...model, scope } : model;

/**
 * The read shape of an MCP, for every route that returns one to a reader.
 *
 * The pairing is the point: the OAuth strip is unconditional and the credential
 * redaction is not, and assembling them per route meant each site had to
 * remember both. A route that reached for `redactMcpSecrets` alone would answer
 * with the OAuth tokens still on the row.
 */
export const mcpReadModel = (row: McpRecord, opts: ReadModelOptions = {}) =>
  withScope(
    redactMcpSecrets(sanitizeMcpResponse(row), { reveal: opts.reveal }),
    opts.scope,
  );

/** The read shape of a Provider, for every route that returns one to a reader. */
export const providerReadModel = (
  row: typeof providerTable.$inferSelect,
  opts: ReadModelOptions = {},
) => withScope(redactProviderSecrets(row, { reveal: opts.reveal }), opts.scope);
