import { useRef, useState } from "react";

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
