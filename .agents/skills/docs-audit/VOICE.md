# Docs voice

House style for `apps/docs/content`. Used by `/docs-audit` to classify TONE
findings, and by anyone editing a page.

## Who is reading

Self-hosters (Operators), Org Admins, and Workspace Owners. People running and
using Platypus — not people building it.

They arrive mid-task with a specific question. They are competent and short of
time. They are not reading the section in order.

## Write the task, not the implementation

The reader cannot see the repository and will never open it.

- No `apps/**` paths, no file names, no function or class names.
- No ADR links and no ADR numbers.
- No inlined TypeScript interfaces where a table of fields would do.
- No "Status: implemented", no roadmap, no changelog.
- No maintainer rationale unless it changes what the reader should do.

The exception is a page whose subject genuinely is the source: the reference
pages cite `.env.example` as their source of truth, and `extending/` shows the
SDK surface a plugin author writes against.

## Voice

Second person, present tense, active. "Open the Webhook again and the **Signing
Secret** field appears" — not "the field will then be displayed".

Say what the thing is before what to do with it. Lead the page with the sentence
a reader could quote to a colleague.

Plain over formal, specific over hedged. Give the number, the default, the exact
label. "Each attempt times out after **10 seconds**" beats "attempts time out
promptly".

Do not sell. No "powerful", "seamless", "simply", "just", "easily". If it were
easy the page would be shorter.

## Name the trap

The strongest thing these docs do is call out the failure a reader is about to
walk into, and say what to do instead:

> Setting `TIMEZONE` and expecting a 9am Trigger to fire at 9am local is the
> trap; set the zone on the Trigger.

> A handler written against `data.notificationId` alone reads `undefined` on
> every bulk event and drops the whole batch silently.

State the wrong mental model, the symptom, then the fix. A `<Callout>` is the
usual home for it. Do not soften it into "note that".

## Conventions

- **Domain nouns are capitalised**: Agent, Sub-Agent, Workspace, Organization,
  Chat, Skill, Trigger, Board, Webhook, Sandbox, Plugin, Tool, Provider,
  Operator. Ordinary words are not — a "card" on a Board is a card.
- **UI labels are bold**, and menu paths use an arrow: **Settings → Webhooks**.
  Bold the label exactly as it appears on screen.
- **Code spans** for env vars, values, fields, and event names: `BACKEND_URL`,
  `card.created`, `disk`.
- `<Callout type="info">` for context a reader can skip;
  `<Callout type="warning">` for something that costs them if missed.
- `<Steps>` for an ordered procedure the reader performs once.
- Tables for enumerations. A Required column earns its place; a Default column
  states `_(none)_` or `_(unset)_` rather than leaving a blank.
- Internal links are root-relative: `/self-hosting/configuration#plugins`.
- End a task page with **Where to next** linking two or three real destinations.

## Length

Say it once, in the place the reader is standing. A claim repeated on three
pages rots on two of them.

Prefer deleting a paragraph to qualifying it. An anchorless claim that nothing
verifies is a liability, and the shortest true page beats the fullest stale one.
