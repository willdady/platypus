import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Suspense } from "react";
import {
  navigationMock,
  authMock,
  toastMock,
  swrMock,
  configuredMutate,
  resetFormHarness,
  setDataFor,
  setError,
  stubAcceptedSave,
  savedBody,
} from "@/lib/form-test-harness";

vi.mock("next/navigation", () => navigationMock);
vi.mock("@/components/auth-provider", () => authMock);
vi.mock("sonner", () => toastMock);
vi.mock("swr", () => swrMock);
vi.mock("@/components/back-button", () => ({ BackButton: () => null }));

import DashboardSettingsPage from "./page";

const COLLECTION = "http://test/organizations/org1/workspaces/ws1/dashboards";
const MEMBER = `${COLLECTION}/d1`;

const renderPage = async () => {
  // `params` is unwrapped with `use`, so the first render suspends.
  await act(async () => {
    render(
      <Suspense>
        <DashboardSettingsPage
          params={Promise.resolve({
            orgId: "org1",
            workspaceId: "ws1",
            dashboardId: "d1",
          })}
        />
      </Suspense>,
    );
  });
};

describe("DashboardSettingsPage", () => {
  beforeEach(() => resetFormHarness());
  afterEach(() => vi.unstubAllGlobals());

  it("lets the Name field be cleared, disabling Save", async () => {
    setDataFor("/dashboards/d1", { id: "d1", name: "Ops", description: null });
    await renderPage();

    const name = screen.getByLabelText("Name");
    expect(name).toHaveValue("Ops");
    fireEvent.change(name, { target: { value: "" } });

    expect(name).toHaveValue("");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("saves name and description and revalidates the dashboards list", async () => {
    setDataFor("/dashboards/d1", { id: "d1", name: "Ops", description: null });
    const fetchMock = stubAcceptedSave({ id: "d1" });
    await renderPage();

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: " Ops v2 " },
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Uptime" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe(MEMBER);
    expect(savedBody(fetchMock)).toEqual({
      name: "Ops v2",
      description: "Uptime",
    });
    await waitFor(() =>
      expect(configuredMutate).toHaveBeenCalledWith(COLLECTION),
    );
    expect(configuredMutate).toHaveBeenCalledWith(MEMBER);
  });

  it("shows the not-found notice when the dashboard is gone", async () => {
    setError({ status: 404 }, "/dashboards/d1");
    await renderPage();

    expect(screen.getByText("Not found")).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  });
});
