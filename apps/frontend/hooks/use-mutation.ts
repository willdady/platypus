import { useRef, useState } from "react";

/**
 * Wraps an async write so it can't be sent twice. `run` drops any call made
 * while a previous one is still in flight — a double click, or Enter held
 * down — and `pending` drives the button's disabled state and pending label.
 *
 * The guard is a ref, not the `pending` state: two clicks in the same tick
 * both see the state from before the first one landed.
 */
export function useMutation<Args extends unknown[], Result>(
  fn: (...args: Args) => Promise<Result>,
) {
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);

  const run = async (...args: Args): Promise<Result | undefined> => {
    if (inFlight.current) return undefined;
    inFlight.current = true;
    setPending(true);
    try {
      return await fn(...args);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  return { run, pending };
}
