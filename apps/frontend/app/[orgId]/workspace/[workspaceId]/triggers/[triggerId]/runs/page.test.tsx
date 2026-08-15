import { describe, it, expect, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
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

import TriggerRunsPage from "./page";
import { RUN_CUT_SHORT_NOTICE } from "@/components/run-cut-short-notice";

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
