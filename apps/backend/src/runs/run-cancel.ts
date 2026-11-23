import { z } from "zod";
import { logger } from "../logger.ts";
import { notify, onNotification } from "./notify-listener.ts";
import { runRegistry } from "./run-registry.ts";
import type { RunId } from "./types.ts";

const CHANNEL = "run_cancel";

export const cancelRun = async (
  runId: RunId,
  { startedBefore }: { startedBefore?: Date } = {},
): Promise<void> => {
  const options = { startedBefore: startedBefore?.getTime() };
  if (runRegistry.cancel(runId, options)) return;
  await notify(CHANNEL, JSON.stringify({ runId, ...options }));
};

const cancelSchema = z
  .object({
    runId: z.string().min(1),
    startedBefore: z.number().optional(),
  })
  .strict();

type Cancel = z.infer<typeof cancelSchema>;

const readJson = (payload: string): unknown => {
  try {
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
};

const parseCancel = (payload: string): Cancel | undefined => {
  const result = cancelSchema.safeParse(readJson(payload));
  if (!result.success) {
    logger.warn(
      { payload, issues: result.error.issues },
      "Dropped a run_cancel payload in an unknown shape",
    );
    return undefined;
  }
  return result.data;
};

onNotification(CHANNEL, (payload) => {
  const cancel = parseCancel(payload);
  if (!cancel) return;
  runRegistry.cancel(cancel.runId, { startedBefore: cancel.startedBefore });
});
