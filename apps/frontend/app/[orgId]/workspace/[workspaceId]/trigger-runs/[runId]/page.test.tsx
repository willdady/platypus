import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { Suspense } from "react";
import type { RunEvent, TriggerRunDetail } from "@platypus/schemas";

/**
 * The page reads one run through `useSWR` with its own incremental fetcher.
 * The mock below stands in for SWR: it calls the page's fetcher against a
 * staged sequence of responses, so the test sees both what the page asked
 * for (the `sinceSeq` it computed) and what it rendered after folding the
 * answers together.
 */
const state = {
  responses: [] as { run: TriggerRunDetail; events: RunEvent[] }[],
  urls: [] as string[],
  config: undefined as Record<string, unknown> | undefined,
  data: undefined as unknown,
  error: undefined as Error | undefined,
  isLoading: false,
  /** The page's own fetcher and key, captured so a test can run a poll. */
  key: null as string | null,
  fetcher: undefined as ((url: string) => Promise<unknown>) | undefined,
};

vi.mock("swr", () => ({
  useSWRConfig: () => ({ cache: new Map() }),
  default: (
    key: string | null,
    fetcher: (url: string) => Promise<unknown>,
    config: Record<string, unknown>,
  ) => {
    state.config = config;
    state.key = key;
    state.fetcher = fetcher;
    return { data: state.data, error: state.error, isLoading: state.isLoading };
  },
}));

let rerender: (() => void) | undefined;

/** One poll, as SWR would run it: the page's fetcher against its key. */
const poll = async () => {
  await waitFor(() => expect(state.fetcher).toBeDefined());
  state.data = await state.fetcher!(state.key!);
  rerender?.();
};

vi.mock("@/lib/utils", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/utils")>("@/lib/utils");
  return {
    ...actual,
    fetcher: (url: string) => {
      state.urls.push(url);
      return Promise.resolve(state.responses.shift());
    },
  };
});

vi.mock("@/components/auth-provider", () => ({
  useBackendUrl: () => "https://backend.example",
  useAuth: () => ({ user: { id: "user-1" } }),
}));
vi.mock("@/components/back-button", () => ({
  BackButton: () => null,
}));

import TriggerRunDetailPage, {
  RUN_DETAIL_ERROR_NOTICE,
  RUN_DETAIL_POLL_MS,
} from "./page";
import { RUN_TIMELINE_EMPTY_NOTICE } from "@/components/run-timeline";

const T0 = 1_767_258_000_000;

const run = (over: Partial<TriggerRunDetail> = {}): TriggerRunDetail => ({
  id: "run-1",
  triggerId: "trigger-1",
  triggerName: "Nightly digest",
  status: "success",
  eventType: null,
  eventData: null,
  startedAt: new Date(T0),
  completedAt: new Date(T0 + 5_000),
  errorMessage: null,
  stats: null,
  createdAt: new Date(T0),
  finalText: "Three cards moved to Done.",
  eventsTruncated: false,
  ...over,
});

const event = (over: Partial<RunEvent> & { id: string }): RunEvent => ({
  runId: "run-1",
  parentEventId: null,
  seq: 0,
  type: "tool-call",
  toolName: "search",
  startedAt: T0,
  durationMs: 100,
  status: "completed",
  error: null,
  childrenTruncated: false,
  ...over,
});

const params = Promise.resolve({
  orgId: "org-1",
  workspaceId: "ws-1",
  runId: "run-1",
});

const renderPage = async () => {
  // `params` is a promise the page unwraps with `use`, so the first render
  // suspends; flush it before asserting.
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <Suspense fallback={null}>
        <TriggerRunDetailPage params={params} />
      </Suspense>,
    );
  });
  await screen.findByRole("heading", { name: "Trigger run" });
  rerender = () =>
    act(() => {
      view.rerender(
        <Suspense fallback={null}>
          <TriggerRunDetailPage params={params} />
        </Suspense>,
      );
    });
};

describe("TriggerRunDetailPage", () => {
  beforeEach(() => {
    state.responses = [];
    state.urls = [];
    state.config = undefined;
    state.data = undefined;
    state.error = undefined;
    state.isLoading = false;
    state.key = null;
    state.fetcher = undefined;
    rerender = undefined;
  });

  it("renders the run, its timeline and its final text", async () => {
    state.responses = [
      {
        run: run(),
        events: [
          event({ id: "a", toolName: "search" }),
          event({ id: "b", seq: 1, type: "text", startedAt: T0 + 200 }),
        ],
      },
    ];

    await renderPage();
    await poll();

    expect(screen.getByText("Nightly digest")).toBeInTheDocument();
    expect(screen.getByText("search")).toBeInTheDocument();
    expect(screen.getByText("Generating response…")).toBeInTheDocument();
    expect(screen.getByText("Three cards moved to Done.")).toBeInTheDocument();
    // The first read asks for the whole timeline.
    expect(state.urls[0]).toBe(
      "https://backend.example/organizations/org-1/workspaces/ws-1/trigger-runs/run-1",
    );
    // The row heading the page does not link to the page it is on.
    expect(screen.queryByLabelText("View run")).not.toBeInTheDocument();
  });

  it("polls incrementally from below its oldest running event, and folds the patch in", async () => {
    state.responses = [
      {
        run: run({ status: "running", completedAt: null }),
        events: [
          event({ id: "a", toolName: "first" }),
          event({
            id: "b",
            seq: 1,
            toolName: "slow",
            startedAt: T0 + 50,
            durationMs: null,
            status: "running",
          }),
        ],
      },
      {
        run: run(),
        events: [
          event({
            id: "b",
            seq: 1,
            toolName: "slow",
            startedAt: T0 + 50,
            durationMs: 900,
            status: "completed",
          }),
          event({ id: "c", seq: 2, type: "text", startedAt: T0 + 1_000 }),
        ],
      },
    ];

    await renderPage();
    await poll();
    await poll();

    expect(screen.getByText("Generating response…")).toBeInTheDocument();
    // Second read: from just below `b` (seq 1), the oldest event still open —
    // not from `b` itself, or its patch would never arrive.
    expect(state.urls[1]).toMatch(/sinceSeq=0$/);
    // `b` is shown once, in its patched state; `first` was kept from the
    // first read.
    expect(screen.getAllByText("slow")).toHaveLength(1);
    expect(screen.getByText("900ms")).toBeInTheDocument();
    expect(screen.getByText("first")).toBeInTheDocument();
  });

  it("refreshes on the flush interval only while the run is running", async () => {
    state.data = { run: run({ status: "running" }), events: [] };
    await renderPage();
    const refresh = state.config?.refreshInterval as (
      latest: unknown,
    ) => number;

    expect(refresh({ run: run({ status: "running" }) })).toBe(
      RUN_DETAIL_POLL_MS,
    );
    expect(refresh({ run: run({ status: "success" }) })).toBe(0);
    expect(refresh({ run: run({ status: "cancelled" }) })).toBe(0);
  });

  it("renders a run with no events and no final text — one that predates timelines", async () => {
    state.data = { run: run({ finalText: null }), events: [] };

    await renderPage();

    expect(screen.getByText("Nightly digest")).toBeInTheDocument();
    expect(screen.getByText(RUN_TIMELINE_EMPTY_NOTICE)).toBeInTheDocument();
    expect(screen.queryByText("Response")).not.toBeInTheDocument();
  });

  it("shows the placeholder, never a blank page, before the run has loaded", async () => {
    await renderPage();

    expect(screen.getByLabelText("Loading trigger run")).toBeInTheDocument();
  });

  it("says so when the run cannot be read", async () => {
    state.error = new Error("404");

    await renderPage();

    expect(screen.getByText(RUN_DETAIL_ERROR_NOTICE)).toBeInTheDocument();
  });
});
