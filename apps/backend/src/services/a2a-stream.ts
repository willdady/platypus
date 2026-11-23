import type {
  Artifact,
  SendMessageRequest,
  StreamResponse,
  Task,
} from "@a2a-js/sdk";
import {
  TaskNotFoundError,
  UnsupportedOperationError,
} from "@a2a-js/sdk/errors";
import { startA2aTurn, takeFollowerSlot, type A2aCaller } from "./a2a-task.ts";
import {
  findA2aTask,
  isTerminal,
  requireStatus,
  type TaskRow,
} from "./a2a-task-state.ts";
import { readTask, readTaskAfresh } from "./a2a-task-lifecycle.ts";
import {
  a2aFallbackPollMs,
  a2aTaskEvents,
  type A2aTaskSubscription,
} from "./a2a-events.ts";
import { callerIsLive } from "./a2a-liveness.ts";
import { replyArtifact } from "./a2a-parts.ts";

const assertCallerLive = async (caller: A2aCaller): Promise<void> => {
  if (!(await callerIsLive(caller))) throw new TaskNotFoundError();
};

const taskEvent = (task: Task): StreamResponse => ({
  payload: { $case: "task", value: task },
});

const statusEvent = (task: Task): StreamResponse => ({
  payload: {
    $case: "statusUpdate",
    value: {
      taskId: task.id,
      contextId: task.contextId,
      status: task.status,
      metadata: task.metadata,
    },
  },
});

const artifactEvent = (
  task: { id: string; contextId: string },
  artifact: Artifact,
  { append, lastChunk }: { append: boolean; lastChunk: boolean },
): StreamResponse => ({
  payload: {
    $case: "artifactUpdate",
    value: {
      taskId: task.id,
      contextId: task.contextId,
      artifact,
      append,
      lastChunk,
      metadata: undefined,
    },
  },
});

async function* followTask(
  caller: A2aCaller,
  task: TaskRow,
  seen: Task,
  events: A2aTaskSubscription,
): AsyncGenerator<StreamResponse> {
  let state = requireStatus(seen).state;
  let sent = events.replyFrom;
  if (events.catchUp && sent !== null) {
    const { artifactId, text } = events.catchUp;
    yield artifactEvent(seen, replyArtifact(artifactId, text), {
      append: false,
      lastChunk: false,
    });
  }
  for (;;) {
    const event = await events.next(
      events.produced ? undefined : a2aFallbackPollMs(),
      caller.signal,
    );
    if (caller.signal?.aborted) return;
    if (event?.kind === "delta") {
      if (sent !== event.offset) {
        sent = null;
        continue;
      }
      yield artifactEvent(seen, replyArtifact(event.artifactId, event.text), {
        append: event.offset > 0,
        lastChunk: false,
      });
      sent += event.text.length;
      continue;
    }
    await assertCallerLive(caller);
    const read =
      event?.kind === "status"
        ? { ...seen, status: event.status }
        : event?.kind === "end" && event.task
          ? event.task
          : await readTaskAfresh(task);
    if (isTerminal(read)) {
      for (const artifact of read.artifacts) {
        yield artifactEvent(read, artifact, { append: false, lastChunk: true });
      }
      yield statusEvent(read);
      return;
    }
    const { state: readState } = requireStatus(read);
    if (readState !== state) yield statusEvent(read);
    state = readState;
  }
}

export async function* streamA2aMessage(
  caller: A2aCaller,
  params: SendMessageRequest,
): AsyncGenerator<StreamResponse> {
  const { task, events: started } = await startA2aTurn(caller, params);
  // why: subscribed before the read, or an event published between them is missed
  const events = started ?? a2aTaskEvents.subscribe(task.id);
  let release: (() => void) | undefined;
  try {
    const read = await readTask(task);
    if (!started && !isTerminal(read)) release = takeFollowerSlot(caller);
    yield taskEvent(read);
    if (isTerminal(read)) return;
    yield* followTask(caller, task, read, events);
  } finally {
    release?.();
    events.close();
  }
}

export async function* subscribeToA2aTask(
  caller: A2aCaller,
  taskId: string,
): AsyncGenerator<StreamResponse> {
  const task = await findA2aTask(caller, taskId);
  const events = a2aTaskEvents.subscribe(task.id);
  try {
    const read = await readTask(task);
    if (isTerminal(read)) {
      throw new UnsupportedOperationError(
        "The Task has ended; read it with GetTask",
      );
    }
    const release = takeFollowerSlot(caller);
    try {
      yield taskEvent(read);
      yield* followTask(caller, task, read, events);
    } finally {
      release();
    }
  } finally {
    events.close();
  }
}
