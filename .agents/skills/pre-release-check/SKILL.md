---
name: pre-release-check
description: The final gate before a release is cut — go green, reconcile the release PR against what actually landed, sweep what CI can't see, check the roadmap and ADR statuses, optionally deep-review, then return a ship-or-hold verdict.
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

Lint, typecheck and tests are **not** re-run here. CI runs them on every push to `main`,
so the tip has already been through them — but "CI runs on main" is only a guarantee if
you look at the result. Read it:

```bash
git rev-parse origin/main
gh run list --branch main --workflow ci.yml --limit 1 \
  --json headSha,status,conclusion,url --jq '.[0]'
```

The run's `headSha` must equal `origin/main` and its conclusion must be `success`. Three
ways that goes wrong, all holds:

- **The newest run is for an older commit.** The tip is unverified — most likely it
  arrived by a push that bypassed the pull request, which is how a security fix lands off
  a private advisory. Wait for its run, or trigger one.
- **No run at all**, or one still in progress. Wait for it. An absent result is not a
  passing one.
- **A failing run.** Stop here.

Do not accept the release PR's own green check as evidence. CI skips lint, typecheck and
tests on any branch starting `release-please--`, and the `gate` job passes on skipped
jobs — so the release PR is green whatever state the code is in. The run that means
something is the one on `main`.

Then run what CI does **not** cover, from the repo root:

```bash
pnpm build
```

Then `pnpm format` followed by `git status --short`. `format` **writes**, so a dirty tree
afterwards means formatting has drifted on `main` and needs its own commit. Neither the
build nor formatting drift is checked anywhere upstream of here.

Report the CI run and each local check as pass or fail, with the failing output. **Green
is a CI success on this exact commit plus every local check passing on an unmodified
tree.** Anything red is a hold — say so and stop; do not carry a failure forward into the
later steps hoping it looks smaller in a summary.

## Step 2 — Reconcile the release

Establish the range: previous release tag to the tip of `main`.

```bash
git tag --sort=-v:refname | head -1        # previous release
gh release view <prev-tag>                 # what it told self-hosters
gh pr list --state open --search "chore(main): release" --json number,title,body
git log <prev-tag>..origin/main --oneline
git diff <prev-tag>..origin/main --stat
```

Read the previous release's notes first. A changelog lists what changed; the notes are
where a breaking change gets its **commentary** — the migration step, the deprecation
naming the release that removes it, the caveat a self-hoster acted on. That commentary is
the state this upgrade starts from, so the pending range can complete it, contradict it,
or strand someone who followed it.

Then read the release PR body (its changelog), then the range itself — open every file the
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
- Commentary in the previous notes that this range settles, contradicts, or strands — a
  deprecation this range removes, a migration step it invalidates, a "lands next release"
  it either delivers or silently skips.
- User-facing changes the changelog technically lists but doesn't convey.

The remedy for a mismatched bump is the user's call, not yours. Surface it and stop.

## Step 3 — Sweep what CI can't see

The gate Step 1 confirmed is a floor. These four hold the release and none of them go red:

- **Focused or disabled tests.** `grep -rn "\.only(\|\.skip(\|todo(" --include="*.test.ts"
--include="*.test.tsx" apps packages` — a `.only` left in the range silently disables the
  rest of its file, so CI went green over tests that never ran. Any hit introduced in
  this range is a hold until it's removed or justified.
- **Docs that ship with the code.** `CLAUDE.md` maps changed paths to the docs page that
  must change with them — `.env.example`, `packages/schemas` limits, `apps/backend/src/plugins/**`,
  and visible frontend labels. Apply that table to the range's paths: if a mapped path
  changed and `apps/docs/content` didn't, the release ships a docs lie. `docs-contract.test.ts`
  already passed in CI and cannot see UI labels; for those, ask the user to run
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

## Step 5 — Check ADR statuses

`docs/adr/` records decisions, and each ADR's frontmatter `status` claims where that
decision stands relative to the code. A release is when that claim goes stale: a shipped
range implements a decision, or contradicts one, and nothing mechanical notices.

Read the statuses, then the range against them:

```bash
grep -H "^status:\|^implemented-by:" docs/adr/*.md
```

- **Every `accepted-pending-implementation` ADR.** Its `implemented-by` key names the issue
  or PR that builds it. If that number appears in the range — or the range's code otherwise
  makes the ADR true — the flip to `accepted` was meant to land **with the implementing
  PR** and didn't. The release would ship an ADR telling readers its own decision is unbuilt
  while the code does it. Propose: `status: accepted`, drop `implemented-by`, and remove the
  "In the code today" admonition under the title, which is now false.
- **The reverse.** An ADR already at `accepted` whose implementation is not actually in the
  range or in `main` is the same lie pointing the other way — flag it, but confirm against
  the code before proposing a downgrade.
- **Decisions this range overturns.** If the range changes something an accepted ADR
  decided, that ADR needs `superseded-by-NNNN` (the later ADR replacing it) or `deprecated`
  (nothing replaced it). If no ADR records the new decision and the change is architectural,
  say so — the missing ADR is the finding, not the status.
- **Never rewrite an accepted ADR's text to match the new state.** The repo's rule is that
  the old ADR keeps its history and gains a pointer: append an `## Amended by ADR-NNNN`
  section naming which claims are narrowed or withdrawn, and let the newer ADR carry the
  reasoning. `docs/adr/README.md` is the authority on the status vocabulary and this rule.

Like the roadmap, a stale ADR status is not a hold — it's an edit. If nothing shifted, say
so plainly. If something did, propose each change as a concrete diff for the user to accept
or reject; leave the ADRs unwritten until they do.

## Step 6 — Offer the deep review

Ask the user whether they want a deep review of the release range. Recommend it when Step 2
or Step 3 turned anything up, and say why.

If they accept, run the `code-review` skill with the previous release tag as its fixed
point. That skill owns the review criteria; don't restate them here.

Then work the findings **with** the user rather than reporting and leaving. Take them in
severity order, and for each, propose the fix and let the user decide whether it lands
before the release or after it. Some findings are worth blocking a release; most aren't,
and that call is theirs.

## Step 7 — Return the verdict

Close with the call, in this shape:

- **SHIP** — every check in Steps 1–3 passed, the bump matches the range, and any roadmap
  or ADR-status edit is agreed. Name the version being cut and the PR number to merge.
- **HOLD** — list every blocker, each with the step that found it and what would clear it.

State the verdict plainly and let it stand. Do not soften a hold into a list of
observations, and do not upgrade a hold to a ship because the blockers look small — the
user decides to override, and they can only do that if you called it.
