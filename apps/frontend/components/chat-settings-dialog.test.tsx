import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { Dialog } from "./ui/dialog";
import { ChatSettingsDialog } from "./chat-settings-dialog";

const renderDialog = (
  props: Partial<Parameters<typeof ChatSettingsDialog>[0]> = {},
) => {
  const onMaxStepsChange = vi.fn();
  // A stateful parent: the dialog is a controlled component, so its derived
  // validation state only moves when the value round-trips through state.
  const Harness = () => {
    const [maxSteps, setMaxSteps] = useState(props.maxSteps);
    return (
      <Dialog open>
        <ChatSettingsDialog
          instructions=""
          onInstructionsChange={vi.fn()}
          temperature={undefined}
          onTemperatureChange={vi.fn()}
          seed={undefined}
          onSeedChange={vi.fn()}
          topP={undefined}
          onTopPChange={vi.fn()}
          topK={undefined}
          onTopKChange={vi.fn()}
          presencePenalty={undefined}
          onPresencePenaltyChange={vi.fn()}
          frequencyPenalty={undefined}
          onFrequencyPenaltyChange={vi.fn()}
          maxSteps={maxSteps}
          onMaxStepsChange={(v) => {
            onMaxStepsChange(v);
            setMaxSteps(v);
          }}
        />
      </Dialog>
    );
  };
  render(<Harness />);
  // The step ceiling sits beside the sampling settings under the collapsed
  // "Advanced settings" disclosure.
  fireEvent.click(screen.getByText("Advanced settings"));
  return onMaxStepsChange;
};

describe("ChatSettingsDialog", () => {
  // Issue #539: the per-chat step ceiling lives beside the sampling settings,
  // labelled like the Agent form's field.
  it("renders a Max steps input", () => {
    renderDialog({ maxSteps: 25 });

    const input = screen.getByLabelText("Max steps");
    expect(input).toHaveValue(25);
  });

  it("forwards typed values to onMaxStepsChange", () => {
    const onMaxStepsChange = renderDialog();

    fireEvent.change(screen.getByLabelText("Max steps"), {
      target: { value: "30" },
    });

    expect(onMaxStepsChange).toHaveBeenCalledWith(30);
  });

  it("clears the setting when emptied", () => {
    const onMaxStepsChange = renderDialog({ maxSteps: 25 });

    fireEvent.change(screen.getByLabelText("Max steps"), {
      target: { value: "" },
    });

    expect(onMaxStepsChange).toHaveBeenCalledWith(undefined);
  });

  it.each(["0", "-2", "51"])(
    "shows a visible validation error for %s",
    (value) => {
      renderDialog();

      fireEvent.change(screen.getByLabelText("Max steps"), {
        target: { value },
      });

      const input = screen.getByLabelText("Max steps");
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(
        screen.getByText("Max steps must be a whole number between 1 and 50."),
      ).toBeInTheDocument();
    },
  );

  it("clears the validation error once the value is corrected", () => {
    renderDialog();

    const input = screen.getByLabelText("Max steps");
    fireEvent.change(input, { target: { value: "99" } });
    expect(
      screen.getByText("Max steps must be a whole number between 1 and 50."),
    ).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "10" } });
    expect(
      screen.queryByText("Max steps must be a whole number between 1 and 50."),
    ).not.toBeInTheDocument();
    expect(input).not.toHaveAttribute("aria-invalid", "true");
  });
});
