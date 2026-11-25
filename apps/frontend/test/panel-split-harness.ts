import { vi } from "vitest";

export const PANEL_QUERY = "(min-width: 1024px)";

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
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(width);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
}

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
