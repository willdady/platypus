import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FormTextField } from "./form-text-field";

describe("FormTextField", () => {
  it("pairs the label with the input via htmlFor/id", () => {
    render(
      <FormTextField label="Name" name="name" value="" onChange={vi.fn()} />,
    );

    expect(screen.getByRole("textbox", { name: "Name" })).toBeInTheDocument();
  });

  it("calls onChange with the new value when typed into", async () => {
    const onChange = vi.fn();
    render(
      <FormTextField label="Name" name="name" value="" onChange={onChange} />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "a" },
    });

    expect(onChange).toHaveBeenCalledWith("a");
  });

  it("renders the error and marks the field invalid", () => {
    render(
      <FormTextField
        label="Name"
        name="name"
        value=""
        onChange={vi.fn()}
        error="Name is required"
      />,
    );

    expect(screen.getByText("Name is required")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("renders no error when none is given", () => {
    render(
      <FormTextField label="Name" name="name" value="" onChange={vi.fn()} />,
    );

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveAttribute(
      "aria-invalid",
      "false",
    );
  });

  it("renders the description", () => {
    render(
      <FormTextField
        label="Name"
        name="name"
        value=""
        onChange={vi.fn()}
        description="Shown under the chat input"
      />,
    );

    expect(screen.getByText("Shown under the chat input")).toBeInTheDocument();
  });

  it("renders trailing content alongside the error instead of after it", () => {
    render(
      <FormTextField
        label="Name"
        name="name"
        value="abc"
        onChange={vi.fn()}
        error="Too long"
        trailing={<p>3/64</p>}
      />,
    );

    expect(screen.getByText("Too long")).toBeInTheDocument();
    expect(screen.getByText("3/64")).toBeInTheDocument();
  });

  it("respects disabled and required", () => {
    render(
      <FormTextField
        label="Name"
        name="name"
        value=""
        onChange={vi.fn()}
        disabled
        required
      />,
    );

    const input = screen.getByRole("textbox", { name: "Name" });
    expect(input).toBeDisabled();
    expect(input).toBeRequired();
  });

  it("respects autoFocus", () => {
    render(
      <FormTextField
        label="Name"
        name="name"
        value=""
        onChange={vi.fn()}
        autoFocus
      />,
    );

    expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus();
  });

  it("passes through the type prop", () => {
    render(
      <FormTextField
        label="Email"
        name="email"
        value=""
        onChange={vi.fn()}
        type="email"
      />,
    );

    expect(screen.getByRole("textbox", { name: "Email" })).toHaveAttribute(
      "type",
      "email",
    );
  });
});
