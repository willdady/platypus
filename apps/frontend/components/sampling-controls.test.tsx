import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SamplingControls } from "./sampling-controls";

describe("SamplingControls", () => {
  // #1941: one component for both the Agent form and the Chat settings dialog,
  // so the six fields read the same and sit in the same order on both.
  it("renders the six sampling fields in order", () => {
    render(<SamplingControls value={{}} onChange={vi.fn()} />);

    expect(
      screen
        .getAllByRole<HTMLInputElement>("spinbutton")
        .map((input) => input.labels?.[0]?.textContent),
    ).toEqual([
      "Temperature",
      "Seed",
      "Top-p",
      "Top-k",
      "Presence Penalty",
      "Frequency Penalty",
    ]);
  });

  // The bounds are the schema's, so the browser's own hints match the request
  // validator. Seed has no bound because any whole number is valid, and the
  // counts need no step because they only take whole numbers.
  it.each([
    ["Temperature", "min", "0"],
    ["Temperature", "step", "0.1"],
    ["Top-p", "min", "0"],
    ["Top-p", "max", "1"],
    ["Top-p", "step", "0.1"],
    ["Top-k", "min", "1"],
    ["Presence Penalty", "min", "-2"],
    ["Presence Penalty", "max", "2"],
    ["Presence Penalty", "step", "0.1"],
    ["Frequency Penalty", "min", "-2"],
    ["Frequency Penalty", "max", "2"],
    ["Frequency Penalty", "step", "0.1"],
  ])("sets %s's %s", (label, attribute, value) => {
    render(<SamplingControls value={{}} onChange={vi.fn()} />);

    expect(screen.getByLabelText(label)).toHaveAttribute(attribute, value);
  });

  it.each([
    ["Temperature", "max"],
    ["Seed", "min"],
    ["Seed", "max"],
    ["Seed", "step"],
    ["Top-k", "max"],
    ["Top-k", "step"],
  ])("leaves %s's %s unset", (label, attribute) => {
    render(<SamplingControls value={{}} onChange={vi.fn()} />);

    expect(screen.getByLabelText(label)).not.toHaveAttribute(attribute);
  });

  it("shows the value it is given", () => {
    render(
      <SamplingControls
        value={{
          temperature: 0.7,
          seed: 42,
          topP: 0.9,
          topK: 40,
          presencePenalty: -0.5,
          frequencyPenalty: 0.5,
        }}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Temperature")).toHaveValue(0.7);
    expect(screen.getByLabelText("Seed")).toHaveValue(42);
    expect(screen.getByLabelText("Top-p")).toHaveValue(0.9);
    expect(screen.getByLabelText("Top-k")).toHaveValue(40);
    expect(screen.getByLabelText("Presence Penalty")).toHaveValue(-0.5);
    expect(screen.getByLabelText("Frequency Penalty")).toHaveValue(0.5);
  });

  // Each field reports a patch holding only itself, as the continuous ones
  // parse as floats and the counts as whole numbers.
  it.each([
    ["Temperature", "temperature", "0.7", 0.7],
    ["Seed", "seed", "42", 42],
    ["Top-p", "topP", "0.9", 0.9],
    ["Top-k", "topK", "40", 40],
    ["Presence Penalty", "presencePenalty", "0.5", 0.5],
    ["Frequency Penalty", "frequencyPenalty", "-0.5", -0.5],
  ])(
    "reports %s as a patch holding only its own field",
    (label, field, typed, parsed) => {
      const onChange = vi.fn();
      render(<SamplingControls value={{}} onChange={onChange} />);

      fireEvent.change(screen.getByLabelText(label), {
        target: { value: typed },
      });

      expect(onChange).toHaveBeenCalledWith({ [field]: parsed });
    },
  );

  // Emptying a field means "not set", so the Provider or model default applies.
  it.each([
    ["Temperature", "temperature"],
    ["Seed", "seed"],
    ["Top-p", "topP"],
    ["Top-k", "topK"],
    ["Presence Penalty", "presencePenalty"],
    ["Frequency Penalty", "frequencyPenalty"],
  ])("unset %s when emptied", (label, field) => {
    const onChange = vi.fn();
    render(<SamplingControls value={{ [field]: 1 }} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText(label), {
      target: { value: "" },
    });

    expect(onChange).toHaveBeenCalledWith({ [field]: undefined });
  });

  it("shows a field's error inline and marks it invalid", () => {
    render(
      <SamplingControls
        value={{}}
        onChange={vi.fn()}
        errors={{ topP: "Top-p must be between 0 and 1." }}
      />,
    );

    expect(
      screen.getByText("Top-p must be between 0 and 1."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Top-p")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(screen.getByLabelText("Top-k")).toHaveAttribute(
      "aria-invalid",
      "false",
    );
  });

  it("disables every field", () => {
    render(<SamplingControls value={{}} onChange={vi.fn()} disabled />);

    for (const input of screen.getAllByRole("spinbutton")) {
      expect(input).toBeDisabled();
    }
  });
});
