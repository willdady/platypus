import { randomUUID } from "node:crypto";
import { parseJsonEventStream, uiMessageChunkSchema } from "ai";
import { TaskState, type Task } from "@a2a-js/sdk";
import { logger } from "../logger.ts";
import { notify, onNotification } from "../runs/notify-listener.ts";
import { firstOutputLatch } from "../runs/first-output.ts";
import {
  isTerminal,
  requireStatus,
  TERMINAL_TASK_STATES,
  type TaskRow,
} from "./a2a-task-state.ts";
import { readTaskAfresh } from "./a2a-task-lifecycle.ts";

export type A2aTaskEvent =
  | { kind: "status"; status: NonNullable<Task["status"]> }
  | { kind: "delta"; artifactId: string; offset: number; text: string }
  | { kind: "end"; task?: Task };

export type SequencedA2aTaskEvent = A2aTaskEvent & { seq: number };

const CHANNEL = "a2a_task_event";

// why: a NOTIFY payload must stay under 8000 bytes, at up to 4 bytes a character
const MAX_DELTA_CHARS = 1_500;

const LOG_TTL_MS = 10 * 60_000;

const FALLBACK_POLL_MS = 15_000;

export const a2aFallbackPollMs = (): number => FALLBACK_POLL_MS;

type TaskLog = {
  subscriptions: Set<A2aTaskSubscription>;
  producing: boolean;
  nextSeq?: number;
  complete: boolean;
  artifactId?: string;
  replyText: string;
  touchedAt: number;
};

export class A2aTaskSubscription {
  readonly catchUp: { artifactId: string; text: string } | undefined;
  readonly replyFrom: number | null;
  private readonly log: TaskLog;
  private readonly onClose: () => void;
  private readonly queue: SequencedA2aTaskEvent[] = [];
  private wake: (() => void) | undefined;

  constructor(log: TaskLog, onClose: () => void) {
    this.log = log;
    this.onClose = onClose;
    if (log.complete && log.replyText && log.artifactId) {
      this.catchUp = { artifactId: log.artifactId, text: log.replyText };
    }
    this.replyFrom =
      log.complete || log.nextSeq === undefined ? log.replyText.length : null;
  }

  get produced(): boolean {
    return this.log.producing;
  }

  push(event: SequencedA2aTaskEvent): void {
    this.queue.push(event);
    this.wake?.();
  }

  poke(): void {
    this.wake?.();
  }

  next(
    timeoutMs: number | undefined,
    signal?: AbortSignal,
  ): Promise<SequencedA2aTaskEvent | undefined> {
    const queued = this.queue.shift();
    if (queued || signal?.aborted) return Promise.resolve(queued);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        this.wake = undefined;
        resolve(this.queue.shift());
      };
      const timer =
        timeoutMs === undefined ? undefined : setTimeout(done, timeoutMs);
      signal?.addEventListener("abort", done, { once: true });
      this.wake = done;
    });
  }

  close(): void {
    this.onClose();
  }
}

export type A2aTaskPublisher = {
  publish(event: A2aTaskEvent): void;
  stop(): void;
};

export class A2aTaskEventBus {
  private readonly logs = new Map<string, TaskLog>();
  private readonly instanceId: string;
  private readonly send: (payload: string) => Promise<void>;
  // why: one NOTIFY at a time, so they commit in the order published
  private sending: Promise<void> = Promise.resolve();
  private sweptAt = Date.now();

  constructor(options: {
    instanceId: string;
    send: (payload: string) => Promise<void>;
  }) {
    this.instanceId = options.instanceId;
    this.send = options.send;
  }

  private logOf(taskId: string): TaskLog {
    let log = this.logs.get(taskId);
    if (!log) {
      log = {
        subscriptions: new Set(),
        producing: false,
        complete: false,
        replyText: "",
        touchedAt: Date.now(),
      };
      this.logs.set(taskId, log);
    }
    return log;
  }

  private deliver(taskId: string, log: TaskLog, event: SequencedA2aTaskEvent) {
    log.touchedAt = Date.now();
    if (event.kind === "delta") {
      if (event.offset === log.replyText.length) {
        log.artifactId = event.artifactId;
        log.replyText += event.text;
      } else {
        log.complete = false;
      }
    }
    for (const subscription of log.subscriptions) subscription.push(event);
    if (event.kind === "end" && this.logs.get(taskId) === log) {
      log.producing = false;
      this.logs.delete(taskId);
    }
  }

  produce(taskId: string): A2aTaskPublisher {
    const log = this.logOf(taskId);
    log.producing = true;
    if (log.nextSeq === undefined) {
      log.nextSeq = 1;
      log.complete = true;
    }
    return {
      publish: (event) => {
        if (!log.producing) return;
        if (log.nextSeq === undefined) {
          throw new Error(`Task '${taskId}' log lost its sequence`);
        }
        const sequenced = { ...event, seq: log.nextSeq++ };
        this.deliver(taskId, log, sequenced);
        const wire = event.kind === "end" ? { kind: "end" } : event;
        const payload = JSON.stringify({
          instanceId: this.instanceId,
          taskId,
          event: { ...wire, seq: sequenced.seq },
        });
        this.sending = this.sending
          .then(() => this.send(payload))
          .catch((error: unknown) =>
            logger.warn({ error, taskId }, "Could not publish an A2A event"),
          );
      },
      stop: () => {
        if (!log.producing) return;
        log.producing = false;
        for (const subscription of log.subscriptions) subscription.poke();
      },
    };
  }

  subscribe(taskId: string): A2aTaskSubscription {
    const log = this.logOf(taskId);
    const subscription = new A2aTaskSubscription(log, () => {
      log.subscriptions.delete(subscription);
      if (
        !log.subscriptions.size &&
        !log.producing &&
        log.nextSeq === undefined &&
        this.logs.get(taskId) === log
      ) {
        this.logs.delete(taskId);
      }
    });
    log.subscriptions.add(subscription);
    return subscription;
  }

  receive(payload: string): void {
    let message: {
      instanceId: string;
      taskId: string;
      event: SequencedA2aTaskEvent;
    };
    try {
      message = JSON.parse(payload) as typeof message;
    } catch {
      return;
    }
    if (message.instanceId === this.instanceId) return;
    this.sweep();
    const log = this.logOf(message.taskId);
    const { seq } = message.event;
    if (log.nextSeq === undefined) log.complete = seq === 1;
    else if (seq !== log.nextSeq) log.complete = false;
    log.nextSeq = seq + 1;
    this.deliver(message.taskId, log, message.event);
  }

  private sweep(): void {
    const now = Date.now();
    if (now - this.sweptAt < 60_000) return;
    this.sweptAt = now;
    for (const [taskId, log] of this.logs) {
      if (
        !log.producing &&
        !log.subscriptions.size &&
        now - log.touchedAt > LOG_TTL_MS
      ) {
        this.logs.delete(taskId);
      }
    }
  }
}

export const a2aTaskEvents = new A2aTaskEventBus({
  instanceId: randomUUID(),
  send: (payload) => notify(CHANNEL, payload),
});

onNotification(CHANNEL, (payload) => a2aTaskEvents.receive(payload));

const STATUS_READ_MS = 1_000;
const END_READ_MS = 250;
const END_READS = 120;

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const pieces = (text: string): string[] => {
  const out: string[] = [];
  let at = 0;
  while (at < text.length) {
    let end = Math.min(at + MAX_DELTA_CHARS, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    out.push(text.slice(at, end));
    at = end;
  }
  return out;
};

export const produceA2aTaskEvents = (
  task: TaskRow,
  run: ReadableStream<Uint8Array>,
): A2aTaskSubscription => {
  const publisher = a2aTaskEvents.produce(task.id);
  const starter = a2aTaskEvents.subscribe(task.id);
  void produce(task, run, publisher);
  return starter;
};

const produce = async (
  task: TaskRow,
  run: ReadableStream<Uint8Array>,
  publisher: A2aTaskPublisher,
): Promise<void> => {
  const chunks = parseJsonEventStream({
    stream: run,
    schema: uiMessageChunkSchema,
  }).getReader();
  let ended = false;
  try {
    let state: TaskState = TaskState.TASK_STATE_SUBMITTED;
    let readAt = Date.now();
    let artifactId = task.id;
    let offset = 0;
    // why: set apart with "\n\n" as recordedReplies joins parts, so offsets match a read
    let separate = false;
    const isFirstOutput = firstOutputLatch();
    for (;;) {
      // why: a cancel or timeout breaks the stream off; how it ended is the Task's to say
      const next = await chunks.read().catch(() => null);
      if (!next || next.done) break;
      if (!next.value.success) continue;
      const chunk = next.value.value;
      if (chunk.type === "start" && chunk.messageId) {
        artifactId = chunk.messageId;
      }
      const firstOutput = isFirstOutput(chunk);
      if (
        state === TaskState.TASK_STATE_SUBMITTED &&
        (firstOutput || Date.now() - readAt >= STATUS_READ_MS)
      ) {
        readAt = Date.now();
        const read = await readTaskAfresh(task);
        const status = requireStatus(read);
        if (status.state !== state) {
          state = status.state;
          if (!TERMINAL_TASK_STATES.has(state)) {
            publisher.publish({ kind: "status", status });
          }
        }
      }
      if (chunk.type === "text-start" && offset > 0) separate = true;
      if (chunk.type === "text-delta" && chunk.delta) {
        const text = separate ? `\n\n${chunk.delta}` : chunk.delta;
        separate = false;
        for (const piece of pieces(text)) {
          publisher.publish({ kind: "delta", artifactId, offset, text: piece });
          offset += piece.length;
        }
      }
    }
    for (let reads = 0; reads < END_READS; reads++) {
      const read = await readTaskAfresh(task);
      if (isTerminal(read)) {
        publisher.publish({ kind: "end", task: read });
        ended = true;
        return;
      }
      await wait(END_READ_MS);
    }
  } catch (error) {
    logger.warn({ error, taskId: task.id }, "A2A Task events stopped");
  } finally {
    if (!ended) publisher.stop();
    await chunks.cancel().catch(() => undefined);
  }
};
