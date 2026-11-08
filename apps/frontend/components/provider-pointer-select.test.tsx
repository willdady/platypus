import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Provider } from "@platypus/schemas";
import type { Serialized } from "@/lib/api-write";
import { selectOption, setupUser } from "@/test/test-utils";
import { ProviderPointerSelect } from "./provider-pointer-select";

const providers = [
  {
    id: "p-openai",
    name: "OpenAI",
    taskModelId: "gpt-4o",
    memoryExtractionModelId: "",
    embeddingModelId: null,
  },
  {
    id: "p-anthropic",
    name: "Anthropic",
    taskModelId: "claude-3",
    memoryExtractionModelId: "claude-haiku",
    embeddingModelId: null,
  },
  {
    id: "p-voyage",
    name: "Voyage",
    taskModelId: "",
    memoryExtractionModelId: "",
    embeddingModelId: "voyage-3",
  },
] as unknown as Serialized<Provider>[];

function renderSelect(
  props: Partial<React.ComponentProps<typeof ProviderPointerSelect>> = {},
) {
  return render(
    <ProviderPointerSelect
      kind="task"
      label="Provider"
      noneLabel="Disabled"
      value={null}
      onChange={vi.fn()}
      providers={providers}
      {...props}
    />,
  );
}

/** Opens the select and reads every option it offers. */
async function openOptions() {
  await setupUser().click(screen.getByRole("combobox", { name: "Provider" }));
  return (await screen.findAllByRole("option")).map(
    (option) => option.textContent,
  );
}

describe("ProviderPointerSelect", () => {
  it.each([
    ["task", ["Disabled", "OpenAI (gpt-4o)", "Anthropic (claude-3)", "Voyage"]],
    ["memoryExtraction", ["Disabled", "Anthropic (claude-haiku)"]],
    ["embedding", ["Disabled", "Voyage (voyage-3)"]],
  ] as const)(
    "offers the providers eligible for a %s pointer",
    async (kind, expected) => {
      renderSelect({ kind });

      expect(await openOptions()).toEqual(expected);
    },
  );

  it("shows the none label with a null value", () => {
    renderSelect();

    expect(
      screen.getByRole("combobox", { name: "Provider" }),
    ).toHaveTextContent("Disabled");
  });

  it("maps a picked provider to its id and the none option to null", async () => {
    const onChange = vi.fn();
    renderSelect({ value: "p-openai", onChange });

    await selectOption(
      screen.getByRole("combobox", { name: "Provider" }),
      "Disabled",
    );
    expect(onChange).toHaveBeenLastCalledWith(null);

    await selectOption(
      screen.getByRole("combobox", { name: "Provider" }),
      "Anthropic (claude-3)",
    );
    expect(onChange).toHaveBeenLastCalledWith("p-anthropic");
  });

  it("describes the control with its description and error", () => {
    renderSelect({
      description: "The Provider used for titles.",
      error: "Provider is required",
    });

    const control = screen.getByRole("combobox", { name: "Provider" });
    expect(control).toHaveAttribute("aria-invalid", "true");
    expect(control).toHaveAccessibleDescription(
      "The Provider used for titles. Provider is required",
    );
  });

  it("disables itself with no eligible provider when asked", () => {
    renderSelect({ kind: "embedding", providers: [], disableWhenEmpty: true });

    expect(screen.getByRole("combobox", { name: "Provider" })).toBeDisabled();
  });

  it("stays usable with no eligible provider otherwise", () => {
    renderSelect({ kind: "embedding", providers: [] });

    expect(screen.getByRole("combobox", { name: "Provider" })).toBeEnabled();
  });
});
