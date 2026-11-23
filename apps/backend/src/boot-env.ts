import { parseEnv } from "./env.ts";
import { logger } from "./logger.ts";
import { errorMessage } from "./utils/error-message.ts";

export function failStartup(error: unknown): never {
  logger.fatal(
    { err: error },
    `Startup failed, not starting the HTTP server: ${errorMessage(error)}`,
  );
  process.exit(1);
}

// why: at import, so a bad value stops boot before later modules read the environment
try {
  parseEnv();
} catch (error) {
  failStartup(error);
}
