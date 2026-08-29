import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Suspense } from "react";
import type { TriggerRunStats, TriggerRunWithTrigger } from "@platypus/schemas";

/**
 * The page reads its runs through `useSWRInfinite`, one page per key. The mock
 * below stands in for the network: it records the keys the page asks for, and
 * answers with whatever `pages` the test has staged, so assertions can be made
 * about both what was rendered and what was requested.
 */
const state = {
  pages: [] as { results: TriggerRunWithTrigger[] }[],
  keys: [] as (string | null)[],
  config: undefined as Record<string, unknown> | undefined,
  size: 1,
  setSize: vi.fn(),
  isLoading: false,
  error: undefined as Error | undefined,
  triggers: [] as { id: string; name: string }[],
};

vi.mock("swr/infinite", () => ({
  default: (
    getKey: (
      index: number,
      previous: { results: TriggerRunWithTrigger[] } | null,
    ) => string | null,
    _fetcher: unknown,
    config: Record<string, unknown>,
  ) => {
    state.config = config;
    state.keys = [];
    for (let i = 0; i < Math.max(state.size, 1); i++) {
      state.keys.push(getKey(i, state.pages[i - 1] ?? null));
    }
    return {
      data: state.pages,
      size: state.size,
      setSize: state.setSize,
      isLoading: state.isLoading,
      error: state.error,
      isValidating: false,
    };
  },
}));

const TRIGGERS = [
  { id: "trigger-1", name: "Nightly digest" },
  { id: "trigger-2", name: "Card watcher" },
];

// The triggers behind the filter dropdown, fetched separately from the runs.
vi.mock("swr", () => ({
  default: () => ({ data: { results: state.triggers }, isLoading: false }),
}));

vi.mock("@/app/client-context", () => ({
  useBackendUrl: () => "https://backend.example",
}));
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));
vi.mock("@/components/back-button", () => ({
  BackButton: () => null,
}));

const { replaceSpy, searchParams } = vi.hoisted(() => ({
  replaceSpy: vi.fn(),
  searchParams: { current: new URLSearchParams() },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceSpy, push: vi.fn() }),
  usePathname: () => "/org-1/workspace/ws-1/trigger-runs",
  useSearchParams: () => searchParams.current,
}));

const { toastSuccessSpy, toastErrorSpy } = vi.hoisted(() => ({
  toastSuccessSpy: vi.fn(),
  toastErrorSpy: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { success: toastSuccessSpy, error: toastErrorSpy },
}));

// Radix Tooltip content measures itself on focus, which jsdom has no
// ResizeObserver for.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

import TriggerRunsPage from "./page";
import {
  RUN_CUT_SHORT_NOTICE,
  RUN_STEP_LIMIT_NOTICE,
} from "@/components/run-cut-short-notice";

const stats = (overrides?: Partial<TriggerRunStats>): TriggerRunStats => ({
  steps: 1,
  toolCalls: [],
  inputTokens: 100,
  outputTokens: 4096,
  ...overrides,
});

const run = (
  overrides: Partial<TriggerRunWithTrigger> = {},
): TriggerRunWithTrigger => ({
  id: "run-1",
  triggerId: "trigger-1",
  triggerName: "Nightly digest",
  status: "success",
  startedAt: new Date("2026-01-01T09:00:00Z"),
  completedAt: new Date("2026-01-01T09:00:10Z"),
  stats: stats(),
  createdAt: new Date("2026-01-01T09:00:00Z"),
  ...overrides,
});

const renderPage = async () => {
  // `params` is a promise the page unwraps with `use`, so the first render
  // suspends; flush it before asserting.
  await act(async () => {
    render(
      <Suspense>
        <TriggerRunsPage
          params={Promise.resolve({ orgId: "org-1", workspaceId: "ws-1" })}
        />
      </Suspense>,
    );
  });
  await screen.findByRole("heading", { name: "Trigger runs" });
};

const renderRuns = async (rows: TriggerRunWithTrigger[]) => {
  state.pages = [{ results: rows }];
  await renderPage();
};

/** Picks an option on the Radix Select currently reading `from`. */
const selectOption = async (from: string, option: string) => {
  const combobox = screen
    .getAllByRole("combobox")
    .find((el) => el.textContent === from)!;
  const scrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = vi.fn();
  try {
    fireEvent.keyDown(combobox, { key: "ArrowDown" });
    const item = await screen.findByRole("option", { name: option });
    fireEvent.keyDown(item, { key: "Enter" });
  } finally {
    Element.prototype.scrollIntoView = scrollIntoView;
  }
};

beforeEach(() => {
  vi.clearAllMocks();
  searchParams.current = new URLSearchParams();
  state.pages = [];
  state.size = 1;
  state.isLoading = false;
  state.error = undefined;
  state.triggers = TRIGGERS;
});

// The point of the page: one list answering "what fired in this workspace?",
// which per-trigger pages could only answer one trigger at a time.
describe("Trigger runs list", () => {
  it("lists runs from every trigger, each naming and linking its own", async () => {
    await renderRuns([
      run(),
      run({
        id: "run-2",
        triggerId: "trigger-2",
        triggerName: "Card watcher",
      }),
    ]);

    const nightly = screen.getByRole("link", { name: "Nightly digest" });
    expect(nightly).toHaveAttribute(
      "href",
      "/org-1/workspace/ws-1/triggers/trigger-1",
    );
    expect(screen.getByRole("link", { name: "Card watcher" })).toHaveAttribute(
      "href",
      "/org-1/workspace/ws-1/triggers/trigger-2",
    );
  });

  it("keeps the heading static whatever the filters say", async () => {
    searchParams.current = new URLSearchParams({ triggerId: "trigger-1" });
    await renderRuns([run()]);

    expect(
      screen.getByRole("heading", { name: "Trigger runs" }),
    ).toBeInTheDocument();
  });

  it("asks the workspace-wide endpoint, unfiltered, for the first page", async () => {
    await renderRuns([run()]);

    expect(state.keys[0]).toContain(
      "https://backend.example/organizations/org-1/workspaces/ws-1/trigger-runs?",
    );
    expect(state.keys[0]).toContain("limit=50");
    expect(state.keys[0]).toContain("offset=0");
    expect(state.keys[0]).not.toContain("triggerId=");
    expect(state.keys[0]).not.toContain("status=");
  });
});

// Both filters live in the URL so a filtered view survives a refresh and can be
// pasted to someone else.
describe("Trigger runs filters", () => {
  it("carries the URL's trigger and status into the request", async () => {
    searchParams.current = new URLSearchParams({
      triggerId: "trigger-2",
      status: "failed",
    });
    await renderRuns([run()]);

    expect(state.keys[0]).toContain("triggerId=trigger-2");
    expect(state.keys[0]).toContain("status=failed");
  });

  it("shows the URL's trigger as the selected filter", async () => {
    searchParams.current = new URLSearchParams({ triggerId: "trigger-2" });
    await renderRuns([run()]);

    expect(
      screen.getAllByRole("combobox").map((el) => el.textContent),
    ).toContain("Card watcher");
  });

  // Someone arriving by redirect must see the filter set to theirs — the
  // dropdown's own list of triggers is a separate fetch and may not be back.
  it("names the filtered trigger before the dropdown's triggers arrive", async () => {
    state.triggers = [];
    searchParams.current = new URLSearchParams({ triggerId: "trigger-1" });
    await renderRuns([run()]);

    expect(
      screen.getAllByRole("combobox").map((el) => el.textContent),
    ).toContain("Nightly digest");
  });

  it("writes the chosen trigger to the URL", async () => {
    await renderRuns([run()]);

    await act(async () => {
      await selectOption("All triggers", "Card watcher");
    });

    expect(replaceSpy).toHaveBeenCalledWith(
      "/org-1/workspace/ws-1/trigger-runs?triggerId=trigger-2",
      { scroll: false },
    );
  });

  it("writes the chosen status to the URL", async () => {
    await renderRuns([run()]);

    await act(async () => {
      await selectOption("All statuses", "Failed");
    });

    expect(replaceSpy).toHaveBeenCalledWith(
      "/org-1/workspace/ws-1/trigger-runs?status=failed",
      { scroll: false },
    );
  });

  it("drops the parameter again when the filter goes back to all", async () => {
    searchParams.current = new URLSearchParams({ status: "failed" });
    await renderRuns([run()]);

    await act(async () => {
      await selectOption("Failed", "All statuses");
    });

    expect(replaceSpy).toHaveBeenCalledWith(
      "/org-1/workspace/ws-1/trigger-runs",
      { scroll: false },
    );
  });
});

// Filtering to 'failed' on a healthy workspace must not claim no trigger has
// ever run.
describe("Trigger runs empty states", () => {
  it("says the workspace has no runs when nothing is filtered", async () => {
    await renderRuns([]);

    expect(screen.getByText(/No runs yet/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });

  it("says nothing matches, and offers a way out, when a filter is active", async () => {
    searchParams.current = new URLSearchParams({ status: "failed" });
    await renderRuns([]);

    expect(screen.getByText(/No runs match/)).toBeInTheDocument();
    expect(screen.queryByText(/No runs yet/)).toBeNull();
  });

  // A rejected filter — a hand-edited or stale URL the endpoint 400s — must not
  // read as "nothing matched", which is a claim about the data the page never
  // received.
  it("reports a failed read rather than showing an empty list", async () => {
    searchParams.current = new URLSearchParams({ status: "bogus" });
    state.error = new Error("Bad Request");
    await renderRuns([]);

    expect(screen.getByText(/Couldn't load runs/)).toBeInTheDocument();
    expect(screen.queryByText(/No runs match/)).toBeNull();
    expect(screen.queryByText(/No runs yet/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Clear filters" }),
    ).toBeInTheDocument();
  });

  it("keeps showing the runs it has when a later refresh fails", async () => {
    state.error = new Error("Bad Request");
    await renderRuns([run()]);

    expect(
      screen.getByRole("link", { name: "Nightly digest" }),
    ).toBeInTheDocument();
  });

  it("clears every filter from the URL", async () => {
    searchParams.current = new URLSearchParams({
      status: "failed",
      triggerId: "trigger-1",
    });
    await renderRuns([]);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    });

    expect(replaceSpy).toHaveBeenCalledWith(
      "/org-1/workspace/ws-1/trigger-runs",
      { scroll: false },
    );
  });
});

describe("Trigger runs paging", () => {
  const fullPage = Array.from({ length: 50 }, (_, i) =>
    run({ id: `run-${i}` }),
  );

  it("offers Load more while a full page came back", async () => {
    await renderRuns(fullPage);

    expect(
      screen.getByRole("button", { name: "Load more" }),
    ).toBeInTheDocument();
  });

  it("hides Load more once every run is shown", async () => {
    await renderRuns(fullPage.slice(0, 12));

    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("asks for the next page and keeps the loaded ones", async () => {
    await renderRuns(fullPage);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    });

    expect(state.setSize).toHaveBeenCalled();
    const nextSize = state.setSize.mock.calls[0][0] as
      number | ((s: number) => number);
    expect(typeof nextSize === "function" ? nextSize(1) : nextSize).toBe(2);
  });

  // A run can then be watched moving from 'running' to a terminal status —
  // including on pages already loaded — without burning requests on a tab
  // nobody is looking at.
  it("polls every ten seconds, refreshing every loaded page, but not while hidden", async () => {
    await renderRuns([run()]);

    expect(state.config).toMatchObject({
      refreshInterval: 10000,
      refreshWhenHidden: false,
      revalidateAll: true,
    });
  });

  it("requests the second page at the next offset and appends it", async () => {
    state.size = 2;
    state.pages = [
      { results: fullPage },
      { results: [run({ id: "run-99", triggerName: "Card watcher" })] },
    ];
    await renderPage();

    expect(state.keys[1]).toContain("offset=50");
    expect(screen.getByRole("link", { name: "Card watcher" })).toBeVisible();
  });
});

// Ported from the retired per-trigger page: a run that hit the model's output
// ceiling still ends as 'success', so without the marker the runs view is the
// same for a complete answer and a half-written one.
describe("Trigger runs truncation marker", () => {
  it("marks a run whose stats say it stopped at the output limit", async () => {
    await renderRuns([run({ stats: stats({ truncatedByTokenLimit: true }) })]);

    expect(screen.getByText(RUN_CUT_SHORT_NOTICE)).toBeInTheDocument();
  });

  it("marks a run whose stats say its loop was stopped short", async () => {
    await renderRuns([run({ stats: stats({ stoppedAtStepLimit: true }) })]);

    expect(screen.getByText(RUN_STEP_LIMIT_NOTICE)).toBeInTheDocument();
  });

  it("renders no marker for a run that finished cleanly", async () => {
    await renderRuns([run()]);

    expect(screen.queryByText(RUN_CUT_SHORT_NOTICE)).toBeNull();
    expect(screen.queryByText(RUN_STEP_LIMIT_NOTICE)).toBeNull();
  });

  // The no-progress stop reports itself already: a failed run with its own
  // message.
  it("leaves a no-progress failure reported as itself", async () => {
    await renderRuns([
      run({
        status: "failed",
        stats: stats({ steps: 4 }),
        errorMessage:
          "no_progress: tool 'listCards' produced the same result 3 times without making progress",
      }),
    ]);

    expect(
      screen.getByText(/no_progress: tool 'listCards'/),
    ).toBeInTheDocument();
    expect(screen.queryByText(RUN_STEP_LIMIT_NOTICE)).toBeNull();
  });
});

describe("Trigger runs stats", () => {
  it("shows how full the context got on the run's last step", async () => {
    await renderRuns([run({ stats: stats({ contextOccupancy: 42000 }) })]);

    expect(screen.getByText(/42K context/)).toBeInTheDocument();
  });

  it("shows no occupancy where the Provider reported no usage", async () => {
    await renderRuns([run()]);

    expect(screen.queryByText(/context/)).toBeNull();
  });

  it("keeps the token sums as their own figure beside occupancy", async () => {
    await renderRuns([run({ stats: stats({ contextOccupancy: 42000 }) })]);

    expect(screen.getByText(/100 in \/ 4\.1K out/)).toBeInTheDocument();
  });

  // Issue #734. The cached-input breakdown reads through a tooltip and must
  // not change what the visible `in` figure means — the input already includes
  // cached tokens.
  describe("cached-input breakdown", () => {
    it("shows the read and write counts in a tooltip on the token line", async () => {
      await renderRuns([
        run({
          stats: stats({ cacheReadTokens: 2_700, cacheWriteTokens: 150 }),
        }),
      ]);

      expect(screen.getByText(/100 in \/ 4\.1K out/)).toBeInTheDocument();
      fireEvent.focus(screen.getByText(/100 in \/ 4\.1K out/));

      expect(
        await screen.findByText("of which 2.7K read from cache"),
      ).toBeInTheDocument();
      expect(
        screen.getByText("of which 150 written to cache"),
      ).toBeInTheDocument();
    });

    it("keeps the token figures unchanged beside the breakdown", async () => {
      await renderRuns([
        run({
          stats: stats({ cacheReadTokens: 2_700, cacheWriteTokens: 150 }),
        }),
      ]);

      expect(screen.getByText(/100 in \/ 4\.1K out/)).toBeInTheDocument();
    });

    it("renders no cache tooltip where the Provider reported no cache detail", async () => {
      await renderRuns([run()]);

      expect(screen.queryByText(/read from cache/)).toBeNull();
      expect(screen.queryByText(/written to cache/)).toBeNull();
    });
  });

  it("shows the run's status, timing and event type", async () => {
    await renderRuns([run({ status: "failed", eventType: "card.created" })]);

    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("Event: card.created")).toBeInTheDocument();
    expect(screen.getByText("Duration: 10.0s")).toBeInTheDocument();
  });
});

// Issue #665, carried forward. Backend logs are keyed by runId, but the id is
// never rendered — the clipboard is the only place an Operator can get it out
// of the UI.
describe("Trigger runs copy-run-id control", () => {
  const writeText = vi.fn();

  beforeEach(() => {
    writeText.mockReset().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
  });

  it("never renders the run id as visible text", async () => {
    await renderRuns([run()]);

    expect(screen.queryByText("run-1")).toBeNull();
  });

  it("exposes an accessible name and a matching tooltip", async () => {
    await renderRuns([run()]);

    const button = screen.getByRole("button", { name: "Copy run id" });
    expect(button).toBeInTheDocument();

    fireEvent.focus(button);
    expect(await screen.findAllByText("Copy run id")).not.toHaveLength(0);
  });

  it("copies the full run id and shows a success toast", async () => {
    await renderRuns([run()]);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy run id" }));
    });

    expect(writeText).toHaveBeenCalledWith("run-1");
    expect(toastSuccessSpy).toHaveBeenCalledWith("Copied to clipboard");
  });

  it("shows an error toast when the clipboard write rejects", async () => {
    writeText.mockReset().mockRejectedValue(new Error("denied"));
    await renderRuns([run()]);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy run id" }));
    });

    expect(toastErrorSpy).toHaveBeenCalledWith("Failed to copy to clipboard");
  });
});
