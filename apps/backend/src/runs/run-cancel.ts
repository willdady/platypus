import { z } from "zod";
import { logger } from "../logger.ts";
import { notify, onNotification } from "./notify-listener.ts";
import { runRegistry } from "./run-registry.ts";
import type { RunId } from "./types.ts";

const CHANNEL = "run_cancel";

export type CancelRunOptions = { turnId?: string };

export const cancelRun = async (
  runId: RunId,
  { turnId }: CancelRunOptions = {},
): Promise<void> => {
  if (runRegistry.cancel(runId, { turnId })) return;
  await notify(CHANNEL, JSON.stringify({ runId, turnId }));
};

const cancelSchema = z
  .object({
    runId: z.string().min(1),
    turnId: z.string().min(1).optional(),
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
  runRegistry.cancel(cancel.runId, { turnId: cancel.turnId });
});
