---
name: pre-release-check
description: The final gate before a release is cut — go green, reconcile the release PR against what actually landed, sweep what CI can't see, check the roadmap, optionally deep-review, then return a ship-or-hold verdict.
disable-model-invocation: true
---

# Pre-release check

**This is the last thing that runs before a release is cut.** Nothing downstream catches
what you miss here.

Releases are cut by **release-please**: a bot PR titled `chore(main): release <version>`
sits open against `main`, and the release happens the moment it merges — tagging,
publishing images, and cutting a GitHub release. There is no undo.

Three mechanics shape the whole check:

- The changelog is built **only** from Conventional Commit subjects on `main`.
- `main` squash-merges with **the PR title as the commit subject**. A PR titled without a
  `feat`/`fix`/`chore` prefix lands a commit that contributes nothing to the changelog and
  nothing to the version bump — a feature ships silently inside a patch release.
- `main` is protected against force-pushes, so a subject that landed wrong **cannot be
  rewritten**. It can only be corrected by a follow-up commit.

You end on a **verdict**: **ship** or **hold**. A hedge is a hold. Everything below feeds
that one call, so run every step — a skipped step is an unknown, and an unknown holds.

## Step 1 — Go green

Confirm the ground first: on `main`, synced with `origin/main`, working tree clean.

```bash
git fetch --tags && git fetch origin main
git status --short && git log --oneline origin/main..HEAD
```

Then run the gate from the repo root:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Then `pnpm format` followed by `git status --short`. `format` **writes**, so a dirty tree
afterwards means formatting has drifted on `main` and needs its own commit.

Report each check as pass or fail with the failing output. **Green is every check passing
on an unmodified tree.** Anything red is a hold — say so and stop; do not carry a failure
forward into the later steps hoping it looks smaller in a summary.

## Step 2 — Reconcile the release

Establish the range: previous release tag to the tip of `main`.

```bash
git tag --sort=-v:refname | head -1        # previous release
gh pr list --state open --search "chore(main): release" --json number,title,body
git log <prev-tag>..origin/main --oneline
git diff <prev-tag>..origin/main --stat
```

Read the release PR body (its changelog), then read the range itself — open every file the
stat flags as substantial. **Never reconcile from commit subjects alone**; the subject is
the thing under suspicion.

**Every commit in the range must be accounted for**: it either appears in the changelog, or
you name it and say what it actually changed. Hunt specifically for a subject that isn't
`feat`/`fix`/`chore` — that commit is invisible to release-please.

Report:

- Commits in the range but absent from the changelog, with what each actually changed.
- Whether the proposed bump matches the largest change in the range — a `feat` in the range
  and a patch bump on the PR is a **hold**.
- Anything breaking: a removed or renamed env var, a changed default, an API or schema shift
  a self-hoster upgrades into. Breaking work in a non-major release is a **hold**.
- User-facing changes the changelog technically lists but doesn't convey.

The remedy for a mismatched bump is the user's call, not yours. Surface it and stop.

## Step 3 — Sweep what CI can't see

The gate in Step 1 is a floor. These four hold the release and none of them go red:

- **Focused or disabled tests.** `grep -rn "\.only(\|\.skip(\|todo(" --include="*.test.ts"
  --include="*.test.tsx" apps packages` — a `.only` left in the range silently disables the
  rest of its file, so Step 1 went green over tests that never ran. Any hit introduced in
  this range is a hold until it's removed or justified.
- **Docs that ship with the code.** `CLAUDE.md` maps changed paths to the docs page that
  must change with them — `.env.example`, `packages/schemas` limits, `apps/backend/src/plugins/**`,
  and visible frontend labels. Apply that table to the range's paths: if a mapped path
  changed and `apps/docs/content` didn't, the release ships a docs lie. `docs-contract.test.ts`
  already passed in Step 1 and cannot see UI labels; for those, ask the user to run
  `/docs-audit` — it is user-invoked and you cannot start it yourself.
- **The plugin SDK version.** If the range touches `packages/plugin-sdk`, its
  `package.json` version must already be bumped by hand. `publish-sdk.yml` fires on release
  publish and publishes only when that version isn't on npm — an unbumped SDK means the
  release goes out with SDK changes that never reach consumers.
- **Migrations.** If the range adds a migration, confirm it's a real `.sql` file that
  `drizzle-kit migrate` will run in production, not a dev-only `push` that exists nowhere
  but a developer's database.

## Step 4 — Check the roadmap

`ROADMAP.md` groups work by horizon: **Now**, **Shipped**, **Later / Exploring**, and
**Non-goals**. Its own promise is that a returning reader is never told something is unbuilt
when it's running in production — and a release is exactly when that goes stale.

Against the range you just read, check each:

- Does this release complete a **Now** item, so it moves to **Shipped** with this version
  appended (`### Item — 2.11.0`)?
- Does it deliver part of a **Later / Exploring** item, or settle a design that section
  calls unsettled?
- Does it contradict a **Non-goal**, or make a **Vision** claim newly true or newly wrong?
- Do any "Contributions welcome" notes now point at work that's already done?

A stale roadmap is not a hold — it's an edit. If nothing shifted, say so plainly. If
something did, propose the edit as a concrete diff for the user to accept or reject; leave
`ROADMAP.md` unwritten until they do.

## Step 5 — Offer the deep review

Ask the user whether they want a deep review of the release range. Recommend it when Step 2
or Step 3 turned anything up, and say why.

If they accept, run the `code-review` skill with the previous release tag as its fixed
point. That skill owns the review criteria; don't restate them here.

Then work the findings **with** the user rather than reporting and leaving. Take them in
severity order, and for each, propose the fix and let the user decide whether it lands
before the release or after it. Some findings are worth blocking a release; most aren't,
and that call is theirs.

## Step 6 — Return the verdict

Close with the call, in this shape:

- **SHIP** — every check in Steps 1–3 passed, the bump matches the range, and any roadmap
  edit is agreed. Name the version being cut and the PR number to merge.
- **HOLD** — list every blocker, each with the step that found it and what would clear it.

State the verdict plainly and let it stand. Do not soften a hold into a list of
observations, and do not upgrade a hold to a ship because the blockers look small — the
user decides to override, and they can only do that if you called it.
