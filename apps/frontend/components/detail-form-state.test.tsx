import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DetailFormState } from "./detail-form-state";

const baseProps = {
  isLoading: false,
  subject: "provider",
  backHref: "/org1/settings/providers",
  backLabel: "Back to providers",
  children: <p>the form</p>,
};

describe("DetailFormState", () => {
  it("holds the form back while the record is loading", () => {
    render(<DetailFormState {...baseProps} isLoading />);

    expect(screen.queryByText("the form")).toBeNull();
  });

  it("renders the form once the record is loaded", () => {
    render(<DetailFormState {...baseProps} data={{ id: "p1" }} />);

    expect(screen.getByText("the form")).toBeInTheDocument();
  });

  it("renders the form in create mode, where there is no record to read", () => {
    render(<DetailFormState {...baseProps} />);

    expect(screen.getByText("the form")).toBeInTheDocument();
  });

  it("explains a deleted record and offers the way back", () => {
    render(<DetailFormState {...baseProps} error={{ status: 404 }} />);

    expect(screen.getByText("Not found")).toBeInTheDocument();
    expect(screen.getByText(/no longer exists/)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Back to providers" }),
    ).toHaveAttribute("href", "/org1/settings/providers");
    expect(screen.queryByText("the form")).toBeNull();
  });

  it("explains a forbidden record", () => {
    render(<DetailFormState {...baseProps} error={{ status: 403 }} />);

    expect(screen.getByText("You don't have access")).toBeInTheDocument();
    expect(screen.getByText(/do not have permission/)).toBeInTheDocument();
  });

  it("explains a read that failed for any other reason", () => {
    render(<DetailFormState {...baseProps} error={new Error("boom")} />);

    expect(screen.getByText("Couldn't load")).toBeInTheDocument();
    expect(screen.getByText(/Try again/)).toBeInTheDocument();
  });

  it("keeps the form when a revalidation fails over data already in hand", () => {
    render(
      <DetailFormState
        {...baseProps}
        data={{ id: "p1" }}
        error={{ status: 404 }}
      />,
    );

    expect(screen.getByText("the form")).toBeInTheDocument();
  });
});

describe("DetailFormState loading placeholder", () => {
  it("names the placeholder after the subject by default", () => {
    render(<DetailFormState {...baseProps} isLoading />);

    expect(screen.getByLabelText("Loading provider")).toHaveAttribute(
      "role",
      "status",
    );
  });

  it("shows the form's own skeleton under the label it's given", () => {
    render(
      <DetailFormState
        {...baseProps}
        isLoading
        loadingLabel="Loading form"
        skeleton={<p>the skeleton</p>}
      />,
    );

    expect(screen.getByLabelText("Loading form")).toBeInTheDocument();
    expect(screen.getByText("the skeleton")).toBeInTheDocument();
    expect(screen.queryByText("the form")).toBeNull();
  });
});
