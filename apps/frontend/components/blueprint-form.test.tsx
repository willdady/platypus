import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  navigationMock,
  authMock,
  toastMock,
  swrMock,
  resetFormHarness,
  setDataFor,
  setLoading,
} from "@/lib/form-test-harness";

vi.mock("next/navigation", () => navigationMock);
vi.mock("@/components/auth-provider", () => authMock);
vi.mock("sonner", () => toastMock);
vi.mock("swr", () => swrMock);

import { BlueprintForm } from "./blueprint-form";

describe("BlueprintForm shared resource groups", () => {
  beforeEach(() => {
    resetFormHarness();
    setDataFor("/organizations/org1/providers", { results: [] });
  });

  it("doesn't claim a group is empty while its list is still loading", () => {
    setLoading("/organizations/org1/agents");

    render(<BlueprintForm orgId="org1" />);

    expect(
      screen.queryByText("No shared agents in this organization yet."),
    ).toBeNull();
    // A group whose list landed empty still says so.
    expect(
      screen.getByText("No shared skills in this organization yet."),
    ).toBeInTheDocument();
  });

  it("holds the form back until the providers land, so its selects aren't blank", () => {
    setLoading("/organizations/org1/providers");

    render(<BlueprintForm orgId="org1" />);

    expect(screen.getByLabelText("Loading blueprint")).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).toBeNull();
  });
});
