import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setErrorReporter } from "@/lib/error-reporting";

beforeAll(async () => {
  await import("./instrumentation-client");
});

afterEach(() => setErrorReporter(null));

describe("instrumentation-client", () => {
  it("reports a promise rejection nothing handled", () => {
    const reporter = vi.fn();
    setErrorReporter(reporter);
    const reason = new Error("nobody caught me");

    window.dispatchEvent(
      Object.assign(new Event("unhandledrejection"), { reason }),
    );

    expect(reporter).toHaveBeenCalledWith(reason, {
      source: "unhandledrejection",
    });
  });

  it("reports an uncaught error", () => {
    const reporter = vi.fn();
    setErrorReporter(reporter);
    const error = new Error("thrown from a timer");

    window.dispatchEvent(new ErrorEvent("error", { error, message: "x" }));

    expect(reporter).toHaveBeenCalledWith(error, { source: "window-error" });
  });
});
