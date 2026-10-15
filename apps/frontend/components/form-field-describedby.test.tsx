import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import { SelectItem } from "@/components/ui/select";
import { installRadixPointerPolyfills } from "@/lib/test-utils";
import { FormTextField } from "./form-text-field";
import { FormTextareaField } from "./form-textarea-field";
import { FormSelectField } from "./form-select-field";

beforeAll(installRadixPointerPolyfills);

const FIELDS = [
  {
    kind: "text",
    render: (props: { error?: string; description?: string }) => (
      <FormTextField
        label="Name"
        name="name"
        value=""
        onChange={vi.fn()}
        {...props}
      />
    ),
    control: () => screen.getByRole("textbox", { name: "Name" }),
  },
  {
    kind: "textarea",
    render: (props: { error?: string; description?: string }) => (
      <FormTextareaField
        label="Name"
        name="name"
        value=""
        onChange={vi.fn()}
        {...props}
      />
    ),
    control: () => screen.getByRole("textbox", { name: "Name" }),
  },
  {
    kind: "select",
    render: (props: { error?: string; description?: string }) => (
      <FormSelectField
        label="Name"
        name="name"
        value=""
        onValueChange={vi.fn()}
        {...props}
      >
        <SelectItem value="a">A</SelectItem>
      </FormSelectField>
    ),
    control: () => screen.getByRole("combobox", { name: "Name" }),
  },
];

describe.each(FIELDS)(
  "Form $kind field",
  ({ render: renderField, control }) => {
    it("describes the control with its description", () => {
      render(renderField({ description: "What people call it." }));

      expect(control()).toHaveAccessibleDescription("What people call it.");
    });

    it("describes the control with its error, after the description", () => {
      render(
        renderField({
          description: "What people call it.",
          error: "Name is required",
        }),
      );

      expect(control()).toHaveAccessibleDescription(
        "What people call it. Name is required",
      );
    });

    it("carries no description when there is nothing to say", () => {
      render(renderField({}));

      expect(control()).not.toHaveAttribute("aria-describedby");
    });
  },
);
