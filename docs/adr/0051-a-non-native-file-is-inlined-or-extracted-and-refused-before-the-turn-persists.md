---
status: accepted
---

# A non-native file is inlined or extracted, and refused before the turn persists

A file a model ingests natively (ADR-0039) is sent unchanged. Any other file is
turned into text at send time: a textual file is inlined in a fenced block, and
a binary document (PDF, DOCX) has its text extracted and is labelled as
extracted, because tables, layout and images do not survive. Extraction is only
ever a fallback; it never replaces a file the model accepts natively. A file
that is neither native, textual nor extractable is refused with a 400 before the
chat row is written, so a turn can never persist a file that would break every
later turn of the chat. The fresh upload is verified by actually extracting it,
so a scanned PDF with no text layer is refused up front; history parts were
verified the turn they were attached and are not re-fetched.

Whether a file is textual is decided from its extension plus a NUL-byte check of
its bytes, never from the media type the browser sends, which differs by OS
(`.py` arrives as `text/x-python`, `.md` as `application/octet-stream`). The
backend gate and the frontend warning share one classifier, so the warning and
the refusal never disagree.

## Considered options

- **Refuse every non-native file** — rejected. Most models read no PDFs
  natively, and a source file is just text.
- **Trust the browser's media type** — rejected for the reason above.
- **Extract at send time only, with no pre-persist check** — rejected. A file that
  yields no text would be written to the chat and fail every turn after it.

## Consequences

- **Extraction runs in-process**, so input is capped by size and the result is
  cached by the file's content hash: the whole history is re-sent every turn,
  and without the cache every document would be re-parsed on every message.
- **A failed extraction or a missing file in history** is sent as a short
  placeholder naming the file, never an error, so one bad file cannot stop a
  chat.
