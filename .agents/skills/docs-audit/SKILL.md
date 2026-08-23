---
name: docs-audit
description: Audit one section of the docs content against the code, and report what is wrong, stale, fragile, off-voice, or missing.
disable-model-invocation: true
---

Audit one section of `apps/docs/content` against the source, and report every
claim that no longer holds.

`apps/docs/content/docs-contract.test.ts` already pins the claims with exactly
one authoritative source — env tables, webhook events, core Plugin names, field
limits, internal links, heading anchors. Assume those are green and do not
re-check them. Your job is everything that needs judgement, above all the ~150
bolded UI labels across `building-with-platypus/`, which nothing can see.

**Never answer from memory.** Every verdict cites a file and a line in the code.
A claim you did not open the source for is a claim you did not check.

## Step 1 — Pick the section and build the suspect pool

Audit **one** section per run — one top-level directory of the docs content.
List what is actually there rather than working from a remembered set, so a
section added since cannot be the one you never audit. Ask the user which if
they did not say.

Find when the section was last touched, then list what changed in the code
since:

```bash
git log -1 --format=%H -- apps/docs/content/<section>
git log <that-sha>..HEAD --oneline -- apps/backend apps/frontend packages/schemas
```

Drift concentrates where code moved and docs did not, so read that commit list
before you read the pages — it tells you which claims to distrust.

**Done when:** you have the section, the last-touch SHA, and the commit list.

## Step 2 — List every claim

Read each page in the section **in full**. Then write out every falsifiable
claim it makes, each with its `file:line`.

A claim is anything a reader could act on and find wrong: a UI label, a field
name, a menu path, a default, a limit, an ordering, a behaviour, a "this
requires that", a "you cannot do X".

List **every** claim, not a sample. Coverage has to be a property of the
procedure, because it will not be a property of your attention. A page with
sixty claims produces sixty rows.

**Done when:** every page in the section has been read end to end and every
claim is on the list with a line number.

## Step 3 — Verify each claim against source

For each claim, open the code that decides it and record the verdict as
`doc file:line vs code file:line`.

Where to look:

- UI labels, fields, menu paths → `apps/frontend/app/**`, `apps/frontend/components/**`
- limits, enums, required fields → `packages/schemas/index.ts`
- endpoints, status codes, errors → `apps/backend/src/routes/**`
- run behaviour, steps, timeouts → `apps/backend/src/runs/**`
- plugins, Sandboxes, tool sets → `apps/backend/src/plugins/**`
- deployment, env, first boot → `.env.example`, `compose*.yaml`, `apps/backend/index.ts`

Check exhaustive lists **in both directions**: everything the code has appears
in the doc, and everything the doc lists exists in the code. A missing row is
invisible to a reader — they cannot miss what they were never shown.

**Done when:** every claim has a verdict and a code citation.

## Step 4 — Classify

| Class       | Meaning                                                             |
| ----------- | ------------------------------------------------------------------- |
| **WRONG**   | Contradicts the code. A reader following it fails.                  |
| **STALE**   | Was true, describes something that has since moved or been renamed. |
| **FRAGILE** | True today, with no anchor — it will rot and nothing will notice.   |
| **TONE**    | Accurate but off-voice against `VOICE.md`.                          |
| **GAP**     | The code does something user-facing that no page mentions.          |

## Step 5 — Report

Rank by **reader cost**: what breaks a deployment first, then what wastes an
hour, then what merely reads badly. Not by page order, and not by how easy the
fix is.

For each finding give the doc `file:line`, the code `file:line`, what the page
says, what the code does, and the proposed edit.

**FRAGILE defaults to deletion, not correction.** Correcting an anchorless claim
resets the clock; deleting it stops the bleeding. Keep it only when it earns its
maintenance — say why in the finding. Otherwise the audit's own output becomes
next year's backlog.

Close with the claim count, how many you verified, and what you could not
check — a claim you could not resolve is a finding, not a silence.

## The honest limit

This skill is user-invoked only, so its value is bounded entirely by someone
remembering to type it. Nothing schedules it and nothing reminds you. Pair it
with a release checklist or `/loop`, or accept that the contract test is the
only thing actually running.
