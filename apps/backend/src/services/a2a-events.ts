import { randomUUID } from "node:crypto";
import { parseJsonEventStream, uiMessageChunkSchema } from "ai";
import { TaskState, type Task } from "@a2a-js/sdk";
import { logger } from "../logger.ts";
import { notify, onNotification } from "../runs/notify-listener.ts";
import {
  readTaskAfresh,
  TERMINAL_TASK_STATES,
  type TaskRow,
} from "./a2a-task-state.ts";

/**
 * Every stream on an A2A Task gets the same events, in the same order (A2A
 * 1.0 §3.5.2, ADR-0032 #1308). The instance running a Task's run is its one
 * producer: it reads the run's own stream and publishes what happens — a
 * change of status, each piece of the reply, the end — as numbered events.
 * Streams on that instance get them in-process; every other instance gets
 * them through Postgres NOTIFY, each event carrying its piece of the reply,
 * so no instance reads another's memory. Each instance keeps the reply so far
 * of every Task it hears of, so a stream that joins mid-reply is sent it
 * first and then follows on.
 *
 * A notification lost while an instance's listener reconnects leaves a gap
 * in the numbers. A stream there then sends no more pieces of the reply, and
 * its followers' fallback poll (`a2aFallbackPollMs`) reads the Task's status
 * and end from the database, as a stream did before #1308.
 */

/** What happens to a Task, as its producer publishes it. */
export type A2aTaskEvent =
  /** A change of status short of the end, as `readTask` reads it. */
  | { kind: "status"; status: NonNullable<Task["status"]> }
  /**
   * A piece of the reply: `text` follows the first `offset` characters of
   * the reply artifact `artifactId`.
   */
  | { kind: "delta"; artifactId: string; offset: number; text: string }
  /**
   * The Task has ended. `task` is it as its producer read it, handed only to
   * streams on the producer's instance; any other reads it.
   */
  | { kind: "end"; task?: Task };

export type SequencedA2aTaskEvent = A2aTaskEvent & { seq: number };

/** The NOTIFY channel events travel on between instances. */
const CHANNEL = "a2a_task_event";

/**
 * The most of the reply one event carries. A NOTIFY payload must be under
 * 8000 bytes; this many characters fit at four bytes each with room to spare.
 */
const MAX_DELTA_CHARS = 1_500;

/** How long a Task's events are kept with no stream and no news of it. */
const LOG_TTL_MS = 10 * 60_000;

/**
 * How long a follower waits for an event before reading its Task from the
 * database, when no producer on its instance will tell it of the end.
 */
const FALLBACK_POLL_MS = 15_000;
let fallbackPollMs = FALLBACK_POLL_MS;

/** How long a follower with no producer here waits before reading its Task. */
export const a2aFallbackPollMs = (): number => fallbackPollMs;

/** Test seam: a shorter fallback poll, or the default with none. */
export const setA2aFallbackPollMs = (ms?: number): void => {
  fallbackPollMs = ms ?? FALLBACK_POLL_MS;
};

/** What an instance knows of one Task's events. */
type TaskLog = {
  subscriptions: Set<A2aTaskSubscription>;
  /** A producer on this instance is publishing them. */
  producing: boolean;
  /** The number the next event should carry; none seen yet when undefined. */
  nextSeq?: number;
  /** `replyText` is the whole reply so far: no event was missed. */
  complete: boolean;
  artifactId?: string;
  replyText: string;
  touchedAt: number;
};

/**
 * One stream's place in a Task's events, taken before it reads the Task so
 * nothing published meanwhile is missed. Close it when the stream ends.
 */
export class A2aTaskSubscription {
  /**
   * The reply so far, when this instance has all of it: a stream joining
   * mid-reply sends it first, as one artifact.
   */
  readonly catchUp: { artifactId: string; text: string } | undefined;
  /**
   * How much of the reply the stream will have sent, once it has sent
   * `catchUp`: a piece starting there is the next one. `null` when this
   * instance missed some of the reply, so pieces cannot be followed.
   */
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

  /**
   * Whether a producer on this instance will publish the Task's end. A
   * follower that has one waits for it; one that has none polls as well.
   */
  get produced(): boolean {
    return this.log.producing;
  }

  /** @internal Queues an event for the stream. */
  push(event: SequencedA2aTaskEvent): void {
    this.queue.push(event);
    this.wake?.();
  }

  /** @internal Wakes the stream with no event: its producer has stopped. */
  poke(): void {
    this.wake?.();
  }

  /**
   * The next event, or `undefined` once `timeoutMs` passes, `signal`
   * aborts, or the producer stops without an end. Waits with no timeout when
   * `timeoutMs` is undefined.
   */
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

/** Publishes one Task's events, as its producer. */
export type A2aTaskPublisher = {
  publish(event: A2aTaskEvent): void;
  /** Stops without an end: its followers fall back to polling. */
  stop(): void;
};

/**
 * One instance's view of every Task's events: those its producers publish,
 * and those it hears from other instances through `send` and `receive`.
 */
export class A2aTaskEventBus {
  private readonly logs = new Map<string, TaskLog>();
  private readonly instanceId: string;
  private readonly send: (payload: string) => Promise<void>;
  /** NOTIFYs go out one at a time, so they commit in the order published. */
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

  /** Hands `event` to every stream on the Task here, keeping the reply. */
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

  /**
   * Makes this instance the Task's producer.
   *
   * ponytail: one NOTIFY per piece of the reply, as the model streams it.
   * Coalesce pieces on a short timer, for every stream alike, if NOTIFY
   * traffic bites.
   */
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
        const sequenced = { ...event, seq: log.nextSeq!++ };
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

  /** A stream's place in the Task's events, from now on. */
  subscribe(taskId: string): A2aTaskSubscription {
    const log = this.logOf(taskId);
    const subscription = new A2aTaskSubscription(log, () => {
      log.subscriptions.delete(subscription);
      // A Task no event was heard of is not kept for a stream that left.
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

  /** An event another instance published, as NOTIFY delivered it. */
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

  /**
   * Forgets the Tasks no stream follows and nothing has been heard of for a
   * while: their end was missed, or their producer died with its instance.
   */
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

/** This instance's events. */
export const a2aTaskEvents = new A2aTaskEventBus({
  instanceId: randomUUID(),
  send: (payload) => notify(CHANNEL, payload),
});

onNotification(CHANNEL, (payload) => a2aTaskEvents.receive(payload));

// ------------------------------------------------------------------ producer

/** How often a producer re-reads a Task not yet `working`, at most. */
const STATUS_READ_MS = 1_000;
/** How often, and how many times, a producer reads its Task once its run's
 * stream closes, until the end its run wrote is there. */
const END_READ_MS = 250;
const END_READS = 120;

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `text` in pieces no larger than one event carries, never splitting a pair. */
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

/**
 * Makes this instance the producer of the Task whose run started here, and
 * returns the starting call's own subscription, taken before any of the
 * run's stream is read. The run's stream is read to its end whoever follows.
 */
export const produceA2aTaskEvents = (
  task: TaskRow,
  run: ReadableStream<Uint8Array>,
  bus: A2aTaskEventBus = a2aTaskEvents,
): A2aTaskSubscription => {
  const publisher = bus.produce(task.id);
  const starter = bus.subscribe(task.id);
  void produce(task, run, publisher);
  return starter;
};

/**
 * Publishes the run's text as it is produced, a change of state `readTask`
 * reports while the Task is `submitted`, and, once the run's stream closes
 * and its end is recorded, the end.
 */
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
    // A text part after the first is set apart as `readTask` joins them.
    let separate = false;
    for (;;) {
      // A cancel or a timeout aborts the run, breaking off its stream. How it
      // ended is the Task's to say.
      const next = await chunks.read().catch(() => null);
      if (!next || next.done) break;
      if (!next.value.success) continue;
      const chunk = next.value.value;
      if (chunk.type === "start" && chunk.messageId) {
        artifactId = chunk.messageId;
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
      // Past `submitted`, the only change left is the end, which follows
      // the stream's close.
      if (
        state === TaskState.TASK_STATE_SUBMITTED &&
        Date.now() - readAt >= STATUS_READ_MS
      ) {
        readAt = Date.now();
        const read = await readTaskAfresh(task);
        if (read.status!.state !== state) {
          state = read.status!.state;
          if (!TERMINAL_TASK_STATES.has(state)) {
            publisher.publish({ kind: "status", status: read.status! });
          }
        }
      }
    }
    for (let reads = 0; reads < END_READS; reads++) {
      const read = await readTaskAfresh(task);
      if (TERMINAL_TASK_STATES.has(read.status!.state)) {
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
