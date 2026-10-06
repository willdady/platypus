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
import { findA2aTask, isTerminal, type TaskRow } from "./a2a-task-state.ts";
import { readTask, readTaskAfresh } from "./a2a-task-lifecycle.ts";
import {
  a2aFallbackPollMs,
  a2aTaskEvents,
  type A2aTaskSubscription,
} from "./a2a-events.ts";
import { callerIsLive } from "./a2a-liveness.ts";
import { replyArtifact } from "./a2a-parts.ts";

/**
 * A2A Tasks over SSE (ADR-0032): `SendStreamingMessage` and `SubscribeToTask`.
 * Every stream on a Task, on any instance, follows the same events
 * (`a2a-events.ts`): the reply as it is written, each change of status, and
 * the end, when it reads the Task, so its last events say what `GetTask`
 * says. A follower of a run it did not start holds a follower slot until its
 * stream ends (`takeFollowerSlot`).
 */

/**
 * Ends the stream with an error once the caller's access is cut off: it is
 * told nothing more, as a new call would be told nothing.
 */
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
      metadata: undefined,
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

/**
 * From `seen` on: the reply so far when `events` has it, then each piece of
 * the reply and each change of state, then, once the Task ends, its
 * artifacts whole and its terminal status, which ends the stream. Ends at
 * once when the client hangs up. With no producer on this instance to say
 * the Task ended, it is also read every `a2aFallbackPollMs`.
 */
async function* followTask(
  caller: A2aCaller,
  task: TaskRow,
  seen: Task,
  events: A2aTaskSubscription,
): AsyncGenerator<StreamResponse> {
  let state = seen.status!.state;
  // How much of the reply this stream has sent; `null` once it missed some.
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
        : (event?.kind === "end" && event.task) || (await readTaskAfresh(task));
    if (isTerminal(read)) {
      for (const artifact of read.artifacts) {
        yield artifactEvent(read, artifact, { append: false, lastChunk: true });
      }
      yield statusEvent(read);
      return;
    }
    if (read.status!.state !== state) yield statusEvent(read);
    state = read.status!.state;
  }
}

/**
 * `SendStreamingMessage`: the turn's Task, its reply as the run writes it,
 * then its artifact whole and its terminal status. A retry of a message
 * follows the Task it already started, as `SubscribeToTask` does, on a
 * follower slot: past the follower cap it is refused before its first event.
 */
export async function* streamA2aMessage(
  caller: A2aCaller,
  params: SendMessageRequest,
): AsyncGenerator<StreamResponse> {
  const { task, events: started } = await startA2aTurn(caller, params);
  // Taken before the Task is read, so nothing published meanwhile is missed.
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
    // Stops following the run, never the run: it goes on server-side.
    events.close();
  }
}

/**
 * `SubscribeToTask`: one of this endpoint's Tasks from its current state
 * onward, on a follower slot. A Task that has ended has nothing more to say;
 * `GetTask` reads it.
 */
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
