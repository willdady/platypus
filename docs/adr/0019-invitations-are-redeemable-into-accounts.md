---
status: accepted
---

# Invitations are redeemable into accounts

Extends ADR-0008 and ADR-0009. Those ADRs treat an invitation as a row matched to an
_existing_ account by email address, which makes the invitation useless as an admission
control: the invitee must already hold an account before the invitation is visible to them,
so open self-service registration is a prerequisite of the invitation flow rather than an
oversight in it. We therefore give an invitation a **token** and make it **redeemable into an
account**: an invitation link creates the account, signs the person in, and accepts the
invitation in one act. An Operator may then require invitations, at which point the
invitation row is the only thing in the system that can produce a `user`. Everything
ADR-0008 and ADR-0009 establish about what an invitation _carries_ — the optional Workspace
name, the ordered Blueprint set, snapshot-not-binding application, the deletion guard — is
unchanged.

## Decisions

- **The invitation is the admission record, and nothing restates it.** The alternative
  considered first was an Operator-created account: close registration and have the Super
  Admin mint `user` rows from the platform Users screen. Rejected because it produces _two_
  records of one decision — an invitation saying a person may join, and a hand-made account
  saying they may hold an account — and a two-step process where the second step can be
  skipped, leaving exactly the orphaned accountless-Organization state this work exists to
  eliminate. One record, one action.

- **The token binds the redemption, not the address.** An email-match gate — reject
  registration unless a pending invitation exists for the submitted address — was the
  originally proposed mechanism and is rejected. Platypus verifies no addresses
  (`requireEmailVerification` is off and there is no mail transport), so such a gate tests
  whether an address is _on a list_, never whether the person at the keyboard is its owner.
  Company addresses follow guessable conventions, so the gate would narrow the set of
  registerable addresses to precisely the invited — and therefore valuable — ones. A
  server-minted token is not guessable. The invitee's address is read off the invitation
  rather than typed.

- **This trades guessability for transmission, deliberately.** Under address matching an
  invitation is worthless to anyone not already controlling that mailbox. Under token
  redemption, whoever holds the link can redeem it: forwarded to the wrong person, they get
  the account and the Organization membership. This is a real and accepted regression in one
  axis, taken because the transmission channel is the sender's to choose and is the same
  channel that already had to carry "an invitation is waiting for you", whereas
  guessability is under nobody's control. Single-use and expiry — already carried by
  `status` and `expiresAt` — bound the exposure; there is no revocation action beyond
  deleting the invitation and creating a new one.

- **The token is stored in plaintext and re-copyable.** Hashing it would confine the
  plaintext to the creation response, making the link show-once and a lost link
  unrecoverable. Rejected: Platypus has no email, so the one channel that could re-send a
  show-once secret does not exist, and the threat this design addresses is a stranger
  reaching the registration page, not an attacker holding `SELECT` on the database. An
  Organization's Invitations surface therefore offers the link on any pending row.

- **Requiring invitations disables registration rather than gating it.** With redemption
  performing account creation server-side, the auth library's own `disableSignUp` option
  closes the public registration endpoint outright when the Operator requires invitations. A
  `hooks.before` middleware that inspected registration requests for a valid token was
  rejected: it leaves the endpoint live and makes the middleware the security boundary, so
  every upgrade of the auth library is an opportunity for the fence to stop lining up with
  the door it fences. Closing the door with a supported option and minting users only
  through a route we own is the stronger shape.

- **Admission is Operator-scoped.** Requiring invitations is a deploy-time Operator
  decision, defaulted to off so existing deployments are unaffected. Admission rules owned
  by an Organization — notably an org-held allowed-email-domain list — are rejected on
  authority grounds; see `.out-of-scope/org-email-domain-admission.md`.

## Consequences

- **Redemption may leave an account behind.** Redemption creates the account, signs the
  person in, then joins the Organization and provisions the Workspace with its Blueprints.
  Account creation happens outside the accept transaction — the hazard `seed.ts` already
  documents and hand-compensates for — so a Blueprint failure can leave a usable account
  with the invitation still pending. This is the deliberate answer: the account survives and
  the in-app acceptance path is still available, which is strictly better than a link that
  lands someone on an empty shell.

- **In-app acceptance remains, and the link serves both audiences.** Someone who already
  holds an account has nothing to redeem into, so the existing notification and
  Settings-based acceptance path is unchanged. The link also works for a signed-in holder of
  the invited address, and refuses explicitly when a _different_ account is signed in rather
  than silently binding to the wrong one.

- **Self-service registration survives.** Requiring invitations does not make account
  creation an administrative act: the invitee still chooses their own name and password, and
  no initial password is ever transmitted or known to an administrator. Only the entrance
  changes.

- **The self-hosting documentation now describes two admission modes.** With the requirement
  defaulted off, the deployment's admission posture depends on configuration and can no
  longer be stated as one flat claim. The default is expected to flip at the next major
  version, at which point the documentation returns to stating one thing.
