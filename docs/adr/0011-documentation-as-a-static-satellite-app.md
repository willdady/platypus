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
are written independently for end users. It is **excluded from the app runtime**: no
Docker image, absent from `compose.yaml` and `build-and-push.yml`, and built to a static
export so it can be served cheaply from a CDN. Docs **track the latest release only**;
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
  Self-Hosting, Concepts, Building with Platypus, Extending, Reference); the host for
  `docs.platypus.chat` is deliberately deferred, since the static output is portable
  between GitHub Pages / Cloudflare Pages / Vercel.
