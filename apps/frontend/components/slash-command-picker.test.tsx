import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRef, useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Skill } from "@platypus/schemas";
import { Composer } from "./composer";
import { SlashCommandPicker } from "./slash-command-picker";
import { useSlashCommands } from "@/hooks/use-slash-commands";
import { composerProvider } from "@/lib/chat-test-fixtures";
import { installMatchMediaStub } from "@/lib/test-utils";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

beforeEach(installMatchMediaStub);

const skill = (
  name: string,
  extra: Partial<Skill> = {},
): Pick<Skill, "name" | "description" | "argumentHint"> => ({
  name,
  description: `Does ${name}`,
  argumentHint: null,
  ...extra,
});

/**
 * The picker is driven through the REAL composer, not a bare textarea: the
 * keydown ordering is the integration risk this feature carries.
 * `PromptInputTextarea` owns Enter-to-submit and runs a caller's handler first,
 * standing down only on `defaultPrevented` — so "Enter accepts the highlighted
 * command instead of sending the message" is a claim about that interaction,
 * and only the composer can test it.
 */
const renderPicker = ({
  commands,
  enabled = true,
}: {
  commands: Pick<Skill, "name" | "description" | "argumentHint">[];
  enabled?: boolean;
}) => {
  const onSubmit = vi.fn();

  const Harness = () => {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [value, setValue] = useState("");
    const slash = useSlashCommands({
      commands,
      enabled,
      value,
      onChange: setValue,
      textareaRef,
    });

    return (
      <div className="relative">
        <SlashCommandPicker {...slash.picker} />
        <Composer
          onSubmit={onSubmit}
          passthroughFileTypes={[]}
          modelSelection={{
            agents: [],
            providers: [composerProvider],
            agentId: "",
            modelId: "gpt-4o",
            providerId: composerProvider.id,
            isResolved: true,
            onModelChange: vi.fn(),
          }}
          textarea={{
            ref: textareaRef,
            value,
            onChange: (e) => setValue(e.target.value),
            onKeyDown: slash.onKeyDown,
            ...slash.combobox,
          }}
          onTranscriptionChange={setValue}
          submit={
            <button type="submit" data-testid="send">
              Send
            </button>
          }
        />
      </div>
    );
  };

  render(<Harness />);
  const textarea = screen.getByRole("combobox") as HTMLTextAreaElement;
  return { textarea, onSubmit };
};

const type = (textarea: HTMLTextAreaElement, value: string) =>
  fireEvent.change(textarea, { target: { value } });

const options = () => screen.queryAllByRole("option").map((o) => o.textContent);

describe("SlashCommandPicker", () => {
  const commands = [
    skill("blog-post", { argumentHint: "<topic>" }),
    skill("deploy"),
    skill("deploy-staging"),
  ];

  it("opens on a slash at position 0 and not on a slash anywhere else", () => {
    const { textarea } = renderPicker({ commands });

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(textarea).toHaveAttribute("aria-expanded", "false");

    type(textarea, "/");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(textarea).toHaveAttribute("aria-expanded", "true");

    type(textarea, "tell me about /deploy");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("closes once the command is followed by a space", () => {
    const { textarea } = renderPicker({ commands });
    type(textarea, "/deploy");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    type(textarea, "/deploy ");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("renders the argument hint beside the command name", () => {
    const { textarea } = renderPicker({ commands });
    type(textarea, "/blog");
    expect(screen.getByRole("option")).toHaveTextContent("/blog-post");
    expect(screen.getByRole("option")).toHaveTextContent("<topic>");
  });

  it("highlights the exact match when a shorter name also matches", () => {
    const { textarea } = renderPicker({ commands });
    type(textarea, "/deploy");

    expect(options()).toHaveLength(2);
    expect(screen.getAllByRole("option")[0]).toHaveTextContent("/deploy");
    expect(textarea).toHaveAttribute(
      "aria-activedescendant",
      "slash-command-option-deploy",
    );
  });

  it("moves the selection with the arrow keys", () => {
    const { textarea } = renderPicker({ commands });
    type(textarea, "/deploy");

    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(textarea).toHaveAttribute(
      "aria-activedescendant",
      "slash-command-option-deploy-staging",
    );

    // Wraps, so the list is navigable in one direction alone.
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(textarea).toHaveAttribute(
      "aria-activedescendant",
      "slash-command-option-deploy",
    );

    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(textarea).toHaveAttribute(
      "aria-activedescendant",
      "slash-command-option-deploy-staging",
    );
  });

  it("accepts the highlighted command on Enter without sending the message", () => {
    const { textarea, onSubmit } = renderPicker({ commands });
    type(textarea, "/blog");

    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(textarea.value).toBe("/blog-post ");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    // The caret sits after the token, so the user keeps typing their prompt.
    expect(textarea.selectionStart).toBe("/blog-post ".length);
    expect(document.activeElement).toBe(textarea);
  });

  it("accepts on Tab", () => {
    const { textarea } = renderPicker({ commands });
    type(textarea, "/blog");
    fireEvent.keyDown(textarea, { key: "Tab" });
    expect(textarea.value).toBe("/blog-post ");
  });

  it("leaves Shift+Tab to move focus", () => {
    const { textarea } = renderPicker({ commands });
    type(textarea, "/blog");
    fireEvent.keyDown(textarea, { key: "Tab", shiftKey: true });
    expect(textarea.value).toBe("/blog");
  });

  it("accepts on click", () => {
    const { textarea } = renderPicker({ commands });
    type(textarea, "/deploy");
    fireEvent.click(screen.getAllByRole("option")[1]);
    expect(textarea.value).toBe("/deploy-staging ");
  });

  it("closes on Escape without clearing the input, and reopens on further typing", () => {
    const { textarea } = renderPicker({ commands });
    type(textarea, "/blog");

    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(textarea.value).toBe("/blog");

    type(textarea, "/blog-");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("sends an unmatched command as ordinary text", async () => {
    const { textarea, onSubmit } = renderPicker({ commands });
    type(textarea, "/usr");

    // Open, saying so, but with nothing to accept — so Enter is the textarea's
    // again and the message goes as typed.
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText(/ordinary text/)).toBeInTheDocument();
    expect(textarea).not.toHaveAttribute("aria-activedescendant");

    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ text: "/usr" }),
        expect.anything(),
      ),
    );
  });

  // `aria-controls` has to follow the listbox element, not the open state: an
  // open picker with nothing to list renders a message and no list, and an id
  // pointing at nothing is worse than no id at all.
  it("points aria-controls at the listbox only while one is rendered", () => {
    const { textarea } = renderPicker({ commands });

    type(textarea, "/blog");
    expect(textarea).toHaveAttribute(
      "aria-controls",
      screen.getByRole("listbox").id,
    );

    type(textarea, "/usr");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(textarea).not.toHaveAttribute("aria-controls");
    // Still a popup, and the line explaining why is announced.
    expect(textarea).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("status")).toHaveTextContent("No matching skill");
  });

  it("says so when the agent has no skills assigned", () => {
    const { textarea } = renderPicker({ commands: [] });
    type(textarea, "/");
    expect(
      screen.getByText("This agent has no skills assigned."),
    ).toBeInTheDocument();
  });

  it("does nothing at all when no agent is selected", async () => {
    const { textarea, onSubmit } = renderPicker({ commands, enabled: false });
    type(textarea, "/blog");

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.queryByText(/skills/)).not.toBeInTheDocument();
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ text: "/blog" }),
        expect.anything(),
      ),
    );
  });

  it("leaves Shift+Enter as a newline", () => {
    const { textarea, onSubmit } = renderPicker({ commands });
    type(textarea, "/blog");
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(textarea.value).toBe("/blog");
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
