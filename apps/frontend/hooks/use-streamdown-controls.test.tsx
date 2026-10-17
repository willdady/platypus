import { describe, it, expect, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useStreamdownControls } from "./use-streamdown-controls";

// jsdom does not define `isSecureContext` at all.
const stubSecureContext = (secure: boolean) =>
  Object.defineProperty(window, "isSecureContext", {
    value: secure,
    configurable: true,
  });

afterEach(() => {
  Reflect.deleteProperty(window, "isSecureContext");
});

describe("useStreamdownControls", () => {
  it("keeps Streamdown's defaults in a secure context", () => {
    stubSecureContext(true);
    expect(renderHook(useStreamdownControls).result.current).toBeUndefined();
  });

  it("hides table copy over plain HTTP, where it cannot work", () => {
    stubSecureContext(false);
    expect(renderHook(useStreamdownControls).result.current).toEqual({
      table: { copy: false },
    });
  });
});
