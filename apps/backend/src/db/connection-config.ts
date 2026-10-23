import type { PoolConfig } from "pg";
import { parseIntoClientConfig } from "pg-connection-string";

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
