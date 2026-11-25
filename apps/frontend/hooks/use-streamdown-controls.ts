import { useSyncExternalStore } from "react";
import type { ControlsConfig } from "streamdown";

const insecureControls: ControlsConfig = { table: { copy: false } };

function noSubscribe() {
  return () => {};
}

export function useStreamdownControls(): ControlsConfig | undefined {
  const isInsecure = useSyncExternalStore(
    noSubscribe,
    () => window.isSecureContext === false,
    () => false,
  );
  return isInsecure ? insecureControls : undefined;
}
