import { afterEach, describe, it, expect, vi } from "vitest";
import { replaceSearchParam } from "./search-params";

function stubWindow(search: string, pathname = "/org1/chat") {
  const replaceState = vi.fn();
  vi.stubGlobal("window", {
    location: { search, pathname },
    history: { replaceState },
  });
  return replaceState;
}

afterEach(() => vi.unstubAllGlobals());

describe("replaceSearchParam", () => {
  it("sets a param in place rather than navigating", () => {
    const replaceState = stubWindow("?page=2");

    replaceSearchParam("model", "gpt-4");

    expect(replaceState).toHaveBeenCalledWith(null, "", "?page=2&model=gpt-4");
  });

  it("removes a param and keeps the rest of the query string", () => {
    const replaceState = stubWindow("?page=2&model=gpt-4");

    replaceSearchParam("model", null);

    expect(replaceState).toHaveBeenCalledWith(null, "", "?page=2");
  });

  it("keeps the path when the last param goes", () => {
    const replaceState = stubWindow("?model=gpt-4");

    replaceSearchParam("model", "");

    expect(replaceState).toHaveBeenCalledWith(null, "", "/org1/chat");
  });
});
