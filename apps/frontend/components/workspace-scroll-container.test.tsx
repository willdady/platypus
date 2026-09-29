import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import useSWR, { SWRConfig } from "swr";
import { WorkspaceScrollContainer } from "./workspace-scroll-container";

let pathname = "/workspaces/test";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

function CachedPage({ fetcher }: { fetcher: () => Promise<string> }) {
  const { data } = useSWR("/page", fetcher, {
    revalidateOnMount: false,
    revalidateOnFocus: false,
  });
  return <div>{data ?? "Loading page"}</div>;
}

const touchAt = (clientY: number) => ({ clientX: 0, clientY });

// Use the real pull-to-refresh component, including its settle period.
async function pullDown(container: HTMLElement) {
  fireEvent.touchStart(container, { touches: [touchAt(0)] });
  fireEvent.touchMove(container, { touches: [touchAt(10)] });
  await new Promise((resolve) => setTimeout(resolve, 120));
  fireEvent.touchMove(container, { touches: [touchAt(10)] });
  fireEvent.touchMove(container, { touches: [touchAt(200)] });
  fireEvent.touchEnd(container);
}

describe("WorkspaceScrollContainer refresh", () => {
  afterEach(() => {
    pathname = "/workspaces/test";
  });

  it("keeps cached content visible until the refresh finishes", async () => {
    let finishFetch!: (value: string) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishFetch = resolve;
        }),
    );
    const cache = new Map();
    cache.set("/page", { data: "Current content" });

    const { container } = render(
      <SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>
        <WorkspaceScrollContainer>
          <CachedPage fetcher={fetcher} />
        </WorkspaceScrollContainer>
      </SWRConfig>,
    );
    expect(screen.getByText("Current content")).toBeInTheDocument();

    await act(async () => {
      await pullDown(container.firstElementChild as HTMLElement);
    });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(cache.get("/page")?.data).toBe("Current content");
    expect(screen.getByText("Current content")).toBeInTheDocument();
    expect(screen.queryByText("Loading page")).not.toBeInTheDocument();

    await act(async () => finishFetch("Updated content"));
    expect(await screen.findByText("Updated content")).toBeInTheDocument();
  });

  it("does not attach pull-to-refresh on chat routes", () => {
    pathname = "/workspaces/test/chat/123";
    const { container } = render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <WorkspaceScrollContainer>Chat</WorkspaceScrollContainer>
      </SWRConfig>,
    );
    expect(container.firstElementChild).not.toHaveClass("relative");
    expect(screen.getByText("Chat")).toBeInTheDocument();
  });
});
