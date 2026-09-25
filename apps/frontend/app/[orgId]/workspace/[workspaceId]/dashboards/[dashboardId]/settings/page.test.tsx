import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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
  stubRejectedSave,
  savedBody,
  push,
  toastError,
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

  it("shows a refused save inline", async () => {
    setDataFor("/dashboards/d1", { id: "d1", name: "Ops", description: null });
    stubRejectedSave("A dashboard with that name already exists", 409);
    await renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText("A dashboard with that name already exists"),
    ).toBeInTheDocument();
    expect(configuredMutate).not.toHaveBeenCalled();
  });

  it("shows the not-found notice when the dashboard is gone", async () => {
    setError({ status: 404 }, "/dashboards/d1");
    await renderPage();

    expect(screen.getByText("Not found")).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  });

  describe("deleting", () => {
    const confirmDelete = () => {
      fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
      const dialog = screen.getByRole("dialog");
      fireEvent.change(
        within(dialog).getByPlaceholderText(
          "Type 'delete dashboard' to confirm",
        ),
        { target: { value: "delete dashboard" } },
      );
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    };

    it("deletes it and returns to the workspace", async () => {
      setDataFor("/dashboards/d1", {
        id: "d1",
        name: "Ops",
        description: null,
      });
      const fetchMock = stubAcceptedSave();
      await renderPage();

      confirmDelete();

      await waitFor(() =>
        expect(push).toHaveBeenCalledWith("/org1/workspace/ws1"),
      );
      expect(fetchMock).toHaveBeenCalledWith(
        MEMBER,
        expect.objectContaining({ method: "DELETE" }),
      );
    });

    it("reports a refused delete and stays on the page", async () => {
      setDataFor("/dashboards/d1", {
        id: "d1",
        name: "Ops",
        description: null,
      });
      stubRejectedSave("Not allowed", 403);
      await renderPage();

      confirmDelete();

      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith("Not allowed"),
      );
      expect(push).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
    });
  });
});
