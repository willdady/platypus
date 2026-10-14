import { describe, it, expect, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { Suspense } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}));
vi.mock("@/components/trigger-form", () => ({
  TriggerForm: () => <div>trigger form</div>,
}));

import EditTriggerPage from "./page";
import CreateTriggerPage from "../create/page";

const params = Promise.resolve({
  orgId: "org-1",
  workspaceId: "ws-1",
  triggerId: "trigger-1",
});

describe("Edit Trigger page", () => {
  it("offers View runs beside its title, filtered to this Trigger", async () => {
    await act(async () => {
      render(
        <Suspense>
          <EditTriggerPage params={params} />
        </Suspense>,
      );
    });

    await screen.findByRole("heading", { name: "Edit Trigger" });
    expect(screen.getByRole("link", { name: "View runs" })).toHaveAttribute(
      "href",
      "/org-1/workspace/ws-1/trigger-runs?triggerId=trigger-1",
    );
  });

  it("offers no View runs while the Trigger is being created", async () => {
    await act(async () => {
      render(
        <Suspense>
          <CreateTriggerPage params={params} />
        </Suspense>,
      );
    });

    await screen.findByRole("heading");
    expect(
      screen.queryByRole("link", { name: "View runs" }),
    ).not.toBeInTheDocument();
  });
});
