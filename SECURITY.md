# Security Policy

## Reporting a vulnerability

**Report it privately. Do not open an issue, a pull request, or a public branch.**

Use GitHub's private reporting form:

**[Report a vulnerability](https://github.com/willdady/platypus/security/advisories/new)**

You can also reach it from the **Security** tab → **Advisories** → **Report a
vulnerability**. The report is visible only to you and the maintainers, and it
becomes the draft advisory the fix is tracked against — so nothing has to be
re-typed later.

Include what you would want if you were fixing it: the endpoint or screen, who
has to be signed in as what, the steps, and what you got that you should not
have. A short reproduction beats a long description.

### Why not a pull request

Every deployment is upgraded by its own Operator, on their own schedule — there
is no central instance a maintainer can patch on everyone's behalf. Until a
release exists, a public fix tells every unpatched deployment where the hole is
and gives them nothing to upgrade to.

A pull request discloses as surely as an issue does, and it is easy to disclose
without meaning to. The branch name, the commit message, a test named after the
attack, and the shape of the diff itself all say where the missing check was.
Report it privately instead, and the fix and the advisory can be published
together.

If you already have a patch, say so in the report and keep it to yourself for
now. We can open a temporary private fork and invite you to it, so your fix
still lands as your work.

### What happens next

1. We confirm the report and open (or reuse) a private draft advisory.
2. The fix is written against that advisory, not on a public branch.
3. A release goes out, and the advisory is published against it, naming the
   patched version.
4. You are credited in the advisory unless you would rather not be.

We will tell you what we think the severity is and why. If you disagree, say so
— you have looked at it more closely than anyone.

## Supported versions

Fixes land in the next release cut from `main`. Only the most recent release is
supported: there are no backports to earlier tags, so upgrading is the remedy
for every advisory published here.

## What is not a vulnerability

Two things get reported often and are working as intended:

- **The default `admin@example.com` / `admin123` account.** This is the
  documented first-startup credential, overridden with `ADMIN_EMAIL` and
  `ADMIN_PASSWORD`. A deployment left on the default is a deployment that
  skipped its own setup.
- **Anything that needs an Operator account first.** The Operator — the platform
  super-admin — already controls the deployment, its environment, and its
  database, and bypasses in-app authorization by design. A finding that begins
  "as a super-admin" is describing that design.

Crossing a tenancy boundary is always worth reporting: an Organization reaching
another Organization's data, a Workspace Owner reaching a Workspace that is not
theirs, or a Shared resource being reached without an Attachment.
