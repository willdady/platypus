import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const read: { data?: { name: string }; isLoading: boolean } = {
  isLoading: false,
};
vi.mock("@/hooks/use-organization", () => ({
  useOrganization: () => read,
}));

import { OrganizationName } from "./organization-name";

describe("OrganizationName", () => {
  it("shows neither name nor fallback while the Organization loads", () => {
    read.isLoading = true;
    read.data = undefined;
    render(<OrganizationName orgId="org1" />);
    expect(screen.queryByText("this organization")).not.toBeInTheDocument();
  });

  it("shows the Organization's name once loaded", () => {
    read.isLoading = false;
    read.data = { name: "Acme" };
    render(<OrganizationName orgId="org1" />);
    expect(screen.getByText("Acme")).toBeInTheDocument();
  });

  it("falls back to 'this organization' without a name", () => {
    read.isLoading = false;
    read.data = undefined;
    render(<OrganizationName orgId="org1" />);
    expect(screen.getByText("this organization")).toBeInTheDocument();
  });
});
