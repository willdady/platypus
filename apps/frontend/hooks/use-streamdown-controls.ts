import { useSyncExternalStore } from "react";
import type { ControlsConfig } from "streamdown";

// Streamdown's table copy calls `navigator.clipboard.write` with a
// `ClipboardItem`, which the clipboard fallback does not cover, so over plain
// HTTP it is hidden. The table can still be downloaded or selected by hand.
const insecureControls: ControlsConfig = { table: { copy: false } };

function noSubscribe() {
  return () => {};
}

/** The `controls` to give a Streamdown that keeps its copy buttons. */
export function useStreamdownControls(): ControlsConfig | undefined {
  const isInsecure = useSyncExternalStore(
    noSubscribe,
    () => window.isSecureContext === false,
    () => false,
  );
  return isInsecure ? insecureControls : undefined;
}
