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
 * Every helper here returns one fixed shape. A secret is either its value (the
 * caller may manage the resource) or absent, and its presence indicator
 * (`apiKeySet`, `headersSet`, `bearerTokenSet`) is always present, so a caller
 * can tell "unset" from "not shown" without branching on who is reading.
 *
 * *Who* may reveal is decided once per surface, not per route:
 * `workspaceCredentialsVisible` and `orgCredentialsVisible`
 * (`middleware/authorization.ts`), which are where these helpers' `reveal`
 * argument comes from.
 */

import type {
  McpResponse,
  ProviderResponse,
  ResourceScope,
  SecretPresence,
} from "@platypus/schemas";
import type { McpRecord } from "./mcp-oauth-provider.ts";
import type { provider as providerTable } from "../db/schema.ts";

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
  opts: { reveal: boolean },
): Omit<T, "apiKey" | "headers"> & {
  apiKey?: string;
  apiKeySet: SecretPresence;
  headers?: Record<string, string> | null;
  headersSet: SecretPresence;
} => {
  const { apiKey, headers, ...rest } = row;
  return {
    ...rest,
    ...(opts.reveal && { apiKey, headers }),
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
 * Distinct from the OAuth token strip in {@link sanitizeMcpResponse}, which is
 * unconditional: those tokens are minted by Platypus and never belong in a
 * response, whereas `bearerToken` and `headers` are Operator-entered config that
 * the edit form legitimately reads back for whoever may edit it.
 */
export const redactMcpSecrets = <T extends McpSecretFields>(
  row: T,
  opts: { reveal: boolean },
): Omit<T, "bearerToken" | "headers"> & {
  bearerToken?: string | null;
  bearerTokenSet: SecretPresence;
  headers?: Record<string, string> | null;
  headersSet: SecretPresence;
} => {
  const { bearerToken, headers, ...rest } = row;
  return {
    ...rest,
    ...(opts.reveal && { bearerToken, headers }),
    bearerTokenSet: presence(bearerToken),
    headersSet: presence(headers),
  };
};

/**
 * Strips the OAuth secrets Platypus mints for an MCP and reports only whether
 * the server is authorized. Unconditional — unlike {@link redactMcpSecrets},
 * these are never Operator-entered and belong in no response, so every route
 * returning an MCP row runs it, writes included. The Last-known tool listing
 * goes too, with when its fetch last failed: a Chat turn's internal cache
 * (ADR-0029, ADR-0031), not configuration.
 */
const sanitizeMcpResponse = (record: McpRecord) => {
  const {
    oauthAccessToken,
    oauthRefreshToken,
    oauthClientSecret,
    oauthTokenExpiresAt,
    oauthScope,
    oauthAuthorizationServer,
    oauthClientDynamicallyRegistered,
    lastKnownToolListing,
    lastKnownToolListingFetchedAt,
    lastFetchFailedAt,
    ...rest
  } = record;
  return {
    ...rest,
    oauthAuthorized:
      record.authType === "OAuth" ? !!oauthAccessToken : undefined,
  };
};

/** What a read route supplies to its read model: who may see secrets, and the scope. */
type ReadModelOptions = {
  /** Decided per surface by `workspaceCredentialsVisible`/`orgCredentialsVisible`. */
  reveal: boolean;
  /**
   * The scope the Scoped-resource module resolved the row at. Always present:
   * the Organization surface passes `"organization"`, where every row is
   * Organization-scoped by construction, rather than omitting the field.
   */
  scope: ResourceScope;
};

/**
 * The read shape of an MCP, for every route that returns one to a reader or a
 * writer.
 *
 * The pairing is the point: the OAuth strip is unconditional and the credential
 * redaction is not, and assembling them per route meant each site had to
 * remember both. A route that reached for `redactMcpSecrets` alone would answer
 * with the OAuth tokens still on the row.
 */
export const mcpReadModel = (
  row: McpRecord,
  opts: ReadModelOptions,
): McpResponse => {
  const model = {
    ...redactMcpSecrets(sanitizeMcpResponse(row), { reveal: opts.reveal }),
    scope: opts.scope,
  };
  // `authType` is a text column; every write path narrows it to the enum.
  return model as McpResponse;
};

/** The read shape of a Provider, for every route that returns one to a reader or a writer. */
export const providerReadModel = (
  row: typeof providerTable.$inferSelect,
  opts: ReadModelOptions,
): ProviderResponse => ({
  ...redactProviderSecrets(row, { reveal: opts.reveal }),
  scope: opts.scope,
  // Stored rows may still hold bare model ids; the schema accepts both shapes,
  // and the form normalizes either into model objects.
  modelIds: row.modelIds as ProviderResponse["modelIds"],
});
