import { toast } from "sonner";

export async function copyToClipboard(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {}
  }
  return copyWithCommand(text);
}

function copyWithCommand(text: string): boolean {
  const previousFocus = document.activeElement as HTMLElement | null;
  const container =
    previousFocus?.closest<HTMLElement>(
      '[role="dialog"], [role="alertdialog"], [role="menu"]',
    ) ?? document.body;
  // why: the browser carries a focus ring back to a mouse-clicked button
  const ringBefore = previousFocus?.matches(":focus-visible") ?? false;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.opacity = "0";
  // why: below 16px iOS zooms the page in on focus
  textarea.style.fontSize = "16px";
  container.appendChild(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    // why: iOS Safari ignores `select()` on a readonly field
    textarea.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    container.removeChild(textarea);
    previousFocus?.focus({ preventScroll: true, focusVisible: ringBefore });
  }
}

export async function copyWithToast(
  text: string,
  copied: string | false = "Copied to clipboard",
  failed = "Failed to copy to clipboard",
): Promise<boolean> {
  const ok = await copyToClipboard(text);
  if (!ok) toast.error(failed);
  else if (copied) toast.success(copied);
  return ok;
}

export function installClipboardFallback() {
  if (window.isSecureContext !== false || navigator.clipboard) return;
  Object.defineProperty(navigator, "clipboard", {
    value: {
      writeText: (text: string) => {
        if (copyWithCommand(text)) return Promise.resolve();
        toast.error("Failed to copy to clipboard");
        return Promise.reject(new Error("Copy failed"));
      },
    },
    configurable: true,
  });
}
