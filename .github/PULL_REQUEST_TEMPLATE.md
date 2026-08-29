<!--
  ⚠️  Does this fix a security vulnerability?

  Close this tab and report it privately instead:
  https://github.com/willdady/platypus/security/advisories/new

  Opening the pull request tells every deployment that has not upgraded where
  the hole is, before a release exists for them to upgrade to — and the branch
  name, the commit message and a test named after the attack disclose it just as
  loudly as the diff. See SECURITY.md.
-->

## What

## Why

## Checklist

- [ ] The **PR title** is a Conventional Commit subject (`feat:`, `fix:` or `chore:`, optional scope). This is squash-merged as the commit on `main` and is what the changelog and version bump are built from — a title without one means the change ships with neither.
- [ ] **The change is covered by tests.** New behaviour gets tests; a bug fix gets a test that fails without the fix. A change with no test is one nothing stops from coming back — say so in the description if you believe this one genuinely cannot be tested.
- [ ] Docs in `apps/docs/content` are updated **in this PR** if it touched an `.env.example`, a user-facing limit or enum in `packages/schemas`, anything under `apps/backend/src/plugins`, or a visible label or field in the frontend.
- [ ] `pnpm test`, `pnpm typecheck` and `pnpm format` pass locally.
