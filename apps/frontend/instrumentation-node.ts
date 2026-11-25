import { getEnv } from "@/lib/env";

export function validateEnvOrExit() {
  try {
    getEnv();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
