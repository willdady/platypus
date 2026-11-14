import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FormSwitchField } from "./form-switch-field";

describe("FormSwitchField", () => {
  it("pairs the label with the switch via htmlFor/id", () => {
    render(
      <FormSwitchField
        label="Enabled"
        name="enabled"
        checked={false}
        onCheckedChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("switch", { name: "Enabled" })).toBeInTheDocument();
  });

  it("uses the name as the control's id", () => {
    render(
      <FormSwitchField
        label="Enabled"
        name="enabled"
        checked={false}
        onCheckedChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("switch", { name: "Enabled" })).toHaveAttribute(
      "id",
      "enabled",
    );
  });

  it("calls onCheckedChange when clicked", () => {
    const onCheckedChange = vi.fn();
    render(
      <FormSwitchField
        label="Enabled"
        name="enabled"
        checked={false}
        onCheckedChange={onCheckedChange}
      />,
    );

    fireEvent.click(screen.getByRole("switch", { name: "Enabled" }));

    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("toggles when its label is clicked", () => {
    const onCheckedChange = vi.fn();
    render(
      <FormSwitchField
        label="Enabled"
        name="enabled"
        checked={false}
        onCheckedChange={onCheckedChange}
      />,
    );

    fireEvent.click(screen.getByText("Enabled"));

    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("renders the description and links it to the switch", () => {
    render(
      <FormSwitchField
        label="Enabled"
        name="enabled"
        checked={false}
        onCheckedChange={vi.fn()}
        description="When disabled, no webhook requests will be sent."
      />,
    );

    expect(
      screen.getByText("When disabled, no webhook requests will be sent."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Enabled" }),
    ).toHaveAccessibleDescription(
      "When disabled, no webhook requests will be sent.",
    );
  });

  it("renders the error and marks the field invalid", () => {
    render(
      <FormSwitchField
        label="Enabled"
        name="enabled"
        checked={false}
        onCheckedChange={vi.fn()}
        error="Enabled is required"
      />,
    );

    expect(screen.getByText("Enabled is required")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Enabled" })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("renders no error when none is given", () => {
    render(
      <FormSwitchField
        label="Enabled"
        name="enabled"
        checked={false}
        onCheckedChange={vi.fn()}
      />,
    );

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Enabled" })).toHaveAttribute(
      "aria-invalid",
      "false",
    );
  });

  it("puts the switch after the text when aligned to the end", () => {
    render(
      <FormSwitchField
        label="Keep history"
        name="keepHistory"
        checked={false}
        onCheckedChange={vi.fn()}
        align="end"
      />,
    );

    const label = screen.getByText("Keep history");
    const toggle = screen.getByRole("switch", { name: "Keep history" });

    expect(
      label.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders leading content before the label", () => {
    render(
      <FormSwitchField
        label="Helper"
        name="agent-a1"
        checked={false}
        onCheckedChange={vi.fn()}
        leading={<span>avatar</span>}
      />,
    );

    const leading = screen.getByText("avatar");
    const label = screen.getByText("Helper");

    expect(
      leading.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("respects disabled", () => {
    render(
      <FormSwitchField
        label="Enabled"
        name="enabled"
        checked
        onCheckedChange={vi.fn()}
        disabled
      />,
    );

    expect(screen.getByRole("switch", { name: "Enabled" })).toBeDisabled();
  });
});
