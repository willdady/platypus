import type { PlatypusPlugin } from "@platypuschat/plugin-sdk";

// The static built-in map IS the core allowlist (ADR-0013): membership here —
// resolved from the trusted bundle, not the package-scope string — decides which
// plugin names are treated as core. Core plugins are internal backend modules
// under `apps/backend/src/plugins/<name>/`, reached through these loader thunks
// (this map replaced the old side-effect `import`s at server bootstrap). Their
// `@platypus/*` names are logical ids, not published packages. Third-party
// plugins are absent from this map and resolve via dynamic `import()` in the
// loader.
export const BUILTIN_PLUGINS: Record<
  string,
  () => Promise<{ plugin: PlatypusPlugin }>
> = {
  "@platypus/tools-basic": () => import("./tools-basic/index.ts"),
  "@platypus/web-fetch": () => import("./web-fetch/index.ts"),
  "@platypus/tools-platform": () => import("./tools-platform/index.ts"),
  "@platypus/docker": () => import("./docker/index.ts"),
};
