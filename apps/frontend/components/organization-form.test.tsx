import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  navigationMock,
  authMock,
  toastMock,
  swrMock,
  push,
  toastSuccess,
  resetFormHarness,
  setData,
  setError,
  setLoading,
  stubAcceptedSave,
  savedBody,
} from "@/lib/form-test-harness";

vi.mock("next/navigation", () => navigationMock);
vi.mock("@/components/auth-provider", () => authMock);
vi.mock("sonner", () => toastMock);
vi.mock("swr", () => swrMock);

import { OrganizationForm } from "./organization-form";

describe("OrganizationForm record read", () => {
  beforeEach(() => resetFormHarness());

  it("shows the skeleton, not a blank editable form, while loading", () => {
    setLoading();
    render(<OrganizationForm orgId="org1" />);

    expect(screen.getByLabelText("Loading organization")).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  });

  it("shows the failure notice on a cold server error", () => {
    setError({ status: 500 });
    render(<OrganizationForm orgId="org1" />);

    expect(screen.getByText("Couldn't load")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Back to organization" }),
    ).toHaveAttribute("href", "/org1");
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  });

  it("seeds the fields from the loaded organization", () => {
    setData({ id: "org1", name: "Acme", identityContext: "We make anvils" });
    render(<OrganizationForm orgId="org1" />);

    expect(screen.getByLabelText("Name")).toHaveValue("Acme");
    expect(screen.getByDisplayValue("We make anvils")).toBeInTheDocument();
  });

  it("renders the create form without waiting on a read", () => {
    setLoading();
    render(<OrganizationForm />);

    expect(screen.getByLabelText("Name")).toHaveValue("");
  });
});

describe("OrganizationForm create", () => {
  beforeEach(() => resetFormHarness());
  afterEach(() => vi.unstubAllGlobals());

  it("creates the organization and opens it", async () => {
    const fetchMock = stubAcceptedSave({ id: "org9", name: "Acme" });
    render(<OrganizationForm />);

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Acme" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/org9"));
    expect(toastSuccess).toHaveBeenCalledWith("Organization created");
    expect(fetchMock.mock.calls[0][0]).toBe("http://test/organizations");
    expect(savedBody(fetchMock)).toEqual({ name: "Acme" });
  });
});
