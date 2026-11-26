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

type ReadModelOptions = {
  reveal: boolean;
  scope: ResourceScope;
};

export const mcpReadModel = (
  row: McpRecord,
  opts: ReadModelOptions,
): McpResponse => ({
  ...redactMcpSecrets(sanitizeMcpResponse(row), { reveal: opts.reveal }),
  scope: opts.scope,
});

export const providerReadModel = (
  row: typeof providerTable.$inferSelect,
  opts: ReadModelOptions,
): ProviderResponse => ({
  ...redactProviderSecrets(row, { reveal: opts.reveal }),
  scope: opts.scope,
});
