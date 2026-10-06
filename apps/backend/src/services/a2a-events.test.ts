import { describe, it, expect, vi } from "vitest";

vi.mock("../index.ts", () => ({ db: {} }));

const { A2aTaskEventBus } = await import("./a2a-events.ts");

/**
 * Two instances sharing one Postgres: what one publishes reaches the other
 * through NOTIFY, unless `drop` says that notification is lost.
 */
const twoInstances = (drop: (payload: string) => boolean = () => false) => {
  const sent: string[] = [];
  const elsewhere = new A2aTaskEventBus({
    instanceId: "b",
    send: () => Promise.resolve(),
  });
  const here = new A2aTaskEventBus({
    instanceId: "a",
    send: (payload) => {
      sent.push(payload);
      if (!drop(payload)) elsewhere.receive(payload);
      // Postgres delivers a NOTIFY to its sender's listener too.
      here.receive(payload);
      return Promise.resolve();
    },
  });
  return { here, elsewhere, sent };
};

/** Lets the serialized NOTIFYs go out. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const delta = (offset: number, text: string) => ({
  kind: "delta" as const,
  artifactId: "reply-1",
  offset,
  text,
});

describe("A2aTaskEventBus", () => {
  it("hands every stream on the Task, on either instance, the same events in order", async () => {
    const { here, elsewhere } = twoInstances();
    const local = here.subscribe("task-1");
    const remote = elsewhere.subscribe("task-1");
    const publisher = here.produce("task-1");

    publisher.publish(delta(0, "Hello "));
    publisher.publish(delta(6, "there"));
    publisher.publish({ kind: "end" });
    await settle();

    const drain = async (sub: typeof local) => {
      const events = [];
      for (let e = await sub.next(0); e; e = await sub.next(0)) events.push(e);
      return events;
    };
    const heardHere = await drain(local);
    expect(heardHere.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(await drain(remote)).toEqual(heardHere);
  });

  it("sends a stream joining mid-reply on another instance the reply so far", async () => {
    const { here, elsewhere } = twoInstances();
    const publisher = here.produce("task-1");
    publisher.publish(delta(0, "Hello "));
    publisher.publish(delta(6, "there"));
    await settle();

    const late = elsewhere.subscribe("task-1");

    expect(late.catchUp).toEqual({
      artifactId: "reply-1",
      text: "Hello there",
    });
    expect(late.replyFrom).toBe(11);
  });

  it("follows no more of the reply on an instance that missed a piece of it", async () => {
    const { here, elsewhere } = twoInstances((payload) =>
      payload.includes('"seq":2'),
    );
    const publisher = here.produce("task-1");
    publisher.publish(delta(0, "Hello "));
    publisher.publish(delta(6, "there"));
    publisher.publish(delta(11, "!"));
    await settle();

    const late = elsewhere.subscribe("task-1");

    expect(late.catchUp).toBeUndefined();
    expect(late.replyFrom).toBeNull();
  });

  it("says nothing of the reply's start to a stream joining after it was missed", () => {
    const { elsewhere } = twoInstances();
    // Its listener was down for the first events.
    elsewhere.receive(
      JSON.stringify({
        instanceId: "a",
        taskId: "task-1",
        event: { ...delta(6, "there"), seq: 2 },
      }),
    );

    expect(elsewhere.subscribe("task-1").replyFrom).toBeNull();
  });

  it("lets a stream know when its producer stops without an end", async () => {
    const { here } = twoInstances();
    const publisher = here.produce("task-1");
    const sub = here.subscribe("task-1");
    expect(sub.produced).toBe(true);

    const waiting = sub.next(undefined);
    publisher.stop();

    expect(await waiting).toBeUndefined();
    expect(sub.produced).toBe(false);
  });

  it("stops waiting when the client hangs up", async () => {
    const { here } = twoInstances();
    here.produce("task-1");
    const sub = here.subscribe("task-1");
    const hangUp = new AbortController();

    const waiting = sub.next(undefined, hangUp.signal);
    hangUp.abort();

    expect(await waiting).toBeUndefined();
  });
});
