import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  debounceTriggerExecution,
  clearPendingTriggers,
} from "./event-trigger-debounce.ts";

const makeTrigger = (id: string) =>
  ({ id, workspaceId: "ws-1" }) as Parameters<
    typeof debounceTriggerExecution
  >[1];

const makeContext = (data: unknown) =>
  ({
    eventType: "card.updated" as const,
    eventData: data,
  }) as Parameters<typeof debounceTriggerExecution>[2];

describe("event-trigger-debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearPendingTriggers();
  });

  afterEach(() => {
    clearPendingTriggers();
    vi.useRealTimers();
  });

  it("should fire after 5s delay", () => {
    const executeFn = vi.fn().mockResolvedValue(undefined);
    const trigger = makeTrigger("t-1");
    const ctx = makeContext({ id: "card-1" });

    debounceTriggerExecution("t-1:card-1", trigger, ctx, executeFn);

    expect(executeFn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5_000);

    expect(executeFn).toHaveBeenCalledOnce();
    expect(executeFn).toHaveBeenCalledWith(trigger, ctx);
  });

  it("should coalesce rapid events and use latest data", () => {
    const executeFn = vi.fn().mockResolvedValue(undefined);
    const trigger = makeTrigger("t-1");

    const ctx1 = makeContext({ id: "card-1", title: "first" });
    const ctx2 = makeContext({ id: "card-1", title: "second" });
    const ctx3 = makeContext({ id: "card-1", title: "third" });

    debounceTriggerExecution("t-1:card-1", trigger, ctx1, executeFn);
    vi.advanceTimersByTime(1_000);
    debounceTriggerExecution("t-1:card-1", trigger, ctx2, executeFn);
    vi.advanceTimersByTime(1_000);
    debounceTriggerExecution("t-1:card-1", trigger, ctx3, executeFn);

    // Not yet fired
    vi.advanceTimersByTime(4_999);
    expect(executeFn).not.toHaveBeenCalled();

    // Now 5s after last event
    vi.advanceTimersByTime(1);
    expect(executeFn).toHaveBeenCalledOnce();
    expect(executeFn).toHaveBeenCalledWith(trigger, ctx3);
  });

  it("should fire independently for different debounce keys", () => {
    const executeFn = vi.fn().mockResolvedValue(undefined);
    const trigger1 = makeTrigger("t-1");
    const trigger2 = makeTrigger("t-2");
    const ctx1 = makeContext({ id: "card-1" });
    const ctx2 = makeContext({ id: "card-2" });

    debounceTriggerExecution("t-1:card-1", trigger1, ctx1, executeFn);
    debounceTriggerExecution("t-2:card-2", trigger2, ctx2, executeFn);

    vi.advanceTimersByTime(5_000);

    expect(executeFn).toHaveBeenCalledTimes(2);
    expect(executeFn).toHaveBeenCalledWith(trigger1, ctx1);
    expect(executeFn).toHaveBeenCalledWith(trigger2, ctx2);
  });

  it("should reset timer on each new event", () => {
    const executeFn = vi.fn().mockResolvedValue(undefined);
    const trigger = makeTrigger("t-1");

    debounceTriggerExecution(
      "t-1:card-1",
      trigger,
      makeContext({ id: "card-1", v: 1 }),
      executeFn,
    );

    // Advance 4s, then send another event
    vi.advanceTimersByTime(4_000);
    expect(executeFn).not.toHaveBeenCalled();

    const latestCtx = makeContext({ id: "card-1", v: 2 });
    debounceTriggerExecution("t-1:card-1", trigger, latestCtx, executeFn);

    // 4s after second event — still not fired
    vi.advanceTimersByTime(4_000);
    expect(executeFn).not.toHaveBeenCalled();

    // 5s after second event — fires
    vi.advanceTimersByTime(1_000);
    expect(executeFn).toHaveBeenCalledOnce();
    expect(executeFn).toHaveBeenCalledWith(trigger, latestCtx);
  });

  it("should cancel all pending executions with clearPendingTriggers", () => {
    const executeFn = vi.fn().mockResolvedValue(undefined);

    debounceTriggerExecution(
      "t-1:card-1",
      makeTrigger("t-1"),
      makeContext({ id: "card-1" }),
      executeFn,
    );
    debounceTriggerExecution(
      "t-2:card-2",
      makeTrigger("t-2"),
      makeContext({ id: "card-2" }),
      executeFn,
    );

    clearPendingTriggers();

    vi.advanceTimersByTime(10_000);

    expect(executeFn).not.toHaveBeenCalled();
  });
});
