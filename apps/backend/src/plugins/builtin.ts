export const BUILTIN_PLUGINS: Record<
  string,
  () => Promise<{ plugin: unknown }>
> = {
  "@platypus/tools-basic": () => import("./tools-basic/index.ts"),
  "@platypus/web-fetch": () => import("./web-fetch/index.ts"),
  "@platypus/tools-platform": () => import("./tools-platform/index.ts"),
  "@platypus/docker": () => import("./docker/index.ts"),
  "@platypus/ssh": () => import("./ssh/index.ts"),
  "@platypus/daytona": () => import("./daytona/index.ts"),
  "@platypus/exa": () => import("./exa/index.ts"),
  "@platypus/decision-gate": () => import("./decision-gate/index.ts"),
};

export const ALWAYS_ON_PLUGINS: readonly string[] = [
  "@platypus/tools-basic",
  "@platypus/tools-platform",
];
