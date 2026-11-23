import { vi } from "vitest";

/** Tailwind's `lg` query, the width at which the panel sits beside the Chat. */
export const PANEL_QUERY = "(min-width: 1024px)";

/** A browser that treats the viewport as wide enough for the split, or not. */
export function stubWideViewport(wide: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: query === PANEL_QUERY ? wide : false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
}

/** Lays the row out at `width`, which jsdom otherwise reports as zero. */
export function layOutRow(width: number) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width,
    height: 600,
    top: 0,
    left: 0,
    bottom: 600,
    right: width,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  // The split primitive sizes its items by `offsetWidth`/`offsetHeight`, which
  // jsdom leaves at zero as well.
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(width);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
}

/**
 * Replaces the silent ResizeObserver stub with one that hands back a function
 * to fire every observer's callback — the component's row observer and the
 * split primitive's own. Call it before mounting the split.
 */
export function captureRowResize(): () => void {
  const observers: Array<{
    callback: ResizeObserverCallback;
    observer: ResizeObserver;
  }> = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private readonly callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
        observers.push({
          callback,
          observer: this,
        });
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  return () => {
    for (const { callback, observer } of observers) callback([], observer);
  };
}
