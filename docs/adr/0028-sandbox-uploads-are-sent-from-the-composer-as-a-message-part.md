---
status: accepted
---

# Sandbox uploads are sent from the composer, as a message part

A User places a file in the Workspace's Sandbox from the chat composer: the ➕
menu's **Upload to Sandbox** item. The file travels through the Workspace upload
route of ADR-0027 and is recorded on the message as a **Sandbox upload** part
(`data-sandbox-upload`: path, filename, size). The Workspace home page's Sandbox
card, which uploaded and downloaded by path, is removed. Both routes stay: the
composer uses upload, and `fsDownload`'s button uses download, so a User
downloads by asking the Agent.

## Decisions

- **Pending until Send.** A Sandbox upload chip holds the file in the browser,
  like a File part. Removing a chip uploads nothing. The 25 MiB bound is checked
  when the file is picked, since a file over it can never be sent.
- **Uploads go first, then the message.** Each file lands at the Sandbox root
  under its own name, through the route's create-versus-overwrite behaviour. A
  taken path asks the User; a cancel or any other failure stops the Send and
  keeps the chips. A file that landed is remembered, so a retried Send uploads
  only what has not landed and never asks to overwrite a file it just placed.
- **A note, not bytes.** The part is never resolved to bytes. The model sees a
  short note of the path and size, and reads the file with its Sandbox tools if
  it needs to. The part records a past upload: editing, regenerating or
  retrying the message never uploads again, and a file changed since is
  something the Agent finds out for itself.
- **No File part duplication.** A Sandbox upload is its own part kind, not a
  File part with a flag. A User who wants the model to see the file as well
  attaches it both ways.
- **No download link in the Transcript.** It would serve whatever the path
  holds now, not what was uploaded.
- **The Agent picker is locked** while the composer holds a Sandbox upload chip.
  The item was offered because this Agent has the `sandbox` Tool set; another
  selection, a plain model above all, may not, and the upload would land where
  no tool can read it.
- **Hidden, not disabled.** The item shows only when the Workspace has a
  Sandbox, its backend supports upload, and the Chat's Agent has the `sandbox`
  Tool set. A disabled item would need to say which of the three failed, and
  none of them is something the User fixes from the composer.
- **Drag-and-drop and paste stay File parts.** Only the menu item makes a
  Sandbox upload, so the common gesture keeps its old meaning.

## Considered Options

- **A toggle on one attachment kind** ("also send to Sandbox"). Rejected: it
  conflates two parts with different lifetimes, and a toggle per chip is easy to
  miss.
- **Choosing the destination by file type.** Rejected: a CSV is as likely to be
  a question for the model as input for a script, and a guess the User cannot
  see is worse than a choice they make.
- **Uploading on pick.** Rejected: a removed chip would leave a file behind in
  the Sandbox, and an abandoned draft would write to it.
- **A text note in the message instead of a part.** Rejected: it reads as words
  the User wrote, and the Transcript could not render it as a file.
- **Keeping the home page card.** Rejected: two upload surfaces with different
  path rules, and the card's upload never reached the Agent's context.

## Consequences

- The chat submit route accepts `data-sandbox-upload` parts, validated against
  their schema; any other data part is refused.
- The Sandbox upload part persists with the message like any other part, and
  nothing deletes the Sandbox file when the message or Chat is deleted.
- Files arriving through a messaging Gateway stay File parts.
