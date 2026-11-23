import type { PoolConfig } from "pg";
import { parseIntoClientConfig } from "pg-connection-string";

export const POOL_CONNECTION_TIMEOUT_MS = 10_000;

export const POOL_STATEMENT_TIMEOUT_MS = 600_000;

export const POOL_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS = 60_000;

export const databaseConfig = (url: string): PoolConfig => {
  const config: PoolConfig = parseIntoClientConfig(url);
  const options = config.options ?? process.env.PGOPTIONS;
  return {
    ...config,
    options: [options, "-c TimeZone=UTC"].filter(Boolean).join(" "),
  };
};

export const buildPoolConfig = (url: string, max: number): PoolConfig => ({
  ...databaseConfig(url),
  max,
  connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS,
  statement_timeout: POOL_STATEMENT_TIMEOUT_MS,
  idle_in_transaction_session_timeout:
    POOL_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS,
});
