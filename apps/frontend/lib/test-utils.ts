import { fireEvent } from "@testing-library/react";

/**
 * Radix's DropdownMenu opens on pointerdown and grabs pointer capture,
 * neither of which jsdom implements. Call once (e.g. in `beforeAll`) before
 * rendering anything that uses a Radix DropdownMenu/Select/etc.
 */
export function installRadixPointerPolyfills() {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
}

/** Opens the first closed Radix DropdownMenu trigger found in the document. */
export function openDropdownMenu() {
  const trigger = document.querySelector('[aria-haspopup="menu"]');
  if (!trigger) {
    throw new Error("No dropdown menu trigger found in the document");
  }
  // Our DropdownMenu trigger only opens on pointerdown for a mouse; jsdom
  // leaves `pointerType` empty, so the tap has to be completed with a click.
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 });
  fireEvent.pointerUp(trigger, { button: 0, pointerId: 1 });
  fireEvent.click(trigger, { button: 0 });
}
