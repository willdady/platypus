import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";
import { navigationMock, toastMock } from "@/test/test-utils";

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  ...navigationMock,
}));
vi.mock("sonner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("sonner")>()),
  ...toastMock,
}));

if (typeof window !== "undefined") {
  // why: plain assignment, so the per-test unstubGlobals leaves these in place
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
