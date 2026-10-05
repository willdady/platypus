import { parseJsonEventStream, uiMessageChunkSchema } from "ai";
import type {
  Artifact,
  SendMessageRequest,
  StreamResponse,
  Task,
} from "@a2a-js/sdk";
import { UnsupportedOperationError } from "@a2a-js/sdk/errors";
import { findA2aTask, startA2aTurn, type A2aCaller } from "./a2a-task.ts";
import {
  readTask,
  TERMINAL_TASK_STATES,
  type TaskRow,
} from "./a2a-task-state.ts";

/**
 * A2A Tasks over SSE (ADR-0032): `SendStreamingMessage` and `SubscribeToTask`.
 * Status always comes from `readTask`, so it says what `GetTask` says. Token
 * deltas exist only on the connection that started the run, read from the
 * run's own stream; any other follower, on any instance, gets status and
 * artifact events read from the database.
 */

/** How often a stream re-reads its Task's status. */
const STREAM_POLL_MS = 1_000;

const isTerminal = (task: Task) => TERMINAL_TASK_STATES.has(task.status!.state);

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

/** A piece of the reply's text, as `readTask` names its artifact. */
const replyDelta = (artifactId: string, text: string): Artifact => ({
  artifactId,
  name: "reply",
  description: "",
  parts: [
    {
      content: { $case: "text", value: text },
      metadata: undefined,
      filename: "",
      mediaType: "text/plain",
    },
  ],
  metadata: undefined,
  extensions: [],
});

/**
 * From `seen` on: each change of state `readTask` reports, then, once the
 * Task ends, its artifacts whole and its terminal status, which ends the
 * stream.
 */
async function* followTask(
  task: TaskRow,
  seen: Task,
): AsyncGenerator<StreamResponse> {
  let last = seen;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, STREAM_POLL_MS));
    const read = await readTask(task);
    if (isTerminal(read)) {
      for (const artifact of read.artifacts) {
        yield artifactEvent(read, artifact, { append: false, lastChunk: true });
      }
      yield statusEvent(read);
      return;
    }
    if (read.status!.state !== last.status!.state) yield statusEvent(read);
    last = read;
  }
}

/** The run's response body, read as UI message chunks. */
const readChunks = (run: ReadableStream<Uint8Array>) =>
  parseJsonEventStream({
    stream: run,
    schema: uiMessageChunkSchema,
  }).getReader();
type ChunkReader = ReturnType<typeof readChunks>;

/**
 * The run's text as it is produced, as appends to the reply artifact, with
 * any change of state `readTask` reports along the way. Returns the Task as
 * last read once the run's stream ends.
 */
async function* streamRun(
  seen: Task,
  task: TaskRow,
  chunks: ChunkReader,
): AsyncGenerator<StreamResponse, Task> {
  let last = seen;
  let readAt = Date.now();
  let replyId = task.id;
  let sent = false;
  // A text part after the first is set apart as `readTask` joins them.
  let separate = false;
  for (;;) {
    let next: Awaited<ReturnType<ChunkReader["read"]>>;
    try {
      next = await chunks.read();
    } catch {
      // A cancel or a timeout aborts the run, breaking off its stream. How
      // it ended is the Task's to say.
      return last;
    }
    const { done, value } = next;
    if (done) return last;
    if (!value.success) continue;
    const chunk = value.value;
    if (chunk.type === "start" && chunk.messageId) replyId = chunk.messageId;
    if (chunk.type === "text-start" && sent) separate = true;
    if (chunk.type === "text-delta" && chunk.delta) {
      const text = separate ? `\n\n${chunk.delta}` : chunk.delta;
      yield artifactEvent(seen, replyDelta(replyId, text), {
        append: sent,
        lastChunk: false,
      });
      sent = true;
      separate = false;
    }
    if (Date.now() - readAt >= STREAM_POLL_MS) {
      readAt = Date.now();
      const read = await readTask(task);
      if (read.status!.state !== last.status!.state) yield statusEvent(read);
      last = read;
    }
  }
}

/**
 * `SendStreamingMessage`: the turn's Task, its reply as the run writes it,
 * then its artifact whole and its terminal status. A retry of a message
 * follows the Task it already started, without token deltas.
 */
export async function* streamA2aMessage(
  caller: A2aCaller,
  params: SendMessageRequest,
): AsyncGenerator<StreamResponse> {
  const { task, run } = await startA2aTurn(caller, params);
  const chunks = run && readChunks(run);
  try {
    const read = await readTask(task);
    yield taskEvent(read);
    if (isTerminal(read)) return;
    yield* followTask(
      task,
      chunks ? yield* streamRun(read, task, chunks) : read,
    );
  } finally {
    // Stops reading the run, never the run: it goes on server-side.
    await chunks?.cancel();
  }
}

/**
 * `SubscribeToTask`: one of this endpoint's Tasks from its current state
 * onward. A Task that has ended has nothing more to say; `GetTask` reads it.
 */
export async function* subscribeToA2aTask(
  caller: A2aCaller,
  taskId: string,
): AsyncGenerator<StreamResponse> {
  const task = await findA2aTask(caller, taskId);
  const read = await readTask(task);
  if (isTerminal(read)) {
    throw new UnsupportedOperationError(
      "The Task has ended; read it with GetTask",
    );
  }
  yield taskEvent(read);
  yield* followTask(task, read);
}
