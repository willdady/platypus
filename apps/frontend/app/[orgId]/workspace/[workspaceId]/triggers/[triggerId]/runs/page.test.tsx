import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Suspense } from "react";
import type { TriggerRun, TriggerRunStats } from "@platypus/schemas";

const runs: TriggerRun[] = [];

vi.mock("swr", () => ({
  default: (key: string | null) => ({
    data: key?.endsWith("/runs")
      ? { results: runs }
      : { id: "trigger-1", name: "Nightly digest" },
    isLoading: false,
  }),
}));
vi.mock("@/app/client-context", () => ({
  useBackendUrl: () => "https://backend.example",
}));
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));
// Reads the browser history through the app router, which no test mounts.
vi.mock("@/components/back-button", () => ({
  BackButton: () => null,
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

const run = (runStats: TriggerRunStats): TriggerRun => ({
  id: "run-1",
  triggerId: "trigger-1",
  status: "success",
  startedAt: new Date("2026-01-01T09:00:00Z"),
  completedAt: new Date("2026-01-01T09:00:10Z"),
  stats: runStats,
  createdAt: new Date("2026-01-01T09:00:00Z"),
});

const renderRuns = async (rows: TriggerRun[]) => {
  runs.splice(0, runs.length, ...rows);
  // `params` is a promise the page unwraps with `use`, so the first render
  // suspends; flush it before asserting.
  await act(async () => {
    render(
      <Suspense>
        <TriggerRunsPage
          params={Promise.resolve({
            orgId: "org-1",
            workspaceId: "ws-1",
            triggerId: "trigger-1",
          })}
        />
      </Suspense>,
    );
  });
  await screen.findByText("Nightly digest");
};

// A run that hit the model's output ceiling still ends as 'success', so
// without the marker the runs view is the same for a complete answer and a
// half-written one.
describe("Trigger runs truncation marker", () => {
  it("marks a run whose stats say it stopped at the output limit", async () => {
    await renderRuns([run(stats({ truncatedByTokenLimit: true }))]);

    expect(screen.getByText(RUN_CUT_SHORT_NOTICE)).toBeInTheDocument();
  });

  it("renders no marker for a run that finished cleanly", async () => {
    await renderRuns([run(stats())]);

    expect(screen.queryByText(RUN_CUT_SHORT_NOTICE)).toBeNull();
  });
});

// Issue #540. The same problem for the other limit: a run whose loop ran out of
// steps also ends as 'success', and the runs view said nothing about it.
describe("Trigger runs step-limit marker", () => {
  it("marks a run whose stats say its loop was stopped short", async () => {
    await renderRuns([run(stats({ stoppedAtStepLimit: true }))]);

    expect(screen.getByText(RUN_STEP_LIMIT_NOTICE)).toBeInTheDocument();
  });

  it("names the step limit, not the output limit", async () => {
    await renderRuns([run(stats({ stoppedAtStepLimit: true }))]);

    expect(screen.queryByText(RUN_CUT_SHORT_NOTICE)).toBeNull();
  });

  it("renders no marker for a run that finished cleanly", async () => {
    await renderRuns([run(stats())]);

    expect(screen.queryByText(RUN_STEP_LIMIT_NOTICE)).toBeNull();
  });

  // The no-progress stop reports itself already: a failed run with its own
  // message. Relabelling it a step-limit stop would tell an Operator to raise a
  // ceiling that was never the problem.
  it("leaves a no-progress failure reported as itself", async () => {
    await renderRuns([
      {
        ...run(stats({ steps: 4 })),
        status: "failed",
        errorMessage:
          "no_progress: tool 'listCards' produced the same result 3 times without making progress",
      },
    ]);

    expect(
      screen.getByText(/no_progress: tool 'listCards'/),
    ).toBeInTheDocument();
    expect(screen.queryByText(RUN_STEP_LIMIT_NOTICE)).toBeNull();
  });
});

// Without this an Operator can only see a scheduled Agent's context filling up
// after it starts failing at the vendor (ADR-0018).
describe("Trigger runs Context occupancy", () => {
  it("shows how full the context got on the run's last step", async () => {
    await renderRuns([run(stats({ contextOccupancy: 42000 }))]);

    expect(screen.getByText(/42K context/)).toBeInTheDocument();
  });

  it("shows nothing where the Provider reported no usage", async () => {
    await renderRuns([run(stats())]);

    expect(screen.queryByText(/context/)).toBeNull();
  });

  it("keeps the token sums as their own figure beside occupancy", async () => {
    // These are cross-step billing sums an Operator has been reading; occupancy
    // is a separate figure and must not be mistaken for either of them.
    await renderRuns([run(stats({ contextOccupancy: 42000 }))]);

    expect(screen.getByText(/100 in \/ 4\.1K out/)).toBeInTheDocument();
  });

  // The same quantity the Chat meter shows, so it is written the same way —
  // `1M` in one place and `1,000,000` in the other reads as two measurements.
  it("abbreviates a figure of a million tokens or more", async () => {
    await renderRuns([
      run(stats({ contextOccupancy: 1_048_576, inputTokens: 2_500_000 })),
    ]);

    expect(screen.getByText(/1M context/)).toBeInTheDocument();
    expect(screen.getByText(/2\.5M in/)).toBeInTheDocument();
  });
});

// Issue #665. Backend logs are keyed by runId, but the id is never rendered —
// the clipboard is the only place an Operator can get it out of the UI.
describe("Trigger runs copy-run-id control", () => {
  const writeText = vi.fn();

  beforeEach(() => {
    writeText.mockReset().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    toastSuccessSpy.mockClear();
    toastErrorSpy.mockClear();
  });

  it("never renders the run id as visible text", async () => {
    await renderRuns([run(stats())]);

    expect(screen.queryByText("run-1")).toBeNull();
  });

  it("exposes an accessible name and a matching tooltip", async () => {
    await renderRuns([run(stats())]);

    const button = screen.getByRole("button", { name: "Copy run id" });
    expect(button).toBeInTheDocument();

    fireEvent.focus(button);
    expect(await screen.findAllByText("Copy run id")).not.toHaveLength(0);
  });

  it("copies the full run id and shows a success toast", async () => {
    await renderRuns([run(stats())]);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy run id" }));
    });

    expect(writeText).toHaveBeenCalledWith("run-1");
    expect(toastSuccessSpy).toHaveBeenCalledWith("Copied to clipboard");
  });

  it("shows an error toast when the clipboard write rejects", async () => {
    writeText.mockReset().mockRejectedValue(new Error("denied"));
    await renderRuns([run(stats())]);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy run id" }));
    });

    expect(toastErrorSpy).toHaveBeenCalledWith("Failed to copy to clipboard");
  });
});
