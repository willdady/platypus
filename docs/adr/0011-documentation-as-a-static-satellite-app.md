---
status: accepted
---

# Documentation site is a static satellite, not a runtime artifact

Platypus ships user- and contributor-facing docs as a **Nextra 4** app at `apps/docs`
(Next.js 16 App Router, MDX), reusing the frontend's Tailwind tokens for brand cohesion
rather than adopting a separately-styled framework like Docusaurus. The site is the
**single source of truth for narrative content** (setup, concepts, guides, extension
points); `README.md` keeps a short quick-start and links in, while the internal
`CONTEXT.md` glossary and `docs/adr/` are **not published** — the public "Concepts" pages
are written independently for end users. It is **excluded from the self-hosted app
runtime**: no Docker image, absent from `compose.yaml` and `build-and-push.yml`. It
deploys independently as its own Cloudflare Worker via OpenNext
(`@opennextjs/cloudflare`) — see the Amendment below; pages remain statically generated.
Docs **track the latest release only**;
older versions are reached by checking out the corresponding git tag (a self-hoster
already has the matching docs in their checkout), avoiding a per-release
snapshot/version-switcher.

## Considered Options

- **Fully bespoke docs (Next.js static export).** Rejected: maximum styling control but
  turns a "fill docs gaps" effort into building and maintaining a docs engine (nav, TOC,
  search, versioning, edit links) from scratch.
- **Astro Starlight.** Rejected: leanest static option, but a different framework from the
  frontend — no React component reuse, only token-level styling parity.
- **Docs as a third deployable** (Docker image + compose service). Rejected: a static site
  needs no server; bundling a docs container into every self-hosted deployment is cost
  with no payoff over a CDN plus the in-repo Markdown.
- **Multi-version docs with a version switcher.** Rejected for now: Nextra doesn't provide
  it for free, and per-release snapshotting plus canonical-URL handling is a permanent tax
  the git-tag/self-host model already covers. Revisit on a major breaking release.

## Consequences

- A self-hoster on an old release reads docs by checking out that tag, not from a "v1.x"
  dropdown on the public site.
- `apps/docs` carries Turbo `build`/`dev`/`lint` tasks but no `build-docker`; it is kept
  out of the default `pnpm dev` loop (opt-in via `pnpm --filter docs dev`).
- The public site and `CONTEXT.md` cover overlapping subjects for different readers; they
  must be maintained independently and may legitimately diverge in voice and depth.
- Top-level information architecture follows audience/journey (Getting Started,
  Self-Hosting, Concepts, Building with Platypus, Extending, Reference).

## Amendment (2026-06-13): deploy via OpenNext to Cloudflare Workers

The original decision built `apps/docs` to a static export (`output: 'export'` → `out/`)
for serving from a CDN, leaving the host deliberately deferred. We now deploy the site to
**Cloudflare Workers via OpenNext** (`@opennextjs/cloudflare` + `wrangler`):

- `next.config.mjs` drops `output: 'export'` (and the `images.unoptimized` it required) and
  calls `initOpenNextCloudflareForDev()`. The build runs in Next.js standalone mode and the
  OpenNext adapter wraps it into a Worker (`.open-next/worker.js`), configured by
  `wrangler.jsonc` and `open-next.config.ts`.
- Pages are still **statically generated** — this is not a move to per-request SSR. The
  Worker serves prerendered HTML plus static assets (`.open-next/assets`, populated from
  `public/`). No incremental cache / R2 is configured.
- **Pagefind search** moves from indexing the static `out/` to indexing the standalone
  build output: `pagefind --site .next/server/app --output-path public/_pagefind`, folded
  into the `build` script so the index is copied into the Worker's assets.
- Deploy/preview is `pnpm --filter docs deploy` / `preview` (OpenNext + Wrangler). The site
  stays out of the self-hosted `compose.yaml` / `build-and-push.yml` — this changes only
  _where the public docs site is hosted_, not the self-hosted-from-git-tag model.

This supersedes "built to a static export … served from a CDN" and the deferred-host note;
the rest of the ADR (Nextra choice, latest-only, IA, independence from `CONTEXT.md`) stands.
