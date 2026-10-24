import { parseEnv } from "./env.ts";
import { logger } from "./logger.ts";
import { errorMessage } from "./utils/error-message.ts";

/**
 * Log why startup failed and exit non-zero. The message goes in the log line,
 * not just the serialised error: it is the one thing the Operator has to work
 * from (#369).
 */
export function failStartup(error: unknown): never {
  logger.fatal(
    { err: error },
    `Startup failed, not starting the HTTP server: ${errorMessage(error)}`,
  );
  process.exit(1);
}

// At import, not in `main`: `index.ts` imports this first, and later modules
// read the environment as they load (the auth config, CORS), so a bad value
// must stop the backend before any of them can trip over it (#1617).
try {
  parseEnv();
} catch (error) {
  failStartup(error);
}
