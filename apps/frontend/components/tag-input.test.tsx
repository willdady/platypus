import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TagInput } from "./tag-input";

const renderTagInput = (value: string[] = []) => {
  const onChange = vi.fn();
  render(
    <>
      <label htmlFor="tags">Tags</label>
      <TagInput id="tags" value={value} onChange={onChange} />
    </>,
  );
  return { onChange, input: screen.getByLabelText("Tags") };
};

const enterTag = (input: HTMLElement, text: string, key = "Enter") => {
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key });
};

describe("TagInput", () => {
  it.each(["Enter", ","])("adds the typed tag on %s", (key) => {
    const { onChange, input } = renderTagInput(["alpha"]);

    enterTag(input, "beta", key);

    expect(onChange).toHaveBeenCalledWith(["alpha", "beta"]);
    expect(input).toHaveValue("");
  });

  it("trims and lowercases a tag before adding it", () => {
    const { onChange, input } = renderTagInput();

    enterTag(input, "  Release-Notes ");

    expect(onChange).toHaveBeenCalledWith(["release-notes"]);
  });

  it("refuses a tag that is not kebab-case and keeps what was typed", () => {
    const { onChange, input } = renderTagInput();

    enterTag(input, "two words");

    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue("two words");
  });

  // A duplicate isn't an error to fix: the input clears, as if it were added.
  it("does not add a tag it already has, and clears the input", () => {
    const { onChange, input } = renderTagInput(["alpha"]);

    enterTag(input, "Alpha");

    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue("");
  });

  it("removes a tag from its remove button", () => {
    const { onChange } = renderTagInput(["alpha", "beta"]);

    fireEvent.click(screen.getByRole("button", { name: "Remove alpha" }));

    expect(onChange).toHaveBeenCalledWith(["beta"]);
  });

  it("removes the last tag on Backspace in an empty input", () => {
    const { onChange, input } = renderTagInput(["alpha", "beta"]);

    fireEvent.keyDown(input, { key: "Backspace" });

    expect(onChange).toHaveBeenCalledWith(["alpha"]);
  });

  it("leaves the tags alone on Backspace while there is text to delete", () => {
    const { onChange, input } = renderTagInput(["alpha"]);

    fireEvent.change(input, { target: { value: "be" } });
    fireEvent.keyDown(input, { key: "Backspace" });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("disables the input once the tag limit is reached", () => {
    const { input } = renderTagInput(["a", "b", "c", "d", "e"]);

    expect(input).toBeDisabled();
  });
});
