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
}

/**
 * Replaces the silent ResizeObserver stub with one that hands back a function
 * to fire the row's resize callback. Call it before mounting the split.
 */
export function captureRowResize(): () => void {
  let resize: (() => void) | undefined;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = () => callback([], this);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  return () => resize?.();
}
