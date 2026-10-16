import { describe, it, expect, vi, afterEach } from "vitest";
import { toast } from "sonner";
import {
  copyToClipboard,
  copyWithToast,
  installClipboardFallback,
} from "./clipboard";

// jsdom does not define `isSecureContext` at all.
const stubSecureContext = (secure: boolean) =>
  Object.defineProperty(window, "isSecureContext", {
    value: secure,
    configurable: true,
  });

// jsdom implements neither the Clipboard API nor execCommand, so both are
// installed per test and removed after.
const setClipboard = (writeText: ((text: string) => Promise<void>) | null) =>
  Object.defineProperty(navigator, "clipboard", {
    value: writeText ? { writeText } : undefined,
    configurable: true,
  });

const setExecCommand = (impl: (command: string) => boolean) =>
  Object.defineProperty(document, "execCommand", {
    value: vi.fn(impl),
    configurable: true,
  });

afterEach(() => {
  setClipboard(null);
});

describe("copyToClipboard", () => {
  it("uses the Clipboard API in a secure context", async () => {
    stubSecureContext(true);
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);
    setExecCommand(() => true);

    expect(await copyToClipboard("tok_123")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("tok_123");
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  it("falls back to the copy command over plain HTTP, where the API is missing", async () => {
    stubSecureContext(false);
    let selected = "";
    setExecCommand((command) => {
      const active = document.activeElement as HTMLTextAreaElement;
      selected = active.value.slice(active.selectionStart, active.selectionEnd);
      return command === "copy";
    });

    expect(await copyToClipboard("tok_123")).toBe(true);
    expect(selected).toBe("tok_123");
    // The throwaway textarea is gone afterwards.
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("puts the fallback inside the focused dialog, past its focus trap", async () => {
    stubSecureContext(false);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const button = document.createElement("button");
    dialog.appendChild(button);
    document.body.appendChild(dialog);
    button.focus();
    let parent: Element | null = null;
    setExecCommand(() => {
      parent = document.activeElement?.parentElement ?? null;
      return true;
    });

    expect(await copyToClipboard("tok_123")).toBe(true);
    expect(parent).toBe(dialog);
    // Focus goes back to the button that asked for the copy.
    expect(document.activeElement).toBe(button);
    dialog.remove();
  });

  it("puts the fallback inside an open menu, past its focus trap", async () => {
    stubSecureContext(false);
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    const item = document.createElement("div");
    item.tabIndex = -1;
    menu.appendChild(item);
    document.body.appendChild(menu);
    item.focus();
    let parent: Element | null = null;
    setExecCommand(() => {
      parent = document.activeElement?.parentElement ?? null;
      return true;
    });

    expect(await copyToClipboard("tok_123")).toBe(true);
    expect(parent).toBe(menu);
    menu.remove();
  });

  it("falls back when the Clipboard API refuses", async () => {
    stubSecureContext(true);
    setClipboard(vi.fn().mockRejectedValue(new Error("NotAllowedError")));
    setExecCommand(() => true);

    expect(await copyToClipboard("tok_123")).toBe(true);
    expect(document.execCommand).toHaveBeenCalledWith("copy");
  });

  it("reports failure when neither way copies", async () => {
    stubSecureContext(false);
    setExecCommand(() => false);

    expect(await copyToClipboard("tok_123")).toBe(false);
  });
});

describe("copyWithToast", () => {
  it("names what failed to copy", async () => {
    stubSecureContext(false);
    setExecCommand(() => false);
    const error = vi.spyOn(toast, "error");

    await copyWithToast("x", "Link copied", "Could not copy the link");
    expect(error).toHaveBeenCalledWith("Could not copy the link");
  });

  it("stays quiet on success when the button shows its own", async () => {
    stubSecureContext(false);
    setExecCommand(() => true);
    const success = vi.spyOn(toast, "success");

    expect(await copyWithToast("x", false)).toBe(true);
    expect(success).not.toHaveBeenCalled();
  });
});

describe("installClipboardFallback", () => {
  it("stands in for writeText over plain HTTP and reports a failed copy", async () => {
    stubSecureContext(false);
    setExecCommand(() => false);
    const error = vi.spyOn(toast, "error");
    installClipboardFallback();

    await expect(navigator.clipboard.writeText("x")).rejects.toThrow();
    expect(error).toHaveBeenCalledWith("Failed to copy to clipboard");
  });

  it("leaves a secure context alone", () => {
    stubSecureContext(true);
    installClipboardFallback();
    expect(navigator.clipboard).toBeUndefined();
  });
});
