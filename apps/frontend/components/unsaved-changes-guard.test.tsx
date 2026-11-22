import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { push } from "@/test/test-utils";
import Link from "next/link";
import { interceptedHref } from "@/lib/unsaved-changes";
import {
  UnsavedChangesProvider,
  useUnsavedChangesGuard,
} from "./unsaved-changes-guard";

// What `interceptedHref` makes of a click on an anchor with `attrs`.
function clickResult(attrs: Record<string, string>, init?: MouseEventInit) {
  const anchor = document.createElement("a");
  for (const [name, value] of Object.entries(attrs))
    anchor.setAttribute(name, value);
  anchor.textContent = "link";
  document.body.append(anchor);
  let result: string | null | undefined;
  const listener = (event: MouseEvent) => {
    result = interceptedHref(event);
    event.preventDefault();
  };
  document.addEventListener("click", listener, true);
  anchor.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true, ...init }),
  );
  document.removeEventListener("click", listener, true);
  anchor.remove();
  return result;
}

describe("interceptedHref", () => {
  it("holds a plain same-origin link click", () => {
    expect(clickResult({ href: "/org/settings?tab=a" })).toBe(
      "/org/settings?tab=a",
    );
  });

  it("lets modified, middle and new-tab clicks through", () => {
    expect(clickResult({ href: "/x" }, { metaKey: true })).toBeNull();
    expect(clickResult({ href: "/x" }, { ctrlKey: true })).toBeNull();
    expect(clickResult({ href: "/x" }, { shiftKey: true })).toBeNull();
    expect(clickResult({ href: "/x" }, { button: 1 })).toBeNull();
    expect(clickResult({ href: "/x", target: "_blank" })).toBeNull();
    expect(clickResult({ href: "/x", download: "" })).toBeNull();
  });

  it("lets external links and same-page anchors through", () => {
    expect(clickResult({ href: "https://example.com/x" })).toBeNull();
    expect(clickResult({ href: "#section" })).toBeNull();
  });
});

function Surface({ dirty }: { dirty: boolean }) {
  useUnsavedChangesGuard(dirty);
  return <Link href="/elsewhere">Elsewhere</Link>;
}

function renderGuarded(dirty: boolean) {
  return render(
    <UnsavedChangesProvider>
      <Surface dirty={dirty} />
    </UnsavedChangesProvider>,
  );
}

function unload() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("UnsavedChangesProvider", () => {
  afterEach(() => push.mockClear());

  it("registers beforeunload only while dirty", () => {
    const { rerender } = renderGuarded(false);
    expect(unload()).toBe(false);

    rerender(
      <UnsavedChangesProvider>
        <Surface dirty />
      </UnsavedChangesProvider>,
    );
    expect(unload()).toBe(true);
  });

  it("holds a link click until Discard, then navigates with the router", () => {
    renderGuarded(true);

    const notCancelled = fireEvent.click(screen.getByText("Elsewhere"));
    expect(notCancelled).toBe(false);
    expect(screen.getByText("Discard unsaved changes?")).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(push).toHaveBeenCalledWith("/elsewhere");
  });

  it("stays put on Keep editing", () => {
    renderGuarded(true);

    fireEvent.click(screen.getByText("Elsewhere"));
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));

    expect(push).not.toHaveBeenCalled();
    expect(
      screen.queryByText("Discard unsaved changes?"),
    ).not.toBeInTheDocument();
  });
});
