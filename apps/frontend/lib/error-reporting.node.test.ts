import { afterEach, describe, expect, it, vi } from "vitest";
import { reportClientError, setErrorReporter } from "./error-reporting";

afterEach(() => setErrorReporter(null));

describe("reportClientError", () => {
  it("sends nothing anywhere until a reporter is set", () => {
    expect(() =>
      reportClientError(new Error("boom"), { source: "segment" }),
    ).not.toThrow();
  });

  it("hands the error and where it was caught to the reporter", () => {
    const reporter = vi.fn();
    setErrorReporter(reporter);
    const error = new Error("boom");

    reportClientError(error, { source: "root", digest: "abc" });

    expect(reporter).toHaveBeenCalledWith(error, {
      source: "root",
      digest: "abc",
    });
  });

  it("stops sending once the reporter is cleared", () => {
    const reporter = vi.fn();
    setErrorReporter(reporter);
    setErrorReporter(null);

    reportClientError(new Error("boom"), { source: "segment" });

    expect(reporter).not.toHaveBeenCalled();
  });

  it("swallows a reporter that throws", () => {
    setErrorReporter(() => {
      throw new Error("reporter down");
    });

    expect(() =>
      reportClientError(new Error("boom"), { source: "segment" }),
    ).not.toThrow();
  });
});
