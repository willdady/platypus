import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { installClipboardFallback } from "@/lib/clipboard";
import { MessageResponse } from "./message";

afterEach(() => {
  Reflect.deleteProperty(window, "isSecureContext");
  Reflect.deleteProperty(navigator, "clipboard");
  Reflect.deleteProperty(document, "execCommand");
});

describe("MessageResponse code-block copy over plain HTTP", () => {
  it("copies through the clipboard fallback", async () => {
    Object.defineProperty(window, "isSecureContext", {
      value: false,
      configurable: true,
    });
    let copied = "";
    Object.defineProperty(document, "execCommand", {
      value: vi.fn(() => {
        copied = (document.activeElement as HTMLTextAreaElement).value;
        return true;
      }),
      configurable: true,
    });
    installClipboardFallback();

    render(<MessageResponse>{"```js\nconst a = 1;\n```"}</MessageResponse>);
    fireEvent.click(await screen.findByRole("button", { name: "Copy Code" }));

    await waitFor(() => expect(copied.trim()).toBe("const a = 1;"));
  });
});
