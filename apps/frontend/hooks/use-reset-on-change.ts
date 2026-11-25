import { useState } from "react";

const UNINITIALIZED = Symbol("useResetOnChange:uninitialized");

export function useResetOnChange(key: unknown, reset: () => void) {
  const [prevKey, setPrevKey] = useState<unknown>(UNINITIALIZED);
  if (key !== prevKey) {
    setPrevKey(key);
    reset();
  }
}
