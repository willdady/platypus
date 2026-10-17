# React Compiler

The frontend does not enable React Compiler (`reactCompiler: true` in the Next.js config). Memoization stays hand-written with `useMemo`, `useCallback` and `memo()`.

## Why this is out of scope

The compiler adds memoization automatically at build time, and in principle it lets most hand-written wrappers be deleted. The costs don't pay for that here:

- **Slower builds.** Next.js runs the compiler as a Babel plugin over every component, on top of the SWC/Turbopack pipeline.
- **Behaviour risk.** The compiler assumes every component and hook follows the Rules of React. Code that mutates props or state, or reads mutable values during render, is skipped or changes behaviour silently. Finding those cases means a full manual pass through the app, and the risk returns with every later change.
- **The pain it solves is narrow.** Most of the memoization that exists only to keep a reference stable is the unwrapped list (`data?.results || []`). A shared list hook that returns a stable empty array removes that without a compiler (#1491).

## Prior requests

- #1491: "decide on code-style consistency items (React Compiler, export style, sizing utilities)"
