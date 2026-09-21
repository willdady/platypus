import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { PullToRefresh } from "./pull-to-refresh";

const touchAt = (clientY: number, clientX = 0) => ({ clientX, clientY });

const renderPullToRefresh = (
  onRefresh: () => Promise<void>,
  { disabled = false }: { disabled?: boolean } = {},
) => {
  const view = render(
    <PullToRefresh onRefresh={onRefresh} disabled={disabled}>
      <div>content</div>
    </PullToRefresh>,
  );
  return { view, container: view.container.firstElementChild as HTMLElement };
};

/**
 * Walks the gesture the component expects: a small move inside the settle
 * window, a pause past the settle period, then the pull itself. A single large
 * move would be disqualified as a flick.
 */
const pullDown = (container: HTMLElement, endY: number) => {
  fireEvent.touchStart(container, { touches: [touchAt(0)] });
  fireEvent.touchMove(container, { touches: [touchAt(10)] });
  vi.advanceTimersByTime(110);
  fireEvent.touchMove(container, { touches: [touchAt(10)] });
  fireEvent.touchMove(container, { touches: [touchAt(endY)] });
};

describe("PullToRefresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes once the pull passes the threshold", async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const { container } = renderPullToRefresh(onRefresh);

    pullDown(container, 200);
    await act(async () => {
      fireEvent.touchEnd(container);
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh on a pull short of the threshold", async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const { container } = renderPullToRefresh(onRefresh);

    pullDown(container, 100);
    await act(async () => {
      fireEvent.touchEnd(container);
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("ignores a gesture that starts with the container scrolled down", async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const { container } = renderPullToRefresh(onRefresh);
    container.scrollTop = 40;

    pullDown(container, 200);
    await act(async () => {
      fireEvent.touchEnd(container);
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(onRefresh).not.toHaveBeenCalled();
  });

  // A flick disqualifies the whole gesture, so a fast scroll can't refresh.
  it("ignores a gesture that moves too far before the settle period", async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const { container } = renderPullToRefresh(onRefresh);

    fireEvent.touchStart(container, { touches: [touchAt(0)] });
    fireEvent.touchMove(container, { touches: [touchAt(120)] });
    vi.advanceTimersByTime(110);
    fireEvent.touchMove(container, { touches: [touchAt(120)] });
    await act(async () => {
      fireEvent.touchEnd(container);
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("ignores a horizontal swipe", async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const { container } = renderPullToRefresh(onRefresh);

    fireEvent.touchStart(container, { touches: [touchAt(0)] });
    fireEvent.touchMove(container, { touches: [touchAt(5, 100)] });
    vi.advanceTimersByTime(110);
    fireEvent.touchMove(container, { touches: [touchAt(5, 100)] });
    await act(async () => {
      fireEvent.touchEnd(container);
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("does not refresh while disabled", async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const { container } = renderPullToRefresh(onRefresh, { disabled: true });

    pullDown(container, 200);
    await act(async () => {
      fireEvent.touchEnd(container);
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("does not start a second refresh while one is in flight", async () => {
    let resolveRefresh: () => void = () => {};
    const onRefresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const { container } = renderPullToRefresh(onRefresh);

    pullDown(container, 200);
    fireEvent.touchEnd(container);
    pullDown(container, 200);
    fireEvent.touchEnd(container);

    expect(onRefresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRefresh();
      await vi.advanceTimersByTimeAsync(600);
    });
  });
});
