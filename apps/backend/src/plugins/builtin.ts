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
  "@platypus/ssh": () => import("./ssh/index.ts"),
};

// The always-on core set (ADR-0013 amendment): these core plugins load
// unconditionally, independent of `PLATYPUS_PLUGINS`. They carry Platypus's own
// essential tools — pure utilities (`tools-basic`) and the domain Tool sets
// (`tools-platform`) — none of which an Operator would plausibly want to deny in
// isolation, so gating them behind the list only invites the "forgot to list →
// silently no tools" footgun. They remain full plugins (boot log, `GET /plugins`,
// catalog annotations); the list gates only the deny-worthy plugins
// (`@platypus/web-fetch` egress, `@platypus/docker` infra) and third-party ones.
//
// A name here is therefore rejected fail-loud if it also appears in
// `PLATYPUS_PLUGINS` — it is not a valid enable switch, so listing it is a
// misconfiguration, not a redundancy. Every entry must be a key of
// {@link BUILTIN_PLUGINS}.
export const ALWAYS_ON_PLUGINS: readonly string[] = [
  "@platypus/tools-basic",
  "@platypus/tools-platform",
];
