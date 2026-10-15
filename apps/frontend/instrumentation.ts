import { PHASE_PRODUCTION_BUILD } from "next/constants";

/**
 * Runs once when the server starts. Skipped during `next build`, which runs
 * before the image's run-time environment exists. The checks live in a
 * Node-only module so the Edge bundle never sees `process.exit`.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD) return;
  const { validateEnvOrExit } = await import("./instrumentation-node");
  validateEnvOrExit();
}
