import { getEnv } from "@/lib/env";

/**
 * Fails the server at boot, naming the variable, when the backend URL is
 * missing or malformed, rather than serving pages that can't reach it. A thrown
 * error alone would be logged while Next carried on answering with 500s.
 */
export function validateEnvOrExit() {
  try {
    getEnv();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
