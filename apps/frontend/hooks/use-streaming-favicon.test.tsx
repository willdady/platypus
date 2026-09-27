import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useStreamingFavicon } from "./use-streaming-favicon";

const DOT = "data:image/png;base64,dot";
const ORIGINAL = "http://localhost/favicon.ico";

// jsdom neither decodes images nor implements canvas, so both are faked: the
// image "loads" on a microtask and the canvas hands back a fixed data URL.
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  width = 32;
  height = 32;
  set src(_: string) {
    queueMicrotask(() => this.onload?.());
  }
}

const icon = () => document.querySelector<HTMLLinkElement>('link[rel="icon"]')!;

const flush = () => act(async () => {});

describe("useStreamingFavicon", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("Image", FakeImage);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(DOT);
    document.head.innerHTML = `<link rel="icon" href="${ORIGINAL}">`;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does nothing while inactive", async () => {
    renderHook(() => useStreamingFavicon(false));
    await flush();
    act(() => vi.advanceTimersByTime(3000));
    expect(icon().href).toBe(ORIGINAL);
  });

  it("toggles the dot frame while active", async () => {
    renderHook(() => useStreamingFavicon(true));
    await flush();
    act(() => vi.advanceTimersByTime(700));
    expect(icon().href).toBe(DOT);
    act(() => vi.advanceTimersByTime(700));
    expect(icon().href).toBe(ORIGINAL);
    act(() => vi.advanceTimersByTime(700));
    expect(icon().href).toBe(DOT);
  });

  it("restores the original icon and stops on active=false", async () => {
    const { rerender } = renderHook(
      ({ active }) => useStreamingFavicon(active),
      {
        initialProps: { active: true },
      },
    );
    await flush();
    act(() => vi.advanceTimersByTime(700));
    expect(icon().href).toBe(DOT);

    rerender({ active: false });
    expect(icon().href).toBe(ORIGINAL);
    act(() => vi.advanceTimersByTime(3000));
    expect(icon().href).toBe(ORIGINAL);
  });

  it("restores the original icon on unmount", async () => {
    const { unmount } = renderHook(() => useStreamingFavicon(true));
    await flush();
    act(() => vi.advanceTimersByTime(700));
    expect(icon().href).toBe(DOT);

    unmount();
    expect(icon().href).toBe(ORIGINAL);
  });

  it("never starts blinking when unmounted before the frame is built", async () => {
    const { unmount } = renderHook(() => useStreamingFavicon(true));
    unmount();
    await flush();
    act(() => vi.advanceTimersByTime(3000));
    expect(icon().href).toBe(ORIGINAL);
  });

  it("leaves the static icon alone when there is no 2D context", async () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
    renderHook(() => useStreamingFavicon(true));
    await flush();
    act(() => vi.advanceTimersByTime(3000));
    expect(icon().href).toBe(ORIGINAL);
  });
});
