import { describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RevealableInput } from "./revealable-input";

describe("RevealableInput", () => {
  it("defaults to type='password'", () => {
    render(<RevealableInput aria-label="Secret" />);

    const input = screen.getByLabelText("Secret");
    expect(input).toHaveAttribute("type", "password");
  });

  it("has type='button' on the toggle button", () => {
    render(<RevealableInput aria-label="Secret" />);

    const button = screen.getByRole("button", { name: "Show password" });
    expect(button).toHaveAttribute("type", "button");
  });

  it("flips to text and back when clicked, flipping aria-label", () => {
    render(<RevealableInput aria-label="Secret" />);

    const input = screen.getByLabelText("Secret");
    const showButton = screen.getByRole("button", { name: "Show password" });

    fireEvent.click(showButton);
    expect(input).toHaveAttribute("type", "text");
    const hideButton = screen.getByRole("button", { name: "Hide password" });
    expect(hideButton).toBeInTheDocument();

    fireEvent.click(hideButton);
    expect(input).toHaveAttribute("type", "password");
    expect(
      screen.getByRole("button", { name: "Show password" }),
    ).toBeInTheDocument();
  });

  it("preserves typed value across reveal and conceal", () => {
    render(<RevealableInput aria-label="Secret" />);

    const input = screen.getByLabelText("Secret");
    fireEvent.change(input, { target: { value: "my-secret-token-42" } });
    expect(input).toHaveValue("my-secret-token-42");

    const toggle = screen.getByRole("button", { name: "Show password" });
    fireEvent.click(toggle);
    expect(input).toHaveAttribute("type", "text");
    expect(input).toHaveValue("my-secret-token-42");

    fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveValue("my-secret-token-42");
  });

  it("uses custom revealLabel in the accessible name", () => {
    render(<RevealableInput aria-label="API Key" revealLabel="API key" />);

    const showButton = screen.getByRole("button", { name: "Show API key" });
    expect(showButton).toBeInTheDocument();

    fireEvent.click(showButton);
    expect(
      screen.getByRole("button", { name: "Hide API key" }),
    ).toBeInTheDocument();
  });

  it("toggles two instances rendered together independently", () => {
    render(
      <div>
        <RevealableInput
          id="pass1"
          aria-label="First Password"
          revealLabel="first password"
        />
        <RevealableInput
          id="pass2"
          aria-label="Second Password"
          revealLabel="second password"
        />
      </div>,
    );

    const input1 = screen.getByLabelText("First Password");
    const input2 = screen.getByLabelText("Second Password");

    expect(input1).toHaveAttribute("type", "password");
    expect(input2).toHaveAttribute("type", "password");

    // Reveal first input only
    fireEvent.click(
      screen.getByRole("button", { name: "Show first password" }),
    );
    expect(input1).toHaveAttribute("type", "text");
    expect(input2).toHaveAttribute("type", "password");

    // Reveal second input
    fireEvent.click(
      screen.getByRole("button", { name: "Show second password" }),
    );
    expect(input1).toHaveAttribute("type", "text");
    expect(input2).toHaveAttribute("type", "text");

    // Conceal first input
    fireEvent.click(
      screen.getByRole("button", { name: "Hide first password" }),
    );
    expect(input1).toHaveAttribute("type", "password");
    expect(input2).toHaveAttribute("type", "text");
  });

  it("disables the toggle button when input is disabled", () => {
    render(<RevealableInput aria-label="Secret" disabled />);

    const button = screen.getByRole("button", { name: "Show password" });
    expect(button).toBeDisabled();
  });
});
