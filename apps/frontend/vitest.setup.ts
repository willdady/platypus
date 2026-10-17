import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";
import { navigationMock, toastMock } from "@/test/test-utils";

// Default module mocks for every test file. A file that needs something else
// still calls `vi.mock` itself, which replaces these for that file. Both hand
// out the shared spies in `test/test-utils` (`push`, `refresh`, `toastError`,
// …), so a test asserts on those rather than declaring its own.
//
// `next/navigation`: the App Router hooks throw outside a mounted router, so
// `useRouter` is stubbed; `redirect`, `notFound` and the rest stay real.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  ...navigationMock,
}));
// `sonner`: `toast` is stubbed so nothing renders a toast; `Toaster` stays real.
vi.mock("sonner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("sonner")>()),
  ...toastMock,
}));

// What jsdom leaves out and Radix, cmdk and the media-query hooks call. Plain
// assignments rather than `vi.stubGlobal`, so the per-test `unstubGlobals`
// (vitest.config.ts) leaves them in place. A test that needs something else —
// a matching media query, a spy on `scrollIntoView` — assigns its own.
if (typeof window !== "undefined") {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });

  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

  Element.prototype.scrollIntoView = () => {};
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
}
