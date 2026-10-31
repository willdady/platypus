import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { Dialog } from "./ui/dialog";
import { ChatSettingsDialog } from "./chat-settings-dialog";
import { CHAT_SAMPLING_ERRORS } from "@/lib/chat-turn";
import type { ChatSettings } from "@/hooks/use-chat-settings";
import type { ReasoningMap } from "@platypus/schemas";
import { selectOption } from "@/test/test-utils";

function renderDialog(
  initial: Partial<ChatSettings> = {},
  reasoning?: ReasoningMap,
) {
  const onChange = vi.fn();
  // A stateful parent: the dialog is a controlled component, so its derived
  // validation state only moves when the value round-trips through state.
  const Harness = () => {
    const [settings, setSettings] = useState<ChatSettings>({
      instructions: "",
      temperature: undefined,
      seed: undefined,
      topP: undefined,
      topK: undefined,
      presencePenalty: undefined,
      frequencyPenalty: undefined,
      reasoningThinking: undefined,
      reasoningEffort: undefined,
      thinkingBudget: undefined,
      maxSteps: undefined,
      ...initial,
    });
    return (
      <Dialog open>
        <ChatSettingsDialog
          settings={settings}
          reasoning={reasoning}
          onChange={(patch) => {
            onChange(patch);
            setSettings((prev) => ({ ...prev, ...patch }));
          }}
        />
      </Dialog>
    );
  };
  render(<Harness />);
  // The step ceiling sits beside the sampling settings under the collapsed
  // "Advanced settings" disclosure.
  fireEvent.click(screen.getByText("Advanced settings"));
  return onChange;
}

describe("ChatSettingsDialog", () => {
  // Issue #1058: Skills and Sub-Agents come from an Agent, so an agentless
  // Chat never receives them. The helper text must not promise them.
  it("does not promise Skills or Sub-Agents in the Instructions helper", () => {
    renderDialog();

    const helper = screen.getByText(/builds the\s+full system prompt/);
    expect(helper).not.toHaveTextContent(/Skills|Sub-Agents/);
  });

  // Issue #1440: `field-sizing-content` lets the field grow to fit pasted
  // text, so both it and the dialog need a height cap to stay on screen.
  // jsdom computes no layout, so the classes are all a test can see.
  it("caps the Instructions field and the dialog height", () => {
    renderDialog();

    expect(screen.getByLabelText("Instructions")).toHaveClass("max-h-[15em]");
    expect(screen.getByRole("dialog")).toHaveClass(
      "max-h-[90vh]",
      "overflow-y-auto",
    );
  });

  // Issue #539: the per-chat step ceiling lives beside the sampling settings,
  // labelled like the Agent form's field.
  it("renders a Max steps input", () => {
    renderDialog({ maxSteps: 25 });

    const input = screen.getByLabelText("Max steps");
    expect(input).toHaveValue(25);
  });

  it("forwards typed values to onChange", () => {
    const onChange = renderDialog();

    fireEvent.change(screen.getByLabelText("Max steps"), {
      target: { value: "30" },
    });

    expect(onChange).toHaveBeenCalledWith({ maxSteps: 30 });
  });

  it("clears the setting when emptied", () => {
    const onChange = renderDialog({ maxSteps: 25 });

    fireEvent.change(screen.getByLabelText("Max steps"), {
      target: { value: "" },
    });

    expect(onChange).toHaveBeenCalledWith({ maxSteps: undefined });
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

  // #1177: the sampling inputs are judged like Max steps, with the string the
  // send guard would refuse with.
  it.each([
    ["temperature", "Temperature", "-1"],
    ["topP", "Top-p", "1.5"],
    ["topK", "Top-k", "0"],
    ["presencePenalty", "Presence Penalty", "3"],
    ["frequencyPenalty", "Frequency Penalty", "-3"],
  ] as const)("marks an out-of-range %s invalid", (field, label, value) => {
    renderDialog({ [field]: Number(value) });

    expect(screen.getByLabelText(label)).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(screen.getByText(CHAT_SAMPLING_ERRORS[field])).toBeInTheDocument();
  });

  // A stored pre-3.14.0 value can be fractional even though typing parses ints.
  it.each([
    ["topK", "Top-k"],
    ["seed", "Seed"],
  ] as const)("marks a fractional stored %s invalid", (field, label) => {
    renderDialog({ [field]: 2.5 });

    expect(screen.getByLabelText(label)).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(screen.getByText(CHAT_SAMPLING_ERRORS[field])).toBeInTheDocument();
  });

  it("shows no sampling errors for in-range values", () => {
    renderDialog({
      temperature: 0.7,
      topP: 0.9,
      topK: 40,
      seed: 1,
      presencePenalty: 0,
      frequencyPenalty: 0,
    });

    for (const message of Object.values(CHAT_SAMPLING_ERRORS)) {
      expect(screen.queryByText(message)).not.toBeInTheDocument();
    }
  });
});

describe("ChatSettingsDialog inputs", () => {
  const numberFields = [
    ["Temperature", "temperature", "0.7", 0.7],
    ["Seed", "seed", "42", 42],
    ["Top-p", "topP", "0.9", 0.9],
    ["Top-k", "topK", "40", 40],
    ["Presence Penalty", "presencePenalty", "0.5", 0.5],
    ["Frequency Penalty", "frequencyPenalty", "-0.5", -0.5],
  ] as const;

  // Each setting reaches the Chat as a number of the kind the schema expects:
  // floats for the continuous ones, whole numbers for the counts.
  it.each(numberFields)(
    "forwards a typed %s as a number",
    (label, field, value, parsed) => {
      const onChange = renderDialog();

      fireEvent.change(screen.getByLabelText(label), { target: { value } });

      expect(onChange).toHaveBeenCalledWith({ [field]: parsed });
    },
  );

  // Emptying a field unsets it, so the Provider's default applies again.
  it.each(numberFields)("clears %s when emptied", (label, field) => {
    const onChange = renderDialog({ [field]: 1 });

    fireEvent.change(screen.getByLabelText(label), { target: { value: "" } });

    expect(onChange).toHaveBeenCalledWith({ [field]: undefined });
  });

  it("forwards typed instructions", () => {
    const onChange = renderDialog();

    fireEvent.change(screen.getByLabelText("Instructions"), {
      target: { value: "Be terse." },
    });

    expect(onChange).toHaveBeenCalledWith({ instructions: "Be terse." });
  });

  // Issue #1521: the controls follow the selected model's Reasoning map.
  describe("Reasoning controls", () => {
    const MAP: ReasoningMap = {
      thinking: { on: {}, off: {} },
      effort: { low: {}, high: {} },
      budget: { field: "thinking_token_budget" },
    };

    it("shows none for a model with no map", () => {
      renderDialog();
      expect(screen.queryByLabelText("Thinking")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Effort")).not.toBeInTheDocument();
      expect(
        screen.queryByLabelText("Thinking budget"),
      ).not.toBeInTheDocument();
    });

    it("stores the chosen effort step", async () => {
      const onChange = renderDialog({}, MAP);
      await selectOption(screen.getByLabelText("Effort"), "High");
      expect(onChange).toHaveBeenLastCalledWith({ reasoningEffort: "high" });
    });

    it("offers only the declared effort steps", () => {
      renderDialog({}, MAP);
      fireEvent.click(screen.getByLabelText("Effort"));
      expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
        "Model default",
        "Low",
        "High",
      ]);
    });

    it("turning thinking off disables effort and budget", async () => {
      const onChange = renderDialog({}, MAP);
      await selectOption(screen.getByLabelText("Thinking"), "Off");
      expect(onChange).toHaveBeenLastCalledWith({ reasoningThinking: false });
      expect(screen.getByLabelText("Effort")).toBeDisabled();
      expect(screen.getByLabelText("Thinking budget")).toBeDisabled();
    });

    it("clears the budget back to unset", () => {
      const onChange = renderDialog({ thinkingBudget: 512 }, MAP);
      fireEvent.change(screen.getByLabelText("Thinking budget"), {
        target: { value: "" },
      });
      expect(onChange).toHaveBeenLastCalledWith({ thinkingBudget: undefined });
    });
  });
});
