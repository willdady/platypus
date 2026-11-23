import { env } from "../env.ts";

export const chatPerRunTimeoutMs = (): number => env().CHAT_PER_RUN_TIMEOUT_MS;

export const chatTimeouts = () => ({
  perStepTimeoutMs: env().CHAT_PER_STEP_TIMEOUT_MS,
  perRunTimeoutMs: chatPerRunTimeoutMs(),
});
