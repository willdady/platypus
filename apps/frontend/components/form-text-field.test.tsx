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

  it("passes through autoComplete", () => {
    render(
      <FormTextField
        label="Passphrase"
        name="passphrase"
        value=""
        onChange={vi.fn()}
        autoComplete="off"
      />,
    );

    expect(screen.getByLabelText("Passphrase")).toHaveAttribute(
      "autocomplete",
      "off",
    );
  });
});

describe("FormTextField revealable", () => {
  it("masks the value and offers a show control by default", () => {
    render(
      <FormTextField
        label="API Key"
        name="apiKey"
        value="sk-secret"
        onChange={vi.fn()}
        revealable
      />,
    );

    expect(screen.getByLabelText("API Key")).toHaveAttribute(
      "type",
      "password",
    );
    expect(
      screen.getByRole("button", { name: "Show password" }),
    ).toBeInTheDocument();
  });

  it("toggles the value from masked to revealed", () => {
    render(
      <FormTextField
        label="API Key"
        name="apiKey"
        value="sk-secret"
        onChange={vi.fn()}
        revealable
      />,
    );

    const input = screen.getByLabelText("API Key");
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(input).toHaveAttribute("type", "text");
    expect(input).toHaveValue("sk-secret");
  });

  it("names the reveal control with revealLabel where the default does not fit", () => {
    render(
      <FormTextField
        label="API Key"
        name="apiKey"
        value=""
        onChange={vi.fn()}
        revealable
        revealLabel="API key"
      />,
    );

    expect(
      screen.getByRole("button", { name: "Show API key" }),
    ).toBeInTheDocument();
  });

  it("calls onChange with the new value when typed into", () => {
    const onChange = vi.fn();
    render(
      <FormTextField
        label="API Key"
        name="apiKey"
        value=""
        onChange={onChange}
        revealable
      />,
    );

    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "sk-new" },
    });

    expect(onChange).toHaveBeenCalledWith("sk-new");
  });

  it("links the error to the input for assistive technology", () => {
    render(
      <FormTextField
        label="API Key"
        name="apiKey"
        value=""
        onChange={vi.fn()}
        error="API key is required"
        revealable
      />,
    );

    const input = screen.getByLabelText("API Key");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("API key is required");
  });

  it("links the description and the error, in that order", () => {
    render(
      <FormTextField
        label="API Key"
        name="apiKey"
        value=""
        onChange={vi.fn()}
        description="Kept server-side."
        error="API key is required"
        revealable
      />,
    );

    expect(screen.getByLabelText("API Key")).toHaveAccessibleDescription(
      "Kept server-side. API key is required",
    );
  });

  it("respects disabled, required and autoComplete", () => {
    render(
      <FormTextField
        label="API Key"
        name="apiKey"
        value=""
        onChange={vi.fn()}
        revealable
        disabled
        required
        autoComplete="new-password"
      />,
    );

    const input = screen.getByLabelText("API Key");
    expect(input).toBeDisabled();
    expect(input).toBeRequired();
    expect(input).toHaveAttribute("autocomplete", "new-password");
    expect(
      screen.getByRole("button", { name: "Show password" }),
    ).toBeDisabled();
  });

  it("leaves a plain field unmasked and without a reveal control", () => {
    render(
      <FormTextField label="Name" name="name" value="" onChange={vi.fn()} />,
    );

    expect(screen.getByRole("textbox", { name: "Name" })).toHaveAttribute(
      "type",
      "text",
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
