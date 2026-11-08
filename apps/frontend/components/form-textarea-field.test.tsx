import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FormTextareaField } from "./form-textarea-field";

describe("FormTextareaField", () => {
  it("pairs the label with the textarea via htmlFor/id", () => {
    render(
      <FormTextareaField
        label="Host key"
        name="hostKey"
        value=""
        onChange={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("textbox", { name: "Host key" }),
    ).toBeInTheDocument();
  });

  it("calls onChange with the new value when typed into", () => {
    const onChange = vi.fn();
    render(
      <FormTextareaField
        label="Host key"
        name="hostKey"
        value=""
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Host key" }), {
      target: { value: "ssh-ed25519 AAAA" },
    });

    expect(onChange).toHaveBeenCalledWith("ssh-ed25519 AAAA");
  });

  it("passes through autoComplete and spellCheck", () => {
    render(
      <FormTextareaField
        label="Host key"
        name="hostKey"
        value=""
        onChange={vi.fn()}
        autoComplete="off"
        spellCheck={false}
      />,
    );

    const field = screen.getByRole("textbox", { name: "Host key" });
    expect(field).toHaveAttribute("autocomplete", "off");
    expect(field).toHaveAttribute("spellcheck", "false");
  });
});
