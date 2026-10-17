import { toast } from "sonner";

/**
 * Copies text to the clipboard, also where the Clipboard API is missing.
 *
 * `navigator.clipboard` exists only in a secure context (HTTPS or localhost),
 * and a self-hosted deployment is often served over plain HTTP on a LAN name.
 * There the fallback selects the text in a throwaway textarea and runs the
 * legacy copy command, which still works from a click handler.
 *
 * Our own copy buttons call this (or {@link copyWithToast}).
 * {@link installClipboardFallback} exists only for third-party code that calls
 * `navigator.clipboard` itself.
 *
 * Resolves `true` when the text was copied, `false` when neither way worked.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission refused or document not focused: try the fallback.
    }
  }
  return copyWithCommand(text);
}

/**
 * The legacy fallback. The textarea goes inside whatever traps focus — the
 * open dialog or menu holding it, if any: a focus trap pulls focus back from
 * an element outside it, and the copy then finds nothing selected.
 */
function copyWithCommand(text: string): boolean {
  const previousFocus = document.activeElement as HTMLElement | null;
  const container =
    previousFocus?.closest<HTMLElement>(
      '[role="dialog"], [role="alertdialog"], [role="menu"]',
    ) ?? document.body;
  // The textarea always shows a focus ring, and the browser would carry it
  // back to a button that was clicked with the mouse.
  const ringBefore = previousFocus?.matches(":focus-visible") ?? false;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.opacity = "0";
  // Below 16px iOS zooms the page in on focus.
  textarea.style.fontSize = "16px";
  container.appendChild(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    // iOS Safari ignores `select()` on a readonly field.
    textarea.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    container.removeChild(textarea);
    previousFocus?.focus({ preventScroll: true, focusVisible: ringBefore });
  }
}

/**
 * {@link copyToClipboard} with the usual toasts. Pass `copied: false` where
 * the button already shows its own success state.
 */
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

/**
 * Over plain HTTP the browser leaves `navigator.clipboard` out, and
 * Streamdown's code-block and diagram copy buttons call
 * `navigator.clipboard.writeText` themselves. Standing in for that one method
 * sends them through the copy-command fallback. Streamdown's table copy needs
 * `write` instead, so it is hidden over HTTP (see `useStreamdownControls`).
 */
export function installClipboardFallback() {
  if (window.isSecureContext !== false || navigator.clipboard) return;
  Object.defineProperty(navigator, "clipboard", {
    value: {
      writeText: (text: string) => {
        if (copyWithCommand(text)) return Promise.resolve();
        // Streamdown reports a failed copy nowhere the user would see it.
        toast.error("Failed to copy to clipboard");
        return Promise.reject(new Error("Copy failed"));
      },
    },
    configurable: true,
  });
}
