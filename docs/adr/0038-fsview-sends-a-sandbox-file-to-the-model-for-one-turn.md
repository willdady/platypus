---
status: accepted
---

# `fsView` sends a Sandbox file to the model for one turn

The model can now see a Sandbox file as a file: an image it rendered, a PDF it
built. `fsView` joins the `sandbox` Tool set beside `fsDownload`, core-built over
`fsList` and `fsReadBytes`, offered on the same terms and bounded by the same
25 MiB. This amends ADR-0027's rejection of byte-returning Tools: vision and
native PDF input give the model a use for the bytes after all.

The bytes reach the model request and nothing else. The Tool's result, which is
streamed and saved in the Transcript, is `{ path, size, mediaType }`. The bytes
are held in memory for the turn, keyed by tool call, and enter the request only
through the Tool's `toModelOutput`. ADR-0027's rule that Sandbox content is never
written to backend storage still holds.

## Decisions

- **The model gets the file the way it gets a File part.** A media type among the
  model's Passthrough file types goes as is, a text file is inlined, a PDF or
  DOCX becomes Extracted text, and anything else is a tool error. The media type
  comes from the extension, the trust the composer gives an attached file. The
  classification is the turn's Agent's (Provider, model) pair, so a Sub-Agent's
  view follows its own model.
- **A text part naming the file always comes first.** If a Provider drops the
  file, the model still knows one should have arrived and is less likely to
  invent its contents.
- **On OpenAI Chat Completions and OpenRouter, tool-result files move into a
  `user` message.** The OpenAI-compatible adapter JSON-stringifies a file in a
  tool result, so the model reads base64. Whether OpenRouter's
  `/chat/completions` passes one upstream is unverified. A language-model
  middleware on those two paths replaces each file in a tool result with a
  placeholder and adds one `user` message after the last `tool` message of the
  run, holding the files in call order, each labelled with its tool and call. It
  never sits between two tool results of one assistant turn, which a strict API
  rejects. Anthropic, OpenAI Responses, Google and Bedrock keep the file in the
  tool result.
- **No replay.** History is converted without tools, so a later turn sees only
  the saved metadata and calls `fsView` again to see the file. `fsView` is
  eligible for Tool-result clearing for the same reason.

## Considered Options

- **Refuse `fsView` on Chat Completions.** Rejected: Cline, OpenCode, Pi, Goose and
  OpenClaw all move tool-result media into a `user` message instead, and with it
  Chat Completions loses nothing.
- **Keep the file in the tool message on OpenRouter**, as Hermes Agent does.
  Rejected until verified: moving it costs nothing there.
- **Store a copy so later turns can replay it.** Rejected: it would write Sandbox
  content to backend storage, which ADR-0027 rules out, and a fresh `fsView`
  reads the current file anyway.

## Consequences

- A file the Provider rejects fails that model request. Retrying without the file
  is a follow-up if it happens in practice.
- Each viewed file is held in memory until the turn ends.
