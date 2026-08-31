import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FormFooterButtons } from "./form-footer-buttons";

describe("FormFooterButtons", () => {
  it("hides the delete button by default", () => {
    render(<FormFooterButtons submitText="Save" />);

    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Delete/ }),
    ).not.toBeInTheDocument();
  });

  it("shows the delete button when deleteVisible is true", () => {
    render(<FormFooterButtons submitText="Update" deleteVisible />);

    expect(screen.getByRole("button", { name: /Delete/ })).toBeInTheDocument();
  });

  it("fires onSubmit on click when type is 'button'", () => {
    const onSubmit = vi.fn();
    render(<FormFooterButtons submitText="Save" onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("does not wire onClick when type is 'submit', leaving the form's onSubmit in control", () => {
    const onSubmit = vi.fn();
    render(
      <FormFooterButtons
        submitText="Create"
        onSubmit={onSubmit}
        type="submit"
      />,
    );

    const button = screen.getByRole("button", { name: "Create" });
    expect(button).toHaveAttribute("type", "submit");

    fireEvent.click(button);

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("fires onDelete when the delete button is clicked", () => {
    const onDelete = vi.fn();
    render(
      <FormFooterButtons submitText="Save" deleteVisible onDelete={onDelete} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));

    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("respects submitDisabled and deleteDisabled", () => {
    render(
      <FormFooterButtons
        submitText="Save"
        submitDisabled
        deleteVisible
        deleteDisabled
      />,
    );

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Delete/ })).toBeDisabled();
  });
});
