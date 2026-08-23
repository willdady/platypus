# Org-Scoped Email-Domain Admission

Platypus does **not** let an Organization hold a list of allowed email domains that
admits people to the deployment. There is no `allowedEmailDomains` on the
`organization` row, no deployment-wide `SIGNUP_ALLOWED_EMAIL_DOMAINS` env
allowlist, and no `DEFAULT_ORGANIZATION_ID` auto-attach hook. More broadly, this
rejects **admission by address pattern** — the idea that holding an address
matching some rule is sufficient grounds to be given an account.

This rejects the _admission mechanism_, not the underlying want. "Everyone at
this company should be able to get in without me clicking a button per person"
is a reasonable thing to want, and the zero-per-person-admin-work property is
genuinely the thing the other options don't have. What is out of scope is
spending the Organization row, or an env allowlist, to buy it.

## Why domain admission is out of scope

### It inverts the authority tiering

`CONTEXT.md` states the tiering plainly: authority over configuration runs
**Operator → Org Admin → Workspace Owner**, each tier bounded by the tier above
it. Holding an account sits _above_ the top of that chain — only a Super Admin
creates an Organization, and an Org Admin's entire authority is scoped to the
Organization they were given.

A domain list on the Organization row would hand an Org Admin a text field that
decides **who may register on the deployment**. That is Operator authority,
exercised by editing an org-scoped setting. An Org Admin who typed `gmail.com`
into that field would open the deployment to everyone on the internet with a
Gmail address, and the Operator — who owns the deployment's exposure — would have
no say and no signal.

The request's own framing is the tell: the setting "does both jobs — it gates who
may register _and_ answers which Organization they belong to." Those two jobs
belong to two different tiers. Collapsing them into one field is precisely what
makes the field attractive and precisely what makes it wrong.

### An address is not evidence

Platypus does not verify email addresses — `requireEmailVerification` is off and
there is no mail transport to turn it on with. So a domain rule tests a _claim_,
not a fact: nothing establishes that the person registering as
`someone@example.com` controls that mailbox, or exists.

Domain admission therefore reads as "anyone who asserts an address on this
domain is admitted." For a rule whose whole purpose is to decide who gets in,
resting it on an unverified self-assertion is not a strong enough foundation, and
the fix — actually verifying addresses — is a mail-delivery feature Platypus
deliberately does not have.

### The problem it solves is already solved

The request reached the org-scoped design by merging two weaker ideas, and was
explicit that neither is worth having alone: a bare env allowlist still drops
people into the orphaned no-Organization state, and a bare default-org
auto-attach widens exposure because sign-up stays open. That reasoning is sound.

But the thing both halves were reaching for — a person who is admitted **and**
lands somewhere useful — is what an **Invitation** already is. An invitation
names the person, names the Organization, carries an ordered set of Blueprints,
and provisions a Workspace on acceptance. It is the deployment's record of the
decision "this person should have an account here." A domain rule would be a
second, weaker admission record standing beside it, disagreeing about who
decides.

## What to do instead

Send invitations, and redeem them into accounts by link. An invitation link is
one admin action per person: create the invitation, paste the link into whatever
channel you already use. That is not the zero-per-person-work property a domain
list would give, and this is an honest cost of the rejection — a hundred-person
rollout is a hundred invitations.

What you get in exchange is that every account on the deployment traces to a
decision somebody made, and the Operator keeps control of admission while Org
Admins keep control of their Organization.

If the per-person work is genuinely the blocker at your scale, the shape worth
proposing is **Operator-level** — a deployment-wide allowlist owned by whoever
owns the deployment's exposure, set at deploy time, not an org-scoped field an
Org Admin can edit. That is a different request from this one and it is not
rejected here; it simply has not been made.

## Prior requests

- #462 — "Feature: application-level control over who can sign up" (option D)
