import { env } from "../env.ts";

export const triggerPerRunTimeoutMs = (): number =>
  env().TRIGGER_PER_RUN_TIMEOUT_MS;

export const triggerTimeouts = () => ({
  perStepTimeoutMs: env().TRIGGER_PER_STEP_TIMEOUT_MS,
  perRunTimeoutMs: triggerPerRunTimeoutMs(),
});
