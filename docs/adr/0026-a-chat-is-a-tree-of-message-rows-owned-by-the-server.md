---
status: accepted
---

# A Chat is a tree of message rows, and the server owns it

Editing or regenerating a message destroys everything after it, permanently.
The decision is to keep that work as **Alternatives**. Every message becomes a
row in a `chat_message` table with a `parentId`, and the Chat carries an
`activeLeafId`. The **Active path** is the chain from that leaf back to the
root, and it is what every reader treats as the **Transcript**. An edit adds a
user message under the edited message's parent. A regenerate adds an assistant
message under the regenerated message's parent. Neither removes a row.

The storage shape is only half of the decision. The other half is **who owns
the Transcript**. Today it is the client: the server accepts whatever array
arrives and overwrites what it holds. Under this decision the client sends only
the new message and the id it follows, or the id of the assistant message to
regenerate. The server rebuilds the history from its own rows. That change,
rather than rows versus `jsonb`, is what makes lost content impossible. A
stale tab can no longer write its old path over a newer one. It can only add a
sibling on the path it was looking at.

## The request contract

- **Submit** sends `{ message, parentId }`. `parentId` is always explicit, and
  `null` for a message that opens the Chat. The server never attaches a message
  under its own `activeLeafId`, because that would put a stale tab's message
  under whatever leaf another tab had switched to.
- **Regenerate** sends `{ trigger: "regenerate-message", messageId }`. The
  server finds the target's parent and runs the turn from there. A `/skill`
  reply is seeded again from its parent user message, exactly as on submit,
  because the seeded `loadSkill` pair and the reply share one message.
- **The incoming message is a trust boundary.** It must have `role: "user"` and
  only text and file parts, and it must pass `validateUIMessages`. Otherwise a
  client could plant assistant messages or forged tool parts in the model's
  context and the stored Transcript.
- **Errors fail loudly.** A `parentId` not in the Chat is a 404. A duplicate
  message id is a 409. A regenerate whose target is not an assistant message is
  a 409.

User message ids stay client-generated, keyed by `(chatId, id)`. The optimistic
UI and the storage-key layout (`…/{chatId}/{messageId}/…`) keep working
unchanged, and scoping the key by Chat means a client-chosen id cannot collide
with another Chat's.

## What moves the active leaf

The server moves `activeLeafId` on every turn: to the user message on submit,
then to the assistant message once its row exists. A switch between
Alternatives moves it too, landing on the newest leaf under the chosen
Alternative. Last writer wins. That is safe because `activeLeafId` is a pointer
and no content hangs on it.

A switch is refused with a 409 while the Chat has a run in flight. Only one run
per Chat can exist, because the run registry refuses a second with a 409, but that run moves the leaf to its own assistant
message, and a switch landing mid-run would race it. A switch carries the same
gate as submitting a Chat turn. Anyone who can read a Chat but not send to it
sees the Active path and no way to change it.

## Considered Options

- **An `archived` sidecar column beside a linear `chat.messages`.** Proposed in
  a draft ADR (PR #714, closed unmerged; #711 records the refutation). Its
  number, 0022, was later reused for an unrelated decision. It
  was attractive because no downstream reader would learn that Alternatives
  exist. Adversarial review refuted it on three counts:
  - **A single `active` marker cannot express a path through more than one fork
    point.** Every ancestor fork undercounts its siblings by one, and the order
    among them cannot be recovered.
  - **"The sink owns only `messages`" protected nothing.** `ChatSink.onStart`
    overwrites the column from the client's array with no precondition, so a
    stale tab submitting after a switch destroys the segment that switch had
    just moved into place.
  - **Archived segments would ride the 3-second Chat poll** for the whole of
    every run, and every `SELECT *` on `chat` would load them.

  None of the three needs a fix under row storage. They cannot happen.

- **A corrected `jsonb` shape: a lineage list, a precondition on run start, and
  lazy segment fetch.** This fixes each finding one by one. But it stores a tree
  as a denormalised list that the code rebuilds on every render, it still needs
  the whole ownership change, and it grows most of the row model's surface
  anyway. That is the cost of rows without their guarantees.

- **The whole tree as a map inside `chat.messages`, with the server owning
  it.** No new table. But every flush rewrites the whole tree, the whole tree
  still rides the poll, and there is no way to load one message or paginate.

- **Keep the client-owned Transcript and add a version precondition on run
  start.** Cheaper than moving ownership. But it is a guard around the
  overwrite rather than removing it. Every future writer has to remember the
  precondition, and a turn that fails it has nowhere to go but an error the user
  cannot act on.

The row model was rejected in the draft on cost. That cost was overstated. A
census of `chat.messages` finds four writes, all in `ChatSink`, and four
readers: the Chat read, file cleanup on Chat delete, title generation, and
memory extraction. No SQL looks inside the column, and no other table refers to
a message id.

## Consequences

- **Deleting a message takes it out of the Active path, not out of the
  tree.** The row gets a deleted flag. The shared load of the Active path skips
  it, so it is gone from the view and from what the model is sent, and the
  change is stored the moment the user clicks. Users rely on Delete to prune a
  long Chat when the context meter fills up. That is something an Alternative
  cannot do, because an edit starts again from a point and cannot remove one
  message from the middle. Removing a row was rejected because the tree would
  need a rule for its children. Cascade destroys the work this ADR protects.
  Reparenting joins two unrelated lines of conversation and can make an
  assistant reply an Alternative of user messages. A flag leaves the tree's
  shape alone, so neither question comes up. Accepted limitation: deleting a
  message that has Alternatives also removes the arrows that reach them. They
  stay in the tree but cannot be navigated to.
- **`chat.messages` is dropped by the same migration that backfills it.** Each
  existing array becomes a chain in which each message's parent is the one
  before it, and `activeLeafId` is the last message. Keeping the column for a
  release as a rollback copy was rejected: a rollback would show a Transcript
  frozen at upgrade time, which is a worse answer than a restored backup, and it
  leaves a second copy of the content that nothing writes. `drizzle-kit push`
  does not run the backfill, so dev databases need `scripts/migrate.ts` run
  locally or they lose their transcripts.
- **`GET /:chatId` returns the Active path in today's `messages` shape, plus a
  `tree` of `{ id, parentId }` for every message** in `createdAt` order. Readers
  and components that know nothing of Alternatives stay unchanged. The client
  works out sibling counts from `tree`, which costs a few bytes per message on
  the poll. The hydration guard stops comparing message counts. It accepts a
  snapshot when the leaf differs or the same leaf has grown, which holds in both
  directions the count-first comparison got wrong.

  > **Note (#711):** the guard that shipped replaces "the leaf differs or the
  > same leaf has grown" with a rule gated on the run. Once the run is over the
  > row is final, so a snapshot always lands. Mid-run, a snapshot whose leaf is
  > the held leaf lands if that message is at least as far along; one whose leaf
  > is an ancestor on the held path is refused; one whose leaf is not on the held
  > path lands. "The leaf differs" alone accepted the ancestor case, which is a
  > connection dropped before the reply's first flush, and would have wiped the
  > partial reply off the screen.

- **Every background reader works from the Active path**, through one shared
  load: title generation, memory extraction, and the opening Context occupancy.
  Alternatives off the path are invisible to them. An Alternative that was on
  the path when memory was extracted stays in memory after the user moves away,
  because extraction never retracts.
- **Chat delete walks every row, not only the Active path.** The foreign key
  cascades the rows. File cleanup must collect storage keys from all of them,
  deduplicated, because an edit's Alternative may point at the same stored files
  as the message it replaced. Walking only the path is the #715 bug again, one
  level down.
- **`ChatSink` writes only the rows its own turn produced**: the new user
  message, any seeded message, and the assistant message, upserted by id on each
  flush. It never rewrites a row from history. No write path holds the
  whole Transcript to overwrite it, so the guarantee does not depend on each
  new writer remembering a precondition.
- **Triggers are untouched.** `TriggerSink` writes to `trigger_run` and never to
  `chat`.
- **"Branch" is a word for code only.** The glossary term is **Alternative**,
  and the UI labels the control by its anchor: "Message 2 of 3" under a user
  message, "Response 2 of 3" under an assistant message. "Version" was rejected
  because it reads as a software release.
