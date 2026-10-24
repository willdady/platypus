import type { PoolConfig } from "pg";
import { parseIntoClientConfig } from "pg-connection-string";

/**
 * Time an idle pool client's lost connection waits before the pool gives up
 * establishing a new one. `pg`'s own default is 0 — wait forever — which a
 * down or unreachable database turns into a boot that never finishes and a
 * scheduler that never ticks; a finite bound makes the failure a log line and
 * the orchestrator's restart the recovery (#1616).
 */
export const POOL_CONNECTION_TIMEOUT_MS = 10_000;

/**
 * Ceiling for one statement on any pooled connection. A single statement past
 * this is a wedged query — a lock wait or a runaway read — and freeing its
 * connection beats letting it squat one of the pool's few slots. Generous
 * enough that no legitimately slow statement the app runs (a huge cascade
 * delete, the first-boot `CREATE EXTENSION`) trips it.
 */
export const POOL_STATEMENT_TIMEOUT_MS = 600_000;

/**
 * Ceiling for a transaction left open with no statement in flight. The app
 * never intentionally idles inside a transaction — the sinks write their
 * claim-then-write in one quick pass and close it — so a transaction parked
 * here is abandoned work holding a connection and its locks.
 */
export const POOL_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS = 60_000;

/**
 * The node-postgres config for `url`, with every session pinned to UTC.
 *
 * Timestamp columns carry no zone: Drizzle writes JS `Date`s as UTC while
 * `defaultNow()` and `NOW()` write the session's local time, so the two only
 * agree when the session runs in UTC (#1615). The pin goes into `options`,
 * appended to any the URL or `PGOPTIONS` already sets, because node-postgres
 * lets a URL's own `options` replace a separately configured one.
 *
 * Without a URL, node-postgres connects by its `PG*` environment defaults.
 */
export const databaseConfig = (url: string | undefined): PoolConfig => {
  const config: PoolConfig = url ? parseIntoClientConfig(url) : {};
  const options = config.options ?? process.env.PGOPTIONS;
  return {
    ...config,
    options: [options, "-c TimeZone=UTC"].filter(Boolean).join(" "),
  };
};

/**
 * The pool's full configuration: `databaseConfig`'s URL + UTC pin, the pool
 * size from the Operator, and the three connection guards. Built as one
 * explicit object so `index.ts`'s `new Pool(...)` has no implicit default
 * left — and so a Postgres restart is logged by the pool's `error` listener
 * instead of crashing the process.
 */
export const buildPoolConfig = (
  url: string | undefined,
  max: number,
): PoolConfig => ({
  ...databaseConfig(url),
  max,
  connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS,
  statement_timeout: POOL_STATEMENT_TIMEOUT_MS,
  idle_in_transaction_session_timeout:
    POOL_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS,
});
