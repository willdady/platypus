import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import OrgAgentEditLoading from "./loading";

describe("OrgAgentEditLoading", () => {
  it("draws no page-level Back, leaving the shell header's as the only one", () => {
    render(<OrgAgentEditLoading />);

    expect(
      screen.queryByRole("button", { name: "Back" }),
    ).not.toBeInTheDocument();
  });
});
